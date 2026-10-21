import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { addWeeks, format, parseISO, subWeeks } from "date-fns";
import { ChevronLeft, ChevronRight, Plus, Trash2, Save, Send, Lock, CalendarClock, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader, StatusBadge } from "@/components/app/common";
import { useMe, uid, upsertTimesheet, useDemo, type Timesheet, type State } from "@/lib/demo-store";
import { DAYS, formatHours, isoDay, parseHours, weekDates, weekKey, weekLabel } from "@/lib/time";
import { pageHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/timesheet")({
  head: () => pageHead("My Timesheet", "Log weekly hours by client, project and task."),
  component: TimesheetPage,
});

interface Row { id: string; clientId: string; projectId: string; task: string; hours: string[]; billable: boolean; notes: string }

function TimesheetPage() {
  const CURRENT_USER_ID = useMe().id;
  const [week, setWeek] = useState(() => weekKey(new Date()));
  const sheet = useDemo((s) => s.timesheets.find((t) => t.memberId === CURRENT_USER_ID && t.weekStart === week));
  const state = useDemo((s) => s);
  const thisWeek = weekKey(new Date());

  return (
    <>
      <PageHeader
        title="My Timesheet"
        description="Enter hours as decimals (7.5) or hours:minutes (7:30), in 15-minute steps."
        actions={
          <div className="flex items-center gap-1 rounded-lg border bg-card p-1 shadow-card">
            <Button variant="ghost" size="icon" aria-label="Previous week" onClick={() => setWeek(weekKey(subWeeks(parseISO(week), 1)))}><ChevronLeft /></Button>
            <span className="min-w-44 px-2 text-center text-sm font-semibold tabular">{weekLabel(week)}</span>
            <Button variant="ghost" size="icon" aria-label="Next week" disabled={week >= thisWeek} onClick={() => setWeek(weekKey(addWeeks(parseISO(week), 1)))}><ChevronRight /></Button>
            {week !== thisWeek && <Button variant="ghost" size="sm" onClick={() => setWeek(thisWeek)}>Today</Button>}
          </div>
        }
      />
      <Editor key={`${week}-${sheet?.status ?? "new"}-${sheet?.reviewedAt ?? ""}`} week={week} sheet={sheet} state={state} CURRENT_USER_ID={CURRENT_USER_ID} />
    </>
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

function Editor({ week, sheet, state, CURRENT_USER_ID }: { week: string; sheet?: Timesheet | undefined; state: State; CURRENT_USER_ID: string }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(sheet, state));
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const locked = sheet?.status === "submitted" || sheet?.status === "approved";
  const fmt = state.settings.timeFormat;
  const dates = weekDates(week);
  const today = isoDay(new Date());

  const clientOptions = [...state.clients.filter((c) => c.status === "active"), { id: "internal", name: "Internal (non-client)" }];
  const projectsFor = (clientId: string) => state.projects.filter((p) => p.status !== "completed" && (clientId === "internal" ? !p.clientId : p.clientId === clientId));

  const parsed = useMemo(() => rows.map((r) => r.hours.map(parseHours)), [rows]);
  const rowTotals = parsed.map((cells) => cells.reduce((a, c) => a + (c.ok ? c.value : 0), 0));
  const dayTotals = DAYS.map((_, d) => parsed.reduce((a, cells) => a + (cells[d]?.ok ? cells[d].value : 0), 0));
  const total = dayTotals.reduce((a, b) => a + b, 0);
  const cellErrors = parsed.flat().filter((c) => !c.ok).length;
  const dayOver = dayTotals.some((d) => d > 24);
  const incomplete = rows.filter((r) => !r.projectId || !r.task);

  const update = (id: string, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const addRow = () => {
    setRows((rs) => [...rs, { id: uid("e"), clientId: "", projectId: "", task: "", hours: Array(7).fill(""), billable: true, notes: "" }]);
    setDirty(true);
  };

  const persist = (status: "draft" | "submitted"): void => {
    setShowErrors(true);
    const fail = (m: string) => { toast.error(m); };
    if (cellErrors) return fail("Fix the highlighted hour values first");
    if (dayOver) return fail("A day cannot exceed 24 hours in total");
    if (incomplete.length) return fail("Every row needs a project and task");
    if (status === "submitted" && total <= 0) return fail("Add at least some hours before submitting");
    upsertTimesheet({
      id: sheet?.id ?? `t_${CURRENT_USER_ID}_${week}`,
      memberId: CURRENT_USER_ID,
      weekStart: week,
      status,
      submittedAt: status === "submitted" ? isoDay(new Date()) : sheet?.submittedAt,
      reviewComment: status === "submitted" ? undefined : sheet?.reviewComment,
      entries: rows.map((r, i) => ({ id: r.id, projectId: r.projectId, task: r.task, billable: r.billable, notes: r.notes.trim(), hours: (parsed[i] ?? []).map((c) => (c.ok ? c.value : 0)) })),
    });
    setDirty(false);
    toast.success(status === "submitted" ? "Timesheet submitted for approval" : "Draft saved");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-card">
        <span className="text-sm text-muted-foreground">Status</span>
        <StatusBadge status={sheet?.status ?? "draft"} />
        {sheet?.submittedAt && <span className="text-xs text-muted-foreground">Submitted {format(parseISO(sheet.submittedAt), "d MMM yyyy")}</span>}
        {dirty && <span className="text-xs font-medium text-warning-foreground">Unsaved changes</span>}
        <div className="ml-auto text-right">
          <p className="text-xs text-muted-foreground">Week total</p>
          <p className="text-xl font-bold tabular">{formatHours(total, fmt)} h</p>
        </div>
      </div>

      {sheet?.status === "rejected" && sheet.reviewComment && (
        <div role="alert" className="flex gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div><p className="font-semibold text-destructive">Returned by your manager</p><p className="mt-0.5 text-foreground">“{sheet.reviewComment}” — update and resubmit.</p></div>
        </div>
      )}
      {locked && (
        <div className="flex items-center gap-2 rounded-xl border bg-secondary/60 p-3 text-sm text-secondary-foreground">
          <Lock className="size-4" /> This timesheet is {sheet?.status} and read-only.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              <th className="w-[30%] px-3 py-2.5 text-left font-medium">Client · Project · Task</th>
              {dates.map((d, i) => (
                <th key={i} className={cn("w-16 px-1 py-2.5 text-center font-medium", isoDay(d) === today && "text-primary")}>
                  <div>{DAYS[i]}</div><div className="font-normal">{format(d, "d")}</div>
                </th>
              ))}
              <th className="w-16 px-2 py-2.5 text-right font-medium">Total</th>
              <th className="px-3 py-2.5 text-left font-medium">Billable · Notes</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr><td colSpan={11} className="p-6">
                <EmptyState icon={CalendarClock} title="No time logged this week" text="Add a row for each client project and task you worked on." action={!locked && <Button onClick={addRow}><Plus /> Add first row</Button>} />
              </td></tr>
            )}
            {rows.map((r, ri) => {
              const project = state.projects.find((p) => p.id === r.projectId);
              const missing = showErrors && (!r.projectId || !r.task);
              return (
                <tr key={r.id} className="align-top">
                  <td className="space-y-1.5 px-3 py-2.5">
                    <Select disabled={locked} value={r.clientId} onValueChange={(v) => update(r.id, { clientId: v, projectId: "", task: "", billable: v !== "internal" })}>
                      <SelectTrigger aria-label="Client" className={cn("h-8", missing && !r.clientId && "border-destructive")}><SelectValue placeholder="Client" /></SelectTrigger>
                      <SelectContent>{clientOptions.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                    </Select>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Select disabled={locked || !r.clientId} value={r.projectId} onValueChange={(v) => update(r.id, { projectId: v, task: "" })}>
                        <SelectTrigger aria-label="Project" className={cn("h-8", missing && !r.projectId && "border-destructive")}><SelectValue placeholder="Project" /></SelectTrigger>
                        <SelectContent>{(r.projectId && !projectsFor(r.clientId).some((p) => p.id === r.projectId) && project ? [project, ...projectsFor(r.clientId)] : projectsFor(r.clientId)).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                      </Select>
                      <Select disabled={locked || !project} value={r.task} onValueChange={(v) => update(r.id, { task: v })}>
                        <SelectTrigger aria-label="Task" className={cn("h-8", missing && !r.task && "border-destructive")}><SelectValue placeholder="Task" /></SelectTrigger>
                        <SelectContent>{(project?.tasks ?? []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </td>
                  {r.hours.map((h, d) => {
                    const c = parsed[ri]?.[d] ?? { ok: true as const, value: 0 };
                    return (
                      <td key={d} className="px-1 py-2.5">
                        <Input
                          inputMode="decimal"
                          disabled={locked}
                          value={h}
                          aria-label={`${project?.name ?? "Row " + (ri + 1)} hours on ${DAYS[d]}`}
                          aria-invalid={!c.ok}
                          title={c.ok ? undefined : c.error}
                          onChange={(e) => update(r.id, { hours: r.hours.map((x, i) => (i === d ? e.target.value : x)) })}
                          className={cn("h-8 px-1 text-center tabular", !c.ok && "border-destructive bg-destructive/5 text-destructive")}
                          placeholder="–"
                        />
                        {c.ok ? null : <p className="mt-1 text-[0.65rem] leading-tight text-destructive">{c.error}</p>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-4 text-right font-semibold tabular">{formatHours(rowTotals[ri] ?? 0, fmt)}</td>
                  <td className="space-y-1.5 px-3 py-2.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch disabled={locked} checked={r.billable} onCheckedChange={(v) => update(r.id, { billable: v })} aria-label="Billable" />
                      {r.billable ? "Billable" : "Non-billable"}
                    </label>
                    <Input disabled={locked} value={r.notes} maxLength={200} onChange={(e) => update(r.id, { notes: e.target.value })} placeholder="Notes (optional)" aria-label="Notes" className="h-8" />
                  </td>
                  <td className="px-1 py-2.5">
                    {!locked && <Button variant="ghost" size="icon" aria-label="Delete row" onClick={() => { setRows((rs) => rs.filter((x) => x.id !== r.id)); setDirty(true); }}><Trash2 className="text-muted-foreground" /></Button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t bg-muted/40 text-sm font-semibold">
              <tr>
                <td className="px-3 py-2.5">Daily total</td>
                {dayTotals.map((t, i) => <td key={i} className={cn("px-1 py-2.5 text-center tabular", t > 24 && "text-destructive")}>{formatHours(t, fmt)}</td>)}
                <td className="px-2 py-2.5 text-right tabular">{formatHours(total, fmt)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {!locked && (
        <div className="flex flex-wrap items-center gap-2">
          {rows.length > 0 && <Button variant="outline" onClick={addRow}><Plus /> Add row</Button>}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => persist("draft")}><Save /> Save draft</Button>
            <Button onClick={() => persist("submitted")}><Send /> Submit for approval</Button>
          </div>
        </div>
      )}
    </div>
  );
}
