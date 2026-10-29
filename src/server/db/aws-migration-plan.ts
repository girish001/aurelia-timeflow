import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import {
  DEFAULT_AWS_RDS_DATABASE,
  RECOMMENDED_DEDICATED_RDS_DATABASE,
  validateAwsPostgresConfig,
  type AwsPostgresConfig,
} from "./aws-postgres";
import * as schema from "./schema";

// ============================================================================
// Private AWS VPC Migration Manifest, Schema-to-SQL Verifier & Rollback Plan
// ============================================================================

/**
 * Strict topological order of all 23 multi-tenant tables in `0001_initial_multi_tenant.sql`.
 * Every child table appears strictly after all parent tables it references.
 */
export const MIGRATION_TABLE_CREATION_ORDER = [
  "tenants",
  "tenant_domains",
  "users",
  "departments",
  "memberships",
  "roles",
  "permissions",
  "role_permissions",
  "membership_roles",
  "reporting_lines",
  "invitations",
  "identity_connections",
  "subscriptions",
  "audit_logs",
  "clients",
  "projects",
  "project_memberships",
  "timesheets",
  "timesheet_entries",
  "leave_requests",
  "approvals",
  "resource_allocations",
  "company_holidays",
] as const;

/**
 * Reverse topological order for controlled rollback on a staging or pre-cutover database.
 * Every child table is dropped strictly before the parent tables it references.
 */
export const MIGRATION_TABLE_ROLLBACK_ORDER = [...MIGRATION_TABLE_CREATION_ORDER].reverse();

/**
 * 17 tenant-owned tables protected by PostgreSQL Row-Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`)
 * and `USING` + `WITH CHECK` policies bound to `app.current_tenant_id`.
 */
export const MIGRATION_RLS_ENABLED_TABLES = [
  "tenant_domains",
  "departments",
  "memberships",
  "membership_roles",
  "reporting_lines",
  "invitations",
  "identity_connections",
  "audit_logs",
  "clients",
  "projects",
  "project_memberships",
  "timesheets",
  "timesheet_entries",
  "leave_requests",
  "approvals",
  "resource_allocations",
  "company_holidays",
] as const;

export interface GlobalSystemTableClassification {
  tableName: (typeof MIGRATION_TABLE_CREATION_ORDER)[number];
  category: "root_tenant_registry" | "global_identity" | "system_rbac_catalog" | "platform_billing";
  securityEnforcementMechanism: string;
}

/**
 * Deliberate classification of the 6 global/system tables that do not use `tenant_isolation_*` RLS policies.
 * Together with the 17 RLS-enabled tables, all 23 tables in the schema are accounted for (17 + 6 = 23).
 */
export const MIGRATION_GLOBAL_SYSTEM_TABLES: readonly GlobalSystemTableClassification[] = [
  {
    tableName: "tenants",
    category: "root_tenant_registry",
    securityEnforcementMechanism:
      "Root tenant record; read/update restricted by authenticated membership resolution (ctx.tenant.id === tenants.id) and platform admin provisioning guards.",
  },
  {
    tableName: "users",
    category: "global_identity",
    securityEnforcementMechanism:
      "Cross-tenant user identity table allowing one email identity to hold memberships in multiple company workspaces; password_hash is server-only and never returned to client payloads.",
  },
  {
    tableName: "roles",
    category: "system_rbac_catalog",
    securityEnforcementMechanism:
      "Hybrid catalog containing global read-only system role templates (tenant_id IS NULL, is_system_role = TRUE) shared across tenants alongside optional custom tenant roles.",
  },
  {
    tableName: "permissions",
    category: "system_rbac_catalog",
    securityEnforcementMechanism:
      "Immutable global catalog of the 20 system permission codes seeded idempotently at startup.",
  },
  {
    tableName: "role_permissions",
    category: "system_rbac_catalog",
    securityEnforcementMechanism:
      "Immutable join mapping between roles and system permission codes.",
  },
  {
    tableName: "subscriptions",
    category: "platform_billing",
    securityEnforcementMechanism:
      "Commercial seat-limit and subscription lifecycle table managed by Aurelia platform administration and server-side seat-limit enforcement.",
  },
] as const;

/**
 * All 26 explicit `CREATE INDEX` statements defined in `0001_initial_multi_tenant.sql`.
 */
export const MIGRATION_EXPECTED_INDEXES = [
  "tenants_status_idx",
  "tenant_domains_tenant_idx",
  "departments_tenant_idx",
  "memberships_tenant_status_idx",
  "memberships_user_idx",
  "roles_tenant_idx",
  "membership_roles_tenant_member_idx",
  "reporting_lines_manager_idx",
  "reporting_lines_subordinate_idx",
  "invitations_tenant_email_idx",
  "identity_connections_tenant_idx",
  "audit_logs_tenant_created_idx",
  "audit_logs_tenant_category_idx",
  "clients_tenant_idx",
  "projects_tenant_idx",
  "projects_tenant_pm_idx",
  "project_memberships_member_idx",
  "timesheets_tenant_status_idx",
  "timesheet_entries_tenant_sheet_idx",
  "timesheet_entries_tenant_project_idx",
  "leave_requests_tenant_member_idx",
  "approvals_tenant_target_idx",
  "approvals_tenant_status_idx",
  "resource_allocations_tenant_date_idx",
  "resource_allocations_tenant_project_idx",
  "company_holidays_tenant_idx",
] as const;

/**
 * Generates a transactional rollback SQL script (`BEGIN ... COMMIT`) that drops all 17 RLS
 * policies and all 23 tables in strict reverse topological order (`MIGRATION_TABLE_ROLLBACK_ORDER`).
 * Does not require `DROP TABLE ... CASCADE` because every dependent table is dropped before its parent.
 */
export function buildRollbackMigrationSql(): string {
  const dropPolicies = MIGRATION_RLS_ENABLED_TABLES.map(
    (tbl) => `DROP POLICY IF EXISTS tenant_isolation_${tbl} ON ${tbl};`,
  ).join("\n");

  const dropTables = MIGRATION_TABLE_ROLLBACK_ORDER.map(
    (tbl) => `DROP TABLE IF EXISTS ${tbl};`,
  ).join("\n");

  return [
    "-- Transactional Rollback for 0001_initial_multi_tenant.sql",
    "BEGIN;",
    dropPolicies,
    dropTables,
    "COMMIT;",
  ].join("\n");
}

/**
 * Generates the non-transactional SQL bootstrap statements for creating the dedicated
 * `aurelia_timeflow` database (when migrating from the default RDS `postgres` database)
 * and the least-privilege `aurelia_app` role (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`).
 */
export function buildDatabaseAndRoleBootstrapSql(options?: {
  targetDatabaseName?: string;
  applicationRoleName?: string;
}): {
  initialMaintenanceDatabase: typeof DEFAULT_AWS_RDS_DATABASE;
  targetDatabaseName: string;
  applicationRoleName: string;
  createDatabaseStatement: string;
  createRoleBlockSql: string;
  grantPrivilegesSql: string;
} {
  const targetDatabaseName = options?.targetDatabaseName ?? RECOMMENDED_DEDICATED_RDS_DATABASE;
  const applicationRoleName = options?.applicationRoleName ?? "aurelia_app";

  if (!/^[a-z_][a-z0-9_]*$/.test(targetDatabaseName)) {
    throw new Error(`Invalid target database identifier "${targetDatabaseName}".`);
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(applicationRoleName)) {
    throw new Error(`Invalid application role identifier "${applicationRoleName}".`);
  }

  return {
    initialMaintenanceDatabase: DEFAULT_AWS_RDS_DATABASE,
    targetDatabaseName,
    applicationRoleName,
    createDatabaseStatement: `CREATE DATABASE ${targetDatabaseName} ENCODING 'UTF8';`,
    createRoleBlockSql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${applicationRoleName}') THEN CREATE ROLE ${applicationRoleName} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT; END IF; END $$;`,
    grantPrivilegesSql: [
      `GRANT USAGE ON SCHEMA public TO ${applicationRoleName};`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${applicationRoleName};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${applicationRoleName};`,
    ].join("\n"),
  };
}

export interface SchemaMigrationConsistencyReport {
  consistent: boolean;
  schemaTableCount: number;
  sqlTableCount: number;
  rlsEnabledTableCount: number;
  rlsForcedTableCount: number;
  rlsPolicyCount: number;
  indexCount: number;
  transactionalWrapperVerified: boolean;
  leastPrivilegeDdlVerified: boolean;
  discrepancies: string[];
}

const DRIZZLE_SCHEMA_TABLES: readonly PgTable[] = [
  schema.tenants,
  schema.tenantDomains,
  schema.users,
  schema.departments,
  schema.memberships,
  schema.roles,
  schema.permissions,
  schema.rolePermissions,
  schema.membershipRoles,
  schema.reportingLines,
  schema.invitations,
  schema.identityConnections,
  schema.subscriptions,
  schema.auditLogs,
  schema.clients,
  schema.projects,
  schema.projectMemberships,
  schema.timesheets,
  schema.timesheetEntries,
  schema.leaveRequests,
  schema.approvals,
  schema.resourceAllocations,
  schema.companyHolidays,
];

/**
 * Extracts table names and their column definitions from `0001_initial_multi_tenant.sql`.
 */
export function parseSqlMigrationTables(sqlContent: string): Map<string, string[]> {
  const tableMap = new Map<string, string[]>();
  const createTableRegex = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/gi;

  let match: RegExpExecArray | null = createTableRegex.exec(sqlContent);
  while (match !== null) {
    const tableName = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const columns: string[] = [];

    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim().replace(/,$/, "");
      if (!line || line.startsWith("--")) continue;
      const upper = line.toUpperCase();
      if (
        upper.startsWith("UNIQUE ") ||
        upper.startsWith("UNIQUE(") ||
        upper.startsWith("FOREIGN KEY") ||
        upper.startsWith("PRIMARY KEY") ||
        upper.startsWith("CONSTRAINT ")
      ) {
        continue;
      }
      const colMatch = /^([a-z_][a-z0-9_]*)\s+/i.exec(line);
      if (colMatch?.[1]) {
        columns.push(colMatch[1]);
      }
    }

    tableMap.set(tableName, columns);
    match = createTableRegex.exec(sqlContent);
  }

  return tableMap;
}

/**
 * Compares `src/server/db/schema.ts`, `0001_initial_multi_tenant.sql`, and `aws-migration-plan.ts`
 * to detect any table, column, index, RLS policy, or ordering mismatch automatically.
 */
export function verifySchemaAndMigrationConsistency(
  sqlContent: string,
): SchemaMigrationConsistencyReport {
  const discrepancies: string[] = [];

  const sqlTables = parseSqlMigrationTables(sqlContent);
  const sqlTableOrder = [...sqlTables.keys()];

  if (DRIZZLE_SCHEMA_TABLES.length !== 23) {
    discrepancies.push(`Expected 23 Drizzle tables, found ${DRIZZLE_SCHEMA_TABLES.length}.`);
  }
  if (sqlTableOrder.length !== 23) {
    discrepancies.push(`Expected 23 SQL CREATE TABLE blocks, found ${sqlTableOrder.length}.`);
  }

  // Verify topological order matches MIGRATION_TABLE_CREATION_ORDER
  for (let i = 0; i < MIGRATION_TABLE_CREATION_ORDER.length; i++) {
    const expectedTable = MIGRATION_TABLE_CREATION_ORDER[i];
    const actualSqlTable = sqlTableOrder[i];
    if (actualSqlTable !== expectedTable) {
      discrepancies.push(
        `Table order mismatch at position ${i + 1}: expected "${expectedTable}", found "${actualSqlTable ?? "none"}".`,
      );
    }
  }

  // Compare every Drizzle table and column against the SQL migration
  for (const pgTable of DRIZZLE_SCHEMA_TABLES) {
    const cfg = getTableConfig(pgTable);
    const drizzleCols = cfg.columns.map((c) => c.name);
    const sqlCols = sqlTables.get(cfg.name);

    if (!sqlCols) {
      discrepancies.push(`Table "${cfg.name}" is defined in schema.ts but missing from SQL.`);
      continue;
    }

    for (const col of drizzleCols) {
      if (!sqlCols.includes(col)) {
        discrepancies.push(
          `Column "${cfg.name}.${col}" exists in schema.ts but is missing in 0001_initial_multi_tenant.sql.`,
        );
      }
    }

    for (const col of sqlCols) {
      if (!drizzleCols.includes(col)) {
        discrepancies.push(
          `Column "${cfg.name}.${col}" exists in 0001_initial_multi_tenant.sql but is missing in schema.ts.`,
        );
      }
    }
  }

  // Verify 17 RLS-enabled + 6 global tables = 23 total tables with zero overlap
  const rlsSet = new Set<string>(MIGRATION_RLS_ENABLED_TABLES);
  const globalSet = new Set<string>(MIGRATION_GLOBAL_SYSTEM_TABLES.map((t) => t.tableName));
  if (rlsSet.size !== 17 || globalSet.size !== 6) {
    discrepancies.push(
      `Expected 17 RLS tables and 6 global tables, found ${rlsSet.size} and ${globalSet.size}.`,
    );
  }
  for (const table of MIGRATION_TABLE_CREATION_ORDER) {
    if (!rlsSet.has(table) && !globalSet.has(table)) {
      discrepancies.push(`Table "${table}" is neither in RLS list nor in global table list.`);
    }
    if (rlsSet.has(table) && globalSet.has(table)) {
      discrepancies.push(`Table "${table}" cannot be in both RLS and global table lists.`);
    }
  }

  // Verify ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, and CREATE POLICY with USING + WITH CHECK
  let rlsEnabledCount = 0;
  let rlsForcedCount = 0;
  let rlsPolicyCount = 0;

  for (const rlsTable of MIGRATION_RLS_ENABLED_TABLES) {
    const enableRegex = new RegExp(
      `ALTER\\s+TABLE\\s+${rlsTable}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY\\s*;`,
      "i",
    );
    const forceRegex = new RegExp(
      `ALTER\\s+TABLE\\s+${rlsTable}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY\\s*;`,
      "i",
    );
    const policyRegex = new RegExp(
      `CREATE\\s+POLICY\\s+tenant_isolation_${rlsTable}\\s+ON\\s+${rlsTable}\\s+USING\\s*\\(tenant_id\\s*=\\s*NULLIF\\(current_setting\\('app\\.current_tenant_id',\\s*true\\),\\s*''\\)::uuid\\)\\s+WITH\\s+CHECK\\s*\\(tenant_id\\s*=\\s*NULLIF\\(current_setting\\('app\\.current_tenant_id',\\s*true\\),\\s*''\\)::uuid\\)\\s*;`,
      "i",
    );

    if (enableRegex.test(sqlContent)) {
      rlsEnabledCount++;
    } else {
      discrepancies.push(`Missing ENABLE ROW LEVEL SECURITY for "${rlsTable}".`);
    }

    if (forceRegex.test(sqlContent)) {
      rlsForcedCount++;
    } else {
      discrepancies.push(`Missing FORCE ROW LEVEL SECURITY for "${rlsTable}".`);
    }

    if (policyRegex.test(sqlContent)) {
      rlsPolicyCount++;
    } else {
      discrepancies.push(
        `Missing or invalid CREATE POLICY tenant_isolation_${rlsTable} (with USING and WITH CHECK) on "${rlsTable}".`,
      );
    }
  }

  // Verify all 26 indexes exist in SQL
  let indexCount = 0;
  for (const idxName of MIGRATION_EXPECTED_INDEXES) {
    const idxRegex = new RegExp(
      `CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${idxName}\\s+ON\\s+`,
      "i",
    );
    if (idxRegex.test(sqlContent)) {
      indexCount++;
    } else {
      discrepancies.push(`Missing expected index "${idxName}" in 0001_initial_multi_tenant.sql.`);
    }
  }

  const transactionalWrapperVerified =
    /^\s*BEGIN\s*;/m.test(sqlContent) && /COMMIT\s*;\s*$/m.test(sqlContent);
  if (!transactionalWrapperVerified) {
    discrepancies.push("SQL migration must be wrapped in BEGIN; ... COMMIT; transaction block.");
  }

  const hasExcessiveGrants =
    /GRANT\s+ALL/i.test(sqlContent) ||
    /BYPASSRLS\s*;/i.test(sqlContent) ||
    /SUPERUSER\s*;/i.test(sqlContent);
  const leastPrivilegeDdlVerified = !hasExcessiveGrants;
  if (!leastPrivilegeDdlVerified) {
    discrepancies.push(
      "SQL migration contains prohibited privilege escalation (GRANT ALL / SUPERUSER / BYPASSRLS).",
    );
  }

  return {
    consistent: discrepancies.length === 0,
    schemaTableCount: DRIZZLE_SCHEMA_TABLES.length,
    sqlTableCount: sqlTableOrder.length,
    rlsEnabledTableCount: rlsEnabledCount,
    rlsForcedTableCount: rlsForcedCount,
    rlsPolicyCount,
    indexCount,
    transactionalWrapperVerified,
    leastPrivilegeDdlVerified,
    discrepancies,
  };
}

export interface MigrationPreflightCheck {
  readyToExecute: boolean;
  configValid: boolean;
  backupConfirmed: boolean;
  privateVpcConfirmed: boolean;
  config?: Omit<AwsPostgresConfig, "password"> | undefined;
  outstandingPrerequisites: string[];
}

export interface DeploymentReadinessChecklist {
  completedCodeWork: string[];
  remainingCodeChanges: string[];
  awsNetworkingPrerequisites: string[];
  privateBackendRuntimePrerequisites: string[];
  databaseBackupPrerequisites: string[];
  migrationExecutionPrerequisites: string[];
}

/**
 * Verifies all prerequisites before allowing any database migration to execute
 * inside the private AWS Mumbai (`ap-south-1`) VPC.
 */
export function verifyAwsMigrationPrerequisites(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): MigrationPreflightCheck {
  const outstandingPrerequisites: string[] = [];
  let validatedConfig: AwsPostgresConfig | undefined;

  try {
    validatedConfig = validateAwsPostgresConfig(env);
  } catch (err) {
    outstandingPrerequisites.push(
      err instanceof Error ? err.message : "Invalid AWS RDS environment configuration.",
    );
  }

  const backupConfirmed = (env["AWS_RDS_BACKUP_VERIFIED"] ?? "").toLowerCase().trim() === "true";
  if (!backupConfirmed) {
    outstandingPrerequisites.push(
      "AWS_RDS_BACKUP_VERIFIED=true is not set. Confirm automated RDS backups and a pre-migration manual RDS snapshot exist before running migrations.",
    );
  }

  const privateVpcConfirmed =
    (env["AWS_PRIVATE_VPC_EXECUTION"] ?? "").toLowerCase().trim() === "true";
  if (!privateVpcConfirmed) {
    outstandingPrerequisites.push(
      "AWS_PRIVATE_VPC_EXECUTION=true is not set. Migrations must only be executed from an AWS compute service inside the private Mumbai (ap-south-1) VPC.",
    );
  }

  const safeConfig = validatedConfig
    ? {
        host: validatedConfig.host,
        port: validatedConfig.port,
        database: validatedConfig.database,
        user: validatedConfig.user,
        region: validatedConfig.region,
        sslMode: validatedConfig.sslMode,
        caCert: validatedConfig.caCert,
        poolMax: validatedConfig.poolMax,
        environment: validatedConfig.environment,
        endpointType: validatedConfig.endpointType,
        isAwsRdsEndpoint: validatedConfig.isAwsRdsEndpoint,
        isRdsProxyOrCluster: validatedConfig.isRdsProxyOrCluster,
        credentialSource: validatedConfig.credentialSource,
      }
    : undefined;

  return {
    readyToExecute: outstandingPrerequisites.length === 0,
    configValid: Boolean(validatedConfig),
    backupConfirmed,
    privateVpcConfirmed,
    config: safeConfig,
    outstandingPrerequisites,
  };
}

/**
 * Returns the structured 6-category deployment-readiness checklist distinguishing
 * completed code work from AWS networking, runtime, backup, and migration prerequisites.
 */
export function getDeploymentReadinessChecklist(): DeploymentReadinessChecklist {
  return {
    completedCodeWork: [
      "23-table multi-tenant Drizzle ORM schema (src/server/db/schema.ts) verified 1-to-1 against 0001_initial_multi_tenant.sql.",
      "Transactional migration (0001_initial_multi_tenant.sql) with 26 indexes, composite tenant foreign keys, 19 enum CHECK constraints, and 17 ENABLE + FORCE ROW LEVEL SECURITY policies.",
      "Verified reverse-topological transactional rollback generator (buildRollbackMigrationSql) and non-transactional DB/role bootstrap script (0000_create_database_and_role.sql).",
      "Real PostgreSQL transaction wrapper (withTenantDatabaseScope) acquiring one dedicated PoolClient, running BEGIN, SET LOCAL app.current_tenant_id, Drizzle client binding, COMMIT/ROLLBACK, and client.release().",
      "Strict PostgreSQL TLS configuration (buildPostgresTlsOptions) supporting require, verify-ca, and verify-full with CA bundle and hostname verification without silent SSL downgrade.",
      "Executable API router (handleApiRequest in src/server/api/routes.ts) registered in the production server entry point (src/server.ts) for all 18 API contracts including GET /api/v1/health/db.",
      "Real PostgreSQL 16 engine integration tests (via PGlite) verifying cross-tenant SELECT, INSERT, UPDATE, DELETE isolation, fail-closed missing tenant context, composite FKs, and connection pool reuse.",
    ],
    remainingCodeChanges: [
      "Replace in-memory repository calls in route handlers with Drizzle ORM queries wrapped in withTenantDatabaseScope(ctx, async (_tid, { db }) => ...) once the backend is deployed inside the private AWS ap-south-1 VPC.",
      "Wire production OIDC/SAML identity provider token exchange and session cookie signing keys from AWS Secrets Manager.",
    ],
    awsNetworkingPrerequisites: [
      "Keep Amazon RDS instance aurelia-timeflow-db-mumbai in ap-south-1 private (Publicly accessible = No).",
      "Ensure RDS inbound security group rule allows TCP 5432 ONLY from the AWS backend compute security group (ECS Fargate task SG or App Runner VPC Connector SG) within the same ap-south-1 VPC.",
      "Ensure private subnets have NAT Gateway or VPC Interface Endpoints for AWS Secrets Manager and ECR image pulls.",
    ],
    privateBackendRuntimePrerequisites: [
      "Build production Node.js bundle using NITRO_PRESET=node-server npm run build (Node.js >= 22.x).",
      "Inject AWS_REGION=ap-south-1, AWS_RDS_HOST, AWS_RDS_PORT=5432, AWS_RDS_DATABASE (postgres or aurelia_timeflow), AWS_RDS_SSL_MODE=verify-full, AWS_RDS_CA_CERT, and credentials via AWS Secrets Manager (AWS_RDS_SECRET_JSON or AWS_RDS_USER/AWS_RDS_PASSWORD).",
      "Set AWS_PRIVATE_VPC_EXECUTION=true ONLY on the AWS-hosted container task running inside the ap-south-1 VPC.",
    ],
    databaseBackupPrerequisites: [
      "Verify automated RDS backups (retention >= 7 days) are enabled on aurelia-timeflow-db-mumbai in ap-south-1.",
      "Create and verify a manual pre-migration RDS snapshot in ap-south-1 before running any DDL migration.",
      "Set AWS_RDS_BACKUP_VERIFIED=true in the migration runner environment only after the snapshot status is Available.",
    ],
    migrationExecutionPrerequisites: [
      "Decide whether to use the existing RDS database named postgres (AWS_RDS_DATABASE=postgres) or run 0000_create_database_and_role.sql from inside the private VPC to create the dedicated aurelia_timeflow database and least-privilege aurelia_app role (NOSUPERUSER NOBYPASSRLS).",
      "Execute 0001_initial_multi_tenant.sql from an ephemeral ECS Fargate task or AWS CodeBuild runner inside the private ap-south-1 VPC using psql -v ON_ERROR_STOP=1.",
      "Run GRANT USAGE ON SCHEMA public TO aurelia_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aurelia_app; and switch runtime AWS_RDS_USER to aurelia_app.",
    ],
  };
}
