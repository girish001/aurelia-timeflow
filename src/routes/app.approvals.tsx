import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Check, X, Inbox, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, Initials, PageHeader, StatusBadge } from "@/components/app/common";
import { entryTotal, reviewTimesheet, sheetTotal, useDemo, type SheetStatus } from "@/lib/demo-store";
import { DAYS, formatHours, weekLabel } from "@/lib/time";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/approvals")({
  head: () => pageHead("Approvals", "Review, approve or return submitted timesheets."),
  component: Approvals,
});

function Approvals() {
  const s = useDemo((x) => x);
  const [filter, setFilter] = useState<SheetStatus | "all">("submitted");
  const [openId, setOpenId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [err, setErr] = useState("");
  const fmt = s.settings.timeFormat;
  const member = (id: string) => s.members.find((m) => m.id === id);
  const list = s.timesheets
    .filter((t) => t.status !== "draft" && (filter === "all" || t.status === filter))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || (a.memberId > b.memberId ? 1 : -1));
  const open = s.timesheets.find((t) => t.id === openId);
  const count = (st: SheetStatus) => s.timesheets.filter((t) => t.status === st).length;

  const decide = (decision: "approved" | "rejected") => {
    if (!open) return;
    if (decision === "rejected" && comment.trim().length < 3) return setErr("Add a short reason so the employee knows what to fix.");
    reviewTimesheet(open.id, decision, comment.trim());
    toast.success(`${member(open.memberId)?.name}'s timesheet ${decision}`);
    setOpenId(null);
  };

  return (
    <>
      <PageHeader title="Approvals" description="Manager view — you are reviewing as Priya Sharma (demo)." />
      <Tabs value={filter} onValueChange={(v) => setFilter(v as SheetStatus)} className="mb-4">
        <TabsList>
          <TabsTrigger value="submitted">Pending ({count("submitted")})</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {list.length === 0 ? (
        <EmptyState icon={Inbox} title="Nothing here" text={filter === "submitted" ? "No timesheets are waiting for approval." : "No timesheets match this filter."} />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-5 py-3 font-medium">Employee</th><th className="px-5 py-3 font-medium">Week</th><th className="px-5 py-3 text-right font-medium">Total hours</th><th className="px-5 py-3 font-medium">Submitted</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3" /></tr>
            </thead>
            <tbody className="divide-y">
              {list.map((t) => {
                const m = member(t.memberId);
                return (
                  <tr key={t.id} className="hover:bg-muted/30">
                    <td className="px-5 py-3"><div className="flex items-center gap-2.5"><Initials name={m?.name ?? "?"} /><div><p className="font-medium">{m?.name}</p><p className="text-xs text-muted-foreground">{m?.title}</p></div></div></td>
                    <td className="px-5 py-3 text-muted-foreground">{weekLabel(t.weekStart)}</td>
                    <td className="px-5 py-3 text-right font-semibold tabular">{formatHours(sheetTotal(t), fmt)}</td>
                    <td className="px-5 py-3 text-muted-foreground">{t.submittedAt ? format(parseISO(t.submittedAt), "d MMM yyyy") : "—"}</td>
                    <td className="px-5 py-3"><StatusBadge status={t.status} /></td>
                    <td className="px-5 py-3 text-right"><Button size="sm" variant={t.status === "submitted" ? "default" : "outline"} onClick={() => { setOpenId(t.id); setComment(t.reviewComment ?? ""); setErr(""); }}><Eye /> {t.status === "submitted" ? "Review" : "View"}</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        {open && (
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{member(open.memberId)?.name} · {weekLabel(open.weekStart)}</DialogTitle>
              <DialogDescription className="flex items-center gap-2">Total {formatHours(sheetTotal(open), fmt)} h <StatusBadge status={open.status} /></DialogDescription>
            </DialogHeader>
            <div className="max-h-[45vh] overflow-auto rounded-lg border">
              <table className="w-full min-w-[620px] text-xs">
                <thead className="bg-muted/60 text-muted-foreground"><tr><th className="px-3 py-2 text-left font-medium">Project · Task</th>{DAYS.map((d) => <th key={d} className="px-1 py-2 font-medium">{d}</th>)}<th className="px-3 py-2 text-right font-medium">Total</th></tr></thead>
                <tbody className="divide-y">
                  {open.entries.map((e) => {
                    const p = s.projects.find((x) => x.id === e.projectId);
                    return (
                      <tr key={e.id}>
                        <td className="px-3 py-2"><p className="font-medium">{p?.name}</p><p className="text-muted-foreground">{e.task} · {e.billable ? "Billable" : "Non-billable"}{e.notes && ` · ${e.notes}`}</p></td>
                        {e.hours.map((h, i) => <td key={i} className="px-1 py-2 text-center tabular">{h ? formatHours(h, fmt) : "–"}</td>)}
                        <td className="px-3 py-2 text-right font-semibold tabular">{formatHours(entryTotal(e), fmt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {open.status === "submitted" ? (
              <div className="space-y-1.5">
                <Label htmlFor="review-comment">Comment <span className="font-normal text-muted-foreground">(required when rejecting)</span></Label>
                <Textarea id="review-comment" value={comment} maxLength={300} onChange={(e) => { setComment(e.target.value); setErr(""); }} placeholder="e.g. Looks good, thanks!" aria-invalid={!!err} />
                {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
              </div>
            ) : open.reviewComment ? (
              <p className="rounded-lg bg-muted p-3 text-sm"><span className="font-medium">Reviewer comment:</span> {open.reviewComment}</p>
            ) : null}
            {open.status === "submitted" && (
              <DialogFooter className="gap-2">
                <Button variant="outline" className="text-destructive" onClick={() => decide("rejected")}><X /> Reject</Button>
                <Button onClick={() => decide("approved")}><Check /> Approve</Button>
              </DialogFooter>
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
