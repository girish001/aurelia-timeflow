import { eq } from "drizzle-orm";
import {
  assertValidTenantExecutionContext,
  checkAwsDatabaseHealth,
  getAwsPostgresDb,
  getAwsPostgresPool,
  isAwsPostgresConfigured,
  redactPostgresCredentials,
  type AureliaAwsDb,
  type QueryableTransactionPool,
} from "../db/aws-postgres";
import * as schema from "../db/schema";
import {
  importTeamCsvIntoTenant,
  provisionEnterpriseTenant,
  registerSelfServiceCompanyAsync,
  startSupportImpersonationSession,
  verifyCompanyAdminEmail,
} from "../onboarding/onboarding-service";
import {
  approveTimesheetInDb,
  createClientInDb,
  createMemberInvitationInDb,
  createProjectInDb,
  getTenantReportsFromDb,
  getTenantSettingsFromDb,
  getTimesheetForWeekFromDb,
  listAccessibleTeamMembersFromDb,
  listApprovalsFromDb,
  listClientsFromDb,
  listProjectsFromDb,
  listTenantAuditLogsFromDb,
  listUserTenantsFromDb,
  registerCompanyInDb,
  rejectTimesheetInDb,
  submitTimesheetInDb,
  updateClientInDb,
  updateProjectBudgetInDb,
  updateTenantSettingsInDb,
  upsertTimesheetInDb,
  verifyCompanyAdminEmailInDb,
  type TimesheetEntryInput,
} from "../repositories/postgres-tenant-store";
import { MultiTenantDataStore } from "../repositories/tenant-scoped-store";
import {
  DatabaseUnavailableError,
  defaultAuthService,
  extractSafeDatabaseErrorMessage,
  isProductionEnvironment,
} from "../auth/auth-service";
import {
  EmailDeliveryError,
  getDevelopmentEmailOutbox,
  isProductionEmailEnvironment,
  redactSensitiveEmailTokens,
  type EmailDeliveryProvider,
} from "../auth/email-provider";
import { defaultSessionManager, type UserSession } from "../auth/session-manager";
import { defaultSsoService, type OidcProviderConfig } from "../auth/sso-service";
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
 * 5. Fail-closed production authentication: in production (`APP_ENV=production` or `NODE_ENV=production`),
 *    requests NEVER fall back to in-memory sessions, user records, or tenant memberships.
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
    path: "/api/v1/tenants/:tenantId/clients",
    scope: "tenant_scoped",
    requiredPermission: "client:read:all",
    description: "Lists client corporate profiles for the tenant workspace.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/clients",
    scope: "tenant_scoped",
    requiredPermission: "client:write:all",
    description: "Creates a new client corporate profile for the tenant.",
  },
  {
    method: "PATCH",
    path: "/api/v1/tenants/:tenantId/clients/:clientId",
    scope: "tenant_scoped",
    requiredPermission: "client:write:all",
    description: "Updates an existing client profile and billing terms.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/projects",
    scope: "tenant_scoped",
    requiredPermission: "project:read:assigned",
    description: "Lists tenant projects filtered by caller's role and project memberships.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/projects",
    scope: "tenant_scoped",
    requiredPermission: "project:write:all",
    description: "Creates a new project with client, billable rate, budget, and project manager.",
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
    path: "/api/v1/tenants/:tenantId/settings",
    scope: "tenant_scoped",
    requiredPermission: "tenant:settings:manage",
    description: "Returns tenant workspace settings and localization preferences.",
  },
  {
    method: "PATCH",
    path: "/api/v1/tenants/:tenantId/settings",
    scope: "tenant_scoped",
    requiredPermission: "tenant:settings:manage",
    description: "Updates tenant company configuration, timezone, currency, and rules.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/reports",
    scope: "tenant_scoped",
    requiredPermission: "report:read:tenant",
    description: "Returns aggregated utilization, project, client, employee and monthly reports.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/invitations",
    scope: "tenant_scoped",
    requiredPermission: "tenant:members:manage",
    description: "Dispatches a single employee invitation with assigned roles.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/team",
    scope: "tenant_scoped",
    description: "Lists tenant members scoped to caller's HR reporting hierarchy or admin scope.",
  },
  {
    method: "GET",
    path: "/api/v1/tenants/:tenantId/timesheets/week/:weekKey",
    scope: "tenant_scoped",
    requiredPermission: "timesheet:submit:own",
    description:
      "Retrieves timesheet and entries for the specified week and target membership (defaults to caller).",
  },
  {
    method: "PUT",
    path: "/api/v1/tenants/:tenantId/timesheets/week/:weekKey",
    scope: "tenant_scoped",
    requiredPermission: "timesheet:submit:own",
    description: "Creates or updates draft timesheet entries for a specified week and member.",
  },
  {
    method: "POST",
    path: "/api/v1/tenants/:tenantId/timesheets/:timesheetId/submit",
    scope: "tenant_scoped",
    requiredPermission: "timesheet:submit:own",
    description: "Submits a draft or rejected timesheet for manager review.",
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
    method: "POST",
    path: "/api/v1/tenants/:tenantId/timesheets/:timesheetId/reject",
    scope: "tenant_scoped",
    requiredPermission: "timesheet:approve:team",
    description: "Rejects a submitted timesheet with mandatory review comment.",
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
  {
    method: "GET",
    path: "/api/v1/dev/email-outbox",
    scope: "public",
    description:
      "Isolated development/test email outbox endpoint for inspecting password-reset and email-verification tokens when AWS SES is disabled. Strictly disabled (403) in production.",
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
 * - In production mode (`APP_ENV=production` or `NODE_ENV=production`), requires
 *   PostgreSQL (`options.db`) and NEVER falls back to in-memory session validation.
 * - If PostgreSQL is unreachable or throws a connection error during session validation,
 *   throws `DatabaseUnavailableError` (HTTP 503).
 */
export async function extractAuthenticatedIdentity(
  request: Request,
  options?: { db?: AureliaAwsDb | undefined; env?: Record<string, string | undefined> | undefined },
): Promise<AuthenticatedIdentity | null> {
  const isProd = isProductionEnvironment(options?.env);
  if (isProd && !options?.db) {
    throw new DatabaseUnavailableError();
  }

  const token = defaultSessionManager.extractTokenFromRequest(request);
  if (!token) {
    return null;
  }

  let session: UserSession | null = null;
  if (options?.db) {
    try {
      session = await defaultSessionManager.validateSessionInDb(token, { db: options.db });
    } catch (err) {
      const safeMsg = extractSafeDatabaseErrorMessage(err, "Database session validation error");
      throw new DatabaseUnavailableError(`PostgreSQL session store is unavailable: ${safeMsg}`);
    }
  } else if (!isProd) {
    session = defaultSessionManager.validateSession(token);
  } else {
    throw new DatabaseUnavailableError();
  }

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
  options: {
    db?: AureliaAwsDb | undefined;
    store: MultiTenantDataStore;
    env?: Record<string, string | undefined> | undefined;
  },
): Promise<UserRecord | null> {
  const isProd = isProductionEnvironment(options.env);
  if (isProd && !options.db) {
    throw new DatabaseUnavailableError();
  }

  if (options.db) {
    try {
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
    } catch (err) {
      const safeMsg = extractSafeDatabaseErrorMessage(err, "Database user lookup failed");
      throw new DatabaseUnavailableError(`PostgreSQL user directory is unavailable: ${safeMsg}`);
    }
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

function verifyApiCsrfProtection(request: Request, url: URL): { valid: boolean; reason?: string } {
  // Safe HTTP read methods are exempt
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return { valid: true };
  }

  // Token-based bearer authentication is not vulnerable to ambient browser credentials
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return { valid: true };
  }

  // If request has no cookies at all, ambient browser credential risk does not apply
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (!cookieHeader.includes("aurelia_session=")) {
    return { valid: true };
  }

  // State-changing request authenticated via ambient cookie:
  // 1. Check Sec-Fetch-Site (modern browsers)
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return { valid: false, reason: "Cross-site request blocked by Sec-Fetch-Site policy." };
  }

  // 2. Custom headers (standard defense-in-depth: cross-site form post cannot set custom headers)
  if (
    request.headers.get("x-requested-with") ||
    request.headers.get("x-aurelia-csrf") ||
    request.headers.get("x-csrf-token")
  ) {
    return { valid: true };
  }

  // 3. Origin header check
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === url.host) {
        return { valid: true };
      }
      // Allow localhost dev variants
      if (
        (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      ) {
        return { valid: true };
      }
    } catch {
      return { valid: false, reason: "Malformed Origin header in state-changing request." };
    }
    return { valid: false, reason: "Cross-origin request rejected." };
  }

  // If no Origin, check Referer
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.host === url.host) {
        return { valid: true };
      }
    } catch {
      return { valid: false, reason: "Malformed Referer header in state-changing request." };
    }
    return { valid: false, reason: "Cross-origin referer rejected." };
  }

  return { valid: true };
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
    emailProvider?: EmailDeliveryProvider;
    oidcConfig?: OidcProviderConfig;
    oidcFetchFn?: typeof fetch;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/")) {
    return null;
  }

  // CSRF Protection for state-changing endpoints authenticated via ambient cookies
  const csrfResult = verifyApiCsrfProtection(request, url);
  if (!csrfResult.valid) {
    return jsonResponse(
      {
        error: "CSRF_DETECTED",
        message:
          csrfResult.reason ?? "Cross-site request forgery protection rejected this request.",
      },
      403,
    );
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
  const isProd = isProductionEnvironment(env);

  let targetPool = options?.pool;
  let targetDb = options?.db;
  let dbInitError: Error | null = null;

  if (!targetPool && !targetDb && (isProd || (!options?.store && isAwsPostgresConfigured(env)))) {
    try {
      targetPool = getAwsPostgresPool(env);
      targetDb = getAwsPostgresDb(env);
    } catch (err) {
      dbInitError = err instanceof Error ? err : new Error("Failed to initialize PostgreSQL pool");
    }
  }

  const useDatabase = Boolean(targetPool || targetDb);
  const store = options?.store ?? getDefaultApiStore();

  try {
    // 1. Health Check Endpoint (Public summary; detailed diagnostics restricted to Platform Admins)
    if (contract.path === "/api/v1/health/db") {
      const health = await checkAwsDatabaseHealth({ env: options?.env });
      const status = health.status === "unhealthy" ? 503 : 200;

      let callerIdentity: AuthenticatedIdentity | null = null;
      try {
        callerIdentity = await extractAuthenticatedIdentity(request, { db: targetDb, env });
      } catch {
        callerIdentity = null;
      }

      let isAuthorizedPlatformAdmin = false;
      if (callerIdentity) {
        try {
          const verifiedUser = await resolveVerifiedServerUser(callerIdentity.userId, {
            db: targetDb,
            store,
            env,
          });
          if (verifiedUser && verifiedUser.status === "active" && verifiedUser.isPlatformAdmin) {
            isAuthorizedPlatformAdmin = true;
          }
        } catch {
          isAuthorizedPlatformAdmin = false;
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

    // Isolated Development/Test Email Outbox Endpoint (Strictly disabled in production)
    if (contract.path === "/api/v1/dev/email-outbox") {
      if (isProd || isProductionEmailEnvironment(env)) {
        return jsonResponse(
          {
            error: "DEVELOPMENT_ONLY_ENDPOINT",
            message: "The development email outbox is strictly disabled in production.",
          },
          403,
        );
      }

      const outbox = getDevelopmentEmailOutbox(env);
      const filterRecipient = (
        url.searchParams.get("recipient") ??
        url.searchParams.get("email") ??
        ""
      )
        .trim()
        .toLowerCase();
      const filterType = url.searchParams.get("type")?.trim();

      const emails = outbox.getOutbox().filter((item) => {
        if (filterRecipient && item.to !== filterRecipient) {
          return false;
        }
        if (
          filterType &&
          (filterType === "password_reset" || filterType === "email_verification") &&
          item.type !== filterType
        ) {
          return false;
        }
        return true;
      });

      return jsonResponse({
        mode: outbox.mode,
        count: emails.length,
        emails,
      });
    }

    // Fail-closed production safeguard: In production mode, ALL authentication, onboarding,
    // and workspace endpoints require PostgreSQL and MUST NEVER fall back to in-memory state.
    if (isProd && (!useDatabase || !targetDb)) {
      const detail = dbInitError ? `: ${redactPostgresCredentials(dbInitError.message)}` : ".";
      throw new DatabaseUnavailableError(
        `Production mode requires an active private AWS RDS PostgreSQL connection${detail} In-memory fallback is disabled.`,
      );
    }

    // 2. Public Self-Service Onboarding & Auth Endpoints
    if (contract.path === "/api/v1/onboarding/self-service/register-company") {
      const body = await safeReadJsonBody(request);
      if (useDatabase && (targetPool || targetDb)) {
        const result = await registerCompanyInDb(
          {
            pool: targetPool,
            db: targetDb,
            env,
            emailProvider: options?.emailProvider,
          },
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
            verificationEmailDispatched: result.verificationEmailDispatched,
          },
          201,
        );
      }
      const result = await registerSelfServiceCompanyAsync(
        store,
        {
          companyName: String(body["companyName"] ?? ""),
          slug: String(body["slug"] ?? ""),
          adminEmail: String(body["adminEmail"] ?? ""),
          adminFullName: String(body["adminFullName"] ?? ""),
          adminJobTitle: body["adminJobTitle"] ? String(body["adminJobTitle"]) : undefined,
        },
        { env, emailProvider: options?.emailProvider },
      );
      return jsonResponse(
        {
          tenant: result.tenant,
          adminUser: result.adminUser,
          adminMembership: result.adminMembership,
          verificationEmailDispatched: result.verificationEmailDispatched,
        },
        201,
      );
    }

    if (contract.path === "/api/v1/onboarding/self-service/verify-email") {
      const body = await safeReadJsonBody(request);
      const token = String(body["verificationToken"] ?? "");
      const expectedTenantId =
        typeof body["tenantId"] === "string" && body["tenantId"].trim()
          ? body["tenantId"].trim()
          : undefined;
      const expectedEmail =
        typeof body["email"] === "string" && body["email"].trim()
          ? body["email"].trim()
          : undefined;

      if (useDatabase && (targetPool || targetDb)) {
        const result = await verifyCompanyAdminEmailInDb(
          { pool: targetPool, db: targetDb, env },
          token,
          { expectedTenantId, expectedEmail },
        );
        return jsonResponse(result);
      }
      const ctx = verifyCompanyAdminEmail(store, token, {
        expectedTenantId,
        expectedEmail,
      });
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

      try {
        const loginResult = await defaultAuthService.login(
          {
            email,
            password,
            ipAddress,
            userAgent,
          },
          { db: targetDb, store, isSecureRequest, env },
        );

        return jsonResponse(
          {
            authenticated: true,
            user: loginResult.user,
            session: loginResult.session,
            sessionToken: loginResult.sessionToken,
            tenants: loginResult.tenants,
          },
          200,
          { "set-cookie": loginResult.setCookieHeader },
        );
      } catch (err) {
        if (err instanceof AuthorizationError) {
          return jsonResponse(
            {
              error: "UNAUTHENTICATED",
              message: err.message,
            },
            401,
          );
        }
        throw err;
      }
    }

    if (contract.path === "/api/v1/auth/logout") {
      const token = defaultSessionManager.extractTokenFromRequest(request);
      const isSecure = url.protocol === "https:";
      const logoutResult = await defaultAuthService.logout(token || "", isSecure, {
        db: targetDb,
        env,
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
      await defaultAuthService.requestPasswordReset(email, {
        db: targetDb,
        store,
        env,
        emailProvider: options?.emailProvider,
      });
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
        env,
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
      const connectionId = provider === "entra_oidc" ? "entra" : "google";

      const registeredCfg =
        options?.oidcConfig ?? defaultSsoService.getOidcConnection(connectionId, tenantId);

      const oidcRequest =
        provider === "entra_oidc"
          ? defaultSsoService.prepareEntraOidcRequest(
              registeredCfg ?? {
                connectionId,
                provider: "entra_oidc",
                clientId: "aurelia-entra-client-id",
                issuerUrl: "https://login.microsoftonline.com/common/v2.0",
                authorizationEndpoint:
                  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
                redirectUri: `${url.origin}/api/v1/auth/oidc/entra/callback`,
                tenantId,
              },
            )
          : defaultSsoService.prepareGoogleOidcRequest(
              registeredCfg ?? {
                connectionId,
                provider: "google_oidc",
                clientId: "aurelia-google-client-id",
                issuerUrl: "https://accounts.google.com",
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                tokenEndpoint: "https://oauth2.googleapis.com/token",
                jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
                redirectUri: `${url.origin}/api/v1/auth/oidc/google/callback`,
                tenantId,
              },
            );

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
      const redirectUri = `${url.origin}${url.pathname}`;
      const connectionId = params["connectionId"] ?? undefined;
      const ipAddress =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const isSecureRequest = url.protocol === "https:";

      try {
        const oidcAuth = await defaultAuthService.authenticateWithOidcCallback(
          {
            code,
            state,
            error,
            errorDescription,
            redirectUri,
            connectionId,
            config: options?.oidcConfig,
            fetchFn: options?.oidcFetchFn,
            ipAddress,
            userAgent,
          },
          {
            db: targetDb,
            store,
            isSecureRequest,
            env,
          },
        );

        return jsonResponse(
          {
            authenticated: true,
            provider: oidcAuth.provider,
            tenantId: oidcAuth.tenantContext.tenant.id,
            user: oidcAuth.user,
            session: oidcAuth.session,
            sessionToken: oidcAuth.sessionToken,
            tenants: oidcAuth.tenants,
          },
          200,
          { "set-cookie": oidcAuth.setCookieHeader },
        );
      } catch (err) {
        if (
          err instanceof TenantIsolationError ||
          err instanceof AuthorizationError ||
          err instanceof DatabaseUnavailableError
        ) {
          throw err;
        }
        const message = err instanceof Error ? err.message : "OIDC authentication failed.";
        return jsonResponse(
          {
            error: "OIDC_VALIDATION_FAILED",
            message,
          },
          400,
        );
      }
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
    const identity = await extractAuthenticatedIdentity(request, { db: targetDb, env });
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
      const serverUser = await resolveVerifiedServerUser(userId, {
        db: targetDb,
        store,
        env,
      });
      const tenants =
        useDatabase && targetDb
          ? await listUserTenantsFromDb(targetDb, userId)
          : store.listUserTenants(userId);

      return jsonResponse({
        authenticated: true,
        session: identity.session,
        user: serverUser
          ? {
              id: serverUser.id,
              email: serverUser.email,
              fullName: serverUser.fullName,
              status: serverUser.status,
              isPlatformAdmin: serverUser.isPlatformAdmin,
            }
          : null,
        tenants,
      });
    }

    if (contract.path === "/api/v1/auth/session/rotate") {
      const isSecure = url.protocol === "https:";
      const rotated = await defaultAuthService.rotateSession(identity.sessionToken, isSecure, {
        db: targetDb,
        env,
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
      if (isProd) {
        throw new DatabaseUnavailableError();
      }
      return jsonResponse({ tenants: store.listUserTenants(userId) });
    }

    // 4. Platform Admin Endpoints (Verified strictly from server-side user record; NEVER from headers)
    if (contract.scope === "platform_admin") {
      const body = await safeReadJsonBody(request);
      const platformAdminUser = await resolveVerifiedServerUser(userId, {
        db: targetDb,
        store,
        env,
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
        const provider = body["provider"] === "google_oidc" ? "google_oidc" : "entra_oidc";
        const tenantId = String(params["tenantId"] ?? "");
        const connectionId = String(body["connectionId"] ?? `${tenantId}_${provider}`);

        if (
          typeof body["clientId"] === "string" &&
          typeof body["issuerUrl"] === "string" &&
          typeof body["redirectUri"] === "string"
        ) {
          defaultSsoService.registerOidcConnection(connectionId, {
            connectionId,
            provider,
            clientId: String(body["clientId"]),
            clientSecret:
              typeof body["clientSecret"] === "string" ? body["clientSecret"] : undefined,
            issuerUrl: String(body["issuerUrl"]),
            authorizationEndpoint:
              typeof body["authorizationEndpoint"] === "string"
                ? body["authorizationEndpoint"]
                : provider === "google_oidc"
                  ? "https://accounts.google.com/o/oauth2/v2/auth"
                  : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            tokenEndpoint:
              typeof body["tokenEndpoint"] === "string"
                ? body["tokenEndpoint"]
                : provider === "google_oidc"
                  ? "https://oauth2.googleapis.com/token"
                  : "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            jwksUri: typeof body["jwksUri"] === "string" ? body["jwksUri"] : undefined,
            redirectUri: String(body["redirectUri"]),
            tenantId,
          });
        }

        return jsonResponse(
          {
            connectionId,
            tenantId,
            provider,
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
        { db: targetDb, store, env },
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
          env,
        });
        return jsonResponse({ success: true, targetUserId, status: newStatus });
      }

      if (contract.method === "GET" && contract.path === "/api/v1/tenants/:tenantId/clients") {
        const search = url.searchParams.get("search") ?? undefined;
        const status = url.searchParams.get("status") ?? undefined;
        const page = url.searchParams.get("page")
          ? Number(url.searchParams.get("page"))
          : undefined;
        const limit = url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined;

        if (useDatabase) {
          const result = await listClientsFromDb(
            ctx,
            { search, status, page, limit },
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse(result);
        }
        return jsonResponse(store.listClients(ctx, { search, status, page, limit }));
      }

      if (contract.method === "POST" && contract.path === "/api/v1/tenants/:tenantId/clients") {
        const input = {
          name: String(body["name"] ?? ""),
          contactName: String(body["contactName"] ?? body["contact"] ?? ""),
          contactEmail: String(body["contactEmail"] ?? body["email"] ?? ""),
          country: String(body["country"] ?? "India"),
          billingTerms: body["billingTerms"] ? String(body["billingTerms"]) : undefined,
          status: body["status"] ? String(body["status"]) : "active",
        };
        if (useDatabase) {
          const client = await createClientInDb(ctx, input, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ client }, 201);
        }
        const client = store.createClient(ctx, input);
        return jsonResponse({ client }, 201);
      }

      if (
        contract.method === "PATCH" &&
        contract.path === "/api/v1/tenants/:tenantId/clients/:clientId"
      ) {
        const clientId = String(params["clientId"] ?? "");
        const input = {
          name: body["name"] !== undefined ? String(body["name"]) : undefined,
          contactName: body["contactName"] !== undefined ? String(body["contactName"]) : undefined,
          contactEmail:
            body["contactEmail"] !== undefined ? String(body["contactEmail"]) : undefined,
          country: body["country"] !== undefined ? String(body["country"]) : undefined,
          billingTerms:
            body["billingTerms"] !== undefined ? String(body["billingTerms"]) : undefined,
          status: body["status"] !== undefined ? String(body["status"]) : undefined,
        };
        if (useDatabase) {
          const client = await updateClientInDb(ctx, clientId, input, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ client });
        }
        const client = store.updateClient(ctx, clientId, input);
        return jsonResponse({ client });
      }

      if (contract.method === "POST" && contract.path === "/api/v1/tenants/:tenantId/projects") {
        const input = {
          clientId: String(body["clientId"] ?? ""),
          name: String(body["name"] ?? ""),
          projectManagerMembershipId: String(
            body["projectManagerMembershipId"] ?? ctx.membership.id,
          ),
          budgetHours: Number(body["budgetHours"] ?? 100),
          billableRate: Number(body["billableRate"] ?? 75),
          tasks: Array.isArray(body["tasks"]) ? (body["tasks"] as string[]) : undefined,
          status: (body["status"] as "active" | "on-hold" | "completed") ?? "active",
        };
        if (useDatabase) {
          const project = await createProjectInDb(ctx, input, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ project }, 201);
        }
        const project = store.createProjectScoped(ctx, input);
        return jsonResponse({ project }, 201);
      }

      if (contract.method === "GET" && contract.path === "/api/v1/tenants/:tenantId/settings") {
        if (useDatabase) {
          const settings = await getTenantSettingsFromDb(ctx, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ settings });
        }
        const settings = store.getTenantSettings(ctx);
        return jsonResponse({ settings });
      }

      if (contract.method === "PATCH" && contract.path === "/api/v1/tenants/:tenantId/settings") {
        const input = {
          name: body["name"] !== undefined ? String(body["name"]) : undefined,
          country: body["country"] !== undefined ? String(body["country"]) : undefined,
          timezone: body["timezone"] !== undefined ? String(body["timezone"]) : undefined,
          currency: body["currency"] !== undefined ? String(body["currency"]) : undefined,
          timeFormat: body["timeFormat"] !== undefined ? String(body["timeFormat"]) : undefined,
          weekStart: body["weekStart"] !== undefined ? String(body["weekStart"]) : undefined,
          dailyTargetHours:
            body["dailyTargetHours"] !== undefined ? String(body["dailyTargetHours"]) : undefined,
          lockApprovedSheets:
            body["lockApprovedSheets"] !== undefined
              ? Boolean(body["lockApprovedSheets"])
              : undefined,
          requireRejectReason:
            body["requireRejectReason"] !== undefined
              ? Boolean(body["requireRejectReason"])
              : undefined,
        };
        if (useDatabase) {
          const settings = await updateTenantSettingsInDb(ctx, input, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ settings });
        }
        const settings = store.updateTenantSettings(ctx, input);
        return jsonResponse({ settings });
      }

      if (contract.method === "GET" && contract.path === "/api/v1/tenants/:tenantId/reports") {
        const from = url.searchParams.get("from") ?? undefined;
        const to = url.searchParams.get("to") ?? undefined;
        const includeDrafts = url.searchParams.get("includeDrafts") === "true";

        if (useDatabase) {
          const report = await getTenantReportsFromDb(
            ctx,
            { from, to, includeDrafts },
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse(report);
        }
        const report = store.getReports(ctx, { from, to, includeDrafts });
        return jsonResponse(report);
      }

      if (contract.method === "POST" && contract.path === "/api/v1/tenants/:tenantId/invitations") {
        const email = String(body["email"] ?? "");
        const roleKeys = Array.isArray(body["roleKeys"])
          ? (body["roleKeys"] as string[])
          : ["employee"];
        const departmentId = body["departmentId"] ? String(body["departmentId"]) : undefined;
        const reportingManagerMembershipId = body["reportingManagerMembershipId"]
          ? String(body["reportingManagerMembershipId"])
          : undefined;

        if (useDatabase) {
          const invitation = await createMemberInvitationInDb(
            ctx,
            { email, roleKeys, departmentId, reportingManagerMembershipId },
            { pool: targetPool, env: options?.env, emailProvider: options?.emailProvider },
          );
          return jsonResponse({ invitation }, 201);
        }
        const invitation = store.createInvitation(ctx, {
          email,
          roleKeys,
          departmentId,
          reportingManagerMembershipId,
        });
        return jsonResponse({ invitation }, 201);
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

      if (
        contract.method === "GET" &&
        contract.path === "/api/v1/tenants/:tenantId/timesheets/week/:weekKey"
      ) {
        const weekKeyParam = String(params["weekKey"] ?? "");
        const targetMembershipId = url.searchParams.get("membershipId") || ctx.membership.id;
        if (useDatabase) {
          const timesheet = await getTimesheetForWeekFromDb(ctx, targetMembershipId, weekKeyParam, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ timesheet });
        }
        const timesheet = store.getTimesheetForWeek(ctx, targetMembershipId, weekKeyParam);
        return jsonResponse({ timesheet });
      }

      if (
        contract.method === "PUT" &&
        contract.path === "/api/v1/tenants/:tenantId/timesheets/week/:weekKey"
      ) {
        const weekKeyParam = String(params["weekKey"] ?? "");
        const targetMembershipId =
          (body["membershipId"] ? String(body["membershipId"]) : null) || ctx.membership.id;
        const entries = (
          Array.isArray(body["entries"]) ? body["entries"] : []
        ) as TimesheetEntryInput[];
        if (useDatabase) {
          const timesheet = await upsertTimesheetInDb(
            ctx,
            targetMembershipId,
            { weekStart: weekKeyParam, entries },
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ timesheet });
        }
        const timesheet = store.upsertTimesheet(ctx, targetMembershipId, {
          weekStart: weekKeyParam,
          entries,
        });
        return jsonResponse({ timesheet });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/timesheets/:timesheetId/submit") {
        const timesheetId = String(params["timesheetId"] ?? "");
        if (useDatabase) {
          const submitted = await submitTimesheetInDb(ctx, timesheetId, {
            pool: targetPool,
            env: options?.env,
          });
          return jsonResponse({ timesheet: submitted });
        }
        const submitted = store.submitTimesheet(ctx, timesheetId);
        return jsonResponse({ timesheet: submitted });
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

      if (contract.path === "/api/v1/tenants/:tenantId/timesheets/:timesheetId/reject") {
        const comment = String(body["comment"] ?? body["rejectionComment"] ?? "").trim();
        if (!comment || comment.length < 3) {
          return jsonResponse(
            {
              error: "VALIDATION_ERROR",
              message: "A rejection comment of at least 3 characters is required.",
            },
            400,
          );
        }
        if (useDatabase) {
          const rejected = await rejectTimesheetInDb(
            ctx,
            String(params["timesheetId"] ?? ""),
            comment,
            { pool: targetPool, env: options?.env },
          );
          return jsonResponse({ timesheet: rejected });
        }
        const rejected = store.rejectTimesheet(ctx, String(params["timesheetId"] ?? ""), comment);
        return jsonResponse({ timesheet: rejected });
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
        if (useDatabase) {
          const result = await listApprovalsFromDb(ctx, { pool: targetPool, env: options?.env });
          return jsonResponse({
            tenantId: ctx.tenant.id,
            approvals: result.pending,
            pending: result.pending,
            history: result.history,
          });
        }
        const result = store.listApprovals(ctx);
        return jsonResponse({
          tenantId: ctx.tenant.id,
          approvals: result.pending,
          pending: result.pending,
          history: result.history,
        });
      }
    }

    return jsonResponse({ error: "NOT_IMPLEMENTED" }, 501);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError || error instanceof EmailDeliveryError) {
      return jsonResponse(
        {
          error: error.code,
          message: redactSensitiveEmailTokens(redactPostgresCredentials(error.message)),
        },
        error.statusCode,
      );
    }
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
    return jsonResponse(
      {
        error: "BAD_REQUEST",
        message: redactSensitiveEmailTokens(redactPostgresCredentials(message)),
      },
      400,
    );
  }
}
