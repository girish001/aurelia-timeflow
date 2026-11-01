import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  assertCanAccessTeamMember,
  assertCanManageProject,
  assertSameTenant,
  canAccessTeamMember,
  canApproveTimesheetRecord,
  canManageProject,
  canViewProject,
  SYSTEM_ROLE_PERMISSIONS,
} from "../authz/rbac";
import {
  assertValidTenantExecutionContext,
  getAwsPostgresPool,
  withTenantDatabaseScope,
  type AureliaAwsDb,
  type QueryableTransactionPool,
} from "../db/aws-postgres";
import * as schema from "../db/schema";
import {
  AuthorizationError,
  TenantIsolationError,
  type AuditLogRecord,
  type MembershipRecord,
  type PermissionCode,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type ResolvedTenantContext,
  type RoleKey,
  type SystemRoleKey,
  type TenantRecord,
  type TimesheetRecord,
  type UserRecord,
} from "../tenancy/tenant-context";

// ============================================================================
// Types for Query Options: Pagination, Sorting, Filtering
// ============================================================================

export interface PaginationOptions {
  page?: number | undefined;
  limit?: number | undefined;
}

export interface ProjectQueryOptions extends PaginationOptions {
  status?: "active" | "on-hold" | "completed" | "all" | undefined;
  search?: string | undefined;
  sortBy?: "name" | "createdAt" | "budgetHours" | undefined;
  sortOrder?: "asc" | "desc" | undefined;
}

export interface TeamQueryOptions extends PaginationOptions {
  departmentId?: string | undefined;
  search?: string | undefined;
  status?: "active" | "invited" | "inactive" | "all" | undefined;
}

export interface AuditLogQueryOptions extends PaginationOptions {
  category?: string | undefined;
  search?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ScopeOptions {
  pool?: QueryableTransactionPool | undefined;
  env?: Record<string, string | undefined> | undefined;
}

// ============================================================================
// 1. Context Resolution from Real PostgreSQL Database
// ============================================================================

/**
 * Resolves a verified `ResolvedTenantContext` directly from PostgreSQL.
 * Security Invariants:
 * 1. Checks tenant exists and is not suspended/archived.
 * 2. Checks user exists and is active.
 * 3. Enforces that an explicit, active `memberships` row exists for (userId, tenantId).
 *    Email domain matching alone NEVER grants access.
 * 4. Aggregates system and custom role permissions.
 * 5. Aggregates direct reports (HR hierarchy) and managed projects.
 */
export async function resolveTenantContextFromDb(
  db: AureliaAwsDb,
  userId: string,
  tenantId: string,
): Promise<ResolvedTenantContext> {
  // 1. Fetch Tenant
  const tenantRows = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);

  const tenant = tenantRows[0];
  if (!tenant || tenant.status === "suspended" || tenant.status === "archived") {
    throw new TenantIsolationError(`Tenant ${tenantId} is unavailable or suspended.`);
  }

  // 2. Fetch User
  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);

  const user = userRows[0];
  if (!user || user.status !== "active") {
    throw new TenantIsolationError(`User ${userId} is not active.`);
  }

  // 3. Fetch Explicit Active Membership
  const membershipRows = await db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, userId)))
    .limit(1);

  const membership = membershipRows[0];
  if (!membership || membership.status !== "active") {
    throw new TenantIsolationError(
      `Access denied: user ${user.email} has no active membership in tenant ${tenant.slug}. Email domain matching alone does not grant access.`,
    );
  }

  // 4. Multi-Role & Permission Aggregation
  const roleAssignments = await db
    .select({
      roleId: schema.membershipRoles.roleId,
      key: schema.roles.key,
      isSystemRole: schema.roles.isSystemRole,
    })
    .from(schema.membershipRoles)
    .innerJoin(schema.roles, eq(schema.membershipRoles.roleId, schema.roles.id))
    .where(
      and(
        eq(schema.membershipRoles.tenantId, tenantId),
        eq(schema.membershipRoles.membershipId, membership.id),
      ),
    );

  const roleKeys = new Set<RoleKey>();
  const permissions = new Set<PermissionCode>();

  for (const ra of roleAssignments) {
    if (ra.key) {
      roleKeys.add(ra.key as RoleKey);
      if (ra.key in SYSTEM_ROLE_PERMISSIONS) {
        const sysPerms = SYSTEM_ROLE_PERMISSIONS[ra.key as SystemRoleKey];
        sysPerms.forEach((p) => permissions.add(p));
      }
    }
  }

  // Also query any custom role permissions defined in role_permissions table
  if (roleAssignments.length > 0) {
    const roleIds = roleAssignments.map((ra) => ra.roleId);
    const customPermRows = await db
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
      .where(inArray(schema.rolePermissions.roleId, roleIds));

    for (const cp of customPermRows) {
      permissions.add(cp.code as PermissionCode);
    }
  }

  // 5. Reporting Lines (Direct Reports in HR Hierarchy)
  const reportingLineRows = await db
    .select({ subordinateMembershipId: schema.reportingLines.subordinateMembershipId })
    .from(schema.reportingLines)
    .where(
      and(
        eq(schema.reportingLines.tenantId, tenantId),
        eq(schema.reportingLines.managerMembershipId, membership.id),
      ),
    );

  const directReportMembershipIds = new Set<string>(
    reportingLineRows.map((rl) => rl.subordinateMembershipId),
  );

  // 6. Managed & Assigned Projects
  const managedProjectIds = new Set<string>();
  const assignedProjectIds = new Set<string>();

  const pmProjects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.tenantId, tenantId),
        eq(schema.projects.projectManagerMembershipId, membership.id),
      ),
    );

  for (const p of pmProjects) {
    managedProjectIds.add(p.id);
    assignedProjectIds.add(p.id);
  }

  const projectMemberRows = await db
    .select({
      projectId: schema.projectMemberships.projectId,
      projectRole: schema.projectMemberships.projectRole,
      canManageAllocations: schema.projectMemberships.canManageAllocations,
      canApproveTimesheets: schema.projectMemberships.canApproveTimesheets,
    })
    .from(schema.projectMemberships)
    .where(
      and(
        eq(schema.projectMemberships.tenantId, tenantId),
        eq(schema.projectMemberships.membershipId, membership.id),
      ),
    );

  for (const pm of projectMemberRows) {
    assignedProjectIds.add(pm.projectId);
    if (
      pm.projectRole === "project_manager" ||
      pm.canManageAllocations ||
      pm.canApproveTimesheets
    ) {
      managedProjectIds.add(pm.projectId);
    }
  }

  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status as TenantRecord["status"],
      onboardingMode: tenant.onboardingMode as TenantRecord["onboardingMode"],
    },
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
      isPlatformAdmin: user.isPlatformAdmin,
      status: user.status as UserRecord["status"],
    },
    membership: {
      id: membership.id,
      tenantId: membership.tenantId,
      userId: membership.userId,
      jobTitle: membership.jobTitle,
      status: membership.status as MembershipRecord["status"],
    },
    roleKeys,
    permissions,
    directReportMembershipIds,
    managedProjectIds,
    assignedProjectIds,
  };
}

/**
 * Lists all active tenant workspaces where a given user holds an active membership.
 */
export async function listUserTenantsFromDb(
  db: AureliaAwsDb,
  userId: string,
): Promise<Array<{ tenant: TenantRecord; membership: MembershipRecord }>> {
  const rows = await db
    .select({
      tenant: schema.tenants,
      membership: schema.memberships,
    })
    .from(schema.memberships)
    .innerJoin(schema.tenants, eq(schema.memberships.tenantId, schema.tenants.id))
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.status, "active"),
        eq(schema.tenants.status, "active"),
      ),
    );

  return rows.map((r) => ({
    tenant: {
      id: r.tenant.id,
      slug: r.tenant.slug,
      name: r.tenant.name,
      status: r.tenant.status as TenantRecord["status"],
      onboardingMode: r.tenant.onboardingMode as TenantRecord["onboardingMode"],
    },
    membership: {
      id: r.membership.id,
      tenantId: r.membership.tenantId,
      userId: r.membership.userId,
      jobTitle: r.membership.jobTitle,
      status: r.membership.status as MembershipRecord["status"],
    },
  }));
}

// ============================================================================
// 2. Tenant-Scoped PostgreSQL Queries Using withTenantDatabaseScope
// ============================================================================

/**
 * Lists projects visible to the caller inside a PostgreSQL transaction with active RLS.
 * Supports pagination, filtering by status, search by name/code, and sorting.
 */
export async function listProjectsFromDb(
  ctx: ResolvedTenantContext,
  options: ProjectQueryOptions = {},
  scopeOptions?: ScopeOptions,
): Promise<PaginatedResult<ProjectRecord>> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const page = Math.max(1, Number(options.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
      const offset = (page - 1) * limit;

      // Fetch caller's project memberships in this tenant
      const pms = await db
        .select()
        .from(schema.projectMemberships)
        .where(eq(schema.projectMemberships.tenantId, verifiedTenantId));

      const isBusinessAdmin =
        ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:projects:manage");

      // Build WHERE conditions
      const conditions = [eq(schema.projects.tenantId, verifiedTenantId)];

      if (options.status && options.status !== "all") {
        conditions.push(eq(schema.projects.status, options.status));
      }

      if (options.search?.trim()) {
        const searchPattern = `%${options.search.trim()}%`;
        conditions.push(ilike(schema.projects.name, searchPattern));
      }

      // If not business admin, only projects assigned or managed
      if (!isBusinessAdmin) {
        const accessibleIds = Array.from(ctx.assignedProjectIds);
        if (accessibleIds.length === 0) {
          return {
            data: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          };
        }
        conditions.push(inArray(schema.projects.id, accessibleIds));
      }

      const whereClause = and(...conditions);

      // Total count
      const totalCountRows = await db
        .select({ count: count() })
        .from(schema.projects)
        .where(whereClause);
      const total = Number(totalCountRows[0]?.count ?? 0);

      // Order By
      let orderByExpr = desc(schema.projects.createdAt);
      if (options.sortBy === "name") {
        orderByExpr =
          options.sortOrder === "desc" ? desc(schema.projects.name) : asc(schema.projects.name);
      } else if (options.sortBy === "budgetHours") {
        orderByExpr =
          options.sortOrder === "desc"
            ? desc(schema.projects.budgetHours)
            : asc(schema.projects.budgetHours);
      } else if (options.sortOrder === "asc") {
        orderByExpr = asc(schema.projects.createdAt);
      }

      // Query data
      const rows = await db
        .select()
        .from(schema.projects)
        .where(whereClause)
        .orderBy(orderByExpr)
        .limit(limit)
        .offset(offset);

      const data: ProjectRecord[] = rows.map((p) => ({
        id: p.id,
        tenantId: p.tenantId,
        clientId: p.clientId,
        name: p.name,
        projectManagerMembershipId: p.projectManagerMembershipId,
        budgetHours: Number(p.budgetHours),
        billableRate: Number(p.billableRate),
        status: p.status,
      }));

      return {
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    },
    scopeOptions,
  );
}

/**
 * Retrieves a single project by ID verifying tenant boundary and project authorization.
 */
export async function getProjectByIdFromDb(
  ctx: ResolvedTenantContext,
  projectId: string,
  scopeOptions?: ScopeOptions,
): Promise<ProjectRecord> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const rows = await db
        .select()
        .from(schema.projects)
        .where(
          and(eq(schema.projects.tenantId, verifiedTenantId), eq(schema.projects.id, projectId)),
        )
        .limit(1);

      const project = rows[0];
      if (!project) {
        throw new Error(`Project ${projectId} not found.`);
      }

      assertSameTenant(ctx, project.tenantId);

      const pms = await db
        .select()
        .from(schema.projectMemberships)
        .where(eq(schema.projectMemberships.tenantId, verifiedTenantId));

      const convertedProject: ProjectRecord = {
        id: project.id,
        tenantId: project.tenantId,
        clientId: project.clientId,
        name: project.name,
        projectManagerMembershipId: project.projectManagerMembershipId,
        budgetHours: Number(project.budgetHours),
        billableRate: Number(project.billableRate),
        status: project.status,
      };

      const convertedPms: ProjectMembershipRecord[] = pms.map((pm) => ({
        id: pm.id,
        tenantId: pm.tenantId,
        projectId: pm.projectId,
        membershipId: pm.membershipId,
        projectRole: pm.projectRole,
        canManageAllocations: pm.canManageAllocations,
      }));

      if (!canViewProject(ctx, convertedProject, convertedPms)) {
        throw new AuthorizationError(
          `Membership ${ctx.membership.id} is not authorized to view project ${project.id}.`,
        );
      }

      return convertedProject;
    },
    scopeOptions,
  );
}

/**
 * Updates project budget hours in PostgreSQL within an isolated transaction.
 * Records an immutable audit log entry within the same transaction.
 */
export async function updateProjectBudgetInDb(
  ctx: ResolvedTenantContext,
  projectId: string,
  newBudgetHours: number,
  scopeOptions?: ScopeOptions,
): Promise<ProjectRecord> {
  if (isNaN(newBudgetHours) || newBudgetHours < 0) {
    throw new Error("Budget hours must be a non-negative number.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const rows = await db
        .select()
        .from(schema.projects)
        .where(
          and(eq(schema.projects.tenantId, verifiedTenantId), eq(schema.projects.id, projectId)),
        )
        .limit(1);

      const project = rows[0];
      if (!project) {
        throw new Error(`Project ${projectId} not found.`);
      }

      assertSameTenant(ctx, project.tenantId);

      const pms = await db
        .select()
        .from(schema.projectMemberships)
        .where(eq(schema.projectMemberships.tenantId, verifiedTenantId));

      const convertedProject: ProjectRecord = {
        id: project.id,
        tenantId: project.tenantId,
        clientId: project.clientId,
        name: project.name,
        projectManagerMembershipId: project.projectManagerMembershipId,
        budgetHours: Number(project.budgetHours),
        billableRate: Number(project.billableRate),
        status: project.status,
      };

      const convertedPms: ProjectMembershipRecord[] = pms.map((pm) => ({
        id: pm.id,
        tenantId: pm.tenantId,
        projectId: pm.projectId,
        membershipId: pm.membershipId,
        projectRole: pm.projectRole,
        canManageAllocations: pm.canManageAllocations,
      }));

      assertCanManageProject(ctx, convertedProject, convertedPms);

      // Perform UPDATE
      const updatedRows = await db
        .update(schema.projects)
        .set({
          budgetHours: String(newBudgetHours),
        })
        .where(
          and(eq(schema.projects.tenantId, verifiedTenantId), eq(schema.projects.id, projectId)),
        )
        .returning();

      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`Failed to update project ${projectId}.`);
      }

      // Record Audit Log within transaction
      await recordAuditLogToDb(db, {
        tenantId: verifiedTenantId,
        actorUserId: ctx.user.id,
        actorMembershipId: ctx.membership.id,
        impersonatedByPlatformUserId: ctx.impersonatedByPlatformUserId,
        category: "project",
        action: "project.budget.updated",
        targetType: "project",
        targetId: projectId,
        metadata: { oldBudgetHours: project.budgetHours, newBudgetHours },
      });

      return {
        id: updated.id,
        tenantId: updated.tenantId,
        clientId: updated.clientId,
        name: updated.name,
        projectManagerMembershipId: updated.projectManagerMembershipId,
        budgetHours: Number(updated.budgetHours),
        billableRate: Number(updated.billableRate),
        status: updated.status,
      };
    },
    scopeOptions,
  );
}

/**
 * Lists accessible team members scoped to the caller's HR reporting hierarchy or admin scope.
 * Supports pagination, filtering by department, and search by job title.
 */
export async function listAccessibleTeamMembersFromDb(
  ctx: ResolvedTenantContext,
  options: TeamQueryOptions = {},
  scopeOptions?: ScopeOptions,
): Promise<PaginatedResult<MembershipRecord>> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const page = Math.max(1, Number(options.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(options.limit) || 20));
      const offset = (page - 1) * limit;

      const isBusinessAdmin =
        ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:members:manage");

      const conditions = [eq(schema.memberships.tenantId, verifiedTenantId)];

      if (options.status && options.status !== "all") {
        conditions.push(eq(schema.memberships.status, options.status));
      }

      if (options.departmentId) {
        conditions.push(eq(schema.memberships.departmentId, options.departmentId));
      }

      if (options.search?.trim()) {
        conditions.push(ilike(schema.memberships.jobTitle, `%${options.search.trim()}%`));
      }

      // Scope restriction: Non-admins can only view themselves and their direct reports
      if (!isBusinessAdmin) {
        const allowedMembershipIds = [
          ctx.membership.id,
          ...Array.from(ctx.directReportMembershipIds),
        ];
        conditions.push(inArray(schema.memberships.id, allowedMembershipIds));
      }

      const whereClause = and(...conditions);

      const totalCountRows = await db
        .select({ count: count() })
        .from(schema.memberships)
        .where(whereClause);
      const total = Number(totalCountRows[0]?.count ?? 0);

      const rows = await db
        .select()
        .from(schema.memberships)
        .where(whereClause)
        .orderBy(asc(schema.memberships.jobTitle))
        .limit(limit)
        .offset(offset);

      const data: MembershipRecord[] = rows.map((m) => ({
        id: m.id,
        tenantId: m.tenantId,
        userId: m.userId,
        jobTitle: m.jobTitle,
        status: m.status as MembershipRecord["status"],
      }));

      return {
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    },
    scopeOptions,
  );
}

/**
 * Retrieves a single team member profile verifying tenant isolation and reporting line access.
 */
export async function getTeamMemberProfileFromDb(
  ctx: ResolvedTenantContext,
  targetMembershipId: string,
  scopeOptions?: ScopeOptions,
): Promise<MembershipRecord> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const rows = await db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.tenantId, verifiedTenantId),
            eq(schema.memberships.id, targetMembershipId),
          ),
        )
        .limit(1);

      const member = rows[0];
      if (!member) {
        throw new Error(`Membership ${targetMembershipId} not found.`);
      }

      assertSameTenant(ctx, member.tenantId);

      const converted: MembershipRecord = {
        id: member.id,
        tenantId: member.tenantId,
        userId: member.userId,
        jobTitle: member.jobTitle,
        status: member.status as MembershipRecord["status"],
      };

      assertCanAccessTeamMember(ctx, converted);
      return converted;
    },
    scopeOptions,
  );
}

/**
 * Approves a timesheet in PostgreSQL inside a dedicated transaction.
 * Enforces HR direct report or project manager approval authority.
 * Creates approval record and audit log entry within the same transaction.
 */
export async function approveTimesheetInDb(
  ctx: ResolvedTenantContext,
  timesheetId: string,
  comment?: string,
  scopeOptions?: ScopeOptions,
): Promise<TimesheetRecord> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const tsRows = await db
        .select()
        .from(schema.timesheets)
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.id, timesheetId),
          ),
        )
        .limit(1);

      const ts = tsRows[0];
      if (!ts) {
        throw new Error(`Timesheet ${timesheetId} not found.`);
      }

      assertSameTenant(ctx, ts.tenantId);

      // Find the project associated with this timesheet via its entries
      const entryRows = await db
        .select({ projectId: schema.timesheetEntries.projectId })
        .from(schema.timesheetEntries)
        .where(
          and(
            eq(schema.timesheetEntries.tenantId, verifiedTenantId),
            eq(schema.timesheetEntries.timesheetId, timesheetId),
          ),
        )
        .limit(1);

      const projectId = entryRows[0]?.projectId;
      if (!projectId) {
        throw new Error(`Timesheet ${timesheetId} has no associated project entry.`);
      }

      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(
          and(eq(schema.projects.tenantId, verifiedTenantId), eq(schema.projects.id, projectId)),
        )
        .limit(1);

      const project = projectRows[0];
      if (!project) {
        throw new Error(`Project ${projectId} not found.`);
      }

      const pmsRows = await db
        .select()
        .from(schema.projectMemberships)
        .where(eq(schema.projectMemberships.tenantId, verifiedTenantId));

      const convertedTs: TimesheetRecord = {
        id: ts.id,
        tenantId: ts.tenantId,
        membershipId: ts.membershipId,
        projectId,
        weekStartDate: ts.weekStart,
        status: ts.status as TimesheetRecord["status"],
      };

      const convertedProject: ProjectRecord = {
        id: project.id,
        tenantId: project.tenantId,
        clientId: project.clientId,
        name: project.name,
        projectManagerMembershipId: project.projectManagerMembershipId,
        budgetHours: Number(project.budgetHours),
        billableRate: Number(project.billableRate),
        status: project.status,
      };

      const convertedPms: ProjectMembershipRecord[] = pmsRows.map((pm) => ({
        id: pm.id,
        tenantId: pm.tenantId,
        projectId: pm.projectId,
        membershipId: pm.membershipId,
        projectRole: pm.projectRole,
        canManageAllocations: pm.canManageAllocations,
      }));

      if (!canApproveTimesheetRecord(ctx, convertedTs, convertedProject, convertedPms)) {
        throw new AuthorizationError(
          `Membership ${ctx.membership.id} is not authorized to approve timesheet ${timesheetId}.`,
        );
      }

      // Perform Timesheet UPDATE
      const now = new Date();
      await db
        .update(schema.timesheets)
        .set({
          status: "approved",
          reviewedAt: now,
          reviewedByMembershipId: ctx.membership.id,
          reviewComment: comment ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.id, timesheetId),
          ),
        );

      // Create an approval tracking record
      await db.insert(schema.approvals).values({
        tenantId: verifiedTenantId,
        targetType: "timesheet",
        targetId: timesheetId,
        requesterMembershipId: ts.membershipId,
        approverMembershipId: ctx.membership.id,
        status: "approved",
        comment: comment ?? null,
        decidedAt: now,
      });

      // Record Audit Log within transaction
      await recordAuditLogToDb(db, {
        tenantId: verifiedTenantId,
        actorUserId: ctx.user.id,
        actorMembershipId: ctx.membership.id,
        impersonatedByPlatformUserId: ctx.impersonatedByPlatformUserId,
        category: "approval",
        action: "timesheet.approved",
        targetType: "timesheet",
        targetId: timesheetId,
        metadata: { comment },
      });

      return {
        ...convertedTs,
        status: "approved",
      };
    },
    scopeOptions,
  );
}

/**
 * Rejects a timesheet in PostgreSQL within a dedicated transaction.
 * Requires a mandatory rejection comment.
 */
export async function rejectTimesheetInDb(
  ctx: ResolvedTenantContext,
  timesheetId: string,
  rejectionComment: string,
  scopeOptions?: ScopeOptions,
): Promise<TimesheetRecord> {
  if (!rejectionComment || rejectionComment.trim().length < 3) {
    throw new Error("A rejection comment of at least 3 characters is required.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const tsRows = await db
        .select()
        .from(schema.timesheets)
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.id, timesheetId),
          ),
        )
        .limit(1);

      const ts = tsRows[0];
      if (!ts) {
        throw new Error(`Timesheet ${timesheetId} not found.`);
      }

      assertSameTenant(ctx, ts.tenantId);

      const entryRows = await db
        .select({ projectId: schema.timesheetEntries.projectId })
        .from(schema.timesheetEntries)
        .where(
          and(
            eq(schema.timesheetEntries.tenantId, verifiedTenantId),
            eq(schema.timesheetEntries.timesheetId, timesheetId),
          ),
        )
        .limit(1);

      const projectId = entryRows[0]?.projectId ?? "";
      const now = new Date();

      await db
        .update(schema.timesheets)
        .set({
          status: "rejected",
          reviewedAt: now,
          reviewedByMembershipId: ctx.membership.id,
          reviewComment: rejectionComment.trim(),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.id, timesheetId),
          ),
        );

      await db.insert(schema.approvals).values({
        tenantId: verifiedTenantId,
        targetType: "timesheet",
        targetId: timesheetId,
        requesterMembershipId: ts.membershipId,
        approverMembershipId: ctx.membership.id,
        status: "rejected",
        comment: rejectionComment.trim(),
        decidedAt: now,
      });

      await recordAuditLogToDb(db, {
        tenantId: verifiedTenantId,
        actorUserId: ctx.user.id,
        actorMembershipId: ctx.membership.id,
        impersonatedByPlatformUserId: ctx.impersonatedByPlatformUserId,
        category: "approval",
        action: "timesheet.rejected",
        targetType: "timesheet",
        targetId: timesheetId,
        metadata: { rejectionComment: rejectionComment.trim() },
      });

      return {
        id: ts.id,
        tenantId: ts.tenantId,
        membershipId: ts.membershipId,
        projectId,
        weekStartDate: ts.weekStart,
        status: "rejected",
      };
    },
    scopeOptions,
  );
}

/**
 * Lists tenant audit logs with pagination, category filter, and search.
 * Strictly checks `audit:read:tenant` permission.
 */
export async function listTenantAuditLogsFromDb(
  ctx: ResolvedTenantContext,
  options: AuditLogQueryOptions = {},
  scopeOptions?: ScopeOptions,
): Promise<PaginatedResult<AuditLogRecord>> {
  if (!ctx.permissions.has("audit:read:tenant")) {
    throw new AuthorizationError("Only authorized administrators can read tenant audit logs.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const page = Math.max(1, Number(options.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
      const offset = (page - 1) * limit;

      const conditions = [eq(schema.auditLogs.tenantId, verifiedTenantId)];

      if (options.category && options.category !== "all") {
        conditions.push(eq(schema.auditLogs.category, options.category));
      }

      if (options.search?.trim()) {
        const pattern = `%${options.search.trim()}%`;
        conditions.push(ilike(schema.auditLogs.action, pattern));
      }

      if (options.startDate) {
        conditions.push(sql`${schema.auditLogs.createdAt} >= ${new Date(options.startDate)}`);
      }

      if (options.endDate) {
        conditions.push(sql`${schema.auditLogs.createdAt} <= ${new Date(options.endDate)}`);
      }

      const whereClause = and(...conditions);

      const totalRows = await db
        .select({ count: count() })
        .from(schema.auditLogs)
        .where(whereClause);
      const total = Number(totalRows[0]?.count ?? 0);

      const rows = await db
        .select()
        .from(schema.auditLogs)
        .where(whereClause)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(limit)
        .offset(offset);

      const data: AuditLogRecord[] = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        actorUserId: r.actorUserId,
        actorMembershipId: r.actorMembershipId ?? "",
        impersonatedByPlatformUserId: r.impersonatedByPlatformUserId ?? undefined,
        category: r.category,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        createdAt: r.createdAt.toISOString(),
      }));

      return {
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    },
    scopeOptions,
  );
}

/**
 * Inserts an immutable audit log row inside a PostgreSQL transaction.
 */
export async function recordAuditLogToDb(
  txDb: AureliaAwsDb,
  entry: {
    tenantId: string;
    actorUserId: string;
    actorMembershipId?: string | undefined;
    impersonatedByPlatformUserId?: string | undefined;
    category: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown> | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  },
): Promise<void> {
  await txDb.insert(schema.auditLogs).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    actorMembershipId: entry.actorMembershipId ?? null,
    impersonatedByPlatformUserId: entry.impersonatedByPlatformUserId ?? null,
    category: entry.category,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    detailsJson: entry.metadata ?? {},
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  });
}

/**
 * Self-service company registration in PostgreSQL.
 * Inserts tenant, administrator user, membership, and business_admin role inside a database transaction.
 */
export async function registerCompanyInDb(
  poolOrDb: {
    pool?: QueryableTransactionPool;
    db?: AureliaAwsDb;
    env?: Record<string, string | undefined>;
  },
  input: {
    companyName: string;
    slug: string;
    adminEmail: string;
    adminFullName: string;
    adminJobTitle?: string | undefined;
  },
): Promise<{
  tenant: TenantRecord;
  adminUser: UserRecord;
  adminMembership: MembershipRecord;
  verificationToken: string;
}> {
  const slug = input.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (slug.length < 2) {
    throw new Error("Company workspace slug must be at least 2 characters.");
  }
  const email = input.adminEmail.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("A valid administrator work email is required.");
  }

  const pool = poolOrDb.pool ?? getAwsPostgresPool(poolOrDb.env);
  const client = await pool.connect();
  try {
    await client.query("BEGIN;");

    // 1. Insert Tenant
    const tenantRes = await client.query(
      `INSERT INTO tenants (slug, name, status, onboarding_mode) 
       VALUES ($1, $2, 'onboarding', 'self_service') 
       RETURNING id, slug, name, status, onboarding_mode;`,
      [slug, input.companyName.trim()],
    );
    const tenantRow = tenantRes.rows[0];

    // 2. Insert or find User
    const existingUserRes = await client.query(
      `SELECT id, email, full_name, email_verified_at, is_platform_admin, status FROM users WHERE email = $1;`,
      [email],
    );
    let userRow = existingUserRes.rows[0];
    if (!userRow) {
      const newUserRes = await client.query(
        `INSERT INTO users (email, full_name, is_platform_admin, status) 
         VALUES ($1, $2, false, 'active') 
         RETURNING id, email, full_name, email_verified_at, is_platform_admin, status;`,
        [email, input.adminFullName.trim()],
      );
      userRow = newUserRes.rows[0];
    }

    // 3. Insert Membership
    const memberRes = await client.query(
      `INSERT INTO memberships (tenant_id, user_id, job_title, status) 
       VALUES ($1, $2, $3, 'active') 
       RETURNING id, tenant_id, user_id, job_title, status;`,
      [tenantRow.id, userRow.id, input.adminJobTitle?.trim() || "Business Administrator"],
    );
    const memberRow = memberRes.rows[0];

    // 4. Ensure System Role business_admin exists & link membership
    const roleRes = await client.query(
      `SELECT id FROM roles WHERE key = 'business_admin' AND is_system_role = true LIMIT 1;`,
    );
    let roleId = roleRes.rows[0]?.id;
    if (!roleId) {
      const newRoleRes = await client.query(
        `INSERT INTO roles (key, name, description, is_system_role) 
         VALUES ('business_admin', 'Business Admin', 'Full workspace admin', true) 
         RETURNING id;`,
      );
      roleId = newRoleRes.rows[0].id;
    }

    await client.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id) 
       VALUES ($1, $2, $3) 
       ON CONFLICT DO NOTHING;`,
      [tenantRow.id, memberRow.id, roleId],
    );

    // 5. Create verification token
    const verificationToken = `vtok_${tenantRow.id}_${userRow.id}`;

    await client.query("COMMIT;");

    return {
      tenant: {
        id: tenantRow.id,
        slug: tenantRow.slug,
        name: tenantRow.name,
        status: tenantRow.status,
        onboardingMode: tenantRow.onboarding_mode,
      },
      adminUser: {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        emailVerifiedAt: userRow.email_verified_at
          ? new Date(userRow.email_verified_at).toISOString()
          : null,
        isPlatformAdmin: userRow.is_platform_admin,
        status: userRow.status,
      },
      adminMembership: {
        id: memberRow.id,
        tenantId: memberRow.tenant_id,
        userId: memberRow.user_id,
        jobTitle: memberRow.job_title,
        status: memberRow.status,
      },
      verificationToken,
    };
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verifies email and activates the tenant in PostgreSQL.
 */
export async function verifyCompanyAdminEmailInDb(
  poolOrDb: {
    pool?: QueryableTransactionPool;
    db?: AureliaAwsDb;
    env?: Record<string, string | undefined>;
  },
  verificationToken: string,
): Promise<{ tenant: TenantRecord; user: UserRecord; membership: MembershipRecord }> {
  const parts = verificationToken.split("_");
  if (parts.length < 3 || parts[0] !== "vtok") {
    throw new Error("Invalid or expired email verification token.");
  }
  const tenantId = parts[1];
  const userId = parts[2];

  const pool = poolOrDb.pool ?? getAwsPostgresPool(poolOrDb.env);
  const client = await pool.connect();
  try {
    await client.query("BEGIN;");

    const tenantRes = await client.query(
      `UPDATE tenants SET status = 'active', updated_at = NOW() 
       WHERE id = $1 
       RETURNING id, slug, name, status, onboarding_mode;`,
      [tenantId],
    );
    if (tenantRes.rowCount === 0) {
      throw new Error(`Tenant workspace ${tenantId} not found.`);
    }
    const tenantRow = tenantRes.rows[0];

    const userRes = await client.query(
      `UPDATE users SET email_verified_at = NOW(), updated_at = NOW() 
       WHERE id = $1 
       RETURNING id, email, full_name, email_verified_at, is_platform_admin, status;`,
      [userId],
    );
    const userRow = userRes.rows[0];

    const memberRes = await client.query(
      `SELECT id, tenant_id, user_id, job_title, status FROM memberships 
       WHERE tenant_id = $1 AND user_id = $2 LIMIT 1;`,
      [tenantId, userId],
    );
    const memberRow = memberRes.rows[0];

    await client.query("COMMIT;");

    return {
      tenant: {
        id: tenantRow.id,
        slug: tenantRow.slug,
        name: tenantRow.name,
        status: tenantRow.status,
        onboardingMode: tenantRow.onboarding_mode,
      },
      user: {
        id: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        emailVerifiedAt: userRow.email_verified_at
          ? new Date(userRow.email_verified_at).toISOString()
          : null,
        isPlatformAdmin: userRow.is_platform_admin,
        status: userRow.status,
      },
      membership: memberRow
        ? {
            id: memberRow.id,
            tenantId: memberRow.tenant_id,
            userId: memberRow.user_id,
            jobTitle: memberRow.job_title,
            status: memberRow.status,
          }
        : {
            id: `m_${tenantId}_${userId}`,
            tenantId,
            userId,
            jobTitle: "Business Administrator",
            status: "active",
          },
    };
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  } finally {
    client.release();
  }
}
