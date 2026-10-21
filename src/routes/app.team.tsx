import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { UserPlus, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Initials, PageHeader, StatusBadge } from "@/components/app/common";
import { addMember, CURRENT_USER_ID, uid, updateMember, useDemo, type Role } from "@/lib/demo-store";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/team")({
  head: () => pageHead("Team", "Team members, roles and invitations."),
  component: Team,
});

const schema = z.object({
  name: z.string().trim().min(2, "Name is required").max(80),
  email: z.string().trim().email("Enter a valid work email").max(255),
  title: z.string().trim().max(80),
  role: z.enum(["Admin", "Manager", "Employee"]),
});

function Team() {
  const s = useDemo((x) => x);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", email: "", title: "", role: "Employee" as Role });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    if (s.members.some((m) => m.email.toLowerCase() === r.data.email.toLowerCase())) return setErrors({ email: "This email is already on the team" });
    addMember({ id: uid("m"), ...r.data, title: r.data.title || "Team member", status: "invited" });
    toast.success("Added as invited (demo) — no email was sent");
    setOpen(false);
    setF({ name: "", email: "", title: "", role: "Employee" });
    setErrors({});
  };

  return (
    <>
      <PageHeader title="Team" description={`${s.members.filter((m) => m.status === "active").length} active members`} actions={<Button onClick={() => setOpen(true)}><UserPlus /> Invite member</Button>} />
      <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-5 py-3 font-medium">Member</th><th className="px-5 py-3 font-medium">Title</th><th className="px-5 py-3 font-medium">Role</th><th className="px-5 py-3 font-medium">Status</th></tr>
          </thead>
          <tbody className="divide-y">
            {s.members.map((m) => (
              <tr key={m.id}>
                <td className="px-5 py-3"><div className="flex items-center gap-2.5"><Initials name={m.name} /><div><p className="font-medium">{m.name}{m.id === CURRENT_USER_ID && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}</p><p className="text-xs text-muted-foreground">{m.email}</p></div></div></td>
                <td className="px-5 py-3 text-muted-foreground">{m.title}</td>
                <td className="px-5 py-3">
                  <Select value={m.role} disabled={m.id === CURRENT_USER_ID} onValueChange={(v) => { updateMember(m.id, { role: v as Role }); toast.success(`${m.name} is now ${v}`); }}>
                    <SelectTrigger className="h-8 w-32" aria-label={`Role for ${m.name}`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="Admin">Admin</SelectItem><SelectItem value="Manager">Manager</SelectItem><SelectItem value="Employee">Employee</SelectItem></SelectContent>
                  </Select>
                </td>
                <td className="px-5 py-3"><StatusBadge status={m.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite team member</DialogTitle><DialogDescription>Add someone to this demo workspace.</DialogDescription></DialogHeader>
          <div className="flex gap-2 rounded-lg border border-teal/30 bg-teal-soft p-3 text-sm text-accent-foreground" role="note">
            <Info className="mt-0.5 size-4 shrink-0" /> Demo only: invitations are <strong>not</strong> emailed. The person is added to the list with “invited” status.
          </div>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="space-y-1.5"><Label htmlFor="iv-name">Full name</Label><Input id="iv-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={!!errors.name} />{errors.name && <p className="text-xs text-destructive">{errors.name}</p>}</div>
            <div className="space-y-1.5"><Label htmlFor="iv-email">Work email</Label><Input id="iv-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-invalid={!!errors.email} />{errors.email && <p className="text-xs text-destructive">{errors.email}</p>}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="iv-title">Job title</Label><Input id="iv-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Role</Label>
                <Select value={f.role} onValueChange={(v) => setF({ ...f, role: v as Role })}><SelectTrigger aria-label="Role"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="Employee">Employee</SelectItem><SelectItem value="Manager">Manager</SelectItem><SelectItem value="Admin">Admin</SelectItem></SelectContent></Select></div>
            </div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">Add to demo team</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
