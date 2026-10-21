import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Briefcase, Building2, CheckSquare, Clock, LayoutDashboard, Menu, RotateCcw, Settings, Users, FlaskConical, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Initials, Logo } from "./common";
import { endDemoSession, resetDemo, useDemo, useMe } from "@/lib/demo-store";
import { canAccess, ROLE_LABEL, type Page } from "@/lib/rules";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/app", label: "Overview", icon: LayoutDashboard },
  { to: "/app/timesheet", label: "My Timesheet", icon: Clock },
  { to: "/app/approvals", label: "Approvals", icon: CheckSquare },
  { to: "/app/projects", label: "Projects", icon: Briefcase },
  { to: "/app/clients", label: "Clients", icon: Building2 },
  { to: "/app/reports", label: "Reports", icon: BarChart3 },
  { to: "/app/team", label: "Team", icon: Users },
  { to: "/app/settings", label: "Settings", icon: Settings },
] as const;

function NavList({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const path = useRouterState({ select: (r) => r.location.pathname });
  const pending = useDemo((s) => s.timesheets.filter((t) => t.status === "submitted").length);
  const me = useMe();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {nav.filter((n) => canAccess(me.role, (n.to.replace(/^\/app\/?/, "") || "overview") as Page)).map((n) => {
        const active = n.to === "/app" ? path === "/app" || path === "/app/" : path.startsWith(n.to);
        return (
          <Link key={n.to} to={n.to} onClick={onNavigate} aria-current={active ? "page" : undefined}
            className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground")}>
            <n.icon className={cn("size-4.5", active && "text-sidebar-primary")} aria-hidden />
            <span className="flex-1">{n.label}</span>
            {n.label === "Approvals" && pending > 0 && (
              <span className="rounded-full bg-sidebar-primary px-2 py-0.5 text-[0.7rem] font-bold text-sidebar-primary-foreground">{pending}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return (
    <div className="flex h-full flex-col gap-6 bg-sidebar p-4">
      <div className="px-1 pt-1"><Logo inverted /></div>
      <NavList onNavigate={onNavigate} />
      <div className="mt-auto rounded-lg border border-sidebar-border bg-sidebar-accent/50 p-3 text-xs text-sidebar-foreground">
        <p className="flex items-center gap-1.5 font-semibold text-sidebar-accent-foreground"><FlaskConical className="size-3.5 text-sidebar-primary" aria-hidden /> Demo workspace</p>
        <p className="mt-1 leading-relaxed">Fictional sample data, stored only in this browser.</p>
        <Link to="/" className="mt-2 inline-flex items-center gap-1 text-sidebar-primary hover:underline">Product site <ArrowUpRight className="size-3" /></Link>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const me = useMe();
  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 lg:block"><SidebarBody /></aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 border-0 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation"><Menu /></Button>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal-soft px-3 py-1 text-xs font-semibold text-accent-foreground">
            <span className="size-1.5 rounded-full bg-teal" aria-hidden /> Demo workspace
          </span>
          <span className="hidden text-xs text-muted-foreground md:inline">Sample data only — not connected to real customers</span>
          <div className="ml-auto flex items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm"><RotateCcw className="size-3.5" /> <span className="hidden sm:inline">Reset demo data</span></Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset demo data?</AlertDialogTitle>
                  <AlertDialogDescription>All changes you made in this browser (timesheets, approvals, projects, clients, settings) will be replaced with fresh sample data.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => { resetDemo(); toast.success("Demo data reset"); }}>Reset</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {me && (
              <div className="flex items-center gap-2 border-l pl-3">
                <Initials name={me.name} />
                <div className="hidden leading-tight sm:block">
                  <p className="text-sm font-semibold">{me.name}</p>
                  <p className="text-xs text-muted-foreground">{ROLE_LABEL[me.role]} · demo persona</p>
                </div>
                <Button asChild variant="ghost" size="sm"><Link to="/login">Switch demo role</Link></Button>
                <Button variant="ghost" size="sm" onClick={() => endDemoSession()}>Exit</Button>
              </div>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
