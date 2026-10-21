import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Plus, Pencil, Building2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, PageHeader, StatusBadge } from "@/components/app/common";
import { uid, upsertClient, useDemo, type Client } from "@/lib/demo-store";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/clients")({
  head: () => pageHead("Clients", "Manage client contacts and active engagements."),
  component: Clients,
});

const schema = z.object({
  name: z.string().trim().min(2, "Client name is required").max(80),
  contact: z.string().trim().min(2, "Contact name is required").max(80),
  email: z.string().trim().email("Enter a valid email").max(255),
  country: z.string().trim().min(2, "Country is required").max(60),
  status: z.enum(["active", "inactive"]),
});

function Clients() {
  const s = useDemo((x) => x);
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  return (
    <>
      <PageHeader title="Clients" description="All client names and contacts are fictional demo data." actions={<Button onClick={() => setEditing("new")}><Plus /> Add client</Button>} />
      {s.clients.length === 0 ? (
        <EmptyState icon={Building2} title="No clients yet" action={<Button onClick={() => setEditing("new")}><Plus /> Add client</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {s.clients.map((c) => {
            const active = s.projects.filter((p) => p.clientId === c.id && p.status === "active");
            return (
              <article key={c.id} className="flex flex-col rounded-xl border bg-card p-5 shadow-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-lg bg-secondary text-primary"><Building2 className="size-5" /></span>
                    <div><h2 className="font-semibold leading-tight">{c.name}</h2><p className="text-xs text-muted-foreground">{c.country}</p></div>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
                <div className="mt-4 space-y-1 text-sm">
                  <p className="font-medium">{c.contact}</p>
                  <p className="flex items-center gap-1.5 text-muted-foreground"><Mail className="size-3.5" /> {c.email}</p>
                </div>
                <div className="mt-4 flex items-end justify-between border-t pt-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Active projects</p>
                    <p className="text-sm font-semibold">{active.length ? active.map((p) => p.name).join(", ") : "None"}</p>
                  </div>
                  <Button size="icon" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil /></Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editing && <ClientDialog client={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ClientDialog({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const [f, setF] = useState({ name: client?.name ?? "", contact: client?.contact ?? "", email: client?.email ?? "", country: client?.country ?? "India", status: client?.status ?? "active" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    upsertClient({ id: client?.id ?? uid("c"), ...r.data });
    toast.success(client ? "Client updated" : "Client added");
    onClose();
  };
  const field = (k: "name" | "contact" | "email" | "country", label: string, type = "text") => (
    <div className="space-y-1.5">
      <Label htmlFor={`cl-${k}`}>{label}</Label>
      <Input id={`cl-${k}`} type={type} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errors[k]} />
      {errors[k] && <p className="text-xs text-destructive">{errors[k]}</p>}
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{client ? "Edit client" : "Add client"}</DialogTitle><DialogDescription>Please use sample data only in this demo.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          {field("name", "Client name")}
          <div className="grid gap-3 sm:grid-cols-2">{field("contact", "Contact person")}{field("email", "Contact email", "email")}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("country", "Country")}
            <div className="space-y-1.5"><Label>Status</Label>
              <Select value={f.status} onValueChange={(v) => set("status", v)}><SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem></SelectContent></Select></div>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">{client ? "Save changes" : "Add client"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
