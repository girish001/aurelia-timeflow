// ============================================================================
// Multi-Tenant Context, Domain Models & Security Invariants
// ============================================================================

export type SystemRoleKey = "business_admin" | "manager" | "team_lead" | "employee";
export type RoleKey = SystemRoleKey | (string & {});

export type PermissionCode =
  | "tenant:settings:manage"
  | "tenant:members:manage"
  | "client:read:all"
  | "client:write:all"
  | "project:read:all"
  | "project:read:assigned"
  | "project:write:all"
  | "project:write:assigned"
  | "allocation:read:all"
  | "allocation:read:team"
  | "allocation:read:own"
  | "allocation:write:project"
  | "timesheet:submit:own"
  | "timesheet:read:team"
  | "timesheet:approve:team"
  | "timesheet:approve:project"
  | "leave:request:own"
  | "leave:approve:reports"
  | "report:read:tenant"
  | "audit:read:tenant";

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  status: "provisioning" | "onboarding" | "trial" | "active" | "suspended" | "archived";
  onboardingMode: "self_service" | "assisted_enterprise";
}

export interface TenantDomainRecord {
  id: string;
  tenantId: string;
  domain: string;
  verifiedAt: string | null;
  autoJoinPolicy: "never" | "invite_only" | "sso_verified_only";
}

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  emailVerifiedAt: string | null;
  isPlatformAdmin: boolean;
  status: "active" | "locked" | "disabled";
}

export interface MembershipRecord {
  id: string;
  tenantId: string;
  userId: string;
  departmentId?: string | undefined;
  jobTitle: string;
  status: "invited" | "active" | "inactive" | "offboarded";
}

export interface RoleRecord {
  id: string;
  tenantId: string | null;
  key: RoleKey;
  name: string;
  permissions: PermissionCode[];
  isSystemRole: boolean;
}

export interface MembershipRoleAssignment {
  id: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  roleKey: RoleKey;
}

export interface ReportingLineRecord {
  id: string;
  tenantId: string;
  subordinateMembershipId: string;
  managerMembershipId: string;
  relationshipType: "primary_hr" | "dotted_line";
}

export interface ProjectRecord {
  id: string;
  tenantId: string;
  clientId: string;
  name: string;
  projectManagerMembershipId: string;
  status: "active" | "on-hold" | "completed";
  budgetHours: number;
  billableRate: number;
}

export interface ProjectMembershipRecord {
  id: string;
  tenantId: string;
  projectId: string;
  membershipId: string;
  projectRole: "project_manager" | "team_lead" | "contributor" | "viewer";
  canApproveTimesheets: boolean;
  canManageAllocations: boolean;
}

export interface TimesheetRecord {
  id: string;
  tenantId: string;
  membershipId: string;
  projectId: string;
  weekStart: string;
  totalHours: number;
  status: "draft" | "submitted" | "approved" | "rejected";
}

export interface AuditLogRecord {
  id: string;
  tenantId: string;
  actorUserId: string;
  actorMembershipId: string | null;
  impersonatedByPlatformUserId?: string | undefined;
  category: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

/**
 * Resolved request-scoped security context for a specific tenant operation.
 */
export interface ResolvedTenantContext {
  tenant: TenantRecord;
  user: UserRecord;
  membership: MembershipRecord;
  roleKeys: Set<RoleKey>;
  permissions: Set<PermissionCode>;
  directReportMembershipIds: Set<string>;
  managedProjectIds: Set<string>;
  assignedProjectIds: Set<string>;
  impersonatedByPlatformUserId?: string | undefined;
}

export class TenantIsolationError extends Error {
  public readonly statusCode = 403;
  public readonly code = "TENANT_ISOLATION_VIOLATION";
  constructor(message = "Cross-tenant access or missing tenant membership is prohibited.") {
    super(message);
    this.name = "TenantIsolationError";
  }
}

export class AuthorizationError extends Error {
  public readonly statusCode = 403;
  public readonly code = "INSUFFICIENT_PERMISSIONS";
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "AuthorizationError";
  }
}
