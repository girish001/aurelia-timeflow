import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { format, addMonths, subMonths } from "date-fns";
import { TeamLeaveCalendar } from "@/components/app/TeamLeaveCalendar";
import {
  resetDemo,
  endDemoSession,
  startDemoSession,
  addLeave,
  type LeaveRequest,
} from "@/lib/demo-store";
import { isoDay } from "@/lib/time";

beforeEach(() => {
  window.localStorage.clear();
  resetDemo();
  endDemoSession();
  startDemoSession("m1"); // Priya Sharma (Manager - manages Arjun Mehta m2, Kavya Nair m3)
});

describe("TeamLeaveCalendar Component", () => {
  const currentMonthDate = new Date();
  const currentMonthTitle = format(currentMonthDate, "MMMM yyyy");
  const dStr = isoDay(currentMonthDate);

  it("renders the calendar card with month title and view toggle", () => {
    render(<TeamLeaveCalendar />);

    expect(screen.getByTestId("team-leave-calendar-card")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-month-title")).toHaveTextContent(currentMonthTitle);
    expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /today/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /timeline view/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /month grid view/i })).toBeInTheDocument();
  });

  it("renders manager's scoped team members in the timeline view", () => {
    render(<TeamLeaveCalendar />);

    const table = screen.getByTestId("leave-timeline-table");
    expect(table).toBeInTheDocument();

    // Check manager & direct report rows
    expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
    expect(screen.getByText("Arjun Mehta")).toBeInTheDocument();
    expect(screen.getByText("Kavya Nair")).toBeInTheDocument();
  });

  it("displays approved leaves categorized by leave type and ignores pending/rejected leaves", () => {
    // Add distinct test leaves for Kavya Nair (m3) in active month
    const approvedAnnual: LeaveRequest = {
      id: "test_approved_annual",
      memberId: "m3",
      type: "annual",
      start: dStr,
      end: dStr,
      partial: "full",
      reason: "Annual vacation trip",
      status: "approved",
      createdAt: dStr,
      reviewedBy: "m1",
    };

    const pendingSick: LeaveRequest = {
      id: "test_pending_sick",
      memberId: "m3",
      type: "sick",
      start: dStr,
      end: dStr,
      partial: "full",
      reason: "Pending unapproved fever",
      status: "pending",
      createdAt: dStr,
    };

    const rejectedPersonal: LeaveRequest = {
      id: "test_rejected_personal",
      memberId: "m3",
      type: "personal",
      start: dStr,
      end: dStr,
      partial: "full",
      reason: "Rejected request",
      status: "rejected",
      createdAt: dStr,
    };

    act(() => {
      addLeave(approvedAnnual);
      addLeave(pendingSick);
      addLeave(rejectedPersonal);
    });

    render(<TeamLeaveCalendar />);

    // Approved annual leave should be rendered
    const leaveButtons = screen.getAllByRole("button", {
      name: /annual vacation trip/i,
    });
    expect(leaveButtons.length).toBeGreaterThan(0);

    // Pending and rejected leaves should NOT be rendered in the approved timeline
    expect(
      screen.queryByRole("button", { name: /pending unapproved fever/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rejected request/i })).not.toBeInTheDocument();
  });

  it("allows navigating between months with Prev, Next, and Today buttons", () => {
    render(<TeamLeaveCalendar />);

    const prevMonthTitle = format(subMonths(currentMonthDate, 1), "MMMM yyyy");
    const nextMonthTitle = format(addMonths(currentMonthDate, 1), "MMMM yyyy");

    // Click Prev
    fireEvent.click(screen.getByRole("button", { name: /previous month/i }));
    expect(screen.getByTestId("calendar-month-title")).toHaveTextContent(prevMonthTitle);

    // Click Next twice (back to current, then to next)
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(screen.getByTestId("calendar-month-title")).toHaveTextContent(currentMonthTitle);

    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    expect(screen.getByTestId("calendar-month-title")).toHaveTextContent(nextMonthTitle);

    // Click Today
    fireEvent.click(screen.getByRole("button", { name: /today/i }));
    expect(screen.getByTestId("calendar-month-title")).toHaveTextContent(currentMonthTitle);
  });

  it("filters leaves by category when category filter button is clicked", () => {
    const annualReq: LeaveRequest = {
      id: "test_cat_annual",
      memberId: "m2",
      type: "annual",
      start: dStr,
      end: dStr,
      partial: "full",
      reason: "Cat test annual",
      status: "approved",
      createdAt: dStr,
      reviewedBy: "m1",
    };

    const sickReq: LeaveRequest = {
      id: "test_cat_sick",
      memberId: "m3",
      type: "sick",
      start: dStr,
      end: dStr,
      partial: "full",
      reason: "Cat test sick",
      status: "approved",
      createdAt: dStr,
      reviewedBy: "m1",
    };

    act(() => {
      addLeave(annualReq);
      addLeave(sickReq);
    });

    render(<TeamLeaveCalendar />);

    // Both should be in document initially under "All Types"
    expect(screen.getByRole("button", { name: /cat test annual/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cat test sick/i })).toBeInTheDocument();

    // Click "Sick" category filter inside category-filter-group
    const filterGroup = screen.getByTestId("category-filter-group");
    const sickFilterBtn = within(filterGroup).getByRole("button", { name: /sick/i });
    fireEvent.click(sickFilterBtn);

    // Sick should be visible, Annual should be hidden
    expect(screen.getByRole("button", { name: /cat test sick/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cat test annual/i })).not.toBeInTheDocument();

    // Click "All Types" filter
    const allFilterBtn = within(filterGroup).getByRole("button", { name: /all types/i });
    fireEvent.click(allFilterBtn);

    // Both should be visible again
    expect(screen.getByRole("button", { name: /cat test annual/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cat test sick/i })).toBeInTheDocument();
  });

  it("opens leave details dialog when a timeline leave bar is clicked", () => {
    const leaveDetailReq: LeaveRequest = {
      id: "test_modal_leave",
      memberId: "m2",
      type: "annual",
      start: dStr,
      end: dStr,
      partial: "full",
      reason: "Family gathering demo test",
      status: "approved",
      createdAt: dStr,
      reviewedBy: "m1",
    };

    act(() => {
      addLeave(leaveDetailReq);
    });

    render(<TeamLeaveCalendar />);

    // Click the leave bar
    const leaveBar = screen.getByRole("button", { name: /family gathering demo test/i });
    fireEvent.click(leaveBar);

    // Verify modal content
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Leave Details")).toBeInTheDocument();
    expect(within(dialog).getByText("Family gathering demo test")).toBeInTheDocument();
    expect(within(dialog).getByText("Arjun Mehta")).toBeInTheDocument();
    expect(within(dialog).getByText("Priya Sharma")).toBeInTheDocument(); // Approved By reviewer
  });

  it("toggles between Timeline view and Month Grid view", () => {
    render(<TeamLeaveCalendar />);

    // Default is timeline
    expect(screen.getByTestId("leave-timeline-table")).toBeInTheDocument();

    // Switch to Month Grid
    const gridBtn = screen.getByRole("button", { name: /month grid view/i });
    fireEvent.click(gridBtn);

    expect(screen.queryByTestId("leave-timeline-table")).not.toBeInTheDocument();
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();

    // Switch back to Timeline
    const timelineBtn = screen.getByRole("button", { name: /timeline view/i });
    fireEvent.click(timelineBtn);

    expect(screen.getByTestId("leave-timeline-table")).toBeInTheDocument();
  });
});
