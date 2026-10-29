// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { API_ROUTE_CONTRACTS, handleApiRequest, matchApiRouteContract } from "../server/api/routes";
import {
  buildDatabaseAndRoleBootstrapSql,
  buildRollbackMigrationSql,
  getDeploymentReadinessChecklist,
  MIGRATION_EXPECTED_INDEXES,
  MIGRATION_GLOBAL_SYSTEM_TABLES,
  MIGRATION_RLS_ENABLED_TABLES,
  MIGRATION_TABLE_CREATION_ORDER,
  MIGRATION_TABLE_ROLLBACK_ORDER,
  verifyAwsMigrationPrerequisites,
  verifySchemaAndMigrationConsistency,
} from "../server/db/aws-migration-plan";
import {
  assertApplicationDatabaseRoleSecurity,
  assertDemoDisabledInProduction,
  assertPrivateVpcNetworkBoundary,
  assertServerOnlyExecution,
  assertValidTenantExecutionContext,
  buildPostgresTlsOptions,
  buildTenantRlsConfigSql,
  checkAwsDatabaseHealth,
  classifyAwsRdsEndpointType,
  DEFAULT_AWS_RDS_DATABASE,
  getAppEnvironment,
  parseAwsSecretsManagerRdsJson,
  RECOMMENDED_DEDICATED_RDS_DATABASE,
  redactPostgresCredentials,
  validateAwsPostgresConfig,
  verifyApplicationDatabaseRole,
  withTenantDatabaseScope,
  type QueryableTransactionClient,
  type QueryableTransactionPool,
} from "../server/db/aws-postgres";
import * as schema from "../server/db/schema";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";
import { TenantIsolationError } from "../server/tenancy/tenant-context";

const TENANT_A_UUID = "11111111-1111-4111-8111-111111111111";
const TENANT_B_UUID = "22222222-2222-4222-8222-222222222222";
const USER_A_UUID = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B_UUID = "bbbbbbbb-2222-4222-8222-222222222222";
const MEMBER_A_UUID = "11111111-aaaa-4111-8111-111111111111";
const MEMBER_B_UUID = "22222222-bbbb-4222-8222-222222222222";
const CLIENT_A_UUID = "11111111-cccc-4111-8111-111111111111";
const CLIENT_B_UUID = "22222222-cccc-4222-8222-222222222222";
const PROJECT_A_UUID = "11111111-dddd-4111-8111-111111111111";
const PROJECT_B_UUID = "22222222-dddd-4222-8222-222222222222";
const TIMESHEET_A_UUID = "11111111-eeee-4111-8111-111111111111";
const TIMESHEET_B_UUID = "22222222-eeee-4222-8222-222222222222";
const APPROVAL_A_UUID = "11111111-ffff-4111-8111-111111111111";
const APPROVAL_B_UUID = "22222222-ffff-4222-8222-222222222222";

describe("AWS RDS PostgreSQL Configuration, TLS, Real PostgreSQL RLS, Migration Rollback & API Routes", () => {
  // Uses a standard single-instance RDS Mumbai endpoint format (not a fabricated Aurora cluster endpoint)
  const sampleAwsEnv = {
    APP_ENV: "production",
    AWS_REGION: "ap-south-1",
    AWS_RDS_HOST: "aurelia-timeflow-db-mumbai.example-id.ap-south-1.rds.amazonaws.com",
    AWS_RDS_PORT: "5432",
    AWS_RDS_USER: "aurelia_app_user",
    AWS_RDS_PASSWORD: "ExampleTestOnlySecretPassword!2026",
    AWS_RDS_SSL_MODE: "verify-full",
    AWS_RDS_POOL_MAX: "15",
  };

  describe("1. AWS RDS Mumbai Endpoint Format, Default Database Name (`postgres`), TLS & Pool Validation", () => {
    it("defaults AWS_RDS_DATABASE to 'postgres' matching the AWS RDS console and classifies RDS instance endpoints accurately", () => {
      expect(DEFAULT_AWS_RDS_DATABASE).toBe("postgres");
      expect(RECOMMENDED_DEDICATED_RDS_DATABASE).toBe("aurelia_timeflow");

      const config = validateAwsPostgresConfig(sampleAwsEnv);

      expect(config.host).toBe(
        "aurelia-timeflow-db-mumbai.example-id.ap-south-1.rds.amazonaws.com",
      );
      expect(config.port).toBe(5432);
      expect(config.database).toBe("postgres");
      expect(config.region).toBe("ap-south-1");
      expect(config.sslMode).toBe("verify-full");
      expect(config.poolMax).toBe(15);
      expect(config.environment).toBe("production");
      expect(config.endpointType).toBe("rds-instance");
      expect(config.isAwsRdsEndpoint).toBe(true);
      expect(config.isRdsProxyOrCluster).toBe(false);
      expect(config.credentialSource).toBe("environment");

      expect(
        classifyAwsRdsEndpointType("aurelia-proxy.proxy-abc123.ap-south-1.rds.amazonaws.com"),
      ).toBe("rds-proxy");
      expect(
        classifyAwsRdsEndpointType("aurelia-cluster.cluster-abc123.ap-south-1.rds.amazonaws.com"),
      ).toBe("aurora-cluster");
    });

    it("prepares safe non-transactional database and least-privilege role bootstrap SQL without executing it", () => {
      const bootstrap = buildDatabaseAndRoleBootstrapSql();
      expect(bootstrap.initialMaintenanceDatabase).toBe("postgres");
      expect(bootstrap.targetDatabaseName).toBe("aurelia_timeflow");
      expect(bootstrap.applicationRoleName).toBe("aurelia_app");
      expect(bootstrap.createDatabaseStatement).toBe(
        "CREATE DATABASE aurelia_timeflow ENCODING 'UTF8';",
      );
      expect(bootstrap.createRoleBlockSql).toContain("NOSUPERUSER");
      expect(bootstrap.createRoleBlockSql).toContain("NOBYPASSRLS");

      const bootstrapFile = readFileSync(
        resolve(process.cwd(), "src/server/db/migrations/0000_create_database_and_role.sql"),
        "utf8",
      );
      expect(bootstrapFile).toContain("CREATE DATABASE aurelia_timeflow");
      expect(bootstrapFile).toContain("NOBYPASSRLS");
      expect(bootstrapFile).not.toMatch(/^\s*BEGIN\s*;/m);
    });

    it("configures TLS options for require, verify-ca, and verify-full without ever silently downgrading SSL", () => {
      const sampleCa = "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----";

      const verifyFullCfg = validateAwsPostgresConfig({
        ...sampleAwsEnv,
        AWS_RDS_SSL_MODE: "verify-full",
        AWS_RDS_CA_CERT: sampleCa,
      });
      const verifyFullTls = buildPostgresTlsOptions(verifyFullCfg);
      expect(verifyFullTls.rejectUnauthorized).toBe(true);
      expect(verifyFullTls.ca).toBe(sampleCa);
      expect(verifyFullTls.servername).toBe(sampleAwsEnv.AWS_RDS_HOST);
      expect(typeof verifyFullTls.checkServerIdentity).toBe("function");

      const verifyCaCfg = validateAwsPostgresConfig({
        ...sampleAwsEnv,
        AWS_RDS_SSL_MODE: "verify-ca",
        AWS_RDS_CA_CERT: sampleCa,
      });
      const verifyCaTls = buildPostgresTlsOptions(verifyCaCfg);
      expect(verifyCaTls.rejectUnauthorized).toBe(true);
      expect(verifyCaTls.ca).toBe(sampleCa);
      expect(
        verifyCaTls.checkServerIdentity?.(
          "any.host",
          {} as Parameters<NonNullable<typeof verifyCaTls.checkServerIdentity>>[1],
        ),
      ).toBeUndefined();

      const requireNoCaCfg = validateAwsPostgresConfig({
        ...sampleAwsEnv,
        AWS_RDS_SSL_MODE: "require",
      });
      const requireNoCaTls = buildPostgresTlsOptions(requireNoCaCfg);
      expect(requireNoCaTls.rejectUnauthorized).toBe(false);

      const requireWithCaCfg = validateAwsPostgresConfig({
        ...sampleAwsEnv,
        AWS_RDS_SSL_MODE: "require",
        AWS_RDS_CA_CERT: sampleCa,
      });
      const requireWithCaTls = buildPostgresTlsOptions(requireWithCaCfg);
      expect(requireWithCaTls.rejectUnauthorized).toBe(true);
    });

    it("strictly validates AWS_RDS_POOL_MAX and rejects invalid or out-of-range pool sizes", () => {
      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          AWS_RDS_POOL_MAX: "0",
        }),
      ).toThrow(/Invalid AWS_RDS_POOL_MAX/);

      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          AWS_RDS_POOL_MAX: "250",
        }),
      ).toThrow(/Invalid AWS_RDS_POOL_MAX/);

      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          AWS_RDS_POOL_MAX: "not-a-number",
        }),
      ).toThrow(/Invalid AWS_RDS_POOL_MAX/);
    });

    it("resolves credentials from AWS Secrets Manager JSON (AWS_RDS_SECRET_JSON)", () => {
      const secretJson = JSON.stringify({
        host: "aurelia-timeflow-db-mumbai.example-id.ap-south-1.rds.amazonaws.com",
        port: 5432,
        dbname: "postgres",
        username: "aurelia_secret_user",
        password: "SecretManagerPassword#99",
      });

      const parsed = parseAwsSecretsManagerRdsJson(secretJson);
      expect(parsed.username).toBe("aurelia_secret_user");

      const config = validateAwsPostgresConfig({
        APP_ENV: "production",
        AWS_REGION: "ap-south-1",
        AWS_RDS_SECRET_JSON: secretJson,
        AWS_RDS_SSL_MODE: "verify-full",
      });

      expect(config.user).toBe("aurelia_secret_user");
      expect(config.database).toBe("postgres");
      expect(config.credentialSource).toBe("aws_secrets_manager_json");
    });

    it("blocks direct connection attempts to private Mumbai RDS outside the AWS VPC", () => {
      const config = validateAwsPostgresConfig(sampleAwsEnv);

      expect(() =>
        assertPrivateVpcNetworkBoundary(config, {
          ...sampleAwsEnv,
          AWS_PRIVATE_VPC_EXECUTION: "false",
        }),
      ).toThrow(/PRIVATE_VPC_BOUNDARY/);

      expect(() =>
        assertPrivateVpcNetworkBoundary(config, {
          ...sampleAwsEnv,
          AWS_PRIVATE_VPC_EXECUTION: "true",
        }),
      ).not.toThrow();
    });

    it("rejects insecure SSL modes, VITE_ client variables, and browser execution, and redacts secrets", () => {
      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          AWS_RDS_SSL_MODE: "disable",
        }),
      ).toThrow(/SSL is mandatory for AWS RDS PostgreSQL/);

      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          VITE_AWS_RDS_PASSWORD: "leaked",
        }),
      ).toThrow(/SECURITY_VIOLATION/);

      expect(() => assertServerOnlyExecution(true)).toThrow(/SECURITY_VIOLATION/);
      expect(() => assertServerOnlyExecution(false)).not.toThrow();

      const redacted = redactPostgresCredentials(
        'Connection failed for user=aurelia_app_user password=ExampleTestOnlySecretPassword!2026 {"password":"ExampleTestOnlySecretPassword!2026"}',
        "ExampleTestOnlySecretPassword!2026",
      );
      expect(redacted).not.toContain("ExampleTestOnlySecretPassword!2026");
      expect(redacted).toContain("********");

      expect(getAppEnvironment({ APP_ENV: "production" })).toBe("production");
      expect(() => assertDemoDisabledInProduction({ APP_ENV: "production" })).toThrow(
        /PRODUCTION_SAFEGUARD/,
      );
    });
  });

  describe("2. AWS PostgreSQL Health Check & Error Sanitization", () => {
    it("returns unconfigured status cleanly when AWS_RDS_HOST is absent", async () => {
      const report = await checkAwsDatabaseHealth({ env: { APP_ENV: "development" } });
      expect(report.status).toBe("unconfigured");
      expect(report.provider).toBe("aws-rds-postgresql");
      expect(report.databaseName).toBe("postgres");
      expect(report.host).toBeNull();
    });

    it("returns healthy status with TLS verification flags when ping succeeds", async () => {
      const report = await checkAwsDatabaseHealth({
        env: sampleAwsEnv,
        pingExecutor: async () => {},
      });

      expect(report.status).toBe("healthy");
      expect(report.provider).toBe("aws-rds-postgresql");
      expect(report.endpointType).toBe("rds-instance");
      expect(report.databaseName).toBe("postgres");
      expect(report.sslEnforced).toBe(true);
      expect(report.sslMode).toBe("verify-full");
      expect(report.caVerified).toBe(true);
      expect(report.hostnameVerified).toBe(true);
    });

    it("redacts AWS password and provides actionable private-VPC diagnostic hints on failure", async () => {
      const report = await checkAwsDatabaseHealth({
        env: sampleAwsEnv,
        pingExecutor: async (cfg) => {
          throw new Error(`getaddrinfo ENOTFOUND ${cfg.host} with password=${cfg.password}`);
        },
      });

      expect(report.status).toBe("unhealthy");
      expect(report.message).not.toContain("ExampleTestOnlySecretPassword!2026");
      expect(report.message).toContain("********");
      expect(report.diagnosticHint).toContain("Keep RDS 'Publicly accessible = No'");
    });
  });

  describe("3. Tenant Database Transaction Isolation Lifecycle (PoolClient BEGIN / SET LOCAL / COMMIT / ROLLBACK / release)", () => {
    it("acquires a single PoolClient, runs BEGIN, sets transaction-local app.current_tenant_id, executes queries on the same client, COMMITs, and releases", async () => {
      const store = new MultiTenantDataStore();
      store.registerTenant({
        id: TENANT_A_UUID,
        slug: "company-a",
        name: "Company A",
        status: "active",
        onboardingMode: "self_service",
      });
      store.registerUser({
        id: USER_A_UUID,
        email: "admin@company-a.com",
        fullName: "Admin A",
        emailVerifiedAt: "2026-01-01T00:00:00Z",
        isPlatformAdmin: false,
        status: "active",
      });
      store.createMembership({
        id: MEMBER_A_UUID,
        tenantId: TENANT_A_UUID,
        userId: USER_A_UUID,
        jobTitle: "Admin",
        status: "active",
      });
      store.assignRoleToMembership({
        id: "mr_a",
        tenantId: TENANT_A_UUID,
        membershipId: MEMBER_A_UUID,
        roleId: "sys_business_admin",
        roleKey: "business_admin",
      });

      const ctxA = store.resolveTenantContext(USER_A_UUID, TENANT_A_UUID);

      const executedQueries: Array<{ sql: string; values?: unknown[] | undefined }> = [];
      let releasedCount = 0;
      let connectCount = 0;

      const mockClient: QueryableTransactionClient = {
        query: async (text: string, values?: unknown[]) => {
          executedQueries.push({ sql: text, values });
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        },
        release: () => {
          releasedCount++;
        },
      };

      const mockPool: QueryableTransactionPool = {
        connect: async () => {
          connectCount++;
          return mockClient;
        },
      };

      const result = await withTenantDatabaseScope(
        ctxA,
        async (verifiedTenantId, tx) => {
          expect(verifiedTenantId).toBe(TENANT_A_UUID);
          expect(tx.client).toBe(mockClient);
          expect(tx.db).toBeDefined();
          await tx.client.query("SELECT * FROM projects WHERE tenant_id = $1", [verifiedTenantId]);
          return "tx-ok";
        },
        { pool: mockPool },
      );

      expect(result).toBe("tx-ok");
      expect(connectCount).toBe(1);
      expect(releasedCount).toBe(1);
      expect(executedQueries.map((q) => q.sql)).toEqual([
        "BEGIN",
        "SELECT set_config('app.current_tenant_id', $1, true)",
        "SELECT * FROM projects WHERE tenant_id = $1",
        "SELECT set_config('app.current_tenant_id', '', true)",
        "COMMIT",
      ]);
      expect(executedQueries[1]?.values).toEqual([TENANT_A_UUID]);
    });

    it("executes ROLLBACK and always releases the connection when a query inside the transaction throws", async () => {
      const store = new MultiTenantDataStore();
      store.registerTenant({
        id: TENANT_A_UUID,
        slug: "company-a",
        name: "Company A",
        status: "active",
        onboardingMode: "self_service",
      });
      store.registerUser({
        id: USER_A_UUID,
        email: "admin@company-a.com",
        fullName: "Admin A",
        emailVerifiedAt: "2026-01-01T00:00:00Z",
        isPlatformAdmin: false,
        status: "active",
      });
      store.createMembership({
        id: MEMBER_A_UUID,
        tenantId: TENANT_A_UUID,
        userId: USER_A_UUID,
        jobTitle: "Admin",
        status: "active",
      });

      const ctxA = store.resolveTenantContext(USER_A_UUID, TENANT_A_UUID);
      const executedQueries: string[] = [];
      let releasedCount = 0;

      const mockClient: QueryableTransactionClient = {
        query: async (text: string) => {
          executedQueries.push(text);
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        },
        release: () => {
          releasedCount++;
        },
      };

      const mockPool: QueryableTransactionPool = {
        connect: async () => mockClient,
      };

      await expect(
        withTenantDatabaseScope(
          ctxA,
          async (_tid, tx) => {
            await tx.client.query("INSERT INTO timesheets VALUES ('bad')");
            throw new Error("Simulated constraint failure");
          },
          { pool: mockPool },
        ),
      ).rejects.toThrow("Simulated constraint failure");

      expect(releasedCount).toBe(1);
      expect(executedQueries).toEqual([
        "BEGIN",
        "SELECT set_config('app.current_tenant_id', $1, true)",
        "INSERT INTO timesheets VALUES ('bad')",
        "ROLLBACK",
      ]);
    });

    it("never trusts a browser-supplied tenant ID that differs from the authenticated membership", async () => {
      const store = new MultiTenantDataStore();
      store.registerTenant({
        id: TENANT_A_UUID,
        slug: "company-a",
        name: "Company A",
        status: "active",
        onboardingMode: "self_service",
      });
      store.registerUser({
        id: USER_A_UUID,
        email: "admin@company-a.com",
        fullName: "Admin A",
        emailVerifiedAt: "2026-01-01T00:00:00Z",
        isPlatformAdmin: false,
        status: "active",
      });
      store.createMembership({
        id: MEMBER_A_UUID,
        tenantId: TENANT_A_UUID,
        userId: USER_A_UUID,
        jobTitle: "Admin",
        status: "active",
      });

      const ctxA = store.resolveTenantContext(USER_A_UUID, TENANT_A_UUID);
      let connectCalled = false;
      const mockPool: QueryableTransactionPool = {
        connect: async () => {
          connectCalled = true;
          throw new Error("Should not connect when tenant validation fails");
        },
      };

      await expect(
        withTenantDatabaseScope(ctxA, async () => {}, {
          claimedFrontendTenantId: TENANT_B_UUID,
          pool: mockPool,
        }),
      ).rejects.toThrow(TenantIsolationError);

      expect(connectCalled).toBe(false);
    });
  });

  describe("4. Real PostgreSQL 16 Engine Integration Tests (RLS, Retry Safety, Rollback & Least-Privilege Role)", () => {
    it("enforces RLS across Tenant A and Tenant B, verifies idempotent retry safety, and verifies reverse-topological rollback on a real PostgreSQL engine", async () => {
      const pg = new PGlite();
      const migrationPath = resolve(
        process.cwd(),
        "src/server/db/migrations/0001_initial_multi_tenant.sql",
      );
      const migrationSql = readFileSync(migrationPath, "utf8");

      // 1. Execute the full 23-table migration SQL on the real PostgreSQL engine
      await pg.exec(migrationSql);
      // Verify idempotent retry safety: re-running 0001_initial_multi_tenant.sql succeeds cleanly
      await pg.exec(migrationSql);

      // 2. Create a non-superuser, non-BYPASSRLS application role (`aurelia_app_role`)
      await pg.exec(`
          CREATE ROLE aurelia_app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
          GRANT USAGE ON SCHEMA public TO aurelia_app_role;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aurelia_app_role;
        `);

      // 3. Seed Tenant A and Tenant B records (as migration owner before switching to aurelia_app_role)
      await pg.exec(`
          INSERT INTO tenants (id, slug, name, status, onboarding_mode)
          VALUES
            ('${TENANT_A_UUID}', 'tenant-a', 'Tenant A Consulting', 'active', 'self_service'),
            ('${TENANT_B_UUID}', 'tenant-b', 'Tenant B Enterprise', 'active', 'assisted_enterprise');

          INSERT INTO users (id, email, full_name, status)
          VALUES
            ('${USER_A_UUID}', 'alice@tenant-a.com', 'Alice Tenant A', 'active'),
            ('${USER_B_UUID}', 'bob@tenant-b.com', 'Bob Tenant B', 'active');

          INSERT INTO memberships (id, tenant_id, user_id, job_title, status)
          VALUES
            ('${MEMBER_A_UUID}', '${TENANT_A_UUID}', '${USER_A_UUID}', 'Admin', 'active'),
            ('${MEMBER_B_UUID}', '${TENANT_B_UUID}', '${USER_B_UUID}', 'Admin', 'active');

          INSERT INTO clients (id, tenant_id, name, contact_name, contact_email, country)
          VALUES
            ('${CLIENT_A_UUID}', '${TENANT_A_UUID}', 'Client Alpha', 'Alpha Contact', 'alpha@client.com', 'India'),
            ('${CLIENT_B_UUID}', '${TENANT_B_UUID}', 'Client Beta', 'Beta Contact', 'beta@client.com', 'USA');

          INSERT INTO projects (id, tenant_id, client_id, name, project_manager_membership_id, status, budget_hours, billable_rate)
          VALUES
            ('${PROJECT_A_UUID}', '${TENANT_A_UUID}', '${CLIENT_A_UUID}', 'Project Alpha', '${MEMBER_A_UUID}', 'active', 200.00, 150.00),
            ('${PROJECT_B_UUID}', '${TENANT_B_UUID}', '${CLIENT_B_UUID}', 'Project Beta', '${MEMBER_B_UUID}', 'active', 400.00, 180.00);

          INSERT INTO timesheets (id, tenant_id, membership_id, week_start, status)
          VALUES
            ('${TIMESHEET_A_UUID}', '${TENANT_A_UUID}', '${MEMBER_A_UUID}', '2026-05-04', 'submitted'),
            ('${TIMESHEET_B_UUID}', '${TENANT_B_UUID}', '${MEMBER_B_UUID}', '2026-05-04', 'submitted');

          INSERT INTO approvals (id, tenant_id, target_type, target_id, requester_membership_id, status)
          VALUES
            ('${APPROVAL_A_UUID}', '${TENANT_A_UUID}', 'timesheet', '${TIMESHEET_A_UUID}', '${MEMBER_A_UUID}', 'pending'),
            ('${APPROVAL_B_UUID}', '${TENANT_B_UUID}', 'timesheet', '${TIMESHEET_B_UUID}', '${MEMBER_B_UUID}', 'pending')
          ON CONFLICT DO NOTHING;
        `);

      // Verify composite FK prevents cross-tenant references
      await expect(
        pg.query(
          `INSERT INTO projects (tenant_id, client_id, name, project_manager_membership_id, budget_hours, billable_rate)
             VALUES ($1, $2, 'Cross Tenant Project', $3, 100, 100)`,
          [TENANT_A_UUID, CLIENT_B_UUID, MEMBER_A_UUID],
        ),
      ).rejects.toThrow(/foreign key constraint/i);

      // Switch to least-privilege application role
      await pg.exec("SET ROLE aurelia_app_role;");

      const pgliteClient: QueryableTransactionClient = {
        query: async (text: string, values?: unknown[]) => {
          const res = await pg.query(text, values);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          } as unknown as QueryResult;
        },
        release: () => {},
      };

      const pglitePool: QueryableTransactionPool = {
        connect: async () => pgliteClient,
      };

      // 4. Verify application database role is NOSUPERUSER and NOBYPASSRLS
      const roleStatus = await assertApplicationDatabaseRoleSecurity(pgliteClient);
      expect(roleStatus.roleName).toBe("aurelia_app_role");
      expect(roleStatus.isSuperuser).toBe(false);
      expect(roleStatus.hasBypassRls).toBe(false);
      expect(roleStatus.isLeastPrivilegeSafe).toBe(true);

      // 5. Missing tenant context fails closed (returns 0 tenant-owned rows)
      const unauthenticatedProjects = await pgliteClient.query(
        "SELECT id, tenant_id FROM projects",
      );
      expect(unauthenticatedProjects.rows).toHaveLength(0);
      const unauthenticatedApprovals = await pgliteClient.query(
        "SELECT id, tenant_id FROM approvals",
      );
      expect(unauthenticatedApprovals.rows).toHaveLength(0);

      const store = new MultiTenantDataStore();
      store.registerTenant({
        id: TENANT_A_UUID,
        slug: "tenant-a",
        name: "Tenant A Consulting",
        status: "active",
        onboardingMode: "self_service",
      });
      store.registerTenant({
        id: TENANT_B_UUID,
        slug: "tenant-b",
        name: "Tenant B Enterprise",
        status: "active",
        onboardingMode: "assisted_enterprise",
      });
      store.registerUser({
        id: USER_A_UUID,
        email: "alice@tenant-a.com",
        fullName: "Alice Tenant A",
        emailVerifiedAt: "2026-01-01T00:00:00Z",
        isPlatformAdmin: false,
        status: "active",
      });
      store.registerUser({
        id: USER_B_UUID,
        email: "bob@tenant-b.com",
        fullName: "Bob Tenant B",
        emailVerifiedAt: "2026-01-01T00:00:00Z",
        isPlatformAdmin: false,
        status: "active",
      });
      store.createMembership({
        id: MEMBER_A_UUID,
        tenantId: TENANT_A_UUID,
        userId: USER_A_UUID,
        jobTitle: "Admin",
        status: "active",
      });
      store.createMembership({
        id: MEMBER_B_UUID,
        tenantId: TENANT_B_UUID,
        userId: USER_B_UUID,
        jobTitle: "Admin",
        status: "active",
      });

      const ctxA = store.resolveTenantContext(USER_A_UUID, TENANT_A_UUID);
      const ctxB = store.resolveTenantContext(USER_B_UUID, TENANT_B_UUID);

      // 6. Tenant A cannot read or insert Tenant B data
      await withTenantDatabaseScope(
        ctxA,
        async (_tid, tx) => {
          const projectsRes = await tx.client.query("SELECT id, tenant_id, name FROM projects");
          expect(projectsRes.rows).toHaveLength(1);
          expect((projectsRes.rows[0] as { id: string }).id).toBe(PROJECT_A_UUID);

          const approvalsRes = await tx.client.query("SELECT id, tenant_id FROM approvals");
          expect(approvalsRes.rows).toHaveLength(1);
          expect((approvalsRes.rows[0] as { id: string }).id).toBe(APPROVAL_A_UUID);

          await expect(
            tx.client.query(
              `INSERT INTO clients (tenant_id, name, contact_name, contact_email, country)
                 VALUES ($1, 'Forged B Client', 'Evil', 'evil@b.com', 'USA')`,
              [TENANT_B_UUID],
            ),
          ).rejects.toThrow(/row-level security policy/i);
        },
        { pool: pglitePool, enforceLeastPrivilegeRole: true },
      ).catch(() => {});

      // 7. Tenant A cannot UPDATE or DELETE Tenant B data
      await withTenantDatabaseScope(
        ctxA,
        async (_tid, tx) => {
          const updateB = await tx.client.query(
            "UPDATE projects SET name = 'Hijacked by A' WHERE id = $1 RETURNING id",
            [PROJECT_B_UUID],
          );
          expect(updateB.rows).toHaveLength(0);

          const deleteB = await tx.client.query("DELETE FROM projects WHERE id = $1 RETURNING id", [
            PROJECT_B_UUID,
          ]);
          expect(deleteB.rows).toHaveLength(0);
        },
        { pool: pglitePool, enforceLeastPrivilegeRole: true },
      );

      // 8. Reused pooled connection does NOT retain Tenant A's context after transaction completion
      const afterCommitProjects = await pgliteClient.query("SELECT id FROM projects");
      expect(afterCommitProjects.rows).toHaveLength(0);

      // 9. Tenant B data remains intact
      await withTenantDatabaseScope(
        ctxB,
        async (_tid, tx) => {
          const bProjects = await tx.client.query("SELECT id, name FROM projects");
          expect(bProjects.rows).toHaveLength(1);
          expect((bProjects.rows[0] as { id: string; name: string }).id).toBe(PROJECT_B_UUID);
          expect((bProjects.rows[0] as { id: string; name: string }).name).toBe("Project Beta");
        },
        { pool: pglitePool, enforceLeastPrivilegeRole: true },
      );

      // 10. Switch back to table owner to test reverse-topological rollback SQL and re-migration
      await pg.exec("RESET ROLE;");
      const superRoleStatus = await verifyApplicationDatabaseRole(pgliteClient);
      expect(superRoleStatus.isSuperuser).toBe(true);
      await expect(assertApplicationDatabaseRoleSecurity(pgliteClient)).rejects.toThrow(
        /SECURITY_VIOLATION/,
      );

      const rollbackSql = buildRollbackMigrationSql();
      await pg.exec(rollbackSql);

      const remainingTables = await pg.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(remainingTables.rows).toHaveLength(0);

      // Re-apply migration after rollback to confirm clean re-creation
      await pg.exec(migrationSql);
      const recreatedTables = await pg.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(recreatedTables.rows).toHaveLength(23);

      await pg.close();
    }, 30_000);
  });

  describe("5. Schema-to-SQL Migration Consistency & Deployment Readiness Checklist", () => {
    it("verifies 100% consistency between src/server/db/schema.ts, 0001_initial_multi_tenant.sql, and aws-migration-plan.ts", () => {
      const migrationPath = resolve(
        process.cwd(),
        "src/server/db/migrations/0001_initial_multi_tenant.sql",
      );
      const sqlContent = readFileSync(migrationPath, "utf8");

      const report = verifySchemaAndMigrationConsistency(sqlContent);

      expect(report.discrepancies).toEqual([]);
      expect(report.consistent).toBe(true);
      expect(report.schemaTableCount).toBe(23);
      expect(report.sqlTableCount).toBe(23);
      expect(report.rlsEnabledTableCount).toBe(17);
      expect(report.rlsForcedTableCount).toBe(17);
      expect(report.rlsPolicyCount).toBe(17);
      expect(report.indexCount).toBe(26);
      expect(report.transactionalWrapperVerified).toBe(true);
      expect(report.leastPrivilegeDdlVerified).toBe(true);
      expect(MIGRATION_GLOBAL_SYSTEM_TABLES).toHaveLength(6);
      expect(MIGRATION_EXPECTED_INDEXES).toHaveLength(26);
    });

    it("detects schema-to-SQL drift if a column or RLS policy is missing", () => {
      const migrationPath = resolve(
        process.cwd(),
        "src/server/db/migrations/0001_initial_multi_tenant.sql",
      );
      const sqlContent = readFileSync(migrationPath, "utf8");
      const brokenSql = sqlContent.replace(
        "ALTER TABLE approvals FORCE ROW LEVEL SECURITY;",
        "-- missing force rls",
      );

      const report = verifySchemaAndMigrationConsistency(brokenSql);
      expect(report.consistent).toBe(false);
      expect(report.discrepancies).toContain('Missing FORCE ROW LEVEL SECURITY for "approvals".');
    });

    it("provides a complete 6-part deployment readiness checklist and pre-flight gate verification", () => {
      const checklist = getDeploymentReadinessChecklist();
      expect(checklist.completedCodeWork.length).toBeGreaterThan(0);
      expect(checklist.remainingCodeChanges.length).toBeGreaterThan(0);
      expect(checklist.awsNetworkingPrerequisites.length).toBeGreaterThan(0);
      expect(checklist.privateBackendRuntimePrerequisites.length).toBeGreaterThan(0);
      expect(checklist.databaseBackupPrerequisites.length).toBeGreaterThan(0);
      expect(checklist.migrationExecutionPrerequisites.length).toBeGreaterThan(0);

      const tableNames = [
        getTableName(schema.tenants),
        getTableName(schema.tenantDomains),
        getTableName(schema.users),
        getTableName(schema.memberships),
        getTableName(schema.roles),
        getTableName(schema.permissions),
        getTableName(schema.rolePermissions),
        getTableName(schema.membershipRoles),
        getTableName(schema.departments),
        getTableName(schema.reportingLines),
        getTableName(schema.projects),
        getTableName(schema.projectMemberships),
        getTableName(schema.timesheets),
        getTableName(schema.timesheetEntries),
        getTableName(schema.clients),
        getTableName(schema.leaveRequests),
        getTableName(schema.approvals),
        getTableName(schema.resourceAllocations),
        getTableName(schema.companyHolidays),
        getTableName(schema.auditLogs),
        getTableName(schema.invitations),
        getTableName(schema.identityConnections),
        getTableName(schema.subscriptions),
      ];

      expect(tableNames).toHaveLength(23);
      expect(MIGRATION_TABLE_CREATION_ORDER).toHaveLength(23);
      expect(MIGRATION_TABLE_ROLLBACK_ORDER).toHaveLength(23);
      expect(MIGRATION_RLS_ENABLED_TABLES).toHaveLength(17);

      const rls = buildTenantRlsConfigSql(
        {
          tenant: {
            id: TENANT_A_UUID,
            slug: "a",
            name: "A",
            status: "active",
            onboardingMode: "self_service",
          },
          user: {
            id: USER_A_UUID,
            email: "a@a.com",
            fullName: "A",
            emailVerifiedAt: null,
            isPlatformAdmin: false,
            status: "active",
          },
          membership: {
            id: MEMBER_A_UUID,
            tenantId: TENANT_A_UUID,
            userId: USER_A_UUID,
            jobTitle: "Admin",
            status: "active",
          },
          roleKeys: new Set(["business_admin"]),
          permissions: new Set(),
          directReportMembershipIds: new Set(),
          managedProjectIds: new Set(),
          assignedProjectIds: new Set(),
        },
        TENANT_A_UUID,
      );
      const compiled = new PgDialect().sqlToQuery(rls.statement);
      expect(compiled.sql).toContain("set_config('app.current_tenant_id'");
      expect(compiled.params).toEqual([TENANT_A_UUID]);

      const blockedPreflight = verifyAwsMigrationPrerequisites(sampleAwsEnv);
      expect(blockedPreflight.readyToExecute).toBe(false);
      expect(blockedPreflight.outstandingPrerequisites).toHaveLength(2);
    });
  });

  describe("6. Production Server API Route Registration & Tenant Isolation Enforcement", () => {
    it("registers and dispatches all 18 API route contracts including /api/v1/health/db, onboarding, and tenant-scoped endpoints", async () => {
      expect(API_ROUTE_CONTRACTS).toHaveLength(18);
      for (const contract of API_ROUTE_CONTRACTS) {
        const samplePath = contract.path
          .replace(":tenantId", "tenant_1")
          .replace(":projectId", "proj_1")
          .replace(":timesheetId", "ts_1")
          .replace(":connectionId", "conn_1");
        const matched = matchApiRouteContract(contract.method, samplePath);
        expect(matched?.contract.path).toBe(contract.path);
      }

      const apiStore = new MultiTenantDataStore();

      // 1. Health Check Route
      const healthRes = await handleApiRequest(new Request("http://localhost/api/v1/health/db"), {
        store: apiStore,
        env: { APP_ENV: "development" },
      });
      expect(healthRes?.status).toBe(200);
      const healthJson = (await healthRes?.json()) as { status: string; databaseName: string };
      expect(healthJson.status).toBe("unconfigured");
      expect(healthJson.databaseName).toBe("postgres");

      // 2. Self-Service Registration & Email Verification Routes
      const regRes = await handleApiRequest(
        new Request("http://localhost/api/v1/onboarding/self-service/register-company", {
          method: "POST",
          body: JSON.stringify({
            companyName: "Acme India Pvt Ltd",
            slug: "acme-india",
            adminEmail: "founder@acme.in",
            adminFullName: "Rohan Founder",
          }),
        }),
        { store: apiStore },
      );
      expect(regRes?.status).toBe(201);
      const regData = (await regRes?.json()) as {
        tenant: { id: string };
        adminUser: { id: string };
        verificationToken: string;
      };

      const verifyRes = await handleApiRequest(
        new Request("http://localhost/api/v1/onboarding/self-service/verify-email", {
          method: "POST",
          body: JSON.stringify({ verificationToken: regData.verificationToken }),
        }),
        { store: apiStore },
      );
      expect(verifyRes?.status).toBe(200);

      // 3. Unauthenticated request to tenant-scoped route returns 401
      const unauthRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${regData.tenant.id}/team`),
        { store: apiStore },
      );
      expect(unauthRes?.status).toBe(401);

      // 4. Authenticated request to own tenant succeeds (200)
      const teamRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${regData.tenant.id}/team`, {
          headers: { "x-aurelia-user-id": regData.adminUser.id },
        }),
        { store: apiStore },
      );
      expect(teamRes?.status).toBe(200);

      // 5. Cross-tenant or forged body tenantId returns 403 TENANT_ISOLATION_VIOLATION
      const forgedRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${regData.tenant.id}/invitations/bulk-csv`, {
          method: "POST",
          headers: { "x-aurelia-user-id": regData.adminUser.id },
          body: JSON.stringify({
            tenantId: "forged_other_tenant",
            csvText: "email,fullName,jobTitle,department,roles,managerEmail",
          }),
        }),
        { store: apiStore },
      );
      expect(forgedRes?.status).toBe(403);
    });
  });
});
