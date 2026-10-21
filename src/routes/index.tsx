import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ArrowRight, BarChart3, CheckCircle2, CheckSquare, Clock, Download, Briefcase, Info, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Logo } from "@/components/app/common";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Aurelia TimeFlow — Timesheets & billable hours for IT services teams" },
      { name: "description", content: "Simple weekly timesheets, manager approvals, project tracking and billable-hours reporting for IT services firms and agencies." },
      { property: "og:title", content: "Aurelia TimeFlow — Timesheets & billable hours" },
      { property: "og:description", content: "Weekly timesheets, approvals and utilization reporting for IT services companies, consultancies and agencies." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const features = [
  { icon: Clock, title: "Weekly timesheets", text: "A Monday–Sunday grid by client, project and task. Billable flags, notes and validation built in." },
  { icon: CheckSquare, title: "Manager approvals", text: "Review submitted weeks, approve in one click or return with a comment." },
  { icon: Briefcase, title: "Projects & clients", text: "Budgeted vs logged hours, project managers and billable rates in one place." },
  { icon: BarChart3, title: "Utilization reports", text: "Billable vs non-billable by project, client or employee — export to CSV." },
];

const plans = [
  { name: "Starter pilot", price: "₹3,000", per: "/month", text: "For small teams validating a time-tracking process.", items: ["Weekly timesheets", "Approvals workflow", "Projects & clients", "CSV export"] },
  { name: "Team pilot", price: "₹6,000", per: "/month", text: "For growing delivery teams with multiple managers.", items: ["Everything in Starter", "Utilization reporting", "Multiple approvers", "Onboarding support"], featured: true },
  { name: "Custom setup", price: "Quoted", per: "separately", text: "Data migration, configuration or integrations.", items: ["Scoped with your team", "Fixed-price quote", "Optional training"] },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav aria-label="Sections" className="ml-auto hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#pricing" className="hover:text-foreground">Pilot pricing</a>
            <a href="#contact" className="hover:text-foreground">Contact</a>
          </nav>
          <Button asChild variant="outline" size="sm" className="ml-auto md:ml-0"><Link to="/login">Open demo</Link></Button>
        </div>
      </header>

      <section className="bg-hero">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-teal/30 bg-teal-soft px-3 py-1 text-xs font-semibold text-accent-foreground">For IT services firms, consultancies & agencies</p>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] text-foreground sm:text-5xl lg:text-[3.4rem]">
              Every billable hour, <span className="text-primary">captured and approved.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted-foreground">Aurelia TimeFlow makes weekly time entry, manager approvals and utilization reporting simple — so delivery leads spend less time chasing timesheets.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg"><a href="#contact">Book a demo <ArrowRight /></a></Button>
              <Button asChild size="lg" variant="outline"><Link to="/login">Explore the demo workspace</Link></Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">No sign-up needed. The demo uses fictional sample data.</p>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <h2 className="text-3xl font-bold">Focused on the workflow that drives revenue</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">Log time → approve → report. Nothing your team has to learn twice.</p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border bg-card p-6 shadow-card">
              <span className="grid size-10 place-items-center rounded-lg bg-secondary text-primary"><f.icon className="size-5" /></span>
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="scroll-mt-20 border-y bg-card">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <span className="rounded-full bg-warning/15 px-3 py-1 text-xs font-semibold text-warning-foreground">Pilot pricing</span>
          <h2 className="mt-3 text-3xl font-bold">Simple pilot plans</h2>
          <p className="mt-2 text-muted-foreground">Introductory pricing for early pilot customers. Taxes extra where applicable.</p>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {plans.map((p) => (
              <div key={p.name} className={p.featured ? "rounded-2xl bg-navy-gradient p-7 text-navy-foreground shadow-elevated" : "rounded-2xl border bg-background p-7"}>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="mt-3"><span className="text-4xl font-extrabold">{p.price}</span> <span className={p.featured ? "text-navy-foreground/70" : "text-muted-foreground"}>{p.per}</span></p>
                <p className={`mt-2 text-sm ${p.featured ? "text-navy-foreground/80" : "text-muted-foreground"}`}>{p.text}</p>
                <ul className="mt-5 space-y-2 text-sm">
                  {p.items.map((i) => <li key={i} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-teal" /> {i}</li>)}
                </ul>
                <Button asChild className="mt-6 w-full" variant={p.featured ? "secondary" : "outline"}><a href="#contact">Book a demo</a></Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="contact" className="mx-auto grid max-w-6xl scroll-mt-20 gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2">
        <div>
          <h2 className="text-3xl font-bold">Book a demo</h2>
          <p className="mt-2 text-muted-foreground">Tell us about your team and we'll walk you through TimeFlow with your workflow in mind.</p>
          <ul className="mt-6 space-y-3 text-sm">
            {["30-minute guided walkthrough", "Discuss pilot fit and setup needs", "No obligation"].map((t) => <li key={t} className="flex gap-2"><CheckCircle2 className="size-4 text-teal" /> {t}</li>)}
          </ul>
        </div>
        <ContactForm />
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo />
          <p>© {new Date().getFullYear()} Aurelia Business Services. Prototype — not yet a production service.</p>
        </div>
      </footer>
    </div>
  );
}

function ProductPreview() {
  const bars = [62, 74, 58, 81, 70, 88];
  return (
    <div className="relative rounded-2xl border bg-card p-5 shadow-elevated" aria-hidden>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Team hours · last 6 weeks</p>
        <span className="rounded-full bg-teal-soft px-2.5 py-0.5 text-xs font-medium text-accent-foreground">Demo</span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {[["Hours this week", "214"], ["Pending approvals", "4"], ["Utilization", "82%"]].map(([l, v]) => (
          <div key={l} className="rounded-lg bg-muted p-3"><p className="text-[0.65rem] text-muted-foreground">{l}</p><p className="text-xl font-bold tabular">{v}</p></div>
        ))}
      </div>
      <div className="mt-5 flex h-36 items-end gap-3 border-b pb-1">
        {bars.map((b, i) => (
          <div key={i} className="flex flex-1 flex-col justify-end overflow-hidden rounded-t-md" style={{ height: `${b}%` }}>
            <div className="bg-teal" style={{ height: "22%" }} /><div className="flex-1 bg-primary" />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {[["Arjun M.", "40.5h", "Submitted"], ["Kavya N.", "38h", "Approved"]].map(([n, h, st]) => (
          <div key={n} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
            <span className="font-medium">{n}</span><span className="tabular text-muted-foreground">{h}</span>
            <span className={st === "Approved" ? "text-xs font-medium text-success" : "text-xs font-medium text-warning-foreground"}>{st}</span>
          </div>
        ))}
      </div>
      <div className="absolute -bottom-4 -left-4 hidden items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs font-medium shadow-card sm:flex"><Download className="size-3.5 text-primary" /> CSV export ready</div>
    </div>
  );
}

const contactSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(100),
  email: z.string().trim().email("Enter a valid work email").max(255),
  company: z.string().trim().min(2, "Company name is required").max(100),
  teamSize: z.string().trim().max(20).optional(),
  message: z.string().trim().max(1000, "Keep it under 1000 characters").optional(),
});

function ContactForm() {
  const [f, setF] = useState({ name: "", email: "", company: "", teamSize: "", message: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = contactSchema.safeParse(f);
    if (!r.success) return setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path[0], i.message])));
    setErrors({});
    setDone(true);
  };
  if (done)
    return (
      <div className="rounded-2xl border bg-card p-8 shadow-card" role="status">
        <CheckCircle2 className="size-8 text-success" />
        <h3 className="mt-3 text-xl font-semibold">Thanks, {f.name.split(" ")[0]} — form validated</h3>
        <div className="mt-3 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p><strong>Demo only:</strong> this prototype does not send or store contact requests, so no message was delivered. Please reach Aurelia Business Services directly to book a demo.</p>
        </div>
        <Button variant="outline" className="mt-5" onClick={() => { setDone(false); setF({ name: "", email: "", company: "", teamSize: "", message: "" }); }}>Submit another</Button>
      </div>
    );
  const field = (k: "name" | "email" | "company" | "teamSize", label: string, type = "text") => (
    <div className="space-y-1.5">
      <Label htmlFor={`ct-${k}`}>{label}</Label>
      <Input id={`ct-${k}`} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={!!errors[k]} aria-describedby={errors[k] ? `ct-${k}-err` : undefined} />
      {errors[k] && <p id={`ct-${k}-err`} className="text-xs text-destructive">{errors[k]}</p>}
    </div>
  );
  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border bg-card p-6 shadow-card sm:p-8">
      <div className="grid gap-4 sm:grid-cols-2">{field("name", "Full name")}{field("email", "Work email", "email")}</div>
      <div className="grid gap-4 sm:grid-cols-2">{field("company", "Company")}{field("teamSize", "Team size (optional)")}</div>
      <div className="space-y-1.5">
        <Label htmlFor="ct-message">What would you like to see? (optional)</Label>
        <Textarea id="ct-message" rows={4} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} aria-invalid={!!errors["message"]} />
        {errors["message"] && <p className="text-xs text-destructive">{errors["message"]}</p>}
      </div>
      <Button type="submit" size="lg" className="w-full">Request demo</Button>
      <p className="text-center text-xs text-muted-foreground">Prototype form — submissions are not sent anywhere.</p>
    </form>
  );
}
