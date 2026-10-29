import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import {
  format,
  parseISO,
  addDays,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameDay,
  isWeekend,
} from "date-fns";
import {
  CalendarDays,
  Clock,
  CheckCircle2,
  AlertCircle,
  Plus,
  Calendar,
  Check,
  X,
  User,
  ShieldCheck,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Search,
  Users,
  Sparkles,
  TrendingUp,
  PartyPopper,
  Building,
  Info,
  CalendarRange,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, Initials, PageHeader, StatCard, StatusBadge } from "@/components/app/common";
import {
  useDemo,
  useMe,
  addLeave,
  setLeave,
  removeLeave,
  upsertHoliday,
  removeHoliday,
  addAuditLog,
  uid,
  type LeaveRequest,
  type LeaveType,
  type DayPart,
  type CompanyHoliday,
  type HolidayType,
} from "@/lib/demo-store";
import {
  LEAVE_LABEL,
  leaveDays,
  leaveBalance,
  memberAllLeaveBalances,
  staffLeaveEntitlements,
  calculateMonthlyAccrual,
  validateLeave,
  overlapsExisting,
  canReviewLeave,
  decideLeave,
  teamIds,
  type LeaveInput,
  type StaffLeaveEntitlement,
} from "@/lib/rules";
import { LeaveBalanceProgress } from "@/components/app/LeaveBalanceProgress";
import { TeamLeaveCalendar } from "@/components/app/TeamLeaveCalendar";
import { isoDay } from "@/lib/time";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/timeoff")({
  head: () =>
    pageHead("Leave Management", "Manage employee leave requests, balances and absence calendars."),
  component: TimeOffPage,
});

export function TimeOffPage() {
  const me = useMe();
  const s = useDemo((x) => x);
  const currentYear = new Date().getFullYear();
  const todayStr = isoDay(new Date());

  // Tabs
  const [activeTab, setActiveTab] = useState<
    "mine" | "review" | "calendar" | "holidays" | "balances"
  >("mine");

  // Filters
  const [myStatusFilter, setMyStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">(
    "all",
  );
  const [mySearch, setMySearch] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [balancesSearch, setBalancesSearch] = useState("");

  // Holiday filters and dialog state
  const [holidaySearch, setHolidaySearch] = useState("");
  const [holidayTypeFilter, setHolidayTypeFilter] = useState<"all" | HolidayType>("all");
  const [addHolidayOpen, setAddHolidayOpen] = useState(false);
  const [newHolidayName, setNewHolidayName] = useState("");
  const [newHolidayDate, setNewHolidayDate] = useState(todayStr);
  const [newHolidayType, setNewHolidayType] = useState<HolidayType>("festival");
  const [newHolidayDescription, setNewHolidayDescription] = useState("");
  const [addHolidayError, setAddHolidayError] = useState("");

  // Request leave dialog state
  const [requestOpen, setRequestOpen] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>("annual");
  const [startDate, setStartDate] = useState(todayStr);
  const [endDate, setEndDate] = useState(todayStr);
  const [partial, setPartial] = useState<DayPart>("full");
  const [reason, setReason] = useState("");
  const [requestError, setRequestError] = useState("");

  // Review dialog state (Manager/Admin)
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [selectedReq, setSelectedReq] = useState<LeaveRequest | null>(null);
  const [reviewDecision, setReviewDecision] = useState<"approved" | "rejected">("approved");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewError, setReviewError] = useState("");

  // Balances
  const myBalance = useMemo(() => leaveBalance(s, me.id, currentYear), [s, me.id, currentYear]);

  // Scoped members & requests
  const teamMembers = useMemo(() => {
    const ids = new Set(teamIds(s, me));
    return s.members.filter((m) => ids.has(m.id));
  }, [s, me]);

  const teamMemberIds = useMemo(() => new Set(teamMembers.map((m) => m.id)), [teamMembers]);

  // My requests list (filtered)
  const allMyRequests = useMemo(
    () =>
      s.leaves.filter((l) => l.memberId === me.id).sort((a, b) => b.start.localeCompare(a.start)),
    [s.leaves, me.id],
  );

  const filteredMyRequests = useMemo(() => {
    return allMyRequests.filter((req) => {
      if (myStatusFilter !== "all" && req.status !== myStatusFilter) return false;
      if (mySearch.trim()) {
        const query = mySearch.toLowerCase();
        const typeMatch = LEAVE_LABEL[req.type].toLowerCase().includes(query);
        const reasonMatch = req.reason?.toLowerCase().includes(query);
        const dateMatch = req.start.includes(query) || req.end.includes(query);
        if (!typeMatch && !reasonMatch && !dateMatch) return false;
      }
      return true;
    });
  }, [allMyRequests, myStatusFilter, mySearch]);

  // Reviewable pending requests for manager/admin
  const pendingReviewRequests = useMemo(
    () =>
      s.leaves
        .filter((l) => l.status === "pending" && canReviewLeave(s, me, l))
        .sort((a, b) => a.start.localeCompare(b.start)),
    [s, me],
  );

  const filteredPendingRequests = useMemo(() => {
    if (!reviewSearch.trim()) return pendingReviewRequests;
    const q = reviewSearch.toLowerCase();
    return pendingReviewRequests.filter((r) => {
      const emp = s.members.find((m) => m.id === r.memberId);
      const nameMatch = emp?.name.toLowerCase().includes(q);
      const typeMatch = LEAVE_LABEL[r.type].toLowerCase().includes(q);
      const reasonMatch = r.reason?.toLowerCase().includes(q);
      return nameMatch || typeMatch || reasonMatch;
    });
  }, [pendingReviewRequests, reviewSearch, s.members]);

  // Historical decisions in scope
  const allTeamRequests = useMemo(() => {
    if (me.role === "Employee") return [];
    return s.leaves
      .filter((l) => teamMemberIds.has(l.memberId))
      .sort((a, b) => b.start.localeCompare(a.start));
  }, [s.leaves, me.role, teamMemberIds]);

  // Contextual team statistics
  const teamMetrics = useMemo(() => {
    const todayLeaves = s.leaves.filter(
      (l) =>
        l.status === "approved" &&
        teamMemberIds.has(l.memberId) &&
        l.start <= todayStr &&
        l.end >= todayStr,
    );
    const approvedTeamDays = s.leaves
      .filter(
        (l) =>
          l.status === "approved" &&
          teamMemberIds.has(l.memberId) &&
          l.start.startsWith(String(currentYear)),
      )
      .reduce((acc, l) => acc + leaveDays(l), 0);

    return {
      outToday: todayLeaves.length,
      approvedDays: approvedTeamDays,
    };
  }, [s.leaves, teamMemberIds, todayStr, currentYear]);

  // Calculated days for modal (automatically excluding company holidays and weekends)
  const estimatedDays = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return 0;
    return leaveDays({ start: startDate, end: endDate, partial }, s.holidays);
  }, [startDate, endDate, partial, s.holidays]);

  // Holidays that fall in the requested range
  const rangeHolidays = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return [];
    return (s.holidays ?? []).filter((h) => h.date >= startDate && h.date <= endDate);
  }, [startDate, endDate, s.holidays]);

  // Filtered company holidays
  const filteredHolidays = useMemo(() => {
    return (s.holidays ?? [])
      .filter((h) => {
        if (holidayTypeFilter !== "all" && h.type !== holidayTypeFilter) return false;
        if (holidaySearch.trim()) {
          const q = holidaySearch.toLowerCase();
          return (
            h.name.toLowerCase().includes(q) ||
            h.date.includes(q) ||
            (h.description && h.description.toLowerCase().includes(q))
          );
        }
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [s.holidays, holidayTypeFilter, holidaySearch]);

  // Next upcoming holiday
  const nextUpcomingHoliday = useMemo(() => {
    const upcoming = (s.holidays ?? [])
      .filter((h) => h.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming[0] || null;
  }, [s.holidays, todayStr]);

  // Staff leave entitlements directory
  const allStaffEntitlements = useMemo(() => {
    return staffLeaveEntitlements(s, currentYear);
  }, [s, currentYear]);

  const filteredStaffEntitlements = useMemo(() => {
    if (!balancesSearch.trim()) return allStaffEntitlements;
    const q = balancesSearch.toLowerCase();
    return allStaffEntitlements.filter(
      (ent) =>
        ent.member.name.toLowerCase().includes(q) ||
        ent.member.role.toLowerCase().includes(q) ||
        ent.member.title.toLowerCase().includes(q),
    );
  }, [allStaffEntitlements, balancesSearch]);

  // Member lookup
  const memberLookup = (id: string) => s.members.find((m) => m.id === id);

  // Handle submit leave
  const handleSubmitRequest = (e: React.FormEvent) => {
    e.preventDefault();
    setRequestError("");

    const input: LeaveInput = {
      type: leaveType,
      start: startDate,
      end: endDate,
      partial,
      reason: reason.trim(),
    };

    const err = validateLeave(input, todayStr, s.holidays);
    if (err) {
      setRequestError(err);
      return;
    }

    const overlap = overlapsExisting(s.leaves, me.id, input);
    if (overlap) {
      setRequestError(
        `Conflicts with an existing ${overlap.status} request from ${overlap.start} to ${overlap.end}.`,
      );
      return;
    }

    // Check balance for annual, sick, or personal leave using actual working days (excluding holidays)
    const currentBalances = memberAllLeaveBalances(s, me.id, currentYear);
    const days = leaveDays(input, s.holidays);
    if (leaveType === "annual") {
      if (days > currentBalances.annual.remaining) {
        setRequestError(
          `Insufficient annual balance: requesting ${days}d, remaining ${currentBalances.annual.remaining}d.`,
        );
        return;
      }
    } else if (leaveType === "sick") {
      if (days > currentBalances.sick.remaining) {
        setRequestError(
          `Insufficient sick leave balance: requesting ${days}d, remaining ${currentBalances.sick.remaining}d.`,
        );
        return;
      }
    } else if (leaveType === "personal") {
      if (days > currentBalances.personal.remaining) {
        setRequestError(
          `Insufficient personal balance: requesting ${days}d, remaining ${currentBalances.personal.remaining}d.`,
        );
        return;
      }
    }

    const newRequest: LeaveRequest = {
      id: uid("leave"),
      memberId: me.id,
      type: leaveType,
      start: startDate,
      end: endDate,
      partial,
      reason: reason.trim(),
      status: "pending",
      createdAt: todayStr,
    };

    addLeave(newRequest);
    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Leave Requested",
      category: "leave",
      details: `${LEAVE_LABEL[leaveType]} submitted (${days}d: ${startDate} to ${endDate})`,
    });

    toast.success("Leave request submitted successfully for manager approval.");
    setRequestOpen(false);
    setReason("");
  };

  // Handle add holiday
  const handleAddHoliday = (e: React.FormEvent) => {
    e.preventDefault();
    setAddHolidayError("");
    if (!newHolidayName.trim()) {
      setAddHolidayError("Please provide a holiday name.");
      return;
    }
    if (!newHolidayDate) {
      setAddHolidayError("Please choose a date.");
      return;
    }
    const exists = (s.holidays ?? []).some((h) => h.date === newHolidayDate);
    if (exists) {
      setAddHolidayError(`A holiday on ${newHolidayDate} already exists.`);
      return;
    }
    const holiday: CompanyHoliday = {
      id: uid("hol"),
      name: newHolidayName.trim(),
      date: newHolidayDate,
      type: newHolidayType,
      mandatory: true,
      description: newHolidayDescription.trim() || undefined,
    };
    upsertHoliday(holiday);
    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Holiday Added",
      category: "policy",
      details: `Added holiday: ${holiday.name} (${holiday.date})`,
    });
    toast.success(`Holiday "${holiday.name}" added to company calendar.`);
    setAddHolidayOpen(false);
    setNewHolidayName("");
    setNewHolidayDescription("");
  };

  // Handle delete holiday
  const handleRemoveHoliday = (h: CompanyHoliday) => {
    removeHoliday(h.id);
    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Holiday Removed",
      category: "policy",
      details: `Removed holiday: ${h.name} (${h.date})`,
    });
    toast.success(`Holiday "${h.name}" removed from calendar.`);
  };

  // Handle cancel pending leave
  const handleCancelRequest = (req: LeaveRequest) => {
    if (req.status !== "pending") {
      toast.error("Only pending requests can be cancelled.");
      return;
    }
    removeLeave(req.id);
    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Leave Cancelled",
      category: "leave",
      details: `Cancelled pending ${LEAVE_LABEL[req.type]} (${req.start} to ${req.end})`,
    });
    toast.success("Leave request cancelled.");
  };

  // Open review modal
  const openReviewModal = (req: LeaveRequest, decision: "approved" | "rejected") => {
    setSelectedReq(req);
    setReviewDecision(decision);
    setReviewComment("");
    setReviewError("");
    setReviewModalOpen(true);
  };

  // Confirm review
  const handleConfirmReview = () => {
    if (!selectedReq) return;
    try {
      const updated = decideLeave(selectedReq, reviewDecision, reviewComment, me.id);
      setLeave(updated);
      const requester = s.members.find((m) => m.id === selectedReq.memberId)?.name ?? "Employee";
      addAuditLog({
        actorId: me.id,
        actorName: me.name,
        action: reviewDecision === "approved" ? "Leave Approved" : "Leave Rejected",
        category: "leave",
        details: `${reviewDecision === "approved" ? "Approved" : "Rejected"} ${requester}'s ${LEAVE_LABEL[selectedReq.type]} (${selectedReq.start} to ${selectedReq.end})${reviewComment ? ` - Reason: ${reviewComment}` : ""}`,
      });
      toast.success(`Leave request ${reviewDecision}.`);
      setReviewModalOpen(false);
      setSelectedReq(null);
    } catch (err: unknown) {
      setReviewError(err instanceof Error ? err.message : "Failed to record review");
    }
  };

  // Balance of currently selected employee in review modal
  const selectedReqBalance = useMemo(() => {
    if (!selectedReq) return null;
    return leaveBalance(s, selectedReq.memberId, currentYear);
  }, [selectedReq, s, currentYear]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave Management"
        description="Submit time off requests, check annual balances and review team absence schedules."
        actions={
          <Button onClick={() => setRequestOpen(true)} className="gap-2 shadow-xs">
            <Plus className="size-4" />
            Request Leave
          </Button>
        }
      />

      {/* Top Overview: Visual Progress Bars for Employee, Team Metrics for Manager/Admin */}
      {me.role === "Employee" ? (
        <LeaveBalanceProgress
          onRequestLeave={(type) => {
            setLeaveType(type);
            setRequestOpen(true);
          }}
          year={currentYear}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Pending Team Requests"
            value={pendingReviewRequests.length}
            hint={
              pendingReviewRequests.length === 0
                ? "All requests reviewed"
                : `${pendingReviewRequests.length} require action`
            }
            icon={Clock}
            tone={pendingReviewRequests.length > 0 ? "warning" : "primary"}
          />
          <StatCard
            label="Team On Leave Today"
            value={teamMetrics.outToday}
            hint={`${teamMembers.length} active team members`}
            icon={Users}
            tone="teal"
          />
          <StatCard
            label="Team Days Approved"
            value={`${teamMetrics.approvedDays} days`}
            hint={`${currentYear} booked absences`}
            icon={CheckCircle2}
            tone="success"
          />
          <StatCard
            label="My Remaining Leave"
            value={`${myBalance.remaining} days`}
            hint={`${myBalance.used}d used of ${myBalance.entitlement}d`}
            icon={CalendarDays}
            tone="primary"
          />
        </div>
      )}

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex sm:grid-cols-none">
          <TabsTrigger value="mine" className="gap-2">
            <Clock className="size-4" />
            My Requests ({allMyRequests.length})
          </TabsTrigger>
          {me.role !== "Employee" && (
            <TabsTrigger value="review" className="gap-2">
              <ShieldCheck className="size-4" />
              Team Review
              {pendingReviewRequests.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 px-2 py-0.5 text-[0.7rem] font-bold text-white">
                  {pendingReviewRequests.length}
                </span>
              )}
            </TabsTrigger>
          )}
          <TabsTrigger value="calendar" className="gap-2">
            <Calendar className="size-4" />
            Team Calendar
          </TabsTrigger>
          <TabsTrigger value="holidays" className="gap-2">
            <PartyPopper className="size-4" />
            Holiday Calendar ({s.holidays?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="balances" className="gap-2">
            <Sparkles className="size-4" />
            Staff Entitlements
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: My Requests */}
        <TabsContent value="mine" className="mt-4 space-y-4">
          {me.role !== "Employee" && (
            <LeaveBalanceProgress
              onRequestLeave={(type) => {
                setLeaveType(type);
                setRequestOpen(true);
              }}
              year={currentYear}
            />
          )}

          <div className="rounded-xl border bg-card shadow-card">
            <div className="border-b px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h2 className="font-semibold text-foreground">My Leave History</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Track the status of your submitted, approved and scheduled time off.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative w-44">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search requests..."
                    value={mySearch}
                    onChange={(e) => setMySearch(e.target.value)}
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                {/* Status segmented control */}
                <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-0.5 text-xs">
                  {(["all", "pending", "approved", "rejected"] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setMyStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-md capitalize font-medium transition-colors ${
                        myStatusFilter === st
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRequestOpen(true)}
                  className="gap-1.5 h-8"
                >
                  <Plus className="size-3.5" />
                  New Request
                </Button>
              </div>
            </div>

            {filteredMyRequests.length === 0 ? (
              <div className="py-12">
                <EmptyState
                  icon={CalendarDays}
                  title={
                    allMyRequests.length === 0 ? "No leave requests found" : "No matching requests"
                  }
                  description={
                    allMyRequests.length === 0
                      ? "You have not submitted any leave requests yet for this period."
                      : "Try clearing your search query or status filter."
                  }
                  action={
                    allMyRequests.length === 0 ? (
                      <Button onClick={() => setRequestOpen(true)} size="sm">
                        Submit Your First Request
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setMyStatusFilter("all");
                          setMySearch("");
                        }}
                      >
                        Reset Filters
                      </Button>
                    )
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3">Type</th>
                      <th className="px-5 py-3">Dates</th>
                      <th className="px-5 py-3">Duration</th>
                      <th className="px-5 py-3">Partition</th>
                      <th className="px-5 py-3">Reason</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredMyRequests.map((req) => {
                      const days = leaveDays(req);
                      const reviewer = req.reviewedBy ? memberLookup(req.reviewedBy)?.name : null;
                      return (
                        <tr key={req.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-5 py-3 font-medium text-foreground">
                            {LEAVE_LABEL[req.type]}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs tabular-nums">
                            {req.start === req.end ? (
                              <span>{format(parseISO(req.start), "MMM d, yyyy")}</span>
                            ) : (
                              <span>
                                {format(parseISO(req.start), "MMM d")} –{" "}
                                {format(parseISO(req.end), "MMM d, yyyy")}
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs tabular-nums">
                            <span className="font-semibold text-foreground">{days}</span> day
                            {days !== 1 ? "s" : ""}
                          </td>
                          <td className="px-5 py-3">
                            <span className="text-xs text-muted-foreground capitalize">
                              {req.partial === "full"
                                ? "Full day"
                                : `${req.partial.toUpperCase()} half-day`}
                            </span>
                          </td>
                          <td
                            className="px-5 py-3 max-w-[220px] truncate text-muted-foreground text-xs"
                            title={req.reason}
                          >
                            {req.reason || "—"}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex flex-col gap-0.5">
                              <StatusBadge status={req.status} />
                              {req.reviewComment && (
                                <span
                                  className="text-[11px] text-muted-foreground truncate max-w-[180px]"
                                  title={req.reviewComment}
                                >
                                  {reviewer ? `${reviewer}: ` : ""}&quot;{req.reviewComment}&quot;
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right">
                            {req.status === "pending" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleCancelRequest(req)}
                                className="h-8 gap-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="size-3.5" />
                                Cancel
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground font-mono">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Tab 2: Team Review (Manager / Admin) */}
        {me.role !== "Employee" && (
          <TabsContent value="review" className="mt-4 space-y-6">
            {/* Pending approvals section */}
            <div className="rounded-xl border bg-card shadow-card">
              <div className="border-b px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="font-semibold text-foreground">Pending Team Requests</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Requests from members of your assigned projects and managed teams.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative w-48">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Filter requests..."
                      value={reviewSearch}
                      onChange={(e) => setReviewSearch(e.target.value)}
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <Badge variant={pendingReviewRequests.length > 0 ? "default" : "outline"}>
                    {pendingReviewRequests.length} Pending Action
                  </Badge>
                </div>
              </div>

              {filteredPendingRequests.length === 0 ? (
                <div className="py-10 text-center">
                  <CheckCircle2 className="mx-auto size-9 text-emerald-500 opacity-80" />
                  <h3 className="mt-2 text-sm font-medium">All caught up</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pendingReviewRequests.length === 0
                      ? "No pending leave requests require your review right now."
                      : "No pending requests matched your search query."}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                      <tr>
                        <th className="px-5 py-3">Employee</th>
                        <th className="px-5 py-3">Leave Type</th>
                        <th className="px-5 py-3">Requested Period</th>
                        <th className="px-5 py-3">Duration</th>
                        <th className="px-5 py-3">Balance Info</th>
                        <th className="px-5 py-3">Reason</th>
                        <th className="px-5 py-3 text-right">Decision</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {filteredPendingRequests.map((req) => {
                        const emp = memberLookup(req.memberId);
                        const days = leaveDays(req);
                        const bal = emp ? leaveBalance(s, emp.id, currentYear) : null;
                        return (
                          <tr key={req.id} className="hover:bg-muted/30 transition-colors">
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-2.5">
                                <Initials name={emp?.name ?? "User"} size="sm" />
                                <div>
                                  <div className="font-medium text-foreground">{emp?.name}</div>
                                  <div className="text-xs text-muted-foreground">{emp?.title}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-5 py-3 font-medium text-foreground">
                              {LEAVE_LABEL[req.type]}
                            </td>
                            <td className="px-5 py-3 font-mono text-xs tabular-nums">
                              {req.start === req.end ? (
                                <span>{format(parseISO(req.start), "MMM d, yyyy")}</span>
                              ) : (
                                <span>
                                  {format(parseISO(req.start), "MMM d")} –{" "}
                                  {format(parseISO(req.end), "MMM d, yyyy")}
                                </span>
                              )}
                              {req.partial !== "full" && (
                                <span className="ml-1.5 text-muted-foreground">
                                  ({req.partial.toUpperCase()})
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 font-mono text-xs tabular-nums">
                              <span className="font-semibold text-foreground">{days}</span> day
                              {days !== 1 ? "s" : ""}
                            </td>
                            <td className="px-5 py-3 text-xs text-muted-foreground font-mono tabular-nums">
                              {bal ? `${bal.remaining}d remaining` : "—"}
                            </td>
                            <td
                              className="px-5 py-3 max-w-[200px] truncate text-muted-foreground text-xs"
                              title={req.reason}
                            >
                              {req.reason || "—"}
                            </td>
                            <td className="px-5 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openReviewModal(req, "rejected")}
                                  className="h-8 gap-1 text-destructive hover:bg-destructive/10"
                                >
                                  <X className="size-3.5" />
                                  Reject
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => openReviewModal(req, "approved")}
                                  className="h-8 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                                >
                                  <Check className="size-3.5" />
                                  Approve
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Past Decisions in scope */}
            <div className="rounded-xl border bg-card shadow-card">
              <div className="border-b px-5 py-4">
                <h2 className="font-semibold text-foreground">Recent Team Decisions</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Historical leave decisions made for your team.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3">Employee</th>
                      <th className="px-5 py-3">Type</th>
                      <th className="px-5 py-3">Dates</th>
                      <th className="px-5 py-3">Days</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Reviewer Comments</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {allTeamRequests
                      .filter((r) => r.status !== "pending")
                      .slice(0, 8)
                      .map((req) => {
                        const emp = memberLookup(req.memberId);
                        const days = leaveDays(req);
                        return (
                          <tr key={req.id} className="hover:bg-muted/30 transition-colors">
                            <td className="px-5 py-3 font-medium text-foreground">{emp?.name}</td>
                            <td className="px-5 py-3">{LEAVE_LABEL[req.type]}</td>
                            <td className="px-5 py-3 font-mono text-xs tabular-nums">
                              {req.start} to {req.end}
                            </td>
                            <td className="px-5 py-3 font-mono text-xs tabular-nums">{days}d</td>
                            <td className="px-5 py-3">
                              <StatusBadge status={req.status} />
                            </td>
                            <td className="px-5 py-3 text-xs text-muted-foreground">
                              {req.reviewComment || "—"}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </TabsContent>
        )}

        {/* Tab 3: Team Absence Calendar */}
        <TabsContent value="calendar" className="mt-4 space-y-4">
          <TeamLeaveCalendar
            title="Team Absence Schedule"
            description="Monthly timeline of approved employee leaves categorized by leave type."
          />
        </TabsContent>

        {/* Tab 4: Official Holiday Calendar (Accessible to all staff) */}
        <TabsContent value="holidays" className="mt-4 space-y-4">
          <div className="rounded-xl border bg-card shadow-card">
            <div className="border-b px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-foreground">
                    Official Holiday Calendar ({currentYear})
                  </h2>
                  <Badge
                    variant="outline"
                    className="bg-primary/5 text-primary border-primary/20 text-xs"
                  >
                    {s.holidays?.length ?? 0} Paid Holidays
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Official company-recognized holidays. Leaves booked on holidays are automatically
                  excluded from leave deductions.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative w-48">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search holidays..."
                    value={holidaySearch}
                    onChange={(e) => setHolidaySearch(e.target.value)}
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                {me.role !== "Employee" && (
                  <Button
                    size="sm"
                    onClick={() => setAddHolidayOpen(true)}
                    className="gap-1.5 h-8 text-xs"
                  >
                    <Plus className="size-3.5" />
                    Add Holiday
                  </Button>
                )}
              </div>
            </div>

            {/* Next upcoming holiday spotlight banner */}
            {nextUpcomingHoliday && (
              <div className="mx-5 mt-4 p-4 rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-transparent flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="size-11 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
                    <PartyPopper className="size-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                        Next Upcoming Holiday
                      </span>
                      <Badge className="bg-primary text-primary-foreground text-[10px] px-1.5 py-0 h-4">
                        {isSameDay(parseISO(nextUpcomingHoliday.date), new Date())
                          ? "Today!"
                          : `${format(parseISO(nextUpcomingHoliday.date), "EEEE, MMM d, yyyy")}`}
                      </Badge>
                    </div>
                    <div className="text-base font-bold text-foreground mt-0.5">
                      {nextUpcomingHoliday.name}
                    </div>
                    {nextUpcomingHoliday.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {nextUpcomingHoliday.description}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 self-start sm:self-auto">
                  <Badge variant="outline" className="capitalize text-xs font-medium">
                    {nextUpcomingHoliday.type} Holiday
                  </Badge>
                </div>
              </div>
            )}

            {/* Filter pills */}
            <div className="px-5 pt-3 pb-2 flex flex-wrap items-center gap-1.5 text-xs border-b">
              {(
                [
                  { key: "all", label: `All (${s.holidays?.length ?? 0})` },
                  {
                    key: "national",
                    label: `National (${(s.holidays ?? []).filter((h) => h.type === "national").length})`,
                  },
                  {
                    key: "festival",
                    label: `Festival (${(s.holidays ?? []).filter((h) => h.type === "festival").length})`,
                  },
                  {
                    key: "gazetted",
                    label: `Gazetted (${(s.holidays ?? []).filter((h) => h.type === "gazetted").length})`,
                  },
                  {
                    key: "company",
                    label: `Company (${(s.holidays ?? []).filter((h) => h.type === "company").length})`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setHolidayTypeFilter(tab.key as typeof holidayTypeFilter)}
                  className={`px-3 py-1 rounded-md transition-colors ${
                    holidayTypeFilter === tab.key
                      ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                      : "bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Holiday table */}
            <div className="overflow-x-auto">
              {filteredHolidays.length === 0 ? (
                <div className="py-12">
                  <EmptyState
                    icon={PartyPopper}
                    title="No holidays found"
                    description={
                      holidaySearch
                        ? `No holidays match "${holidaySearch}".`
                        : "No company holidays configured for this category."
                    }
                  />
                </div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 w-40">Date</th>
                      <th className="px-5 py-3 w-32">Day</th>
                      <th className="px-5 py-3">Holiday Name</th>
                      <th className="px-5 py-3 w-32">Category</th>
                      <th className="px-5 py-3">Observance & Details</th>
                      {me.role !== "Employee" && (
                        <th className="px-5 py-3 text-right w-20">Actions</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredHolidays.map((h) => {
                      const dateObj = parseISO(h.date);
                      const isPast = h.date < todayStr;
                      const isToday = h.date === todayStr;
                      return (
                        <tr
                          key={h.id}
                          className={`hover:bg-muted/30 transition-colors ${
                            isToday ? "bg-primary/5 font-medium" : isPast ? "opacity-70" : ""
                          }`}
                        >
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-semibold text-foreground text-xs">
                                {format(dateObj, "MMM d, yyyy")}
                              </span>
                              {isToday && (
                                <Badge className="bg-emerald-600 text-[10px] px-1 py-0 h-4">
                                  Today
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-xs text-muted-foreground">
                            {format(dateObj, "EEEE")}
                          </td>
                          <td className="px-5 py-3.5">
                            <span className="font-semibold text-foreground text-sm">{h.name}</span>
                          </td>
                          <td className="px-5 py-3.5">
                            <Badge
                              variant="outline"
                              className={`capitalize text-xs font-medium ${
                                h.type === "national"
                                  ? "border-blue-500/30 text-blue-700 bg-blue-500/10 dark:text-blue-400"
                                  : h.type === "festival"
                                    ? "border-amber-500/30 text-amber-700 bg-amber-500/10 dark:text-amber-400"
                                    : h.type === "gazetted"
                                      ? "border-emerald-500/30 text-emerald-700 bg-emerald-500/10 dark:text-emerald-400"
                                      : "border-purple-500/30 text-purple-700 bg-purple-500/10 dark:text-purple-400"
                              }`}
                            >
                              {h.type}
                            </Badge>
                          </td>
                          <td className="px-5 py-3.5 text-xs text-muted-foreground">
                            {h.description || "Official paid public holiday."}
                          </td>
                          {me.role !== "Employee" && (
                            <td className="px-5 py-3.5 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveHoliday(h)}
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                title="Remove holiday"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="border-t px-5 py-3 bg-muted/20 text-xs text-muted-foreground flex items-center gap-2">
              <Info className="size-4 shrink-0 text-primary" />
              <span>
                Note: All 13 company holidays are fully paid. When an employee takes leave spanning
                any of these dates, TimeFlow automatically deducts 0 working days for holiday dates.
              </span>
            </div>
          </div>
        </TabsContent>

        {/* Tab 5: Staff Entitlements & Accrual Policy (Accessible to all staff) */}
        <TabsContent value="balances" className="mt-4 space-y-5">
          {/* Policy Overview Highlights */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl border bg-card p-4 shadow-card space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
                <span>Paid Leave (PL) Accrual</span>
                <TrendingUp className="size-4 text-primary" />
              </div>
              <div className="text-xl font-bold text-foreground">1.5 days / mo</div>
              <p className="text-[11px] text-muted-foreground">
                18 days annual cap · Accrues on 1st of each month
              </p>
            </div>

            <div className="rounded-xl border bg-card p-4 shadow-card space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
                <span>Yearly Sick Leave (SL)</span>
                <AlertCircle className="size-4 text-emerald-600" />
              </div>
              <div className="text-xl font-bold text-foreground">10 days / yr</div>
              <p className="text-[11px] text-muted-foreground">
                Credited Jan 1 · Backdatable for medical illness
              </p>
            </div>

            <div className="rounded-xl border bg-card p-4 shadow-card space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
                <span>Personal Leave (CL)</span>
                <User className="size-4 text-amber-500" />
              </div>
              <div className="text-xl font-bold text-foreground">5 days / yr</div>
              <p className="text-[11px] text-muted-foreground">
                Credited Jan 1 · For personal affairs & emergencies
              </p>
            </div>

            <div className="rounded-xl border bg-card p-4 shadow-card space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
                <span>Company Holidays</span>
                <PartyPopper className="size-4 text-purple-500" />
              </div>
              <div className="text-xl font-bold text-foreground">
                {s.holidays?.length ?? 13} days / yr
              </div>
              <p className="text-[11px] text-muted-foreground">
                Gazetted & festival holidays · 0 leave deduction
              </p>
            </div>
          </div>

          {/* Personal entitlement spotlight card for the viewing staff member */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5 shadow-card">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-primary/15 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Badge className="bg-primary text-primary-foreground text-xs font-semibold">
                    My Entitlements
                  </Badge>
                  <span className="text-sm font-bold text-foreground">{me.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ({me.role} · {me.title})
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  You accrue{" "}
                  <strong className="text-foreground">1.5 days of Paid Leave (PL)</strong> every
                  month. You have accrued{" "}
                  <strong className="text-foreground">
                    {calculateMonthlyAccrual(new Date()).accruedToDate} days
                  </strong>{" "}
                  to date through {format(new Date(), "MMMM yyyy")}.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => setRequestOpen(true)}
                className="gap-1.5 shrink-0 shadow-xs"
              >
                <Plus className="size-3.5" />
                Request Time Off
              </Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4">
              <div className="rounded-lg bg-background/80 p-3 border">
                <span className="text-xs text-muted-foreground block">Annual PL (18d max)</span>
                <span className="text-lg font-bold text-foreground tabular-nums">
                  {myBalance.remaining}d remaining
                </span>
                <span className="text-[11px] text-muted-foreground block mt-0.5">
                  {myBalance.used}d used · {myBalance.pending}d pending
                </span>
              </div>
              <div className="rounded-lg bg-background/80 p-3 border">
                <span className="text-xs text-muted-foreground block">Sick Leave (10d grant)</span>
                <span className="text-lg font-bold text-emerald-600 tabular-nums">
                  {memberAllLeaveBalances(s, me.id, currentYear).sick.remaining}d remaining
                </span>
                <span className="text-[11px] text-muted-foreground block mt-0.5">
                  {memberAllLeaveBalances(s, me.id, currentYear).sick.used}d used
                </span>
              </div>
              <div className="rounded-lg bg-background/80 p-3 border">
                <span className="text-xs text-muted-foreground block">
                  Personal Leave (5d grant)
                </span>
                <span className="text-lg font-bold text-amber-600 tabular-nums">
                  {memberAllLeaveBalances(s, me.id, currentYear).personal.remaining}d remaining
                </span>
                <span className="text-[11px] text-muted-foreground block mt-0.5">
                  {memberAllLeaveBalances(s, me.id, currentYear).personal.used}d used
                </span>
              </div>
              <div className="rounded-lg bg-background/80 p-3 border">
                <span className="text-xs text-muted-foreground block">Total Balance Available</span>
                <span className="text-lg font-bold text-primary tabular-nums">
                  {myBalance.remaining +
                    memberAllLeaveBalances(s, me.id, currentYear).sick.remaining +
                    memberAllLeaveBalances(s, me.id, currentYear).personal.remaining}
                  d available
                </span>
                <span className="text-[11px] text-muted-foreground block mt-0.5">
                  Across all 3 leave types
                </span>
              </div>
            </div>
          </div>

          {/* Consolidated Staff Entitlements Table */}
          <div className="rounded-xl border bg-card shadow-card">
            <div className="border-b px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h2 className="font-semibold text-foreground">
                  Staff Leave Entitlements Directory ({currentYear})
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Consolidated monthly PL accruals, annual sick/personal leave allotments, and
                  utilization for all staff.
                </p>
              </div>
              <div className="relative w-52">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search staff by name or role..."
                  value={balancesSearch}
                  onChange={(e) => setBalancesSearch(e.target.value)}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3">Staff Member</th>
                    <th className="px-4 py-3 text-center">PL Accrual</th>
                    <th className="px-4 py-3 text-right">Accrued YTD</th>
                    <th className="px-5 py-3 text-right">Annual (PL)</th>
                    <th className="px-5 py-3 text-right">Sick Leave (10d)</th>
                    <th className="px-5 py-3 text-right">Personal (5d)</th>
                    <th className="px-5 py-3 text-right">Total Remaining</th>
                    <th className="px-5 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredStaffEntitlements.map((ent) => {
                    const m = ent.member;
                    const isMe = m.id === me.id;
                    const isOnLeave = s.leaves.some(
                      (l) =>
                        l.memberId === m.id &&
                        l.status === "approved" &&
                        l.start <= todayStr &&
                        l.end >= todayStr,
                    );
                    const hasPending = ent.totalPending > 0;

                    return (
                      <tr
                        key={m.id}
                        className={`hover:bg-muted/30 transition-colors ${
                          isMe ? "bg-primary/5 font-medium" : ""
                        }`}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Initials name={m.name} size="sm" />
                            <div>
                              <div className="font-semibold text-foreground flex items-center gap-1.5">
                                {m.name}
                                {isMe && (
                                  <Badge className="text-[10px] px-1 py-0 h-4 bg-primary text-primary-foreground">
                                    You
                                  </Badge>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {m.title} · {m.role}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Badge
                            variant="outline"
                            className="font-mono text-xs text-primary bg-primary/5 border-primary/20"
                          >
                            +{ent.monthlyPaidLeaveAccrual}d / mo
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium text-foreground tabular-nums">
                          {ent.accruedPaidLeaveToDate}d
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums">
                          <span className="font-bold text-foreground">{ent.annual.remaining}d</span>
                          <span className="text-xs text-muted-foreground ml-1">
                            ({ent.annual.used}d used)
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums">
                          <span className="font-bold text-emerald-600">{ent.sick.remaining}d</span>
                          <span className="text-xs text-muted-foreground ml-1">
                            ({ent.sick.used}d used)
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right font-mono tabular-nums">
                          <span className="font-bold text-amber-600">
                            {ent.personal.remaining}d
                          </span>
                          <span className="text-xs text-muted-foreground ml-1">
                            ({ent.personal.used}d used)
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right font-mono font-bold text-foreground text-sm tabular-nums">
                          {ent.totalRemaining} days
                        </td>
                        <td className="px-5 py-3 text-center">
                          {isOnLeave ? (
                            <Badge className="bg-amber-500 text-white text-[11px]">On Leave</Badge>
                          ) : hasPending ? (
                            <Badge
                              variant="outline"
                              className="text-amber-600 border-amber-300 text-[11px]"
                            >
                              {ent.totalPending}d Pending
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-emerald-600 border-emerald-300 text-[11px]"
                            >
                              Active
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialog: Submit Request */}
      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Request Time Off</DialogTitle>
            <DialogDescription>
              Submit a leave request for manager review and calendar booking.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmitRequest} className="space-y-4 pt-2">
            {requestError && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span>{requestError}</span>
              </div>
            )}

            {rangeHolidays.length > 0 && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-2">
                <PartyPopper className="size-4 shrink-0 mt-0.5 text-emerald-600" />
                <div>
                  <span className="font-semibold">
                    Includes {rangeHolidays.length} company holiday
                    {rangeHolidays.length > 1 ? "s" : ""}:
                  </span>{" "}
                  {rangeHolidays
                    .map((h) => `${h.name} (${format(parseISO(h.date), "MMM d")})`)
                    .join(", ")}
                  .
                  <span className="block mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                    Official holidays are paid and automatically excluded from your leave deduction!
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="leaveType">Leave Category</Label>
              <Select value={leaveType} onValueChange={(v) => setLeaveType(v as LeaveType)}>
                <SelectTrigger id="leaveType">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="annual">Annual Leave (18d entitlement)</SelectItem>
                  <SelectItem value="sick">Sick Leave (10d entitlement)</SelectItem>
                  <SelectItem value="personal">Personal Leave (5d entitlement)</SelectItem>
                  <SelectItem value="unpaid">Unpaid Leave</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dayPart">Day Partition</Label>
              <Select value={partial} onValueChange={(v) => setPartial(v as DayPart)}>
                <SelectTrigger id="dayPart">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full Day</SelectItem>
                  <SelectItem value="am">Half Day – Morning (AM)</SelectItem>
                  <SelectItem value="pm">Half Day – Afternoon (PM)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Half-day requests only apply when start and end dates match.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reason">Reason / Note</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Brief reason for your absence (required for unpaid leave)..."
                rows={2}
                maxLength={300}
              />
            </div>

            <div className="rounded-lg bg-muted/50 p-3 text-xs flex justify-between items-center">
              <div>
                <span className="text-muted-foreground">Estimated working days:</span>
                {leaveType !== "unpaid" && (
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    Remaining balance:{" "}
                    {
                      memberAllLeaveBalances(s, me.id, currentYear)[
                        leaveType as "annual" | "sick" | "personal"
                      ]?.remaining
                    }
                    d available
                  </span>
                )}
              </div>
              <span className="font-semibold text-foreground text-sm font-mono tabular-nums">
                {estimatedDays} day{estimatedDays !== 1 ? "s" : ""}
              </span>
            </div>

            <DialogFooter className="gap-2 sm:gap-0 pt-2">
              <Button type="button" variant="outline" onClick={() => setRequestOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Submit Request</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog: Review & Decide */}
      <Dialog open={reviewModalOpen} onOpenChange={setReviewModalOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {reviewDecision === "approved" ? "Approve" : "Reject"} Leave Request
            </DialogTitle>
            <DialogDescription>
              {reviewDecision === "approved"
                ? "Confirm this request to approve and record on the absence calendar."
                : "Provide feedback explaining why this request cannot be approved."}
            </DialogDescription>
          </DialogHeader>

          {selectedReq && (
            <div className="space-y-4 pt-2">
              {reviewError && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
                  {reviewError}
                </div>
              )}

              <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Employee:</span>
                  <span className="font-medium text-foreground">
                    {memberLookup(selectedReq.memberId)?.name} (
                    {memberLookup(selectedReq.memberId)?.title})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type:</span>
                  <span className="font-medium text-foreground">
                    {LEAVE_LABEL[selectedReq.type]}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Requested Period:</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {selectedReq.start} to {selectedReq.end} ({leaveDays(selectedReq)}d)
                  </span>
                </div>
                {selectedReqBalance && selectedReq.type === "annual" && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Annual Balance:</span>
                    <span className="font-mono text-foreground tabular-nums">
                      {selectedReqBalance.remaining}d remaining (out of{" "}
                      {selectedReqBalance.entitlement}d)
                    </span>
                  </div>
                )}
                {selectedReq.reason && (
                  <div className="flex justify-between pt-1 border-t">
                    <span className="text-muted-foreground">Employee Note:</span>
                    <span className="text-foreground italic max-w-[240px] text-right">
                      &quot;{selectedReq.reason}&quot;
                    </span>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="reviewComment">
                  Review Comment{" "}
                  {reviewDecision === "rejected" && <span className="text-destructive">*</span>}
                </Label>
                <Textarea
                  id="reviewComment"
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder={
                    reviewDecision === "rejected"
                      ? "Mandatory reason for rejecting (minimum 3 characters)..."
                      : "Optional note for employee..."
                  }
                  rows={3}
                />
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setReviewModalOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirmReview}
                  className={
                    reviewDecision === "approved"
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                      : "bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  }
                >
                  Confirm {reviewDecision === "approved" ? "Approval" : "Rejection"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog: Add Company Holiday (Manager/Admin) */}
      <Dialog open={addHolidayOpen} onOpenChange={setAddHolidayOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Add Official Company Holiday</DialogTitle>
            <DialogDescription>
              Configure an official paid holiday. Days marked as holidays are not deducted from
              employee leave quotas.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleAddHoliday} className="space-y-4 pt-2">
            {addHolidayError && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span>{addHolidayError}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="holidayName">Holiday Name</Label>
              <Input
                id="holidayName"
                placeholder="e.g., Diwali, Independence Day, Christmas"
                value={newHolidayName}
                onChange={(e) => setNewHolidayName(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="holidayDate">Date</Label>
                <Input
                  id="holidayDate"
                  type="date"
                  value={newHolidayDate}
                  onChange={(e) => setNewHolidayDate(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="holidayType">Category</Label>
                <Select
                  value={newHolidayType}
                  onValueChange={(v) => setNewHolidayType(v as HolidayType)}
                >
                  <SelectTrigger id="holidayType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="festival">Festival</SelectItem>
                    <SelectItem value="national">National Holiday</SelectItem>
                    <SelectItem value="gazetted">Gazetted Holiday</SelectItem>
                    <SelectItem value="company">Company Special</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="holidayDesc">Description (Optional)</Label>
              <Textarea
                id="holidayDesc"
                placeholder="Brief description or cultural observance notes..."
                value={newHolidayDescription}
                onChange={(e) => setNewHolidayDescription(e.target.value)}
                rows={2}
                maxLength={200}
              />
            </div>

            <DialogFooter className="gap-2 sm:gap-0 pt-2">
              <Button type="button" variant="outline" onClick={() => setAddHolidayOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Add to Calendar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
