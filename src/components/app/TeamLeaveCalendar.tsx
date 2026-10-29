import { useState, useMemo } from "react";
import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isWeekend,
  isSameDay,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
} from "date-fns";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Filter,
  Users,
  Clock,
  CheckCircle2,
  CalendarDays,
  Palmtree,
  HeartPulse,
  UserCheck,
  HelpCircle,
  LayoutList,
  CalendarRange,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Initials, StatusBadge } from "@/components/app/common";
import { useDemo, useMe, type LeaveRequest, type LeaveType, type Member } from "@/lib/demo-store";
import { LEAVE_LABEL, leaveDays, teamIds } from "@/lib/rules";
import { isoDay } from "@/lib/time";
import { cn } from "@/lib/utils";

export interface TeamLeaveCalendarProps {
  className?: string;
  defaultMonth?: Date;
  title?: string;
  description?: string;
  showViewToggle?: boolean;
}

const LEAVE_CATEGORY_CONFIG: Record<
  LeaveType,
  {
    label: string;
    shortLabel: string;
    badgeClass: string;
    timelineBarClass: string;
    borderClass: string;
    dotClass: string;
    textColor: string;
    icon: typeof Palmtree;
  }
> = {
  annual: {
    label: "Annual leave",
    shortLabel: "Annual",
    badgeClass:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800",
    timelineBarClass:
      "bg-emerald-500/15 border-emerald-500/40 text-emerald-900 dark:text-emerald-200 hover:bg-emerald-500/25",
    borderClass: "border-emerald-500",
    dotClass: "bg-emerald-500",
    textColor: "text-emerald-600 dark:text-emerald-400",
    icon: Palmtree,
  },
  sick: {
    label: "Sick leave",
    shortLabel: "Sick",
    badgeClass:
      "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300 border-rose-300 dark:border-rose-800",
    timelineBarClass:
      "bg-rose-500/15 border-rose-500/40 text-rose-900 dark:text-rose-200 hover:bg-rose-500/25",
    borderClass: "border-rose-500",
    dotClass: "bg-rose-500",
    textColor: "text-rose-600 dark:text-rose-400",
    icon: HeartPulse,
  },
  personal: {
    label: "Personal leave",
    shortLabel: "Personal",
    badgeClass:
      "bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300 border-sky-300 dark:border-sky-800",
    timelineBarClass:
      "bg-sky-500/15 border-sky-500/40 text-sky-900 dark:text-sky-200 hover:bg-sky-500/25",
    borderClass: "border-sky-500",
    dotClass: "bg-sky-500",
    textColor: "text-sky-600 dark:text-sky-400",
    icon: UserCheck,
  },
  unpaid: {
    label: "Unpaid leave",
    shortLabel: "Unpaid",
    badgeClass:
      "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-300 border-slate-300 dark:border-slate-700",
    timelineBarClass:
      "bg-slate-500/15 border-slate-500/40 text-slate-900 dark:text-slate-200 hover:bg-slate-500/25",
    borderClass: "border-slate-500",
    dotClass: "bg-slate-500",
    textColor: "text-slate-600 dark:text-slate-400",
    icon: HelpCircle,
  },
};

export function TeamLeaveCalendar({
  className,
  defaultMonth,
  title = "Team Leave Calendar",
  description = "Visual month timeline of approved team absences categorized by leave type.",
  showViewToggle = true,
}: TeamLeaveCalendarProps) {
  const me = useMe();
  const s = useDemo((x) => x);
  const today = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => isoDay(today), [today]);

  // Current viewed month date
  const [currentMonthDate, setCurrentMonthDate] = useState<Date>(() => defaultMonth ?? new Date());

  // Category filter: "all" or specific LeaveType
  const [selectedCategory, setSelectedCategory] = useState<"all" | LeaveType>("all");

  // Member filter: "all" or member ID
  const [selectedMemberId, setSelectedMemberId] = useState<string>("all");

  // View mode: timeline or month grid
  const [viewMode, setViewMode] = useState<"timeline" | "grid">("timeline");

  // Selected leave request for detail dialog
  const [selectedLeave, setSelectedLeave] = useState<LeaveRequest | null>(null);

  // Month interval calculation
  const monthStart = useMemo(() => startOfMonth(currentMonthDate), [currentMonthDate]);
  const monthEnd = useMemo(() => endOfMonth(currentMonthDate), [currentMonthDate]);
  const monthStartStr = useMemo(() => isoDay(monthStart), [monthStart]);
  const monthEndStr = useMemo(() => isoDay(monthEnd), [monthEnd]);

  const daysInMonth = useMemo(
    () => eachDayOfInterval({ start: monthStart, end: monthEnd }),
    [monthStart, monthEnd],
  );

  // Calendar grid full-month view intervals (starting Monday)
  const calendarGridDays = useMemo(() => {
    const start = startOfWeek(monthStart, { weekStartsOn: 1 });
    const end = endOfWeek(monthEnd, { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [monthStart, monthEnd]);

  // Team members in scope for this manager/user
  const teamMembers = useMemo(() => {
    const ids = new Set(teamIds(s, me));
    return s.members.filter((m) => ids.has(m.id));
  }, [s, me]);

  const teamMemberIds = useMemo(() => new Set(teamMembers.map((m) => m.id)), [teamMembers]);

  // Filtered members for display
  const displayMembers = useMemo(() => {
    if (selectedMemberId === "all") return teamMembers;
    return teamMembers.filter((m) => m.id === selectedMemberId);
  }, [teamMembers, selectedMemberId]);

  // Approved leave requests for team members that intersect the active month
  const approvedMonthLeaves = useMemo(() => {
    return s.leaves.filter((l) => {
      if (l.status !== "approved") return false;
      if (!teamMemberIds.has(l.memberId)) return false;
      // Overlaps the active month: start <= monthEnd and end >= monthStart
      if (l.start > monthEndStr || l.end < monthStartStr) return false;
      return true;
    });
  }, [s.leaves, teamMemberIds, monthStartStr, monthEndStr]);

  // Apply category and member filters
  const filteredLeaves = useMemo(() => {
    return approvedMonthLeaves.filter((l) => {
      if (selectedCategory !== "all" && l.type !== selectedCategory) return false;
      if (selectedMemberId !== "all" && l.memberId !== selectedMemberId) return false;
      return true;
    });
  }, [approvedMonthLeaves, selectedCategory, selectedMemberId]);

  // Summary statistics for the month
  const monthStats = useMemo(() => {
    const totalDays = approvedMonthLeaves.reduce((acc, l) => acc + leaveDays(l), 0);
    const uniqueMembers = new Set(approvedMonthLeaves.map((l) => l.memberId)).size;

    const byCategory: Record<LeaveType, number> = {
      annual: 0,
      sick: 0,
      personal: 0,
      unpaid: 0,
    };

    approvedMonthLeaves.forEach((l) => {
      if (byCategory[l.type] !== undefined) {
        byCategory[l.type] += leaveDays(l);
      }
    });

    const activeTodayCount = approvedMonthLeaves.filter(
      (l) => l.start <= todayStr && l.end >= todayStr,
    ).length;

    return {
      totalDays,
      uniqueMembers,
      byCategory,
      activeTodayCount,
    };
  }, [approvedMonthLeaves, todayStr]);

  // Navigation handlers
  const handlePrevMonth = () => setCurrentMonthDate((d) => subMonths(d, 1));
  const handleNextMonth = () => setCurrentMonthDate((d) => addMonths(d, 1));
  const handleToday = () => setCurrentMonthDate(new Date());

  // Detail dialog helpers
  const selectedMember = useMemo(
    () => (selectedLeave ? s.members.find((m) => m.id === selectedLeave.memberId) : null),
    [selectedLeave, s.members],
  );

  const selectedReviewer = useMemo(
    () =>
      selectedLeave?.reviewedBy ? s.members.find((m) => m.id === selectedLeave.reviewedBy) : null,
    [selectedLeave, s.members],
  );

  const monthHolidays = useMemo(() => {
    const mStr = format(currentMonthDate, "yyyy-MM");
    return (s.holidays ?? []).filter((h) => h.date.startsWith(mStr));
  }, [s.holidays, currentMonthDate]);

  return (
    <div
      data-testid="team-leave-calendar-card"
      className={cn("rounded-xl border bg-card shadow-card", className)}
    >
      {/* Header bar */}
      <div className="flex flex-col gap-4 border-b p-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <CalendarDays className="size-4.5" />
            </span>
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>

        {/* Controls: Month Nav, Member Selector, View Mode */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Member filter */}
          {teamMembers.length > 1 && (
            <Select value={selectedMemberId} onValueChange={setSelectedMemberId}>
              <SelectTrigger aria-label="Filter by team member" className="h-8 w-44 text-xs">
                <SelectValue placeholder="All Members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Members ({teamMembers.length})</SelectItem>
                {teamMembers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Month Navigation */}
          <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrevMonth}
              aria-label="Previous month"
              className="h-7 w-7 p-0"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span
              data-testid="calendar-month-title"
              className="min-w-[110px] text-center text-xs font-semibold tabular-nums text-foreground"
            >
              {format(currentMonthDate, "MMMM yyyy")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNextMonth}
              aria-label="Next month"
              className="h-7 w-7 p-0"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={handleToday}
            className="h-8 text-xs font-medium"
          >
            Today
          </Button>

          {/* View mode toggle */}
          {showViewToggle && (
            <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode("timeline")}
                aria-label="Timeline view"
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors",
                  viewMode === "timeline"
                    ? "bg-background text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LayoutList className="size-3.5" />
                <span className="hidden sm:inline">Timeline</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                aria-label="Month grid view"
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors",
                  viewMode === "grid"
                    ? "bg-background text-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarRange className="size-3.5" />
                <span className="hidden sm:inline">Month Grid</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Official Company Holidays Banner for Current Month */}
      {monthHolidays.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-amber-500/10 px-5 py-2 text-xs">
          <span className="font-semibold text-foreground flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-amber-600 dark:text-amber-400" />
            {format(currentMonthDate, "MMMM")} Company Holidays ({monthHolidays.length}):
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {monthHolidays.map((h) => (
              <span
                key={h.id}
                className="inline-flex items-center gap-1 rounded-md bg-background/80 border border-amber-300 dark:border-amber-800 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-200"
              >
                <span>{format(parseISO(h.date), "MMM d")}:</span>
                <strong className="font-semibold">{h.name}</strong>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Monthly Statistics & Leave Type Category Filters */}
      <div className="border-b bg-muted/20 px-5 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Quick Stats */}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-muted-foreground">Approved:</span>
              <span className="font-semibold tabular-nums text-foreground">
                {monthStats.totalDays} day{monthStats.totalDays !== 1 ? "s" : ""}
              </span>
            </div>
            <span className="text-muted-foreground/40">•</span>
            <div className="flex items-center gap-1.5">
              <Users className="size-4 text-primary" />
              <span className="text-muted-foreground">Members away:</span>
              <span className="font-semibold tabular-nums text-foreground">
                {monthStats.uniqueMembers}
              </span>
            </div>
            {monthStats.activeTodayCount > 0 && (
              <>
                <span className="text-muted-foreground/40">•</span>
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <Clock className="size-4" />
                  <span className="font-medium">{monthStats.activeTodayCount} on leave today</span>
                </div>
              </>
            )}
          </div>

          {/* Category Filter Buttons */}
          <div
            data-testid="category-filter-group"
            className="flex flex-wrap items-center gap-1.5 text-xs"
          >
            <span className="mr-1 text-[11px] font-medium text-muted-foreground flex items-center gap-1">
              <Filter className="size-3" /> Filter by:
            </span>
            <button
              type="button"
              onClick={() => setSelectedCategory("all")}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                selectedCategory === "all"
                  ? "border-primary bg-primary text-primary-foreground shadow-xs font-semibold"
                  : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              All Types ({approvedMonthLeaves.length})
            </button>
            {(["annual", "sick", "personal", "unpaid"] as const).map((type) => {
              const cfg = LEAVE_CATEGORY_CONFIG[type];
              const count = approvedMonthLeaves.filter((l) => l.type === type).length;
              const isSelected = selectedCategory === type;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedCategory(type)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    isSelected
                      ? "border-foreground bg-foreground text-background shadow-xs font-semibold"
                      : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <span className={cn("size-2 rounded-full", cfg.dotClass)} />
                  <span>{cfg.shortLabel}</span>
                  <span className="text-[10px] opacity-75 font-mono">({count})</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Calendar Viewport */}
      {viewMode === "timeline" ? (
        /* ================= TIMELINE / GANTT VIEW ================= */
        <div className="relative overflow-x-auto p-5">
          <table
            data-testid="leave-timeline-table"
            className="w-full border-collapse text-xs text-left"
          >
            <thead>
              <tr className="border-b bg-muted/40">
                <th
                  scope="col"
                  className="sticky left-0 z-20 min-w-[200px] border-r bg-card/95 p-3 font-semibold text-foreground backdrop-blur-xs shadow-xs"
                >
                  <div className="flex items-center justify-between">
                    <span>Team Member</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({displayMembers.length})
                    </span>
                  </div>
                </th>
                {daysInMonth.map((day) => {
                  const weekend = isWeekend(day);
                  const isCurrentDay = isSameDay(day, today);
                  const dayNum = format(day, "d");
                  const dayName = format(day, "EEE");

                  return (
                    <th
                      key={day.toISOString()}
                      scope="col"
                      className={cn(
                        "min-w-[42px] max-w-[42px] border-r p-1.5 text-center text-[11px] transition-colors",
                        weekend && "bg-muted/60 text-muted-foreground/80",
                        isCurrentDay &&
                          "bg-primary/10 text-primary font-bold border-b-2 border-b-primary",
                      )}
                    >
                      <div className="text-[10px] uppercase font-medium">{dayName[0]}</div>
                      <div
                        className={cn(
                          "font-mono text-xs tabular-nums mt-0.5",
                          isCurrentDay &&
                            "mx-auto size-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold",
                        )}
                      >
                        {dayNum}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {displayMembers.map((member) => {
                // Find member leaves matching the active category filter
                const memberLeaves = filteredLeaves.filter((l) => l.memberId === member.id);
                const memberTotalDays = memberLeaves.reduce((acc, l) => acc + leaveDays(l), 0);

                return (
                  <tr key={member.id} className="hover:bg-muted/20 transition-colors group">
                    {/* Sticky Member Column */}
                    <td className="sticky left-0 z-10 border-r bg-card/95 p-2.5 backdrop-blur-xs group-hover:bg-muted/30 shadow-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Initials name={member.name} className="size-7 text-[10px]" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground text-xs leading-snug">
                              {member.name}
                            </p>
                            <p className="truncate text-[10px] text-muted-foreground leading-snug">
                              {member.title}
                            </p>
                          </div>
                        </div>
                        {memberTotalDays > 0 && (
                          <span
                            title={`${memberTotalDays} approved leave days this month`}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-muted text-foreground"
                          >
                            {memberTotalDays}d
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Day Cells across the month */}
                    {daysInMonth.map((day) => {
                      const dStr = isoDay(day);
                      const weekend = isWeekend(day);
                      const isCurrentDay = isSameDay(day, today);

                      // Check if member has an approved leave on this date
                      const activeLeave = memberLeaves.find(
                        (l) => l.start <= dStr && l.end >= dStr,
                      );

                      if (activeLeave) {
                        const cfg = LEAVE_CATEGORY_CONFIG[activeLeave.type];
                        const isStart = activeLeave.start === dStr;
                        const isEnd = activeLeave.end === dStr;

                        return (
                          <td
                            key={dStr}
                            className={cn(
                              "border-r p-0.5 text-center align-middle relative",
                              weekend ? "bg-muted/40" : "",
                              isCurrentDay ? "bg-primary/5" : "",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => setSelectedLeave(activeLeave)}
                              aria-label={`${member.name}: ${cfg.label} (${activeLeave.start} to ${activeLeave.end}) - ${activeLeave.reason || "Approved"}`}
                              title={`${member.name}: ${cfg.label} (${activeLeave.start} to ${activeLeave.end}) - ${activeLeave.reason || "Approved"}`}
                              className={cn(
                                "w-full h-8 flex flex-col items-center justify-center border text-[9px] font-semibold transition-all shadow-xs cursor-pointer",
                                cfg.timelineBarClass,
                                isStart ? "rounded-l-md" : "rounded-l-none",
                                isEnd ? "rounded-r-md" : "rounded-r-none",
                              )}
                            >
                              <span className="truncate max-w-[36px] font-bold">
                                {cfg.shortLabel.slice(0, 3).toUpperCase()}
                              </span>
                              {activeLeave.partial !== "full" && (
                                <span className="text-[8px] opacity-80 leading-none">
                                  {activeLeave.partial.toUpperCase()}
                                </span>
                              )}
                            </button>
                          </td>
                        );
                      }

                      return (
                        <td
                          key={dStr}
                          className={cn(
                            "border-r p-1 text-center align-middle transition-colors",
                            weekend ? "bg-muted/40" : "",
                            isCurrentDay ? "bg-primary/5" : "",
                          )}
                        >
                          {weekend ? (
                            <span className="text-[10px] text-muted-foreground/40 font-mono">
                              —
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/20 font-mono">
                              ·
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* ================= CALENDAR MONTH GRID VIEW ================= */
        <div className="p-5">
          <div className="grid grid-cols-7 gap-px rounded-lg border bg-border overflow-hidden">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((dayName) => (
              <div
                key={dayName}
                className="bg-muted/60 p-2 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider"
              >
                {dayName}
              </div>
            ))}

            {calendarGridDays.map((day) => {
              const dStr = isoDay(day);
              const isCurrentDay = isSameDay(day, today);
              const isMonthDay = day >= monthStart && day <= monthEnd;
              const weekend = isWeekend(day);

              // Find leaves active on this day
              const dayLeaves = filteredLeaves.filter((l) => l.start <= dStr && l.end >= dStr);

              return (
                <div
                  key={dStr}
                  className={cn(
                    "min-h-[90px] p-1.5 flex flex-col justify-between transition-colors",
                    isMonthDay ? "bg-card" : "bg-muted/20 text-muted-foreground/60",
                    weekend && isMonthDay && "bg-muted/10",
                    isCurrentDay && "ring-2 ring-primary ring-inset",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "text-xs font-mono font-medium",
                        isCurrentDay &&
                          "size-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold",
                        !isMonthDay && "text-muted-foreground/50",
                      )}
                    >
                      {format(day, "d")}
                    </span>
                    {dayLeaves.length > 0 && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {dayLeaves.length} away
                      </span>
                    )}
                  </div>

                  <div className="mt-1 space-y-1 overflow-y-auto max-h-[64px]">
                    {dayLeaves.slice(0, 3).map((l) => {
                      const emp = s.members.find((m) => m.id === l.memberId);
                      const cfg = LEAVE_CATEGORY_CONFIG[l.type];
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => setSelectedLeave(l)}
                          aria-label={`${emp?.name}: ${cfg.label} (${l.start} to ${l.end}) - ${l.reason || "Approved"}`}
                          title={`${emp?.name}: ${cfg.label} (${l.start} to ${l.end}) - ${l.reason || "Approved"}`}
                          className={cn(
                            "w-full text-left truncate rounded px-1.5 py-0.5 text-[10px] font-medium border flex items-center justify-between gap-1 transition-colors",
                            cfg.timelineBarClass,
                          )}
                        >
                          <span className="truncate">{emp?.name.split(" ")[0]}</span>
                          <span className="text-[9px] font-bold uppercase opacity-80">
                            {cfg.shortLabel.slice(0, 3)}
                          </span>
                        </button>
                      );
                    })}
                    {dayLeaves.length > 3 && (
                      <span className="block text-center text-[9px] text-muted-foreground font-medium">
                        +{dayLeaves.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend & Summary Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/10 px-5 py-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-medium text-foreground">Legend:</span>
          {(["annual", "sick", "personal", "unpaid"] as const).map((type) => {
            const cfg = LEAVE_CATEGORY_CONFIG[type];
            return (
              <span key={type} className="flex items-center gap-1.5">
                <span className={cn("size-2.5 rounded-xs", cfg.dotClass)} />
                <span className="capitalize">{cfg.label}</span>
              </span>
            );
          })}
        </div>
        <div className="text-[11px] text-muted-foreground/80">
          Showing approved leaves for {format(currentMonthDate, "MMMM yyyy")}
        </div>
      </div>

      {/* Leave Details Dialog */}
      <Dialog open={!!selectedLeave} onOpenChange={(open) => !open && setSelectedLeave(null)}>
        <DialogContent className="max-w-md">
          {selectedLeave && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-3 rounded-full",
                      LEAVE_CATEGORY_CONFIG[selectedLeave.type].dotClass,
                    )}
                  />
                  <DialogTitle>Leave Details</DialogTitle>
                </div>
                <DialogDescription>
                  Approved time off entry recorded for team schedule planning.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-4 space-y-4 text-xs">
                {/* Employee info */}
                <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                  <Initials name={selectedMember?.name ?? "Employee"} className="size-9" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm text-foreground">{selectedMember?.name}</p>
                    <p className="text-muted-foreground">
                      {selectedMember?.title} • {selectedMember?.department || "Team"}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-md border px-2 py-0.5 font-medium uppercase text-[10px]",
                      LEAVE_CATEGORY_CONFIG[selectedLeave.type].badgeClass,
                    )}
                  >
                    {LEAVE_LABEL[selectedLeave.type]}
                  </span>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border p-2.5 bg-card">
                    <span className="text-muted-foreground block text-[11px]">Date Range</span>
                    <span className="font-semibold text-foreground font-mono mt-0.5 block">
                      {selectedLeave.start === selectedLeave.end ? (
                        format(parseISO(selectedLeave.start), "MMM d, yyyy")
                      ) : (
                        <>
                          {format(parseISO(selectedLeave.start), "MMM d")} –{" "}
                          {format(parseISO(selectedLeave.end), "MMM d, yyyy")}
                        </>
                      )}
                    </span>
                  </div>

                  <div className="rounded-md border p-2.5 bg-card">
                    <span className="text-muted-foreground block text-[11px]">Duration</span>
                    <span className="font-semibold text-foreground font-mono mt-0.5 block">
                      {leaveDays(selectedLeave)} day
                      {leaveDays(selectedLeave) !== 1 ? "s" : ""}{" "}
                      <span className="text-muted-foreground font-normal">
                        (
                        {selectedLeave.partial === "full"
                          ? "Full day"
                          : `${selectedLeave.partial.toUpperCase()} half-day`}
                        )
                      </span>
                    </span>
                  </div>
                </div>

                {/* Reason */}
                {selectedLeave.reason && (
                  <div className="rounded-md border p-2.5 bg-card">
                    <span className="text-muted-foreground block text-[11px]">Reason</span>
                    <p className="mt-1 text-foreground leading-relaxed">{selectedLeave.reason}</p>
                  </div>
                )}

                {/* Approval metadata */}
                <div className="rounded-md border p-2.5 bg-muted/20 flex items-center justify-between">
                  <div>
                    <span className="text-muted-foreground block text-[10px]">Status</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 mt-0.5">
                      <CheckCircle2 className="size-3.5" /> Approved
                    </span>
                  </div>
                  {selectedReviewer && (
                    <div className="text-right">
                      <span className="text-muted-foreground block text-[10px]">Approved By</span>
                      <span className="font-medium text-foreground">{selectedReviewer.name}</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
