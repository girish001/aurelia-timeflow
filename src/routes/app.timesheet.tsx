import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addWeeks, format, parseISO, subWeeks } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Copy,
  Save,
  Send,
  Lock,
  CalendarClock,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Calendar,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState, PageHeader, StatusBadge } from "@/components/app/common";
import {
  useMe,
  uid,
  upsertTimesheet,
  copyPreviousWeek,
  useDemo,
  type Timesheet,
  type State,
} from "@/lib/demo-store";
import { DAYS, formatHours, isoDay, parseHours, weekDates, weekKey, weekLabel } from "@/lib/time";
import { pageHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/timesheet")({
  head: () => pageHead("My Timesheet", "Log weekly hours by client, project and task."),
  component: TimesheetPage,
});

interface Row {
  id: string;
  clientId: string;
  projectId: string;
  task: string;
  hours: string[];
  billable: boolean;
  notes: string;
}

export function TimesheetPage() {
  const me = useMe();
  const CURRENT_USER_ID = me.id;
  const [week, setWeek] = useState(() => weekKey(new Date()));
  const sheet = useDemo((s) =>
    s.timesheets.find((t) => t.memberId === CURRENT_USER_ID && t.weekStart === week),
  );
  const state = useDemo((s) => s);
  const thisWeek = weekKey(new Date());

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Timesheet"
        description="Enter hours as decimals (7.5) or hours:minutes (7:30) in 15-minute increments."
        actions={
          <div className="flex items-center gap-1 rounded-xl border bg-card p-1 shadow-card">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous week"
              onClick={() => setWeek(weekKey(subWeeks(parseISO(week), 1)))}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-44 px-3 text-center text-sm font-semibold tabular">
              {weekLabel(week)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next week"
              disabled={week >= thisWeek}
              onClick={() => setWeek(weekKey(addWeeks(parseISO(week), 1)))}
            >
              <ChevronRight className="size-4" />
            </Button>
            {week !== thisWeek && (
              <Button variant="ghost" size="sm" onClick={() => setWeek(thisWeek)}>
                Current
              </Button>
            )}
          </div>
        }
      />
      <Editor
        key={`${week}-${sheet?.status ?? "new"}-${sheet?.reviewedAt ?? ""}`}
        week={week}
        sheet={sheet}
        state={state}
        CURRENT_USER_ID={CURRENT_USER_ID}
      />
    </div>
  );
}

function toRows(sheet: Timesheet | undefined, s: State): Row[] {
  return (sheet?.entries ?? []).map((e) => ({
    id: e.id,
    projectId: e.projectId,
    clientId: s.projects.find((p) => p.id === e.projectId)?.clientId || "internal",
    task: e.task,
    hours: e.hours.map((h) => (h ? String(h) : "")),
    billable: e.billable,
    notes: e.notes,
  }));
}

function Editor({
  week,
  sheet,
  state,
  CURRENT_USER_ID,
}: {
  week: string;
  sheet?: Timesheet | undefined;
  state: State;
  CURRENT_USER_ID: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(sheet, state));
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(sheet?.lastAutoSavedAt ?? null);
  const [activeMobileDay, setActiveMobileDay] = useState(0);

  const locked = sheet?.status === "submitted" || sheet?.status === "approved";
  const fmt = state.settings.timeFormat;
  const dates = weekDates(week);
  const today = isoDay(new Date());

  const clientOptions = [
    ...state.clients.filter((c) => c.status === "active"),
    { id: "internal", name: "Internal (non-client)" },
  ];
  const projectsFor = (clientId: string) =>
    state.projects.filter(
      (p) =>
        p.status !== "completed" &&
        (clientId === "internal" ? !p.clientId : p.clientId === clientId),
    );

  const parsed = useMemo(() => rows.map((r) => r.hours.map(parseHours)), [rows]);
  const rowTotals = parsed.map((cells) => cells.reduce((a, c) => a + (c.ok ? c.value : 0), 0));
  const dayTotals = DAYS.map((_, d) =>
    parsed.reduce((a, cells) => a + (cells[d]?.ok ? cells[d].value : 0), 0),
  );
  const total = dayTotals.reduce((a, b) => a + b, 0);
  const billableTotal = rows.reduce(
    (acc, r, i) => (r.billable ? acc + (rowTotals[i] ?? 0) : acc),
    0,
  );
  const cellErrors = parsed.flat().filter((c) => !c.ok).length;
  const dayOver = dayTotals.some((d) => d > 24);
  const incomplete = rows.filter((r) => !r.projectId || !r.task);

  // Check for duplicate rows (same project + task)
  const duplicateIndices = useMemo(() => {
    const keys = new Map<string, number>();
    const dupes = new Set<number>();
    rows.forEach((r, idx) => {
      if (r.projectId && r.task) {
        const k = `${r.projectId}__${r.task}`;
        if (keys.has(k)) {
          dupes.add(idx);
          dupes.add(keys.get(k)!);
        } else {
          keys.set(k, idx);
        }
      }
    });
    return dupes;
  }, [rows]);

  const update = (id: string, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const addRow = () => {
    setRows((rs) => [
      ...rs,
      {
        id: uid("e"),
        clientId: "",
        projectId: "",
        task: "",
        hours: Array(7).fill(""),
        billable: true,
        notes: "",
      },
    ]);
    setDirty(true);
  };

  const duplicateRow = (r: Row) => {
    setRows((rs) => [
      ...rs,
      {
        ...r,
        id: uid("e"),
        hours: Array(7).fill(""),
      },
    ]);
    setDirty(true);
    toast.success("Row duplicated");
  };

  const handleCopyPreviousWeek = () => {
    const success = copyPreviousWeek(week, CURRENT_USER_ID);
    if (success) {
      toast.success("Copied tasks and projects from previous week");
      const updatedSheet = state.timesheets.find(
        (t) => t.memberId === CURRENT_USER_ID && t.weekStart === week,
      );
      if (updatedSheet) {
        setRows(toRows(updatedSheet, state));
        setDirty(false);
      }
    } else {
      toast.error("No entries found in previous week to copy");
    }
  };

  // Auto-save debounce effect for drafts
  useEffect(() => {
    if (!dirty || locked) return;
    const timer = setTimeout(() => {
      if (cellErrors === 0 && !dayOver) {
        const nowTime = format(new Date(), "HH:mm");
        upsertTimesheet({
          id: sheet?.id ?? `t_${CURRENT_USER_ID}_${week}`,
          memberId: CURRENT_USER_ID,
          weekStart: week,
          status: "draft",
          submittedAt: undefined,
          reviewComment: sheet?.reviewComment,
          lastAutoSavedAt: nowTime,
          entries: rows.map((r, i) => ({
            id: r.id,
            projectId: r.projectId,
            task: r.task,
            billable: r.billable,
            notes: r.notes.trim(),
            hours: (parsed[i] ?? []).map((c) => (c.ok ? c.value : 0)),
          })),
        });
        setDirty(false);
        setLastSaved(nowTime);
      }
    }, 2500);

    return () => clearTimeout(timer);
  }, [dirty, locked, cellErrors, dayOver, rows, parsed, sheet, CURRENT_USER_ID, week]);

  const persist = (status: "draft" | "submitted"): void => {
    setShowErrors(true);
    const fail = (m: string) => {
      toast.error(m);
    };
    if (cellErrors) return fail("Fix the highlighted invalid hour values first");
    if (dayOver) return fail("A day cannot exceed 24 hours in total");
    if (incomplete.length) return fail("Every row needs a project and task specified");
    if (duplicateIndices.size > 0) return fail("Resolve duplicate task entries before proceeding");
    if (status === "submitted" && total <= 0)
      return fail("Add at least some logged hours before submitting");

    const nowTime = format(new Date(), "HH:mm");
    upsertTimesheet({
      id: sheet?.id ?? `t_${CURRENT_USER_ID}_${week}`,
      memberId: CURRENT_USER_ID,
      weekStart: week,
      status,
      submittedAt: status === "submitted" ? isoDay(new Date()) : sheet?.submittedAt,
      reviewComment: status === "submitted" ? undefined : sheet?.reviewComment,
      lastAutoSavedAt: nowTime,
      entries: rows.map((r, i) => ({
        id: r.id,
        projectId: r.projectId,
        task: r.task,
        billable: r.billable,
        notes: r.notes.trim(),
        hours: (parsed[i] ?? []).map((c) => (c.ok ? c.value : 0)),
      })),
    });
    setDirty(false);
    setLastSaved(nowTime);
    setShowConfirmSubmit(false);
    toast.success(
      status === "submitted" ? "Timesheet submitted for manager approval" : "Draft saved",
    );
  };

  return (
    <div className="space-y-4">
      {/* Top Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Status:</span>
            <StatusBadge status={sheet?.status ?? "draft"} />
          </div>

          {sheet?.submittedAt && (
            <span className="text-xs text-muted-foreground">
              Submitted on {format(parseISO(sheet.submittedAt), "d MMM yyyy")}
            </span>
          )}

          {lastSaved && !dirty && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3 text-success" /> Auto-saved at {lastSaved}
            </span>
          )}

          {dirty && (
            <span className="text-xs font-semibold text-warning-foreground">• Unsaved changes</span>
          )}
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <p className="text-[11px] font-medium text-muted-foreground">Billable Hours</p>
            <p className="text-base font-bold tabular text-primary">
              {formatHours(billableTotal, fmt)}h
            </p>
          </div>
          <div className="text-right border-l pl-4">
            <p className="text-[11px] font-medium text-muted-foreground">Weekly Total</p>
            <p className="text-2xl font-extrabold tabular text-foreground">
              {formatHours(total, fmt)}h
            </p>
          </div>
        </div>
      </div>

      {/* Rejected comments banner */}
      {sheet?.status === "rejected" && sheet.reviewComment && (
        <div
          role="alert"
          className="flex items-start gap-3.5 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <div className="rounded-lg bg-destructive/10 p-2 text-destructive shrink-0">
            <AlertCircle className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-bold text-destructive">Timesheet Returned for Revision</p>
            <p className="text-foreground leading-relaxed">
              Reviewer note: <span className="font-semibold">“{sheet.reviewComment}”</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Please adjust the hours or task allocations as requested and re-submit for approval.
            </p>
          </div>
        </div>
      )}

      {/* Approved Lock banner */}
      {locked && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-border bg-secondary/80 p-3.5 text-sm text-secondary-foreground">
          <Lock className="size-4.5 text-primary" />
          <span>
            This timesheet is <strong className="capitalize">{sheet?.status}</strong> and locked for
            editing.
          </span>
        </div>
      )}

      {/* Duplicate warning */}
      {duplicateIndices.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning-foreground">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            Duplicate task entries detected. Multiple rows have identical project and task names.
          </span>
        </div>
      )}

      {/* Actions Toolbar */}
      {!locked && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="size-3.5" />
              <span>Add row</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyPreviousWeek}
              title="Copy task rows from previous week with zero hours"
            >
              <Copy className="size-3.5" />
              <span>Copy last week's rows</span>
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => persist("draft")}>
              <Save className="size-3.5" />
              <span>Save draft</span>
            </Button>
            <Button size="sm" onClick={() => setShowConfirmSubmit(true)}>
              <Send className="size-3.5" />
              <span>Submit for approval</span>
            </Button>
          </div>
        </div>
      )}

      {/* Desktop Weekly Table View */}
      <div className="hidden md:block overflow-x-auto rounded-2xl border bg-card shadow-card">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              <th className="w-[32%] px-4 py-3 text-left font-semibold">Client · Project · Task</th>
              {dates.map((d, i) => (
                <th
                  key={i}
                  className={cn(
                    "w-16 px-1 py-3 text-center font-medium",
                    isoDay(d) === today && "text-primary font-bold bg-primary/5",
                  )}
                >
                  <div className="text-xs font-semibold">{DAYS[i]}</div>
                  <div className="text-[11px] opacity-75">{format(d, "d MMM")}</div>
                </th>
              ))}
              <th className="w-16 px-2 py-3 text-right font-semibold">Total</th>
              <th className="px-4 py-3 text-left font-semibold">Billable & Notes</th>
              <th className="w-20 px-2 py-3 text-right" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="p-8">
                  <EmptyState
                    icon={CalendarClock}
                    title="No time logged this week"
                    text="Add a row for each client project and task you worked on, or copy from last week."
                    action={
                      !locked && (
                        <div className="flex gap-2">
                          <Button onClick={addRow}>
                            <Plus className="size-4" /> Add first row
                          </Button>
                          <Button variant="outline" onClick={handleCopyPreviousWeek}>
                            <Copy className="size-4" /> Copy previous week
                          </Button>
                        </div>
                      )
                    }
                  />
                </td>
              </tr>
            )}

            {rows.map((r, ri) => {
              const project = state.projects.find((p) => p.id === r.projectId);
              const missing = showErrors && (!r.projectId || !r.task);
              const isDupe = duplicateIndices.has(ri);

              return (
                <tr
                  key={r.id}
                  className={cn(
                    "align-top hover:bg-muted/20 transition-colors",
                    isDupe && "bg-warning/5",
                  )}
                >
                  <td className="space-y-1.5 px-4 py-3">
                    <Select
                      disabled={locked}
                      value={r.clientId}
                      onValueChange={(v) =>
                        update(r.id, {
                          clientId: v,
                          projectId: "",
                          task: "",
                          billable: v !== "internal",
                        })
                      }
                    >
                      <SelectTrigger
                        aria-label="Client"
                        className={cn(
                          "h-8 text-xs",
                          missing && !r.clientId && "border-destructive",
                        )}
                      >
                        <SelectValue placeholder="Select Client" />
                      </SelectTrigger>
                      <SelectContent>
                        {clientOptions.map((c) => (
                          <SelectItem key={c.id} value={c.id} className="text-xs">
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <div className="grid grid-cols-2 gap-1.5">
                      <Select
                        disabled={locked || !r.clientId}
                        value={r.projectId}
                        onValueChange={(v) => update(r.id, { projectId: v, task: "" })}
                      >
                        <SelectTrigger
                          aria-label="Project"
                          className={cn(
                            "h-8 text-xs",
                            missing && !r.projectId && "border-destructive",
                          )}
                        >
                          <SelectValue placeholder="Project" />
                        </SelectTrigger>
                        <SelectContent>
                          {(r.projectId &&
                          !projectsFor(r.clientId).some((p) => p.id === r.projectId) &&
                          project
                            ? [project, ...projectsFor(r.clientId)]
                            : projectsFor(r.clientId)
                          ).map((p) => (
                            <SelectItem key={p.id} value={p.id} className="text-xs">
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select
                        disabled={locked || !project}
                        value={r.task}
                        onValueChange={(v) => update(r.id, { task: v })}
                      >
                        <SelectTrigger
                          aria-label="Task"
                          className={cn("h-8 text-xs", missing && !r.task && "border-destructive")}
                        >
                          <SelectValue placeholder="Task" />
                        </SelectTrigger>
                        <SelectContent>
                          {(project?.tasks ?? []).map((t) => (
                            <SelectItem key={t} value={t} className="text-xs">
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </td>

                  {r.hours.map((h, d) => {
                    const c = parsed[ri]?.[d] ?? { ok: true as const, value: 0 };
                    return (
                      <td key={d} className="px-1 py-3">
                        <Input
                          inputMode="decimal"
                          disabled={locked}
                          value={h}
                          aria-label={`${project?.name ?? "Row " + (ri + 1)} hours on ${DAYS[d]}`}
                          aria-invalid={!c.ok}
                          title={c.ok ? undefined : c.error}
                          onChange={(e) =>
                            update(r.id, {
                              hours: r.hours.map((x, i) => (i === d ? e.target.value : x)),
                            })
                          }
                          className={cn(
                            "h-8 px-1 text-center tabular text-xs",
                            !c.ok &&
                              "border-destructive bg-destructive/5 text-destructive font-semibold",
                          )}
                          placeholder="–"
                        />
                        {c.ok ? null : (
                          <p className="mt-1 text-[0.65rem] leading-tight text-destructive">
                            {c.error}
                          </p>
                        )}
                      </td>
                    );
                  })}

                  <td className="px-2 py-4 text-right font-bold tabular text-xs">
                    {formatHours(rowTotals[ri] ?? 0, fmt)}h
                  </td>

                  <td className="space-y-1.5 px-4 py-3">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                      <Switch
                        disabled={locked}
                        checked={r.billable}
                        onCheckedChange={(v) => update(r.id, { billable: v })}
                        aria-label="Billable"
                      />
                      <span className={r.billable ? "text-primary font-semibold" : ""}>
                        {r.billable ? "Billable" : "Non-billable"}
                      </span>
                    </label>
                    <Input
                      disabled={locked}
                      value={r.notes}
                      maxLength={200}
                      onChange={(e) => update(r.id, { notes: e.target.value })}
                      placeholder="Notes / work details"
                      aria-label="Notes"
                      className="h-8 text-xs"
                    />
                  </td>

                  <td className="px-2 py-3 text-right">
                    {!locked && (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Duplicate row"
                          title="Duplicate row"
                          onClick={() => duplicateRow(r)}
                        >
                          <Copy className="size-3.5 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete row"
                          title="Delete row"
                          onClick={() => {
                            setRows((rs) => rs.filter((x) => x.id !== r.id));
                            setDirty(true);
                          }}
                        >
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>

          {rows.length > 0 && (
            <tfoot className="border-t bg-muted/40 text-sm font-semibold">
              <tr>
                <td className="px-4 py-3">Daily Total</td>
                {dayTotals.map((t, i) => (
                  <td
                    key={i}
                    className={cn(
                      "px-1 py-3 text-center tabular text-xs",
                      t > 24 && "text-destructive font-bold",
                    )}
                  >
                    {formatHours(t, fmt)}h
                  </td>
                ))}
                <td className="px-2 py-3 text-right tabular text-sm font-bold text-primary">
                  {formatHours(total, fmt)}h
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile Timesheet Entry Cards */}
      <div className="md:hidden space-y-4">
        {/* Day selector tabs */}
        <div className="flex overflow-x-auto gap-1 border-b pb-2">
          {DAYS.map((d, i) => (
            <button
              key={d}
              type="button"
              onClick={() => setActiveMobileDay(i)}
              className={cn(
                "flex-1 min-w-[48px] rounded-lg py-2 text-center text-xs font-semibold transition-colors",
                activeMobileDay === i
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/50 text-muted-foreground",
              )}
            >
              <div>{d}</div>
              <div className="text-[10px] font-normal">{dayTotals[i]?.toFixed(1) || 0}h</div>
            </button>
          ))}
        </div>

        {rows.map((r, ri) => {
          const project = state.projects.find((p) => p.id === r.projectId);
          const c = parsed[ri]?.[activeMobileDay] ?? { ok: true as const, value: 0 };
          return (
            <div key={r.id} className="rounded-xl border bg-card p-4 space-y-3 shadow-xs">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-sm">{project?.name || "Unassigned Project"}</p>
                  <p className="text-xs text-muted-foreground">{r.task || "Select task"}</p>
                </div>
                {!locked && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setRows((rs) => rs.filter((x) => x.id !== r.id));
                      setDirty(true);
                    }}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                    Hours on {DAYS[activeMobileDay]}
                  </label>
                  <Input
                    inputMode="decimal"
                    disabled={locked}
                    value={r.hours[activeMobileDay] || ""}
                    onChange={(e) =>
                      update(r.id, {
                        hours: r.hours.map((x, i) => (i === activeMobileDay ? e.target.value : x)),
                      })
                    }
                    placeholder="0.0"
                    className="text-center font-bold tabular"
                  />
                </div>
                <div className="pt-4">
                  <Switch
                    disabled={locked}
                    checked={r.billable}
                    onCheckedChange={(v) => update(r.id, { billable: v })}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Submission Confirmation Modal */}
      <AlertDialog open={showConfirmSubmit} onOpenChange={setShowConfirmSubmit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit timesheet for approval?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 pt-2 text-sm text-foreground">
                <p>
                  You are about to submit your weekly timesheet for{" "}
                  <strong>{weekLabel(week)}</strong>.
                </p>
                <div className="rounded-xl border bg-muted/40 p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Logged Hours:</span>
                    <strong className="text-foreground">{formatHours(total, fmt)} hrs</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Billable Hours:</span>
                    <strong className="text-primary">{formatHours(billableTotal, fmt)} hrs</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Entries Count:</span>
                    <strong className="text-foreground">{rows.length} rows</strong>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Once submitted, the timesheet will be locked and routed to your project managers
                  for review.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => persist("submitted")}>
              Confirm & Submit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
