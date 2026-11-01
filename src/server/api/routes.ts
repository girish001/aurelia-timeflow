import { eq } from "drizzle-orm";
import {
  assertValidTenantExecutionContext,
  checkAwsDatabaseHealth,
  getAwsPostgresDb,
  getAwsPostgresPool,
  isAwsPostgresConfigured,
  type AureliaAwsDb,
  type QueryableTransactionPool,
} from "../db/aws-postgres";
import * as schema from "../db/schema";
import {
  importTeamCsvIntoTenant,
  provisionEnterpriseTenant,
  registerSelfServiceCompany,
  startSupportImpersonationSession,
  verifyCompanyAdminEmail,
} from "../onboarding/onboarding-service";
import {
  approveTimesheetInDb,
  getProjectByIdFromDb,
  getTeamMemberProfileFromDb,
  listAccessibleTeamMembersFromDb,
  listProjectsFromDb,
  listTenantAuditLogsFromDb,
  listUserTenantsFromDb,
  recordAuditLogToDb,
  registerCompanyInDb,
  resolveTenantContextFromDb,
  updateProjectBudgetInDb,
  verifyCompanyAdminEmailInDb,
} from "../repositories/postgres-tenant-store";
import { MultiTenantDataStore } from "../repositories/tenant-scoped-store";
import { defaultAuthService } from "../auth/auth-service";
import { defaultSessionManager, type UserSession } from "../auth/session-manager";
import { defaultSsoService } from "../auth/sso-service";
import {
  AuthorizationError,
  TenantIsolationError,
  type PermissionCode,
  type UserRecord,
} from "../tenancy/tenant-context";

/**
 * API Route Blueprint & Executable Dispatcher for Aurelia TimeFlow SaaS.
 * Every `/api/v1/tenants/:tenantId/*` endpoint enforces:
 * 1. Authenticated server-side session (`aurelia_session` cookie or `Authorization: Bearer <sessionToken>`)
 * 2. Active tenant membership resolved from PostgreSQL (`resolveTenantContextFromDb`)
 * 3. Rejection of untrusted body `tenantId` mismatches (`assertValidTenantExecutionContext`)
 * 4. Endpoint permission / scope guard (`requiredPermission` + resource-level ABAC)
 */
export interface ApiRouteContract {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  scope: "public" | "authenticated" | "tenant_scoped" | "platform_admin";
  requiredPermission?: PermissionCode | undefined;
  description: string;
}

export const API_ROUTE_CONTRACTS: ApiRouteContract[] = [
  // 1. Authentication & Multi-Provider SSO Endpoints
  {
    method: "POST",
    path: "/api/v1/auth/login",
    scope: "public",
    description:
      "Email/password authentication returning user session, HttpOnly cookie, and available tenant memberships.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/logout",
    scope: "public",
    description: "Invalidates active session token and clears the HttpOnly session cookie.",
  },
  {
    method: "GET",
    path: "/api/v1/auth/session",
    scope: "authenticated",
    description: "Returns currently authenticated session user, email, and session expiry.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/session/rotate",
    scope: "authenticated",
    description: "Rotates active session token for enhanced replay protection.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/password-reset/request",
    scope: "public",
    description: "Dispatches a time-boxed password reset token for the given user email.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/password-reset/confirm",
    scope: "public",
    description: "Validates reset token, updates password hash, and revokes all active sessions.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/account/status",
    scope: "tenant_scoped",
    requiredPermission: "tenant:members:manage",
    description:
      "Activates, suspends, or deactivates a user account, terminating all active sessions on deactivation.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/users/:targetUserId/status",
    scope: "tenant_scoped",
    requiredPermission: "tenant:members:manage",
    description:
      "Activates, suspends, or deactivates a user account in tenant workspace, terminating all active sessions on deactivation.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/sso/discover",
    scope: "public",
    description:
      "Discovers tenant SSO connection (Entra ID OIDC, Google Workspace OIDC, or SAML 2.0) without granting membership.",
  },
  {
    method: "GET",
    path: "/api/v1/auth/oidc/:connectionId/callback",
    scope: "public",
    description: "OIDC authorization code callback for Microsoft Entra ID and Google Workspace.",
  },
  {
    method: "POST",
    path: "/api/v1/auth/saml/:connectionId/acs",
    scope: "public",
    description: "SAML 2.0 Assertion Consumer Service (ACS) endpoint for enterprise IdPs.",
  },
  {
    method: "GET",
    path: "/api/v1/auth/tenants",
    scope: "authenticated",
    description:
      "Lists all active company tenants where the authenticated user holds an active membership.",
  },

  // 2. Self-Service Company Onboarding Endpoints
  {
    method: "POST",
    path: "/api/v1/onboarding/self-service/register-company",
    scope: "public",
    description:
      "Provisions a new tenant in onboarding state, creates initial user and Business Admin membership, and sends verification email.",
  },
  {
    method: "POST",
    path: "/api/v1/onboarding/self-service/verify-email",
    scope: "public",
    description:
      "Verifies administrator email and activates the self-service tenant trial workspace.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/invitations/bulk-csv",
    scope: "tenant_scoped",
    requiredPermission: "tenant:members:manage",
    description:
      "Imports employees, departments, and reporting lines via validated CSV and dispatches invitations.",
  },

  // 3. Aurelia Platform Administration (Assisted Enterprise Onboarding)
  {
    method: "POST",
    path: "/api/v1/platform-admin/tenants",
    scope: "platform_admin",
    description:
      "Aurelia internal admin provisions an enterprise tenant, subscription seat limit, and initial admin invite.",
  },
  {
    method: "POST",
    path: "/api/v1/platform-admin/tenants/:tenantId/sso-connections",
    scope: "platform_admin",
    description:
      "Configures and tests enterprise OIDC / SAML 2.0 identity connection for a customer tenant.",
  },
  {
    method: "POST",
    path: "/api/v1/platform-admin/tenants/:tenantId/support-impersonation",
    scope: "platform_admin",
    description:
      "Grants time-boxed, ticket-referenced customer support access with mandatory `impersonatedByPlatformUserId` audit logging.",
  },

  // 4. Tenant-Scoped Operational Endpoints
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/projects",
    scope: "tenant_scoped",
    requiredPermission: "project:read:assigned",
    description: "Lists tenant projects filtered by caller's role and project memberships.",
  },
  {
    method: "PATCH",
    path: "/api/v1/tenants/:tenantId/projects/:projectId",
    scope: "tenant_scoped",
    requiredPermission: "project:write:assigned",
    description:
      "Updates project settings/budget; enforces project manager or business admin ownership.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/team",
    scope: "tenant_scoped",
    description: "Lists tenant members scoped to caller's HR reporting hierarchy or admin scope.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/timesheets/:timesheetId/approve",
    scope: "tenant_scoped",
    requiredPermission: "timesheet:approve:team",
    description:
      "Approves a submitted timesheet; validates HR reporting line or project-level approver permission.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/audit-logs",
    scope: "tenant_scoped",
    requiredPermission: "audit:read:tenant",
    description: "Returns immutable server-recorded tenant audit trail events.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/approvals",
    scope: "tenant_scoped",
    requiredPermission: "timesheet:approve:team",
    description:
      "Lists pending and decided timesheet and leave approval records scoped to the caller's tenant and reporting/project authority.",
  },
  {
    method: "GET",
    path: "/api/v1/health/db",
    scope: "public",
    description:
      "Returns credential-redacted PostgreSQL connectivity, SSL enforcement, and latency health status.",
  },
];

export interface MatchedApiRoute {
  contract: ApiRouteContract;
  params: Record<string, string>;
}

declare global {
  var _aureliaDefaultApiStore: MultiTenantDataStore | undefined;
}

export function getDefaultApiStore(): MultiTenantDataStore {
  if (!globalThis._aureliaDefaultApiStore) {
    globalThis._aureliaDefaultApiStore = new MultiTenantDataStore();
  }
  return globalThis._aureliaDefaultApiStore;
}

/**
 * Matches an HTTP method and URL pathname against the registered `API_ROUTE_CONTRACTS`
 * and extracts `:param` path segments (`:tenantId`, `:projectId`, `:timesheetId`, `:connectionId`).
 */
export function matchApiRouteContract(method: string, pathname: string): MatchedApiRoute | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const reqSegments = normalizedPath.split("/").filter(Boolean);

  for (const contract of API_ROUTE_CONTRACTS) {
    if (contract.method !== normalizedMethod) continue;
    const contractSegments = contract.path.split("/").filter(Boolean);
    if (contractSegments.length !== reqSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < contractSegments.length; i++) {
      const cSeg = contractSegments[i] ?? "";
      const rSeg = reqSegments[i] ?? "";
      if (cSeg.startsWith(":")) {
        params[cSeg.slice(1)] = decodeURIComponent(rSeg);
      } else if (cSeg !== rSeg) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { contract, params };
    }
  }

  return null;
}

function jsonResponse(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (extraHeaders) {
    if (extraHeaders instanceof Headers) {
      extraHeaders.forEach((v, k) => headers.set(k, v));
    } else if (Array.isArray(extraHeaders)) {
      extraHeaders.forEach(([k, v]) => headers.append(k, v));
    } else {
      Object.entries(extraHeaders).forEach(([k, v]) => {
        if (v) headers.set(k, v);
      });
    }
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

export interface AuthenticatedIdentity {
  userId: string;
  sessionToken: string;
  session: UserSession;
  isSession: true;
}

/**
 * Extracts and validates the caller's authenticated session identity.
 *
 * Security Invariants:
 * - NEVER trusts `x-aurelia-user-id` headers.
 * - NEVER trusts `Authorization: Bearer user:<id>` tokens.
 * - Requires a valid, non-expired, non-revoked session token verified against PostgreSQL
 *   (when `db` is provided) or `defaultSessionManager`.
 */
export async function extractAuthenticatedIdentity(
  request: Request,
  options?: { db?: AureliaAwsDb },
): Promise<AuthenticatedIdentity | null> {
  const token = defaultSessionManager.extractTokenFromRequest(request);
  if (!token) {
    return null;
  }

  const session = options?.db
    ? await defaultSessionManager.validateSessionInDb(token, { db: options.db })
    : defaultSessionManager.validateSession(token);

  if (!session) {
    return null;
  }

  return {
    userId: session.userId,
    sessionToken: token,
    session,
    isSession: true,
  };
}

async function resolveVerifiedServerUser(
  userId: string,
  options: { db?: AureliaAwsDb; store: MultiTenantDataStore },
): Promise<UserRecord | null> {
  if (options.db) {
    const rows = await options.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      emailVerifiedAt: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null,
      isPlatformAdmin: row.isPlatformAdmin,
      status: row.status as UserRecord["status"],
    };
  }
  return options.store.getUser(userId) ?? null;
}

async function safeReadJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Production API request handler registered in `src/server.ts`.
 * Returns `null` for non-`/api/v1/*` paths so TanStack Start SSR handles page routes.
 */
export async function handleApiRequest(
  request: Request,
  options?: {
    store?: MultiTenantDataStore;
    env?: Record<string, string | undefined>;
    pool?: QueryableTransactionPool;
    db?: AureliaAwsDb;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/")) {
    return null;
  }

  const matched = matchApiRouteContract(request.method, url.pathname);
  if (!matched) {
    return jsonResponse(
      {
        error: "NOT_FOUND",
        message: `No registered API route for ${request.method} ${url.pathname}`,
      },
      404,
    );
  }

  const { contract, params } = matched;
  const env = options?.env;
  let targetPool = options?.pool;
  let targetDb = options?.db;
  if (!targetPool && !options?.store && isAwsPostgresConfigured(env)) {
    try {
      targetPool = getAwsPostgresPool(env);
      targetDb = options?.db ?? getAwsPostgresDb(env);
    } catch {
      // Caught VPC network boundary check or configuration validation; handled safely per route
    }
  }
  const useDatabase = Boolean(targetPool || targetDb);
  const store = options?.store ?? getDefaultApiStore();

  try {
    // 1. Health Check Endpoint (Public summary; detailed diagnostics restricted to Platform Admins)
    if (contract.path === "/api/v1/health/db") {
      const health = await checkAwsDatabaseHealth({ env: options?.env });
      const status = health.status === "unhealthy" ? 503 : 200;

      const callerIdentity = await extractAuthenticatedIdentity(request, { db: targetDb });
      let isAuthorizedPlatformAdmin = false;
      if (callerIdentity) {
        const verifiedUser = await resolveVerifiedServerUser(callerIdentity.userId, {
          db: targetDb,
          store,
        });
        if (verifiedUser && verifiedUser.status === "active" && verifiedUser.isPlatformAdmin) {
          isAuthorizedPlatformAdmin = true;
        }
      }

      if (isAuthorizedPlatformAdmin) {
        return jsonResponse(health, status);
      }

      // Redacted public health response: never expose hostnames, database names, regions, or network hints
      return jsonResponse(
        {
          status: health.status,
          provider: health.provider,
          checkedAt: health.checkedAt,
        },
        status,
      );
    }

    // 2. Public Self-Service Onboarding & Auth Endpoints
    if (contract.path === "/api/v1/onboarding/self-service/register-company") {
      const body = await safeReadJsonBody(request);
      if (useDatabase && (targetPool || targetDb)) {
        const result = await registerCompanyInDb(
          { pool: targetPool, db: targetDb, env },
          {
            companyName: String(body["companyName"] ?? ""),
            slug: String(body["slug"] ?? ""),
            adminEmail: String(body["adminEmail"] ?? ""),
            adminFullName: String(body["adminFullName"] ?? ""),
            adminJobTitle: body["adminJobTitle"] ? String(body["adminJobTitle"]) : undefined,
          },
        );
        return jsonResponse(
          {
            tenant: result.tenant,
            adminUser: result.adminUser,
            adminMembership: result.adminMembership,
            verificationEmailDispatched: true,
          },
          201,
        );
      }
      const result = registerSelfServiceCompany(store, {
        companyName: String(body["companyName"] ?? ""),
        slug: String(body["slug"] ?? ""),
        adminEmail: String(body["adminEmail"] ?? ""),
        adminFullName: String(body["adminFullName"] ?? ""),
        adminJobTitle: body["adminJobTitle"] ? String(body["adminJobTitle"]) : undefined,
      });
      return jsonResponse(
        {
          tenant: result.tenant,
          adminUser: result.adminUser,
          adminMembership: result.adminMembership,
          verificationEmailDispatched: true,
        },
        201,
      );
    }

    if (contract.path === "/api/v1/onboarding/self-service/verify-email") {
      const body = await safeReadJsonBody(request);
      const token = String(body["verificationToken"] ?? "");
      if (useDatabase && (targetPool || targetDb)) {
        const result = await verifyCompanyAdminEmailInDb(
          { pool: targetPool, db: targetDb, env },
          token,
        );
        return jsonResponse(result);
      }
      const ctx = verifyCompanyAdminEmail(store, token);
      return jsonResponse({
        tenant: ctx.tenant,
        user: ctx.user,
        membership: ctx.membership,
      });
    }

    if (contract.path === "/api/v1/auth/login") {
      const body = await safeReadJsonBody(request);
      const email = String(body["email"] ?? "").trim();
      const password = typeof body["password"] === "string" ? body["password"] : undefined;

      if (!email || !password) {
        return jsonResponse(
          { error: "BAD_REQUEST", message: "email and password are required." },
          400,
        );
      }

      const ipAddress =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const isSecureRequest = url.protocol === "https:";

      const loginResult = await defaultAuthService.login(
        {
          email,
          password,
          ipAddress,
          userAgent,
        },
        { db: targetDb, store, isSecureRequest },
      );

      return jsonResponse(
        {
          user: loginResult.user,
          session: loginResult.session,
          sessionToken: loginResult.sessionToken,
          tenants: loginResult.tenants,
        },
        200,
        { "set-cookie": loginResult.setCookieHeader },
      );
    }

    if (contract.path === "/api/v1/auth/logout") {
      const token = defaultSessionManager.extractTokenFromRequest(request);
      const isSecure = url.protocol === "https:";
      const logoutResult = await defaultAuthService.logout(token || "", isSecure, {
        db: targetDb,
      });
      return jsonResponse({ success: true, message: "Logged out successfully." }, 200, {
        "set-cookie": logoutResult.clearCookieHeader,
      });
    }

    if (contract.path === "/api/v1/auth/password-reset/request") {
      const body = await safeReadJsonBody(request);
      const email = String(body["email"] ?? "").trim();
      if (!email || !email.includes("@")) {
        return jsonResponse(
          { error: "BAD_REQUEST", message: "A valid email address is required." },
          400,
        );
      }
      await defaultAuthService.requestPasswordReset(email, { db: targetDb, store });
      // Security Invariant: NEVER return password reset tokens in HTTP API responses.
      return jsonResponse({
        success: true,
        message: "If an account exists with that email, a password reset link has been dispatched.",
      });
    }

    if (contract.path === "/api/v1/auth/password-reset/confirm") {
      const body = await safeReadJsonBody(request);
      const token = String(body["token"] ?? "").trim();
      const newPassword = String(body["newPassword"] ?? "");
      if (!token || !newPassword) {
        return jsonResponse(
          { error: "BAD_REQUEST", message: "token and newPassword are required." },
          400,
        );
      }
      const result = await defaultAuthService.confirmPasswordReset(token, newPassword, {
        db: targetDb,
        store,
      });
      return jsonResponse({
        success: true,
        message: "Password has been reset successfully. All active sessions have been revoked.",
        userId: result.userId,
      });
    }

    if (contract.path === "/api/v1/auth/sso/discover") {
      const body = await safeReadJsonBody(request);
      const email = String(body["email"] ?? "")
        .trim()
        .toLowerCase();
      const domain = email.includes("@") ? email.split("@")[1] : String(body["domain"] ?? "");
      const provider = domain?.includes("microsoft") ? "entra_oidc" : "google_oidc";
      const tenantId = String(body["tenantId"] ?? "t_discovery");

      const oidcRequest =
        provider === "entra_oidc"
          ? defaultSsoService.prepareEntraOidcRequest({
              provider: "entra_oidc",
              clientId: "aurelia-entra-client-id",
              issuerUrl: "https://login.microsoftonline.com/common/v2.0",
              authorizationEndpoint:
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
              tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
              redirectUri: `${url.origin}/api/v1/auth/oidc/entra/callback`,
              tenantId,
            })
          : defaultSsoService.prepareGoogleOidcRequest({
              provider: "google_oidc",
              clientId: "aurelia-google-client-id",
              issuerUrl: "https://accounts.google.com",
              authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
              tokenEndpoint: "https://oauth2.googleapis.com/token",
              redirectUri: `${url.origin}/api/v1/auth/oidc/google/callback`,
              tenantId,
            });

      return jsonResponse({
        provider,
        domain,
        authorizationUrl: oidcRequest.authorizationUrl,
        state: oidcRequest.state,
      });
    }

    if (contract.path === "/api/v1/auth/oidc/:connectionId/callback") {
      const code = url.searchParams.get("code") ?? undefined;
      const state = url.searchParams.get("state") ?? undefined;
      const error = url.searchParams.get("error") ?? undefined;
      const errorDescription = url.searchParams.get("error_description") ?? undefined;

      const validation = defaultSsoService.validateOidcCallback({
        code,
        state,
        error,
        errorDescription,
      });

      if (!validation.valid) {
        return jsonResponse({ error: "OIDC_VALIDATION_FAILED", message: validation.error }, 400);
      }

      // Security invariant: Real token exchange required; do not simulate fake authentication
      return jsonResponse(
        {
          status: "oidc_callback_validated",
          tenantId: validation.tenantId,
          codeReceived: true,
          message:
            "OIDC state and authorization code validated. Production IdP token exchange required.",
        },
        200,
      );
    }

    if (contract.path === "/api/v1/auth/saml/:connectionId/acs") {
      const body = await safeReadJsonBody(request);
      const samlResponse = String(body["SAMLResponse"] ?? "");
      const relayState = String(body["RelayState"] ?? "");

      const validation = defaultSsoService.validateSamlResponse({
        samlResponse,
        relayState,
      });

      if (!validation.valid) {
        return jsonResponse({ error: "SAML_VALIDATION_FAILED", message: validation.error }, 400);
      }

      return jsonResponse(
        {
          status: "saml_acs_validated",
          tenantId: validation.tenantId,
          message: "SAML assertion and RelayState signature validated.",
        },
        200,
      );
    }

    // 3. Authenticated Endpoints Requiring Valid Server-Side Session
    const identity = await extractAuthenticatedIdentity(request, { db: targetDb });
    if (!identity) {
      return jsonResponse(
        {
          error: "UNAUTHENTICATED",
          message: "Missing, invalid, or expired session token.",
        },
        401,
      );
    }
    const userId = identity.userId;

    if (contract.path === "/api/v1/auth/session") {
      return jsonResponse({ authenticated: true, session: identity.session });
    }

    if (contract.path === "/api/v1/auth/session/rotate") {
      const isSecure = url.protocol === "https:";
      const rotated = await defaultAuthService.rotateSession(identity.sessionToken, isSecure, {
        db: targetDb,
      });
      if (!rotated) {
        return jsonResponse(
          { error: "UNAUTHENTICATED", message: "Session expired or invalid." },
          401,
        );
      }
      return jsonResponse({ session: rotated.session, sessionToken: rotated.sessionToken }, 200, {
        "set-cookie": rotated.setCookieHeader,
      });
    }

    if (contract.path === "/api/v1/auth/tenants") {
      if (useDatabase && targetDb) {
        const tenants = await listUserTenantsFromDb(targetDb, userId);
        return jsonResponse({ tenants });
      }
      return jsonResponse({ tenants: store.listUserTenants(userId) });
    }

    // 4. Platform Admin Endpoints (Verified strictly from server-side user record; NEVER from headers)
    if (contract.scope === "platform_admin") {
      const body = await safeReadJsonBody(request);
      const platformAdminUser = await resolveVerifiedServerUser(userId, {
        db: targetDb,
        store,
      });

      if (
        !platformAdminUser ||
        platformAdminUser.status !== "active" ||
        platformAdminUser.isPlatformAdmin !== true
      ) {
        throw new AuthorizationError(
          "Only active Aurelia Platform Administrators verified via server-side records are authorized.",
        );
      }

      if (contract.path === "/api/v1/platform-admin/tenants") {
        const result = provisionEnterpriseTenant(store, platformAdminUser, {
          companyName: String(body["companyName"] ?? ""),
          slug: String(body["slug"] ?? ""),
          primaryDomain: String(body["primaryDomain"] ?? ""),
          primaryAdminEmail: String(body["primaryAdminEmail"] ?? ""),
          primaryAdminFullName: String(body["primaryAdminFullName"] ?? ""),
        });
        return jsonResponse(result, 201);
      }

      if (contract.path === "/api/v1/platform-admin/tenants/:tenantId/support-impersonation") {
        const ctx = startSupportImpersonationSession(store, platformAdminUser, {
          tenantId: String(params["tenantId"] ?? ""),
          targetMembershipId: String(body["targetMembershipId"] ?? ""),
          supportTicketId: String(body["supportTicketId"] ?? ""),
          reason: String(body["reason"] ?? ""),
        });
        return jsonResponse({
          tenantId: ctx.tenant.id,
          impersonatedMembershipId: ctx.membership.id,
          impersonatedByPlatformUserId: ctx.impersonatedByPlatformUserId,
        });
      }

      if (contract.path === "/api/v1/platform-admin/tenants/:tenantId/sso-connections") {
        return jsonResponse(
          {
            tenantId: params["tenantId"],
            provider: body["provider"] ?? "entra_oidc",
            status: "draft",
          },
          201,
        );
      }
    }

    // 5. Tenant-Scoped Endpoints
    if (contract.scope === "tenant_scoped") {
      const body = request.method === "GET" ? {} : await safeReadJsonBody(request);
      const claimedBodyTenantId =
        typeof body["tenantId"] === "string" ? body["tenantId"] : undefined;
      const pathTenantId = params["tenantId"] || claimedBodyTenantId || "";

      const ctx = await defaultAuthService.resolveAuthenticatedTenantContext(
        identity.sessionToken,
        pathTenantId,
        { db: targetDb, store },
      );

      // Reject any mismatch between URL :tenantId, authenticated membership, and body tenantId
      assertValidTenantExecutionContext(ctx, claimedBodyTenantId);

      if (contract.requiredPermission && !ctx.permissions.has(contract.requiredPermission)) {
        throw new AuthorizationError(
          `Missing required permission "${contract.requiredPermission}" in tenant "${ctx.tenant.id}".`,
        );
      }

      if (
        contract.path === "/api/v1/auth/account/status" ||
        contract.path === "/api/v1/tenants/:tenantId/users/:targetUserId/status"
      ) {
        const targetUserId = String(
          params["targetUserId"] ?? body["targetUserId"] ?? body["userId"] ?? "",
        );
        const newStatus = String(body["status"] ?? "active") as
          "active" | "suspended" | "deactivated";
        if (newStatus !== "active" && newStatus !== "suspended" && newStatus !== "deactivated") {
          return jsonResponse({ error: "BAD_REQUEST", message: "Invalid status value." }, 400);
        }
        await defaultAuthService.updateAccountStatus(targetUserId, newStatus, {
          db: targetDb,
          store,
        });
        return jsonResponse({ success: true, targetUserId, status: newStatus });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/invitations/bulk-csv") {
        const summary = importTeamCsvIntoTenant(store, ctx, String(body["csvText"] ?? ""));
        return jsonResponse(summary, 201);
      }

      if (contract.path === "/api/v1/tenants/:tenantId/projects") {
        if (useDatabase) {
          const page = url.searchParams.get("page")
            ? Number(url.searchParams.get("page"))
            : undefined;
          const limit = url.searchParams.get("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined;
          const statusParam = url.searchParams.get("status");
          const status =
            statusParam === "active" ||
            statusParam === "on-hold" ||
            statusParam === "completed" ||
            statusParam === "all"
              ? statusParam
              : undefined;
          const search = url.searchParams.get("search") ?? undefined;
          const sortByParam = url.searchParams.get("sortBy");
          const sortBy =
            sortByParam === "name" || sortByParam === "createdAt" || sortByParam === "budgetHours"
              ? sortByParam
              : undefined;
          const sortOrderParam = url.searchParams.get("sortOrder");
          const sortOrder =
            sortOrderParam === "asc" || sortOrderParam === "desc" ? sortOrderParam : undefined;

          const result = await listProjectsFromDb(
            ctx,
            { page, limit, status, search, sortBy, sortOrder },
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ projects: result.data, pagination: result.pagination });
        }
        return jsonResponse({ projects: store.listVisibleProjects(ctx) });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/projects/:projectId") {
        if (useDatabase) {
          const updated = await updateProjectBudgetInDb(
            ctx,
            String(params["projectId"] ?? ""),
            Number(body["budgetHours"] ?? 0),
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ project: updated });
        }
        const updated = store.updateProjectBudget(
          ctx,
          String(params["projectId"] ?? ""),
          Number(body["budgetHours"] ?? 0),
        );
        return jsonResponse({ project: updated });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/team") {
        if (useDatabase) {
          const page = url.searchParams.get("page")
            ? Number(url.searchParams.get("page"))
            : undefined;
          const limit = url.searchParams.get("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined;
          const departmentId = url.searchParams.get("departmentId") ?? undefined;
          const search = url.searchParams.get("search") ?? undefined;
          const teamStatusParam = url.searchParams.get("status");
          const status =
            teamStatusParam === "active" ||
            teamStatusParam === "invited" ||
            teamStatusParam === "inactive" ||
            teamStatusParam === "all"
              ? teamStatusParam
              : undefined;

          const result = await listAccessibleTeamMembersFromDb(
            ctx,
            { page, limit, departmentId, search, status },
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ members: result.data, pagination: result.pagination });
        }
        return jsonResponse({ members: store.listAccessibleTeamMembers(ctx) });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/timesheets/:timesheetId/approve") {
        if (useDatabase) {
          const comment = body["comment"] ? String(body["comment"]) : undefined;
          const approved = await approveTimesheetInDb(
            ctx,
            String(params["timesheetId"] ?? ""),
            comment,
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ timesheet: approved });
        }
        const approved = store.approveTimesheet(ctx, String(params["timesheetId"] ?? ""));
        return jsonResponse({ timesheet: approved });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/audit-logs") {
        if (useDatabase) {
          const page = url.searchParams.get("page")
            ? Number(url.searchParams.get("page"))
            : undefined;
          const limit = url.searchParams.get("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined;
          const category = url.searchParams.get("category") ?? undefined;
          const search = url.searchParams.get("search") ?? undefined;
          const startDate = url.searchParams.get("startDate") ?? undefined;
          const endDate = url.searchParams.get("endDate") ?? undefined;

          const result = await listTenantAuditLogsFromDb(
            ctx,
            { page, limit, category, search, startDate, endDate },
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ auditLogs: result.data, pagination: result.pagination });
        }
        return jsonResponse({ auditLogs: store.listTenantAuditLogs(ctx) });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/approvals") {
        return jsonResponse({ tenantId: ctx.tenant.id, approvals: [] });
      }
    }

    return jsonResponse({ error: "NOT_IMPLEMENTED" }, 501);
  } catch (error) {
    if (error instanceof TenantIsolationError || error instanceof AuthorizationError) {
      return jsonResponse(
        {
          error: error.code,
          message: error.message,
        },
        error.statusCode,
      );
    }
    const message = error instanceof Error ? error.message : "Bad request";
    return jsonResponse({ error: "BAD_REQUEST", message }, 400);
  }
}
