import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Plus, Search, Pencil, FolderOpen } from "lucide-react";
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
import { EmptyState, PageHeader, StatusBadge } from "@/components/app/common";
import { loggedHours, uid, upsertProject, useDemo, type Project } from "@/lib/demo-store";
import { formatHours, formatMoney } from "@/lib/time";
import { pageHead } from "@/lib/seo";

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

function Projects() {
  const s = useDemo((x) => x);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [client, setClient] = useState("all");
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const cur = s.settings.currency;
  const list = s.projects.filter((p) => {
    const c = s.clients.find((x) => x.id === p.clientId)?.name ?? "Internal";
    return (
      (status === "all" || p.status === status) &&
      (client === "all" || p.clientId === client) &&
      `${p.name} ${c}`.toLowerCase().includes(q.toLowerCase())
    );
  });

  return (
    <>
      <PageHeader
        title="Projects"
        description="Billable rates shown are demo values, per hour."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus /> New project
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects or clients"
            className="pl-9"
            aria-label="Search projects"
          />
        </div>
        <Select value={client} onValueChange={setClient}>
          <SelectTrigger className="sm:w-52" aria-label="Filter by client">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {s.clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="sm:w-40" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="on-hold">On hold</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No projects found"
          text="Try a different search or filter."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Project</th>
                <th className="px-5 py-3 font-medium">Manager</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Logged / budget</th>
                <th className="px-5 py-3 text-right font-medium">Rate</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((p) => {
                const logged = loggedHours(s, p.id);
                const pct = p.budgetHours ? Math.min(100, (logged / p.budgetHours) * 100) : 0;
                return (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="px-5 py-3">
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.clients.find((c) => c.id === p.clientId)?.name ?? "Internal"}
                      </p>
                    </td>
                    <td className="px-5 py-3">
                      {s.members.find((m) => m.id === p.managerId)?.name ?? "—"}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="w-56 px-5 py-3">
                      <p className="text-xs tabular">
                        <span className="font-semibold">{formatHours(logged)}</span> /{" "}
                        {p.budgetHours ? `${p.budgetHours} h` : "no budget"}
                      </p>
                      {p.budgetHours > 0 && (
                        <Progress
                          value={pct}
                          className="mt-1.5 h-1.5"
                          aria-label={`${pct.toFixed(0)}% of budget used`}
                        />
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular">
                      {p.rate ? formatMoney(p.rate, cur) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => setEditing(p)}
                      >
                        <Pencil />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ProjectDialog
          project={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const s = useDemo((x) => x);
  const [f, setF] = useState({
    name: project?.name ?? "",
    clientId: project?.clientId || "internal",
    managerId: project?.managerId ?? "",
    status: project?.status ?? "active",
    budgetHours: String(project?.budgetHours ?? ""),
    rate: String(project?.rate ?? ""),
    tasks: (project?.tasks ?? ["Development", "Meetings"]).join(", "),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success)
      return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    upsertProject({
      id: project?.id ?? uid("p"),
      ...r.data,
      clientId: r.data.clientId === "internal" ? "" : r.data.clientId,
      tasks: r.data.tasks
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    toast.success(project ? "Project updated" : "Project created");
    onClose();
  };
  const err = (k: string) => errors[k] && <p className="text-xs text-destructive">{errors[k]}</p>;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>Stored in this browser's demo workspace only.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="pn">Project name</Label>
            <Input id="pn" value={f.name} onChange={(e) => set("name", e.target.value)} />
            {err("name")}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Client</Label>
              <Select value={f.clientId} onValueChange={(v) => set("clientId", v)}>
                <SelectTrigger aria-label="Client">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">Internal</SelectItem>
                  {s.clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Project manager</Label>
              <Select value={f.managerId} onValueChange={(v) => set("managerId", v)}>
                <SelectTrigger aria-label="Project manager">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {s.members
                    .filter((m) => m.status !== "inactive")
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {err("managerId")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb">Budgeted hours</Label>
              <Input
                id="pb"
                inputMode="numeric"
                value={f.budgetHours}
                onChange={(e) => set("budgetHours", e.target.value)}
              />
              {err("budgetHours")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr">Billable rate / hour ({s.settings.currency})</Label>
              <Input
                id="pr"
                inputMode="numeric"
                value={f.rate}
                onChange={(e) => set("rate", e.target.value)}
              />
              {err("rate")}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={f.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="on-hold">On hold</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pt">Tasks (comma separated)</Label>
            <Input id="pt" value={f.tasks} onChange={(e) => set("tasks", e.target.value)} />
            {err("tasks")}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">{project ? "Save changes" : "Create project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
