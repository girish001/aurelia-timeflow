import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { format, parseISO } from "date-fns";
import {
  Check,
  X,
  Inbox,
  Eye,
  CheckCheck,
  Clock,
  Gauge,
  CheckCircle2,
  Users,
  ShieldAlert,
  CalendarDays,
  Calendar,
  Search,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, Initials, PageHeader, StatCard, StatusBadge } from "@/components/app/common";
import {
  entryTotal,
  reviewTimesheet,
  bulkReviewTimesheets,
  sheetTotal,
  useDemo,
  useMe,
  setLeave,
  bulkReviewLeaves,
  addAuditLog,
  type SheetStatus,
  type LeaveRequest,
  type LeaveType,
  type LeaveStatus,
} from "@/lib/demo-store";
import { DAYS, formatHours, weekLabel, isoDay } from "@/lib/time";
import {
  ROLE_LABEL,
  LEAVE_LABEL,
  approvableTimesheets,
  canApproveTimesheet,
  directReportIds,
  approvableLeaves,
  canReviewLeave,
  decideLeave,
  leaveDays,
  leaveDaysInYear,
  leaveBalance,
} from "@/lib/rules";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/approvals")({
  head: () =>
    pageHead("Approvals", "Review, approve or return team timesheets and leave requests."),
  component: Approvals,
});

export function Approvals() {
  const me = useMe();
  const s = useDemo((x) => x);
  const currentYear = new Date().getFullYear();
  const todayStr = isoDay(new Date());

  // Top-level module switcher: Timesheets vs Team Leave Requests
  const [activeModule, setActiveModule] = useState<"timesheets" | "leave">("timesheets");

  // ================= Timesheets State =================
  const [tsFilter, setTsFilter] = useState<SheetStatus | "all">("submitted");
  const [openTsId, setOpenTsId] = useState<string | null>(null);
  const [selectedTsIds, setSelectedTsIds] = useState<string[]>([]);
  const [tsComment, setTsComment] = useState("");
  const [tsErr, setTsErr] = useState("");

  // ================= Leave Requests State =================
  const [leaveFilter, setLeaveFilter] = useState<LeaveStatus | "all">("pending");
  const [leaveSearch, setLeaveSearch] = useState("");
  const [leaveTypeFilter, setLeaveTypeFilter] = useState<"all" | LeaveType>("all");
  const [selectedLeaveIds, setSelectedLeaveIds] = useState<string[]>([]);
  const [reviewLeaveModalOpen, setReviewLeaveModalOpen] = useState(false);
  const [selectedLeave, setSelectedLeave] = useState<LeaveRequest | null>(null);
  const [leaveDecision, setLeaveDecision] = useState<"approved" | "rejected">("approved");
  const [leaveComment, setLeaveComment] = useState("");
  const [leaveCommentErr, setLeaveCommentErr] = useState("");
  const [detailsLeaveModalOpen, setDetailsLeaveModalOpen] = useState(false);
  const [detailsLeave, setDetailsLeave] = useState<LeaveRequest | null>(null);

  const fmt = s.settings.timeFormat;
  const member = (id: string) => s.members.find((m) => m.id === id);
  const project = (id: string) => s.projects.find((p) => p.id === id);

  // ----------------- Scoped Timesheets -----------------
  const approvableTs = useMemo(() => approvableTimesheets(s, me), [s, me]);
  const tsList = useMemo(
    () =>
      approvableTs
        .filter((t) => t.status !== "draft" && (tsFilter === "all" || t.status === tsFilter))
        .sort(
          (a, b) => b.weekStart.localeCompare(a.weekStart) || (a.memberId > b.memberId ? 1 : -1),
        ),
    [approvableTs, tsFilter],
  );

  const openTs = s.timesheets.find((t) => t.id === openTsId);
  const tsCount = (st: SheetStatus) => approvableTs.filter((t) => t.status === st).length;

  const pendingSheets = useMemo(
    () => approvableTs.filter((t) => t.status === "submitted"),
    [approvableTs],
  );
  const pendingHours = pendingSheets.reduce((acc, t) => acc + sheetTotal(t), 0);
  const pendingBillableHours = pendingSheets.reduce(
    (acc, t) =>
      acc +
      t.entries
        .filter((e) => e.billable)
        .reduce((sum, e) => sum + e.hours.reduce((x, y) => x + y, 0), 0),
    0,
  );
  const pendingBillableRatio = pendingHours > 0 ? (pendingBillableHours / pendingHours) * 100 : 0;

  // ----------------- Scoped Leave Requests -----------------
  // Strictly filtered to requests from employees reporting to the logged-in manager (or all company for admin)
  const directRepIds = useMemo(() => directReportIds(s, me), [s, me]);
  const directRepMembers = useMemo(
    () => s.members.filter((m) => directRepIds.includes(m.id)),
    [s.members, directRepIds],
  );

  const allTeamLeaves = useMemo(() => approvableLeaves(s, me), [s, me]);

  const pendingLeaveRequests = useMemo(
    () => allTeamLeaves.filter((l) => l.status === "pending"),
    [allTeamLeaves],
  );

  const leaveCount = (st: LeaveStatus) => allTeamLeaves.filter((l) => l.status === st).length;

  const filteredLeaves = useMemo(() => {
    return allTeamLeaves
      .filter((l) => {
        if (leaveFilter !== "all" && l.status !== leaveFilter) return false;
        if (leaveTypeFilter !== "all" && l.type !== leaveTypeFilter) return false;
        if (leaveSearch.trim()) {
          const q = leaveSearch.toLowerCase();
          const emp = s.members.find((m) => m.id === l.memberId);
          const nameMatch = emp?.name.toLowerCase().includes(q);
          const typeMatch = LEAVE_LABEL[l.type].toLowerCase().includes(q);
          const reasonMatch = l.reason?.toLowerCase().includes(q);
          const dateMatch = l.start.includes(q) || l.end.includes(q);
          if (!nameMatch && !typeMatch && !reasonMatch && !dateMatch) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Pending requests first, then by earliest start date
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (a.status !== "pending" && b.status === "pending") return 1;
        return a.start.localeCompare(b.start);
      });
  }, [allTeamLeaves, leaveFilter, leaveTypeFilter, leaveSearch, s.members]);

  // Leave KPI metrics
  const teamOnLeaveToday = useMemo(() => {
    return allTeamLeaves.filter(
      (l) => l.status === "approved" && l.start <= todayStr && l.end >= todayStr,
    );
  }, [allTeamLeaves, todayStr]);

  const teamApprovedDaysThisYear = useMemo(() => {
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;
    return allTeamLeaves
      .filter((l) => l.status === "approved" && l.start <= yearEnd && l.end >= yearStart)
      .reduce((acc, l) => acc + leaveDaysInYear(l, currentYear, s.holidays), 0);
  }, [allTeamLeaves, currentYear, s.holidays]);

  // ================= Single Review (Timesheets) =================
  const decideTs = (decision: "approved" | "rejected") => {
    if (!openTs) return;
    if (decision === "rejected" && tsComment.trim().length < 3)
      return setTsErr("Add a specific reason so the employee knows what adjustments to make.");

    if (!canApproveTimesheet(s, me, openTs.id)) {
      toast.error(
        "Unauthorized: You cannot approve this timesheet (own submission or outside team scope).",
      );
      return;
    }

    reviewTimesheet(openTs.id, decision, tsComment.trim(), me.id, me.name);
    toast.success(`${member(openTs.memberId)?.name}'s timesheet ${decision}`);
    setOpenTsId(null);
    setTsComment("");
    setTsErr("");
  };

  // ================= Bulk Review (Timesheets) =================
  const handleBulkApproveTs = () => {
    if (selectedTsIds.length === 0) return;
    const validIds = selectedTsIds.filter((id) => canApproveTimesheet(s, me, id));

    if (validIds.length === 0) {
      toast.error(
        "Unauthorized: None of the selected timesheets are within your approval authority.",
      );
      return;
    }

    bulkReviewTimesheets(validIds, "approved", me.id, me.name, "Bulk approved by manager");
    toast.success(`Approved ${validIds.length} timesheets successfully`);
    setSelectedTsIds([]);
  };

  const toggleSelectAllTs = (checked: boolean) => {
    if (checked) {
      const pendingIds = tsList
        .filter((t) => t.status === "submitted" && t.memberId !== me.id)
        .map((t) => t.id);
      setSelectedTsIds(pendingIds);
    } else {
      setSelectedTsIds([]);
    }
  };

  const toggleSelectOneTs = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedTsIds((prev) => [...prev, id]);
    } else {
      setSelectedTsIds((prev) => prev.filter((x) => x !== id));
    }
  };

  // ================= Leave Review Actions =================
  const openLeaveReview = (req: LeaveRequest, decision: "approved" | "rejected") => {
    setSelectedLeave(req);
    setLeaveDecision(decision);
    setLeaveComment("");
    setLeaveCommentErr("");
    setReviewLeaveModalOpen(true);
  };

  const handleConfirmLeaveReview = () => {
    if (!selectedLeave) return;

    if (leaveDecision === "rejected" && leaveComment.trim().length < 3) {
      setLeaveCommentErr(
        "Please provide a reason so the employee understands why it was returned.",
      );
      return;
    }

    // Strict manager check
    if (!canReviewLeave(s, me, selectedLeave)) {
      toast.error(
        "Unauthorized: You can only review leave requests from employees reporting to you.",
      );
      return;
    }

    try {
      const updated = decideLeave(selectedLeave, leaveDecision, leaveComment.trim(), me.id);
      setLeave(updated);
      const requester = member(selectedLeave.memberId)?.name ?? "Employee";
      addAuditLog({
        actorId: me.id,
        actorName: me.name,
        action: leaveDecision === "approved" ? "Leave Approved" : "Leave Rejected",
        category: "leave",
        details: `${leaveDecision === "approved" ? "Approved" : "Rejected"} ${requester}'s ${LEAVE_LABEL[selectedLeave.type]} (${selectedLeave.start} to ${selectedLeave.end})${leaveComment.trim() ? ` - Reason: ${leaveComment.trim()}` : ""}`,
      });
      toast.success(`${requester}'s leave request ${leaveDecision}.`);
      setReviewLeaveModalOpen(false);
      setSelectedLeave(null);
      setLeaveComment("");
      setLeaveCommentErr("");
    } catch (err) {
      setLeaveCommentErr(err instanceof Error ? err.message : "Failed to record decision");
    }
  };

  // ================= Bulk Review (Leave Requests) =================
  const handleBulkApproveLeaves = () => {
    if (selectedLeaveIds.length === 0) return;
    const validRequests = selectedLeaveIds
      .map((id) => s.leaves.find((l) => l.id === id))
      .filter((l): l is LeaveRequest => !!l && canReviewLeave(s, me, l));

    if (validRequests.length === 0) {
      toast.error("Unauthorized: None of the selected leave requests are within your direct team.");
      return;
    }

    bulkReviewLeaves(
      validRequests.map((l) => l.id),
      "approved",
      me.id,
      me.name,
      "Bulk approved by manager",
    );
    toast.success(`Approved ${validRequests.length} team leave requests successfully`);
    setSelectedLeaveIds([]);
  };

  const toggleSelectAllLeaves = (checked: boolean) => {
    if (checked) {
      const pendingIds = filteredLeaves
        .filter((l) => l.status === "pending" && canReviewLeave(s, me, l))
        .map((l) => l.id);
      setSelectedLeaveIds(pendingIds);
    } else {
      setSelectedLeaveIds([]);
    }
  };

  const toggleSelectOneLeave = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedLeaveIds((prev) => [...prev, id]);
    } else {
      setSelectedLeaveIds((prev) => prev.filter((x) => x !== id));
    }
  };

  const selectedLeaveRequester = selectedLeave ? member(selectedLeave.memberId) : null;
  const selectedLeaveBalance = selectedLeave
    ? leaveBalance(s, selectedLeave.memberId, currentYear)
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals Hub"
        description={`Logged in as ${me.name} (${ROLE_LABEL[me.role]})${me.department ? ` · ${me.department}` : ""}`}
        actions={
          activeModule === "timesheets"
            ? selectedTsIds.length > 0 && (
                <Button
                  onClick={handleBulkApproveTs}
                  className="bg-success text-success-foreground hover:bg-success/90 gap-1.5 shadow-xs"
                >
                  <CheckCheck className="size-4" />
                  <span>Bulk Approve ({selectedTsIds.length})</span>
                </Button>
              )
            : selectedLeaveIds.length > 0 && (
                <Button
                  onClick={handleBulkApproveLeaves}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 shadow-xs"
                >
                  <CheckCheck className="size-4" />
                  <span>Bulk Approve Leaves ({selectedLeaveIds.length})</span>
                </Button>
              )
        }
      />

      {/* Primary Approval Module Tabs */}
      <div className="border-b border-border">
        <nav className="flex space-x-6" aria-label="Approval Modules">
          <button
            type="button"
            onClick={() => setActiveModule("timesheets")}
            className={`flex items-center gap-2 border-b-2 py-3 px-1 text-sm font-semibold transition-colors ${
              activeModule === "timesheets"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            <Clock className="size-4" />
            <span>Weekly Timesheets</span>
            {pendingSheets.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500/90 px-2 py-0.5 text-[0.7rem] font-bold text-white">
                {pendingSheets.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveModule("leave")}
            className={`flex items-center gap-2 border-b-2 py-3 px-1 text-sm font-semibold transition-colors ${
              activeModule === "leave"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            <CalendarDays className="size-4" />
            <span>Team Leave Requests</span>
            {pendingLeaveRequests.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500/90 px-2 py-0.5 text-[0.7rem] font-bold text-white">
                {pendingLeaveRequests.length}
              </span>
            )}
          </button>
        </nav>
      </div>

      {/* ======================================================== */}
      {/* MODULE 1: TIMESHEETS APPROVALS                           */}
      {/* ======================================================== */}
      {activeModule === "timesheets" && (
        <div className="space-y-6">
          {/* Summary KPI Cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Pending review"
              value={tsCount("submitted")}
              hint="Timesheets awaiting manager decision"
              icon={Clock}
              tone={tsCount("submitted") > 0 ? "warning" : "success"}
            />
            <StatCard
              label="Pending hours"
              value={`${formatHours(pendingHours, fmt)}h`}
              hint={`${formatHours(pendingBillableHours, fmt)}h billable to clients`}
              icon={Gauge}
              tone="primary"
            />
            <StatCard
              label="Billable ratio"
              value={`${pendingBillableRatio.toFixed(0)}%`}
              hint="Across all pending submissions"
              icon={CheckCircle2}
              tone="teal"
            />
            <StatCard
              label="Awaiting employees"
              value={new Set(pendingSheets.map((t) => t.memberId)).size}
              hint="Team members waiting for approval"
              icon={Users}
              tone="primary"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <Tabs value={tsFilter} onValueChange={(v) => setTsFilter(v as SheetStatus | "all")}>
              <TabsList>
                <TabsTrigger value="submitted">Pending ({tsCount("submitted")})</TabsTrigger>
                <TabsTrigger value="approved">Approved ({tsCount("approved")})</TabsTrigger>
                <TabsTrigger value="rejected">Rejected ({tsCount("rejected")})</TabsTrigger>
                <TabsTrigger value="all">
                  All ({approvableTs.filter((t) => t.status !== "draft").length})
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {tsFilter === "submitted" && selectedTsIds.length > 0 && (
              <span className="text-xs font-semibold text-primary">
                {selectedTsIds.length} timesheets selected
              </span>
            )}
          </div>

          {tsList.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing here"
              text={
                tsFilter === "submitted"
                  ? "No timesheets are currently waiting for your approval."
                  : "No timesheets match this status filter."
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {tsFilter === "submitted" && (
                      <th className="w-10 px-4 py-3">
                        <Checkbox
                          checked={
                            selectedTsIds.length > 0 &&
                            selectedTsIds.length ===
                              tsList.filter((t) => t.status === "submitted" && t.memberId !== me.id)
                                .length
                          }
                          onCheckedChange={(c) => toggleSelectAllTs(Boolean(c))}
                          aria-label="Select all timesheets"
                        />
                      </th>
                    )}
                    <th className="px-5 py-3 font-semibold">Employee</th>
                    <th className="px-5 py-3 font-semibold">Week</th>
                    <th className="px-5 py-3 text-right font-semibold">Total hours</th>
                    <th className="px-5 py-3 text-right font-semibold">Billable</th>
                    <th className="px-5 py-3 font-semibold">Submitted</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tsList.map((t) => {
                    const m = member(t.memberId);
                    const isSelected = selectedTsIds.includes(t.id);
                    const isOwn = t.memberId === me.id;
                    const billableHours = t.entries
                      .filter((e) => e.billable)
                      .reduce((acc, e) => acc + e.hours.reduce((a, b) => a + b, 0), 0);

                    return (
                      <tr
                        key={t.id}
                        className={`hover:bg-muted/30 transition-colors ${
                          isSelected ? "bg-primary/5" : ""
                        }`}
                      >
                        {tsFilter === "submitted" && (
                          <td className="px-4 py-3">
                            <Checkbox
                              disabled={isOwn}
                              checked={isSelected}
                              onCheckedChange={(c) => toggleSelectOneTs(t.id, Boolean(c))}
                              aria-label={`Select ${m?.name}'s timesheet`}
                            />
                          </td>
                        )}
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <Initials name={m?.name ?? "?"} className="size-8 text-xs font-bold" />
                            <div>
                              <p className="font-semibold text-foreground">
                                {m?.name}
                                {isOwn && (
                                  <span className="ml-1.5 text-[10px] rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                                    You
                                  </span>
                                )}
                              </p>
                              <p className="text-xs text-muted-foreground">{m?.title}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-muted-foreground font-medium">
                          {weekLabel(t.weekStart)}
                        </td>
                        <td className="px-5 py-3 text-right font-bold tabular">
                          {formatHours(sheetTotal(t), fmt)}h
                        </td>
                        <td className="px-5 py-3 text-right tabular text-xs text-primary font-semibold">
                          {formatHours(billableHours, fmt)}h
                        </td>
                        <td className="px-5 py-3 text-muted-foreground text-xs">
                          {t.submittedAt ? format(parseISO(t.submittedAt), "d MMM yyyy") : "—"}
                        </td>
                        <td className="px-5 py-3">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-5 py-3 text-right">
                          <Button
                            size="sm"
                            variant={t.status === "submitted" ? "default" : "outline"}
                            onClick={() => {
                              setOpenTsId(t.id);
                              setTsComment(t.reviewComment ?? "");
                              setTsErr("");
                            }}
                          >
                            <Eye className="size-3.5" />
                            <span>{t.status === "submitted" ? "Review" : "View details"}</span>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Detailed Timesheet Dialog */}
          <Dialog open={!!openTs} onOpenChange={(o) => !o && setOpenTsId(null)}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Timesheet Review</DialogTitle>
                <DialogDescription>
                  {openTs && (
                    <span>
                      Submitted by <strong>{member(openTs.memberId)?.name}</strong> for{" "}
                      {weekLabel(openTs.weekStart)}
                    </span>
                  )}
                </DialogDescription>
              </DialogHeader>

              {openTs && (
                <div className="space-y-5 py-2">
                  {openTs.memberId === me.id && (
                    <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning-foreground">
                      <ShieldAlert className="size-4 shrink-0" />
                      <span>
                        This is your own timesheet. Role policy prevents approving your own
                        submissions.
                      </span>
                    </div>
                  )}

                  {/* Task table breakdown */}
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2.5 text-left font-semibold">Project · Task</th>
                          {DAYS.map((d) => (
                            <th key={d} className="px-1.5 py-2.5 text-center font-semibold">
                              {d}
                            </th>
                          ))}
                          <th className="px-3 py-2.5 text-right font-semibold">Total</th>
                          <th className="px-3 py-2.5 text-left font-semibold">Billable</th>
                          <th className="px-3 py-2.5 text-left font-semibold">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {openTs.entries.map((e) => (
                          <tr key={e.id}>
                            <td className="px-3 py-2.5">
                              <p className="font-semibold text-foreground">
                                {project(e.projectId)?.name ?? "Internal"}
                              </p>
                              <p className="text-[11px] text-muted-foreground">{e.task}</p>
                            </td>
                            {e.hours.map((h, i) => (
                              <td key={i} className="px-1.5 py-2.5 text-center tabular font-medium">
                                {h ? `${h}h` : "—"}
                              </td>
                            ))}
                            <td className="px-3 py-2.5 text-right tabular font-bold">
                              {formatHours(entryTotal(e), fmt)}h
                            </td>
                            <td className="px-3 py-2.5 font-medium">
                              <span
                                className={e.billable ? "text-primary" : "text-muted-foreground"}
                              >
                                {e.billable ? "Yes" : "No"}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-muted-foreground max-w-[160px] truncate">
                              {e.notes || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t bg-muted/30 font-bold">
                        <tr>
                          <td className="px-3 py-2.5">Total</td>
                          {DAYS.map((_, d) => {
                            const sum = openTs.entries.reduce(
                              (acc, e) => acc + (e.hours[d] || 0),
                              0,
                            );
                            return (
                              <td
                                key={d}
                                className="px-1.5 py-2.5 text-center tabular font-semibold"
                              >
                                {sum ? `${sum}h` : "—"}
                              </td>
                            );
                          })}
                          <td className="px-3 py-2.5 text-right tabular text-primary">
                            {formatHours(sheetTotal(openTs), fmt)}h
                          </td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Review notes and feedback */}
                  <div className="space-y-2">
                    <Label htmlFor="review-comment">Reviewer notes / feedback</Label>
                    <Textarea
                      id="review-comment"
                      value={tsComment}
                      onChange={(e) => {
                        setTsComment(e.target.value);
                        if (tsErr) setTsErr("");
                      }}
                      placeholder={
                        openTs.status === "submitted"
                          ? "Add revision instructions (required if rejecting) or approval note..."
                          : "No reviewer comment recorded"
                      }
                      disabled={openTs.status !== "submitted"}
                      rows={3}
                    />
                    {tsErr && <p className="text-xs text-destructive">{tsErr}</p>}
                  </div>

                  {openTs.reviewedAt && (
                    <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
                      Reviewed on {format(parseISO(openTs.reviewedAt), "d MMM yyyy")}
                    </div>
                  )}
                </div>
              )}

              <DialogFooter>
                {openTs?.status === "submitted" ? (
                  <div className="flex w-full items-center justify-between gap-2">
                    <Button variant="ghost" onClick={() => setOpenTsId(null)}>
                      Cancel
                    </Button>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="border-destructive/40 text-destructive hover:bg-destructive/10"
                        disabled={openTs.memberId === me.id}
                        onClick={() => decideTs("rejected")}
                      >
                        <X className="size-4" />
                        <span>Return for revision</span>
                      </Button>
                      <Button
                        disabled={openTs.memberId === me.id}
                        onClick={() => decideTs("approved")}
                        className="bg-success text-success-foreground hover:bg-success/90"
                      >
                        <Check className="size-4" />
                        <span>Approve timesheet</span>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button onClick={() => setOpenTsId(null)}>Close</Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODULE 2: TEAM LEAVE REQUESTS APPROVAL DASHBOARD         */}
      {/* ======================================================== */}
      {activeModule === "leave" && (
        <div className="space-y-6">
          {/* Direct report team context notice */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-xs text-foreground flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Users className="size-4 text-primary shrink-0" />
              <span>
                <strong>Team Scope:</strong> Showing requests from employees reporting to you (
                <strong>{directRepMembers.length} team members</strong>
                {directRepMembers.length > 0
                  ? `: ${directRepMembers.map((m) => m.name).join(", ")}`
                  : ""}{" "}
                ).
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              Self-requests excluded to enforce dual-control policy.
            </span>
          </div>

          {/* Leave Summary KPI Cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Pending Team Requests"
              value={pendingLeaveRequests.length}
              hint={
                pendingLeaveRequests.length === 0
                  ? "All requests reviewed"
                  : `${pendingLeaveRequests.length} awaiting your action`
              }
              icon={Clock}
              tone={pendingLeaveRequests.length > 0 ? "warning" : "success"}
            />
            <StatCard
              label="Direct Reports"
              value={directRepMembers.length}
              hint="Employees reporting to you"
              icon={Users}
              tone="primary"
            />
            <StatCard
              label="Team On Leave Today"
              value={teamOnLeaveToday.length}
              hint="Active scheduled absences"
              icon={CalendarDays}
              tone="teal"
            />
            <StatCard
              label="Approved Leave Days"
              value={`${teamApprovedDaysThisYear} days`}
              hint={`Approved for team in ${currentYear}`}
              icon={CheckCircle2}
              tone="success"
            />
          </div>

          {/* Filter Bar & Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <Tabs
              value={leaveFilter}
              onValueChange={(v) => setLeaveFilter(v as LeaveStatus | "all")}
            >
              <TabsList>
                <TabsTrigger value="pending">Pending ({leaveCount("pending")})</TabsTrigger>
                <TabsTrigger value="approved">Approved ({leaveCount("approved")})</TabsTrigger>
                <TabsTrigger value="rejected">Rejected ({leaveCount("rejected")})</TabsTrigger>
                <TabsTrigger value="all">All ({allTeamLeaves.length})</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-48 sm:w-56">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search team leave..."
                  value={leaveSearch}
                  onChange={(e) => setLeaveSearch(e.target.value)}
                  className="h-9 pl-8 text-xs"
                />
              </div>

              <Select
                value={leaveTypeFilter}
                onValueChange={(v) => setLeaveTypeFilter(v as typeof leaveTypeFilter)}
              >
                <SelectTrigger className="h-9 w-36 text-xs">
                  <SelectValue placeholder="All Leave Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="annual">Annual Leave</SelectItem>
                  <SelectItem value="sick">Sick Leave</SelectItem>
                  <SelectItem value="personal">Personal Leave</SelectItem>
                  <SelectItem value="unpaid">Unpaid Leave</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Leave Requests Table */}
          {filteredLeaves.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title={
                leaveFilter === "pending"
                  ? "No pending leave requests"
                  : "No requests found matching filters"
              }
              text={
                leaveFilter === "pending"
                  ? "All leave submissions from your direct reports have been reviewed."
                  : "Try clearing your search query or choosing another status tab."
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
              <table className="w-full min-w-[840px] text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {leaveFilter === "pending" && (
                      <th className="w-10 px-4 py-3">
                        <Checkbox
                          checked={
                            selectedLeaveIds.length > 0 &&
                            selectedLeaveIds.length ===
                              filteredLeaves.filter((l) => l.status === "pending").length
                          }
                          onCheckedChange={(c) => toggleSelectAllLeaves(Boolean(c))}
                          aria-label="Select all pending leaves"
                        />
                      </th>
                    )}
                    <th className="px-5 py-3 font-semibold">Employee</th>
                    <th className="px-5 py-3 font-semibold">Leave Type</th>
                    <th className="px-5 py-3 font-semibold">Requested Period</th>
                    <th className="px-5 py-3 text-right font-semibold">Duration</th>
                    <th className="px-5 py-3 font-semibold">Balance Info</th>
                    <th className="px-5 py-3 font-semibold">Reason</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredLeaves.map((req) => {
                    const emp = member(req.memberId);
                    const days = leaveDays(req, s.holidays);
                    const bal = emp ? leaveBalance(s, emp.id, currentYear) : null;
                    const isSelected = selectedLeaveIds.includes(req.id);
                    const reviewer = req.reviewedBy ? member(req.reviewedBy)?.name : null;

                    return (
                      <tr
                        key={req.id}
                        className={`hover:bg-muted/30 transition-colors ${
                          isSelected ? "bg-primary/5" : ""
                        }`}
                      >
                        {leaveFilter === "pending" && (
                          <td className="px-4 py-3">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(c) => toggleSelectOneLeave(req.id, Boolean(c))}
                              aria-label={`Select ${emp?.name}'s leave request`}
                            />
                          </td>
                        )}
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <Initials
                              name={emp?.name ?? "?"}
                              className="size-8 text-xs font-bold"
                            />
                            <div>
                              <p className="font-semibold text-foreground">{emp?.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {emp?.title} {emp?.department ? `· ${emp.department}` : ""}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                              req.type === "annual"
                                ? "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200 dark:border-blue-800"
                                : req.type === "sick"
                                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800"
                                  : req.type === "personal"
                                    ? "bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300 border-purple-200 dark:border-purple-800"
                                    : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-700"
                            }`}
                          >
                            {LEAVE_LABEL[req.type]}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-xs font-mono tabular-nums">
                          {req.start === req.end ? (
                            <span>{format(parseISO(req.start), "MMM d, yyyy")}</span>
                          ) : (
                            <span>
                              {format(parseISO(req.start), "MMM d")} –{" "}
                              {format(parseISO(req.end), "MMM d, yyyy")}
                            </span>
                          )}
                          {req.partial !== "full" && (
                            <span className="ml-1 text-muted-foreground font-sans">
                              ({req.partial.toUpperCase()} half-day)
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right font-bold tabular">
                          <span className="text-foreground">{days}</span> day{days !== 1 ? "s" : ""}
                        </td>
                        <td className="px-5 py-3 text-xs font-mono tabular-nums text-muted-foreground">
                          {bal ? (
                            <span
                              className={bal.remaining < 3 ? "text-amber-600 font-semibold" : ""}
                            >
                              {bal.remaining}d remaining
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td
                          className="px-5 py-3 text-xs text-muted-foreground max-w-[180px] truncate"
                          title={req.reason}
                        >
                          {req.reason || "—"}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-col gap-0.5">
                            <StatusBadge status={req.status} />
                            {req.reviewComment && (
                              <span
                                className="text-[11px] text-muted-foreground truncate max-w-[140px]"
                                title={req.reviewComment}
                              >
                                &quot;{req.reviewComment}&quot;
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right">
                          {req.status === "pending" ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1 border-destructive/30 text-destructive hover:bg-destructive/10"
                                onClick={() => openLeaveReview(req, "rejected")}
                              >
                                <X className="size-3.5" />
                                <span>Reject</span>
                              </Button>
                              <Button
                                size="sm"
                                className="h-8 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                                onClick={() => openLeaveReview(req, "approved")}
                              >
                                <Check className="size-3.5" />
                                <span>Approve</span>
                              </Button>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setDetailsLeave(req);
                                setDetailsLeaveModalOpen(true);
                              }}
                            >
                              <Eye className="size-3.5" />
                              <span>Details</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ======================================================== */}
          {/* INTERACTIVE LEAVE REVIEW MODAL (APPROVE / REJECT)        */}
          {/* ======================================================== */}
          <Dialog
            open={reviewLeaveModalOpen}
            onOpenChange={(o) => {
              if (!o) {
                setReviewLeaveModalOpen(false);
                setSelectedLeave(null);
              }
            }}
          >
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  {leaveDecision === "approved" ? (
                    <div className="size-6 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center">
                      <Check className="size-4" />
                    </div>
                  ) : (
                    <div className="size-6 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
                      <X className="size-4" />
                    </div>
                  )}
                  <span>
                    {leaveDecision === "approved"
                      ? "Approve Team Leave Request"
                      : "Return / Reject Leave Request"}
                  </span>
                </DialogTitle>
                <DialogDescription>
                  Reviewing submission by{" "}
                  <strong>{selectedLeaveRequester?.name ?? "Employee"}</strong>
                </DialogDescription>
              </DialogHeader>

              {selectedLeave && (
                <div className="space-y-4 py-2 text-sm">
                  {/* Summary Card */}
                  <div className="rounded-xl border bg-muted/30 p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <Initials
                          name={selectedLeaveRequester?.name ?? "?"}
                          className="size-8 text-xs font-bold"
                        />
                        <div>
                          <p className="font-semibold text-foreground">
                            {selectedLeaveRequester?.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {selectedLeaveRequester?.title}
                          </p>
                        </div>
                      </div>
                      <Badge variant="outline" className="capitalize">
                        {LEAVE_LABEL[selectedLeave.type]}
                      </Badge>
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
                      <div>
                        <span className="text-muted-foreground block">Period:</span>
                        <span className="font-semibold text-foreground">
                          {selectedLeave.start} to {selectedLeave.end}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground block">Duration:</span>
                        <span className="font-semibold text-foreground">
                          {leaveDays(selectedLeave, s.holidays)} working day(s)
                          {selectedLeave.partial !== "full" &&
                            ` (${selectedLeave.partial.toUpperCase()})`}
                        </span>
                      </div>
                      {selectedLeaveBalance && (
                        <div>
                          <span className="text-muted-foreground block">Annual Balance:</span>
                          <span className="font-semibold text-foreground">
                            {selectedLeaveBalance.remaining}d remaining of{" "}
                            {selectedLeaveBalance.entitlement}d
                          </span>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground block">Submitted:</span>
                        <span className="font-medium text-foreground">
                          {selectedLeave.createdAt}
                        </span>
                      </div>
                    </div>

                    {selectedLeave.reason && (
                      <div className="pt-2 border-t text-xs">
                        <span className="text-muted-foreground block mb-0.5">Employee Reason:</span>
                        <p className="italic text-foreground bg-background/80 rounded-md p-2 border">
                          &quot;{selectedLeave.reason}&quot;
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Comment Input */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="leave-comment" className="text-xs font-semibold">
                        {leaveDecision === "rejected"
                          ? "Reason for rejection (Required)"
                          : "Reviewer Feedback / Handover Notes (Optional)"}
                      </Label>
                      {leaveDecision === "rejected" && (
                        <span className="text-[11px] text-destructive">Min 3 characters</span>
                      )}
                    </div>
                    <Textarea
                      id="leave-comment"
                      value={leaveComment}
                      onChange={(e) => {
                        setLeaveComment(e.target.value);
                        if (leaveCommentErr) setLeaveCommentErr("");
                      }}
                      placeholder={
                        leaveDecision === "rejected"
                          ? "Provide specific feedback on why this request cannot be approved..."
                          : "Add any handover instructions, coverage notes, or well wishes..."
                      }
                      rows={3}
                      className="text-xs"
                    />
                    {leaveCommentErr && (
                      <p className="text-xs text-destructive">{leaveCommentErr}</p>
                    )}
                  </div>

                  {/* Decision toggle buttons inside modal */}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-muted-foreground">Change decision:</span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={leaveDecision === "approved" ? "default" : "outline"}
                        className={
                          leaveDecision === "approved"
                            ? "bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs"
                            : "h-7 text-xs"
                        }
                        onClick={() => {
                          setLeaveDecision("approved");
                          setLeaveCommentErr("");
                        }}
                      >
                        <Check className="size-3 mr-1" />
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={leaveDecision === "rejected" ? "default" : "outline"}
                        className={
                          leaveDecision === "rejected"
                            ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 h-7 text-xs"
                            : "h-7 text-xs"
                        }
                        onClick={() => {
                          setLeaveDecision("rejected");
                          setLeaveCommentErr("");
                        }}
                      >
                        <X className="size-3 mr-1" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <DialogFooter className="gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setReviewLeaveModalOpen(false);
                    setSelectedLeave(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirmLeaveReview}
                  className={
                    leaveDecision === "approved"
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                      : "bg-destructive hover:bg-destructive/90 text-destructive-foreground gap-1.5"
                  }
                >
                  {leaveDecision === "approved" ? (
                    <>
                      <Check className="size-4" />
                      <span>Confirm Approval</span>
                    </>
                  ) : (
                    <>
                      <X className="size-4" />
                      <span>Confirm Rejection</span>
                    </>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* ======================================================== */}
          {/* VIEW DETAILS DIALOG (FOR DECIDED LEAVES)                 */}
          {/* ======================================================== */}
          <Dialog
            open={detailsLeaveModalOpen}
            onOpenChange={(o) => {
              if (!o) {
                setDetailsLeaveModalOpen(false);
                setDetailsLeave(null);
              }
            }}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Leave Request Details</DialogTitle>
                <DialogDescription>
                  Submitted by {detailsLeave ? member(detailsLeave.memberId)?.name : "Employee"}
                </DialogDescription>
              </DialogHeader>

              {detailsLeave && (
                <div className="space-y-4 py-2 text-xs">
                  <div className="flex items-center justify-between border-b pb-3">
                    <span className="text-muted-foreground">Status:</span>
                    <StatusBadge status={detailsLeave.status} />
                  </div>

                  <div className="grid grid-cols-2 gap-3 border-b pb-3">
                    <div>
                      <span className="text-muted-foreground block">Leave Type:</span>
                      <span className="font-semibold text-foreground">
                        {LEAVE_LABEL[detailsLeave.type]}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Duration:</span>
                      <span className="font-semibold text-foreground">
                        {leaveDays(detailsLeave, s.holidays)} working days
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Date Range:</span>
                      <span className="font-mono text-foreground">
                        {detailsLeave.start} to {detailsLeave.end}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Submitted:</span>
                      <span className="font-mono text-foreground">{detailsLeave.createdAt}</span>
                    </div>
                  </div>

                  {detailsLeave.reason && (
                    <div className="border-b pb-3">
                      <span className="text-muted-foreground block mb-1">Employee Reason:</span>
                      <p className="bg-muted/40 p-2.5 rounded-lg text-foreground italic">
                        &quot;{detailsLeave.reason}&quot;
                      </p>
                    </div>
                  )}

                  {detailsLeave.reviewComment && (
                    <div>
                      <span className="text-muted-foreground block mb-1">
                        Reviewer Feedback (
                        {detailsLeave.reviewedBy
                          ? member(detailsLeave.reviewedBy)?.name
                          : "Reviewer"}
                        ):
                      </span>
                      <p className="bg-primary/5 border border-primary/20 p-2.5 rounded-lg text-foreground font-medium">
                        {detailsLeave.reviewComment}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <DialogFooter>
                <Button
                  onClick={() => {
                    setDetailsLeaveModalOpen(false);
                    setDetailsLeave(null);
                  }}
                >
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}
