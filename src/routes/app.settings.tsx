import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel } from "@/components/app/common";
import { getState, updateSettings, useDemo } from "@/lib/demo-store";
import { formatHours } from "@/lib/time";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/app/settings")({
  head: () => pageHead("Settings", "Company profile, week start, time display and currency."),
  component: SettingsPage,
});

const schema = z.object({
  companyName: z.string().trim().min(2, "Company name is required").max(100),
  companyEmail: z.string().trim().email("Enter a valid email").max(255),
  country: z.string().trim().min(2, "Country is required").max(60),
  dailyTarget: z.coerce.number().min(1, "1–24 hours").max(24, "1–24 hours"),
});

function SettingsPage() {
  const settings = useDemo((s) => s.settings);
  const [f, setF] = useState(() => ({ ...getState().settings, dailyTarget: String(getState().settings.dailyTarget) }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const r = schema.safeParse(f);
    if (!r.success) return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    setErrors({});
    updateSettings({ ...r.data, timezone: f.timezone });
    toast.success("Company profile saved");
  };

  return (
    <>
      <PageHeader title="Settings" description="Workspace preferences for this demo." />
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-teal/30 bg-teal-soft p-4 text-sm text-accent-foreground">
        <FlaskConical className="size-5 shrink-0" />
        <p><strong>Demo mode is on.</strong> Data lives only in this browser. There is no login, no server storage and no email sending yet.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Company profile">
          <form onSubmit={save} className="space-y-3" noValidate>
            {(["companyName", "companyEmail", "country"] as const).map((k) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={k}>{{ companyName: "Company name", companyEmail: "Billing / admin email", country: "Country" }[k]}</Label>
                <Input id={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={!!errors[k]} />
                {errors[k] && <p className="text-xs text-destructive">{errors[k]}</p>}
              </div>
            ))}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Time zone</Label>
                <Select value={f.timezone} onValueChange={(v) => setF({ ...f, timezone: v })}><SelectTrigger aria-label="Time zone"><SelectValue /></SelectTrigger>
                  <SelectContent>{["Asia/Kolkata", "Asia/Singapore", "Asia/Dubai", "Europe/London", "America/New_York", "Australia/Sydney"].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label htmlFor="dt">Daily target hours</Label><Input id="dt" inputMode="decimal" value={f.dailyTarget} onChange={(e) => setF({ ...f, dailyTarget: e.target.value })} />{errors["dailyTarget"] && <p className="text-xs text-destructive">{errors["dailyTarget"]}</p>}</div>
            </div>
            <Button type="submit">Save profile</Button>
          </form>
        </Panel>

        <div className="space-y-6">
          <Panel title="Timesheet preferences">
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-sm font-medium">Week starts on</p><p className="text-xs text-muted-foreground">Timesheets run Monday → Sunday.</p></div>
                <span className="rounded-md bg-secondary px-3 py-1.5 text-sm font-semibold text-secondary-foreground">Monday</span>
              </div>
              <fieldset>
                <legend className="text-sm font-medium">Time display</legend>
                <RadioGroup value={settings.timeFormat} onValueChange={(v) => { updateSettings({ timeFormat: v as "decimal" | "hhmm" }); toast.success("Time display updated"); }} className="mt-2 grid grid-cols-2 gap-2">
                  {(["decimal", "hhmm"] as const).map((v) => (
                    <Label key={v} htmlFor={`tf-${v}`} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-secondary">
                      <RadioGroupItem id={`tf-${v}`} value={v} />
                      <span>{v === "decimal" ? "Decimal" : "Hours:minutes"} <span className="text-muted-foreground">({formatHours(7.5, v)})</span></span>
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
            </div>
          </Panel>
          <Panel title="Currency">
            <RadioGroup value={settings.currency} onValueChange={(v) => { updateSettings({ currency: v as "INR" | "USD" }); toast.success(`Currency set to ${v}`); }} className="grid grid-cols-2 gap-2">
              {(["INR", "USD"] as const).map((v) => (
                <Label key={v} htmlFor={`cur-${v}`} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-secondary">
                  <RadioGroupItem id={`cur-${v}`} value={v} />
                  <span>{v === "INR" ? "₹ Indian Rupee" : "$ US Dollar"}</span>
                </Label>
              ))}
            </RadioGroup>
            <p className="mt-3 text-xs text-muted-foreground">Changes the display symbol for rates and billable value. Demo rates are not converted.</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
