// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/node-postgres";
import type { QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { handleApiRequest } from "../server/api/routes";
import { defaultSessionManager } from "../server/auth/session-manager";
import {
  withTenantDatabaseScope,
  type AureliaAwsDb,
  type QueryableTransactionClient,
  type QueryableTransactionPool,
} from "../server/db/aws-postgres";
import * as schema from "../server/db/schema";
import {
  approveTimesheetInDb,
  getProjectByIdFromDb,
  getTeamMemberProfileFromDb,
  listAccessibleTeamMembersFromDb,
  listProjectsFromDb,
  listTenantAuditLogsFromDb,
  listUserTenantsFromDb,
  resolveTenantContextFromDb,
  updateProjectBudgetInDb,
} from "../server/repositories/postgres-tenant-store";
import { TenantIsolationError } from "../server/tenancy/tenant-context";

const TENANT_ALPHA = "11111111-1111-4111-8111-111111111111";
const TENANT_BETA = "22222222-2222-4222-8222-222222222222";

const USER_ADMIN = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_DEV = "bbbbbbbb-2222-4222-8222-222222222222";
const USER_BETA_ADMIN = "cccccccc-3333-4333-8333-333333333333";

const MEMBER_ADMIN = "11111111-aaaa-4111-8111-111111111111";
const MEMBER_DEV = "11111111-bbbb-4111-8111-111111111111";
const MEMBER_BETA_ADMIN = "22222222-aaaa-4222-8222-222222222222";

const CLIENT_ALPHA = "11111111-cccc-4111-8111-111111111111";
const CLIENT_BETA = "22222222-cccc-4222-8222-222222222222";

const PROJECT_ALPHA_1 = "11111111-dddd-4111-8111-111111111111";
const PROJECT_ALPHA_2 = "11111111-dddd-4111-8111-222222222222";
const PROJECT_BETA_1 = "22222222-dddd-4222-8222-111111111111";

const TIMESHEET_ALPHA_1 = "11111111-eeee-4111-8111-111111111111";

const ROLE_BA = "44444444-1111-4111-8111-111111111111";
const ROLE_EMP = "44444444-2222-4222-8222-222222222222";
const MR_ADMIN = "55555555-1111-4111-8111-111111111111";
const MR_DEV = "55555555-2222-4222-8222-222222222222";
const MR_BETA_ADMIN = "55555555-3333-4333-8333-333333333333";
const RL_1 = "66666666-1111-4111-8111-111111111111";
const PM_A1 = "77777777-1111-4111-8111-111111111111";
const PM_A2 = "77777777-2222-4222-8222-222222222222";
const TE_1 = "88888888-1111-4111-8111-111111111111";

describe(
  "Phase 1: PostgreSQL Drizzle Integration, Real Transactions & Tenant-Scoped Repositories",
  { timeout: 30000 },
  () => {
    async function setupRealPostgresDb() {
      const pg = new PGlite();
      const migrationPath = resolve(
        process.cwd(),
        "src/server/db/migrations/0001_initial_multi_tenant.sql",
      );
      const sqlContent = readFileSync(migrationPath, "utf8");
      await pg.exec(sqlContent);

      // Create least-privilege app role for testing RLS policies
      await pg.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aurelia_app_user') THEN
          CREATE ROLE aurelia_app_user WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
          GRANT USAGE ON SCHEMA public TO aurelia_app_user;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aurelia_app_user;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aurelia_app_user;
        END IF;
      END
      $$;
    `);

      const pgliteClient: QueryableTransactionClient = {
        query: async (
          textOrConfig: string | { text: string; values?: unknown[]; rowMode?: string },
          values?: unknown[],
        ) => {
          let text: string;
          let params: unknown[];
          let rowMode: "array" | "object" | undefined = undefined;

          if (typeof textOrConfig === "string") {
            text = textOrConfig;
            params = Array.isArray(values) ? values : [];
          } else if (textOrConfig && typeof textOrConfig === "object") {
            text = textOrConfig.text;
            params =
              Array.isArray(values) && values.length > 0
                ? values
                : Array.isArray(textOrConfig.values)
                  ? textOrConfig.values
                  : [];
            if (textOrConfig.rowMode === "array") {
              rowMode = "array";
            }
          } else {
            text = String(textOrConfig);
            params = Array.isArray(values) ? values : [];
          }

          const res = await pg.query(text, params, rowMode ? { rowMode } : undefined);
          return {
            rows: res.rows,
            rowCount: res.rows.length,
            command: "SELECT",
            oid: 0,
            fields: res.fields
              ? res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }))
              : [],
          } as unknown as QueryResult;
        },
        release: () => {},
      };

      const pglitePool: QueryableTransactionPool = {
        connect: async () => pgliteClient,
      };

      const db = drizzle(pgliteClient as unknown as Parameters<typeof drizzle>[0], {
        schema,
      }) as unknown as AureliaAwsDb;

      // Seed Tenants
      await pg.query(
        `INSERT INTO tenants (id, slug, name, status, onboarding_mode) VALUES 
       ('${TENANT_ALPHA}', 'alpha-consulting', 'Alpha Consulting Ltd', 'active', 'self_service'),
       ('${TENANT_BETA}', 'beta-tech', 'Beta Technologies Inc', 'active', 'self_service');`,
      );

      // Seed Users
      await pg.query(
        `INSERT INTO users (id, email, full_name, status, is_platform_admin) VALUES 
       ('${USER_ADMIN}', 'admin@alpha.com', 'Aarav Admin', 'active', false),
       ('${USER_DEV}', 'dev@alpha.com', 'Dev Employee', 'active', false),
       ('${USER_BETA_ADMIN}', 'admin@beta.com', 'Zara Beta Admin', 'active', false);`,
      );

      // Seed Memberships
      await pg.query(
        `INSERT INTO memberships (id, tenant_id, user_id, job_title, status) VALUES 
       ('${MEMBER_ADMIN}', '${TENANT_ALPHA}', '${USER_ADMIN}', 'Engineering Director', 'active'),
       ('${MEMBER_DEV}', '${TENANT_ALPHA}', '${USER_DEV}', 'Software Engineer', 'active'),
       ('${MEMBER_BETA_ADMIN}', '${TENANT_BETA}', '${USER_BETA_ADMIN}', 'VP Operations', 'active');`,
      );

      // Seed System Roles & Membership Roles
      await pg.query(
        `INSERT INTO roles (id, tenant_id, key, name, description, is_system_role) VALUES 
       ('${ROLE_BA}', NULL, 'business_admin', 'Business Admin', 'Full workspace admin', true),
       ('${ROLE_EMP}', NULL, 'employee', 'Employee', 'Standard workforce', true);`,
      );

      await pg.query(
        `INSERT INTO membership_roles (id, tenant_id, membership_id, role_id) VALUES 
       ('${MR_ADMIN}', '${TENANT_ALPHA}', '${MEMBER_ADMIN}', '${ROLE_BA}'),
       ('${MR_DEV}', '${TENANT_ALPHA}', '${MEMBER_DEV}', '${ROLE_EMP}'),
       ('${MR_BETA_ADMIN}', '${TENANT_BETA}', '${MEMBER_BETA_ADMIN}', '${ROLE_BA}');`,
      );

      // Seed Reporting Line: Dev reports to Admin
      await pg.query(
        `INSERT INTO reporting_lines (id, tenant_id, manager_membership_id, subordinate_membership_id, relationship_type, effective_from) VALUES 
       ('${RL_1}', '${TENANT_ALPHA}', '${MEMBER_ADMIN}', '${MEMBER_DEV}', 'primary_hr', '2026-01-01');`,
      );

      // Seed Clients
      await pg.query(
        `INSERT INTO clients (id, tenant_id, name, contact_name, contact_email, country) VALUES 
       ('${CLIENT_ALPHA}', '${TENANT_ALPHA}', 'Acme Global', 'John Acme', 'john@acme.com', 'India'),
       ('${CLIENT_BETA}', '${TENANT_BETA}', 'Nexus Corp', 'Jane Nexus', 'jane@nexus.com', 'Singapore');`,
      );

      // Seed Projects
      await pg.query(
        `INSERT INTO projects (id, tenant_id, client_id, name, project_manager_membership_id, status, budget_hours, billable_rate, tasks_json) VALUES 
       ('${PROJECT_ALPHA_1}', '${TENANT_ALPHA}', '${CLIENT_ALPHA}', 'Alpha Core Engine', '${MEMBER_ADMIN}', 'active', 250.00, 120.00, '["Design", "Backend", "QA"]'),
       ('${PROJECT_ALPHA_2}', '${TENANT_ALPHA}', '${CLIENT_ALPHA}', 'Alpha Analytics Suite', '${MEMBER_ADMIN}', 'on-hold', 100.00, 110.00, '["Dashboard", "Reports"]'),
       ('${PROJECT_BETA_1}', '${TENANT_BETA}', '${CLIENT_BETA}', 'Beta Security Gateway', '${MEMBER_BETA_ADMIN}', 'active', 500.00, 150.00, '["Firewall", "Audit"]');`,
      );

      // Seed Project Memberships
      await pg.query(
        `INSERT INTO project_memberships (id, tenant_id, project_id, membership_id, project_role, can_approve_timesheets, can_manage_allocations) VALUES 
       ('${PM_A1}', '${TENANT_ALPHA}', '${PROJECT_ALPHA_1}', '${MEMBER_DEV}', 'contributor', false, false),
       ('${PM_A2}', '${TENANT_ALPHA}', '${PROJECT_ALPHA_1}', '${MEMBER_ADMIN}', 'project_manager', true, true);`,
      );

      // Seed Timesheet and entry
      await pg.query(
        `INSERT INTO timesheets (id, tenant_id, membership_id, week_start, status) VALUES 
       ('${TIMESHEET_ALPHA_1}', '${TENANT_ALPHA}', '${MEMBER_DEV}', '2026-10-26', 'submitted');`,
      );

      await pg.query(
        `INSERT INTO timesheet_entries (id, tenant_id, timesheet_id, project_id, task_name, hours_by_day_json, billable, notes) VALUES 
       ('${TE_1}', '${TENANT_ALPHA}', '${TIMESHEET_ALPHA_1}', '${PROJECT_ALPHA_1}', 'Backend Development', '[8, 8, 8, 8, 8]', true, 'Core API implementation');`,
      );

      return { pg, pgliteClient, pglitePool, db };
    }

    it("1. Resolves tenant context from real PostgreSQL tables and aggregates permissions and reporting lines", async () => {
      const { pg, db } = await setupRealPostgresDb();

      // Resolve Admin Context in Tenant Alpha
      const adminCtx = await resolveTenantContextFromDb(db, USER_ADMIN, TENANT_ALPHA);
      expect(adminCtx.tenant.id).toBe(TENANT_ALPHA);
      expect(adminCtx.tenant.name).toBe("Alpha Consulting Ltd");
      expect(adminCtx.membership.id).toBe(MEMBER_ADMIN);
      expect(adminCtx.roleKeys.has("business_admin")).toBe(true);
      expect(adminCtx.permissions.has("project:write:all")).toBe(true);
      expect(adminCtx.permissions.has("tenant:members:manage")).toBe(true);
      expect(adminCtx.directReportMembershipIds.has(MEMBER_DEV)).toBe(true);

      // Resolve Dev Context in Tenant Alpha
      const devCtx = await resolveTenantContextFromDb(db, USER_DEV, TENANT_ALPHA);
      expect(devCtx.roleKeys.has("employee")).toBe(true);
      expect(devCtx.assignedProjectIds.has(PROJECT_ALPHA_1)).toBe(true);
      expect(devCtx.directReportMembershipIds.size).toBe(0);

      // Unassigned user in Tenant Beta should be blocked
      await expect(resolveTenantContextFromDb(db, USER_ADMIN, TENANT_BETA)).rejects.toThrow(
        TenantIsolationError,
      );

      await pg.close();
    });

    it("2. Lists projects from PostgreSQL with pagination, search, status filter, and sorting", async () => {
      const { pg, db, pglitePool } = await setupRealPostgresDb();
      const adminCtx = await resolveTenantContextFromDb(db, USER_ADMIN, TENANT_ALPHA);

      // All active projects with pagination
      const res1 = await listProjectsFromDb(
        adminCtx,
        { page: 1, limit: 10, status: "all" },
        { pool: pglitePool },
      );
      expect(res1.data).toHaveLength(2);
      expect(res1.pagination.total).toBe(2);
      expect(res1.pagination.totalPages).toBe(1);

      // Filter by status = "on-hold"
      const res2 = await listProjectsFromDb(adminCtx, { status: "on-hold" }, { pool: pglitePool });
      expect(res2.data).toHaveLength(1);
      expect(res2.data[0]?.name).toBe("Alpha Analytics Suite");

      // Search by name
      const res3 = await listProjectsFromDb(adminCtx, { search: "Engine" }, { pool: pglitePool });
      expect(res3.data).toHaveLength(1);
      expect(res3.data[0]?.name).toBe("Alpha Core Engine");

      // Pagination: page 1 with limit 1
      const pagedRes = await listProjectsFromDb(
        adminCtx,
        { page: 1, limit: 1, sortBy: "name", sortOrder: "asc" },
        { pool: pglitePool },
      );
      expect(pagedRes.data).toHaveLength(1);
      expect(pagedRes.pagination.page).toBe(1);
      expect(pagedRes.pagination.limit).toBe(1);
      expect(pagedRes.pagination.total).toBe(2);
      expect(pagedRes.pagination.totalPages).toBe(2);

      await pg.close();
    });

    it("3. Updates project budget transactionally and writes immutable audit log in PostgreSQL", async () => {
      const { pg, db, pglitePool } = await setupRealPostgresDb();
      const adminCtx = await resolveTenantContextFromDb(db, USER_ADMIN, TENANT_ALPHA);

      // Update budget from 250 to 300
      const updated = await updateProjectBudgetInDb(adminCtx, PROJECT_ALPHA_1, 300, {
        pool: pglitePool,
      });
      expect(updated.budgetHours).toBe(300);

      // Verify persisted in PostgreSQL
      const fetched = await getProjectByIdFromDb(adminCtx, PROJECT_ALPHA_1, { pool: pglitePool });
      expect(fetched.budgetHours).toBe(300);

      // Verify audit log record created in PostgreSQL
      const auditRes = await listTenantAuditLogsFromDb(adminCtx, {}, { pool: pglitePool });
      expect(auditRes.data.length).toBeGreaterThanOrEqual(1);
      const budgetLog = auditRes.data.find((l) => l.action === "project.budget.updated");
      expect(budgetLog).toBeDefined();
      expect(budgetLog?.targetId).toBe(PROJECT_ALPHA_1);
      expect(budgetLog?.tenantId).toBe(TENANT_ALPHA);

      // Negative budget hours should be rejected
      await expect(
        updateProjectBudgetInDb(adminCtx, PROJECT_ALPHA_1, -50, { pool: pglitePool }),
      ).rejects.toThrow(/Budget hours must be a non-negative number/);

      await pg.close();
    });

    it("4. Approves timesheets transactionally with approval records and audit logs", async () => {
      const { pg, db, pglitePool } = await setupRealPostgresDb();
      const adminCtx = await resolveTenantContextFromDb(db, USER_ADMIN, TENANT_ALPHA);

      // Admin approves dev's submitted timesheet
      const approved = await approveTimesheetInDb(
        adminCtx,
        TIMESHEET_ALPHA_1,
        "Excellent progress on backend API",
        { pool: pglitePool },
      );
      expect(approved.status).toBe("approved");

      // Verify approvals table in database has approval row
      const approvalCheck = await pg.query(
        `SELECT status, comment FROM approvals WHERE target_id = '${TIMESHEET_ALPHA_1}';`,
      );
      expect(approvalCheck.rows).toHaveLength(1);
      expect((approvalCheck.rows[0] as { status: string }).status).toBe("approved");

      // Verify audit trail recorded timesheet.approved
      const auditRes = await listTenantAuditLogsFromDb(
        adminCtx,
        { category: "approval" },
        { pool: pglitePool },
      );
      expect(auditRes.data.some((l) => l.action === "timesheet.approved")).toBe(true);

      await pg.close();
    });

    it("5. Enforces PostgreSQL Row-Level Security: cross-tenant access is strictly blocked", async () => {
      const { pg, db, pglitePool } = await setupRealPostgresDb();
      const adminAlpha = await resolveTenantContextFromDb(db, USER_ADMIN, TENANT_ALPHA);
      const adminBeta = await resolveTenantContextFromDb(db, USER_BETA_ADMIN, TENANT_BETA);

      // Admin Alpha attempting to access Project Beta 1 is blocked by TenantIsolationError
      await expect(
        getProjectByIdFromDb(adminAlpha, PROJECT_BETA_1, { pool: pglitePool }),
      ).rejects.toThrow(/Project .* not found|TenantIsolationError/);

      // Admin Beta cannot view Project Alpha 1
      await expect(
        getProjectByIdFromDb(adminBeta, PROJECT_ALPHA_1, { pool: pglitePool }),
      ).rejects.toThrow(/Project .* not found|TenantIsolationError/);

      // Admin Alpha querying team members sees only Tenant Alpha members
      const teamAlpha = await listAccessibleTeamMembersFromDb(adminAlpha, {}, { pool: pglitePool });
      expect(teamAlpha.data.every((m) => m.tenantId === TENANT_ALPHA)).toBe(true);
      expect(teamAlpha.data.some((m) => m.id === MEMBER_BETA_ADMIN)).toBe(false);

      await pg.close();
    });

    it("6. API router handleApiRequest dispatches PostgreSQL queries when pool is provided and rejects forged headers", async () => {
      const { pg, db, pglitePool } = await setupRealPostgresDb();

      // 0. Forged x-aurelia-user-id header without a valid session is rejected with HTTP 401
      const forgedHeaderRes = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/tenants", {
          headers: { "x-aurelia-user-id": USER_ADMIN },
        }),
        { pool: pglitePool, db },
      );
      expect(forgedHeaderRes?.status).toBe(401);

      // Issue a PostgreSQL-persisted session for USER_ADMIN
      const { rawToken } = await defaultSessionManager.createSessionInDb(
        USER_ADMIN,
        "admin@alpha.com",
        { db },
      );
      const authHeaders = {
        cookie: `aurelia_session=${rawToken}`,
      };

      // 1. Authenticated GET /api/v1/auth/tenants backed by PostgreSQL
      const tenantsRes = await handleApiRequest(
        new Request("http://localhost/api/v1/auth/tenants", {
          headers: authHeaders,
        }),
        { pool: pglitePool, db },
      );
      expect(tenantsRes?.status).toBe(200);
      const tenantsJson = (await tenantsRes?.json()) as {
        tenants: Array<{ tenant: { id: string } }>;
      };
      expect(tenantsJson.tenants).toHaveLength(1);
      expect(tenantsJson.tenants[0]?.tenant.id).toBe(TENANT_ALPHA);

      // 2. Authenticated GET /api/v1/tenants/:tenantId/projects?page=1&limit=5 backed by PostgreSQL
      const projectsRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${TENANT_ALPHA}/projects?page=1&limit=5`, {
          headers: authHeaders,
        }),
        { pool: pglitePool, db },
      );
      expect(projectsRes?.status).toBe(200);
      const projectsJson = (await projectsRes?.json()) as {
        projects: Array<{ id: string; name: string }>;
        pagination: { total: number; page: number };
      };
      expect(projectsJson.projects).toHaveLength(2);
      expect(projectsJson.pagination.total).toBe(2);

      // 3. Authenticated PATCH /api/v1/tenants/:tenantId/projects/:projectId backed by PostgreSQL
      const patchRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${TENANT_ALPHA}/projects/${PROJECT_ALPHA_1}`, {
          method: "PATCH",
          headers: {
            ...authHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({ budgetHours: 420 }),
        }),
        { pool: pglitePool, db },
      );
      expect(patchRes?.status).toBe(200);
      const patchJson = (await patchRes?.json()) as { project: { budgetHours: number } };
      expect(patchJson.project.budgetHours).toBe(420);

      // 4. Cross-tenant request is rejected with 403 TENANT_ISOLATION_VIOLATION
      const crossRes = await handleApiRequest(
        new Request(`http://localhost/api/v1/tenants/${TENANT_BETA}/projects`, {
          headers: authHeaders,
        }),
        { pool: pglitePool, db },
      );
      expect(crossRes?.status).toBe(403);

      await pg.close();
    });
  },
);
