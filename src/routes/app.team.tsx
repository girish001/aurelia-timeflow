import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import {
  UserPlus,
  Search,
  Users,
  ShieldCheck,
  Briefcase,
  Mail,
  Building,
  CheckCircle2,
  Clock,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Initials, PageHeader, StatCard, StatusBadge } from "@/components/app/common";
import {
  addMember,
  addAuditLog,
  useMe,
  uid,
  updateMember,
  useDemo,
  flatten,
  type Role,
  type Member,
} from "@/lib/demo-store";
import { formatHours, weekKey } from "@/lib/time";
import { ROLE_LABEL, scopedMembers } from "@/lib/rules";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/team")({
  head: () => pageHead("Team", "Team directory, roles, departments and onboarding."),
  component: Team,
});

const schema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  email: z.string().trim().email("Enter a valid work email").max(255),
  title: z.string().trim().max(80),
  department: z.string().trim().min(1, "Select department"),
  role: z.enum(["Admin", "Manager", "Employee"]),
  reportingManagerId: z.string().optional(),
});

const DEPARTMENTS = [
  "Engineering",
  "Design & UX",
  "Quality Assurance",
  "Product & Delivery",
  "Operations & Admin",
];

export function Team() {
  const me = useMe();
  const CURRENT_USER_ID = me.id;
  const s = useDemo((x) => x);
  const fmt = s.settings.timeFormat;
  const thisWeek = weekKey(new Date());

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [deptFilter, setDeptFilter] = useState("all");

  const [f, setF] = useState({
    name: "",
    email: "",
    title: "",
    department: "Engineering",
    role: "Employee" as Role,
    reportingManagerId: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) {
      return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    }
    if (s.members.some((m) => m.email.toLowerCase() === r.data.email.toLowerCase())) {
      return setErrors({ email: "This email is already associated with an account" });
    }

    addMember({
      id: uid("m"),
      name: r.data.name,
      email: r.data.email,
      title: r.data.title || "Team member",
      role: r.data.role,
      department: r.data.department,
      reportingManagerId: r.data.reportingManagerId || undefined,
      status: "invited",
    });

    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Member Invited",
      category: "member",
      details: `Invited ${r.data.name} (${r.data.email}) as ${r.data.role} in ${r.data.department}`,
    });

    toast.success(`Invitation generated for ${r.data.name} (${r.data.email})`);
    setOpen(false);
    setF({
      name: "",
      email: "",
      title: "",
      department: "Engineering",
      role: "Employee",
      reportingManagerId: "",
    });
    setErrors({});
  };

  const visibleMembers = scopedMembers(s, me);

  const filteredMembers = visibleMembers.filter((m) => {
    const matchesQ = `${m.name} ${m.email} ${m.title} ${m.department || ""}`
      .toLowerCase()
      .includes(q.toLowerCase());
    const matchesRole = roleFilter === "all" || m.role === roleFilter;
    const matchesDept = deptFilter === "all" || m.department === deptFilter;
    return matchesQ && matchesRole && matchesDept;
  });

  const activeCount = visibleMembers.filter((m) => m.status === "active").length;
  const invitedCount = visibleMembers.filter((m) => m.status === "invited").length;
  const managerCount = visibleMembers.filter((m) => m.role === "Manager").length;
  const employeeCount = visibleMembers.filter((m) => m.role === "Employee").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Company personnel, organizational roles, department hierarchy and onboarding."
        actions={
          me.role === "Admin" ? (
            <Button onClick={() => setOpen(true)}>
              <UserPlus className="size-4" />
              <span>Invite member</span>
            </Button>
          ) : undefined
        }
      />

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={me.role === "Admin" ? "Total team size" : "Team members"}
          value={visibleMembers.length}
          hint={`${activeCount} active, ${invitedCount} invited`}
          icon={Users}
          tone="primary"
        />
        <StatCard
          label="Delivery leads"
          value={managerCount}
          hint="Managing client engagements"
          icon={ShieldCheck}
          tone="teal"
        />
        <StatCard
          label="Consultants & Engineers"
          value={employeeCount}
          hint="Active delivery personnel"
          icon={Briefcase}
          tone="success"
        />
        <StatCard
          label="Departments"
          value={DEPARTMENTS.length}
          hint="Engineering, QA, Design, Ops"
          icon={Building}
          tone="primary"
        />
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email, designation..."
            className="pl-9"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="All roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="Admin">Business Admin</SelectItem>
            <SelectItem value="Manager">Project Manager</SelectItem>
            <SelectItem value="Employee">Employee</SelectItem>
          </SelectContent>
        </Select>
        <Select value={deptFilter} onValueChange={setDeptFilter}>
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {DEPARTMENTS.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Team table */}
      <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-semibold">Member</th>
              <th className="px-5 py-3 font-semibold">Title & Department</th>
              <th className="px-5 py-3 font-semibold">Role</th>
              <th className="px-5 py-3 text-right font-semibold">This Week</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredMembers.map((m) => {
              const currentWeekSheet = s.timesheets.find(
                (t) => t.memberId === m.id && t.weekStart === thisWeek,
              );
              const weeklyHours = currentWeekSheet
                ? currentWeekSheet.entries.reduce(
                    (acc, e) => acc + e.hours.reduce((a, b) => a + b, 0),
                    0,
                  )
                : 0;

              return (
                <tr key={m.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Initials name={m.name} className="size-9 text-xs font-bold" />
                      <div>
                        <p className="font-semibold text-foreground">
                          {m.name}
                          {m.id === CURRENT_USER_ID && (
                            <span className="ml-1.5 rounded-md bg-teal-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">
                              You
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">{m.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="font-medium text-foreground">{m.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.department ||
                        (m.role === "Admin"
                          ? "Operations"
                          : m.role === "Manager"
                            ? "Delivery"
                            : "Engineering")}
                    </p>
                  </td>
                  <td className="px-5 py-3.5">
                    <Select
                      value={m.role}
                      disabled={m.id === CURRENT_USER_ID || me.role !== "Admin"}
                      onValueChange={(v) => {
                        updateMember(m.id, { role: v as Role });
                        addAuditLog({
                          actorId: me.id,
                          actorName: me.name,
                          action: "Member Role Updated",
                          category: "member",
                          details: `Updated ${m.name}'s role to ${ROLE_LABEL[v as Role]}`,
                        });
                        toast.success(`${m.name}'s role updated to ${ROLE_LABEL[v as Role]}`);
                      }}
                    >
                      <SelectTrigger
                        className="h-8 w-36 text-xs font-medium"
                        aria-label={`Role for ${m.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Admin">Business Admin</SelectItem>
                        <SelectItem value="Manager">Project Manager</SelectItem>
                        <SelectItem value="Employee">Employee</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-5 py-3.5 text-right tabular">
                    <span className="font-semibold text-foreground">
                      {formatHours(weeklyHours, fmt)}h
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={m.status} />
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {me.role === "Admin" && m.status === "invited" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          updateMember(m.id, { status: "active" });
                          addAuditLog({
                            actorId: me.id,
                            actorName: me.name,
                            action: "Member Activated",
                            category: "member",
                            details: `Activated invited member ${m.name} (${m.email})`,
                          });
                          toast.success(`${m.name} marked as active`);
                        }}
                      >
                        Activate
                      </Button>
                    ) : me.role === "Admin" && m.id !== CURRENT_USER_ID ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const nextStatus = m.status === "active" ? "inactive" : "active";
                          updateMember(m.id, { status: nextStatus });
                          addAuditLog({
                            actorId: me.id,
                            actorName: me.name,
                            action:
                              nextStatus === "active" ? "Member Reactivated" : "Member Deactivated",
                            category: "member",
                            details: `Changed ${m.name}'s status to ${nextStatus}`,
                          });
                          toast.success(`${m.name} marked as ${nextStatus}`);
                        }}
                      >
                        {m.status === "active" ? "Deactivate" : "Reactivate"}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Invite Member Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite Team Member</DialogTitle>
            <DialogDescription>
              Add a new employee or manager to your Aurelia TimeFlow workspace.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-3.5 py-2" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="mem-name">Full name</Label>
              <Input
                id="mem-name"
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
                placeholder="e.g. Ankit Sharma"
                aria-invalid={!!errors["name"]}
              />
              {errors["name"] && <p className="text-xs text-destructive">{errors["name"]}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mem-email">Work email</Label>
              <Input
                id="mem-email"
                type="email"
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
                placeholder="ankit@company.com"
                aria-invalid={!!errors["email"]}
              />
              {errors["email"] && <p className="text-xs text-destructive">{errors["email"]}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mem-title">Designation / Title</Label>
                <Input
                  id="mem-title"
                  value={f.title}
                  onChange={(e) => setF({ ...f, title: e.target.value })}
                  placeholder="e.g. Fullstack Engineer"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Department</Label>
                <Select value={f.department} onValueChange={(v) => setF({ ...f, department: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Workspace Role</Label>
                <Select value={f.role} onValueChange={(v: Role) => setF({ ...f, role: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Admin">Business Admin</SelectItem>
                    <SelectItem value="Manager">Project Manager</SelectItem>
                    <SelectItem value="Employee">Employee</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Reporting Manager</Label>
                <Select
                  value={f.reportingManagerId}
                  onValueChange={(v) => setF({ ...f, reportingManagerId: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select manager" />
                  </SelectTrigger>
                  <SelectContent>
                    {s.members
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

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Send invitation</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
