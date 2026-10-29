import { useState, useMemo, type ReactNode } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  BarChart3,
  Briefcase,
  Building2,
  CheckSquare,
  Clock,
  LayoutDashboard,
  Menu,
  RotateCcw,
  Settings,
  Users,
  FlaskConical,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  Sparkles,
  Shield,
  Layers,
  CalendarDays,
  CalendarRange,
  History,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Initials, Logo } from "./common";
import {
  endDemoSession,
  resetDemo,
  startDemoSession,
  useDemo,
  useMe,
  markAllNotificationsRead,
  markNotificationRead,
  type Role,
} from "@/lib/demo-store";
import {
  canAccess,
  ROLE_LABEL,
  approvableTimesheets,
  canReviewLeave,
  type Page,
} from "@/lib/rules";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  section: "Workspace" | "Operations" | "Insights & Setup";
}

const navItems: NavItem[] = [
  { to: "/app", label: "Overview", icon: LayoutDashboard, section: "Workspace" },
  { to: "/app/timesheet", label: "My Timesheet", icon: Clock, section: "Workspace" },
  { to: "/app/timeoff", label: "Leave Management", icon: CalendarDays, section: "Workspace" },
  { to: "/app/approvals", label: "Approvals", icon: CheckSquare, section: "Operations" },
  { to: "/app/calendar", label: "Resource Planning", icon: CalendarRange, section: "Operations" },
  { to: "/app/projects", label: "Projects", icon: Briefcase, section: "Operations" },
  { to: "/app/clients", label: "Clients", icon: Building2, section: "Operations" },
  { to: "/app/team", label: "Team", icon: Users, section: "Operations" },
  { to: "/app/reports", label: "Reports", icon: BarChart3, section: "Insights & Setup" },
  { to: "/app/audit", label: "Audit Trail", icon: History, section: "Insights & Setup" },
  { to: "/app/settings", label: "Settings", icon: Settings, section: "Insights & Setup" },
];

function NavList({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const path = useRouterState({ select: (r) => r.location.pathname });
  const s = useDemo((x) => x);
  const me = useMe();
  const pendingTimesheets = useMemo(
    () => approvableTimesheets(s, me).filter((t) => t.status === "submitted").length,
    [s, me],
  );
  const pendingLeaves = useMemo(() => {
    if (me.role === "Employee") return 0;
    return s.leaves.filter((l) => l.status === "pending" && canReviewLeave(s, me, l)).length;
  }, [s, me]);

  const sections: ("Workspace" | "Operations" | "Insights & Setup")[] = [
    "Workspace",
    "Operations",
    "Insights & Setup",
  ];

  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {sections.map((section) => {
        const items = navItems.filter(
          (n) =>
            n.section === section &&
            canAccess(me.role, (n.to.replace(/^\/app\/?/, "") || "overview") as Page),
        );
        if (items.length === 0) return null;

        return (
          <div key={section} className="space-y-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
              {section}
            </p>
            <div className="space-y-0.5">
              {items.map((n) => {
                const active =
                  n.to === "/app" ? path === "/app" || path === "/app/" : path.startsWith(n.to);
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs font-semibold"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <n.icon
                      className={cn(
                        "size-4 shrink-0",
                        active ? "text-sidebar-primary" : "opacity-80",
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{n.label}</span>
                    {n.label === "Approvals" && pendingTimesheets + pendingLeaves > 0 && (
                      <span className="rounded-full bg-sidebar-primary px-2 py-0.5 text-[0.7rem] font-bold text-sidebar-primary-foreground">
                        {pendingTimesheets + pendingLeaves}
                      </span>
                    )}
                    {n.label === "Leave Management" && pendingLeaves > 0 && (
                      <span className="rounded-full bg-amber-500/90 px-2 py-0.5 text-[0.7rem] font-bold text-white">
                        {pendingLeaves}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const me = useMe();
  return (
    <div className="flex h-full flex-col justify-between bg-sidebar p-4 text-sidebar-foreground">
      <div className="space-y-6">
        <div className="px-1 pt-1">
          <Logo inverted />
        </div>
        <NavList onNavigate={onNavigate} />
      </div>

      <div className="space-y-3 pt-4 border-t border-sidebar-border">
        {/* Active Persona Indicator */}
        <div className="rounded-lg bg-sidebar-accent/60 p-2.5">
          <div className="flex items-center gap-2.5">
            <Initials name={me.name} className="size-8 text-xs font-bold" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-xs font-semibold text-sidebar-accent-foreground">
                {me.name}
              </p>
              <p className="truncate text-[11px] text-sidebar-foreground/75">
                {ROLE_LABEL[me.role]}
              </p>
            </div>
          </div>
        </div>

        {/* Demo Workspace info */}
        <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-semibold text-sidebar-accent-foreground">
            <FlaskConical className="size-3.5 text-sidebar-primary" aria-hidden /> Demo workspace
          </p>
          <p className="mt-1 text-[11px] text-sidebar-foreground/80 leading-relaxed">
            Fictional sample data stored in browser storage.
          </p>
          <div className="mt-2 flex items-center justify-between text-[11px]">
            <Link
              to="/"
              className="text-sidebar-primary hover:underline inline-flex items-center gap-1"
            >
              Product site <ArrowUpRight className="size-3" />
            </Link>
            <Link to="/login" className="text-sidebar-foreground/90 hover:underline">
              Switch role
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const me = useMe();
  const navigate = useNavigate();
  const rawMembers = useDemo((s) => s.members);
  const allMembers = useMemo(() => rawMembers.filter((m) => m.status === "active"), [rawMembers]);
  const notifications = useDemo((s) => s.notifications);
  const myNotifications = useMemo(
    () => (notifications || []).filter((n) => n.recipientId === "all" || n.recipientId === me.id),
    [notifications, me.id],
  );
  const unreadCount = useMemo(
    () => myNotifications.filter((n) => !n.read).length,
    [myNotifications],
  );

  const handleSwitchPersona = (id: string) => {
    startDemoSession(id);
    toast.success(`Switched role persona to ${allMembers.find((m) => m.id === id)?.name}`);
  };

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 lg:block border-r border-sidebar-border">
        <SidebarBody />
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 border-0 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur-md sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>

          {/* Demo workspace pill (Required by tests and UX) */}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal-soft px-3 py-1 text-xs font-semibold text-accent-foreground">
            <span className="size-1.5 rounded-full bg-teal animate-pulse" aria-hidden /> Demo
            workspace
          </span>

          <span className="hidden text-xs text-muted-foreground md:inline">
            Fictional demo dataset • Enterprise SaaS Preview
          </span>

          <div className="ml-auto flex items-center gap-2">
            {/* Notification Center */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
                  <Bell className="size-4" />
                  {unreadCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 flex size-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-primary" />
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0 shadow-elevated">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">Notifications</p>
                    {unreadCount > 0 && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {unreadCount} new
                      </span>
                    )}
                  </div>
                  {unreadCount > 0 && (
                    <button
                      onClick={() => markAllNotificationsRead(me.id)}
                      className="text-xs text-primary hover:underline font-medium"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                <div className="max-h-72 divide-y overflow-y-auto">
                  {myNotifications.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground">
                      No notifications
                    </p>
                  ) : (
                    myNotifications.map((n) => (
                      <div
                        key={n.id}
                        className={cn(
                          "p-3 text-xs transition-colors hover:bg-muted/40",
                          !n.read && "bg-secondary/40 font-medium",
                        )}
                        onClick={() => markNotificationRead(n.id)}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <p className="font-semibold text-foreground">{n.title}</p>
                          <span className="text-[10px] text-muted-foreground">{n.timestamp}</span>
                        </div>
                        <p className="mt-0.5 text-muted-foreground leading-relaxed">{n.message}</p>
                        {n.link && (
                          <Link
                            to={n.link}
                            className="mt-1 inline-block text-[11px] text-primary hover:underline font-medium"
                          >
                            View details →
                          </Link>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Reset Demo Data */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="hidden sm:inline-flex">
                  <RotateCcw className="size-3.5" />
                  <span>Reset demo</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset demo data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    All changes you made in this browser (timesheets, approvals, projects, clients,
                    settings) will be replaced with fresh sample data.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      resetDemo();
                      toast.success("Demo data reset to initial sample state");
                    }}
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {/* User Profile & Persona Switcher */}
            {me && (
              <div className="flex items-center gap-2 border-l pl-3">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <Initials name={me.name} className="size-8 text-xs font-bold" />
                      <div className="hidden leading-tight text-left sm:block">
                        <p className="text-sm font-semibold">{me.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {ROLE_LABEL[me.role]} · demo
                        </p>
                      </div>
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-2 shadow-elevated">
                    <div className="px-2 py-1.5 border-b mb-1">
                      <p className="text-xs font-medium text-muted-foreground">Current Persona</p>
                      <p className="text-sm font-bold text-foreground">{me.name}</p>
                      <p className="text-xs text-primary font-medium">{ROLE_LABEL[me.role]}</p>
                    </div>

                    <div className="space-y-1 my-1">
                      <p className="px-2 text-[10px] uppercase font-semibold text-muted-foreground">
                        Quick Persona Switch
                      </p>
                      {allMembers.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSwitchPersona(m.id)}
                          className={cn(
                            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-left transition-colors hover:bg-secondary",
                            m.id === me.id && "bg-secondary font-semibold text-primary",
                          )}
                        >
                          <div>
                            <span className="block">{m.name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {ROLE_LABEL[m.role]}
                            </span>
                          </div>
                          {m.id === me.id && <Check className="size-3.5 text-primary" />}
                        </button>
                      ))}
                    </div>

                    <div className="border-t pt-1 mt-1 space-y-0.5">
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-xs"
                      >
                        <Link to="/login">Full demo login page</Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => endDemoSession()}
                        className="w-full justify-start text-xs text-destructive hover:text-destructive"
                      >
                        Exit demo session
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
