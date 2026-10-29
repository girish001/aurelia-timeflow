import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Check,
  X,
  Inbox,
  Eye,
  CheckCheck,
  AlertCircle,
  Clock,
  Gauge,
  CheckCircle2,
  Users,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  type SheetStatus,
} from "@/lib/demo-store";
import { DAYS, formatHours, weekLabel } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/rules";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/approvals")({
  head: () => pageHead("Approvals", "Review, approve or return submitted timesheets."),
  component: Approvals,
});

export function Approvals() {
  const me = useMe();
  const s = useDemo((x) => x);
  const [filter, setFilter] = useState<SheetStatus | "all">("submitted");
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [err, setErr] = useState("");

  const fmt = s.settings.timeFormat;
  const member = (id: string) => s.members.find((m) => m.id === id);
  const project = (id: string) => s.projects.find((p) => p.id === id);

  // Filter list: exclude drafts
  const list = s.timesheets
    .filter((t) => t.status !== "draft" && (filter === "all" || t.status === filter))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || (a.memberId > b.memberId ? 1 : -1));

  const open = s.timesheets.find((t) => t.id === openId);
  const count = (st: SheetStatus) => s.timesheets.filter((t) => t.status === st).length;

  const pendingSheets = s.timesheets.filter((t) => t.status === "submitted");
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

  // Single review
  const decide = (decision: "approved" | "rejected") => {
    if (!open) return;
    if (decision === "rejected" && comment.trim().length < 3)
      return setErr("Add a specific reason so the employee knows what adjustments to make.");

    // Prevent approving own timesheet in realistic SaaS
    if (open.memberId === me.id) {
      toast.error(
        "You cannot approve your own timesheet. Please request another manager to review.",
      );
      return;
    }

    reviewTimesheet(open.id, decision, comment.trim());
    toast.success(`${member(open.memberId)?.name}'s timesheet ${decision}`);
    setOpenId(null);
    setComment("");
    setErr("");
  };

  // Bulk review
  const handleBulkApprove = () => {
    if (selectedIds.length === 0) return;
    const validIds = selectedIds.filter((id) => {
      const ts = s.timesheets.find((t) => t.id === id);
      return ts && ts.memberId !== me.id;
    });

    if (validIds.length === 0) {
      toast.error("Cannot approve your own timesheets in bulk.");
      return;
    }

    bulkReviewTimesheets(validIds, "approved", me.id, me.name, "Bulk approved by manager");
    toast.success(`Approved ${validIds.length} timesheets successfully`);
    setSelectedIds([]);
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      const pendingIds = list
        .filter((t) => t.status === "submitted" && t.memberId !== me.id)
        .map((t) => t.id);
      setSelectedIds(pendingIds);
    } else {
      setSelectedIds([]);
    }
  };

  const toggleSelectOne = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => [...prev, id]);
    } else {
      setSelectedIds((prev) => prev.filter((x) => x !== id));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description={`Reviewing as ${me.name} (${ROLE_LABEL[me.role]})`}
        actions={
          selectedIds.length > 0 && (
            <Button
              onClick={handleBulkApprove}
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              <CheckCheck className="size-4" />
              <span>Bulk Approve ({selectedIds.length})</span>
            </Button>
          )
        }
      />

      {/* Summary KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Pending review"
          value={count("submitted")}
          hint="Timesheets awaiting manager decision"
          icon={Clock}
          tone={count("submitted") > 0 ? "warning" : "success"}
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
        <Tabs value={filter} onValueChange={(v) => setFilter(v as SheetStatus)}>
          <TabsList>
            <TabsTrigger value="submitted">Pending ({count("submitted")})</TabsTrigger>
            <TabsTrigger value="approved">Approved ({count("approved")})</TabsTrigger>
            <TabsTrigger value="rejected">Rejected ({count("rejected")})</TabsTrigger>
            <TabsTrigger value="all">
              All ({s.timesheets.filter((t) => t.status !== "draft").length})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {filter === "submitted" && selectedIds.length > 0 && (
          <span className="text-xs font-semibold text-primary">
            {selectedIds.length} timesheets selected
          </span>
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing here"
          text={
            filter === "submitted"
              ? "No timesheets are currently waiting for approval."
              : "No timesheets match this status filter."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {filter === "submitted" && (
                  <th className="w-10 px-4 py-3">
                    <Checkbox
                      checked={
                        selectedIds.length > 0 &&
                        selectedIds.length ===
                          list.filter((t) => t.status === "submitted" && t.memberId !== me.id)
                            .length
                      }
                      onCheckedChange={(c) => toggleSelectAll(Boolean(c))}
                      aria-label="Select all"
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
              {list.map((t) => {
                const m = member(t.memberId);
                const isSelected = selectedIds.includes(t.id);
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
                    {filter === "submitted" && (
                      <td className="px-4 py-3">
                        <Checkbox
                          disabled={isOwn}
                          checked={isSelected}
                          onCheckedChange={(c) => toggleSelectOne(t.id, Boolean(c))}
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
                          setOpenId(t.id);
                          setComment(t.reviewComment ?? "");
                          setErr("");
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

      {/* Detailed Review Dialog */}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Timesheet Review</DialogTitle>
            <DialogDescription>
              {open && (
                <span>
                  Submitted by <strong>{member(open.memberId)?.name}</strong> for{" "}
                  {weekLabel(open.weekStart)}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {open && (
            <div className="space-y-5 py-2">
              {open.memberId === me.id && (
                <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning-foreground">
                  <ShieldAlert className="size-4 shrink-0" />
                  <span>
                    This is your own timesheet. Role policy prevents approving your own submissions.
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
                    {open.entries.map((e) => (
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
                          <span className={e.billable ? "text-primary" : "text-muted-foreground"}>
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
                        const sum = open.entries.reduce((acc, e) => acc + (e.hours[d] || 0), 0);
                        return (
                          <td key={d} className="px-1.5 py-2.5 text-center tabular font-semibold">
                            {sum ? `${sum}h` : "—"}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2.5 text-right tabular text-primary">
                        {formatHours(sheetTotal(open), fmt)}h
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
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value);
                    if (err) setErr("");
                  }}
                  placeholder={
                    open.status === "submitted"
                      ? "Add revision instructions (required if rejecting) or approval note..."
                      : "No reviewer comment recorded"
                  }
                  disabled={open.status !== "submitted"}
                  rows={3}
                />
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>

              {open.reviewedAt && (
                <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
                  Reviewed on {format(parseISO(open.reviewedAt), "d MMM yyyy")}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {open?.status === "submitted" ? (
              <div className="flex w-full items-center justify-between gap-2">
                <Button variant="ghost" onClick={() => setOpenId(null)}>
                  Cancel
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={open.memberId === me.id}
                    onClick={() => decide("rejected")}
                  >
                    <X className="size-4" />
                    <span>Return for revision</span>
                  </Button>
                  <Button
                    disabled={open.memberId === me.id}
                    onClick={() => decide("approved")}
                    className="bg-success text-success-foreground hover:bg-success/90"
                  >
                    <Check className="size-4" />
                    <span>Approve timesheet</span>
                  </Button>
                </div>
              </div>
            ) : (
              <Button onClick={() => setOpenId(null)}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
