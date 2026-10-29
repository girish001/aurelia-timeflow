import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  MIGRATION_RLS_ENABLED_TABLES,
  MIGRATION_TABLE_CREATION_ORDER,
  MIGRATION_TABLE_ROLLBACK_ORDER,
  verifyAwsMigrationPrerequisites,
} from "../server/db/aws-migration-plan";
import {
  assertDemoDisabledInProduction,
  assertServerOnlyExecution,
  assertValidTenantExecutionContext,
  buildTenantRlsConfigSql,
  checkAwsDatabaseHealth,
  getAppEnvironment,
  redactPostgresCredentials,
  validateAwsPostgresConfig,
  withTenantDatabaseScope,
} from "../server/db/aws-postgres";
import * as schema from "../server/db/schema";
import { MultiTenantDataStore } from "../server/repositories/tenant-scoped-store";
import { TenantIsolationError } from "../server/tenancy/tenant-context";

describe("AWS RDS / Aurora PostgreSQL Configuration, Drizzle Schema & Tenant Isolation", () => {
  const sampleAwsEnv = {
    APP_ENV: "production",
    AWS_REGION: "ap-south-1",
    AWS_RDS_HOST: "aurelia-timeflow-prod.cluster-c9xyz12345.ap-south-1.rds.amazonaws.com",
    AWS_RDS_PORT: "5432",
    AWS_RDS_DATABASE: "aurelia_timeflow",
    AWS_RDS_USER: "aurelia_app_user",
    AWS_RDS_PASSWORD: "AwsSuperSecretPassword!2026",
    AWS_RDS_SSL_MODE: "verify-full",
    AWS_RDS_POOL_MAX: "15",
  };

  describe("1. AWS RDS / Aurora Connection Validation, SSL Enforcement & Credential Masking", () => {
    it("validates AWS RDS / Aurora PostgreSQL configuration and enforces SSL", () => {
      const config = validateAwsPostgresConfig(sampleAwsEnv);

      expect(config.host).toBe(
        "aurelia-timeflow-prod.cluster-c9xyz12345.ap-south-1.rds.amazonaws.com",
      );
      expect(config.port).toBe(5432);
      expect(config.database).toBe("aurelia_timeflow");
      expect(config.region).toBe("ap-south-1");
      expect(config.sslMode).toBe("verify-full");
      expect(config.poolMax).toBe(15);
      expect(config.environment).toBe("production");
      expect(config.isRdsProxyOrCluster).toBe(true);
    });

    it("rejects insecure SSL modes (such as disable or allow)", () => {
      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          AWS_RDS_SSL_MODE: "disable",
        }),
      ).toThrow(/SSL is mandatory for AWS RDS \/ Aurora PostgreSQL/);
    });

    it("rejects VITE_ client-exposed AWS database environment variables", () => {
      expect(() =>
        validateAwsPostgresConfig({
          ...sampleAwsEnv,
          VITE_AWS_RDS_PASSWORD: "leaked",
        }),
      ).toThrow(/SECURITY_VIOLATION/);
    });

    it("blocks browser execution via assertServerOnlyExecution", () => {
      expect(() => assertServerOnlyExecution(true)).toThrow(/SECURITY_VIOLATION/);
      expect(() => assertServerOnlyExecution(false)).not.toThrow();
    });

    it("redacts AWS database passwords from logs and error messages", () => {
      const redacted = redactPostgresCredentials(
        "Connection failed for user=aurelia_app_user password=AwsSuperSecretPassword!2026 host=aurelia-timeflow-prod.rds.amazonaws.com",
        "AwsSuperSecretPassword!2026",
      );

      expect(redacted).not.toContain("AwsSuperSecretPassword!2026");
      expect(redacted).toContain("********");
    });

    it("enforces environment separation (development, staging, production) and blocks demo data in production", () => {
      expect(getAppEnvironment({ APP_ENV: "development" })).toBe("development");
      expect(getAppEnvironment({ APP_ENV: "staging" })).toBe("staging");
      expect(getAppEnvironment({ APP_ENV: "production" })).toBe("production");

      expect(() => assertDemoDisabledInProduction({ APP_ENV: "development" })).not.toThrow();
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
      expect(report.databaseName).toBe("aurelia_timeflow");
      expect(report.host).toBeNull();
    });

    it("returns healthy status when AWS RDS ping succeeds", async () => {
      const report = await checkAwsDatabaseHealth({
        env: sampleAwsEnv,
        pingExecutor: async () => {},
      });

      expect(report.status).toBe("healthy");
      expect(report.provider).toBe("aws-rds-postgresql");
      expect(report.sslEnforced).toBe(true);
      expect(report.sslMode).toBe("verify-full");
      expect(report.region).toBe("ap-south-1");
    });

    it("redacts AWS password and provides actionable diagnostic hints if connection check fails", async () => {
      const report = await checkAwsDatabaseHealth({
        env: sampleAwsEnv,
        pingExecutor: async (cfg) => {
          throw new Error(`getaddrinfo ENOTFOUND ${cfg.host} with password=${cfg.password}`);
        },
      });

      expect(report.status).toBe("unhealthy");
      expect(report.message).not.toContain("AwsSuperSecretPassword!2026");
      expect(report.message).toContain("********");
      expect(report.diagnosticHint).toContain("Keep RDS 'Publicly accessible = No'");
    });
  });

  describe("3. Drizzle ORM Schema & Multi-Tenant Scale Isolation (100 vs 50 Employees)", () => {
    it("defines all 23 multi-tenant SaaS tables in Drizzle schema", () => {
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
      expect(tableNames).toContain("approvals");
      expect(tableNames).toContain("tenants");
      expect(tableNames).toContain("memberships");
    });

    it("strictly isolates Company A (100 employees) and Company B (50 employees) and binds PostgreSQL RLS", async () => {
      const store = new MultiTenantDataStore();

      store.registerTenant({
        id: "tenant_a",
        slug: "company-a",
        name: "Company A Consulting",
        status: "active",
        onboardingMode: "self_service",
      });
      store.registerTenant({
        id: "tenant_b",
        slug: "company-b",
        name: "Company B Engineering",
        status: "active",
        onboardingMode: "assisted_enterprise",
      });

      for (let i = 1; i <= 100; i++) {
        store.registerUser({
          id: `u_a_${i}`,
          email: `user${i}@company-a.com`,
          fullName: `Company A Member ${i}`,
          emailVerifiedAt: "2026-01-01T00:00:00Z",
          isPlatformAdmin: false,
          status: "active",
        });
        store.createMembership({
          id: `m_a_${i}`,
          tenantId: "tenant_a",
          userId: `u_a_${i}`,
          jobTitle: i === 1 ? "Admin" : "Consultant",
          status: "active",
        });
        store.assignRoleToMembership({
          id: `mr_a_${i}`,
          tenantId: "tenant_a",
          membershipId: `m_a_${i}`,
          roleId: i === 1 ? "sys_business_admin" : "sys_employee",
          roleKey: i === 1 ? "business_admin" : "employee",
        });
      }

      for (let j = 1; j <= 50; j++) {
        store.registerUser({
          id: `u_b_${j}`,
          email: `user${j}@company-b.com`,
          fullName: `Company B Member ${j}`,
          emailVerifiedAt: "2026-01-01T00:00:00Z",
          isPlatformAdmin: false,
          status: "active",
        });
        store.createMembership({
          id: `m_b_${j}`,
          tenantId: "tenant_b",
          userId: `u_b_${j}`,
          jobTitle: j === 1 ? "Admin" : "Developer",
          status: "active",
        });
        store.assignRoleToMembership({
          id: `mr_b_${j}`,
          tenantId: "tenant_b",
          membershipId: `m_b_${j}`,
          roleId: j === 1 ? "sys_business_admin" : "sys_employee",
          roleKey: j === 1 ? "business_admin" : "employee",
        });
      }

      const ctxA = store.resolveTenantContext("u_a_1", "tenant_a");
      const ctxB = store.resolveTenantContext("u_b_1", "tenant_b");

      expect(store.listAccessibleTeamMembers(ctxA)).toHaveLength(100);
      expect(store.listAccessibleTeamMembers(ctxB)).toHaveLength(50);

      // Cross-tenant record manipulation is blocked
      expect(() => store.getTeamMemberProfile(ctxA, "m_b_10")).toThrow(TenantIsolationError);
      expect(() => assertValidTenantExecutionContext(ctxA, "tenant_b")).toThrow(
        TenantIsolationError,
      );

      // Verify RLS SQL statement binding
      const rls = buildTenantRlsConfigSql(ctxA, "tenant_a");
      const compiled = new PgDialect().sqlToQuery(rls.statement);
      expect(compiled.sql).toContain("set_config('app.current_tenant_id'");
      expect(compiled.params).toEqual(["tenant_a"]);

      let boundTenant = "";
      await withTenantDatabaseScope(ctxA, async () => {}, {
        executeRlsInit: async (tid) => {
          boundTenant = tid;
        },
      });
      expect(boundTenant).toBe("tenant_a");
    });

    it("verifies 23-table topological migration order, 17 RLS-enabled tables, and enforces backup + private VPC pre-flight gates", () => {
      expect(MIGRATION_TABLE_CREATION_ORDER).toHaveLength(23);
      expect(MIGRATION_TABLE_ROLLBACK_ORDER).toHaveLength(23);
      expect(MIGRATION_TABLE_CREATION_ORDER[0]).toBe("tenants");
      expect(MIGRATION_TABLE_ROLLBACK_ORDER[22]).toBe("tenants");
      expect(MIGRATION_RLS_ENABLED_TABLES).toHaveLength(17);

      // Without backup & private VPC confirmation flags, migration pre-flight blocks execution
      const blockedPreflight = verifyAwsMigrationPrerequisites(sampleAwsEnv);
      expect(blockedPreflight.readyToExecute).toBe(false);
      expect(blockedPreflight.configValid).toBe(true);
      expect(blockedPreflight.backupConfirmed).toBe(false);
      expect(blockedPreflight.privateVpcConfirmed).toBe(false);
      expect(blockedPreflight.outstandingPrerequisites).toHaveLength(2);

      // With both confirmation flags set inside private VPC, pre-flight succeeds without exposing password
      const readyPreflight = verifyAwsMigrationPrerequisites({
        ...sampleAwsEnv,
        AWS_RDS_BACKUP_VERIFIED: "true",
        AWS_PRIVATE_VPC_EXECUTION: "true",
      });
      expect(readyPreflight.readyToExecute).toBe(true);
      expect(readyPreflight.outstandingPrerequisites).toHaveLength(0);
      expect(readyPreflight.config).toBeDefined();
      expect("password" in (readyPreflight.config ?? {})).toBe(false);
    });
  });
});
