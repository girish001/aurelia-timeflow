export interface ServerUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  isPlatformAdmin?: boolean;
}

export interface TenantMembershipSummary {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  membership: {
    id: string;
    roleKey?: string;
    status: string;
  };
}

export interface AuthSessionResponse {
  authenticated: boolean;
  session?: {
    id: string;
    userId: string;
    email: string;
    expiresAt: number;
    createdAt: number;
  };
  user?: ServerUser | null;
  tenants?: TenantMembershipSummary[];
}

export const isProductionEnvironment = (): boolean => {
  return (
    import.meta.env.PROD ||
    import.meta.env["VITE_APP_ENV"] === "production" ||
    (typeof process !== "undefined" && process.env?.["APP_ENV"] === "production")
  );
};

const DEFAULT_AUTH_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};

/**
 * Executes email/password authentication against the Aurelia backend.
 * Returns session data and sets HttpOnly session cookie on the browser.
 */
export async function loginWithCredentials(
  email: string,
  password: string,
): Promise<{
  authenticated: boolean;
  sessionToken: string;
  user: ServerUser;
  tenants: TenantMembershipSummary[];
}> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: DEFAULT_AUTH_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify({ email, password }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Authentication failed. Check your credentials.");
  }

  // Store active tenant ID preference in localStorage if available
  if (data.tenants && data.tenants.length > 0) {
    const firstTenant = data.tenants[0];
    localStorage.setItem("aurelia_active_tenant_id", firstTenant.tenant.id);
    localStorage.setItem("aurelia_active_membership_id", firstTenant.membership.id);
  }
  localStorage.setItem("aurelia_authenticated_user", JSON.stringify(data.user));

  return data;
}

/**
 * Validates active session with the backend.
 */
export async function checkServerSession(): Promise<AuthSessionResponse | null> {
  try {
    const res = await fetch("/api/v1/auth/session", {
      method: "GET",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
      },
      credentials: "same-origin",
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as AuthSessionResponse;
    const firstTenant = data.tenants?.[0];
    if (data.authenticated && firstTenant) {
      const storedTenantId = localStorage.getItem("aurelia_active_tenant_id");
      const matched = data.tenants?.find((t) => t.tenant.id === storedTenantId);
      if (!matched) {
        localStorage.setItem("aurelia_active_tenant_id", firstTenant.tenant.id);
        localStorage.setItem("aurelia_active_membership_id", firstTenant.membership.id);
      }
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Terminates session both on server (invalidating token and clearing HttpOnly cookie)
 * and locally.
 */
export async function logoutServerSession(): Promise<void> {
  try {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: DEFAULT_AUTH_HEADERS,
      credentials: "same-origin",
    });
  } finally {
    localStorage.removeItem("aurelia_active_tenant_id");
    localStorage.removeItem("aurelia_active_membership_id");
    localStorage.removeItem("aurelia_authenticated_user");
    localStorage.removeItem("timeflow:session");
  }
}

/**
 * Retrieves the currently active tenant ID for API calls.
 */
export function getActiveTenantId(): string {
  return localStorage.getItem("aurelia_active_tenant_id") || "t_default";
}

/**
 * Retrieves the active membership ID for API calls.
 */
export function getActiveMembershipId(): string | null {
  return localStorage.getItem("aurelia_active_membership_id");
}
