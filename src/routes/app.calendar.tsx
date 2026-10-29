import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import {
  format,
  parseISO,
  addDays,
  subWeeks,
  addWeeks,
  startOfWeek,
  eachDayOfInterval,
  isSameDay,
  isWeekend,
} from "date-fns";
import {
  CalendarRange,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Plus,
  ChevronLeft,
  ChevronRight,
  Filter,
  Users,
  Briefcase,
  AlertCircle,
  Trash2,
  Edit2,
  CalendarDays,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { EmptyState, Initials, PageHeader, StatCard } from "@/components/app/common";
import {
  useDemo,
  useMe,
  upsertAllocation,
  removeAllocation,
  addAuditLog,
  uid,
  type Allocation,
  type AllocationStatus,
} from "@/lib/demo-store";
import {
  checkAllocation,
  validateAllocationHours,
  findConflicts,
  canEditAllocation,
  dayLoad,
  leaveOn,
  LEAVE_LABEL,
  scopedMembers,
  scopedProjects,
  type Conflict,
} from "@/lib/rules";
import { isoDay } from "@/lib/time";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/calendar")({
  head: () =>
    pageHead(
      "Resource Planning",
      "Weekly team capacity, project assignments and allocation conflict management.",
    ),
  component: ResourcePlanningPage,
});

export function ResourcePlanningPage() {
  const me = useMe();
  const s = useDemo((x) => x);
  const todayStr = isoDay(new Date());

  // Week navigation state (Monday of selected week)
  const [currentWeekStart, setCurrentWeekStart] = useState<string>(() => {
    const monday = startOfWeek(new Date(), { weekStartsOn: 1 });
    return isoDay(monday);
  });

  // Filters
  const [filterProject, setFilterProject] = useState<string>("all");
  const [filterMember, setFilterMember] = useState<string>("all");
  const [showConflictsOnly, setShowConflictsOnly] = useState<boolean>(false);

  // Allocation Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAllocId, setEditingAllocId] = useState<string | null>(null);
  const [formProjectId, setFormProjectId] = useState<string>("");
  const [formMemberId, setFormMemberId] = useState<string>("");
  const [formDate, setFormDate] = useState<string>(todayStr);
  const [formHours, setFormHours] = useState<string>("8");
  const [formStatus, setFormStatus] = useState<AllocationStatus>("confirmed");
  const [formError, setFormError] = useState<string>("");

  // Scoped members & projects
  const accessibleMembers = useMemo(() => scopedMembers(s, me), [s, me]);
  const accessibleProjects = useMemo(() => scopedProjects(s, me), [s, me]);

  // Days of the selected week (Mon - Fri or Mon - Sun)
  const weekDays = useMemo(() => {
    const mon = parseISO(currentWeekStart);
    // 5 working days (Mon-Fri)
    return [0, 1, 2, 3, 4].map((offset) => addDays(mon, offset));
  }, [currentWeekStart]);

  const weekDateStrings = useMemo(() => weekDays.map((d) => isoDay(d)), [weekDays]);

  // Can the user edit allocations? (Admin or Manager with managed projects)
  const canManage = me.role === "Admin" || (me.role === "Manager" && accessibleProjects.length > 0);

  // Filtered members list
  const visibleMembers = useMemo(() => {
    return accessibleMembers.filter((m) => {
      if (filterMember !== "all" && m.id !== filterMember) return false;
      return true;
    });
  }, [accessibleMembers, filterMember]);

  // All allocations in current week for visible members
  const weekAllocations = useMemo(() => {
    const dates = new Set(weekDateStrings);
    return s.allocations.filter((a) => {
      if (!dates.has(a.date)) return false;
      if (filterProject !== "all" && a.projectId !== filterProject) return false;
      return true;
    });
  }, [s.allocations, weekDateStrings, filterProject]);

  // Conflicts in current week
  const allConflicts = useMemo(() => {
    const conflicts = findConflicts(
      s,
      visibleMembers.map((m) => m.id),
    );
    const dates = new Set(weekDateStrings);
    return conflicts.filter((c) => dates.has(c.date));
  }, [s, visibleMembers, weekDateStrings]);

  // Metrics
  const totalPlannedHours = useMemo(() => {
    return weekAllocations.reduce((acc, a) => acc + a.hours, 0);
  }, [weekAllocations]);

  const confirmedHours = useMemo(() => {
    return weekAllocations
      .filter((a) => a.status === "confirmed")
      .reduce((acc, a) => acc + a.hours, 0);
  }, [weekAllocations]);

  const tentativeHours = useMemo(() => {
    return weekAllocations
      .filter((a) => a.status === "tentative")
      .reduce((acc, a) => acc + a.hours, 0);
  }, [weekAllocations]);

  // Real-time conflict preview in allocation modal
  const liveConflictCheck = useMemo(() => {
    if (!formMemberId || !formDate || !formHours) return null;
    const h = parseFloat(formHours);
    if (isNaN(h) || h <= 0) return null;
    return checkAllocation(s, {
      id: editingAllocId ?? undefined,
      memberId: formMemberId,
      date: formDate,
      hours: h,
    });
  }, [s, formMemberId, formDate, formHours, editingAllocId]);

  // Handlers for Week Navigation
  const prevWeek = () => {
    setCurrentWeekStart((curr) => isoDay(subWeeks(parseISO(curr), 1)));
  };
  const nextWeek = () => {
    setCurrentWeekStart((curr) => isoDay(addWeeks(parseISO(curr), 1)));
  };
  const resetToCurrentWeek = () => {
    setCurrentWeekStart(isoDay(startOfWeek(new Date(), { weekStartsOn: 1 })));
  };

  // Open modal to create or edit
  const openCreateModal = (memberId?: string, date?: string) => {
    setEditingAllocId(null);
    setFormMemberId(memberId ?? (visibleMembers[0]?.id || ""));
    setFormProjectId(accessibleProjects[0]?.id || "");
    setFormDate(date ?? currentWeekStart);
    setFormHours("8");
    setFormStatus("confirmed");
    setFormError("");
    setModalOpen(true);
  };

  const openEditModal = (alloc: Allocation) => {
    if (!canEditAllocation(s, me, alloc.projectId)) {
      toast.error("You don't have permission to modify allocations for this project.");
      return;
    }
    setEditingAllocId(alloc.id);
    setFormMemberId(alloc.memberId);
    setFormProjectId(alloc.projectId);
    setFormDate(alloc.date);
    setFormHours(alloc.hours.toString());
    setFormStatus(alloc.status);
    setFormError("");
    setModalOpen(true);
  };

  // Save Allocation
  const handleSaveAllocation = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!canEditAllocation(s, me, formProjectId)) {
      setFormError("You can only manage allocations on projects you lead.");
      return;
    }

    const hours = parseFloat(formHours);
    const err = validateAllocationHours(hours);
    if (err) {
      setFormError(err);
      return;
    }

    const newAlloc: Allocation = {
      id: editingAllocId || uid("alloc"),
      memberId: formMemberId,
      projectId: formProjectId,
      date: formDate,
      hours,
      status: formStatus,
    };

    upsertAllocation(newAlloc);

    const memberName = s.members.find((m) => m.id === formMemberId)?.name ?? "Member";
    const projName = s.projects.find((p) => p.id === formProjectId)?.name ?? "Project";

    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: editingAllocId ? "Allocation Updated" : "Allocation Created",
      category: "allocation",
      details: `${editingAllocId ? "Updated" : "Scheduled"} ${memberName} for ${hours}h on ${projName} (${formDate}, ${formStatus})`,
    });

    toast.success(editingAllocId ? "Allocation updated." : "Resource allocated successfully.");
    setModalOpen(false);
  };

  // Delete Allocation
  const handleDeleteAllocation = () => {
    if (!editingAllocId) return;
    const existing = s.allocations.find((a) => a.id === editingAllocId);
    if (!existing) return;

    if (!canEditAllocation(s, me, existing.projectId)) {
      toast.error("Permission denied to remove this allocation.");
      return;
    }

    removeAllocation(editingAllocId);

    const memberName = s.members.find((m) => m.id === existing.memberId)?.name ?? "Member";
    const projName = s.projects.find((p) => p.id === existing.projectId)?.name ?? "Project";

    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Allocation Removed",
      category: "allocation",
      details: `Removed ${existing.hours}h allocation for ${memberName} on ${projName} (${existing.date})`,
    });

    toast.success("Allocation removed.");
    setModalOpen(false);
  };

  const projectLookup = (id: string) => s.projects.find((p) => p.id === id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Resource Planning"
        description="Weekly scheduling, project work allocation, team capacity tracking and conflict detection."
        action={
          canManage && (
            <Button onClick={() => openCreateModal()} className="gap-2 shadow-xs">
              <Plus className="size-4" />
              Assign Resource
            </Button>
          )
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Planned Workload"
          value={`${totalPlannedHours.toFixed(1)}h`}
          meta={`Week of ${format(parseISO(currentWeekStart), "MMM d")}`}
          icon={<Clock className="size-5 text-primary" />}
        />
        <StatCard
          label="Confirmed Hours"
          value={`${confirmedHours.toFixed(1)}h`}
          meta={`${totalPlannedHours > 0 ? Math.round((confirmedHours / totalPlannedHours) * 100) : 0}% locked in`}
          icon={<CheckCircle2 className="size-5 text-emerald-600" />}
        />
        <StatCard
          label="Tentative Hours"
          value={`${tentativeHours.toFixed(1)}h`}
          meta="Pipeline & unconfirmed"
          icon={<CalendarRange className="size-5 text-amber-500" />}
        />
        <StatCard
          label="Capacity Conflicts"
          value={allConflicts.length.toString()}
          meta={allConflicts.length > 0 ? "Requires rebalancing" : "All schedules balanced"}
          icon={
            <AlertTriangle
              className={`size-5 ${allConflicts.length > 0 ? "text-destructive" : "text-emerald-500"}`}
            />
          }
        />
      </div>

      {/* Conflicts Banner (if any) */}
      {allConflicts.length > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-destructive">
                  {allConflicts.length} Schedule Conflict{allConflicts.length !== 1 ? "s" : ""}{" "}
                  Detected in Current Week
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowConflictsOnly((v) => !v)}
                  className="h-7 text-xs text-destructive hover:bg-destructive/10"
                >
                  {showConflictsOnly ? "Show All Team Members" : "Filter Conflicted Members"}
                </Button>
              </div>
              <ul className="text-xs text-muted-foreground divide-y divide-destructive/10">
                {allConflicts.map((c, i) => {
                  const member = s.members.find((m) => m.id === c.memberId);
                  return (
                    <li key={i} className="py-1 flex items-center justify-between">
                      <span className="font-medium text-foreground">
                        {member?.name} ({format(parseISO(c.date), "EEE, MMM d")}):
                      </span>
                      <span className="text-destructive font-mono">{c.detail}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Control Bar: Week Navigator & Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-xl border bg-card p-4 shadow-card">
        {/* Week navigation */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={prevWeek} className="h-9 gap-1">
            <ChevronLeft className="size-4" />
            Prev Week
          </Button>
          <Button variant="outline" size="sm" onClick={resetToCurrentWeek} className="h-9">
            Today
          </Button>
          <Button variant="outline" size="sm" onClick={nextWeek} className="h-9 gap-1">
            Next Week
            <ChevronRight className="size-4" />
          </Button>
          <div className="ml-2 font-semibold text-sm text-foreground">
            {format(parseISO(currentWeekStart), "MMM d")} –{" "}
            {format(addDays(parseISO(currentWeekStart), 4), "MMM d, yyyy")}
          </div>
        </div>

        {/* Filter dropdowns */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filterProject} onValueChange={setFilterProject}>
            <SelectTrigger className="w-[180px] h-9 text-xs">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {accessibleProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterMember} onValueChange={setFilterMember}>
            <SelectTrigger className="w-[170px] h-9 text-xs">
              <SelectValue placeholder="All Members" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Members</SelectItem>
              {accessibleMembers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(filterProject !== "all" || filterMember !== "all" || showConflictsOnly) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilterProject("all");
                setFilterMember("all");
                setShowConflictsOnly(false);
              }}
              className="h-9 text-xs"
            >
              Reset Filters
            </Button>
          )}
        </div>
      </div>

      {/* Main Allocation Matrix Grid */}
      <div className="rounded-xl border bg-card shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="p-3 font-semibold text-foreground min-w-[200px] border-r">
                  Team Member & Weekly Load
                </th>
                {weekDays.map((date) => {
                  const dStr = isoDay(date);
                  const isToday = isSameDay(date, parseISO(todayStr));
                  return (
                    <th
                      key={dStr}
                      className={`p-3 font-semibold min-w-[170px] border-r last:border-r-0 ${
                        isToday ? "bg-primary/10 text-primary font-bold" : "text-foreground"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span>{format(date, "EEEE")}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {format(date, "MMM d")}
                        </span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleMembers
                .filter((m) => {
                  if (!showConflictsOnly) return true;
                  return allConflicts.some((c) => c.memberId === m.id);
                })
                .map((m) => {
                  const memberAllocs = s.allocations.filter((a) => a.memberId === m.id);
                  const memberWeeklyTotal = weekDateStrings.reduce((acc, d) => {
                    return acc + dayLoad(memberAllocs, m.id, d);
                  }, 0);
                  const weeklyCapacity = (s.settings.dailyTarget || 8) * 5;

                  return (
                    <tr key={m.id} className="hover:bg-muted/10 transition-colors">
                      {/* Member Info & Week Summary Column */}
                      <td className="p-3 border-r align-top bg-muted/5">
                        <div className="flex items-start gap-2.5">
                          <Initials name={m.name} size="sm" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-foreground truncate">{m.name}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {m.title}
                            </div>
                            <div className="mt-2 flex items-center justify-between text-[11px]">
                              <span className="text-muted-foreground">Weekly Total:</span>
                              <span
                                className={`font-mono font-bold ${
                                  memberWeeklyTotal > weeklyCapacity
                                    ? "text-destructive"
                                    : "text-foreground"
                                }`}
                              >
                                {memberWeeklyTotal.toFixed(1)}h / {weeklyCapacity}h
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 w-full bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full ${
                                  memberWeeklyTotal > weeklyCapacity
                                    ? "bg-destructive"
                                    : "bg-primary"
                                }`}
                                style={{
                                  width: `${Math.min((memberWeeklyTotal / weeklyCapacity) * 100, 100)}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Day Columns */}
                      {weekDateStrings.map((dStr) => {
                        const dayAllocs = memberAllocs.filter((a) => a.date === dStr);
                        const load = dayLoad(memberAllocs, m.id, dStr);
                        const capacity = s.settings.dailyTarget || 8;
                        const isOver = load > capacity;
                        const leave = leaveOn(s.leaves, m.id, dStr);
                        const isToday = dStr === todayStr;

                        return (
                          <td
                            key={dStr}
                            className={`p-2.5 border-r last:border-r-0 align-top ${
                              isToday ? "bg-primary/[0.03]" : ""
                            } ${isOver ? "bg-destructive/[0.04]" : ""}`}
                          >
                            {/* Day Header (Load + Leave Status) */}
                            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-border/50 text-[11px]">
                              <div className="flex items-center gap-1 font-mono">
                                <span
                                  className={
                                    isOver
                                      ? "text-destructive font-bold"
                                      : load > 0
                                        ? "text-foreground font-semibold"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {load.toFixed(1)}h
                                </span>
                                <span className="text-muted-foreground/60">/ {capacity}h</span>
                              </div>

                              {canManage && (
                                <button
                                  type="button"
                                  onClick={() => openCreateModal(m.id, dStr)}
                                  className="text-muted-foreground hover:text-primary p-0.5 rounded transition-colors"
                                  title={`Assign work on ${dStr}`}
                                >
                                  <Plus className="size-3.5" />
                                </button>
                              )}
                            </div>

                            {/* Leave warning if away */}
                            {leave && (
                              <div
                                className={`mb-1.5 px-2 py-1 rounded text-[10px] font-medium flex items-center gap-1.5 ${
                                  leave.status === "approved"
                                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800"
                                    : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800"
                                }`}
                                title={`Scheduled ${LEAVE_LABEL[leave.type]} (${leave.status})`}
                              >
                                <CalendarDays className="size-3 shrink-0" />
                                <span className="truncate">
                                  {LEAVE_LABEL[leave.type].split(" ")[0]} ({leave.status})
                                </span>
                              </div>
                            )}

                            {/* Over-capacity warning badge */}
                            {isOver && (
                              <div className="mb-1.5 px-2 py-0.5 rounded bg-destructive/10 text-destructive text-[10px] font-semibold flex items-center gap-1">
                                <AlertTriangle className="size-3 shrink-0" />
                                <span>+{load - capacity}h over cap</span>
                              </div>
                            )}

                            {/* Allocations Cards in Cell */}
                            <div className="space-y-1.5">
                              {dayAllocs.length === 0 && !leave && (
                                <div className="text-[10px] text-muted-foreground/40 italic py-2 text-center">
                                  No planned tasks
                                </div>
                              )}

                              {dayAllocs.map((alloc) => {
                                const proj = projectLookup(alloc.projectId);
                                const canEditThis = canEditAllocation(s, me, alloc.projectId);

                                return (
                                  <div
                                    key={alloc.id}
                                    onClick={() => canEditThis && openEditModal(alloc)}
                                    className={`rounded-md p-1.5 border transition-all text-[11px] ${
                                      alloc.status === "confirmed"
                                        ? "bg-card border-border shadow-xs hover:border-primary/50"
                                        : "bg-amber-500/5 border-dashed border-amber-400 dark:border-amber-700 hover:border-amber-500"
                                    } ${canEditThis ? "cursor-pointer" : ""}`}
                                    title={`${proj?.name ?? "Project"}: ${alloc.hours}h (${alloc.status})`}
                                  >
                                    <div className="flex items-center justify-between font-medium">
                                      <span className="truncate text-foreground max-w-[100px]">
                                        {proj?.name ?? "Project"}
                                      </span>
                                      <span className="font-mono font-semibold ml-1 shrink-0">
                                        {alloc.hours}h
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between text-[10px] mt-0.5 text-muted-foreground">
                                      <span
                                        className={
                                          alloc.status === "confirmed"
                                            ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                            : "text-amber-600 dark:text-amber-400 font-medium"
                                        }
                                      >
                                        {alloc.status}
                                      </span>
                                      {canEditThis && (
                                        <Edit2 className="size-2.5 opacity-60 hover:opacity-100" />
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Project Allocation Breakdown Summary */}
      <div className="rounded-xl border bg-card p-5 shadow-card">
        <h2 className="font-semibold text-foreground text-sm">Week Project Allocation Summary</h2>
        <p className="text-xs text-muted-foreground mt-0.5 mb-4">
          Total dedicated hours across all active projects for the selected weekly window.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {accessibleProjects.map((p) => {
            const projAllocs = weekAllocations.filter((a) => a.projectId === p.id);
            const hours = projAllocs.reduce((sum, a) => sum + a.hours, 0);
            const teamAssigned = new Set(projAllocs.map((a) => a.memberId)).size;

            return (
              <div key={p.id} className="rounded-lg border bg-muted/20 p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground truncate">{p.name}</span>
                  <Badge variant={hours > 0 ? "default" : "outline"} className="text-[10px]">
                    {hours.toFixed(1)}h
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                  <span>
                    {teamAssigned} member{teamAssigned !== 1 ? "s" : ""} allocated
                  </span>
                  <span>Budget: {p.budgetHours ? `${p.budgetHours}h` : "N/A"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dialog: Assign / Edit Allocation */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {editingAllocId ? "Edit Resource Allocation" : "Assign Resource to Project"}
            </DialogTitle>
            <DialogDescription>
              Schedule dedicated daily project hours and monitor capacity limits in real time.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveAllocation} className="space-y-4 pt-2">
            {formError && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start gap-2">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            {/* Live Conflict Warning */}
            {liveConflictCheck?.exceeds && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
                  Capacity Warning
                </div>
                <p>
                  Total planned hours will reach {liveConflictCheck.total}h, exceeding the daily
                  target of {liveConflictCheck.capacity}h.
                </p>
              </div>
            )}

            {liveConflictCheck?.leave && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive space-y-1">
                <div className="flex items-center gap-1.5 font-semibold">
                  <CalendarDays className="size-3.5 shrink-0" />
                  Leave Conflict Warning
                </div>
                <p>
                  This member has a {liveConflictCheck.leave.status}{" "}
                  {LEAVE_LABEL[liveConflictCheck.leave.type]} on this date.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="allocProject">Project</Label>
              <Select value={formProjectId} onValueChange={setFormProjectId}>
                <SelectTrigger id="allocProject">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {accessibleProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="allocMember">Team Member</Label>
              <Select value={formMemberId} onValueChange={setFormMemberId}>
                <SelectTrigger id="allocMember">
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {accessibleMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name} ({m.title})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="allocDate">Date</Label>
                <Input
                  id="allocDate"
                  type="date"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="allocHours">Planned Hours</Label>
                <Input
                  id="allocHours"
                  type="number"
                  step="0.25"
                  min="0.25"
                  max="24"
                  value={formHours}
                  onChange={(e) => setFormHours(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="allocStatus">Commitment Status</Label>
              <Select
                value={formStatus}
                onValueChange={(v) => setFormStatus(v as AllocationStatus)}
              >
                <SelectTrigger id="allocStatus">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="confirmed">Confirmed (Committed load)</SelectItem>
                  <SelectItem value="tentative">Tentative (Tentative planning)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter className="gap-2 sm:gap-0 pt-2 flex items-center justify-between">
              {editingAllocId ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDeleteAllocation}
                  className="text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-4 mr-1" />
                  Delete
                </Button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit">{editingAllocId ? "Save Changes" : "Assign Hours"}</Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
