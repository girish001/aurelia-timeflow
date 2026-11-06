import { getActiveTenantId } from "./auth-client";
import type {
  DetailedTimesheet,
  TimesheetEntryInput,
  ApprovalItem,
  ApprovalHistoryItem,
} from "@/server/repositories/postgres-tenant-store";

const API_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};

/**
 * Fetches the weekly timesheet for the specified week from the backend.
 */
export async function apiFetchTimesheetForWeek(
  weekKey: string,
  tenantId?: string,
  membershipId?: string,
): Promise<DetailedTimesheet | null> {
  const tid = tenantId || getActiveTenantId();
  const query = membershipId ? `?membershipId=${encodeURIComponent(membershipId)}` : "";
  const res = await fetch(
    `/api/v1/tenants/${encodeURIComponent(tid)}/timesheets/week/${encodeURIComponent(weekKey)}${query}`,
    {
      method: "GET",
      headers: API_HEADERS,
      credentials: "same-origin",
    },
  );

  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return null;
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Failed to fetch timesheet.");
  }

  const data = await res.json();
  return data.timesheet ?? null;
}

/**
 * Saves draft timesheet entries to the backend.
 */
export async function apiSaveDraftTimesheet(
  weekKey: string,
  entries: TimesheetEntryInput[],
  tenantId?: string,
  membershipId?: string,
): Promise<DetailedTimesheet> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(
    `/api/v1/tenants/${encodeURIComponent(tid)}/timesheets/week/${encodeURIComponent(weekKey)}`,
    {
      method: "PUT",
      headers: API_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({
        membershipId,
        entries,
      }),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to save timesheet draft.");
  }

  return data.timesheet;
}

/**
 * Submits a timesheet for manager review.
 */
export async function apiSubmitTimesheet(
  timesheetId: string,
  tenantId?: string,
): Promise<DetailedTimesheet> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(
    `/api/v1/tenants/${encodeURIComponent(tid)}/timesheets/${encodeURIComponent(timesheetId)}/submit`,
    {
      method: "POST",
      headers: API_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({}),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to submit timesheet.");
  }

  return data.timesheet;
}

/**
 * Retrieves pending and historical approvals.
 */
export async function apiFetchApprovals(
  tenantId?: string,
): Promise<{ pending: ApprovalItem[]; history: ApprovalHistoryItem[] }> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/approvals`, {
    method: "GET",
    headers: API_HEADERS,
    credentials: "same-origin",
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to fetch approvals.");
  }

  return {
    pending: data.pending || data.approvals || [],
    history: data.history || [],
  };
}

/**
 * Approves a submitted timesheet.
 */
export async function apiApproveTimesheet(
  timesheetId: string,
  comment?: string,
  tenantId?: string,
): Promise<{ success: boolean; timesheet: unknown }> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(
    `/api/v1/tenants/${encodeURIComponent(tid)}/timesheets/${encodeURIComponent(timesheetId)}/approve`,
    {
      method: "POST",
      headers: API_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ comment }),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to approve timesheet.");
  }

  return { success: true, timesheet: data.timesheet };
}

/**
 * Rejects a submitted timesheet with mandatory comment.
 */
export async function apiRejectTimesheet(
  timesheetId: string,
  rejectionComment: string,
  tenantId?: string,
): Promise<{ success: boolean; timesheet: unknown }> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(
    `/api/v1/tenants/${encodeURIComponent(tid)}/timesheets/${encodeURIComponent(timesheetId)}/reject`,
    {
      method: "POST",
      headers: API_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ comment: rejectionComment, rejectionComment }),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to reject timesheet.");
  }

  return { success: true, timesheet: data.timesheet };
}

/**
 * Retrieves database-backed reports & analytics.
 */
export async function apiFetchReports(
  options?: { from?: string; to?: string; includeDrafts?: boolean },
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const query = new URLSearchParams();
  if (options?.from) query.set("from", options.from);
  if (options?.to) query.set("to", options.to);
  if (options?.includeDrafts) query.set("includeDrafts", "true");

  const qs = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/reports${qs}`, {
    method: "GET",
    headers: API_HEADERS,
    credentials: "same-origin",
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to fetch reports.");
  }
  return data;
}

/**
 * Fetches tenant clients.
 */
export async function apiFetchClients(
  options?: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
  },
  tenantId?: string,
): Promise<{ clients: Record<string, unknown>[]; total: number }> {
  const tid = tenantId || getActiveTenantId();
  const query = new URLSearchParams();
  if (options?.search) query.set("search", options.search);
  if (options?.status) query.set("status", options.status);
  if (options?.page) query.set("page", String(options.page));
  if (options?.limit) query.set("limit", String(options.limit));

  const qs = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/clients${qs}`, {
    method: "GET",
    headers: API_HEADERS,
    credentials: "same-origin",
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to fetch clients.");
  }
  return { clients: data.clients || [], total: data.total || 0 };
}

/**
 * Creates a new client profile.
 */
export async function apiCreateClient(
  input: {
    name: string;
    contactName: string;
    contactEmail: string;
    country: string;
    billingTerms?: string;
    status?: string;
  },
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/clients`, {
    method: "POST",
    headers: API_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify(input),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to create client.");
  }
  return data.client;
}

/**
 * Updates an existing client profile.
 */
export async function apiUpdateClient(
  clientId: string,
  input: Partial<{
    name: string;
    contactName: string;
    contactEmail: string;
    country: string;
    billingTerms?: string;
    status?: string;
  }>,
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(
    `/api/v1/tenants/${encodeURIComponent(tid)}/clients/${encodeURIComponent(clientId)}`,
    {
      method: "PATCH",
      headers: API_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(input),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to update client.");
  }
  return data.client;
}

/**
 * Creates a new project in the tenant.
 */
export async function apiCreateProject(
  input: {
    clientId: string;
    name: string;
    projectManagerMembershipId?: string;
    budgetHours: number;
    billableRate: number;
    tasks?: string[];
    status?: "active" | "on-hold" | "completed";
  },
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/projects`, {
    method: "POST",
    headers: API_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify(input),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to create project.");
  }
  return data.project;
}

/**
 * Fetches tenant company settings.
 */
export async function apiFetchSettings(tenantId?: string): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/settings`, {
    method: "GET",
    headers: API_HEADERS,
    credentials: "same-origin",
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to fetch settings.");
  }
  return data.settings;
}

/**
 * Updates tenant company settings.
 */
export async function apiUpdateSettings(
  input: Record<string, unknown>,
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/settings`, {
    method: "PATCH",
    headers: API_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify(input),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to update settings.");
  }
  return data.settings;
}

/**
 * Sends a single employee invitation.
 */
export async function apiInviteMember(
  input: {
    email: string;
    roleKeys: string[];
    departmentId?: string;
    reportingManagerMembershipId?: string;
  },
  tenantId?: string,
): Promise<Record<string, unknown>> {
  const tid = tenantId || getActiveTenantId();
  const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tid)}/invitations`, {
    method: "POST",
    headers: API_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify(input),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || "Failed to invite member.");
  }
  return data.invitation;
}
