import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { parseISO, subDays, startOfMonth } from "date-fns";
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
import { Download, FileBarChart } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, PageHeader, Panel, StatCard } from "@/components/app/common";
import { flatten, useDemo } from "@/lib/demo-store";
import { formatHours, formatMoney, isoDay, mondayOf } from "@/lib/time";
import { toCsv, downloadBlob } from "@/lib/csv";
import { pageHead } from "@/lib/seo";
import { Clock, Gauge, Wallet } from "lucide-react";

export const Route = createFileRoute("/app/reports")({
  head: () => pageHead("Reports", "Billable vs non-billable hours, utilization and CSV export."),
  component: Reports,
});

type Group = "project" | "client" | "employee";

function Reports() {
  const s = useDemo((x) => x);
  const today = new Date();
  const [from, setFrom] = useState(isoDay(subDays(today, 41)));
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
  const value = rows
    .filter((r) => r.billable)
    .reduce((a, r) => a + r.hours * (proj(r.projectId)?.rate ?? 0), 0);

  const breakdown = useMemo(() => {
    const key = (r: (typeof rows)[number]) =>
      group === "project"
        ? (proj(r.projectId)?.name ?? "—")
        : group === "client"
          ? clientName(r.projectId)
          : memberName(r.memberId);
    const map = new Map<string, { name: string; billable: number; nonBillable: number }>();
    for (const r of rows) {
      const k = key(r);
      const e = map.get(k) ?? { name: k, billable: 0, nonBillable: 0 };
      if (r.billable) e.billable += r.hours;
      else e.nonBillable += r.hours;
      map.set(k, e);
    }
    return [...map.values()].sort(
      (a, b) => b.billable + b.nonBillable - (a.billable + a.nonBillable),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, group, s]);

  const utilization = useMemo(() => {
    const m = new Map<string, { name: string; billable: number; nonBillable: number }>();
    for (const r of rows) {
      const n = memberName(r.memberId).split(" ")[0] ?? "";
      const e = m.get(n) ?? { name: n, billable: 0, nonBillable: 0 };
      if (r.billable) e.billable += r.hours;
      else e.nonBillable += r.hours;
      m.set(n, e);
    }
    return [...m.values()].map((e) => ({
      ...e,
      util: +((e.billable / (e.billable + e.nonBillable || 1)) * 100).toFixed(1),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, s]);

  const exportCsv = () => {
    if (!rows.length) {
      toast.error("No data in this range to export");
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
        "Timesheet status",
        "Notes",
      ],
      ...[...rows]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((r) => [
          r.date,
          memberName(r.memberId),
          clientName(r.projectId),
          proj(r.projectId)?.name ?? "",
          r.task,
          r.hours,
          r.billable ? "Yes" : "No",
          r.status,
          r.notes,
        ]),
    ]);
    downloadBlob(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
      `timeflow-demo-report_${from}_to_${to}.csv`,
    );
    toast.success(`Exported ${rows.length} rows`);
  };

  const preset = (start: Date) => {
    setFrom(isoDay(start));
    setTo(isoDay(today));
  };

  return (
    <>
      <PageHeader
        title="Reports"
        description="Approved and submitted hours. Rejected timesheets are excluded."
        actions={
          <Button onClick={exportCsv}>
            <Download /> Export CSV
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4 shadow-card">
        <div className="space-y-1">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => preset(mondayOf(today))}>
            This week
          </Button>
          <Button size="sm" variant="outline" onClick={() => preset(startOfMonth(today))}>
            This month
          </Button>
          <Button size="sm" variant="outline" onClick={() => preset(subDays(today, 41))}>
            Last 6 weeks
          </Button>
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={drafts} onCheckedChange={setDrafts} /> Include drafts
        </label>
        {invalidRange && (
          <p className="w-full text-sm text-destructive" role="alert">
            “From” date must be before “To” date.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total hours"
          value={formatHours(total, fmt)}
          hint={`${parseISO(from).toLocaleDateString()} – ${parseISO(to).toLocaleDateString()}`}
          icon={Clock}
        />
        <StatCard
          label="Billable utilization"
          value={`${total ? ((billable / total) * 100).toFixed(0) : 0}%`}
          hint={`${formatHours(billable, fmt)} billable · ${formatHours(total - billable, fmt)} non-billable`}
          icon={Gauge}
          tone="teal"
        />
        <StatCard
          label="Billable value (demo rates)"
          value={formatMoney(value, cur)}
          hint="Hours × project rate"
          icon={Wallet}
          tone="success"
        />
      </div>

      {rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={FileBarChart}
            title="No hours in this range"
            text="Widen the date range or include drafts."
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-6 xl:grid-cols-3">
            <Panel title="Utilization by employee" className="xl:col-span-2">
              <div
                className="h-72"
                role="img"
                aria-label="Bar chart of billable and non-billable hours per employee"
              >
                <ResponsiveContainer>
                  <BarChart data={utilization} margin={{ left: -16 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis
                      dataKey="name"
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                      stroke="var(--muted-foreground)"
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                      stroke="var(--muted-foreground)"
                    />
                    <Tooltip
                      cursor={{ fill: "var(--muted)" }}
                      contentStyle={{ borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number) => v.toFixed(2)}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="billable" name="Billable" stackId="a" fill="var(--chart-1)" />
                    <Bar
                      dataKey="nonBillable"
                      name="Non-billable"
                      stackId="a"
                      fill="var(--chart-2)"
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel title="Billable vs non-billable">
              <div
                className="h-72"
                role="img"
                aria-label="Donut chart of billable versus non-billable hours"
              >
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={[
                        { name: "Billable", v: +billable.toFixed(2) },
                        { name: "Non-billable", v: +(total - billable).toFixed(2) },
                      ]}
                      dataKey="v"
                      nameKey="name"
                      innerRadius="55%"
                      outerRadius="80%"
                      paddingAngle={2}
                    >
                      <Cell fill="var(--chart-1)" />
                      <Cell fill="var(--chart-2)" />
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <Panel
            className="mt-6"
            title="Breakdown"
            action={
              <Tabs value={group} onValueChange={(v) => setGroup(v as Group)}>
                <TabsList className="h-8">
                  <TabsTrigger value="project" className="text-xs">
                    Project
                  </TabsTrigger>
                  <TabsTrigger value="client" className="text-xs">
                    Client
                  </TabsTrigger>
                  <TabsTrigger value="employee" className="text-xs">
                    Employee
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            }
          >
            <div className="-m-5 overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2.5 font-medium capitalize">{group}</th>
                    <th className="px-5 py-2.5 text-right font-medium">Billable</th>
                    <th className="px-5 py-2.5 text-right font-medium">Non-billable</th>
                    <th className="px-5 py-2.5 text-right font-medium">Total</th>
                    <th className="px-5 py-2.5 text-right font-medium">Billable %</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {breakdown.map((b) => {
                    const t = b.billable + b.nonBillable;
                    return (
                      <tr key={b.name}>
                        <td className="px-5 py-2.5 font-medium">{b.name}</td>
                        <td className="px-5 py-2.5 text-right tabular">
                          {formatHours(b.billable, fmt)}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular">
                          {formatHours(b.nonBillable, fmt)}
                        </td>
                        <td className="px-5 py-2.5 text-right font-semibold tabular">
                          {formatHours(t, fmt)}
                        </td>
                        <td className="px-5 py-2.5 text-right tabular">
                          {((b.billable / t) * 100).toFixed(0)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
