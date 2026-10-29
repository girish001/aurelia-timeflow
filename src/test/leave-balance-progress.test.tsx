import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveBalanceProgress } from "@/components/app/LeaveBalanceProgress";
import {
  resetDemo,
  endDemoSession,
  startDemoSession,
  addLeave,
  type LeaveRequest,
} from "@/lib/demo-store";

beforeEach(() => {
  window.localStorage.clear();
  resetDemo();
  endDemoSession();
  startDemoSession("m2"); // Arjun Mehta (Employee)
});

describe("LeaveBalanceProgress Component", () => {
  const currentYear = new Date().getFullYear();

  it("renders Annual, Sick, and Personal leave balance cards with entitlement badges", () => {
    render(<LeaveBalanceProgress year={currentYear} />);

    expect(screen.getByTestId("leave-balance-progress-section")).toBeInTheDocument();
    expect(screen.getByTestId("leave-balance-card-annual")).toBeInTheDocument();
    expect(screen.getByTestId("leave-balance-card-sick")).toBeInTheDocument();
    expect(screen.getByTestId("leave-balance-card-personal")).toBeInTheDocument();

    // Check headings
    expect(screen.getByText("Annual leave")).toBeInTheDocument();
    expect(screen.getByText("Sick leave")).toBeInTheDocument();
    expect(screen.getByText("Personal leave")).toBeInTheDocument();

    // Entitlement badges
    expect(screen.getByText("18d / yr")).toBeInTheDocument();
    expect(screen.getByText("10d / yr")).toBeInTheDocument();
    expect(screen.getByText("5d / yr")).toBeInTheDocument();
  });

  it("renders accessible progress bars with correct ARIA attributes", () => {
    render(<LeaveBalanceProgress year={currentYear} />);

    const progressBars = screen.getAllByRole("progressbar");
    expect(progressBars).toHaveLength(3);

    // Verify annual progressbar attributes
    const annualBar = progressBars[0];
    expect(annualBar).toHaveAttribute("aria-valuemin", "0");
    expect(annualBar).toHaveAttribute("aria-valuemax", "18");
    expect(annualBar).toHaveAttribute("aria-valuenow");

    // Verify sick progressbar attributes
    const sickBar = progressBars[1];
    expect(sickBar).toHaveAttribute("aria-valuemin", "0");
    expect(sickBar).toHaveAttribute("aria-valuemax", "10");

    // Verify personal progressbar attributes
    const personalBar = progressBars[2];
    expect(personalBar).toHaveAttribute("aria-valuemin", "0");
    expect(personalBar).toHaveAttribute("aria-valuemax", "5");
  });

  it("triggers onRequestLeave callback with selected leave type when request button is clicked", () => {
    const handleRequest = vi.fn();
    render(<LeaveBalanceProgress year={currentYear} onRequestLeave={handleRequest} />);

    // Click request annual leave button
    const annualBtn = screen.getByRole("button", { name: /request annual leave/i });
    fireEvent.click(annualBtn);
    expect(handleRequest).toHaveBeenCalledWith("annual");

    // Click request sick leave button
    const sickBtn = screen.getByRole("button", { name: /request sick leave/i });
    fireEvent.click(sickBtn);
    expect(handleRequest).toHaveBeenCalledWith("sick");

    // Click request personal leave button
    const personalBtn = screen.getByRole("button", { name: /request personal leave/i });
    fireEvent.click(personalBtn);
    expect(handleRequest).toHaveBeenCalledWith("personal");
  });

  it("updates progress breakdown reactively when new leave requests are added", () => {
    const { rerender } = render(<LeaveBalanceProgress year={currentYear} />);

    // Add a new approved sick leave of 3 days
    const req: LeaveRequest = {
      id: "req_test_component",
      memberId: "m2",
      type: "sick",
      start: `${currentYear}-10-05`,
      end: `${currentYear}-10-07`,
      partial: "full",
      reason: "Recovery",
      status: "approved",
      createdAt: `${currentYear}-10-01`,
    };
    act(() => {
      addLeave(req);
    });

    rerender(<LeaveBalanceProgress year={currentYear} />);

    const sickCard = screen.getByTestId("leave-balance-card-sick");
    expect(sickCard).toHaveTextContent("3d"); // 3 days used
  });
});
