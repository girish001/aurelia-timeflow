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
