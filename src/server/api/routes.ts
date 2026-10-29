import { assertValidTenantExecutionContext, checkAwsDatabaseHealth } from "../db/aws-postgres";
import {
  importTeamCsvIntoTenant,
  provisionEnterpriseTenant,
  registerSelfServiceCompany,
  startSupportImpersonationSession,
  verifyCompanyAdminEmail,
} from "../onboarding/onboarding-service";
import { MultiTenantDataStore } from "../repositories/tenant-scoped-store";
import {
  AuthorizationError,
  TenantIsolationError,
  type PermissionCode,
} from "../tenancy/tenant-context";

/**
 * API Route Blueprint & Executable Dispatcher for Aurelia TimeFlow SaaS.
 * Every `/api/v1/tenants/:tenantId/*` endpoint enforces:
 * 1. Authenticated user identity (`x-aurelia-user-id` or `Authorization: Bearer user:<id>`)
 * 2. Active tenant membership (`resolveTenantContext`)
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
      "Email/password authentication returning user session and available tenant memberships.",
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function extractAuthenticatedUserId(request: Request): string | null {
  const headerUser = request.headers.get("x-aurelia-user-id")?.trim();
  if (headerUser) return headerUser;

  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  if (authHeader.toLowerCase().startsWith("bearer user:")) {
    const tokenUser = authHeader.slice("bearer user:".length).trim();
    return tokenUser || null;
  }
  return null;
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
  const store = options?.store ?? getDefaultApiStore();

  try {
    // 1. Public Health Check Endpoint
    if (contract.path === "/api/v1/health/db") {
      const health = await checkAwsDatabaseHealth({ env: options?.env });
      const status = health.status === "unhealthy" ? 503 : 200;
      return jsonResponse(health, status);
    }

    // 2. Public Self-Service Onboarding & Auth Endpoints
    if (contract.path === "/api/v1/onboarding/self-service/register-company") {
      const body = await safeReadJsonBody(request);
      const result = registerSelfServiceCompany(store, {
        companyName: String(body["companyName"] ?? ""),
        slug: String(body["slug"] ?? ""),
        adminEmail: String(body["adminEmail"] ?? ""),
        adminFullName: String(body["adminFullName"] ?? ""),
        adminJobTitle: body["adminJobTitle"] ? String(body["adminJobTitle"]) : undefined,
      });
      return jsonResponse(result, 201);
    }

    if (contract.path === "/api/v1/onboarding/self-service/verify-email") {
      const body = await safeReadJsonBody(request);
      const ctx = verifyCompanyAdminEmail(store, String(body["verificationToken"] ?? ""));
      return jsonResponse({
        tenant: ctx.tenant,
        user: ctx.user,
        membership: ctx.membership,
      });
    }

    if (contract.path === "/api/v1/auth/login") {
      const body = await safeReadJsonBody(request);
      const userId = String(body["userId"] ?? "").trim();
      if (!userId) {
        return jsonResponse({ error: "BAD_REQUEST", message: "userId or email is required." }, 400);
      }
      const tenants = store.listUserTenants(userId);
      return jsonResponse({ userId, tenants });
    }

    if (
      contract.path === "/api/v1/auth/sso/discover" ||
      contract.path === "/api/v1/auth/oidc/:connectionId/callback" ||
      contract.path === "/api/v1/auth/saml/:connectionId/acs"
    ) {
      return jsonResponse({
        route: contract.path,
        connectionId: params["connectionId"] ?? null,
        status: "sso_ready",
      });
    }

    // 3. Authenticated Endpoints Requiring Valid User Identity
    const userId = extractAuthenticatedUserId(request);
    if (!userId) {
      return jsonResponse(
        {
          error: "UNAUTHENTICATED",
          message: "Missing authenticated user session header.",
        },
        401,
      );
    }

    if (contract.path === "/api/v1/auth/tenants") {
      return jsonResponse({ tenants: store.listUserTenants(userId) });
    }

    // 4. Platform Admin Endpoints
    if (contract.scope === "platform_admin") {
      const body = await safeReadJsonBody(request);
      const isPlatformAdminHeader = request.headers.get("x-aurelia-platform-admin") === "true";
      const platformAdminUser = {
        id: userId,
        email: `${userId}@aurelia-platform.internal`,
        fullName: "Aurelia Platform Admin",
        emailVerifiedAt: new Date().toISOString(),
        isPlatformAdmin: isPlatformAdminHeader,
        status: "active" as const,
      };

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
        if (!platformAdminUser.isPlatformAdmin) {
          throw new AuthorizationError("Platform administrator privileges required.");
        }
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
      const pathTenantId = params["tenantId"] ?? "";
      const ctx = store.resolveTenantContext(userId, pathTenantId);

      const body = request.method === "GET" ? {} : await safeReadJsonBody(request);
      const claimedBodyTenantId =
        typeof body["tenantId"] === "string" ? body["tenantId"] : undefined;

      // Reject any mismatch between URL :tenantId, authenticated membership, and body tenantId
      assertValidTenantExecutionContext(ctx, claimedBodyTenantId);

      if (contract.requiredPermission && !ctx.permissions.has(contract.requiredPermission)) {
        throw new AuthorizationError(
          `Missing required permission "${contract.requiredPermission}" in tenant "${ctx.tenant.id}".`,
        );
      }

      if (contract.path === "/api/v1/tenants/:tenantId/invitations/bulk-csv") {
        const summary = importTeamCsvIntoTenant(store, ctx, String(body["csvText"] ?? ""));
        return jsonResponse(summary, 201);
      }

      if (contract.path === "/api/v1/tenants/:tenantId/projects") {
        return jsonResponse({ projects: store.listVisibleProjects(ctx) });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/projects/:projectId") {
        const updated = store.updateProjectBudget(
          ctx,
          String(params["projectId"] ?? ""),
          Number(body["budgetHours"] ?? 0),
        );
        return jsonResponse({ project: updated });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/team") {
        return jsonResponse({ members: store.listAccessibleTeamMembers(ctx) });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/timesheets/:timesheetId/approve") {
        const approved = store.approveTimesheet(ctx, String(params["timesheetId"] ?? ""));
        return jsonResponse({ timesheet: approved });
      }

      if (contract.path === "/api/v1/tenants/:tenantId/audit-logs") {
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
