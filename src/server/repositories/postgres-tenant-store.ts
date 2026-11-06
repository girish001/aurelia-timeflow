import crypto from "node:crypto";
import { addDays, format, parseISO } from "date-fns";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  EmailDeliveryError,
  resolveEmailDeliveryProvider,
  type EmailDeliveryProvider,
} from "../auth/email-provider";
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
  type QueryableTransactionClient,
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
        ctx.roleKeys.has("business_admin") ||
        ctx.permissions.has("project:read:all") ||
        ctx.permissions.has("project:write:all");

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
        canApproveTimesheets: pm.canApproveTimesheets,
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
        canApproveTimesheets: pm.canApproveTimesheets,
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
        totalHours: 0,
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
        canApproveTimesheets: pm.canApproveTimesheets,
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
        totalHours: 0,
        status: "rejected",
      };
    },
    scopeOptions,
  );
}

export interface TimesheetEntryInput {
  id?: string;
  projectId: string;
  taskName: string;
  hoursByDay: number[];
  billable?: boolean;
  notes?: string;
}

export interface DetailedTimesheetEntry {
  id: string;
  timesheetId: string;
  projectId: string;
  projectName: string;
  taskName: string;
  hoursByDay: number[];
  billable: boolean;
  notes: string;
}

export interface DetailedTimesheet {
  id: string;
  tenantId: string;
  membershipId: string;
  weekStart: string;
  status: "draft" | "submitted" | "approved" | "rejected";
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedByMembershipId: string | null;
  reviewComment: string | null;
  totalHours: number;
  entries: DetailedTimesheetEntry[];
}

export interface ApprovalItem {
  id: string;
  timesheetId: string;
  membershipId: string;
  memberName: string;
  memberEmail: string;
  jobTitle: string;
  weekStart: string;
  totalHours: number;
  submittedAt: string | null;
  entries: Array<{
    id: string;
    projectId: string;
    projectName: string;
    taskName: string;
    hoursByDay: number[];
    billable: boolean;
    notes: string;
  }>;
}

export interface ApprovalHistoryItem {
  id: string;
  targetType: "timesheet" | "leave_request";
  targetId: string;
  requesterMembershipId: string;
  requesterName: string;
  approverMembershipId: string | null;
  approverName: string | null;
  status: "approved" | "rejected";
  comment: string | null;
  decidedAt: string | null;
}

/**
 * Retrieves a detailed timesheet with its line entries for a given week.
 */
export async function getTimesheetForWeekFromDb(
  ctx: ResolvedTenantContext,
  targetMembershipId: string,
  weekStart: string,
  scopeOptions?: ScopeOptions,
): Promise<DetailedTimesheet | null> {
  const isSelf = ctx.membership.id === targetMembershipId;
  const isManagerOrAdmin =
    ctx.roleKeys.has("business_admin") ||
    ctx.permissions.has("tenant:settings:manage") ||
    (ctx.permissions.has("timesheet:read:team") &&
      ctx.directReportMembershipIds.has(targetMembershipId));

  if (!isSelf && !isManagerOrAdmin) {
    throw new AuthorizationError("You do not have permission to view this timesheet.");
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
            eq(schema.timesheets.membershipId, targetMembershipId),
            eq(schema.timesheets.weekStart, weekStart),
          ),
        )
        .limit(1);

      const ts = tsRows[0];
      if (!ts) return null;

      const entryRows = await db
        .select({
          entry: schema.timesheetEntries,
          projectName: schema.projects.name,
        })
        .from(schema.timesheetEntries)
        .leftJoin(
          schema.projects,
          and(
            eq(schema.projects.tenantId, verifiedTenantId),
            eq(schema.projects.id, schema.timesheetEntries.projectId),
          ),
        )
        .where(
          and(
            eq(schema.timesheetEntries.tenantId, verifiedTenantId),
            eq(schema.timesheetEntries.timesheetId, ts.id),
          ),
        );

      let totalHours = 0;
      const entries: DetailedTimesheetEntry[] = entryRows.map(({ entry, projectName }) => {
        const hours = Array.isArray(entry.hoursByDayJson)
          ? entry.hoursByDayJson
          : [0, 0, 0, 0, 0, 0, 0];
        const entrySum = hours.reduce((acc, h) => acc + (typeof h === "number" ? h : 0), 0);
        totalHours += entrySum;
        return {
          id: entry.id,
          timesheetId: entry.timesheetId,
          projectId: entry.projectId,
          projectName: projectName ?? "General",
          taskName: entry.taskName,
          hoursByDay: hours,
          billable: entry.billable,
          notes: entry.notes,
        };
      });

      return {
        id: ts.id,
        tenantId: ts.tenantId,
        membershipId: ts.membershipId,
        weekStart: String(ts.weekStart),
        status: ts.status,
        submittedAt: ts.submittedAt ? ts.submittedAt.toISOString() : null,
        reviewedAt: ts.reviewedAt ? ts.reviewedAt.toISOString() : null,
        reviewedByMembershipId: ts.reviewedByMembershipId,
        reviewComment: ts.reviewComment,
        totalHours: Math.round(totalHours * 100) / 100,
        entries,
      };
    },
    scopeOptions,
  );
}

/**
 * Creates or updates draft timesheet entries for a specified week.
 */
export async function upsertTimesheetInDb(
  ctx: ResolvedTenantContext,
  targetMembershipId: string,
  input: {
    weekStart: string;
    entries: TimesheetEntryInput[];
  },
  scopeOptions?: ScopeOptions,
): Promise<DetailedTimesheet> {
  const isSelf = ctx.membership.id === targetMembershipId;
  const isAdmin =
    ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:settings:manage");

  if (!isSelf && !isAdmin) {
    throw new AuthorizationError("You can only edit your own timesheets.");
  }

  for (const entry of input.entries) {
    if (!entry.projectId) {
      throw new Error("Project is required for all timesheet entries.");
    }
    if (!entry.taskName?.trim()) {
      throw new Error("Task name is required for all timesheet entries.");
    }
    if (!Array.isArray(entry.hoursByDay) || entry.hoursByDay.length !== 7) {
      throw new Error("Each timesheet entry must contain 7 daily hour values.");
    }
    for (const h of entry.hoursByDay) {
      if (typeof h !== "number" || isNaN(h) || h < 0 || h > 24) {
        throw new Error("Daily hours must be between 0 and 24.");
      }
    }
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const existingRows = await db
        .select()
        .from(schema.timesheets)
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.membershipId, targetMembershipId),
            eq(schema.timesheets.weekStart, input.weekStart),
          ),
        )
        .limit(1);

      const existing = existingRows[0];
      if (existing && existing.status === "approved") {
        throw new AuthorizationError("Cannot modify an approved timesheet.");
      }

      const now = new Date();
      let timesheetId = existing?.id;

      if (existing) {
        const newStatus = existing.status === "rejected" ? "draft" : existing.status;
        await db
          .update(schema.timesheets)
          .set({
            status: newStatus,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.timesheets.tenantId, verifiedTenantId),
              eq(schema.timesheets.id, existing.id),
            ),
          );

        await db
          .delete(schema.timesheetEntries)
          .where(
            and(
              eq(schema.timesheetEntries.tenantId, verifiedTenantId),
              eq(schema.timesheetEntries.timesheetId, existing.id),
            ),
          );
      } else {
        const [inserted] = await db
          .insert(schema.timesheets)
          .values({
            tenantId: verifiedTenantId,
            membershipId: targetMembershipId,
            weekStart: input.weekStart,
            status: "draft",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!inserted) {
          throw new Error("Failed to insert draft timesheet.");
        }
        timesheetId = inserted.id;
      }

      if (input.entries.length > 0 && timesheetId) {
        await db.insert(schema.timesheetEntries).values(
          input.entries.map((e) => ({
            tenantId: verifiedTenantId,
            timesheetId,
            projectId: e.projectId,
            taskName: e.taskName.trim(),
            hoursByDayJson: e.hoursByDay,
            billable: e.billable ?? true,
            notes: e.notes?.trim() ?? "",
          })),
        );
      }

      const updated = await getTimesheetForWeekFromDb(
        ctx,
        targetMembershipId,
        input.weekStart,
        scopeOptions,
      );
      if (!updated) {
        throw new Error("Failed to retrieve updated timesheet.");
      }
      return updated;
    },
    scopeOptions,
  );
}

/**
 * Submits a draft or rejected timesheet for manager review.
 */
export async function submitTimesheetInDb(
  ctx: ResolvedTenantContext,
  timesheetId: string,
  scopeOptions?: ScopeOptions,
): Promise<DetailedTimesheet> {
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

      const isSelf = ctx.membership.id === ts.membershipId;
      const isAdmin =
        ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:settings:manage");
      if (!isSelf && !isAdmin) {
        throw new AuthorizationError("You can only submit your own timesheet.");
      }

      if (ts.status === "approved") {
        throw new Error("Timesheet is already approved.");
      }
      if (ts.status === "submitted") {
        throw new Error("Timesheet is already submitted.");
      }

      const now = new Date();
      await db
        .update(schema.timesheets)
        .set({
          status: "submitted",
          submittedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.id, timesheetId),
          ),
        );

      await recordAuditLogToDb(db, {
        tenantId: verifiedTenantId,
        actorUserId: ctx.user.id,
        actorMembershipId: ctx.membership.id,
        impersonatedByPlatformUserId: ctx.impersonatedByPlatformUserId,
        category: "timesheet",
        action: "timesheet.submitted",
        targetType: "timesheet",
        targetId: timesheetId,
        metadata: { weekStart: String(ts.weekStart) },
      });

      const updated = await getTimesheetForWeekFromDb(
        ctx,
        ts.membershipId,
        String(ts.weekStart),
        scopeOptions,
      );
      if (!updated) {
        throw new Error("Failed to retrieve submitted timesheet.");
      }
      return updated;
    },
    scopeOptions,
  );
}

/**
 * Lists pending timesheet approvals and recent approval history.
 */
export async function listApprovalsFromDb(
  ctx: ResolvedTenantContext,
  scopeOptions?: ScopeOptions,
): Promise<{
  pending: ApprovalItem[];
  history: ApprovalHistoryItem[];
}> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const isBusinessAdmin =
        ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:settings:manage");

      const submittedSheets = await db
        .select({
          timesheet: schema.timesheets,
          membership: schema.memberships,
          user: schema.users,
        })
        .from(schema.timesheets)
        .innerJoin(
          schema.memberships,
          and(
            eq(schema.memberships.tenantId, verifiedTenantId),
            eq(schema.memberships.id, schema.timesheets.membershipId),
          ),
        )
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(
          and(
            eq(schema.timesheets.tenantId, verifiedTenantId),
            eq(schema.timesheets.status, "submitted"),
          ),
        )
        .orderBy(desc(schema.timesheets.submittedAt));

      const authorizedSheets = submittedSheets.filter((row) => {
        if (isBusinessAdmin) return true;
        return ctx.directReportMembershipIds.has(row.timesheet.membershipId);
      });

      const pending: ApprovalItem[] = [];
      for (const row of authorizedSheets) {
        const entries = await db
          .select({
            entry: schema.timesheetEntries,
            projectName: schema.projects.name,
          })
          .from(schema.timesheetEntries)
          .leftJoin(
            schema.projects,
            and(
              eq(schema.projects.tenantId, verifiedTenantId),
              eq(schema.projects.id, schema.timesheetEntries.projectId),
            ),
          )
          .where(
            and(
              eq(schema.timesheetEntries.tenantId, verifiedTenantId),
              eq(schema.timesheetEntries.timesheetId, row.timesheet.id),
            ),
          );

        let totalHours = 0;
        const mappedEntries = entries.map(({ entry, projectName }) => {
          const hours = Array.isArray(entry.hoursByDayJson)
            ? entry.hoursByDayJson
            : [0, 0, 0, 0, 0, 0, 0];
          const entrySum = hours.reduce((acc, h) => acc + (typeof h === "number" ? h : 0), 0);
          totalHours += entrySum;
          return {
            id: entry.id,
            projectId: entry.projectId,
            projectName: projectName ?? "General",
            taskName: entry.taskName,
            hoursByDay: hours,
            billable: entry.billable,
            notes: entry.notes,
          };
        });

        pending.push({
          id: row.timesheet.id,
          timesheetId: row.timesheet.id,
          membershipId: row.membership.id,
          memberName: row.user.fullName,
          memberEmail: row.user.email,
          jobTitle: row.membership.jobTitle,
          weekStart: String(row.timesheet.weekStart),
          totalHours: Math.round(totalHours * 100) / 100,
          submittedAt: row.timesheet.submittedAt ? row.timesheet.submittedAt.toISOString() : null,
          entries: mappedEntries,
        });
      }

      const approvalRows = await db
        .select({
          approval: schema.approvals,
          requesterUser: schema.users,
        })
        .from(schema.approvals)
        .innerJoin(
          schema.memberships,
          and(
            eq(schema.memberships.tenantId, verifiedTenantId),
            eq(schema.memberships.id, schema.approvals.requesterMembershipId),
          ),
        )
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.approvals.tenantId, verifiedTenantId))
        .orderBy(desc(schema.approvals.createdAt))
        .limit(50);

      const history: ApprovalHistoryItem[] = approvalRows.map(({ approval, requesterUser }) => ({
        id: approval.id,
        targetType: approval.targetType,
        targetId: approval.targetId,
        requesterMembershipId: approval.requesterMembershipId,
        requesterName: requesterUser.fullName,
        approverMembershipId: approval.approverMembershipId,
        approverName: null,
        status: approval.status as "approved" | "rejected",
        comment: approval.comment,
        decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
      }));

      return { pending, history };
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
        actorUserId: r.actorUserId ?? "",
        actorMembershipId: r.actorMembershipId ?? "",
        impersonatedByPlatformUserId: r.impersonatedByPlatformUserId ?? undefined,
        category: r.category,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId ?? "",
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

const clientTransactionLocks = new WeakMap<object, Promise<void>>();

async function withClientTransactionLock<T>(
  client: QueryableTransactionClient,
  operation: () => Promise<T>,
): Promise<T> {
  const prev = clientTransactionLocks.get(client) ?? Promise.resolve();
  let releaseLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  clientTransactionLocks.set(
    client,
    prev.then(
      () => current,
      () => current,
    ),
  );
  await prev;
  try {
    return await operation();
  } finally {
    releaseLock();
  }
}

/**
 * Self-service company registration in PostgreSQL.
 * Inserts tenant, administrator user, membership, business_admin role, and SHA-256 hashed
 * single-use email verification token inside a database transaction, then dispatches the
 * verification email via the configured EmailDeliveryProvider.
 *
 * Security Invariants:
 * - Never reports `verificationEmailDispatched: true` unless the email provider confirms
 *   acceptance with a non-empty `messageId`.
 * - Fails safely when email delivery fails.
 */
export async function registerCompanyInDb(
  poolOrDb: {
    pool?: QueryableTransactionPool | undefined;
    db?: AureliaAwsDb | undefined;
    env?: Record<string, string | undefined> | undefined;
    emailProvider?: EmailDeliveryProvider | undefined;
  },
  input: {
    companyName: string;
    slug: string;
    adminEmail: string;
    adminFullName: string;
    adminJobTitle?: string | undefined;
    now?: number | undefined;
    ttlMs?: number | undefined;
  },
): Promise<{
  tenant: TenantRecord;
  adminUser: UserRecord;
  adminMembership: MembershipRecord;
  verificationToken: string;
  verificationEmailDispatched: boolean;
  emailMessageId: string;
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

  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000;
  const expiresAt = now + ttlMs;

  const emailProvider = resolveEmailDeliveryProvider(poolOrDb.env, poolOrDb.emailProvider);
  const pool = poolOrDb.pool ?? getAwsPostgresPool(poolOrDb.env);
  const client = await pool.connect();

  try {
    return await withClientTransactionLock(client, async () => {
      await client.query("BEGIN");
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS email_verification_tokens (
            token_hash VARCHAR(64) PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ
          );
        `);

        // 1. Insert Tenant in 'onboarding' status (activated ONLY after email verification)
        const tenantRes = await client.query(
          `INSERT INTO tenants (slug, name, status, onboarding_mode) 
           VALUES ($1, $2, 'onboarding', 'self_service') 
           RETURNING id, slug, name, status, onboarding_mode;`,
          [slug, input.companyName.trim()],
        );
        const tenantRow = tenantRes.rows[0] as {
          id: string;
          slug: string;
          name: string;
          status: TenantRecord["status"];
          onboarding_mode: TenantRecord["onboardingMode"];
        };

        // Scope transaction-local RLS context to the newly created tenant
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantRow.id]);

        // 2. Insert or find User
        const existingUserRes = await client.query(
          `SELECT id, email, full_name, email_verified_at, is_platform_admin, status FROM users WHERE email = $1;`,
          [email],
        );
        let userRow = existingUserRes.rows[0] as
          | {
              id: string;
              email: string;
              full_name: string;
              email_verified_at: string | Date | null;
              is_platform_admin: boolean;
              status: UserRecord["status"];
            }
          | undefined;
        if (!userRow) {
          const newUserRes = await client.query(
            `INSERT INTO users (email, full_name, is_platform_admin, status) 
             VALUES ($1, $2, false, 'active') 
             RETURNING id, email, full_name, email_verified_at, is_platform_admin, status;`,
            [email, input.adminFullName.trim()],
          );
          userRow = newUserRes.rows[0] as {
            id: string;
            email: string;
            full_name: string;
            email_verified_at: string | Date | null;
            is_platform_admin: boolean;
            status: UserRecord["status"];
          };
        }

        // 3. Insert Membership
        const memberRes = await client.query(
          `INSERT INTO memberships (tenant_id, user_id, job_title, status) 
           VALUES ($1, $2, $3, 'active') 
           RETURNING id, tenant_id, user_id, job_title, status;`,
          [tenantRow.id, userRow.id, input.adminJobTitle?.trim() || "Business Administrator"],
        );
        const memberRow = memberRes.rows[0] as {
          id: string;
          tenant_id: string;
          user_id: string;
          job_title: string;
          status: MembershipRecord["status"];
        };

        // 4. Ensure System Role business_admin exists & link membership
        const roleRes = await client.query(
          `SELECT id FROM roles WHERE key = 'business_admin' AND is_system_role = true LIMIT 1;`,
        );
        let roleId = (roleRes.rows[0] as { id?: string } | undefined)?.id;
        if (!roleId) {
          const newRoleRes = await client.query(
            `INSERT INTO roles (key, name, description, is_system_role) 
             VALUES ('business_admin', 'Business Admin', 'Full workspace admin', true) 
             RETURNING id;`,
          );
          roleId = (newRoleRes.rows[0] as { id: string }).id;
        }

        await client.query(
          `INSERT INTO membership_roles (tenant_id, membership_id, role_id) 
           VALUES ($1, $2, $3) 
           ON CONFLICT DO NOTHING;`,
          [tenantRow.id, memberRow.id, roleId],
        );

        // 5. Generate cryptographically random 256-bit verification token; store ONLY SHA-256 hash
        const verificationToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(verificationToken).digest("hex");
        const createdAtIso = new Date(now).toISOString();
        const expiresAtIso = new Date(expiresAt).toISOString();

        await client.query(
          `INSERT INTO email_verification_tokens (
             token_hash, tenant_id, user_id, email, created_at, expires_at, used_at
           ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, NULL);`,
          [tokenHash, tenantRow.id, userRow.id, email, createdAtIso, expiresAtIso],
        );

        // 6. Dispatch verification email and confirm provider delivery acceptance BEFORE committing
        const delivery = await emailProvider.sendEmailVerificationEmail({
          to: email,
          companyName: tenantRow.name,
          tenantId: tenantRow.id,
          verificationToken,
          expiresAt,
        });

        if (!delivery || !delivery.accepted || !delivery.messageId?.trim()) {
          throw new EmailDeliveryError(
            "Email provider did not confirm verification email acceptance.",
            502,
          );
        }

        await client.query("SELECT set_config('app.current_tenant_id', '', true)");
        await client.query("COMMIT");

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
          verificationEmailDispatched: true,
          emailMessageId: delivery.messageId,
        };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Ignore rollback error
        }
        throw err;
      }
    });
  } finally {
    client.release();
  }
}

/**
 * Verifies email verification token hash (enforcing atomic single-use consumption,
 * expiration, and strict tenant/user/membership binding) and activates the tenant in PostgreSQL.
 */
export async function verifyCompanyAdminEmailInDb(
  poolOrDb: {
    pool?: QueryableTransactionPool | undefined;
    db?: AureliaAwsDb | undefined;
    env?: Record<string, string | undefined> | undefined;
  },
  verificationToken: string,
  options?: {
    now?: number | undefined;
    expectedTenantId?: string | undefined;
    expectedEmail?: string | undefined;
  },
): Promise<{ tenant: TenantRecord; user: UserRecord; membership: MembershipRecord }> {
  if (
    !verificationToken ||
    typeof verificationToken !== "string" ||
    verificationToken.startsWith("vtok_")
  ) {
    throw new Error("Invalid, expired, or already used email verification token.");
  }

  const now = options?.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const tokenHash = crypto.createHash("sha256").update(verificationToken.trim()).digest("hex");

  const pool = poolOrDb.pool ?? getAwsPostgresPool(poolOrDb.env);
  const client = await pool.connect();

  try {
    return await withClientTransactionLock(client, async () => {
      await client.query("BEGIN");
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS email_verification_tokens (
            token_hash VARCHAR(64) PRIMARY KEY,
            tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ
          );
        `);

        // 1. Atomically consume single-use token ONLY if unused and unexpired
        const consumeRes = await client.query(
          `UPDATE email_verification_tokens
           SET used_at = $2::timestamptz
           WHERE token_hash = $1
             AND used_at IS NULL
             AND expires_at > $2::timestamptz
           RETURNING token_hash, tenant_id, user_id, email, expires_at;`,
          [tokenHash, nowIso],
        );

        const tokenRow = consumeRes.rows[0] as
          | {
              token_hash: string;
              tenant_id: string;
              user_id: string;
              email: string;
              expires_at: string | Date;
            }
          | undefined;

        if (!tokenRow) {
          throw new Error("Invalid, expired, or already used email verification token.");
        }

        const tenantId = tokenRow.tenant_id;
        const userId = tokenRow.user_id;
        const tokenEmail = tokenRow.email.trim().toLowerCase();

        // 2. Enforce caller-provided tenant/email binding if supplied
        if (options?.expectedTenantId && options.expectedTenantId !== tenantId) {
          throw new TenantIsolationError(
            `Verification token does not belong to requested tenant "${options.expectedTenantId}".`,
          );
        }
        if (options?.expectedEmail && options.expectedEmail.trim().toLowerCase() !== tokenEmail) {
          throw new AuthorizationError(
            "Verification token does not belong to the specified email address.",
          );
        }

        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

        // 3. Verify an explicit active membership binds userId to tenantId
        const memberRes = await client.query(
          `SELECT id, tenant_id, user_id, job_title, status FROM memberships 
           WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1;`,
          [tenantId, userId],
        );
        const memberRow = memberRes.rows[0] as
          | {
              id: string;
              tenant_id: string;
              user_id: string;
              job_title: string;
              status: MembershipRecord["status"];
            }
          | undefined;

        if (!memberRow) {
          throw new TenantIsolationError(
            "Email verification rejected: token user has no active membership in target tenant.",
          );
        }

        // 4. Activate ONLY a tenant currently in 'onboarding' status matching tenantId
        const tenantRes = await client.query(
          `UPDATE tenants SET status = 'active', updated_at = $2::timestamptz 
           WHERE id = $1 AND status = 'onboarding'
           RETURNING id, slug, name, status, onboarding_mode;`,
          [tenantId, nowIso],
        );
        if (tenantRes.rowCount === 0 || !tenantRes.rows[0]) {
          throw new Error(
            `Tenant workspace ${tenantId} is not in onboarding state or was already activated.`,
          );
        }
        const tenantRow = tenantRes.rows[0] as {
          id: string;
          slug: string;
          name: string;
          status: TenantRecord["status"];
          onboarding_mode: TenantRecord["onboardingMode"];
        };

        // 5. Verify and update ONLY the user matching both userId and tokenEmail
        const userRes = await client.query(
          `UPDATE users SET email_verified_at = $2::timestamptz, updated_at = $2::timestamptz 
           WHERE id = $1 AND LOWER(email) = LOWER($3)
           RETURNING id, email, full_name, email_verified_at, is_platform_admin, status;`,
          [userId, nowIso, tokenEmail],
        );
        if (userRes.rowCount === 0 || !userRes.rows[0]) {
          throw new AuthorizationError(
            "Email verification rejected: target user email does not match verification token.",
          );
        }
        const userRow = userRes.rows[0] as {
          id: string;
          email: string;
          full_name: string;
          email_verified_at: string | Date | null;
          is_platform_admin: boolean;
          status: UserRecord["status"];
        };

        await client.query("SELECT set_config('app.current_tenant_id', '', true)");
        await client.query("COMMIT");

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
          membership: {
            id: memberRow.id,
            tenantId: memberRow.tenant_id,
            userId: memberRow.user_id,
            jobTitle: memberRow.job_title,
            status: memberRow.status,
          },
        };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Ignore rollback error
        }
        throw err;
      }
    });
  } finally {
    client.release();
  }
}

// ============================================================================
// 10. Client Management Repository Functions
// ============================================================================

export interface ClientRecord {
  id: string;
  tenantId: string;
  name: string;
  contactName: string;
  contactEmail: string;
  country: string;
  billingTerms: string;
  status: string;
  createdAt: string;
}

export interface CreateClientInput {
  name: string;
  contactName: string;
  contactEmail: string;
  country: string;
  billingTerms?: string | undefined;
  status?: string | undefined;
}

export async function listClientsFromDb(
  ctx: ResolvedTenantContext,
  options?: (PaginationOptions & { search?: string; status?: string }) | undefined,
  scopeOptions?: ScopeOptions,
): Promise<{ clients: ClientRecord[]; total: number }> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      let conditions = eq(schema.clients.tenantId, verifiedTenantId);

      if (options?.status && options.status !== "all") {
        conditions = and(conditions, eq(schema.clients.status, options.status))!;
      }

      if (options?.search?.trim()) {
        const q = `%${options.search.trim()}%`;
        conditions = and(
          conditions,
          sql`(${schema.clients.name} ILIKE ${q} OR ${schema.clients.contactName} ILIKE ${q} OR ${schema.clients.contactEmail} ILIKE ${q})`,
        )!;
      }

      const totalResult = await db
        .select({ count: count() })
        .from(schema.clients)
        .where(conditions);
      const total = totalResult[0]?.count ?? 0;

      const page = Math.max(1, options?.page ?? 1);
      const limit = Math.max(1, Math.min(100, options?.limit ?? 50));
      const offset = (page - 1) * limit;

      const rows = await db
        .select()
        .from(schema.clients)
        .where(conditions)
        .orderBy(asc(schema.clients.name))
        .limit(limit)
        .offset(offset);

      return {
        clients: rows.map((r) => ({
          id: r.id,
          tenantId: r.tenantId,
          name: r.name,
          contactName: r.contactName,
          contactEmail: r.contactEmail,
          country: r.country,
          billingTerms: r.billingTerms,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        total,
      };
    },
    scopeOptions,
  );
}

export async function createClientInDb(
  ctx: ResolvedTenantContext,
  input: CreateClientInput,
  scopeOptions?: ScopeOptions,
): Promise<ClientRecord> {
  if (!ctx.permissions.has("client:write:all")) {
    throw new AuthorizationError("Only administrators can create client accounts.");
  }
  if (!input.name?.trim()) {
    throw new Error("Client name is required.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const rows = await db
        .insert(schema.clients)
        .values({
          tenantId: verifiedTenantId,
          name: input.name.trim(),
          contactName: input.contactName?.trim() || "Contact Representative",
          contactEmail: input.contactEmail?.trim().toLowerCase() || "",
          country: input.country?.trim() || "India",
          billingTerms: input.billingTerms?.trim() || "Net 30",
          status: input.status === "inactive" ? "inactive" : "active",
        })
        .returning();

      const created = rows[0]!;
      await recordAuditLogToDb(
        ctx,
        "client",
        "client.created",
        "client",
        created.id,
        { name: created.name, contactName: created.contactName },
        scopeOptions,
      );

      return {
        id: created.id,
        tenantId: created.tenantId,
        name: created.name,
        contactName: created.contactName,
        contactEmail: created.contactEmail,
        country: created.country,
        billingTerms: created.billingTerms,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
      };
    },
    scopeOptions,
  );
}

export async function updateClientInDb(
  ctx: ResolvedTenantContext,
  clientId: string,
  input: Partial<CreateClientInput>,
  scopeOptions?: ScopeOptions,
): Promise<ClientRecord> {
  if (!ctx.permissions.has("client:write:all")) {
    throw new AuthorizationError("Only administrators can update client accounts.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch["name"] = input.name.trim();
      if (input.contactName !== undefined) patch["contactName"] = input.contactName.trim();
      if (input.contactEmail !== undefined)
        patch["contactEmail"] = input.contactEmail.trim().toLowerCase();
      if (input.country !== undefined) patch["country"] = input.country.trim();
      if (input.billingTerms !== undefined) patch["billingTerms"] = input.billingTerms.trim();
      if (input.status !== undefined)
        patch["status"] = input.status === "inactive" ? "inactive" : "active";

      const rows = await db
        .update(schema.clients)
        .set(patch)
        .where(and(eq(schema.clients.tenantId, verifiedTenantId), eq(schema.clients.id, clientId)))
        .returning();

      const updated = rows[0];
      if (!updated) {
        throw new Error(`Client ${clientId} not found.`);
      }

      await recordAuditLogToDb(
        ctx,
        "client",
        "client.updated",
        "client",
        clientId,
        patch,
        scopeOptions,
      );

      return {
        id: updated.id,
        tenantId: updated.tenantId,
        name: updated.name,
        contactName: updated.contactName,
        contactEmail: updated.contactEmail,
        country: updated.country,
        billingTerms: updated.billingTerms,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
      };
    },
    scopeOptions,
  );
}

// ============================================================================
// 11. Project Creation Repository Function
// ============================================================================

export interface CreateProjectInput {
  clientId: string;
  name: string;
  projectManagerMembershipId: string;
  budgetHours: number;
  billableRate: number;
  tasks?: string[] | undefined;
  status?: "active" | "on-hold" | "completed" | undefined;
}

export async function createProjectInDb(
  ctx: ResolvedTenantContext,
  input: CreateProjectInput,
  scopeOptions?: ScopeOptions,
): Promise<ProjectRecord> {
  if (!ctx.permissions.has("project:write:all")) {
    throw new AuthorizationError("Only administrators can create new projects.");
  }
  if (!input.name?.trim()) {
    throw new Error("Project name is required.");
  }
  if (!input.clientId) {
    throw new Error("clientId is required.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      // Ensure client exists in the same tenant
      const clientRows = await db
        .select()
        .from(schema.clients)
        .where(
          and(eq(schema.clients.tenantId, verifiedTenantId), eq(schema.clients.id, input.clientId)),
        )
        .limit(1);
      if (!clientRows[0]) {
        throw new Error(`Client ${input.clientId} not found in this tenant.`);
      }

      const rows = await db
        .insert(schema.projects)
        .values({
          tenantId: verifiedTenantId,
          clientId: input.clientId,
          name: input.name.trim(),
          projectManagerMembershipId: input.projectManagerMembershipId || ctx.membership.id,
          status: input.status ?? "active",
          budgetHours: String(input.budgetHours ?? 100),
          billableRate: String(input.billableRate ?? 75),
          tasksJson:
            input.tasks && input.tasks.length > 0
              ? input.tasks
              : ["Architecture & Engineering", "Testing & Delivery", "Code Review"],
        })
        .returning();

      const created = rows[0]!;

      // Automatically add Project Manager membership
      await db
        .insert(schema.projectMemberships)
        .values({
          tenantId: verifiedTenantId,
          projectId: created.id,
          membershipId: created.projectManagerMembershipId,
          projectRole: "project_manager",
          canApproveTimesheets: true,
          canManageAllocations: true,
        })
        .onConflictDoNothing();

      await recordAuditLogToDb(
        ctx,
        "project",
        "project.created",
        "project",
        created.id,
        {
          name: created.name,
          budgetHours: created.budgetHours,
          billableRate: created.billableRate,
        },
        scopeOptions,
      );

      return {
        id: created.id,
        tenantId: created.tenantId,
        clientId: created.clientId,
        name: created.name,
        projectManagerMembershipId: created.projectManagerMembershipId,
        budgetHours: Number(created.budgetHours),
        billableRate: Number(created.billableRate),
        status: created.status,
      };
    },
    scopeOptions,
  );
}

// ============================================================================
// 12. Tenant Settings Repository Functions
// ============================================================================

export interface TenantSettingsRecord {
  id: string;
  name: string;
  slug: string;
  country: string;
  timezone: string;
  currency: string;
  timeFormat: string;
  weekStart: string;
  dailyTargetHours: string;
  lockApprovedSheets: boolean;
  requireRejectReason: boolean;
}

export async function getTenantSettingsFromDb(
  ctx: ResolvedTenantContext,
  scopeOptions?: ScopeOptions,
): Promise<TenantSettingsRecord> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const rows = await db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, verifiedTenantId))
        .limit(1);

      const t = rows[0];
      if (!t) {
        throw new Error(`Tenant ${verifiedTenantId} not found.`);
      }

      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        country: t.country,
        timezone: t.timezone,
        currency: t.currency,
        timeFormat: t.timeFormat,
        weekStart: t.weekStart,
        dailyTargetHours: t.dailyTargetHours,
        lockApprovedSheets: t.lockApprovedSheets,
        requireRejectReason: t.requireRejectReason,
      };
    },
    scopeOptions,
  );
}

export async function updateTenantSettingsInDb(
  ctx: ResolvedTenantContext,
  input: Partial<Omit<TenantSettingsRecord, "id" | "slug">>,
  scopeOptions?: ScopeOptions,
): Promise<TenantSettingsRecord> {
  if (!ctx.permissions.has("tenant:settings:manage")) {
    throw new AuthorizationError("Only administrators can update company settings.");
  }

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch["name"] = input.name.trim();
      if (input.country !== undefined) patch["country"] = input.country.trim();
      if (input.timezone !== undefined) patch["timezone"] = input.timezone.trim();
      if (input.currency !== undefined) patch["currency"] = input.currency.trim();
      if (input.timeFormat !== undefined) patch["timeFormat"] = input.timeFormat.trim();
      if (input.weekStart !== undefined) patch["weekStart"] = input.weekStart.trim();
      if (input.dailyTargetHours !== undefined)
        patch["dailyTargetHours"] = String(input.dailyTargetHours);
      if (input.lockApprovedSheets !== undefined)
        patch["lockApprovedSheets"] = Boolean(input.lockApprovedSheets);
      if (input.requireRejectReason !== undefined)
        patch["requireRejectReason"] = Boolean(input.requireRejectReason);

      const rows = await db
        .update(schema.tenants)
        .set(patch)
        .where(eq(schema.tenants.id, verifiedTenantId))
        .returning();

      const updated = rows[0];
      if (!updated) {
        throw new Error(`Tenant ${verifiedTenantId} not found.`);
      }

      await recordAuditLogToDb(
        ctx,
        "settings",
        "tenant.settings_updated",
        "tenant",
        verifiedTenantId,
        patch,
        scopeOptions,
      );

      return {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        country: updated.country,
        timezone: updated.timezone,
        currency: updated.currency,
        timeFormat: updated.timeFormat,
        weekStart: updated.weekStart,
        dailyTargetHours: updated.dailyTargetHours,
        lockApprovedSheets: updated.lockApprovedSheets,
        requireRejectReason: updated.requireRejectReason,
      };
    },
    scopeOptions,
  );
}

// ============================================================================
// 13. Real Database-Backed Reports & Analytics
// ============================================================================

export interface TenantReportsResult {
  from: string;
  to: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  utilizationRate: number;
  totalBillableValue: number;
  byProject: Array<{
    projectId: string;
    projectName: string;
    clientName: string;
    billableHours: number;
    nonBillableHours: number;
    totalHours: number;
    billableValue: number;
  }>;
  byClient: Array<{
    clientId: string;
    clientName: string;
    billableHours: number;
    nonBillableHours: number;
    totalHours: number;
    billableValue: number;
  }>;
  byEmployee: Array<{
    membershipId: string;
    employeeName: string;
    department: string;
    billableHours: number;
    nonBillableHours: number;
    totalHours: number;
    utilizationRate: number;
  }>;
  byMonth: Array<{
    monthKey: string;
    monthLabel: string;
    billableHours: number;
    nonBillableHours: number;
    totalHours: number;
    billableValue: number;
  }>;
  entries: Array<{
    date: string;
    membershipId: string;
    employeeName: string;
    clientId: string;
    clientName: string;
    projectId: string;
    projectName: string;
    task: string;
    hours: number;
    billable: boolean;
    rate: number;
    billableValue: number;
    status: string;
    notes: string;
  }>;
}

export async function getTenantReportsFromDb(
  ctx: ResolvedTenantContext,
  options: { from?: string; to?: string; includeDrafts?: boolean },
  scopeOptions?: ScopeOptions,
): Promise<TenantReportsResult> {
  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      // 1. Fetch all projects and clients for lookups
      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.tenantId, verifiedTenantId));

      const clientRows = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.tenantId, verifiedTenantId));

      const memberRows = await db
        .select({
          membershipId: schema.memberships.id,
          userId: schema.memberships.userId,
          departmentId: schema.memberships.departmentId,
          userName: schema.users.fullName,
          userEmail: schema.users.email,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
        .where(eq(schema.memberships.tenantId, verifiedTenantId));

      const clientMap = new Map(clientRows.map((c) => [c.id, c.name]));
      const projectMap = new Map(
        projectRows.map((p) => [
          p.id,
          {
            name: p.name,
            rate: Number(p.billableRate || 0),
            clientId: p.clientId,
            clientName: clientMap.get(p.clientId) ?? "Internal",
          },
        ]),
      );
      const memberMap = new Map(
        memberRows.map((m) => [
          m.membershipId,
          { name: m.userName, email: m.userEmail, departmentId: m.departmentId ?? "" },
        ]),
      );

      // 2. Fetch timesheets
      const statusConditions = options.includeDrafts
        ? sql`${schema.timesheets.status} IN ('draft', 'submitted', 'approved', 'rejected')`
        : sql`${schema.timesheets.status} IN ('submitted', 'approved', 'rejected')`;

      const tsRows = await db
        .select()
        .from(schema.timesheets)
        .where(and(eq(schema.timesheets.tenantId, verifiedTenantId), statusConditions));

      const tsIds = tsRows.map((t) => t.id);

      const entryRows =
        tsIds.length > 0
          ? await db
              .select()
              .from(schema.timesheetEntries)
              .where(
                and(
                  eq(schema.timesheetEntries.tenantId, verifiedTenantId),
                  inArray(schema.timesheetEntries.timesheetId, tsIds),
                ),
              )
          : [];

      const tsMap = new Map(tsRows.map((t) => [t.id, t]));

      const fromDate = options.from || "2000-01-01";
      const toDate = options.to || "2099-12-31";

      const entries: TenantReportsResult["entries"] = [];
      let totalHours = 0;
      let billableHours = 0;
      let nonBillableHours = 0;
      let totalBillableValue = 0;

      const projectAgg = new Map<
        string,
        {
          projectId: string;
          projectName: string;
          clientName: string;
          billableHours: number;
          nonBillableHours: number;
          totalHours: number;
          billableValue: number;
        }
      >();

      const clientAgg = new Map<
        string,
        {
          clientId: string;
          clientName: string;
          billableHours: number;
          nonBillableHours: number;
          totalHours: number;
          billableValue: number;
        }
      >();

      const employeeAgg = new Map<
        string,
        {
          membershipId: string;
          employeeName: string;
          department: string;
          billableHours: number;
          nonBillableHours: number;
          totalHours: number;
        }
      >();

      const monthAgg = new Map<
        string,
        {
          monthKey: string;
          monthLabel: string;
          billableHours: number;
          nonBillableHours: number;
          totalHours: number;
          billableValue: number;
        }
      >();

      for (const entry of entryRows) {
        const ts = tsMap.get(entry.timesheetId);
        if (!ts) continue;

        const proj = projectMap.get(entry.projectId) ?? {
          name: "Project",
          rate: 0,
          clientId: "general",
          clientName: "General",
        };
        const memb = memberMap.get(ts.membershipId) ?? {
          name: "Team Member",
          email: "",
          departmentId: "",
        };

        const hoursArray = entry.hoursByDayJson ?? [];
        for (let i = 0; i < Math.min(7, hoursArray.length); i++) {
          const h = Number(hoursArray[i] ?? 0);
          if (h <= 0) continue;

          let entryDate: string;
          try {
            entryDate = format(addDays(parseISO(ts.weekStart), i), "yyyy-MM-dd");
          } catch {
            entryDate = ts.weekStart;
          }

          if (entryDate < fromDate || entryDate > toDate) continue;

          const billVal = entry.billable ? h * proj.rate : 0;
          totalHours += h;
          if (entry.billable) {
            billableHours += h;
            totalBillableValue += billVal;
          } else {
            nonBillableHours += h;
          }

          entries.push({
            date: entryDate,
            membershipId: ts.membershipId,
            employeeName: memb.name,
            clientId: proj.clientId,
            clientName: proj.clientName,
            projectId: entry.projectId,
            projectName: proj.name,
            task: entry.taskName,
            hours: h,
            billable: entry.billable,
            rate: proj.rate,
            billableValue: billVal,
            status: ts.status,
            notes: entry.notes || "",
          });

          // Aggregate by project
          const pEntry = projectAgg.get(entry.projectId) ?? {
            projectId: entry.projectId,
            projectName: proj.name,
            clientName: proj.clientName,
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
            billableValue: 0,
          };
          pEntry.totalHours += h;
          if (entry.billable) {
            pEntry.billableHours += h;
            pEntry.billableValue += billVal;
          } else {
            pEntry.nonBillableHours += h;
          }
          projectAgg.set(entry.projectId, pEntry);

          // Aggregate by client
          const cEntry = clientAgg.get(proj.clientId) ?? {
            clientId: proj.clientId,
            clientName: proj.clientName,
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
            billableValue: 0,
          };
          cEntry.totalHours += h;
          if (entry.billable) {
            cEntry.billableHours += h;
            cEntry.billableValue += billVal;
          } else {
            cEntry.nonBillableHours += h;
          }
          clientAgg.set(proj.clientId, cEntry);

          // Aggregate by employee
          const eEntry = employeeAgg.get(ts.membershipId) ?? {
            membershipId: ts.membershipId,
            employeeName: memb.name,
            department: memb.departmentId || "General",
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
          };
          eEntry.totalHours += h;
          if (entry.billable) {
            eEntry.billableHours += h;
          } else {
            eEntry.nonBillableHours += h;
          }
          employeeAgg.set(ts.membershipId, eEntry);

          // Aggregate by month
          const monthKey = entryDate.substring(0, 7); // YYYY-MM
          let monthLabel: string;
          try {
            monthLabel = format(parseISO(`${monthKey}-01`), "MMM yyyy");
          } catch {
            monthLabel = monthKey;
          }
          const mEntry = monthAgg.get(monthKey) ?? {
            monthKey,
            monthLabel,
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
            billableValue: 0,
          };
          mEntry.totalHours += h;
          if (entry.billable) {
            mEntry.billableHours += h;
            mEntry.billableValue += billVal;
          } else {
            mEntry.nonBillableHours += h;
          }
          monthAgg.set(monthKey, mEntry);
        }
      }

      entries.sort((a, b) => b.date.localeCompare(a.date));

      const utilizationRate =
        totalHours > 0 ? Number(((billableHours / totalHours) * 100).toFixed(1)) : 0;

      return {
        from: fromDate,
        to: toDate,
        totalHours: Number(totalHours.toFixed(2)),
        billableHours: Number(billableHours.toFixed(2)),
        nonBillableHours: Number(nonBillableHours.toFixed(2)),
        utilizationRate,
        totalBillableValue: Number(totalBillableValue.toFixed(2)),
        byProject: Array.from(projectAgg.values()).sort((a, b) => b.totalHours - a.totalHours),
        byClient: Array.from(clientAgg.values()).sort((a, b) => b.totalHours - a.totalHours),
        byEmployee: Array.from(employeeAgg.values())
          .map((e) => ({
            ...e,
            utilizationRate:
              e.totalHours > 0 ? Number(((e.billableHours / e.totalHours) * 100).toFixed(1)) : 0,
          }))
          .sort((a, b) => b.totalHours - a.totalHours),
        byMonth: Array.from(monthAgg.values()).sort((a, b) => b.monthKey.localeCompare(a.monthKey)),
        entries,
      };
    },
    scopeOptions,
  );
}

// ============================================================================
// 14. Single Member Invitation
// ============================================================================

export interface InviteMemberInput {
  email: string;
  roleKeys: RoleKey[];
  departmentId?: string | undefined;
  reportingManagerMembershipId?: string | undefined;
}

export async function createMemberInvitationInDb(
  ctx: ResolvedTenantContext,
  input: InviteMemberInput,
  options?: {
    pool?: QueryableTransactionPool | undefined;
    env?: Record<string, string | undefined> | undefined;
    emailProvider?: EmailDeliveryProvider | undefined;
  },
): Promise<{ invitationId: string; email: string; token: string; expiresAt: string }> {
  if (!ctx.permissions.has("tenant:members:manage")) {
    throw new AuthorizationError("Only administrators can invite new members.");
  }
  const cleanEmail = input.email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("A valid email address is required for member invitation.");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return withTenantDatabaseScope(
    ctx,
    async (verifiedTenantId, { db }) => {
      const rows = await db
        .insert(schema.invitations)
        .values({
          tenantId: verifiedTenantId,
          email: cleanEmail,
          tokenHash,
          roleKeysJson: input.roleKeys.map(String),
          departmentId: input.departmentId || null,
          reportingManagerMembershipId: input.reportingManagerMembershipId || null,
          invitedByMembershipId: ctx.membership.id,
          status: "pending",
          expiresAt,
        })
        .returning();

      const created = rows[0]!;

      // Dispatch invitation email
      const provider = resolveEmailDeliveryProvider(options?.emailProvider, options?.env);
      await provider.sendInvitationEmail(cleanEmail, token, {
        tenantName: ctx.tenant.name,
        companyName: ctx.tenant.name,
        invitedByName: ctx.user.fullName,
      });

      await recordAuditLogToDb(
        ctx,
        "team",
        "member.invited",
        "invitation",
        created.id,
        { email: cleanEmail, roleKeys: input.roleKeys },
        options,
      );

      return {
        invitationId: created.id,
        email: cleanEmail,
        token,
        expiresAt: expiresAt.toISOString(),
      };
    },
    options,
  );
}
