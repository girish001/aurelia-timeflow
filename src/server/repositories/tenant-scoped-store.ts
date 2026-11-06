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
import type {
  ApprovalHistoryItem,
  ApprovalItem,
  ClientRecord,
  CreateClientInput,
  CreateProjectInput,
  DetailedTimesheet,
  DetailedTimesheetEntry,
  InviteMemberInput,
  TenantReportsResult,
  TenantSettingsRecord,
  TimesheetEntryInput,
} from "./postgres-tenant-store";
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
  private userPasswordHashes = new Map<string, string>();
  private memberships = new Map<string, MembershipRecord>();
  private customRoles = new Map<string, RoleRecord>();
  private membershipRoles: MembershipRoleAssignment[] = [];
  private reportingLines: ReportingLineRecord[] = [];
  private projects = new Map<string, ProjectRecord>();
  private projectMemberships: ProjectMembershipRecord[] = [];
  private clients = new Map<string, ClientRecord>();
  private settings = new Map<string, TenantSettingsRecord>();
  private invitations = new Map<
    string,
    {
      id: string;
      tenantId: string;
      email: string;
      token: string;
      roleKeys: string[];
      expiresAt: string;
    }
  >();
  private timesheets = new Map<string, TimesheetRecord>();
  private detailedSheets = new Map<string, DetailedTimesheet>();
  private approvalHistory: ApprovalHistoryItem[] = [];
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

  public registerUser(user: UserRecord, passwordHash?: string): UserRecord {
    this.users.set(user.id, user);
    if (passwordHash) {
      this.userPasswordHashes.set(user.id, passwordHash);
    }
    return user;
  }

  public getUser(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  public listAllUsers(): UserRecord[] {
    return Array.from(this.users.values());
  }

  public setUserPasswordHash(userId: string, hash: string): void {
    this.userPasswordHashes.set(userId, hash);
  }

  public getUserPasswordHash(userId: string): string | null {
    return this.userPasswordHashes.get(userId) ?? null;
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
      this.membershipRoles.push({
        id: assignment.id ?? `mr_${assignment.membershipId}_${assignment.roleKey}`,
        roleId: assignment.roleId ?? `sys_${assignment.roleKey}`,
        ...assignment,
      });
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
    this.reportingLines.push({
      relationshipType: line.relationshipType ?? "primary_hr",
      ...line,
    });
  }

  public createProject(project: ProjectRecord): ProjectRecord {
    const pm = this.memberships.get(project.projectManagerMembershipId);
    if (!pm || pm.tenantId !== project.tenantId) {
      throw new TenantIsolationError(
        "Project manager membership must belong to the same tenant as the project.",
      );
    }
    const normalized: ProjectRecord = {
      clientId: project.clientId ?? "default_client",
      billableRate: project.billableRate ?? 100,
      ...project,
    };
    this.projects.set(normalized.id, normalized);
    return normalized;
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
    const normalized: TimesheetRecord = {
      ...ts,
      weekStart: ts.weekStart ?? ts.weekStartDate ?? "2026-01-05",
    };
    this.timesheets.set(normalized.id, normalized);
    return normalized;
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
      const customRole = assignment.roleId ? this.customRoles.get(assignment.roleId) : undefined;
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

    const detailed = this.detailedSheets.get(timesheetId);
    if (detailed) {
      detailed.status = "approved";
      detailed.reviewedAt = new Date().toISOString();
      detailed.reviewedByMembershipId = ctx.membership.id;
    }

    const requesterUser = this.users.get(this.memberships.get(ts.membershipId)?.userId ?? "");
    this.approvalHistory.unshift({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      targetType: "timesheet",
      targetId: timesheetId,
      requesterMembershipId: ts.membershipId,
      requesterName: requesterUser?.fullName ?? "Team Member",
      approverMembershipId: ctx.membership.id,
      approverName: ctx.user.fullName,
      status: "approved",
      comment: null,
      decidedAt: new Date().toISOString(),
    });

    this.recordAudit(ctx, "approval", "timesheet.approved", "timesheet", timesheetId);
    return updated;
  }

  public getTimesheetForWeek(
    ctx: ResolvedTenantContext,
    targetMembershipId: string,
    weekStart: string,
  ): DetailedTimesheet | null {
    const isSelf = ctx.membership.id === targetMembershipId;
    const isManagerOrAdmin =
      ctx.roleKeys.has("business_admin") ||
      ctx.permissions.has("tenant:settings:manage") ||
      (ctx.permissions.has("timesheet:read:team") &&
        ctx.directReportMembershipIds.has(targetMembershipId));

    if (!isSelf && !isManagerOrAdmin) {
      throw new AuthorizationError("You do not have permission to view this timesheet.");
    }

    for (const sheet of this.detailedSheets.values()) {
      if (
        sheet.tenantId === ctx.tenant.id &&
        sheet.membershipId === targetMembershipId &&
        sheet.weekStart === weekStart
      ) {
        return sheet;
      }
    }
    return null;
  }

  public upsertTimesheet(
    ctx: ResolvedTenantContext,
    targetMembershipId: string,
    input: {
      weekStart: string;
      entries: TimesheetEntryInput[];
    },
  ): DetailedTimesheet {
    const isSelf = ctx.membership.id === targetMembershipId;
    const isAdmin =
      ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:settings:manage");

    if (!isSelf && !isAdmin) {
      throw new AuthorizationError("You can only edit your own timesheet.");
    }

    for (let day = 0; day < 7; day++) {
      let daySum = 0;
      for (const entry of input.entries) {
        const val = entry.hoursByDay[day] ?? 0;
        if (typeof val === "number") {
          daySum += val;
        }
      }
      if (daySum > 24) {
        throw new Error(`Total daily hours cannot exceed 24 hours for day ${day + 1}.`);
      }
    }

    let existing: DetailedTimesheet | undefined;
    for (const sheet of this.detailedSheets.values()) {
      if (
        sheet.tenantId === ctx.tenant.id &&
        sheet.membershipId === targetMembershipId &&
        sheet.weekStart === input.weekStart
      ) {
        existing = sheet;
        break;
      }
    }

    if (existing && (existing.status === "approved" || existing.status === "submitted")) {
      throw new Error(`Cannot modify timesheet in '${existing.status}' status.`);
    }

    const id = existing?.id ?? `ts_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    let totalHours = 0;
    const mappedEntries: DetailedTimesheetEntry[] = input.entries.map((e, idx) => {
      const sum = e.hoursByDay.reduce((acc, h) => acc + (typeof h === "number" ? h : 0), 0);
      totalHours += sum;
      const proj = this.projects.get(e.projectId);
      return {
        id: `entry_${id}_${idx + 1}`,
        timesheetId: id,
        projectId: e.projectId,
        projectName: proj?.name ?? "General",
        taskName: e.taskName.trim(),
        hoursByDay: e.hoursByDay,
        billable: e.billable ?? true,
        notes: e.notes?.trim() ?? "",
      };
    });

    const detailed: DetailedTimesheet = {
      id,
      tenantId: ctx.tenant.id,
      membershipId: targetMembershipId,
      weekStart: input.weekStart,
      status: "draft",
      submittedAt: existing?.submittedAt ?? null,
      reviewedAt: null,
      reviewedByMembershipId: null,
      reviewComment: null,
      totalHours: Math.round(totalHours * 100) / 100,
      entries: mappedEntries,
    };

    this.detailedSheets.set(id, detailed);

    // Keep timesheets map in sync
    const firstProjId = input.entries[0]?.projectId ?? "proj_default";
    this.timesheets.set(id, {
      id,
      tenantId: ctx.tenant.id,
      membershipId: targetMembershipId,
      projectId: firstProjId,
      weekStartDate: input.weekStart,
      totalHours: detailed.totalHours,
      status: "draft",
    });

    return detailed;
  }

  public submitTimesheet(ctx: ResolvedTenantContext, timesheetId: string): DetailedTimesheet {
    const sheet = this.detailedSheets.get(timesheetId);
    if (!sheet) {
      throw new Error(`Timesheet ${timesheetId} not found.`);
    }
    assertSameTenant(ctx, sheet.tenantId);

    const isSelf = ctx.membership.id === sheet.membershipId;
    const isAdmin =
      ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:settings:manage");
    if (!isSelf && !isAdmin) {
      throw new AuthorizationError("You can only submit your own timesheet.");
    }

    if (sheet.status === "approved") {
      throw new Error("Timesheet is already approved.");
    }
    if (sheet.status === "submitted") {
      throw new Error("Timesheet is already submitted.");
    }

    sheet.status = "submitted";
    sheet.submittedAt = new Date().toISOString();
    const legacy = this.timesheets.get(timesheetId);
    if (legacy) {
      legacy.status = "submitted";
    }

    this.recordAudit(ctx, "timesheet", "timesheet.submitted", "timesheet", timesheetId);
    return sheet;
  }

  public rejectTimesheet(
    ctx: ResolvedTenantContext,
    timesheetId: string,
    rejectionComment: string,
  ): TimesheetRecord {
    if (!rejectionComment || rejectionComment.trim().length < 3) {
      throw new Error("A rejection comment of at least 3 characters is required.");
    }

    const ts = this.timesheets.get(timesheetId);
    const detailed = this.detailedSheets.get(timesheetId);
    if (!ts && !detailed) {
      throw new Error(`Timesheet ${timesheetId} not found.`);
    }
    const tenantId = ts?.tenantId ?? detailed?.tenantId ?? "";
    assertSameTenant(ctx, tenantId);

    const membershipId = ts?.membershipId ?? detailed?.membershipId ?? "";
    if (membershipId === ctx.membership.id) {
      throw new AuthorizationError("Self-rejection is not permitted.");
    }

    const isBusinessAdmin = ctx.roleKeys.has("business_admin");
    const isDirectReport = ctx.directReportMembershipIds.has(membershipId);
    if (!isBusinessAdmin && !isDirectReport) {
      throw new AuthorizationError(
        `Membership ${ctx.membership.id} is not authorized to reject timesheet ${timesheetId}.`,
      );
    }

    const updated: TimesheetRecord = {
      id: timesheetId,
      tenantId: ctx.tenant.id,
      membershipId,
      projectId: ts?.projectId ?? detailed?.entries[0]?.projectId ?? "",
      weekStartDate: ts?.weekStartDate ?? detailed?.weekStart ?? "",
      totalHours: ts?.totalHours ?? detailed?.totalHours ?? 0,
      status: "rejected",
    };
    this.timesheets.set(timesheetId, updated);

    if (detailed) {
      detailed.status = "rejected";
      detailed.reviewComment = rejectionComment.trim();
      detailed.reviewedAt = new Date().toISOString();
      detailed.reviewedByMembershipId = ctx.membership.id;
    }

    const requesterUser = this.users.get(this.memberships.get(membershipId)?.userId ?? "");
    this.approvalHistory.unshift({
      id: `appr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      targetType: "timesheet",
      targetId: timesheetId,
      requesterMembershipId: membershipId,
      requesterName: requesterUser?.fullName ?? "Team Member",
      approverMembershipId: ctx.membership.id,
      approverName: ctx.user.fullName,
      status: "rejected",
      comment: rejectionComment.trim(),
      decidedAt: new Date().toISOString(),
    });

    this.recordAudit(ctx, "approval", "timesheet.rejected", "timesheet", timesheetId);
    return updated;
  }

  public listApprovals(ctx: ResolvedTenantContext): {
    pending: ApprovalItem[];
    history: ApprovalHistoryItem[];
  } {
    const isBusinessAdmin =
      ctx.roleKeys.has("business_admin") || ctx.permissions.has("tenant:settings:manage");

    const pending: ApprovalItem[] = [];
    for (const sheet of this.detailedSheets.values()) {
      if (sheet.tenantId !== ctx.tenant.id || sheet.status !== "submitted") continue;
      if (!isBusinessAdmin && !ctx.directReportMembershipIds.has(sheet.membershipId)) continue;

      const member = this.memberships.get(sheet.membershipId);
      const user = member ? this.users.get(member.userId) : undefined;

      pending.push({
        id: sheet.id,
        timesheetId: sheet.id,
        membershipId: sheet.membershipId,
        memberName: user?.fullName ?? "Team Member",
        memberEmail: user?.email ?? "",
        jobTitle: member?.jobTitle ?? "Member",
        weekStart: sheet.weekStart,
        totalHours: sheet.totalHours,
        submittedAt: sheet.submittedAt,
        entries: sheet.entries.map((e) => ({
          id: e.id,
          projectId: e.projectId,
          projectName: e.projectName,
          taskName: e.taskName,
          hoursByDay: e.hoursByDay,
          billable: e.billable,
          notes: e.notes,
        })),
      });
    }

    return {
      pending,
      history: this.approvalHistory.slice(0, 50),
    };
  }

  public listTenantAuditLogs(ctx: ResolvedTenantContext): AuditLogRecord[] {
    if (!ctx.permissions.has("audit:read:tenant")) {
      throw new AuthorizationError("Only authorized administrators can read tenant audit logs.");
    }
    return this.auditLogs.filter((l) => l.tenantId === ctx.tenant.id);
  }

  public listClients(
    ctx: ResolvedTenantContext,
    options?: { search?: string; status?: string; page?: number; limit?: number },
  ): { clients: ClientRecord[]; total: number } {
    let list = Array.from(this.clients.values()).filter((c) => c.tenantId === ctx.tenant.id);
    if (options?.status && options.status !== "all") {
      list = list.filter((c) => c.status === options.status);
    }
    if (options?.search?.trim()) {
      const q = options.search.trim().toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.contactName.toLowerCase().includes(q) ||
          c.contactEmail.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    const total = list.length;
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.max(1, Math.min(100, options?.limit ?? 50));
    const paginated = list.slice((page - 1) * limit, page * limit);
    return { clients: paginated, total };
  }

  public createClient(ctx: ResolvedTenantContext, input: CreateClientInput): ClientRecord {
    if (!ctx.permissions.has("client:write:all")) {
      throw new AuthorizationError("Only administrators can create client accounts.");
    }
    if (!input.name?.trim()) {
      throw new Error("Client name is required.");
    }
    const id = `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const client: ClientRecord = {
      id,
      tenantId: ctx.tenant.id,
      name: input.name.trim(),
      contactName: input.contactName?.trim() || "Contact Representative",
      contactEmail: input.contactEmail?.trim().toLowerCase() || "",
      country: input.country?.trim() || "India",
      billingTerms: input.billingTerms?.trim() || "Net 30",
      status: input.status === "inactive" ? "inactive" : "active",
      createdAt: new Date().toISOString(),
    };
    this.clients.set(id, client);
    this.recordAudit(ctx, "client", "client.created", "client", id);
    return client;
  }

  public updateClient(
    ctx: ResolvedTenantContext,
    clientId: string,
    input: Partial<CreateClientInput>,
  ): ClientRecord {
    if (!ctx.permissions.has("client:write:all")) {
      throw new AuthorizationError("Only administrators can update client accounts.");
    }
    const client = this.clients.get(clientId);
    if (!client || client.tenantId !== ctx.tenant.id) {
      throw new Error(`Client ${clientId} not found.`);
    }
    if (input.name !== undefined) client.name = input.name.trim();
    if (input.contactName !== undefined) client.contactName = input.contactName.trim();
    if (input.contactEmail !== undefined)
      client.contactEmail = input.contactEmail.trim().toLowerCase();
    if (input.country !== undefined) client.country = input.country.trim();
    if (input.billingTerms !== undefined) client.billingTerms = input.billingTerms.trim();
    if (input.status !== undefined) client.status = input.status;
    this.recordAudit(ctx, "client", "client.updated", "client", clientId);
    return client;
  }

  public registerReportingLine(line: ReportingLineRecord): void {
    this.addReportingLine(line);
  }

  public createProjectScoped(ctx: ResolvedTenantContext, input: CreateProjectInput): ProjectRecord {
    if (!ctx.permissions.has("project:write:all")) {
      throw new AuthorizationError("Only administrators can create new projects.");
    }
    if (!input.name?.trim()) {
      throw new Error("Project name is required.");
    }
    const id = `p_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const project: ProjectRecord = {
      id,
      tenantId: ctx.tenant.id,
      clientId: input.clientId,
      name: input.name.trim(),
      projectManagerMembershipId: input.projectManagerMembershipId || ctx.membership.id,
      budgetHours: input.budgetHours ?? 100,
      billableRate: input.billableRate ?? 75,
      status: input.status ?? "active",
    };
    this.projects.set(id, project);
    this.projectMemberships.push({
      id: `pm_${id}_${project.projectManagerMembershipId}`,
      tenantId: ctx.tenant.id,
      projectId: id,
      membershipId: project.projectManagerMembershipId,
      projectRole: "project_manager",
      canApproveTimesheets: true,
      canManageAllocations: true,
    });
    this.recordAudit(ctx, "project", "project.created", "project", id);
    return project;
  }

  public getTenantSettings(ctx: ResolvedTenantContext): TenantSettingsRecord {
    const existing = this.settings.get(ctx.tenant.id);
    if (existing) return existing;
    const defaultSettings: TenantSettingsRecord = {
      id: ctx.tenant.id,
      name: ctx.tenant.name,
      slug: ctx.tenant.slug,
      country: "India",
      timezone: "Asia/Kolkata",
      currency: "INR",
      timeFormat: "decimal",
      weekStart: "monday",
      dailyTargetHours: "8.00",
      lockApprovedSheets: true,
      requireRejectReason: true,
    };
    this.settings.set(ctx.tenant.id, defaultSettings);
    return defaultSettings;
  }

  public updateTenantSettings(
    ctx: ResolvedTenantContext,
    input: Partial<Omit<TenantSettingsRecord, "id" | "slug">>,
  ): TenantSettingsRecord {
    if (!ctx.permissions.has("tenant:settings:manage")) {
      throw new AuthorizationError("Only administrators can update company settings.");
    }
    const current = this.getTenantSettings(ctx);
    const updated: TenantSettingsRecord = {
      ...current,
      ...input,
    };
    this.settings.set(ctx.tenant.id, updated);
    this.recordAudit(ctx, "settings", "tenant.settings_updated", "tenant", ctx.tenant.id);
    return updated;
  }

  public getReports(
    ctx: ResolvedTenantContext,
    options: { from?: string; to?: string; includeDrafts?: boolean },
  ): TenantReportsResult {
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

    for (const sheet of this.detailedSheets.values()) {
      if (sheet.tenantId !== ctx.tenant.id) continue;
      if (!options.includeDrafts && sheet.status === "draft") continue;

      const member = this.memberships.get(sheet.membershipId);
      const user = member ? this.users.get(member.userId) : undefined;
      const empName = user?.fullName ?? "Team Member";

      for (const entry of sheet.entries) {
        const proj = this.projects.get(entry.projectId);
        const client = proj ? this.clients.get(proj.clientId) : undefined;
        const projName = proj?.name ?? entry.projectName;
        const rate = proj?.billableRate ?? 75;
        const clientId = proj?.clientId ?? "c_internal";
        const clientName = client?.name ?? "Internal";

        for (let i = 0; i < Math.min(7, entry.hoursByDay.length); i++) {
          const h = Number(entry.hoursByDay[i] ?? 0);
          if (h <= 0) continue;

          // Simple day calculation: ISO week date offset
          const dateObj = new Date(sheet.weekStart);
          dateObj.setDate(dateObj.getDate() + i);
          const entryDate = dateObj.toISOString().substring(0, 10);

          if (entryDate < fromDate || entryDate > toDate) continue;

          const billVal = entry.billable ? h * rate : 0;
          totalHours += h;
          if (entry.billable) {
            billableHours += h;
            totalBillableValue += billVal;
          } else {
            nonBillableHours += h;
          }

          entries.push({
            date: entryDate,
            membershipId: sheet.membershipId,
            employeeName: empName,
            clientId,
            clientName,
            projectId: entry.projectId,
            projectName: projName,
            task: entry.taskName,
            hours: h,
            billable: entry.billable,
            rate,
            billableValue: billVal,
            status: sheet.status,
            notes: entry.notes || "",
          });

          // Aggregate by project
          const p = projectAgg.get(entry.projectId) ?? {
            projectId: entry.projectId,
            projectName: projName,
            clientName,
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
            billableValue: 0,
          };
          p.totalHours += h;
          if (entry.billable) {
            p.billableHours += h;
            p.billableValue += billVal;
          } else {
            p.nonBillableHours += h;
          }
          projectAgg.set(entry.projectId, p);

          // Aggregate by client
          const c = clientAgg.get(clientId) ?? {
            clientId,
            clientName,
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
            billableValue: 0,
          };
          c.totalHours += h;
          if (entry.billable) {
            c.billableHours += h;
            c.billableValue += billVal;
          } else {
            c.nonBillableHours += h;
          }
          clientAgg.set(clientId, c);

          // Aggregate by employee
          const e = employeeAgg.get(sheet.membershipId) ?? {
            membershipId: sheet.membershipId,
            employeeName: empName,
            department: member?.departmentId || "General",
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
          };
          e.totalHours += h;
          if (entry.billable) {
            e.billableHours += h;
          } else {
            e.nonBillableHours += h;
          }
          employeeAgg.set(sheet.membershipId, e);

          // Aggregate by month
          const monthKey = entryDate.substring(0, 7);
          const m = monthAgg.get(monthKey) ?? {
            monthKey,
            monthLabel: monthKey,
            billableHours: 0,
            nonBillableHours: 0,
            totalHours: 0,
            billableValue: 0,
          };
          m.totalHours += h;
          if (entry.billable) {
            m.billableHours += h;
            m.billableValue += billVal;
          } else {
            m.nonBillableHours += h;
          }
          monthAgg.set(monthKey, m);
        }
      }
    }

    entries.sort((a, b) => b.date.localeCompare(a.date));

    return {
      from: fromDate,
      to: toDate,
      totalHours: Number(totalHours.toFixed(2)),
      billableHours: Number(billableHours.toFixed(2)),
      nonBillableHours: Number(nonBillableHours.toFixed(2)),
      utilizationRate: totalHours > 0 ? Number(((billableHours / totalHours) * 100).toFixed(1)) : 0,
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
  }

  public createInvitation(
    ctx: ResolvedTenantContext,
    input: InviteMemberInput,
  ): { invitationId: string; email: string; token: string; expiresAt: string } {
    if (!ctx.permissions.has("tenant:members:manage")) {
      throw new AuthorizationError("Only administrators can invite new members.");
    }
    const cleanEmail = input.email.trim().toLowerCase();
    const token = `inv_${Math.random().toString(36).substring(2, 10)}`;
    const id = `inv_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.invitations.set(id, {
      id,
      tenantId: ctx.tenant.id,
      email: cleanEmail,
      token,
      roleKeys: input.roleKeys.map(String),
      expiresAt,
    });
    this.recordAudit(ctx, "team", "member.invited", "invitation", id);
    return { invitationId: id, email: cleanEmail, token, expiresAt };
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
