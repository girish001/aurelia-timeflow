import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ShieldAlert,
  Building2,
  FolderKanban,
  User,
  ArrowRight,
  CheckCircle2,
  Sparkles,
  Layers,
  Clock,
  Briefcase,
  Users,
  BarChart3,
  Sliders,
  CheckSquare,
  Calendar,
  Award,
} from "lucide-react";
import { Initials, Logo } from "@/components/app/common";
import { startDemoSession, useDemo, useSessionId, type Role } from "@/lib/demo-store";
import { ROLE_LABEL } from "@/lib/rules";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () =>
    pageHead(
      "Demo role preview",
      "Preview Aurelia TimeFlow as an Admin, Project Manager or Employee. Professional time tracking and resource management SaaS.",
    ),
  component: DemoLogin,
});

interface RoleConfig {
  role: Role;
  title: string;
  badge: string;
  icon: typeof User;
  tagline: string;
  highlights: string[];
}

const roleConfigs: RoleConfig[] = [
  {
    role: "Admin",
    title: "Business Admin",
    badge: "Executive & Ops",
    icon: Building2,
    tagline: "Total organizational governance, client billing, capacity and financial reports.",
    highlights: [
      "Company overview",
      "Employee management",
      "Client management",
      "Project management",
      "Reports",
      "Settings",
    ],
  },
  {
    role: "Manager",
    title: "Project Manager",
    badge: "Delivery & Leads",
    icon: FolderKanban,
    tagline: "Project delivery, resource allocation, team capacity and timesheet approvals.",
    highlights: [
      "Team overview",
      "Managed projects",
      "Timesheet approvals",
      "Resource allocation",
      "Team performance",
    ],
  },
  {
    role: "Employee",
    title: "Employee",
    badge: "Consultants & Devs",
    icon: User,
    tagline: "Effortless weekly time-logging, task updates, leaves and project visibility.",
    highlights: [
      "My timesheets",
      "Submit weekly hours",
      "My projects",
      "Leave requests",
      "Personal profile",
    ],
  },
];

export function DemoLogin() {
  const allMembers = useDemo((s) => s.members);
  const members = useMemo(() => allMembers.filter((m) => m.status === "active"), [allMembers]);
  const current = useSessionId();
  const navigate = useNavigate();
  const [selectedRoleTab, setSelectedRoleTab] = useState<Role | "all">("all");

  const choose = (id: string) => {
    startDemoSession(id);
    void navigate({ to: "/app" });
  };

  return (
    <div className="min-h-screen bg-hero text-foreground">
      {/* Top Navigation */}
      <header className="sticky top-0 z-30 border-b bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 group">
            <Logo />
          </Link>
          <div className="flex items-center gap-4">
            <span className="hidden items-center gap-1.5 rounded-full border border-teal/30 bg-teal-soft px-3 py-1 text-xs font-semibold text-accent-foreground sm:inline-flex">
              <span className="size-1.5 rounded-full bg-teal animate-pulse" aria-hidden />
              Demo Environment
            </span>
            <Link
              to="/"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to product site
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
        <div className="text-center sm:text-left">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3.5 py-1 text-xs font-medium text-primary">
            <Sparkles className="size-3.5" />
            <span>Interactive SaaS Sandbox</span>
          </div>

          <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl lg:text-5xl">
            Demo role preview
          </h1>
          <p className="mt-2 text-lg font-medium text-primary sm:text-xl">
            Work smarter. Track better. Deliver more.
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Select a role persona below to experience Aurelia TimeFlow with role-specific views,
            real-time approvals, billable rates and capacity planning. Switch personas anytime
            without losing state.
          </p>
        </div>

        {/* Security / Demo Banner */}
        <div
          role="note"
          className="mt-6 flex flex-col gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground sm:flex-row sm:items-center"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/20">
            <ShieldAlert className="size-5" />
          </div>
          <div className="space-y-0.5">
            <p className="font-semibold text-foreground">
              Demo Workspace Notice — No Authentication Required
            </p>
            <p className="text-xs sm:text-sm text-muted-foreground">
              This sandbox uses in-browser memory with fictional company personas. No passwords,
              email verification or external credentials are required. Role selections tailor the
              user interface to showcase respective enterprise workflows.
            </p>
          </div>
        </div>

        {/* Role Cards Grid */}
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {roleConfigs.map((r) => {
            const roleMembers = members.filter((m) => m.role === r.role);
            return (
              <section
                key={r.role}
                aria-labelledby={`role-${r.role}`}
                className="flex flex-col justify-between rounded-2xl border bg-card p-6 shadow-card transition-all duration-200 hover:shadow-elevated hover:border-primary/40 relative overflow-hidden group"
              >
                <div className="absolute top-0 right-0 h-24 w-24 bg-gradient-to-br from-primary/10 to-teal/10 rounded-bl-full pointer-events-none" />

                <div>
                  <div className="flex items-center justify-between">
                    <span className="grid size-12 place-items-center rounded-xl bg-secondary text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors duration-200">
                      <r.icon className="size-6" />
                    </span>
                    <span className="rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                      {r.badge}
                    </span>
                  </div>

                  <h2 id={`role-${r.role}`} className="mt-4 text-xl font-bold tracking-tight">
                    {r.title}
                  </h2>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {r.tagline}
                  </p>

                  {/* Highlights Bullet List */}
                  <div className="mt-4 rounded-xl border border-border/60 bg-muted/40 p-3.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Included Capabilities
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {r.highlights.map((item) => (
                        <li key={item} className="flex items-center gap-2 text-xs font-medium">
                          <CheckCircle2 className="size-3.5 text-primary shrink-0" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Available Personas List */}
                <div className="mt-6 pt-4 border-t">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Available Demo Personas ({roleMembers.length})
                  </p>
                  <ul className="mt-2.5 space-y-2">
                    {roleMembers.map((m) => {
                      const isCurrent = m.id === current;
                      return (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => choose(m.id)}
                            className="flex w-full items-center gap-3 rounded-xl border border-input/70 bg-background p-2.5 text-left transition-all hover:border-primary hover:bg-secondary/70 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring group/btn"
                          >
                            <Initials name={m.name} className="size-8.5 font-bold" />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold text-foreground group-hover/btn:text-primary transition-colors">
                                {m.name}
                                {isCurrent && (
                                  <span className="ml-1.5 inline-flex items-center rounded-md bg-teal-soft px-1.5 py-0.2 text-[10px] font-semibold text-accent-foreground">
                                    Current
                                  </span>
                                )}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {m.title}
                              </span>
                            </span>
                            <span className="flex items-center gap-1 text-xs font-semibold text-primary opacity-80 group-hover/btn:opacity-100">
                              <span>Select</span>
                              <ArrowRight className="size-3.5" aria-hidden />
                            </span>
                            <span className="sr-only">
                              Preview as {m.name}, {ROLE_LABEL[r.role]}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            );
          })}
        </div>

        {/* Live Preview Teaser Illustration */}
        <section className="mt-12 rounded-2xl border bg-gradient-navy p-6 sm:p-8 text-navy-foreground shadow-elevated">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="space-y-2 text-center md:text-left">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sidebar-primary/20 px-3 py-1 text-xs font-semibold text-sidebar-primary">
                <Award className="size-3.5" /> Enterprise Grade TimeFlow
              </span>
              <h3 className="text-2xl font-bold tracking-tight text-white">
                Engineered for High-Growth IT Services & Consultancies
              </h3>
              <p className="text-sm text-navy-foreground/80 max-w-2xl leading-relaxed">
                Seamless weekly timesheet grid with keyboard shortcuts, multi-level manager
                approvals, client rate cards, real-time billable utilization benchmarks, and instant
                CSV reporting.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 w-full md:w-auto shrink-0">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 text-center backdrop-blur">
                <p className="text-2xl font-extrabold text-white">84.6%</p>
                <p className="text-xs text-navy-foreground/70">Billable Utilization</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 text-center backdrop-blur">
                <p className="text-2xl font-extrabold text-white">100%</p>
                <p className="text-xs text-navy-foreground/70">Client Hours Logged</p>
              </div>
            </div>
          </div>
        </section>

        {/* Footer info */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground border-t pt-6">
          <p>
            Aurelia TimeFlow © {new Date().getFullYear()} by Aurelia Business Services. All personas
            and client records are fictional demo data.
          </p>
          <div className="flex items-center gap-4">
            <Link to="/" className="hover:text-foreground hover:underline">
              Product Overview
            </Link>
            <span>•</span>
            <span className="text-primary font-medium">Demo Workspace Active</span>
          </div>
        </div>
      </main>
    </div>
  );
}
