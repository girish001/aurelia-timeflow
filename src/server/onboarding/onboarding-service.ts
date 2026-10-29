import {
  AuthorizationError,
  TenantIsolationError,
  type MembershipRecord,
  type ResolvedTenantContext,
  type SystemRoleKey,
  type TenantDomainRecord,
  type TenantRecord,
  type UserRecord,
} from "../tenancy/tenant-context";
import type { MultiTenantDataStore } from "../repositories/tenant-scoped-store";

// ============================================================================
// 1. Self-Service Company Onboarding & Assisted Enterprise Provisioning
// ============================================================================

export interface SelfServiceRegistrationInput {
  companyName: string;
  slug: string;
  adminEmail: string;
  adminFullName: string;
  adminJobTitle?: string;
}

export interface SelfServiceRegistrationResult {
  tenant: TenantRecord;
  adminUser: UserRecord;
  adminMembership: MembershipRecord;
  verificationToken: string;
}

export interface CsvTeamRow {
  email: string;
  fullName: string;
  jobTitle: string;
  department?: string | undefined;
  roles: SystemRoleKey[];
  managerEmail?: string | undefined;
}

export interface CsvImportSummary {
  importedCount: number;
  reportingLinesLinked: number;
  memberships: MembershipRecord[];
}

export interface EnterpriseProvisioningInput {
  companyName: string;
  slug: string;
  primaryDomain: string;
  primaryAdminEmail: string;
  primaryAdminFullName: string;
}

export interface SupportImpersonationInput {
  tenantId: string;
  targetMembershipId: string;
  supportTicketId: string;
  reason: string;
}

const pendingVerificationTokens = new Map<
  string,
  { tenantId: string; userId: string; expiresAt: number }
>();

/**
 * Normalizes a company slug to lowercase alphanumeric + hyphens.
 */
export function normalizeTenantSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Step 1 (Self-Service): Registers a new company tenant in `onboarding` status,
 * creates the founding user and `business_admin` membership, and returns a verification token.
 */
export function registerSelfServiceCompany(
  store: MultiTenantDataStore,
  input: SelfServiceRegistrationInput,
): SelfServiceRegistrationResult {
  const slug = normalizeTenantSlug(input.slug || input.companyName);
  if (slug.length < 2) {
    throw new Error("Company workspace slug must be at least 2 characters.");
  }
  const email = input.adminEmail.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("A valid administrator work email is required.");
  }

  const tenantId = `t_${slug}_${Date.now().toString(36)}`;
  const userId = `u_${Date.now().toString(36)}_admin`;
  const membershipId = `m_${Date.now().toString(36)}_admin`;

  const tenant = store.registerTenant({
    id: tenantId,
    slug,
    name: input.companyName.trim(),
    status: "onboarding",
    onboardingMode: "self_service",
  });

  const adminUser = store.registerUser({
    id: userId,
    email,
    fullName: input.adminFullName.trim(),
    emailVerifiedAt: null,
    isPlatformAdmin: false,
    status: "active",
  });

  const adminMembership = store.createMembership({
    id: membershipId,
    tenantId: tenant.id,
    userId: adminUser.id,
    jobTitle: input.adminJobTitle?.trim() || "Business Administrator",
    status: "active",
  });

  store.assignRoleToMembership({
    id: `mr_${membershipId}_admin`,
    tenantId: tenant.id,
    membershipId: adminMembership.id,
    roleId: "sys_business_admin",
    roleKey: "business_admin",
  });

  const verificationToken = `vtok_${tenant.id}_${userId}`;
  pendingVerificationTokens.set(verificationToken, {
    tenantId: tenant.id,
    userId: adminUser.id,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  return {
    tenant,
    adminUser,
    adminMembership,
    verificationToken,
  };
}

/**
 * Step 2 (Self-Service): Verifies the founding administrator's email token
 * and transitions the tenant from `onboarding` to `active`.
 */
export function verifyCompanyAdminEmail(
  store: MultiTenantDataStore,
  verificationToken: string,
): ResolvedTenantContext {
  const record = pendingVerificationTokens.get(verificationToken);
  if (!record || record.expiresAt < Date.now()) {
    throw new Error("Invalid or expired email verification token.");
  }

  const ctx = store.resolveTenantContext(record.userId, record.tenantId);

  store.registerTenant({
    ...ctx.tenant,
    status: "active",
  });

  store.registerUser({
    ...ctx.user,
    emailVerifiedAt: new Date().toISOString(),
  });

  pendingVerificationTokens.delete(verificationToken);
  return store.resolveTenantContext(record.userId, record.tenantId);
}

/**
 * Parses CSV text (`email,fullName,jobTitle,department,roles,managerEmail`) into structured rows.
 * Multiple roles in the `roles` column are separated by `;` or `|` (e.g., `manager;employee`).
 */
export function parseTeamOnboardingCsv(csvText: string): CsvTeamRow[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstLine = lines[0] ?? "";
  const startIndex = firstLine.toLowerCase().startsWith("email,") ? 1 : 0;
  const rows: CsvTeamRow[] = [];

  const validRoles = new Set<SystemRoleKey>(["business_admin", "manager", "team_lead", "employee"]);

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",").map((c) => c.trim());
    const [email, fullName, jobTitle, department, rolesRaw, managerEmail] = cols;

    if (!email || !email.includes("@") || !fullName) {
      throw new Error(`Invalid CSV row at line ${i + 1}: email and fullName are required.`);
    }

    const parsedRoles = (rolesRaw || "employee")
      .split(/[;|]+/)
      .map((r) => r.trim().toLowerCase() as SystemRoleKey)
      .filter((r) => validRoles.has(r));

    rows.push({
      email: email.toLowerCase(),
      fullName,
      jobTitle: jobTitle || "Team Member",
      department: department || undefined,
      roles: parsedRoles.length > 0 ? parsedRoles : ["employee"],
      managerEmail: managerEmail ? managerEmail.toLowerCase() : undefined,
    });
  }

  return rows;
}

/**
 * Step 3 (Self-Service / Admin): Bulk-imports employees from validated CSV rows,
 * assigns additive multi-roles, and links HR reporting lines (`reporting_lines`) within the tenant.
 */
export function importTeamCsvIntoTenant(
  store: MultiTenantDataStore,
  ctx: ResolvedTenantContext,
  csvText: string,
): CsvImportSummary {
  if (!ctx.permissions.has("tenant:members:manage")) {
    throw new AuthorizationError(
      "Only administrators with tenant:members:manage permission can import team members.",
    );
  }

  const rows = parseTeamOnboardingCsv(csvText);
  const createdMemberships: MembershipRecord[] = [];
  const emailToMembership = new Map<string, MembershipRecord>();

  // Include the calling admin in email lookup so imported members can report to the founding admin
  emailToMembership.set(ctx.user.email.toLowerCase(), ctx.membership);

  rows.forEach((row, idx) => {
    const userId = `u_${ctx.tenant.id}_${idx + 1}`;
    const membershipId = `m_${ctx.tenant.id}_${idx + 1}`;

    store.registerUser({
      id: userId,
      email: row.email,
      fullName: row.fullName,
      emailVerifiedAt: null,
      isPlatformAdmin: false,
      status: "active",
    });

    const membership = store.createMembership({
      id: membershipId,
      tenantId: ctx.tenant.id,
      userId,
      departmentId: row.department,
      jobTitle: row.jobTitle,
      status: "active",
    });

    for (const roleKey of row.roles) {
      store.assignRoleToMembership({
        id: `mr_${membershipId}_${roleKey}`,
        tenantId: ctx.tenant.id,
        membershipId: membership.id,
        roleId: `sys_${roleKey}`,
        roleKey,
      });
    }

    createdMemberships.push(membership);
    emailToMembership.set(row.email, membership);
  });

  let reportingLinesLinked = 0;
  rows.forEach((row, idx) => {
    if (!row.managerEmail) return;
    const subordinate = emailToMembership.get(row.email);
    const manager = emailToMembership.get(row.managerEmail);
    if (subordinate && manager && subordinate.id !== manager.id) {
      store.addReportingLine({
        id: `rl_${ctx.tenant.id}_${idx + 1}`,
        tenantId: ctx.tenant.id,
        subordinateMembershipId: subordinate.id,
        managerMembershipId: manager.id,
        relationshipType: "primary_hr",
      });
      reportingLinesLinked++;
    }
  });

  return {
    importedCount: createdMemberships.length,
    reportingLinesLinked,
    memberships: createdMemberships,
  };
}

/**
 * Assisted Enterprise Provisioning: Allows an Aurelia Platform Admin (`isPlatformAdmin === true`)
 * to provision an enterprise tenant, register its corporate domain with `autoJoinPolicy: "never"`,
 * and create the initial enterprise administrator membership.
 */
export function provisionEnterpriseTenant(
  store: MultiTenantDataStore,
  platformAdmin: UserRecord,
  input: EnterpriseProvisioningInput,
): {
  tenant: TenantRecord;
  domain: TenantDomainRecord;
  adminUser: UserRecord;
  adminMembership: MembershipRecord;
} {
  if (!platformAdmin.isPlatformAdmin || platformAdmin.status !== "active") {
    throw new AuthorizationError(
      "Only active Aurelia Platform Administrators can provision assisted enterprise tenants.",
    );
  }

  const slug = normalizeTenantSlug(input.slug || input.companyName);
  const tenantId = `t_ent_${slug}`;
  const adminUserId = `u_ent_${slug}_admin`;
  const adminMembershipId = `m_ent_${slug}_admin`;

  const tenant = store.registerTenant({
    id: tenantId,
    slug,
    name: input.companyName.trim(),
    status: "active",
    onboardingMode: "assisted_enterprise",
  });

  // Security invariant: corporate domain registration defaults to autoJoinPolicy: "never"
  const domain = store.registerTenantDomain({
    id: `dom_${tenantId}`,
    tenantId: tenant.id,
    domain: input.primaryDomain.trim().toLowerCase(),
    verifiedAt: new Date().toISOString(),
    autoJoinPolicy: "never",
  });

  const adminUser = store.registerUser({
    id: adminUserId,
    email: input.primaryAdminEmail.trim().toLowerCase(),
    fullName: input.primaryAdminFullName.trim(),
    emailVerifiedAt: new Date().toISOString(),
    isPlatformAdmin: false,
    status: "active",
  });

  const adminMembership = store.createMembership({
    id: adminMembershipId,
    tenantId: tenant.id,
    userId: adminUser.id,
    jobTitle: "Enterprise IT Administrator",
    status: "active",
  });

  store.assignRoleToMembership({
    id: `mr_${adminMembershipId}_admin`,
    tenantId: tenant.id,
    membershipId: adminMembership.id,
    roleId: "sys_business_admin",
    roleKey: "business_admin",
  });

  return { tenant, domain, adminUser, adminMembership };
}

/**
 * Assisted Support Impersonation: Allows an Aurelia Platform Admin with a valid support ticket
 * to resolve a customer tenant context with `impersonatedByPlatformUserId` explicitly stamped.
 */
export function startSupportImpersonationSession(
  store: MultiTenantDataStore,
  platformAdmin: UserRecord,
  input: SupportImpersonationInput,
): ResolvedTenantContext {
  if (!platformAdmin.isPlatformAdmin || platformAdmin.status !== "active") {
    throw new AuthorizationError(
      "Only active Aurelia Platform Administrators can initiate support impersonation.",
    );
  }
  if (!input.supportTicketId.trim() || !input.reason.trim()) {
    throw new Error(
      "Support ticket ID and reason are mandatory for customer support impersonation.",
    );
  }

  // Locate the target membership inside the specified tenant
  const targetMember = store
    .listUserTenants(platformAdmin.id)
    .find((t) => t.tenant.id === input.tenantId);
  void targetMember;

  // Verify the target membership belongs to the requested tenant
  let resolvedBase: ResolvedTenantContext | null = null;
  // Resolve via the target membership's user within the tenant
  const allMembers = (store as unknown as { memberships: Map<string, MembershipRecord> })
    .memberships;
  const membership = allMembers.get(input.targetMembershipId);
  if (!membership || membership.tenantId !== input.tenantId) {
    throw new TenantIsolationError(
      `Target membership ${input.targetMembershipId} does not belong to tenant ${input.tenantId}.`,
    );
  }

  resolvedBase = store.resolveTenantContext(membership.userId, input.tenantId);

  return {
    ...resolvedBase,
    impersonatedByPlatformUserId: platformAdmin.id,
  };
}
