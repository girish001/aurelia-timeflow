import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { z } from "zod";
import {
  Plus,
  Search,
  Pencil,
  FolderOpen,
  AlertTriangle,
  Briefcase,
  Clock,
  TrendingUp,
  DollarSign,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, PageHeader, StatCard, StatusBadge } from "@/components/app/common";
import {
  loggedHours,
  uid,
  upsertProject,
  useDemo,
  useMe,
  addAuditLog,
  type Project,
  type State,
} from "@/lib/demo-store";
import { formatHours, formatMoney } from "@/lib/time";
import { scopedProjects } from "@/lib/rules";
import { pageHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/projects")({
  head: () => pageHead("Projects", "Track project budgets, logged hours and billable rates."),
  component: Projects,
});

const schema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  clientId: z.string(),
  managerId: z.string().min(1, "Choose a project manager"),
  status: z.enum(["active", "on-hold", "completed"]),
  budgetHours: z.coerce
    .number({ invalid_type_error: "Enter a number" })
    .min(0, "Cannot be negative")
    .max(100000),
  rate: z.coerce
    .number({ invalid_type_error: "Enter a number" })
    .min(0, "Cannot be negative")
    .max(1000000),
  tasks: z.string().trim().min(1, "Add at least one task"),
});

export function Projects() {
  const me = useMe();
  const s = useDemo((x) => x);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [client, setClient] = useState("all");
  const [editing, setEditing] = useState<Project | "new" | null>(null);

  const cur = s.settings.currency;
  const fmt = s.settings.timeFormat;

  const scoped = useMemo(() => scopedProjects(s, me), [s, me]);

  const list = scoped.filter((p) => {
    const c = s.clients.find((x) => x.id === p.clientId)?.name ?? "Internal";
    return (
      (status === "all" || p.status === status) &&
      (client === "all" || p.clientId === client) &&
      `${p.name} ${c}`.toLowerCase().includes(q.toLowerCase())
    );
  });

  // Calculate project aggregate metrics based on scoped projects
  const totalBudgetHours = scoped.reduce((acc, p) => acc + (p.budgetHours || 0), 0);
  const totalLoggedHours = scoped.reduce((acc, p) => acc + loggedHours(s, p.id), 0);
  const totalEstRevenue = scoped.reduce((acc, p) => acc + loggedHours(s, p.id) * (p.rate || 0), 0);
  const overBudgetCount = scoped.filter(
    (p) => p.budgetHours > 0 && loggedHours(s, p.id) > p.budgetHours,
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Monitor project progress, budget consumption, billable rates and delivery revenue."
        actions={
          me.role === "Admin" ? (
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              <span>New project</span>
            </Button>
          ) : undefined
        }
      />

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={me.role === "Admin" ? "Total projects" : "Managed projects"}
          value={scoped.length}
          hint={`${scoped.filter((p) => p.status === "active").length} active, ${scoped.filter((p) => p.status === "completed").length} completed`}
          icon={Briefcase}
          tone="primary"
        />
        <StatCard
          label="Logged / Budgeted"
          value={`${formatHours(totalLoggedHours, fmt)}h`}
          hint={`Of ${formatHours(totalBudgetHours, fmt)}h allocated capacity`}
          icon={Clock}
          tone="teal"
        />
        <StatCard
          label="Estimated Revenue"
          value={formatMoney(totalEstRevenue, cur)}
          hint="Logged billable hours × hourly rate"
          icon={TrendingUp}
          tone="success"
        />
        <StatCard
          label="Budget Health"
          value={overBudgetCount === 0 ? "100% On Track" : `${overBudgetCount} Over Budget`}
          hint={
            overBudgetCount > 0 ? "Requires manager review" : "All projects within planned hours"
          }
          icon={AlertTriangle}
          tone={overBudgetCount > 0 ? "warning" : "success"}
        />
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects or clients..."
            className="pl-9"
            aria-label="Search projects"
          />
        </div>
        <Select value={client} onValueChange={setClient}>
          <SelectTrigger className="sm:w-56" aria-label="Filter by client">
            <SelectValue placeholder="All clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            <SelectItem value="internal">Internal only</SelectItem>
            {s.clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-44" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="on-hold">On hold</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table view */}
      {list.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No projects found"
          text="Try adjusting your search criteria or create a new project."
          action={
            me.role === "Admin" ? (
              <Button onClick={() => setEditing("new")}>
                <Plus className="size-4" /> Create project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-semibold">Project & Client</th>
                <th className="px-5 py-3 font-semibold">Manager</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Logged / Budget</th>
                <th className="px-5 py-3 text-right font-semibold">Billable Rate</th>
                <th className="px-5 py-3 text-right font-semibold">Est. Value</th>
                <th className="px-5 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((p) => {
                const logged = loggedHours(s, p.id);
                const hasBudget = p.budgetHours > 0;
                const pct = hasBudget ? Math.min(100, (logged / p.budgetHours) * 100) : 0;
                const isOver = hasBudget && logged > p.budgetHours;
                const estValue = logged * (p.rate || 0);

                return (
                  <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-5 py-3.5">
                      <p className="font-semibold text-foreground">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.clients.find((c) => c.id === p.clientId)?.name ?? "Internal"}
                      </p>
                    </td>
                    <td className="px-5 py-3.5 text-foreground font-medium">
                      {s.members.find((m) => m.id === p.managerId)?.name ?? "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="w-64 px-5 py-3.5">
                      <div className="flex items-center justify-between text-xs tabular mb-1">
                        <span className="font-semibold text-foreground">
                          {formatHours(logged, fmt)}h
                        </span>
                        <span className="text-muted-foreground">
                          {hasBudget ? `${p.budgetHours}h` : "No limit"}
                        </span>
                        {isOver && (
                          <span className="rounded bg-destructive/10 px-1.5 py-0.2 text-[10px] font-bold text-destructive">
                            Over budget
                          </span>
                        )}
                      </div>
                      {hasBudget && (
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all duration-300",
                              isOver ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary",
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right tabular font-medium">
                      {p.rate ? formatMoney(p.rate, cur) : "—"}/h
                    </td>
                    <td className="px-5 py-3.5 text-right tabular font-bold text-foreground">
                      {estValue > 0 ? formatMoney(estValue, cur) : "—"}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {me.role === "Admin" || p.managerId === me.id ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => setEditing(p)}
                        >
                          <Pencil className="size-4 text-muted-foreground" />
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground font-mono">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / Create Dialog */}
      {editing && (
        <ProjectEditor
          project={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          state={s}
        />
      )}
    </div>
  );
}

function ProjectEditor({
  project,
  onClose,
  state,
}: {
  project: Project | null;
  onClose: () => void;
  state: State;
}) {
  const me = useMe();
  const [f, setF] = useState({
    name: project?.name ?? "",
    clientId: project?.clientId ?? "",
    managerId: project?.managerId ?? state.members.find((m) => m.role === "Manager")?.id ?? "",
    status: project?.status ?? ("active" as const),
    budgetHours: String(project?.budgetHours ?? 100),
    rate: String(project?.rate ?? 2500),
    tasks: project?.tasks.join(", ") ?? "Development, Code review, Meetings",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) {
      return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    }
    const tasks = r.data.tasks
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const isNew = !project;
    upsertProject({
      id: project?.id ?? uid("p"),
      ...r.data,
      tasks: tasks.length ? tasks : ["General"],
    });

    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: isNew ? "Project Created" : "Project Updated",
      category: "project",
      details: `${isNew ? "Created" : "Updated"} project "${r.data.name}" (budget: ${r.data.budgetHours}h, rate: ${r.data.rate})`,
    });

    toast.success(project ? "Project updated" : "Project created successfully");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{project ? "Edit Project" : "New Project"}</DialogTitle>
          <DialogDescription>
            Configure project parameters, manager allocation, hourly rates and tasks.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3.5 py-2" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              aria-invalid={!!errors["name"]}
            />
            {errors["name"] && <p className="text-xs text-destructive">{errors["name"]}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Client</Label>
              <Select
                value={f.clientId || "internal"}
                onValueChange={(v) => setF({ ...f, clientId: v === "internal" ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">Internal (no client)</SelectItem>
                  {state.clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Project Manager</Label>
              <Select value={f.managerId} onValueChange={(v) => setF({ ...f, managerId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select manager" />
                </SelectTrigger>
                <SelectContent>
                  {state.members
                    .filter((m) => m.role === "Manager" || m.role === "Admin")
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="budget">Budget (hrs)</Label>
              <Input
                id="budget"
                type="number"
                value={f.budgetHours}
                onChange={(e) => setF({ ...f, budgetHours: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate">Rate ({state.settings.currency}/h)</Label>
              <Input
                id="rate"
                type="number"
                value={f.rate}
                onChange={(e) => setF({ ...f, rate: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={f.status}
                onValueChange={(v: "active" | "on-hold" | "completed") => setF({ ...f, status: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="on-hold">On hold</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tasks">Tasks (comma-separated)</Label>
            <Input
              id="tasks"
              value={f.tasks}
              onChange={(e) => setF({ ...f, tasks: e.target.value })}
              placeholder="Development, Design, Code review, QA"
            />
            {errors["tasks"] && <p className="text-xs text-destructive">{errors["tasks"]}</p>}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save project</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
