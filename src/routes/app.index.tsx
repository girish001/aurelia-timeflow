import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { parseISO, subWeeks, format, startOfMonth } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import {
  Briefcase,
  CheckSquare,
  Clock,
  Gauge,
  ArrowRight,
  Inbox,
  TrendingUp,
  AlertTriangle,
  Activity,
  Calendar,
  Sparkles,
  DollarSign,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  Initials,
  PageHeader,
  Panel,
  StatCard,
  StatusBadge,
} from "@/components/app/common";
import { useMe, flatten, sheetTotal, useDemo, loggedHours } from "@/lib/demo-store";
import { formatHours, formatMoney, isoDay, weekKey, weekLabel } from "@/lib/time";
import { pageHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/")({
  head: () =>
    pageHead("Overview", "Enterprise weekly hours, approvals, budget burn and utilization."),
  component: Dashboard,
});

type WindowOption = 4 | 6 | 12;

export function Dashboard() {
  const me = useMe();
  const s = useDemo((x) => x);
  const fmt = s.settings.timeFormat;
  const cur = s.settings.currency;
  const thisWeek = weekKey(new Date());

  const [weeksWindow, setWeeksWindow] = useState<WindowOption>(6);

  const rangeStart = useMemo(
    () => weekKey(subWeeks(parseISO(thisWeek), weeksWindow - 1)),
    [thisWeek, weeksWindow],
  );

  const data = useMemo(() => {
    const rows = flatten(s, { includeDrafts: true }).filter((r) => r.weekStart >= rangeStart);
    const weeks: { week: string; label: string; billable: number; nonBillable: number }[] = [];
    for (let i = weeksWindow - 1; i >= 0; i--) {
      const w = weekKey(subWeeks(parseISO(thisWeek), i));
      const wr = rows.filter((r) => r.weekStart === w);
      weeks.push({
        week: w,
        label: format(parseISO(w), "d MMM"),
        billable: +wr
          .filter((r) => r.billable)
          .reduce((a, r) => a + r.hours, 0)
          .toFixed(2),
        nonBillable: +wr
          .filter((r) => !r.billable)
          .reduce((a, r) => a + r.hours, 0)
          .toFixed(2),
      });
    }
    const total = rows.reduce((a, r) => a + r.hours, 0);
    const billable = rows.filter((r) => r.billable).reduce((a, r) => a + r.hours, 0);
    return {
      weeks,
      util: total ? (billable / total) * 100 : 0,
      totalHours: total,
      billableHours: billable,
    };
  }, [s, rangeStart, thisWeek, weeksWindow]);

  // Project budget health stats
  const projectStats = useMemo(() => {
    return s.projects.map((p) => {
      const spent = loggedHours(s, p.id);
      const budget = p.budgetHours || 1;
      const pct = Math.min(100, Math.round((spent / budget) * 100));
      const isOver = p.budgetHours > 0 && spent > p.budgetHours;
      return {
        ...p,
        spent,
        pct,
        isOver,
        clientName: s.clients.find((c) => c.id === p.clientId)?.name ?? "Internal",
      };
    });
  }, [s]);

  const overBudgetCount = projectStats.filter((p) => p.isOver).length;
  const activeProjects = s.projects.filter((p) => p.status === "active").length;

  const mine = s.timesheets.find((t) => t.memberId === me.id && t.weekStart === thisWeek);
  const myHoursThisWeek = mine ? sheetTotal(mine) : 0;
  const weeklyTarget = (s.settings.dailyTarget || 8) * 5;

  const pending = s.timesheets.filter((t) => t.status === "submitted");
  const recent = [...s.timesheets]
    .filter((t) => t.status !== "draft")
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))
    .slice(0, 6);

  const member = (id: string) => s.members.find((m) => m.id === id)?.name ?? "Unknown";

  // Recent activity events from store audit logs
  const activityLogs = s.auditLogs?.slice(0, 5) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good day, ${me.name.split(" ")[0] || "User"}`}
        description={`Displaying workspace metrics for ${weekLabel(rangeStart).split(" – ")[0]} – ${weekLabel(thisWeek).split(" – ")[1]}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild>
              <Link to="/app/timesheet">
                <Clock className="size-4" />
                <span>Log time</span>
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
            {pending.length > 0 && (me.role === "Admin" || me.role === "Manager") && (
              <Button
                asChild
                variant="outline"
                className="border-warning/50 text-warning-foreground hover:bg-warning/10"
              >
                <Link to="/app/approvals">
                  <CheckSquare className="size-4 text-warning" />
                  <span>Review {pending.length} pending</span>
                </Link>
              </Button>
            )}
          </div>
        }
      />

      {/* KPI Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="My hours this week"
          value={formatHours(myHoursThisWeek, fmt)}
          hint={
            <span className="flex items-center gap-1.5">
              <span>Target: {weeklyTarget}h</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="capitalize font-medium">{mine?.status || "Draft"}</span>
            </span>
          }
          icon={Clock}
          tone="primary"
        />

        <StatCard
          label="Pending approvals"
          value={pending.length}
          hint={
            pending.length > 0 ? (
              <span className="text-warning-foreground font-medium flex items-center gap-1">
                <AlertTriangle className="size-3" /> Action required
              </span>
            ) : (
              "All timesheets up to date"
            )
          }
          icon={CheckSquare}
          tone={pending.length > 0 ? "warning" : "success"}
        />

        <StatCard
          label="Billable utilization"
          value={`${data.util.toFixed(1)}%`}
          hint={
            <span>
              {formatHours(data.billableHours, fmt)}h of {formatHours(data.totalHours, fmt)}h
              billable
            </span>
          }
          icon={Gauge}
          tone="teal"
        />

        <StatCard
          label="Active projects"
          value={activeProjects}
          hint={
            overBudgetCount > 0 ? (
              <span className="text-destructive font-medium">
                {overBudgetCount} project over budget
              </span>
            ) : (
              `${s.clients.filter((c) => c.status === "active").length} active clients`
            )
          }
          icon={Briefcase}
          tone={overBudgetCount > 0 ? "warning" : "success"}
        />
      </div>

      {/* Charts & Approvals Grid */}
      <div className="grid gap-6 xl:grid-cols-3">
        {/* Main Chart */}
        <Panel
          title="Team hours per week"
          className="xl:col-span-2"
          action={
            <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-0.5 text-xs">
              {([4, 6, 12] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWeeksWindow(w)}
                  className={cn(
                    "rounded-md px-2 py-1 font-medium transition-colors",
                    weeksWindow === w
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {w}W
                </button>
              ))}
            </div>
          }
        >
          <div
            className="h-72 w-full"
            role="img"
            aria-label="Stacked bar chart of billable and non-billable hours per week"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.weeks} margin={{ left: -16, right: 8, top: 10, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
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
                  cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--card)",
                    color: "var(--card-foreground)",
                    fontSize: 12,
                    boxShadow: "0 4px 16px -4px rgba(0,0,0,0.1)",
                  }}
                  formatter={(val: number) => [`${val.toFixed(1)} hrs`, ""]}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Bar
                  dataKey="billable"
                  name="Billable"
                  stackId="a"
                  fill="var(--chart-1)"
                  radius={[0, 0, 0, 0]}
                />
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
        </Panel>

        {/* Pending Approvals Panel */}
        <Panel
          title="Pending approvals"
          action={
            <Link
              to="/app/approvals"
              className="text-xs font-semibold text-primary hover:underline"
            >
              View all ({pending.length})
            </Link>
          }
        >
          {pending.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="All caught up"
              text="No timesheets are currently waiting for review."
            />
          ) : (
            <ul className="divide-y">
              {pending.slice(0, 5).map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-3">
                  <Initials name={member(t.memberId)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{member(t.memberId)}</p>
                    <p className="text-xs text-muted-foreground">{weekLabel(t.weekStart)}</p>
                  </div>
                  <div className="text-right">
                    <span className="block text-sm font-bold tabular">
                      {formatHours(sheetTotal(t), fmt)}h
                    </span>
                    <span className="inline-block text-[10px] text-muted-foreground">
                      {t.entries.filter((e) => e.billable).length} billable
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Projects Burn & Activity Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Project Budget Health */}
        <Panel
          title="Project Budget Burn"
          action={
            <Link to="/app/projects" className="text-xs font-semibold text-primary hover:underline">
              All projects →
            </Link>
          }
        >
          <div className="space-y-4">
            {projectStats.slice(0, 4).map((p) => (
              <div key={p.id} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-foreground truncate max-w-[200px]">
                    {p.name}
                  </span>
                  <span className="tabular text-muted-foreground">
                    <strong className="text-foreground">{formatHours(p.spent, fmt)}h</strong>
                    {p.budgetHours > 0 ? ` / ${p.budgetHours}h` : " (Internal)"}
                  </span>
                </div>
                {p.budgetHours > 0 && (
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-300",
                        p.pct >= 90 ? "bg-destructive" : p.pct >= 75 ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${p.pct}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        {/* Recent Activity / Audit Log */}
        <Panel title="Recent Activities">
          {activityLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No recent activity logs.
            </p>
          ) : (
            <ul className="divide-y">
              {activityLogs.map((log) => (
                <li key={log.id} className="py-2.5 flex items-start gap-3">
                  <div className="size-2 rounded-full bg-primary mt-1.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-foreground truncate">
                        {log.actorName} · <span className="font-normal">{log.action}</span>
                      </p>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {log.timestamp}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug truncate mt-0.5">
                      {log.details}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Recent Timesheets Table */}
      <Panel title="Recent timesheets">
        <div className="-mx-5 -my-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Employee</th>
                <th className="px-5 py-3 font-medium">Week</th>
                <th className="px-5 py-3 text-right font-medium">Hours</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {recent.map((t) => (
                <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-5 py-3 font-medium">
                    <div className="flex items-center gap-2.5">
                      <Initials name={member(t.memberId)} className="size-7 text-[11px]" />
                      <span>{member(t.memberId)}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{weekLabel(t.weekStart)}</td>
                  <td className="px-5 py-3 text-right tabular font-semibold">
                    {formatHours(sheetTotal(t), fmt)}h
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link to="/app/timesheet">View</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
