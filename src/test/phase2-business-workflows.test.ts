import { beforeEach, describe, expect, it } from "vitest";
import {
  getState,
  resetDemo,
  endDemoSession,
  addLeave,
  setLeave,
  removeLeave,
  upsertAllocation,
  removeAllocation,
  addAuditLog,
  bulkReviewTimesheets,
  bulkReviewLeaves,
  type LeaveRequest,
  type Allocation,
} from "@/lib/demo-store";
import {
  validateLeave,
  leaveDays,
  leaveBalance,
  memberAllLeaveBalances,
  overlapsExisting,
  canReviewLeave,
  decideLeave,
  directReportIds,
  approvableLeaves,
  checkAllocation,
  validateAllocationHours,
  findConflicts,
  teamIds,
  scopedMembers,
  scopedProjects,
  scopedTimesheets,
  scopedLeaves,
  approvableTimesheets,
  canApproveTimesheet,
  canEditAllocation,
} from "@/lib/rules";
import { isoDay } from "@/lib/time";
import { addDays, parseISO } from "date-fns";

beforeEach(() => {
  window.localStorage.clear();
  resetDemo();
  endDemoSession();
});

describe("Phase 2 - Leave Management Workflows", () => {
  const today = isoDay(new Date());

  it("validates leave input constraints correctly", () => {
    // Missing dates
    expect(
      validateLeave({ type: "annual", start: "", end: "", partial: "full", reason: "" }, today),
    ).toBe("Choose a start and end date");

    // End date before start date
    expect(
      validateLeave(
        { type: "annual", start: "2026-11-10", end: "2026-11-05", partial: "full", reason: "" },
        today,
      ),
    ).toBe("End date cannot be before the start date");

    // Half day spanning multiple dates
    expect(
      validateLeave(
        { type: "annual", start: "2026-11-10", end: "2026-11-12", partial: "am", reason: "" },
        today,
      ),
    ).toBe("Half days apply to single-day requests only");

    // Unpaid leave requires a reason
    expect(
      validateLeave(
        { type: "unpaid", start: "2026-11-10", end: "2026-11-10", partial: "full", reason: "" },
        today,
      ),
    ).toBe("Add a reason for unpaid leave");

    // Backdated annual leave is rejected
    expect(
      validateLeave(
        { type: "annual", start: "2020-01-01", end: "2020-01-02", partial: "full", reason: "Trip" },
        today,
      ),
    ).toBe("Only sick leave can be backdated");
  });

  it("calculates working days and half days accurately", () => {
    // 1 working day full
    expect(leaveDays({ start: "2026-11-02", end: "2026-11-02", partial: "full" })).toBe(1);
    // 1 working day half
    expect(leaveDays({ start: "2026-11-02", end: "2026-11-02", partial: "am" })).toBe(0.5);
    // Mon to Fri = 5 days
    expect(leaveDays({ start: "2026-11-02", end: "2026-11-06", partial: "full" })).toBe(5);
    // Sat to Sun = 0 days
    expect(leaveDays({ start: "2026-11-07", end: "2026-11-08", partial: "full" })).toBe(0);
  });

  it("detects overlapping leave requests for an employee", () => {
    const s = getState();
    const existing: LeaveRequest = {
      id: "test_leave_1",
      memberId: "m2",
      type: "annual",
      start: "2026-11-10",
      end: "2026-11-15",
      partial: "full",
      reason: "Holiday",
      status: "approved",
      createdAt: today,
    };
    addLeave(existing);

    const overlap = overlapsExisting(getState().leaves, "m2", {
      start: "2026-11-12",
      end: "2026-11-18",
    });
    expect(overlap).toBeDefined();
    expect(overlap?.id).toBe("test_leave_1");

    // Non-overlapping date
    const noOverlap = overlapsExisting(getState().leaves, "m2", {
      start: "2026-11-20",
      end: "2026-11-25",
    });
    expect(noOverlap).toBeUndefined();
  });

  it("computes annual entitlement and remaining leave balance", () => {
    const s = getState();
    const bal = leaveBalance(s, "m2", new Date().getFullYear());
    expect(bal.entitlement).toBe(18);
    expect(bal.used).toBeGreaterThanOrEqual(0);
    expect(bal.remaining).toBe(18 - bal.used);
  });

  it("computes annual, sick, and personal entitlements and remaining balances with progress percentages", () => {
    const s = getState();
    const year = new Date().getFullYear();
    const balances = memberAllLeaveBalances(s, "m2", year);

    // Entitlements
    expect(balances.annual.entitlement).toBe(18);
    expect(balances.sick.entitlement).toBe(10);
    expect(balances.personal.entitlement).toBe(5);

    // Remaining calculations
    expect(balances.annual.remaining).toBe(18 - balances.annual.used);
    expect(balances.sick.remaining).toBe(10 - balances.sick.used);
    expect(balances.personal.remaining).toBe(5 - balances.personal.used);

    // Utilization percentages
    expect(balances.annual.percentUsed).toBeGreaterThanOrEqual(0);
    expect(balances.annual.percentUsed).toBeLessThanOrEqual(100);
    expect(balances.sick.percentUsed).toBeGreaterThanOrEqual(0);
    expect(balances.sick.percentUsed).toBeLessThanOrEqual(100);
    expect(balances.personal.percentUsed).toBeGreaterThanOrEqual(0);
    expect(balances.personal.percentUsed).toBeLessThanOrEqual(100);
  });

  it("dynamically updates used and pending leave progress when leaves are added or approved", () => {
    const memberId = "m2";
    const year = new Date().getFullYear();
    const initial = memberAllLeaveBalances(getState(), memberId, year);

    // Add a pending sick leave request of 2 days
    const reqId = "test_sick_leave_progress";
    const newSickReq: LeaveRequest = {
      id: reqId,
      memberId,
      type: "sick",
      start: `${year}-09-07`, // Mon
      end: `${year}-09-08`, // Tue (2 weekdays)
      partial: "full",
      reason: "Flu recovery",
      status: "pending",
      createdAt: today,
    };
    addLeave(newSickReq);

    const withPending = memberAllLeaveBalances(getState(), memberId, year);
    expect(withPending.sick.pending).toBe(initial.sick.pending + 2);
    expect(withPending.sick.percentPending).toBe(
      Math.round(((initial.sick.pending + 2) / 10) * 100),
    );

    // Now approve the leave request
    const approvedReq = decideLeave(newSickReq, "approved", "Approved by manager", "m1");
    setLeave(approvedReq);

    const withApproved = memberAllLeaveBalances(getState(), memberId, year);
    expect(withApproved.sick.used).toBe(initial.sick.used + 2);
    expect(withApproved.sick.pending).toBe(initial.sick.pending);
    expect(withApproved.sick.remaining).toBe(10 - (initial.sick.used + 2));
    expect(withApproved.sick.percentUsed).toBe(Math.round(((initial.sick.used + 2) / 10) * 100));
  });

  it("handles leave approval and rejection with comment validation", () => {
    const req: LeaveRequest = {
      id: "req_test",
      memberId: "m2",
      type: "annual",
      start: "2026-12-01",
      end: "2026-12-03",
      partial: "full",
      reason: "Winter break",
      status: "pending",
      createdAt: today,
    };

    // Rejection without comment throws
    expect(() => decideLeave(req, "rejected", "", "m1")).toThrow();

    // Rejection with valid reason
    const rejected = decideLeave(req, "rejected", "Project release week", "m1");
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewComment).toBe("Project release week");
    expect(rejected.reviewedBy).toBe("m1");

    // Approval
    const approved = decideLeave(req, "approved", "Have fun!", "m1");
    expect(approved.status).toBe("approved");
    expect(approved.reviewedBy).toBe("m1");
  });

  it("filters leave requests strictly to employees reporting to the logged-in manager", () => {
    const s = getState();
    const managerPriya = s.members.find((m) => m.id === "m1")!;
    const managerEmily = s.members.find((m) => m.id === "m5")!;
    const employeeArjun = s.members.find((m) => m.id === "m2")!;
    const adminVikram = s.members.find((m) => m.id === "m6")!;

    // Arjun (m2) reports to Priya (m1)
    const priyaReports = directReportIds(s, managerPriya);
    expect(priyaReports).toContain("m2");
    expect(priyaReports).not.toContain("m1"); // Self excluded

    // Rahul (m4) reports to Emily (m5)
    const emilyReports = directReportIds(s, managerEmily);
    expect(emilyReports).toContain("m4");
    expect(emilyReports).not.toContain("m2"); // Arjun does not report to Emily

    // Approvable leaves for Priya only contain requests from her direct team
    const priyaApprovable = approvableLeaves(s, managerPriya);
    expect(priyaApprovable.every((l) => priyaReports.includes(l.memberId))).toBe(true);

    // Priya cannot review her own leave request
    const ownLeaveReq: LeaveRequest = {
      id: "priya_own_leave",
      memberId: "m1",
      type: "annual",
      start: "2026-11-20",
      end: "2026-11-22",
      partial: "full",
      reason: "Personal",
      status: "pending",
      createdAt: today,
    };
    expect(canReviewLeave(s, managerPriya, ownLeaveReq)).toBe(false);

    // Priya CAN review Arjun's pending leave request
    const arjunReq = s.leaves.find((l) => l.memberId === "m2" && l.status === "pending")!;
    expect(canReviewLeave(s, managerPriya, arjunReq)).toBe(true);

    // Employee cannot review anyone's leave
    expect(canReviewLeave(s, employeeArjun, arjunReq)).toBe(false);

    // Admin can review company leave (excluding own)
    expect(canReviewLeave(s, adminVikram, arjunReq)).toBe(true);
  });

  it("supports bulk review of team leave requests with audit logging", () => {
    const s = getState();
    const managerPriya = s.members.find((m) => m.id === "m1")!;
    const pendingIds = approvableLeaves(s, managerPriya)
      .filter((l) => l.status === "pending")
      .map((l) => l.id);

    expect(pendingIds.length).toBeGreaterThan(0);

    bulkReviewLeaves(pendingIds, "approved", managerPriya.id, managerPriya.name, "Bulk approved");

    const updatedState = getState();
    pendingIds.forEach((id) => {
      const lv = updatedState.leaves.find((l) => l.id === id);
      expect(lv?.status).toBe("approved");
      expect(lv?.reviewedBy).toBe(managerPriya.id);
    });

    const recentAudit = updatedState.auditLogs.find(
      (a) => a.category === "leave" && a.action === "Leave Approved",
    );
    expect(recentAudit).toBeDefined();
    expect(recentAudit?.actorId).toBe(managerPriya.id);
  });
});

describe("Phase 2 - Resource Planning & Conflict Management", () => {
  it("validates allocation hours format and steps", () => {
    expect(validateAllocationHours(0)).toBe("Planned hours must be more than 0");
    expect(validateAllocationHours(-5)).toBe("Planned hours must be more than 0");
    expect(validateAllocationHours(25)).toBe("Planned hours cannot exceed 24");
    // Invalid step (e.g. 0.33)
    expect(validateAllocationHours(4.33)).toBe("Use 15-minute steps (0.25)");
    // Valid 0.25 steps
    expect(validateAllocationHours(4.25)).toBeNull();
    expect(validateAllocationHours(8)).toBeNull();
  });

  it("detects over-capacity allocation conflicts", () => {
    const s = getState();
    const date = "2026-11-05";

    // Adding 5h + 5h = 10h (exceeds default 8h)
    const a1: Allocation = {
      id: "alloc_1",
      memberId: "m3",
      projectId: "p1",
      date,
      hours: 5,
      status: "confirmed",
    };
    const a2: Allocation = {
      id: "alloc_2",
      memberId: "m3",
      projectId: "p2",
      date,
      hours: 5,
      status: "confirmed",
    };
    upsertAllocation(a1);
    upsertAllocation(a2);

    const conflicts = findConflicts(getState(), ["m3"]);
    const overCap = conflicts.find(
      (c) => c.memberId === "m3" && c.date === date && c.kind === "over-capacity",
    );
    expect(overCap).toBeDefined();
    expect(overCap?.kind).toBe("over-capacity");
    expect(overCap?.detail).toContain("vs 8h capacity");
  });

  it("detects conflicts when allocating work during approved leave", () => {
    const date = "2026-11-18";
    const leave: LeaveRequest = {
      id: "l_test_conflict",
      memberId: "m4",
      type: "annual",
      start: date,
      end: date,
      partial: "full",
      reason: "Vacation",
      status: "approved",
      createdAt: isoDay(new Date()),
    };
    addLeave(leave);

    const alloc: Allocation = {
      id: "a_test_conflict",
      memberId: "m4",
      projectId: "p1",
      date,
      hours: 8,
      status: "confirmed",
    };
    upsertAllocation(alloc);

    const conflicts = findConflicts(getState(), ["m4"]);
    const onLeave = conflicts.find(
      (c) => c.memberId === "m4" && c.date === date && c.kind === "on-leave",
    );
    expect(onLeave).toBeDefined();
    expect(onLeave?.detail).toContain("planned during approved annual leave");
  });
});

describe("Phase 2 - Permission Scoping & Access Control", () => {
  it("enforces Employee data isolation", () => {
    const s = getState();
    const employee = s.members.find((m) => m.role === "Employee")!;
    expect(employee).toBeDefined();

    // Employee team view should contain ONLY themselves
    const members = scopedMembers(s, employee);
    expect(members).toHaveLength(1);
    expect(members[0]?.id).toBe(employee.id);

    // Employee timesheets should only be their own
    const timesheets = scopedTimesheets(s, employee);
    expect(timesheets.every((t) => t.memberId === employee.id)).toBe(true);

    // Employee leaves should only be their own
    const leaves = scopedLeaves(s, employee);
    expect(leaves.every((l) => l.memberId === employee.id)).toBe(true);

    // Employee cannot approve any timesheets
    const approvable = approvableTimesheets(s, employee);
    expect(approvable).toHaveLength(0);
  });

  it("enforces Manager team and project boundary", () => {
    const s = getState();
    const manager = s.members.find((m) => m.role === "Manager")!;
    expect(manager).toBeDefined();

    const tIds = teamIds(s, manager);
    expect(tIds).toContain(manager.id);

    // Manager can only see projects they lead
    const projects = scopedProjects(s, manager);
    projects.forEach((p) => {
      expect(p.managerId).toBe(manager.id);
    });

    // Manager cannot approve their own timesheet
    const approvable = approvableTimesheets(s, manager);
    expect(approvable.every((t) => t.memberId !== manager.id)).toBe(true);

    // Manager cannot approve timesheet of someone outside their managed scope
    const outsider = s.members.find((m) => !tIds.includes(m.id));
    if (outsider) {
      const outsiderSheet = s.timesheets.find(
        (t) => t.memberId === outsider.id && t.status === "submitted",
      );
      if (outsiderSheet) {
        expect(canApproveTimesheet(s, manager, outsiderSheet.id)).toBe(false);
      }
    }
  });

  it("prevents self-review of leave requests", () => {
    const s = getState();
    const manager = s.members.find((m) => m.role === "Manager")!;
    const myLeave: LeaveRequest = {
      id: "l_mgr_self",
      memberId: manager.id,
      type: "annual",
      start: "2026-11-20",
      end: "2026-11-21",
      partial: "full",
      reason: "Conference",
      status: "pending",
      createdAt: isoDay(new Date()),
    };
    expect(canReviewLeave(s, manager, myLeave)).toBe(false);
  });
});

describe("Phase 2 - Audit Trail Logging", () => {
  it("records and filters audit logs across multiple business categories", () => {
    addAuditLog({
      actorId: "m1",
      actorName: "Priya Sharma",
      action: "Leave Approved",
      category: "leave",
      details: "Approved Devon Vance's 3d annual leave",
    });

    addAuditLog({
      actorId: "m5",
      actorName: "Kavita Rao",
      action: "Allocation Scheduled",
      category: "allocation",
      details: "Assigned Rohan Verma for 8h on Mobile App Redesign",
    });

    const s = getState();
    const leaveLog = s.auditLogs.find((l) => l.action === "Leave Approved");
    expect(leaveLog).toBeDefined();
    expect(leaveLog?.category).toBe("leave");

    const allocLog = s.auditLogs.find((l) => l.action === "Allocation Scheduled");
    expect(allocLog).toBeDefined();
    expect(allocLog?.category).toBe("allocation");
  });
});
