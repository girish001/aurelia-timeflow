// Pure business rules for the demo. UI-only role checks — production needs
// server-side authorization; these functions only decide what the demo shows.
import { addDays, differenceInCalendarDays, isWeekend, parseISO } from "date-fns";
import type {
  Allocation,
  DayPart,
  LeaveRequest,
  LeaveType,
  Member,
  Project,
  Role,
  State,
  Timesheet,
} from "./demo-store";
import { isoDay } from "./time";

export type Page =
  | "overview"
  | "timesheet"
  | "timeoff"
  | "calendar"
  | "approvals"
  | "projects"
  | "clients"
  | "team"
  | "reports"
  | "settings"
  | "profile"
  | "audit";

export const ROLE_LABEL: Record<Role, string> = {
  Admin: "Business Admin",
  Manager: "Project Manager",
  Employee: "Employee",
};

export const ACCESS: Record<Page, Role[]> = {
  overview: ["Admin", "Manager", "Employee"],
  timesheet: ["Admin", "Manager", "Employee"],
  timeoff: ["Admin", "Manager", "Employee"],
  calendar: ["Admin", "Manager", "Employee"],
  profile: ["Admin", "Manager", "Employee"],
  approvals: ["Admin", "Manager"],
  projects: ["Admin", "Manager"],
  team: ["Admin", "Manager"],
  clients: ["Admin"],
  reports: ["Admin"],
  settings: ["Admin"],
  audit: ["Admin"],
};

export const NAV_ORDER: Page[] = [
  "overview",
  "timesheet",
  "timeoff",
  "calendar",
  "approvals",
  "projects",
  "clients",
  "team",
  "reports",
  "audit",
  "settings",
  "profile",
];

export const canAccess = (role: Role, page: Page) => (ACCESS[page] ?? []).includes(role);
export const navFor = (role: Role) => NAV_ORDER.filter((p) => canAccess(role, p));

export function pageFromPath(path: string): Page | null {
  const seg = path.replace(/^\/app\/?/, "").split("/")[0] ?? "";
  if (!seg) return "overview";
  return seg in ACCESS ? (seg as Page) : null;
}

// ---------- scope & permission isolation ----------
export function managedProjectIds(s: State, meId: string) {
  return s.projects.filter((p) => p.managerId === meId).map((p) => p.id);
}

/** Members whose data the persona may see. */
export function teamIds(s: State, me: Member): string[] {
  if (me.role === "Admin") return s.members.map((m) => m.id);
  if (me.role === "Employee") return [me.id];
  const pids = new Set(managedProjectIds(s, me.id));
  const ids = new Set<string>([me.id]);
  s.members.forEach((m) => {
    if (m.reportingManagerId === me.id) ids.add(m.id);
  });
  s.allocations.forEach((a) => pids.has(a.projectId) && ids.add(a.memberId));
  s.timesheets.forEach((t) => t.entries.some((e) => pids.has(e.projectId)) && ids.add(t.memberId));
  return s.members.filter((m) => ids.has(m.id)).map((m) => m.id);
}

/** Returns member IDs of employees reporting to this manager (excluding themselves). */
export function directReportIds(s: State, me: Member): string[] {
  if (me.role === "Admin") return s.members.filter((m) => m.id !== me.id).map((m) => m.id);
  if (me.role === "Employee") return [];
  const ids = new Set<string>();

  // 1. Primary: Direct reporting structure (reportingManagerId)
  s.members.forEach((m) => {
    if (m.reportingManagerId === me.id && m.id !== me.id) ids.add(m.id);
  });

  // 2. Fallback: If no reporting lines are established in state, fall back to project team
  const hasReportingLines = s.members.some((m) => !!m.reportingManagerId);
  if (!hasReportingLines) {
    const pids = new Set(managedProjectIds(s, me.id));
    s.allocations.forEach((a) => {
      if (pids.has(a.projectId) && a.memberId !== me.id) ids.add(a.memberId);
    });
    s.timesheets.forEach((t) => {
      if (t.entries.some((e) => pids.has(e.projectId)) && t.memberId !== me.id) ids.add(t.memberId);
    });
  }

  return s.members.filter((m) => ids.has(m.id)).map((m) => m.id);
}

export function scopedMembers(s: State, me: Member): Member[] {
  if (me.role === "Admin") return s.members;
  if (me.role === "Employee") return [me];
  const ids = new Set(teamIds(s, me));
  return s.members.filter((m) => ids.has(m.id));
}

export function scopedProjects(s: State, me: Member): Project[] {
  if (me.role === "Admin") return s.projects;
  if (me.role === "Manager") {
    return s.projects.filter((p) => p.managerId === me.id);
  }
  const ids = new Set(s.allocations.filter((a) => a.memberId === me.id).map((a) => a.projectId));
  // Include projects the employee has entries in
  s.timesheets
    .filter((t) => t.memberId === me.id)
    .forEach((t) => t.entries.forEach((e) => ids.add(e.projectId)));
  const found = s.projects.filter((p) => ids.has(p.id));
  return found.length > 0 ? found : s.projects.filter((p) => p.status === "active");
}

export function scopedTimesheets(s: State, me: Member): Timesheet[] {
  if (me.role === "Admin") return s.timesheets;
  if (me.role === "Employee") return s.timesheets.filter((t) => t.memberId === me.id);
  const team = new Set(teamIds(s, me));
  return s.timesheets.filter((t) => t.memberId === me.id || team.has(t.memberId));
}

export function scopedLeaves(s: State, me: Member): LeaveRequest[] {
  if (me.role === "Admin") return s.leaves;
  if (me.role === "Employee") return s.leaves.filter((l) => l.memberId === me.id);
  const team = new Set(teamIds(s, me));
  return s.leaves.filter((l) => l.memberId === me.id || team.has(l.memberId));
}

export function approvableTimesheets(s: State, me: Member): Timesheet[] {
  if (me.role === "Employee") return [];
  if (me.role === "Admin") return s.timesheets.filter((t) => t.memberId !== me.id);
  const team = new Set(teamIds(s, me));
  return s.timesheets.filter((t) => t.memberId !== me.id && team.has(t.memberId));
}

export function canApproveTimesheet(s: State, me: Member, timesheetId: string): boolean {
  if (me.role === "Employee") return false;
  const ts = s.timesheets.find((t) => t.id === timesheetId);
  if (!ts || ts.memberId === me.id || ts.status !== "submitted") return false;
  if (me.role === "Admin") return true;
  return teamIds(s, me).includes(ts.memberId);
}

export function canEditAllocation(
  s: State,
  me: Member,
  projectId: string,
  memberId?: string,
): boolean {
  if (me.role === "Admin") {
    const validProject = s.projects.some((p) => p.id === projectId);
    const validMember = !memberId || s.members.some((m) => m.id === memberId);
    return validProject && validMember;
  }
  if (me.role === "Manager") {
    const managesProject = s.projects.find((p) => p.id === projectId)?.managerId === me.id;
    if (!managesProject) return false;
    if (memberId && !teamIds(s, me).includes(memberId)) return false;
    return true;
  }
  return false;
}

// ---------- time off ----------
export const LEAVE_LABEL: Record<LeaveType, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  personal: "Personal leave",
  unpaid: "Unpaid leave",
};
export const ANNUAL_ENTITLEMENT = 18;
export const SICK_ENTITLEMENT = 10;
export const PERSONAL_ENTITLEMENT = 5;
export const MONTHLY_PAID_LEAVE_ACCRUAL = 1.5; // 1.5 days/month (18 days/year)

export const LEAVE_ENTITLEMENTS: Record<LeaveType, number> = {
  annual: ANNUAL_ENTITLEMENT,
  sick: SICK_ENTITLEMENT,
  personal: PERSONAL_ENTITLEMENT,
  unpaid: 0,
};

export function calculateMonthlyAccrual(
  date: Date = new Date(),
  monthlyRate = MONTHLY_PAID_LEAVE_ACCRUAL,
  annualMax = ANNUAL_ENTITLEMENT,
) {
  const month = date.getMonth() + 1; // 1 to 12
  const accruedToDate = Math.min(annualMax, Math.round(month * monthlyRate * 10) / 10);
  return {
    month,
    monthlyRate,
    accruedToDate,
    annualMax,
  };
}

export interface LeaveInput {
  type: LeaveType;
  start: string;
  end: string;
  partial: DayPart;
  reason: string;
}

export function validateLeave(
  i: LeaveInput,
  today: string,
  holidays?: { date: string; name?: string }[],
): string | null {
  if (!i.start || !i.end) return "Choose a start and end date";
  if (i.end < i.start) return "End date cannot be before the start date";
  if (i.partial !== "full" && i.start !== i.end)
    return "Half days apply to single-day requests only";
  if (differenceInCalendarDays(parseISO(i.end), parseISO(i.start)) > 30)
    return "Requests are limited to 31 days";
  if (i.type !== "sick" && i.start < today) return "Only sick leave can be backdated";
  if (weekdaysBetween(i.start, i.end, holidays).length === 0) {
    if (holidays && holidays.some((h) => h.date >= i.start && h.date <= i.end)) {
      return "The selected dates fall entirely on official company holidays or weekends";
    }
    return "The selected range has no working days";
  }
  if (i.type === "unpaid" && i.reason.trim().length < 3) return "Add a reason for unpaid leave";
  if (i.reason.length > 300) return "Reason must be under 300 characters";
  return null;
}

export function weekdaysBetween(
  start: string,
  end: string,
  holidays?: { date: string }[],
): string[] {
  const out: string[] = [];
  if (!start || !end || end < start) return out;
  const holidaySet = new Set(holidays?.map((h) => h.date) ?? []);
  for (let d = parseISO(start); isoDay(d) <= end; d = addDays(d, 1)) {
    const dStr = isoDay(d);
    if (!isWeekend(d) && !holidaySet.has(dStr)) {
      out.push(dStr);
    }
  }
  return out;
}

export function leaveDays(
  r: Pick<LeaveRequest, "start" | "end"> & { partial?: DayPart | undefined },
  holidays?: { date: string }[],
) {
  const n = weekdaysBetween(r.start, r.end, holidays).length;
  const isHalfDay = r.partial === "am" || r.partial === "pm";
  return isHalfDay ? n * 0.5 : n;
}

/**
 * Working days of a leave request that fall within a specific calendar year,
 * excluding weekends and company holidays consistently.
 * Handles requests crossing calendar years (e.g. Dec 2026 -> Jan 2027).
 */
export function leaveDaysInYear(
  r: Pick<LeaveRequest, "start" | "end"> & { partial?: DayPart | undefined },
  year: number,
  holidays?: { date: string }[],
): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  if (!r.start || !r.end || r.end < yearStart || r.start > yearEnd) return 0;
  const isHalfDay = r.partial === "am" || r.partial === "pm";
  if (isHalfDay) {
    return r.start >= yearStart && r.start <= yearEnd ? leaveDays(r, holidays) : 0;
  }
  const clampedStart = r.start < yearStart ? yearStart : r.start;
  const clampedEnd = r.end > yearEnd ? yearEnd : r.end;
  return weekdaysBetween(clampedStart, clampedEnd, holidays).length;
}

export function overlapsExisting(
  leaves: LeaveRequest[],
  memberId: string,
  i: { start: string; end: string },
  ignoreId?: string,
) {
  return leaves.find(
    (l) =>
      l.memberId === memberId &&
      l.id !== ignoreId &&
      l.status !== "rejected" &&
      l.start <= i.end &&
      l.end >= i.start,
  );
}

export function approvableLeaves(s: State, me: Member): LeaveRequest[] {
  if (me.role === "Employee") return [];
  const reports = new Set(directReportIds(s, me));
  return s.leaves.filter((l) => l.memberId !== me.id && reports.has(l.memberId));
}

export function canReviewLeave(s: State, me: Member, req: LeaveRequest) {
  if (me.role === "Employee" || req.memberId === me.id || req.status !== "pending") return false;
  return directReportIds(s, me).includes(req.memberId);
}

export function decideLeave(
  req: LeaveRequest,
  decision: "approved" | "rejected",
  comment: string,
  reviewerId: string,
): LeaveRequest {
  if (req.status !== "pending") throw new Error("Only pending requests can be reviewed");
  if (decision === "rejected" && comment.trim().length < 3)
    throw new Error("Add a reason when rejecting");
  return {
    ...req,
    status: decision,
    reviewComment: comment.trim() || undefined,
    reviewedBy: reviewerId,
  };
}

export function leaveBalance(s: State, memberId: string, year: number) {
  const entitlement = s.settings.leavePolicy?.yearlyAnnualLeave ?? ANNUAL_ENTITLEMENT;
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const mine = s.leaves.filter(
    (l) =>
      l.memberId === memberId && l.type === "annual" && l.start <= yearEnd && l.end >= yearStart,
  );
  const used = mine
    .filter((l) => l.status === "approved")
    .reduce((a, l) => a + leaveDaysInYear(l, year, s.holidays), 0);
  const pending = mine
    .filter((l) => l.status === "pending")
    .reduce((a, l) => a + leaveDaysInYear(l, year, s.holidays), 0);
  return {
    entitlement,
    used,
    pending,
    remaining: Math.max(0, entitlement - used),
    available: Math.max(0, entitlement - used - pending),
  };
}

export interface CategoryLeaveBalance {
  type: LeaveType;
  label: string;
  entitlement: number;
  used: number;
  pending: number;
  remaining: number;
  available: number;
  percentUsed: number;
  percentPending: number;
}

export function leaveTypeBalance(
  s: State,
  memberId: string,
  type: LeaveType,
  year: number,
): CategoryLeaveBalance {
  const policy = s.settings.leavePolicy;
  const entitlement =
    type === "annual"
      ? (policy?.yearlyAnnualLeave ?? ANNUAL_ENTITLEMENT)
      : type === "sick"
        ? (policy?.yearlySickLeave ?? SICK_ENTITLEMENT)
        : type === "personal"
          ? (policy?.yearlyPersonalLeave ?? PERSONAL_ENTITLEMENT)
          : (LEAVE_ENTITLEMENTS[type] ?? 0);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const mine = s.leaves.filter(
    (l) => l.memberId === memberId && l.type === type && l.start <= yearEnd && l.end >= yearStart,
  );
  const used = mine
    .filter((l) => l.status === "approved")
    .reduce((a, l) => a + leaveDaysInYear(l, year, s.holidays), 0);
  const pending = mine
    .filter((l) => l.status === "pending")
    .reduce((a, l) => a + leaveDaysInYear(l, year, s.holidays), 0);
  const remaining = Math.max(0, entitlement - used);
  const available = Math.max(0, entitlement - used - pending);
  const percentUsed = entitlement > 0 ? Math.min(100, Math.round((used / entitlement) * 100)) : 0;
  const percentPending =
    entitlement > 0 ? Math.min(100 - percentUsed, Math.round((pending / entitlement) * 100)) : 0;

  return {
    type,
    label: LEAVE_LABEL[type],
    entitlement,
    used,
    pending,
    remaining,
    available,
    percentUsed,
    percentPending,
  };
}

export function memberAllLeaveBalances(
  s: State,
  memberId: string,
  year: number,
): {
  annual: CategoryLeaveBalance;
  sick: CategoryLeaveBalance;
  personal: CategoryLeaveBalance;
} {
  return {
    annual: leaveTypeBalance(s, memberId, "annual", year),
    sick: leaveTypeBalance(s, memberId, "sick", year),
    personal: leaveTypeBalance(s, memberId, "personal", year),
  };
}

/**
 * Full leave submission validation including date rules, company holidays,
 * duplicate/overlap prevention, cross-year splits, and pending-inclusive available balance.
 */
export function validateLeaveSubmission(
  s: State,
  memberId: string,
  i: LeaveInput,
  today: string,
  ignoreId?: string,
): string | null {
  const err = validateLeave(i, today, s.holidays);
  if (err) return err;

  const overlap = overlapsExisting(s.leaves, memberId, i, ignoreId);
  if (overlap) {
    return `Conflicts with an existing ${overlap.status} request from ${overlap.start} to ${overlap.end}.`;
  }

  if (i.type !== "unpaid") {
    const startYear = Number(i.start.slice(0, 4));
    const endYear = Number(i.end.slice(0, 4));
    for (let yr = startYear; yr <= endYear; yr++) {
      const daysInYear = leaveDaysInYear(i, yr, s.holidays);
      if (daysInYear <= 0) continue;
      const bal = leaveTypeBalance(s, memberId, i.type, yr);
      if (daysInYear > bal.available) {
        const typeLabel = i.type === "sick" ? "sick leave" : i.type;
        const pendingInfo = bal.pending > 0 ? ` (${bal.pending}d pending)` : "";
        return `Insufficient ${typeLabel} balance${startYear !== endYear ? ` for ${yr}` : ""}: requesting ${daysInYear}d, available ${bal.available}d${pendingInfo}.`;
      }
    }
  }

  return null;
}

export interface StaffLeaveEntitlement {
  member: Member;
  monthlyPaidLeaveAccrual: number;
  accruedPaidLeaveToDate: number;
  annual: CategoryLeaveBalance;
  sick: CategoryLeaveBalance;
  personal: CategoryLeaveBalance;
  totalEntitlement: number;
  totalUsed: number;
  totalPending: number;
  totalRemaining: number;
  totalAvailable: number;
}

export function staffLeaveEntitlements(
  s: State,
  year = new Date().getFullYear(),
): StaffLeaveEntitlement[] {
  const accrual = calculateMonthlyAccrual(
    new Date(),
    s.settings.leavePolicy?.monthlyPaidLeaveAccrual ?? MONTHLY_PAID_LEAVE_ACCRUAL,
    s.settings.leavePolicy?.yearlyAnnualLeave ?? ANNUAL_ENTITLEMENT,
  );

  return s.members.map((m) => {
    const annual = leaveTypeBalance(s, m.id, "annual", year);
    const sick = leaveTypeBalance(s, m.id, "sick", year);
    const personal = leaveTypeBalance(s, m.id, "personal", year);

    const totalEntitlement = annual.entitlement + sick.entitlement + personal.entitlement;
    const totalUsed = annual.used + sick.used + personal.used;
    const totalPending = annual.pending + sick.pending + personal.pending;
    const totalRemaining = annual.remaining + sick.remaining + personal.remaining;
    const totalAvailable = annual.available + sick.available + personal.available;

    return {
      member: m,
      monthlyPaidLeaveAccrual: accrual.monthlyRate,
      accruedPaidLeaveToDate: accrual.accruedToDate,
      annual,
      sick,
      personal,
      totalEntitlement,
      totalUsed,
      totalPending,
      totalRemaining,
      totalAvailable,
    };
  });
}

export function leaveOn(leaves: LeaveRequest[], memberId: string, date: string) {
  return leaves.find(
    (l) => l.memberId === memberId && l.status !== "rejected" && l.start <= date && l.end >= date,
  );
}

// ---------- allocations ----------
export function dayLoad(allocs: Allocation[], memberId: string, date: string, excludeId?: string) {
  return allocs
    .filter((a) => a.memberId === memberId && a.date === date && a.id !== excludeId)
    .reduce((t, a) => t + a.hours, 0);
}

export function checkAllocation(
  s: State,
  draft: { id?: string | undefined; memberId: string; date: string; hours: number },
) {
  const capacity = s.settings.dailyTarget || 8;
  const total = dayLoad(s.allocations, draft.memberId, draft.date, draft.id) + draft.hours;
  const leave = leaveOn(s.leaves, draft.memberId, draft.date);
  return { total, capacity, exceeds: total > capacity, leave };
}

export function validateAllocationHours(h: number): string | null {
  if (!Number.isFinite(h) || h <= 0) return "Planned hours must be more than 0";
  if (h > 24) return "Planned hours cannot exceed 24";
  if (Math.abs(h * 4 - Math.round(h * 4)) > 1e-6) return "Use 15-minute steps (0.25)";
  return null;
}

export interface Conflict {
  memberId: string;
  date: string;
  kind: "over-capacity" | "on-leave";
  detail: string;
}

export function findConflicts(s: State, memberIds?: string[], projectIds?: string[]): Conflict[] {
  const capacity = s.settings.dailyTarget || 8;
  const scope = memberIds ? new Set(memberIds) : null;
  const projScope = projectIds ? new Set(projectIds) : null;
  const byKey = new Map<string, number>();
  for (const a of s.allocations) {
    if (scope && !scope.has(a.memberId)) continue;
    if (projScope && !projScope.has(a.projectId)) continue;
    const k = `${a.memberId}|${a.date}`;
    byKey.set(k, (byKey.get(k) ?? 0) + a.hours);
  }
  const out: Conflict[] = [];
  for (const [k, total] of byKey) {
    const [memberId = "", date = ""] = k.split("|");
    if (total > capacity)
      out.push({
        memberId,
        date,
        kind: "over-capacity",
        detail: `${total}h planned vs ${capacity}h capacity`,
      });
    const l = leaveOn(s.leaves, memberId, date);
    if (l)
      out.push({
        memberId,
        date,
        kind: "on-leave",
        detail: `${total}h planned during ${l.status} ${LEAVE_LABEL[l.type].toLowerCase()}`,
      });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
