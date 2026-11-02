import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Building2,
  FolderKanban,
  User,
  ArrowRight,
  CheckCircle2,
  ShieldCheck,
  Lock,
  Mail,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/app/common";
import { isProductionEnvironment, loginWithCredentials } from "@/lib/auth-client";
import { startDemoSession, useDemo, useSessionId, type Member, type Role } from "@/lib/demo-store";
import { ROLE_LABEL } from "@/lib/rules";
import { pageHead } from "@/lib/seo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () =>
    pageHead(
      "Sign In",
      "Sign in to Aurelia TimeFlow enterprise time tracking, billing and resource management.",
    ),
  component: LoginPage,
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

export function LoginPage() {
  const isProd = isProductionEnvironment();
  const [activeTab, setActiveTab] = useState<"signin" | "demo">("signin");

  // Real authentication form state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Demo sandbox state
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
  const canContinueDemo = Boolean(selectedRole && selectedMember);

  const handleRealLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoading(true);

    try {
      await loginWithCredentials(email.trim(), password);
      void navigate({ to: "/app" });
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Sign-in failed. Please verify your email and password.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleContinueDemo = () => {
    if (isProd) {
      setErrorMessage("Demo sessions are strictly prohibited in production.");
      return;
    }
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
            {!isProd && (
              <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
                Development Environment
              </span>
            )}
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
        <div className="mb-6 text-center sm:text-left">
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
            Demo role preview
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Sign in with your enterprise credentials or preview Aurelia TimeFlow with pre-populated
            demo personas.
          </p>
        </div>

        {/* Real Sign In Panel */}
        <section
          aria-label="Sign in"
          className="mb-6 rounded-2xl border bg-card p-6 shadow-card sm:p-7"
        >
          <div className="mb-4 border-b pb-3">
            <h2 className="text-base font-bold text-foreground">Workspace Sign In</h2>
            <p className="text-xs text-muted-foreground">
              Enter your work email and password to connect to your tenant database.
            </p>
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive"
            >
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <p>{errorMessage}</p>
            </div>
          )}

          <form
            onSubmit={handleRealLogin}
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="login-email" className="text-xs font-semibold">
                Work Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  required
                  autoComplete="email"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password" className="text-xs font-semibold">
                  Password
                </Label>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  autoComplete="current-password"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="flex items-end">
              <Button
                type="submit"
                size="lg"
                disabled={isLoading || !email || !password}
                className="w-full font-semibold"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    <span>Signing in…</span>
                  </>
                ) : (
                  <>
                    <span>Sign In to Workspace</span>
                    <ArrowRight className="ml-2 size-4" />
                  </>
                )}
              </Button>
            </div>
          </form>
        </section>

        {/* Development Demo Role Selection Panel */}
        {!isProd && (
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
                <span>No password required · In-browser dev sandbox</span>
              </div>
            </div>

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
                disabled={!canContinueDemo}
                onClick={handleContinueDemo}
                className="sm:min-w-52 font-semibold"
              >
                <span>Continue to Demo</span>
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            </div>
          </section>
        )}

        {/* Compact Footer */}
        <footer className="mt-6 flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground sm:flex-row">
          <p>Aurelia TimeFlow © {new Date().getFullYear()} Aurelia Business Services.</p>
          <Link to="/" className="hover:text-foreground hover:underline">
            Product Overview
          </Link>
        </footer>
      </main>
    </div>
  );
}

export { LoginPage as DemoLogin };
