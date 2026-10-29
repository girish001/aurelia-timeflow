import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { format, parseISO } from "date-fns";
import {
  History,
  Search,
  Filter,
  Download,
  Calendar,
  Shield,
  Clock,
  CheckCircle2,
  Settings,
  User,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, Initials, PageHeader, StatCard } from "@/components/app/common";
import { useDemo, useMe, type AuditLogItem } from "@/lib/demo-store";
import { canAccess } from "@/lib/rules";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/audit")({
  head: () =>
    pageHead(
      "Audit Trail",
      "System-wide activity logs, security events and administrative history.",
    ),
  component: AuditPage,
});

const CATEGORY_COLORS: Record<string, string> = {
  timesheet: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-200",
  approval:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200",
  leave: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border-purple-200",
  allocation: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300 border-cyan-200",
  project:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border-indigo-200",
  client: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border-sky-200",
  member: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300 border-violet-200",
  settings: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-200",
  policy: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-200",
  auth: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border-slate-200",
};

function formatAuditTimestamp(ts: string): string {
  if (!ts) return "—";
  if (ts.length > 10) {
    return ts.replace("T", " ").slice(0, 16);
  }
  return ts;
}

export function AuditPage() {
  const me = useMe();
  const s = useDemo((x) => x);

  // Filters
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 15;

  // Filtered logs
  const filteredLogs = useMemo(() => {
    const logs = s.auditLogs ?? [];
    return logs.filter((log) => {
      // Category filter
      if (categoryFilter !== "all" && log.category !== categoryFilter) return false;

      // Date range filter (inclusive of entire selected end date)
      const logDate = log.timestamp.slice(0, 10);
      if (startDate && logDate < startDate) return false;
      if (endDate && logDate > endDate) return false;

      // Search keyword filter
      if (search.trim()) {
        const query = search.toLowerCase();
        const matchesActor = log.actorName.toLowerCase().includes(query);
        const matchesAction = log.action.toLowerCase().includes(query);
        const matchesDetails = log.details.toLowerCase().includes(query);
        const matchesCategory = log.category.toLowerCase().includes(query);
        if (!matchesActor && !matchesAction && !matchesDetails && !matchesCategory) {
          return false;
        }
      }

      return true;
    });
  }, [s.auditLogs, categoryFilter, startDate, endDate, search]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
  const currentPageLogs = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, page, pageSize]);

  // Statistics
  const totalEvents = (s.auditLogs ?? []).length;
  const approvalEvents = (s.auditLogs ?? []).filter((l) => l.category === "approval").length;
  const timesheetEvents = (s.auditLogs ?? []).filter((l) => l.category === "timesheet").length;
  const adminEvents = (s.auditLogs ?? []).filter(
    (l) => l.category === "settings" || l.category === "member" || l.category === "policy",
  ).length;

  // CSV Export
  const handleExportCSV = () => {
    if (filteredLogs.length === 0) {
      toast.error("No records to export.");
      return;
    }
    const headers = ["Timestamp", "Actor Name", "Action", "Category", "Details", "ID"];
    const rows = filteredLogs.map((l) => [
      `"${l.timestamp}"`,
      `"${l.actorName.replace(/"/g, '""')}"`,
      `"${l.action.replace(/"/g, '""')}"`,
      `"${l.category}"`,
      `"${l.details.replace(/"/g, '""')}"`,
      `"${l.id}"`,
    ]);
    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute(
      "download",
      `aurelia_audit_trail_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Audit log CSV exported successfully.");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Trail"
        description="Simulated workspace activity log stored in browser localStorage for demo preview purposes (not an immutable production audit record)."
        action={
          <Button variant="outline" onClick={handleExportCSV} className="gap-2 shadow-xs">
            <Download className="size-4" />
            Export CSV
          </Button>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Total Audit Events"
          value={totalEvents.toString()}
          meta="Simulated demo events"
          icon={<History className="size-5 text-primary" />}
        />
        <StatCard
          label="Approval Decisions"
          value={approvalEvents.toString()}
          meta="Timesheet & workflow actions"
          icon={<CheckCircle2 className="size-5 text-emerald-600" />}
        />
        <StatCard
          label="Timesheet Submissions"
          value={timesheetEvents.toString()}
          meta="Time records logged"
          icon={<Clock className="size-5 text-blue-600" />}
        />
        <StatCard
          label="Admin & Config Updates"
          value={adminEvents.toString()}
          meta="Settings, policies and members"
          icon={<Settings className="size-5 text-amber-500" />}
        />
      </div>

      {/* Filter and Search Bar */}
      <div className="rounded-xl border bg-card p-4 shadow-card space-y-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Keyword Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by actor, action description or details..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-9 h-9 text-xs"
            />
          </div>

          {/* Category Select */}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={categoryFilter}
              onValueChange={(v) => {
                setCategoryFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[160px] h-9 text-xs">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="approval">Approvals</SelectItem>
                <SelectItem value="timesheet">Timesheets</SelectItem>
                <SelectItem value="leave">Leave Requests</SelectItem>
                <SelectItem value="allocation">Resource Allocations</SelectItem>
                <SelectItem value="project">Projects</SelectItem>
                <SelectItem value="client">Clients</SelectItem>
                <SelectItem value="member">Team & Roles</SelectItem>
                <SelectItem value="settings">Settings</SelectItem>
                <SelectItem value="policy">Policies & Holidays</SelectItem>
                <SelectItem value="auth">Authentication</SelectItem>
              </SelectContent>
            </Select>

            {/* Date Pickers */}
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPage(1);
                }}
                className="w-[130px] h-9 text-xs"
                title="Start date"
              />
              <span className="text-muted-foreground text-xs">to</span>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPage(1);
                }}
                className="w-[130px] h-9 text-xs"
                title="End date"
              />
            </div>

            {(search || categoryFilter !== "all" || startDate || endDate) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setCategoryFilter("all");
                  setStartDate("");
                  setEndDate("");
                  setPage(1);
                }}
                className="h-9 text-xs"
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="rounded-xl border bg-card shadow-card overflow-hidden">
        <div className="border-b px-5 py-3.5 flex items-center justify-between bg-muted/20">
          <div className="text-xs font-semibold text-foreground">
            Displaying {filteredLogs.length} event{filteredLogs.length !== 1 ? "s" : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="py-12">
            <EmptyState
              icon={History}
              title="No audit events matched"
              description="Try broadening your search query or removing category/date filters."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setCategoryFilter("all");
                    setStartDate("");
                    setEndDate("");
                  }}
                >
                  Reset Filters
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 w-[150px]">Timestamp</th>
                  <th className="px-5 py-3 w-[180px]">Actor</th>
                  <th className="px-5 py-3 w-[130px]">Category</th>
                  <th className="px-5 py-3 w-[200px]">Action</th>
                  <th className="px-5 py-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {currentPageLogs.map((log) => {
                  const colorClass =
                    CATEGORY_COLORS[log.category] || "bg-muted text-muted-foreground";
                  return (
                    <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {formatAuditTimestamp(log.timestamp)}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Initials name={log.actorName} size="xs" />
                          <span className="font-medium text-foreground text-xs">
                            {log.actorName}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border capitalize ${colorClass}`}
                        >
                          {log.category}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-semibold text-foreground text-xs whitespace-nowrap">
                        {log.action}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground">{log.details}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="border-t px-5 py-3 flex items-center justify-between bg-muted/10">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-8 gap-1 text-xs"
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filteredLogs.length)}{" "}
              of {filteredLogs.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-8 gap-1 text-xs"
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
