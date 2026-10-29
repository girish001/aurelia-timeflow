import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import {
  FlaskConical,
  ShieldCheck,
  Building,
  Clock,
  CheckCircle2,
  Lock,
  Layers,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, Panel } from "@/components/app/common";
import { getState, updateSettings, useDemo, useMe, addAuditLog } from "@/lib/demo-store";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/settings")({
  head: () => pageHead("Settings", "Company profile, submission rules, permissions and policies."),
  component: SettingsPage,
});

const schema = z.object({
  companyName: z.string().trim().min(2, "Company name is required").max(100),
  companyEmail: z.string().trim().email("Enter a valid email").max(255),
  country: z.string().trim().min(2, "Country is required").max(60),
  dailyTarget: z.coerce.number().min(1, "1–24 hours").max(24, "1–24 hours"),
});

export function SettingsPage() {
  const me = useMe();
  const settings = useDemo((s) => s.settings);
  const [f, setF] = useState(() => ({
    ...getState().settings,
    dailyTarget: String(getState().settings.dailyTarget),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) {
      return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    }
    setErrors({});
    updateSettings({
      companyName: r.data.companyName,
      companyEmail: r.data.companyEmail,
      country: r.data.country,
      dailyTarget: r.data.dailyTarget,
      timezone: f.timezone,
      lockApproved: f.lockApproved,
      allowOvertime: f.allowOvertime,
      requireRejectReason: f.requireRejectReason,
    });
    addAuditLog({
      actorId: me.id,
      actorName: me.name,
      action: "Settings Updated",
      category: "settings",
      details: `Updated workspace policies (Target: ${r.data.dailyTarget}h/day, Lock approved: ${f.lockApproved})`,
    });
    toast.success("Workspace settings saved");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Company profile, timesheet policies, approval rules and workspace permissions."
      />

      {/* Demo status notice */}
      <div className="flex items-center gap-3.5 rounded-2xl border border-teal/30 bg-teal-soft p-4 text-sm text-accent-foreground">
        <FlaskConical className="size-5 shrink-0 text-teal" />
        <div className="space-y-0.5">
          <p className="font-semibold text-foreground">Demo Sandbox Environment Active</p>
          <p className="text-xs text-muted-foreground">
            Settings configured here are preserved in this browser. In a commercial production
            deployment, these policies are stored in an isolated multi-tenant PostgreSQL database.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Company Profile Panel */}
        <Panel title="Company Profile">
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="company-name">Company legal name</Label>
              <Input
                id="company-name"
                value={f.companyName}
                onChange={(e) => setF({ ...f, companyName: e.target.value })}
                aria-invalid={!!errors["companyName"]}
              />
              {errors["companyName"] && (
                <p className="text-xs text-destructive">{errors["companyName"]}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="company-email">Primary administrator email</Label>
              <Input
                id="company-email"
                type="email"
                value={f.companyEmail}
                onChange={(e) => setF({ ...f, companyEmail: e.target.value })}
                aria-invalid={!!errors["companyEmail"]}
              />
              {errors["companyEmail"] && (
                <p className="text-xs text-destructive">{errors["companyEmail"]}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="country">Headquarters country</Label>
                <Input
                  id="country"
                  value={f.country}
                  onChange={(e) => setF({ ...f, country: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Time zone</Label>
                <Select value={f.timezone} onValueChange={(v) => setF({ ...f, timezone: v })}>
                  <SelectTrigger aria-label="Time zone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      "Asia/Kolkata",
                      "Asia/Singapore",
                      "Asia/Dubai",
                      "Europe/London",
                      "America/New_York",
                      "America/Los_Angeles",
                      "Australia/Sydney",
                    ].map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dt">Daily target hours</Label>
                <Input
                  id="dt"
                  type="number"
                  inputMode="decimal"
                  value={f.dailyTarget}
                  onChange={(e) => setF({ ...f, dailyTarget: e.target.value })}
                />
                {errors["dailyTarget"] && (
                  <p className="text-xs text-destructive">{errors["dailyTarget"]}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Standard weekly capacity</Label>
                <div className="h-9 flex items-center px-3 rounded-md border bg-muted/30 text-xs font-semibold tabular">
                  {(Number(f.dailyTarget) || 8) * 5} hours / week
                </div>
              </div>
            </div>

            <Button type="submit">Save company profile</Button>
          </form>
        </Panel>

        {/* Timesheet & Formatting Preferences */}
        <div className="space-y-6">
          <Panel title="Timesheet & Submission Policies">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 border-b pb-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Lock approved timesheets</p>
                  <p className="text-xs text-muted-foreground">
                    Prevent any modification once a manager grants approval.
                  </p>
                </div>
                <Switch
                  checked={f.lockApproved ?? true}
                  onCheckedChange={(v) => {
                    setF({ ...f, lockApproved: v });
                    updateSettings({ lockApproved: v });
                    addAuditLog({
                      actorId: me.id,
                      actorName: me.name,
                      action: "Settings Updated",
                      category: "settings",
                      details: `Updated policy: Lock approved timesheets set to ${v ? "enabled" : "disabled"}`,
                    });
                    toast.success("Policy updated");
                  }}
                />
              </div>

              <div className="flex items-center justify-between gap-3 border-b pb-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Mandatory rejection justification
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Require managers to provide actionable comments when returning timesheets.
                  </p>
                </div>
                <Switch
                  checked={f.requireRejectReason ?? true}
                  onCheckedChange={(v) => {
                    setF({ ...f, requireRejectReason: v });
                    updateSettings({ requireRejectReason: v });
                    addAuditLog({
                      actorId: me.id,
                      actorName: me.name,
                      action: "Settings Updated",
                      category: "settings",
                      details: `Updated policy: Mandatory rejection justification set to ${v ? "enabled" : "disabled"}`,
                    });
                    toast.success("Policy updated");
                  }}
                />
              </div>

              <div className="flex items-center justify-between gap-3 border-b pb-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Time Increment Step</p>
                  <p className="text-xs text-muted-foreground">
                    15-minute standard rounding (0.25h)
                  </p>
                </div>
                <span className="rounded-md bg-secondary px-2.5 py-1 text-xs font-bold text-primary">
                  15 min (0.25h)
                </span>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Week start day</p>
                  <p className="text-xs text-muted-foreground">Standard delivery calendar</p>
                </div>
                <span className="rounded-md bg-secondary px-2.5 py-1 text-xs font-bold text-foreground">
                  Monday
                </span>
              </div>
            </div>
          </Panel>

          <Panel title="Display & Regional Formatting">
            <div className="space-y-4">
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase">
                  Time format
                </Label>
                <RadioGroup
                  value={settings.timeFormat}
                  onValueChange={(v) => {
                    updateSettings({ timeFormat: v as "decimal" | "hhmm" });
                    addAuditLog({
                      actorId: me.id,
                      actorName: me.name,
                      action: "Settings Updated",
                      category: "settings",
                      details: `Updated workspace time display format to ${v}`,
                    });
                    toast.success("Time display format updated");
                  }}
                  className="mt-2 grid grid-cols-2 gap-3"
                >
                  <label className="flex items-center gap-2.5 rounded-xl border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
                    <RadioGroupItem value="decimal" />
                    <div>
                      <p className="text-sm font-semibold">Decimal (7.5h)</p>
                      <p className="text-xs text-muted-foreground">Standard for invoicing</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-2.5 rounded-xl border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
                    <RadioGroupItem value="hhmm" />
                    <div>
                      <p className="text-sm font-semibold">Clock (7:30)</p>
                      <p className="text-xs text-muted-foreground">Hours and minutes</p>
                    </div>
                  </label>
                </RadioGroup>
              </div>

              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase">
                  Billing Currency
                </Label>
                <RadioGroup
                  value={settings.currency}
                  onValueChange={(v) => {
                    updateSettings({ currency: v as "INR" | "USD" });
                    addAuditLog({
                      actorId: me.id,
                      actorName: me.name,
                      action: "Settings Updated",
                      category: "settings",
                      details: `Updated workspace billing currency to ${v}`,
                    });
                    toast.success("Currency updated");
                  }}
                  className="mt-2 grid grid-cols-2 gap-3"
                >
                  <label className="flex items-center gap-2.5 rounded-xl border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
                    <RadioGroupItem value="INR" />
                    <div>
                      <p className="text-sm font-semibold">INR (₹)</p>
                      <p className="text-xs text-muted-foreground">Indian Rupee</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-2.5 rounded-xl border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
                    <RadioGroupItem value="USD" />
                    <div>
                      <p className="text-sm font-semibold">USD ($)</p>
                      <p className="text-xs text-muted-foreground">US Dollar</p>
                    </div>
                  </label>
                </RadioGroup>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* Role Permissions Matrix */}
      <Panel title="Role Permissions Matrix">
        <p className="text-xs text-muted-foreground mb-4">
          Hierarchical access rights across workspace modules. In Phase 3, these rights are enforced
          server-side via JWT auth and PostgreSQL row-level security.
        </p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-xs">
            <thead className="bg-muted/60 text-muted-foreground font-semibold">
              <tr>
                <th className="px-4 py-2.5 text-left">Module / Feature</th>
                <th className="px-4 py-2.5 text-center">Business Admin</th>
                <th className="px-4 py-2.5 text-center">Project Manager</th>
                <th className="px-4 py-2.5 text-center">Employee</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[
                ["Log Personal Timesheets", "Full Access", "Full Access", "Full Access"],
                ["Review & Approve Team Timesheets", "Full Access", "Team Projects", "No Access"],
                ["Manage Client Accounts", "Full Access", "View Only", "No Access"],
                ["Create & Edit Projects", "Full Access", "Assigned Only", "No Access"],
                ["Company Utilization Reports", "Full Access", "No Access", "No Access"],
                ["Team Directory & Invitations", "Full Access", "View Only", "View Only"],
                ["Workspace Settings & Policies", "Full Access", "No Access", "No Access"],
              ].map(([feature, admin, mgr, emp]) => (
                <tr key={feature} className="hover:bg-muted/20">
                  <td className="px-4 py-2.5 font-medium text-foreground">{feature}</td>
                  <td className="px-4 py-2.5 text-center text-primary font-semibold">{admin}</td>
                  <td className="px-4 py-2.5 text-center font-medium">{mgr}</td>
                  <td className="px-4 py-2.5 text-center text-muted-foreground">{emp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
