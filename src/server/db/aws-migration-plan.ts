import { validateAwsPostgresConfig, type AwsPostgresConfig } from "./aws-postgres";

// ============================================================================
// Private AWS VPC Migration Manifest, Pre-Flight Readiness & Rollback Plan
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
 * Reverse topological order for controlled rollback if ever required on a staging database.
 * Note: Forward migration runs inside `BEGIN ... COMMIT` so any mid-flight DDL error
 * automatically rolls back to the pre-migration state without manual intervention.
 */
export const MIGRATION_TABLE_ROLLBACK_ORDER = [...MIGRATION_TABLE_CREATION_ORDER].reverse();

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

export interface MigrationPreflightCheck {
  readyToExecute: boolean;
  configValid: boolean;
  backupConfirmed: boolean;
  privateVpcConfirmed: boolean;
  config?: Omit<AwsPostgresConfig, "password"> | undefined;
  outstandingPrerequisites: string[];
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
        poolMax: validatedConfig.poolMax,
        environment: validatedConfig.environment,
        isRdsProxyOrCluster: validatedConfig.isRdsProxyOrCluster,
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
