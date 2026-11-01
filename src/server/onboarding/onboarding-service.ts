import crypto from "node:crypto";
import {
  defaultEmailDeliveryProvider,
  EmailDeliveryError,
  resolveEmailDeliveryProvider,
  type EmailDeliveryProvider,
} from "../auth/email-provider";
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
  adminJobTitle?: string | undefined;
}

export interface SelfServiceRegistrationResult {
  tenant: TenantRecord;
  adminUser: UserRecord;
  adminMembership: MembershipRecord;
  verificationToken: string;
  verificationEmailDispatched?: boolean | undefined;
  emailMessageId?: string | undefined;
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

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface StoredVerificationTokenRecord {
  tokenHash: string;
  tenantId: string;
  userId: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number | undefined;
}

// Indexed strictly by SHA-256 tokenHash (never raw tokens)
const pendingVerificationTokens = new Map<string, StoredVerificationTokenRecord>();

export function hashVerificationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

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
 * creates the founding user and `business_admin` membership, generates a 256-bit
 * cryptographically random verification token, stores ONLY its SHA-256 hash,
 * and dispatches the verification link via the secure EmailDeliveryProvider.
 */
export function registerSelfServiceCompany(
  store: MultiTenantDataStore,
  input: SelfServiceRegistrationInput,
  options?: { now?: number; ttlMs?: number; skipAsyncDispatch?: boolean },
): SelfServiceRegistrationResult {
  const slug = normalizeTenantSlug(input.slug || input.companyName);
  if (slug.length < 2) {
    throw new Error("Company workspace slug must be at least 2 characters.");
  }
  const email = input.adminEmail.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("A valid administrator work email is required.");
  }

  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? EMAIL_VERIFICATION_TTL_MS;
  const entropy = crypto.randomBytes(6).toString("hex");
  const tenantId = `t_${slug}_${entropy}`;
  const userId = `u_${entropy}_admin`;
  const membershipId = `m_${entropy}_admin`;

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

  // Security Invariant: 256-bit cryptographically secure random token; store ONLY SHA-256 hash
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashVerificationToken(verificationToken);
  const expiresAt = now + ttlMs;

  pendingVerificationTokens.set(tokenHash, {
    tokenHash,
    tenantId: tenant.id,
    userId: adminUser.id,
    email,
    createdAt: now,
    expiresAt,
  });

  if (!options?.skipAsyncDispatch) {
    void defaultEmailDeliveryProvider.sendEmailVerificationEmail({
      to: email,
      companyName: tenant.name,
      tenantId: tenant.id,
      verificationToken,
      expiresAt,
    });
  }

  return {
    tenant,
    adminUser,
    adminMembership,
    verificationToken,
  };
}

/**
 * Async variant of `registerSelfServiceCompany` that awaits email delivery confirmation
 * from the configured `EmailDeliveryProvider` before reporting `verificationEmailDispatched: true`.
 * If email delivery fails, invalidates the pending verification token and throws `EmailDeliveryError`.
 */
export async function registerSelfServiceCompanyAsync(
  store: MultiTenantDataStore,
  input: SelfServiceRegistrationInput,
  options?: {
    now?: number | undefined;
    ttlMs?: number | undefined;
    env?: Record<string, string | undefined> | undefined;
    emailProvider?: EmailDeliveryProvider | undefined;
  },
): Promise<
  SelfServiceRegistrationResult & { verificationEmailDispatched: true; emailMessageId: string }
> {
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? EMAIL_VERIFICATION_TTL_MS;
  const expiresAt = now + ttlMs;

  const reg = registerSelfServiceCompany(store, input, {
    now,
    ttlMs,
    skipAsyncDispatch: true,
  });
  const tokenHash = hashVerificationToken(reg.verificationToken);
  const emailProvider = resolveEmailDeliveryProvider(options?.env, options?.emailProvider);

  try {
    const delivery = await emailProvider.sendEmailVerificationEmail({
      to: reg.adminUser.email,
      companyName: reg.tenant.name,
      tenantId: reg.tenant.id,
      verificationToken: reg.verificationToken,
      expiresAt,
    });

    if (!delivery || !delivery.accepted || !delivery.messageId?.trim()) {
      throw new EmailDeliveryError(
        "Email provider did not confirm verification email acceptance.",
        502,
      );
    }

    return {
      ...reg,
      verificationEmailDispatched: true,
      emailMessageId: delivery.messageId,
    };
  } catch (err) {
    pendingVerificationTokens.delete(tokenHash);
    throw err;
  }
}

/**
 * Step 2 (Self-Service): Verifies the founding administrator's email token
 * (checking SHA-256 hash, expiration, atomic single-use status, and strict tenant/user binding)
 * and transitions the tenant from `onboarding` to `active`.
 */
export function verifyCompanyAdminEmail(
  store: MultiTenantDataStore,
  verificationToken: string,
  nowOrOptions?:
    | number
    | {
        now?: number | undefined;
        expectedTenantId?: string | undefined;
        expectedEmail?: string | undefined;
      },
): ResolvedTenantContext {
  const now = typeof nowOrOptions === "number" ? nowOrOptions : (nowOrOptions?.now ?? Date.now());
  const expectedTenantId =
    typeof nowOrOptions === "object" ? nowOrOptions?.expectedTenantId : undefined;
  const expectedEmail = typeof nowOrOptions === "object" ? nowOrOptions?.expectedEmail : undefined;

  if (
    !verificationToken ||
    typeof verificationToken !== "string" ||
    verificationToken.startsWith("vtok_")
  ) {
    throw new Error("Invalid, expired, or already used email verification token.");
  }

  const tokenHash = hashVerificationToken(verificationToken.trim());
  const record = pendingVerificationTokens.get(tokenHash);
  if (!record) {
    throw new Error("Invalid, expired, or already used email verification token.");
  }
  if (record.usedAt !== undefined) {
    throw new Error("Invalid, expired, or already used email verification token.");
  }
  if (record.expiresAt <= now) {
    pendingVerificationTokens.delete(tokenHash);
    throw new Error("Invalid, expired, or already used email verification token.");
  }

  if (expectedTenantId && expectedTenantId !== record.tenantId) {
    throw new TenantIsolationError(
      `Verification token does not belong to requested tenant "${expectedTenantId}".`,
    );
  }
  if (expectedEmail && expectedEmail.trim().toLowerCase() !== record.email) {
    throw new AuthorizationError(
      "Verification token does not belong to the specified email address.",
    );
  }

  const ctx = store.resolveTenantContext(record.userId, record.tenantId);

  if (ctx.user.email.trim().toLowerCase() !== record.email) {
    throw new AuthorizationError(
      "Email verification rejected: target user email does not match verification token.",
    );
  }

  if (ctx.tenant.status !== "onboarding") {
    throw new Error(
      `Tenant workspace ${record.tenantId} is not in onboarding state or was already activated.`,
    );
  }

  // Mark single-use token as consumed immediately before activating tenant
  record.usedAt = now;
  pendingVerificationTokens.set(tokenHash, record);

  store.registerTenant({
    ...ctx.tenant,
    status: "active",
  });

  store.registerUser({
    ...ctx.user,
    emailVerifiedAt: new Date(now).toISOString(),
  });

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
