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
  | "profile";

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
  "settings",
  "profile",
];

export const canAccess = (role: Role, page: Page) => ACCESS[page].includes(role);
export const navFor = (role: Role) => NAV_ORDER.filter((p) => canAccess(role, p));

export function pageFromPath(path: string): Page | null {
  const seg = path.replace(/^\/app\/?/, "").split("/")[0] ?? "";
  if (!seg) return "overview";
  return seg in ACCESS ? (seg as Page) : null;
}

// ---------- scope ----------
export function managedProjectIds(s: State, meId: string) {
  return s.projects.filter((p) => p.managerId === meId).map((p) => p.id);
}

/** Members whose data the persona may see. */
export function teamIds(s: State, me: Member): string[] {
  if (me.role === "Admin") return s.members.map((m) => m.id);
  if (me.role === "Employee") return [me.id];
  const pids = new Set(managedProjectIds(s, me.id));
  const ids = new Set<string>([me.id]);
  s.allocations.forEach((a) => pids.has(a.projectId) && ids.add(a.memberId));
  s.timesheets.forEach((t) => t.entries.some((e) => pids.has(e.projectId)) && ids.add(t.memberId));
  return s.members.filter((m) => ids.has(m.id)).map((m) => m.id);
}

export function scopedProjects(s: State, me: Member): Project[] {
  if (me.role === "Admin") return s.projects;
  if (me.role === "Manager") return s.projects.filter((p) => p.managerId === me.id);
  const ids = new Set(s.allocations.filter((a) => a.memberId === me.id).map((a) => a.projectId));
  return s.projects.filter((p) => ids.has(p.id));
}

export function approvableTimesheets(s: State, me: Member): Timesheet[] {
  if (me.role === "Employee") return [];
  const team = new Set(teamIds(s, me));
  return s.timesheets.filter((t) => t.memberId !== me.id && team.has(t.memberId));
}

export function canEditAllocation(s: State, me: Member, projectId: string) {
  if (me.role === "Admin") return true;
  if (me.role === "Manager") return s.projects.find((p) => p.id === projectId)?.managerId === me.id;
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

export interface LeaveInput {
  type: LeaveType;
  start: string;
  end: string;
  partial: DayPart;
  reason: string;
}

export function validateLeave(i: LeaveInput, today: string): string | null {
  if (!i.start || !i.end) return "Choose a start and end date";
  if (i.end < i.start) return "End date cannot be before the start date";
  if (i.partial !== "full" && i.start !== i.end)
    return "Half days apply to single-day requests only";
  if (differenceInCalendarDays(parseISO(i.end), parseISO(i.start)) > 30)
    return "Requests are limited to 31 days";
  if (i.type !== "sick" && i.start < today) return "Only sick leave can be backdated";
  if (weekdaysBetween(i.start, i.end).length === 0) return "The selected range has no working days";
  if (i.type === "unpaid" && i.reason.trim().length < 3) return "Add a reason for unpaid leave";
  if (i.reason.length > 300) return "Reason must be under 300 characters";
  return null;
}

export function weekdaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  if (!start || !end || end < start) return out;
  for (let d = parseISO(start); isoDay(d) <= end; d = addDays(d, 1))
    if (!isWeekend(d)) out.push(isoDay(d));
  return out;
}

export function leaveDays(r: Pick<LeaveRequest, "start" | "end" | "partial">) {
  const n = weekdaysBetween(r.start, r.end).length;
  return r.partial === "full" ? n : n * 0.5;
}

export function overlapsExisting(
  leaves: LeaveRequest[],
  memberId: string,
  i: { start: string; end: string },
) {
  return leaves.find(
    (l) =>
      l.memberId === memberId && l.status !== "rejected" && l.start <= i.end && l.end >= i.start,
  );
}

export function canReviewLeave(s: State, me: Member, req: LeaveRequest) {
  if (me.role === "Employee" || req.memberId === me.id || req.status !== "pending") return false;
  return teamIds(s, me).includes(req.memberId);
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
  const mine = s.leaves.filter(
    (l) => l.memberId === memberId && l.type === "annual" && l.start.startsWith(String(year)),
  );
  const used = mine.filter((l) => l.status === "approved").reduce((a, l) => a + leaveDays(l), 0);
  const pending = mine.filter((l) => l.status === "pending").reduce((a, l) => a + leaveDays(l), 0);
  return { entitlement: ANNUAL_ENTITLEMENT, used, pending, remaining: ANNUAL_ENTITLEMENT - used };
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
  draft: { id?: string; memberId: string; date: string; hours: number },
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

export function findConflicts(s: State, memberIds?: string[]): Conflict[] {
  const capacity = s.settings.dailyTarget || 8;
  const scope = memberIds ? new Set(memberIds) : null;
  const byKey = new Map<string, number>();
  for (const a of s.allocations) {
    if (scope && !scope.has(a.memberId)) continue;
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
