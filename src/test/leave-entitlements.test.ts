import { describe, it, expect } from "vitest";
import {
  calculateMonthlyAccrual,
  weekdaysBetween,
  leaveDays,
  validateLeave,
  staffLeaveEntitlements,
  MONTHLY_PAID_LEAVE_ACCRUAL,
  ANNUAL_ENTITLEMENT,
  SICK_ENTITLEMENT,
  PERSONAL_ENTITLEMENT,
} from "@/lib/rules";
import { createSeed, getDefaultHolidays } from "@/lib/demo-store";

describe("Staff Leave Entitlements & Policy", () => {
  it("calculates monthly Paid Leave (PL) accrual at 1.5 days per month", () => {
    // January (month = 1)
    const janDate = new Date(2026, 0, 15);
    const janAccrual = calculateMonthlyAccrual(janDate);
    expect(janAccrual.monthlyRate).toBe(1.5);
    expect(janAccrual.accruedToDate).toBe(1.5);

    // June (month = 6)
    const junDate = new Date(2026, 5, 10);
    const junAccrual = calculateMonthlyAccrual(junDate);
    expect(junAccrual.accruedToDate).toBe(9.0);

    // October (month = 10)
    const octDate = new Date(2026, 9, 29);
    const octAccrual = calculateMonthlyAccrual(octDate);
    expect(octAccrual.accruedToDate).toBe(15.0);

    // December (month = 12) -> hits 18.0 days annual max
    const decDate = new Date(2026, 11, 31);
    const decAccrual = calculateMonthlyAccrual(decDate);
    expect(decAccrual.accruedToDate).toBe(18.0);
    expect(decAccrual.annualMax).toBe(ANNUAL_ENTITLEMENT);
  });

  it("provides standard entitlements: 18d annual PL, 10d yearly Sick Leave, 5d Personal Leave", () => {
    expect(ANNUAL_ENTITLEMENT).toBe(18);
    expect(SICK_ENTITLEMENT).toBe(10);
    expect(PERSONAL_ENTITLEMENT).toBe(5);
    expect(MONTHLY_PAID_LEAVE_ACCRUAL).toBe(1.5);
  });

  it("loads 13 official company holidays for the calendar year", () => {
    const holidays = getDefaultHolidays(2026);
    expect(holidays.length).toBe(13);

    // Key national & festival holidays
    const names = holidays.map((h) => h.name);
    expect(names).toContain("Republic Day");
    expect(names).toContain("Independence Day");
    expect(names).toContain("Mahatma Gandhi Jayanti");
    expect(names).toContain("Diwali (Deepavali)");
    expect(names).toContain("Christmas");
  });

  it("automatically excludes official company holidays from leave day deductions", () => {
    const holidays = getDefaultHolidays(2026);

    // 2026-01-26 is Republic Day (Monday).
    // If an employee requests leave from 2026-01-26 (Mon) to 2026-01-30 (Fri):
    // Normally 5 weekdays, but Mon 2026-01-26 is a holiday -> only 4 working days should be deducted.
    const workingDays = weekdaysBetween("2026-01-26", "2026-01-30", holidays);
    expect(workingDays).not.toContain("2026-01-26");
    expect(workingDays.length).toBe(4);

    const calculatedDays = leaveDays(
      { start: "2026-01-26", end: "2026-01-30", partial: "full" },
      holidays,
    );
    expect(calculatedDays).toBe(4);
  });

  it("prevents requesting leave if the selected range falls entirely on company holidays or weekends", () => {
    const holidays = getDefaultHolidays(2026);

    // 2026-01-26 is Republic Day. A single day request on this date has 0 working days.
    const err = validateLeave(
      {
        type: "annual",
        start: "2026-01-26",
        end: "2026-01-26",
        partial: "full",
        reason: "Taking off",
      },
      "2026-01-01",
      holidays,
    );
    expect(err).toBe("The selected dates fall entirely on official company holidays or weekends");
  });

  it("generates comprehensive staff leave entitlements directory for all team members", () => {
    const state = createSeed();
    const entitlements = staffLeaveEntitlements(state, 2026);

    expect(entitlements.length).toBe(state.members.length);

    for (const ent of entitlements) {
      expect(ent.monthlyPaidLeaveAccrual).toBe(1.5);
      expect(ent.accruedPaidLeaveToDate).toBeGreaterThan(0);
      expect(ent.annual.entitlement).toBe(18);
      expect(ent.sick.entitlement).toBe(10);
      expect(ent.personal.entitlement).toBe(5);
      expect(ent.totalEntitlement).toBe(33); // 18 + 10 + 5
      expect(ent.totalRemaining).toBeLessThanOrEqual(33);
      expect(ent.totalUsed).toBeGreaterThanOrEqual(0);
    }
  });
});
