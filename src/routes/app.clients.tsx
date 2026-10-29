import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import {
  Plus,
  Pencil,
  Building2,
  Mail,
  Search,
  Phone,
  CreditCard,
  Briefcase,
  Clock,
  ArrowRight,
  TrendingUp,
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
import { EmptyState, PageHeader, StatCard, StatusBadge } from "@/components/app/common";
import {
  loggedHours,
  uid,
  upsertClient,
  useDemo,
  useMe,
  addAuditLog,
  type Client,
} from "@/lib/demo-store";
import { formatHours, formatMoney } from "@/lib/time";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/clients")({
  head: () => pageHead("Clients", "Manage client accounts, engagements and billing terms."),
  component: Clients,
});

const schema = z.object({
  name: z.string().trim().min(2, "Client name is required").max(80),
  contact: z.string().trim().min(2, "Contact name is required").max(80),
  email: z.string().trim().email("Enter a valid email").max(255),
  country: z.string().trim().min(2, "Country is required").max(60),
  status: z.enum(["active", "inactive"]),
  phone: z.string().trim().optional(),
  billingTerms: z.string().trim().optional(),
});

export function Clients() {
  const s = useDemo((x) => x);
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const cur = s.settings.currency;
  const fmt = s.settings.timeFormat;

  const filtered = s.clients.filter((c) => {
    const matchesQ = `${c.name} ${c.contact} ${c.email} ${c.country}`
      .toLowerCase()
      .includes(q.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  // Calculate client aggregate stats
  const activeClientsCount = s.clients.filter((c) => c.status === "active").length;
  const totalClientProjects = s.projects.filter((p) => Boolean(p.clientId)).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clients"
        description="Client corporate profiles, contact persons, active project engagements and billing settings."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            <span>Add client</span>
          </Button>
        }
      />

      {/* Summary KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active clients"
          value={activeClientsCount}
          hint={`${s.clients.length - activeClientsCount} archived / inactive`}
          icon={Building2}
          tone="primary"
        />
        <StatCard
          label="Client projects"
          value={totalClientProjects}
          hint="Engagements mapped to external accounts"
          icon={Briefcase}
          tone="teal"
        />
        <StatCard
          label="Global accounts"
          value={new Set(s.clients.map((c) => c.country)).size}
          hint="Countries with active client footprint"
          icon={TrendingUp}
          tone="success"
        />
        <StatCard
          label="Standard payment terms"
          value="Net 30"
          hint="Standard invoice fulfillment window"
          icon={CreditCard}
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
            placeholder="Search clients by name, contact, country..."
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="sm:w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Clients Cards Grid */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No clients found"
          text="No client profiles match your current search criteria."
          action={
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" /> Add client
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => {
            const projects = s.projects.filter((p) => p.clientId === c.id);
            const activeProjects = projects.filter((p) => p.status === "active");
            const totalHours = projects.reduce((acc, p) => acc + loggedHours(s, p.id), 0);
            const totalRevenue = projects.reduce(
              (acc, p) => acc + loggedHours(s, p.id) * (p.rate || 0),
              0,
            );

            return (
              <article
                key={c.id}
                className="flex flex-col justify-between rounded-2xl border bg-card p-5 shadow-card transition-all duration-200 hover:shadow-elevated hover:border-primary/40 relative"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
                        <Building2 className="size-5.5" />
                      </span>
                      <div>
                        <h2 className="font-bold text-foreground leading-tight text-base">
                          {c.name}
                        </h2>
                        <p className="text-xs text-muted-foreground">{c.country}</p>
                      </div>
                    </div>
                    <StatusBadge status={c.status} />
                  </div>

                  <div className="mt-4 space-y-1.5 text-xs">
                    <p className="font-semibold text-foreground">{c.contact}</p>
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      <Mail className="size-3.5" /> {c.email}
                    </p>
                    {c.phone && (
                      <p className="flex items-center gap-1.5 text-muted-foreground">
                        <Phone className="size-3.5" /> {c.phone}
                      </p>
                    )}
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      <CreditCard className="size-3.5" /> Terms: {c.billingTerms || "Net 30"}
                    </p>
                  </div>

                  {/* Client stats strip */}
                  <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-muted/40 p-2.5 text-xs">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase font-semibold">
                        Logged Hours
                      </p>
                      <p className="font-bold tabular text-foreground">
                        {formatHours(totalHours, fmt)}h
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase font-semibold">
                        Est. Billed
                      </p>
                      <p className="font-bold tabular text-primary">
                        {formatMoney(totalRevenue, cur)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-end justify-between border-t pt-3">
                  <div className="min-w-0 flex-1 pr-2">
                    <p className="text-[11px] text-muted-foreground">
                      Projects ({projects.length})
                    </p>
                    <p className="truncate text-xs font-semibold text-foreground">
                      {activeProjects.length
                        ? activeProjects.map((p) => p.name).join(", ")
                        : "No active projects"}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${c.name}`}
                    onClick={() => setEditing(c)}
                  >
                    <Pencil className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editing && (
        <ClientDialog
          client={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ClientDialog({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const me = useMe();
  const [f, setF] = useState({
    name: client?.name ?? "",
    contact: client?.contact ?? "",
    email: client?.email ?? "",
    country: client?.country ?? "India",
    status: client?.status ?? ("active" as const),
    phone: client?.phone ?? "+91 98765 43210",
    billingTerms: client?.billingTerms ?? "Net 30",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) {
      return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    }

    const isNew = !client;
    upsertClient({
      id: client?.id ?? uid("c"),
      ...r.data,
      phone: r.data.phone || undefined,
      billingTerms: r.data.billingTerms || "Net 30",
    });

    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: isNew ? "Client Added" : "Client Updated",
      category: "client",
      details: `${isNew ? "Added" : "Updated"} client "${r.data.name}" (${r.data.contact}, ${r.data.billingTerms})`,
    });

    toast.success(client ? "Client updated" : "Client profile added");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{client ? "Edit Client" : "Add Client Profile"}</DialogTitle>
          <DialogDescription>
            Specify company information, main contact representative and payment terms.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={save} className="space-y-3.5 py-2" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Company name</Label>
            <Input
              id="c-name"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              aria-invalid={!!errors["name"]}
            />
            {errors["name"] && <p className="text-xs text-destructive">{errors["name"]}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-contact">Primary contact</Label>
              <Input
                id="c-contact"
                value={f.contact}
                onChange={(e) => setF({ ...f, contact: e.target.value })}
                aria-invalid={!!errors["contact"]}
              />
              {errors["contact"] && <p className="text-xs text-destructive">{errors["contact"]}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="c-email">Contact email</Label>
              <Input
                id="c-email"
                type="email"
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
                aria-invalid={!!errors["email"]}
              />
              {errors["email"] && <p className="text-xs text-destructive">{errors["email"]}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-country">Country</Label>
              <Input
                id="c-country"
                value={f.country}
                onChange={(e) => setF({ ...f, country: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="c-phone">Phone number</Label>
              <Input
                id="c-phone"
                value={f.phone}
                onChange={(e) => setF({ ...f, phone: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Payment Terms</Label>
              <Select value={f.billingTerms} onValueChange={(v) => setF({ ...f, billingTerms: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Net 15">Net 15 Days</SelectItem>
                  <SelectItem value="Net 30">Net 30 Days</SelectItem>
                  <SelectItem value="Net 45">Net 45 Days</SelectItem>
                  <SelectItem value="Due on Receipt">Due on Receipt</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={f.status}
                onValueChange={(v: "active" | "inactive") => setF({ ...f, status: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save client</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
