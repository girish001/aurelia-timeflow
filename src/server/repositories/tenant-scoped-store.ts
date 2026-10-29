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
  AuthorizationError,
  TenantIsolationError,
  type AuditLogRecord,
  type MembershipRecord,
  type MembershipRoleAssignment,
  type PermissionCode,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type ReportingLineRecord,
  type ResolvedTenantContext,
  type RoleKey,
  type RoleRecord,
  type SystemRoleKey,
  type TenantDomainRecord,
  type TenantRecord,
  type TimesheetRecord,
  type UserRecord,
} from "../tenancy/tenant-context";

/**
 * Tenant-Scoped Repository & Data Access Layer.
 * Enforces mandatory tenant_id scoping, explicit membership verification
 * (never granting access solely by email domain), multi-role resolution,
 * and fine-grained HR vs. Project authorization.
 */
export class MultiTenantDataStore {
  private tenants = new Map<string, TenantRecord>();
  private tenantDomains = new Map<string, TenantDomainRecord>();
  private users = new Map<string, UserRecord>();
  private memberships = new Map<string, MembershipRecord>();
  private customRoles = new Map<string, RoleRecord>();
  private membershipRoles: MembershipRoleAssignment[] = [];
  private reportingLines: ReportingLineRecord[] = [];
  private projects = new Map<string, ProjectRecord>();
  private projectMemberships: ProjectMembershipRecord[] = [];
  private timesheets = new Map<string, TimesheetRecord>();
  private auditLogs: AuditLogRecord[] = [];

  // --------------------------------------------------------------------------
  // Provisioning & Seeding Helpers
  // --------------------------------------------------------------------------

  public registerTenant(tenant: TenantRecord): TenantRecord {
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  public registerTenantDomain(domain: TenantDomainRecord): TenantDomainRecord {
    this.tenantDomains.set(domain.id, domain);
    return domain;
  }

  public registerUser(user: UserRecord): UserRecord {
    this.users.set(user.id, user);
    return user;
  }

  public createMembership(membership: MembershipRecord): MembershipRecord {
    const tenant = this.tenants.get(membership.tenantId);
    if (!tenant) {
      throw new TenantIsolationError(`Tenant ${membership.tenantId} does not exist.`);
    }
    const existing = Array.from(this.memberships.values()).find(
      (m) => m.tenantId === membership.tenantId && m.userId === membership.userId,
    );
    if (existing) {
      throw new Error(
        `Duplicate membership: user ${membership.userId} already has membership in tenant ${membership.tenantId}.`,
      );
    }
    this.memberships.set(membership.id, membership);
    return membership;
  }

  public registerCustomRole(role: RoleRecord): RoleRecord {
    this.customRoles.set(role.id, role);
    return role;
  }

  public assignRoleToMembership(assignment: MembershipRoleAssignment): void {
    const membership = this.memberships.get(assignment.membershipId);
    if (!membership || membership.tenantId !== assignment.tenantId) {
      throw new TenantIsolationError(
        "Cannot assign a role across mismatched tenant and membership.",
      );
    }
    const duplicate = this.membershipRoles.some(
      (mr) =>
        mr.tenantId === assignment.tenantId &&
        mr.membershipId === assignment.membershipId &&
        mr.roleKey === assignment.roleKey,
    );
    if (!duplicate) {
      this.membershipRoles.push(assignment);
    }
  }

  public addReportingLine(line: ReportingLineRecord): void {
    const sub = this.memberships.get(line.subordinateMembershipId);
    const mgr = this.memberships.get(line.managerMembershipId);
    if (!sub || !mgr || sub.tenantId !== line.tenantId || mgr.tenantId !== line.tenantId) {
      throw new TenantIsolationError(
        "Reporting line members must both belong to the target tenant.",
      );
    }
    if (line.subordinateMembershipId === line.managerMembershipId) {
      throw new Error("A member cannot report to themselves.");
    }
    this.reportingLines.push(line);
  }

  public createProject(project: ProjectRecord): ProjectRecord {
    const pm = this.memberships.get(project.projectManagerMembershipId);
    if (!pm || pm.tenantId !== project.tenantId) {
      throw new TenantIsolationError(
        "Project manager membership must belong to the same tenant as the project.",
      );
    }
    this.projects.set(project.id, project);
    return project;
  }

  public addProjectMembership(pm: ProjectMembershipRecord): void {
    const project = this.projects.get(pm.projectId);
    const member = this.memberships.get(pm.membershipId);
    if (
      !project ||
      !member ||
      project.tenantId !== pm.tenantId ||
      member.tenantId !== pm.tenantId
    ) {
      throw new TenantIsolationError(
        "Project membership requires both project and member to belong to the same tenant.",
      );
    }
    this.projectMemberships.push(pm);
  }

  public createTimesheet(ts: TimesheetRecord): TimesheetRecord {
    const member = this.memberships.get(ts.membershipId);
    const project = this.projects.get(ts.projectId);
    if (
      !member ||
      !project ||
      member.tenantId !== ts.tenantId ||
      project.tenantId !== ts.tenantId
    ) {
      throw new TenantIsolationError(
        "Timesheet membership and project must belong to the target tenant.",
      );
    }
    this.timesheets.set(ts.id, ts);
    return ts;
  }

  // --------------------------------------------------------------------------
  // Context Resolution (Enforces Explicit Membership & Multi-Role Aggregation)
  // --------------------------------------------------------------------------

  /**
   * Resolves a verified `ResolvedTenantContext` for `(userId, tenantId)`.
   * Security invariant:
   * - Matching a verified `tenant_domain` by email address NEVER automatically grants access.
   * - An explicit, `active` `MembershipRecord` in `tenantId` is strictly required.
   */
  public resolveTenantContext(userId: string, tenantId: string): ResolvedTenantContext {
    const tenant = this.tenants.get(tenantId);
    if (!tenant || tenant.status === "suspended" || tenant.status === "archived") {
      throw new TenantIsolationError(`Tenant ${tenantId} is unavailable or suspended.`);
    }

    const user = this.users.get(userId);
    if (!user || user.status !== "active") {
      throw new TenantIsolationError(`User ${userId} is not active.`);
    }

    const membership = Array.from(this.memberships.values()).find(
      (m) => m.tenantId === tenantId && m.userId === userId,
    );

    if (!membership || membership.status !== "active") {
      throw new TenantIsolationError(
        `Access denied: user ${user.email} has no active membership in tenant ${tenant.slug}. Email domain matching alone does not grant access.`,
      );
    }

    const assignedRoles = this.membershipRoles.filter(
      (mr) => mr.tenantId === tenantId && mr.membershipId === membership.id,
    );

    const roleKeys = new Set<RoleKey>();
    const permissions = new Set<PermissionCode>();

    for (const assignment of assignedRoles) {
      roleKeys.add(assignment.roleKey);
      if (assignment.roleKey in SYSTEM_ROLE_PERMISSIONS) {
        const sysPerms = SYSTEM_ROLE_PERMISSIONS[assignment.roleKey as SystemRoleKey];
        sysPerms.forEach((p) => permissions.add(p));
      }
      const customRole = this.customRoles.get(assignment.roleId);
      if (customRole && (customRole.tenantId === null || customRole.tenantId === tenantId)) {
        customRole.permissions.forEach((p) => permissions.add(p));
      }
    }

    const directReportMembershipIds = new Set<string>(
      this.reportingLines
        .filter((rl) => rl.tenantId === tenantId && rl.managerMembershipId === membership.id)
        .map((rl) => rl.subordinateMembershipId),
    );

    const managedProjectIds = new Set<string>();
    const assignedProjectIds = new Set<string>();

    for (const proj of this.projects.values()) {
      if (proj.tenantId === tenantId && proj.projectManagerMembershipId === membership.id) {
        managedProjectIds.add(proj.id);
        assignedProjectIds.add(proj.id);
      }
    }

    for (const pm of this.projectMemberships) {
      if (pm.tenantId === tenantId && pm.membershipId === membership.id) {
        assignedProjectIds.add(pm.projectId);
        if (pm.projectRole === "project_manager" || pm.canManageAllocations) {
          managedProjectIds.add(pm.projectId);
        }
      }
    }

    return {
      tenant,
      user,
      membership,
      roleKeys,
      permissions,
      directReportMembershipIds,
      managedProjectIds,
      assignedProjectIds,
    };
  }

  /**
   * Lists all active tenant memberships for a user (supporting multi-company users).
   */
  public listUserTenants(
    userId: string,
  ): Array<{ tenant: TenantRecord; membership: MembershipRecord }> {
    const out: Array<{ tenant: TenantRecord; membership: MembershipRecord }> = [];
    for (const m of this.memberships.values()) {
      if (m.userId === userId && m.status === "active") {
        const t = this.tenants.get(m.tenantId);
        if (t && t.status === "active") {
          out.push({ tenant: t, membership: m });
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Tenant-Scoped Queries & Commands
  // --------------------------------------------------------------------------

  public getProjectById(ctx: ResolvedTenantContext, projectId: string): ProjectRecord {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }
    assertSameTenant(ctx, project.tenantId);

    const pms = this.projectMemberships.filter((pm) => pm.tenantId === ctx.tenant.id);
    if (!canViewProject(ctx, project, pms)) {
      throw new AuthorizationError(
        `Membership ${ctx.membership.id} is not authorized to view project ${project.id}.`,
      );
    }
    return project;
  }

  public listVisibleProjects(ctx: ResolvedTenantContext): ProjectRecord[] {
    const pms = this.projectMemberships.filter((pm) => pm.tenantId === ctx.tenant.id);
    return Array.from(this.projects.values()).filter(
      (p) => p.tenantId === ctx.tenant.id && canViewProject(ctx, p, pms),
    );
  }

  public updateProjectBudget(
    ctx: ResolvedTenantContext,
    projectId: string,
    newBudgetHours: number,
  ): ProjectRecord {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }
    assertSameTenant(ctx, project.tenantId);

    const pms = this.projectMemberships.filter((pm) => pm.tenantId === ctx.tenant.id);
    assertCanManageProject(ctx, project, pms);

    const updated: ProjectRecord = { ...project, budgetHours: newBudgetHours };
    this.projects.set(projectId, updated);
    this.recordAudit(ctx, "project", "project.budget.updated", "project", projectId);
    return updated;
  }

  public getTeamMemberProfile(
    ctx: ResolvedTenantContext,
    targetMembershipId: string,
  ): MembershipRecord {
    const target = this.memberships.get(targetMembershipId);
    if (!target) {
      throw new Error(`Membership ${targetMembershipId} not found.`);
    }
    assertSameTenant(ctx, target.tenantId);
    assertCanAccessTeamMember(ctx, target);
    return target;
  }

  public listAccessibleTeamMembers(ctx: ResolvedTenantContext): MembershipRecord[] {
    return Array.from(this.memberships.values()).filter(
      (m) => m.tenantId === ctx.tenant.id && canAccessTeamMember(ctx, m),
    );
  }

  public approveTimesheet(ctx: ResolvedTenantContext, timesheetId: string): TimesheetRecord {
    const ts = this.timesheets.get(timesheetId);
    if (!ts) {
      throw new Error(`Timesheet ${timesheetId} not found.`);
    }
    assertSameTenant(ctx, ts.tenantId);

    const project = this.projects.get(ts.projectId);
    if (!project) {
      throw new Error(`Project ${ts.projectId} not found.`);
    }
    assertSameTenant(ctx, project.tenantId);

    const pms = this.projectMemberships.filter((pm) => pm.tenantId === ctx.tenant.id);
    if (!canApproveTimesheetRecord(ctx, ts, project, pms)) {
      throw new AuthorizationError(
        `Membership ${ctx.membership.id} is not authorized to approve timesheet ${timesheetId}.`,
      );
    }

    const updated: TimesheetRecord = { ...ts, status: "approved" };
    this.timesheets.set(timesheetId, updated);
    this.recordAudit(ctx, "approval", "timesheet.approved", "timesheet", timesheetId);
    return updated;
  }

  public listTenantAuditLogs(ctx: ResolvedTenantContext): AuditLogRecord[] {
    if (!ctx.permissions.has("audit:read:tenant")) {
      throw new AuthorizationError("Only authorized administrators can read tenant audit logs.");
    }
    return this.auditLogs.filter((l) => l.tenantId === ctx.tenant.id);
  }

  private recordAudit(
    ctx: ResolvedTenantContext,
    category: string,
    action: string,
    targetType: string,
    targetId: string,
  ): void {
    this.auditLogs.push({
      id: `al_${this.auditLogs.length + 1}`,
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorMembershipId: ctx.membership.id,
      impersonatedByPlatformUserId: ctx.impersonatedByPlatformUserId,
      category,
      action,
      targetType,
      targetId,
      createdAt: new Date().toISOString(),
    });
  }
}

export { canManageProject, canViewProject, canAccessTeamMember };
