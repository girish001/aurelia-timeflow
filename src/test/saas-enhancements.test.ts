import { beforeEach, describe, expect, it } from "vitest";
import {
  copyPreviousWeek,
  bulkReviewTimesheets,
  addAuditLog,
  markNotificationRead,
  markAllNotificationsRead,
  getState,
  resetDemo,
  endDemoSession,
  uid,
} from "@/lib/demo-store";
import { weekKey } from "@/lib/time";
import { addWeeks, parseISO, subWeeks } from "date-fns";

beforeEach(() => {
  window.localStorage.clear();
  resetDemo();
  endDemoSession();
});

describe("Phase 1 - Enterprise SaaS features and helpers", () => {
  it("copies entries from previous week with zero hours", () => {
    const now = new Date();
    const thisWeek = weekKey(now);
    const nextWeek = weekKey(addWeeks(now, 1));

    // Next week initially has no timesheet
    const success = copyPreviousWeek(nextWeek, "m2");
    expect(success).toBe(true);

    const s = getState();
    const sheet = s.timesheets.find((t) => t.memberId === "m2" && t.weekStart === nextWeek);
    expect(sheet).toBeDefined();
    expect(sheet?.entries.length).toBeGreaterThan(0);
    // All hours must be initialized to 0
    sheet?.entries.forEach((e) => {
      expect(e.hours.every((h) => h === 0)).toBe(true);
    });
  });

  it("handles bulk approval of submitted timesheets with audit logging", () => {
    const s = getState();
    const submitted = s.timesheets.filter((t) => t.status === "submitted");
    expect(submitted.length).toBeGreaterThan(0);

    const idsToApprove = submitted.slice(0, 2).map((t) => t.id);
    bulkReviewTimesheets(idsToApprove, "approved", "m1", "Priya Sharma", "Bulk approval test note");

    const updated = getState();
    idsToApprove.forEach((id) => {
      const ts = updated.timesheets.find((t) => t.id === id);
      expect(ts?.status).toBe("approved");
      expect(ts?.reviewComment).toBe("Bulk approval test note");
    });

    // Check that audit logs were appended
    const auditLogs = updated.auditLogs.filter((l) => l.actorId === "m1");
    expect(auditLogs.length).toBeGreaterThanOrEqual(2);
  });

  it("adds and records audit log items correctly", () => {
    addAuditLog({
      actorId: "m6",
      actorName: "Vikram Joshi",
      action: "Client Contract Signed",
      category: "client",
      details: "Client Northwind Retail upgraded service tier",
    });

    const s = getState();
    const found = s.auditLogs.find((l) => l.action === "Client Contract Signed");
    expect(found).toBeDefined();
    expect(found?.actorName).toBe("Vikram Joshi");
    expect(found?.details).toContain("Northwind Retail");
  });

  it("manages notification read state", () => {
    const s = getState();
    const notif = s.notifications[0];
    expect(notif).toBeDefined();

    if (notif) {
      markNotificationRead(notif.id);
      expect(getState().notifications.find((n) => n.id === notif.id)?.read).toBe(true);
    }

    markAllNotificationsRead("m1");
    const m1Notifs = getState().notifications.filter(
      (n) => n.recipientId === "m1" || n.recipientId === "all",
    );
    expect(m1Notifs.every((n) => n.read)).toBe(true);
  });
});
