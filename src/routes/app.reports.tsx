import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  parseISO,
  subDays,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfWeek,
  endOfWeek,
  format,
} from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download, FileBarChart, Printer, Clock, Gauge, DollarSign, Briefcase } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageHeader, Panel, StatCard } from "@/components/app/common";
import { flatten, useDemo, loggedHours } from "@/lib/demo-store";
import { formatHours, formatMoney, isoDay } from "@/lib/time";
import { toCsv, downloadBlob } from "@/lib/csv";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/reports")({
  head: () =>
    pageHead("Reports", "Billable vs non-billable hours, utilization and financial reporting."),
  component: Reports,
});

type Group = "project" | "client" | "employee" | "month";

export function Reports() {
  const s = useDemo((x) => x);
  const today = new Date();

  const [from, setFrom] = useState(isoDay(subDays(today, 30)));
  const [to, setTo] = useState(isoDay(today));
  const [group, setGroup] = useState<Group>("project");
  const [drafts, setDrafts] = useState(false);

  const cur = s.settings.currency;
  const fmt = s.settings.timeFormat;
  const invalidRange = from > to;

  const rows = useMemo(
    () =>
      invalidRange
        ? []
        : flatten(s, { includeDrafts: drafts }).filter((r) => r.date >= from && r.date <= to),
    [s, from, to, drafts, invalidRange],
  );

  const proj = (id: string) => s.projects.find((p) => p.id === id);
  const clientName = (pid: string) =>
    s.clients.find((c) => c.id === proj(pid)?.clientId)?.name ?? "Internal";
  const memberName = (id: string) => s.members.find((m) => m.id === id)?.name ?? "Unknown";

  const total = rows.reduce((a, r) => a + r.hours, 0);
  const billable = rows.filter((r) => r.billable).reduce((a, r) => a + r.hours, 0);
  const nonBillable = total - billable;
  const utilizationRate = total > 0 ? (billable / total) * 100 : 0;
  const value = rows
    .filter((r) => r.billable)
    .reduce((a, r) => a + r.hours * (proj(r.projectId)?.rate ?? 0), 0);

  const breakdown = useMemo(() => {
    const key = (r: (typeof rows)[number]) => {
      if (group === "project") return proj(r.projectId)?.name ?? "Internal";
      if (group === "client") return clientName(r.projectId);
      if (group === "employee") return memberName(r.memberId);
      return format(parseISO(r.date), "MMM yyyy");
    };

    const map = new Map<
      string,
      { name: string; billable: number; nonBillable: number; value: number }
    >();
    for (const r of rows) {
      const k = key(r);
      const e = map.get(k) ?? { name: k, billable: 0, nonBillable: 0, value: 0 };
      if (r.billable) {
        e.billable += r.hours;
        e.value += r.hours * (proj(r.projectId)?.rate ?? 0);
      } else {
        e.nonBillable += r.hours;
      }
      map.set(k, e);
    }
    return [...map.values()].sort(
      (a, b) => b.billable + b.nonBillable - (a.billable + a.nonBillable),
    );
  }, [rows, group, s]);

  const pieData = [
    { name: "Billable", value: +billable.toFixed(1), color: "var(--chart-1)" },
    { name: "Non-billable", value: +nonBillable.toFixed(1), color: "var(--chart-2)" },
  ].filter((d) => d.value > 0);

  const exportCsv = () => {
    if (!rows.length) {
      toast.error("No logged hours in this range to export");
      return;
    }
    const csv = toCsv([
      [
        "Date",
        "Employee",
        "Client",
        "Project",
        "Task",
        "Hours",
        "Billable",
        "Rate",
        "Est Billable Value",
        "Status",
        "Notes",
      ],
      ...[...rows]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((r) => {
          const rate = proj(r.projectId)?.rate ?? 0;
          return [
            r.date,
            memberName(r.memberId),
            clientName(r.projectId),
            proj(r.projectId)?.name ?? "",
            r.task,
            r.hours,
            r.billable ? "Yes" : "No",
            rate,
            r.billable ? r.hours * rate : 0,
            r.status,
            r.notes,
          ];
        }),
    ]);
    downloadBlob(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
      `aurelia-timeflow-report_${from}_to_${to}.csv`,
    );
    toast.success(`Exported ${rows.length} records to CSV`);
  };

  const handlePrint = () => {
    window.print();
  };

  const setRangePreset = (
    preset: "this-week" | "last-week" | "this-month" | "last-month" | "30d" | "90d",
  ) => {
    if (preset === "this-week") {
      setFrom(isoDay(startOfWeek(today, { weekStartsOn: 1 })));
      setTo(isoDay(today));
    } else if (preset === "last-week") {
      const prevWeekStart = subDays(startOfWeek(today, { weekStartsOn: 1 }), 7);
      setFrom(isoDay(prevWeekStart));
      setTo(isoDay(endOfWeek(prevWeekStart, { weekStartsOn: 1 })));
    } else if (preset === "this-month") {
      setFrom(isoDay(startOfMonth(today)));
      setTo(isoDay(today));
    } else if (preset === "last-month") {
      const lastMonth = subMonths(today, 1);
      setFrom(isoDay(startOfMonth(lastMonth)));
      setTo(isoDay(endOfMonth(lastMonth)));
    } else if (preset === "30d") {
      setFrom(isoDay(subDays(today, 30)));
      setTo(isoDay(today));
    } else if (preset === "90d") {
      setFrom(isoDay(subDays(today, 90)));
      setTo(isoDay(today));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Comprehensive analysis of billable utilization, project budgets, client hours and revenue."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handlePrint} className="hidden sm:inline-flex">
              <Printer className="size-4" />
              <span>Print view</span>
            </Button>
            <Button onClick={exportCsv}>
              <Download className="size-4" />
              <span>Export CSV</span>
            </Button>
          </div>
        }
      />

      {/* Date Range & Filter Bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border bg-card p-4 shadow-card">
        <div className="space-y-1">
          <Label htmlFor="from">From date</Label>
          <Input
            id="from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="w-38 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to">To date</Label>
          <Input
            id="to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-38 text-xs"
          />
        </div>

        {/* Quick Range Presets */}
        <div className="flex flex-wrap gap-1.5 pb-0.5">
          <Button variant="outline" size="sm" onClick={() => setRangePreset("this-week")}>
            This Week
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRangePreset("last-week")}>
            Last Week
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRangePreset("this-month")}>
            This Month
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRangePreset("last-month")}>
            Last Month
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRangePreset("30d")}>
            Last 30d
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRangePreset("90d")}>
            Last 90d
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-2 pb-2">
          <Switch id="drafts" checked={drafts} onCheckedChange={setDrafts} />
          <Label htmlFor="drafts" className="text-xs text-muted-foreground cursor-pointer">
            Include unapproved drafts
          </Label>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total hours logged"
          value={`${formatHours(total, fmt)}h`}
          hint={`${formatHours(billable, fmt)}h billable to clients`}
          icon={Clock}
          tone="primary"
        />
        <StatCard
          label="Billable utilization"
          value={`${utilizationRate.toFixed(1)}%`}
          hint="Billable hours ÷ total hours"
          icon={Gauge}
          tone="teal"
        />
        <StatCard
          label="Estimated billable revenue"
          value={formatMoney(value, cur)}
          hint="Logged billable hours × hourly rate"
          icon={DollarSign}
          tone="success"
        />
        <StatCard
          label="Engagements active"
          value={new Set(rows.map((r) => r.projectId)).size}
          hint="Projects with time logged in range"
          icon={Briefcase}
          tone="primary"
        />
      </div>

      {/* Chart and Visual Analytics */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          title={
            <span>
              Hours by{" "}
              {group === "project"
                ? "Project"
                : group === "client"
                  ? "Client"
                  : group === "employee"
                    ? "Employee"
                    : "Month"}
            </span>
          }
          className="lg:col-span-2"
          action={
            <div className="flex gap-1 text-xs">
              {(["project", "client", "employee", "month"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGroup(g)}
                  className={`rounded-md px-2 py-1 font-medium capitalize transition-colors ${
                    group === g
                      ? "bg-secondary font-bold text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          }
        >
          {breakdown.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">
              No hours to graph in this period.
            </p>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={breakdown.slice(0, 8)}
                  margin={{ left: -16, right: 8, top: 10, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    stroke="var(--muted-foreground)"
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    stroke="var(--muted-foreground)"
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      backgroundColor: "var(--card)",
                      color: "var(--card-foreground)",
                      fontSize: 12,
                    }}
                    formatter={(val: number) => [`${val.toFixed(1)}h`, ""]}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                  <Bar dataKey="billable" name="Billable" stackId="a" fill="var(--chart-1)" />
                  <Bar
                    dataKey="nonBillable"
                    name="Non-billable"
                    stackId="a"
                    fill="var(--chart-2)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Billable Ratio Distribution">
          {pieData.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">No hours recorded.</p>
          ) : (
            <div className="h-72 flex flex-col items-center justify-center">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={4}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(val: number) => [`${val} hrs`, ""]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex items-center justify-center gap-6 text-xs mt-2">
                <div className="flex items-center gap-2">
                  <span className="size-3 rounded-full bg-[var(--chart-1)]" />
                  <span>Billable ({utilizationRate.toFixed(0)}%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="size-3 rounded-full bg-[var(--chart-2)]" />
                  <span>Non-billable ({(100 - utilizationRate).toFixed(0)}%)</span>
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* Detailed Aggregation Breakdown Table */}
      <Panel title="Performance Breakdown Table">
        <div className="-mx-5 -my-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-semibold capitalize">{group}</th>
                <th className="px-5 py-3 text-right font-semibold">Billable</th>
                <th className="px-5 py-3 text-right font-semibold">Non-billable</th>
                <th className="px-5 py-3 text-right font-semibold">Total hours</th>
                <th className="px-5 py-3 text-right font-semibold">Utilization %</th>
                <th className="px-5 py-3 text-right font-semibold">Est. Value</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {breakdown.map((b) => {
                const rowTotal = b.billable + b.nonBillable;
                const util = rowTotal > 0 ? (b.billable / rowTotal) * 100 : 0;
                return (
                  <tr key={b.name} className="hover:bg-muted/30 transition-colors">
                    <td className="px-5 py-3 font-semibold text-foreground">{b.name}</td>
                    <td className="px-5 py-3 text-right tabular font-medium">
                      {formatHours(b.billable, fmt)}h
                    </td>
                    <td className="px-5 py-3 text-right tabular text-muted-foreground">
                      {formatHours(b.nonBillable, fmt)}h
                    </td>
                    <td className="px-5 py-3 text-right tabular font-bold text-foreground">
                      {formatHours(rowTotal, fmt)}h
                    </td>
                    <td className="px-5 py-3 text-right tabular font-semibold text-primary">
                      {util.toFixed(1)}%
                    </td>
                    <td className="px-5 py-3 text-right tabular font-bold">
                      {b.value > 0 ? formatMoney(b.value, cur) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {breakdown.length > 0 && (
              <tfoot className="border-t bg-muted/40 font-bold">
                <tr>
                  <td className="px-5 py-3">Total</td>
                  <td className="px-5 py-3 text-right tabular">{formatHours(billable, fmt)}h</td>
                  <td className="px-5 py-3 text-right tabular text-muted-foreground">
                    {formatHours(nonBillable, fmt)}h
                  </td>
                  <td className="px-5 py-3 text-right tabular">{formatHours(total, fmt)}h</td>
                  <td className="px-5 py-3 text-right tabular text-primary">
                    {utilizationRate.toFixed(1)}%
                  </td>
                  <td className="px-5 py-3 text-right tabular">{formatMoney(value, cur)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Panel>
    </div>
  );
}
