import { describe, expect, it, beforeEach } from "vitest";
import {
  resetDemo,
  getState,
  startDemoSession,
  reviewTimesheet,
  bulkReviewTimesheets,
  bulkReviewLeaves,
  type LeaveRequest,
} from "@/lib/demo-store";
import {
  scopedProjects,
  canEditAllocation,
  findConflicts,
  leaveDays,
  leaveDaysInYear,
  leaveTypeBalance,
  validateLeaveSubmission,
} from "@/lib/rules";

describe("Phase 3: Resource Planning Scope, Filters & Permissions", () => {
  beforeEach(() => {
    resetDemo();
  });

  it("Manager project scope does NOT fall back to all active projects when manager owns none", () => {
    const s = getState();
    const managerNoProjects = {
      id: "m_unassigned_mgr",
      name: "Unassigned Manager",
      email: "unassigned@aurelia.io",
      title: "Engineering Manager",
      role: "Manager" as const,
      status: "active" as const,
    };
    const scoped = scopedProjects(s, managerNoProjects);
    expect(scoped).toHaveLength(0);
  });

  it("Manager only sees projects where managerId matches their ID, Admin sees all", () => {
    const s = getState();
    const manager = s.members.find((m) => m.id === "m1")!; // Priya Sharma (Manager)
    const admin = s.members.find((m) => m.id === "m6")!; // Vikram Joshi (Admin)

    const mgrProjects = scopedProjects(s, manager);
    expect(mgrProjects.length).toBeGreaterThan(0);
    expect(mgrProjects.every((p) => p.managerId === manager.id)).toBe(true);

    const adminProjects = scopedProjects(s, admin);
    expect(adminProjects.length).toBe(s.projects.length);
  });

  it("canEditAllocation validates BOTH project ownership and employee team membership for Manager", () => {
    const s = getState();
    const manager = s.members.find((m) => m.id === "m1")!; // Priya Sharma manages p1 and m2, m3
    const managedProject = s.projects.find((p) => p.managerId === manager.id)!;
    const unmanagedProject = s.projects.find((p) => p.managerId !== manager.id)!;

    // Valid: managed project + direct report (m2)
    expect(canEditAllocation(s, manager, managedProject.id, "m2")).toBe(true);
    // Valid: managed project + self (m1)
    expect(canEditAllocation(s, manager, managedProject.id, "m1")).toBe(true);
    // Invalid: managed project + member outside manager's team (m4 reports to m5 and works on p2/p3)
    expect(canEditAllocation(s, manager, managedProject.id, "m4")).toBe(false);
    // Invalid: unmanaged project + direct report (m2)
    expect(canEditAllocation(s, manager, unmanagedProject.id, "m2")).toBe(false);
  });

  it("findConflicts respects both memberIds and projectIds scope filters", () => {
    const s = getState();
    const allConflicts = findConflicts(s);
    // Filtering to a non-existent project should yield 0 conflicts within that project scope
    const emptyScopeConflicts = findConflicts(s, undefined, ["non_existent_project"]);
    expect(emptyScopeConflicts).toHaveLength(0);

    // Filtering to all project IDs matches unfiltered conflicts
    const allProjectIds = s.projects.map((p) => p.id);
    const fullProjectScopeConflicts = findConflicts(s, undefined, allProjectIds);
    expect(fullProjectScopeConflicts.length).toBe(allConflicts.length);
  });
});

describe("Phase 4: Leave Management Working Days, Holidays, Cross-Year & Available Balance", () => {
  beforeEach(() => {
    resetDemo();
  });

  it("excludes weekends and company holidays consistently in leaveDays and leaveDaysInYear", () => {
    const s = getState();
    const year = new Date().getFullYear();
    // Jan 26 is Republic Day in seed holidays
    const req: LeaveRequest = {
      id: "l_test_holiday",
      memberId: "m3",
      type: "annual",
      start: `${year}-01-26`,
      end: `${year}-01-30`,
      partial: "full",
      reason: "Family trip",
      status: "approved",
      createdAt: `${year}-01-05`,
    };

    const withoutHolidays = leaveDays(req, []);
    const withHolidays = leaveDays(req, s.holidays);
    expect(withHolidays).toBe(withoutHolidays - 1);
    expect(leaveDaysInYear(req, year, s.holidays)).toBe(withHolidays);
  });

  it("correctly splits cross-year annual leave requests by calendar year", () => {
    const crossYearReq: LeaveRequest = {
      id: "l_cross_year",
      memberId: "m3",
      type: "annual",
      start: "2025-12-29", // Mon Dec 29, Tue Dec 30, Wed Dec 31 in 2025 (3 weekdays)
      end: "2026-01-02", // Thu Jan 1, Fri Jan 2 in 2026 (2 weekdays)
      partial: "full",
      reason: "Year-end vacation",
      status: "approved",
      createdAt: "2025-12-01",
    };

    expect(leaveDaysInYear(crossYearReq, 2025, [])).toBe(3);
    expect(leaveDaysInYear(crossYearReq, 2026, [])).toBe(2);
    // If 2026-01-01 is a New Year's Day holiday, 2026 only counts 1 day:
    expect(
      leaveDaysInYear(crossYearReq, 2026, [
        { id: "h_ny", name: "New Year's Day", date: "2026-01-01" },
      ]),
    ).toBe(1);
  });

  it("calculates half-day requests accurately as 0.5 days on a working day and 0 on a holiday/weekend", () => {
    const s = getState();
    const year = new Date().getFullYear();
    const workingHalfDay: LeaveRequest = {
      id: "l_half_work",
      memberId: "m3",
      type: "personal",
      start: "2026-06-04", // Thursday
      end: "2026-06-04",
      partial: "am",
      reason: "Dentist appointment",
      status: "approved",
      createdAt: "2026-06-01",
    };
    expect(leaveDays(workingHalfDay, s.holidays)).toBe(0.5);

    const holidayHalfDay: LeaveRequest = {
      ...workingHalfDay,
      id: "l_half_hol",
      start: `${year}-01-26`, // Republic Day holiday in seed data
      end: `${year}-01-26`,
    };
    expect(leaveDays(holidayHalfDay, s.holidays)).toBe(0);
  });

  it("includes pending requests in available balance and prevents over-booking or overlapping requests", () => {
    const s = getState();
    const year = new Date().getFullYear();
    // m2 has a pending annual leave request in seed data for current year
    const m2Annual = leaveTypeBalance(s, "m2", "annual", year);
    expect(m2Annual.pending).toBeGreaterThan(0);
    expect(m2Annual.available).toBe(
      Math.max(0, m2Annual.entitlement - m2Annual.used - m2Annual.pending),
    );
    expect(m2Annual.available).toBeLessThan(m2Annual.remaining);

    // Attempting to submit an overlapping request for m2 should fail
    const existingPending = s.leaves.find((l) => l.memberId === "m2" && l.status === "pending")!;
    const overlapErr = validateLeaveSubmission(
      s,
      "m2",
      {
        type: "annual",
        start: existingPending.start,
        end: existingPending.end,
        partial: "full",
        reason: "Duplicate dates",
      },
      `${year}-01-01`,
    );
    expect(overlapErr).toMatch(/conflicts with an existing/i);

    // Attempting to book more annual days than available (when considering pending) should fail
    const excessiveErr = validateLeaveSubmission(
      s,
      "m2",
      {
        type: "annual",
        start: `${year}-09-01`,
        end: `${year}-09-28`, // ~20 working days > available
        partial: "full",
        reason: "Long vacation",
      },
      `${year}-01-01`,
    );
    expect(excessiveErr).toMatch(/insufficient annual balance/i);

    // Unpaid leave is not blocked by paid entitlement limits
    const unpaidErr = validateLeaveSubmission(
      s,
      "m2",
      {
        type: "unpaid",
        start: `${year}-12-01`,
        end: `${year}-12-04`,
        partial: "full",
        reason: "Sabbatical extension",
      },
      `${year}-01-01`,
    );
    expect(unpaidErr).toBeNull();
  });
});

describe("Phase 5: Audit Trail & Notification Consistency", () => {
  beforeEach(() => {
    resetDemo();
    startDemoSession("m6");
  });

  it("records audit log events for individual timesheet approvals and rejections", () => {
    const beforeCount = getState().auditLogs.length;
    const submittedSheet = getState().timesheets.find((t) => t.status === "submitted")!;

    reviewTimesheet(submittedSheet.id, "approved", "Verified hours", "m6", "Vikram Joshi");

    const afterState = getState();
    expect(afterState.auditLogs.length).toBe(beforeCount + 1);
    expect(afterState.auditLogs[0].category).toBe("approval");
    expect(afterState.auditLogs[0].action).toBe("Timesheet Approved");
    expect(afterState.auditLogs[0].actorName).toBe("Vikram Joshi");
  });

  it("records audit log events for bulk timesheet and bulk leave decisions", () => {
    const s = getState();
    const tsIds = s.timesheets.filter((t) => t.status === "submitted").map((t) => t.id);
    const beforeLogs = s.auditLogs.length;

    bulkReviewTimesheets(tsIds, "approved", "m6", "Vikram Joshi", "Bulk approved");
    expect(getState().auditLogs.length).toBe(beforeLogs + tsIds.length);

    const leaveIds = getState()
      .leaves.filter((l) => l.status === "pending")
      .map((l) => l.id);
    const midLogs = getState().auditLogs.length;

    bulkReviewLeaves(leaveIds, "rejected", "m6", "Vikram Joshi", "Quarter close freeze");
    expect(getState().auditLogs.length).toBe(midLogs + leaveIds.length);
    expect(getState().auditLogs[0].action).toBe("Leave Rejected");
  });
});
