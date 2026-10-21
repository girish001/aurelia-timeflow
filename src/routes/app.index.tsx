import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { parseISO, subWeeks, format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Briefcase, CheckSquare, Clock, Gauge, ArrowRight, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Initials, PageHeader, Panel, StatCard, StatusBadge } from "@/components/app/common";
import { useMe, flatten, sheetTotal, useDemo } from "@/lib/demo-store";
import { formatHours, weekKey, weekLabel } from "@/lib/time";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/")({
  head: () => pageHead("Overview", "Weekly hours, approvals and utilization at a glance."),
  component: Dashboard,
});

function Dashboard() {
  const CURRENT_USER_ID = useMe().id;
  const s = useDemo((x) => x);
  const fmt = s.settings.timeFormat;
  const thisWeek = weekKey(new Date());
  const rangeStart = weekKey(subWeeks(parseISO(thisWeek), 5));

  const data = useMemo(() => {
    const rows = flatten(s, { includeDrafts: true }).filter((r) => r.weekStart >= rangeStart);
    const weeks: { week: string; label: string; billable: number; nonBillable: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const w = weekKey(subWeeks(parseISO(thisWeek), i));
      const wr = rows.filter((r) => r.weekStart === w);
      weeks.push({
        week: w,
        label: format(parseISO(w), "d MMM"),
        billable: +wr.filter((r) => r.billable).reduce((a, r) => a + r.hours, 0).toFixed(2),
        nonBillable: +wr.filter((r) => !r.billable).reduce((a, r) => a + r.hours, 0).toFixed(2),
      });
    }
    const total = rows.reduce((a, r) => a + r.hours, 0);
    const billable = rows.filter((r) => r.billable).reduce((a, r) => a + r.hours, 0);
    return { weeks, util: total ? (billable / total) * 100 : 0 };
  }, [s, rangeStart, thisWeek]);

  const mine = s.timesheets.find((t) => t.memberId === CURRENT_USER_ID && t.weekStart === thisWeek);
  const pending = s.timesheets.filter((t) => t.status === "submitted");
  const recent = [...s.timesheets].filter((t) => t.status !== "draft").sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")).slice(0, 6);
  const activeProjects = s.projects.filter((p) => p.status === "active").length;
  const member = (id: string) => s.members.find((m) => m.id === id)?.name ?? "Unknown";

  return (
    <>
      <PageHeader
        title={`Good day, ${member(CURRENT_USER_ID).split(" ")[0]}`}
        description={`Showing ${weekLabel(rangeStart).split(" – ")[0]} – ${weekLabel(thisWeek).split(" – ")[1]} (last 6 weeks, incl. drafts)`}
        actions={<Button asChild><Link to="/app/timesheet">Log time <ArrowRight /></Link></Button>}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="My hours this week" value={formatHours(mine ? sheetTotal(mine) : 0, fmt)} hint={mine ? `Status: ${mine.status}` : "No timesheet yet"} icon={Clock} />
        <StatCard label="Pending approvals" value={pending.length} hint="Submitted timesheets awaiting review" icon={CheckSquare} tone="warning" />
        <StatCard label="Billable utilization" value={`${data.util.toFixed(0)}%`} hint="Billable ÷ total hours, 6 weeks" icon={Gauge} tone="teal" />
        <StatCard label="Active projects" value={activeProjects} hint={`${s.clients.filter((c) => c.status === "active").length} active clients`} icon={Briefcase} tone="success" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel title="Team hours per week" className="xl:col-span-2">
          <div className="h-72" role="img" aria-label="Stacked bar chart of billable and non-billable hours per week">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.weeks} margin={{ left: -16, right: 8 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="var(--muted-foreground)" />
                <Tooltip cursor={{ fill: "var(--muted)" }} contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 12 }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="billable" name="Billable" stackId="a" fill="var(--chart-1)" />
                <Bar dataKey="nonBillable" name="Non-billable" stackId="a" fill="var(--chart-2)" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Pending approvals" action={<Link to="/app/approvals" className="text-xs font-medium text-primary hover:underline">View all</Link>}>
          {pending.length === 0 ? (
            <EmptyState icon={Inbox} title="All caught up" text="No timesheets are waiting for review." />
          ) : (
            <ul className="divide-y">
              {pending.slice(0, 5).map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2.5">
                  <Initials name={member(t.memberId)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{member(t.memberId)}</p>
                    <p className="text-xs text-muted-foreground">{weekLabel(t.weekStart)}</p>
                  </div>
                  <span className="text-sm font-semibold tabular">{formatHours(sheetTotal(t), fmt)}h</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Recent timesheets" className="mt-6">
        <div className="-mx-5 -my-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-5 py-2.5 font-medium">Employee</th><th className="px-5 py-2.5 font-medium">Week</th><th className="px-5 py-2.5 text-right font-medium">Hours</th><th className="px-5 py-2.5 font-medium">Status</th></tr>
            </thead>
            <tbody className="divide-y">
              {recent.map((t) => (
                <tr key={t.id}>
                  <td className="px-5 py-3 font-medium">{member(t.memberId)}</td>
                  <td className="px-5 py-3 text-muted-foreground">{weekLabel(t.weekStart)}</td>
                  <td className="px-5 py-3 text-right tabular">{formatHours(sheetTotal(t), fmt)}</td>
                  <td className="px-5 py-3"><StatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
