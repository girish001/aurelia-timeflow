import type { PermissionCode } from "../tenancy/tenant-context";

/**
 * Fastify API Route Blueprint & Boundary Specification for Aurelia TimeFlow SaaS.
 * Every `/api/v1/tenants/:tenantId/*` endpoint requires:
 * 1. Authenticated session (`requireSession` preHandler)
 * 2. Active tenant membership (`resolveTenantContext` preHandler)
 * 3. Endpoint permission / scope guard (`requirePermission` + resource-level ABAC)
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
