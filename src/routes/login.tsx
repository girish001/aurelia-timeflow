import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Building2, FolderKanban, User, ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/app/common";
import { startDemoSession, useDemo, useSessionId, type Member, type Role } from "@/lib/demo-store";
import { ROLE_LABEL } from "@/lib/rules";
import { pageHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

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
  icon: typeof User;
  description: string;
}

const roleConfigs: RoleConfig[] = [
  {
    role: "Admin",
    title: "Business Admin",
    icon: Building2,
    description:
      "Full organizational governance, client billing, project budgets, utilization reporting and workspace settings.",
  },
  {
    role: "Manager",
    title: "Project Manager",
    icon: FolderKanban,
    description:
      "Project delivery, team resource allocation, capacity planning and timesheet & leave approvals.",
  },
  {
    role: "Employee",
    title: "Employee",
    icon: User,
    description:
      "Weekly timesheet logging, task tracking, personal leave requests and assigned project schedules.",
  },
];

export function DemoLogin() {
  const allMembers = useDemo((s) => s.members);
  const members = useMemo(() => allMembers.filter((m) => m.status === "active"), [allMembers]);
  const current = useSessionId();
  const navigate = useNavigate();

  const [selectedRole, setSelectedRole] = useState<Role | null>(null);

  const getActiveMemberForRole = (role: Role): Member | undefined => {
    const roleMembers = members.filter((m) => m.role === role);
    if (current) {
      const currentInRole = roleMembers.find((m) => m.id === current);
      if (currentInRole) return currentInRole;
    }
    return roleMembers[0];
  };

  const selectedMember = selectedRole ? getActiveMemberForRole(selectedRole) : undefined;
  const canContinue = Boolean(selectedRole && selectedMember);

  const handleContinue = () => {
    if (!selectedRole || !selectedMember) return;
    startDemoSession(selectedMember.id);
    void navigate({ to: "/app" });
  };

  return (
    <div className="min-h-screen bg-hero text-foreground flex flex-col">
      {/* Top Navigation */}
      <header className="sticky top-0 z-30 border-b bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <Logo />
          </Link>
          <div className="flex items-center gap-4">
            <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
              Interactive Demo Environment
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

      {/* Main Content */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 py-8 sm:px-6 sm:py-12">
        {/* Compact Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
            Demo role preview
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Choose a workspace role below to launch Aurelia TimeFlow with pre-populated enterprise
            data. You can switch roles at any time from the application header.
          </p>
        </div>

        {/* Unified Main Bordered Role-Selection Panel */}
        <section
          aria-label="Select a demo role"
          className="rounded-2xl border bg-card p-5 shadow-card sm:p-7"
        >
          <div className="mb-5 flex flex-col justify-between gap-2 border-b pb-4 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-semibold text-foreground">Select your workspace role</p>
              <p className="text-xs text-muted-foreground">
                Each role tailors navigation, approval permissions and financial visibility.
              </p>
            </div>
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 text-primary shrink-0" aria-hidden />
              <span>No password required · In-browser sandbox</span>
            </div>
          </div>

          {/* 3 Horizontal Role Cards on Desktop/Tablet, Stacked on Mobile */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {roleConfigs.map((r) => {
              const isSelected = selectedRole === r.role;

              return (
                <button
                  key={r.role}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedRole(r.role)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedRole(r.role);
                    }
                  }}
                  className={cn(
                    "group flex flex-col justify-start rounded-xl border p-5 text-left transition-all duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    isSelected
                      ? "border-primary bg-primary/[0.06] ring-2 ring-primary/20 shadow-sm"
                      : "border-border bg-background/60 hover:border-primary/40 hover:bg-muted/30",
                  )}
                >
                  <span className="flex w-full items-start justify-between gap-3">
                    <span
                      className={cn(
                        "grid size-10 place-items-center rounded-lg transition-colors",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-primary group-hover:bg-primary/15",
                      )}
                    >
                      <r.icon className="size-5" aria-hidden />
                    </span>
                    <span
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/30 bg-background group-hover:border-primary/50",
                      )}
                      aria-hidden
                    >
                      {isSelected && <CheckCircle2 className="size-3.5" />}
                    </span>
                  </span>

                  <span
                    id={`role-${r.role}`}
                    role="heading"
                    aria-level={2}
                    className="mt-4 block text-base font-bold tracking-tight text-foreground"
                  >
                    {r.title}
                  </span>
                  <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                    {r.description}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Action Footer with Prominent Continue to Demo Button */}
          <div className="mt-6 flex flex-col items-stretch justify-between gap-4 border-t pt-5 sm:flex-row sm:items-center">
            <div className="text-xs text-muted-foreground">
              {selectedRole ? (
                <span>
                  Selected role:{" "}
                  <strong className="font-semibold text-foreground">
                    {ROLE_LABEL[selectedRole]}
                  </strong>
                </span>
              ) : (
                <span>Select one of the three roles above to continue to the workspace.</span>
              )}
            </div>

            <Button
              type="button"
              size="lg"
              disabled={!canContinue}
              onClick={handleContinue}
              className="sm:min-w-52 font-semibold"
            >
              <span>Continue to Demo</span>
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </div>
        </section>

        {/* Compact Footer */}
        <footer className="mt-6 flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground sm:flex-row">
          <p>
            Aurelia TimeFlow © {new Date().getFullYear()} Aurelia Business Services. All demo
            records are fictional.
          </p>
          <Link to="/" className="hover:text-foreground hover:underline">
            Product Overview
          </Link>
        </footer>
      </main>
    </div>
  );
}
