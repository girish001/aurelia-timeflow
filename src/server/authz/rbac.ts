import {
  AuthorizationError,
  TenantIsolationError,
  type MembershipRecord,
  type PermissionCode,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type ResolvedTenantContext,
  type RoleKey,
  type SystemRoleKey,
  type TimesheetRecord,
} from "../tenancy/tenant-context";

/**
 * Built-in system role permission matrix.
 * Roles are additive and non-mutually-exclusive: a user may simultaneously hold
 * `employee` + `manager`, or `employee` + `team_lead` + custom roles.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, PermissionCode[]> = {
  business_admin: [
    "tenant:settings:manage",
    "tenant:members:manage",
    "client:read:all",
    "client:write:all",
    "project:read:all",
    "project:read:assigned",
    "project:write:all",
    "project:write:assigned",
    "allocation:read:all",
    "allocation:read:team",
    "allocation:read:own",
    "allocation:write:project",
    "timesheet:submit:own",
    "timesheet:read:team",
    "timesheet:approve:team",
    "timesheet:approve:project",
    "leave:request:own",
    "leave:approve:reports",
    "report:read:tenant",
    "audit:read:tenant",
  ],
  manager: [
    "project:read:assigned",
    "project:write:assigned",
    "allocation:read:team",
    "allocation:read:own",
    "allocation:write:project",
    "timesheet:submit:own",
    "timesheet:read:team",
    "timesheet:approve:team",
    "timesheet:approve:project",
    "leave:request:own",
    "leave:approve:reports",
  ],
  team_lead: [
    "project:read:assigned",
    "allocation:read:team",
    "allocation:read:own",
    "timesheet:submit:own",
    "timesheet:read:team",
    "leave:request:own",
  ],
  employee: [
    "project:read:assigned",
    "allocation:read:own",
    "timesheet:submit:own",
    "leave:request:own",
  ],
};

/**
 * Verifies that the target record belongs to the active tenant context.
 */
export function assertSameTenant(ctx: ResolvedTenantContext, recordTenantId: string): void {
  if (ctx.tenant.id !== recordTenantId || ctx.membership.tenantId !== recordTenantId) {
    throw new TenantIsolationError(
      `Tenant isolation violation: context tenant ${ctx.tenant.id} cannot access record in tenant ${recordTenantId}.`,
    );
  }
}

export function hasPermission(ctx: ResolvedTenantContext, permission: PermissionCode): boolean {
  return ctx.permissions.has(permission);
}

export function hasRole(ctx: ResolvedTenantContext, role: RoleKey): boolean {
  return ctx.roleKeys.has(role);
}

/**
 * Evaluates whether the caller can view/manage a specific team member's HR/timesheet profile.
 * Separates:
 * 1. Business Admin (company-wide within tenant)
 * 2. Self access
 * 3. Line Manager / Team Lead access via explicit `reportingLines`
 */
export function canAccessTeamMember(
  ctx: ResolvedTenantContext,
  targetMember: MembershipRecord,
): boolean {
  assertSameTenant(ctx, targetMember.tenantId);

  if (hasRole(ctx, "business_admin") || hasPermission(ctx, "tenant:members:manage")) {
    return true;
  }

  if (ctx.membership.id === targetMember.id) {
    return true;
  }

  if (
    (hasPermission(ctx, "timesheet:read:team") || hasPermission(ctx, "leave:approve:reports")) &&
    ctx.directReportMembershipIds.has(targetMember.id)
  ) {
    return true;
  }

  return false;
}

export function assertCanAccessTeamMember(
  ctx: ResolvedTenantContext,
  targetMember: MembershipRecord,
): void {
  if (!canAccessTeamMember(ctx, targetMember)) {
    throw new AuthorizationError(
      `Membership ${ctx.membership.id} is not authorized to access team member ${targetMember.id}.`,
    );
  }
}

/**
 * Evaluates whether the caller can view a project.
 * Project access is granted by:
 * - Tenant-wide `project:read:all` (e.g. Business Admin)
 * - Being the designated `projectManagerMembershipId` on the project
 * - Having an explicit `project_memberships` assignment on the project
 */
export function canViewProject(
  ctx: ResolvedTenantContext,
  project: ProjectRecord,
  projectMemberships: ProjectMembershipRecord[],
): boolean {
  assertSameTenant(ctx, project.tenantId);

  if (hasPermission(ctx, "project:read:all")) {
    return true;
  }

  if (project.projectManagerMembershipId === ctx.membership.id) {
    return true;
  }

  if (ctx.managedProjectIds.has(project.id) || ctx.assignedProjectIds.has(project.id)) {
    return true;
  }

  return projectMemberships.some(
    (pm) =>
      pm.tenantId === ctx.tenant.id &&
      pm.projectId === project.id &&
      pm.membershipId === ctx.membership.id,
  );
}

/**
 * Evaluates whether the caller can manage a project (budget, tasks, allocations).
 * Notice: A Project Manager can manage their assigned project even without direct HR reportees!
 * Conversely, a Manager/Project Manager CANNOT manage a project they are not assigned to manage.
 */
export function canManageProject(
  ctx: ResolvedTenantContext,
  project: ProjectRecord,
  projectMemberships: ProjectMembershipRecord[],
): boolean {
  assertSameTenant(ctx, project.tenantId);

  if (hasPermission(ctx, "project:write:all")) {
    return true;
  }

  if (project.projectManagerMembershipId === ctx.membership.id) {
    return true;
  }

  if (ctx.managedProjectIds.has(project.id)) {
    return true;
  }

  return projectMemberships.some(
    (pm) =>
      pm.tenantId === ctx.tenant.id &&
      pm.projectId === project.id &&
      pm.membershipId === ctx.membership.id &&
      (pm.projectRole === "project_manager" || pm.canManageAllocations),
  );
}

export function assertCanManageProject(
  ctx: ResolvedTenantContext,
  project: ProjectRecord,
  projectMemberships: ProjectMembershipRecord[],
): void {
  if (!canManageProject(ctx, project, projectMemberships)) {
    throw new AuthorizationError(
      `Membership ${ctx.membership.id} is not authorized to manage project ${project.id}.`,
    );
  }
}

/**
 * Evaluates whether the caller can approve a submitted timesheet.
 * Supports both HR reporting-line managers AND project-level approvers.
 * Self-approval is always prohibited.
 */
export function canApproveTimesheetRecord(
  ctx: ResolvedTenantContext,
  timesheet: TimesheetRecord,
  project: ProjectRecord,
  projectMemberships: ProjectMembershipRecord[],
): boolean {
  assertSameTenant(ctx, timesheet.tenantId);
  assertSameTenant(ctx, project.tenantId);

  // Never allow self-approval
  if (timesheet.membershipId === ctx.membership.id) {
    return false;
  }

  if (hasRole(ctx, "business_admin")) {
    return true;
  }

  // HR Reporting Manager approval path
  if (
    hasPermission(ctx, "timesheet:approve:team") &&
    ctx.directReportMembershipIds.has(timesheet.membershipId)
  ) {
    return true;
  }

  // Project Manager / Project-level approver path (even without HR direct reports)
  if (project.projectManagerMembershipId === ctx.membership.id) {
    return true;
  }

  return projectMemberships.some(
    (pm) =>
      pm.tenantId === ctx.tenant.id &&
      pm.projectId === project.id &&
      pm.membershipId === ctx.membership.id &&
      pm.canApproveTimesheets,
  );
}
