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
  PanelLeftClose,
  PanelLeftOpen,
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

function NavList({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: (() => void) | undefined;
  collapsed?: boolean | undefined;
}) {
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
            {!collapsed && (
              <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
                {section}
              </p>
            )}
            <div className="space-y-0.5">
              {items.map((n) => {
                const active =
                  n.to === "/app" ? path === "/app" || path === "/app/" : path.startsWith(n.to);
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    onClick={onNavigate}
                    title={collapsed ? n.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center rounded-lg py-2 text-sm font-medium transition-colors",
                      collapsed ? "justify-center px-2" : "gap-3 px-3",
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
                    {!collapsed && <span className="flex-1 truncate">{n.label}</span>}
                    {!collapsed &&
                      n.label === "Approvals" &&
                      pendingTimesheets + pendingLeaves > 0 && (
                        <span className="rounded-full bg-sidebar-primary px-2 py-0.5 text-[0.7rem] font-bold text-sidebar-primary-foreground">
                          {pendingTimesheets + pendingLeaves}
                        </span>
                      )}
                    {!collapsed && n.label === "Leave Management" && pendingLeaves > 0 && (
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

function SidebarBody({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: (() => void) | undefined;
  collapsed?: boolean | undefined;
}) {
  const me = useMe();
  return (
    <div
      className={cn(
        "flex h-full flex-col justify-between bg-sidebar text-sidebar-foreground",
        collapsed ? "p-2" : "p-4",
      )}
    >
      <div className="space-y-6">
        <div className={cn("pt-1", collapsed ? "flex justify-center" : "px-1")}>
          {collapsed ? (
            <span className="grid size-8 place-items-center rounded-lg bg-teal text-navy font-bold text-xs">
              AT
            </span>
          ) : (
            <Logo inverted />
          )}
        </div>
        <NavList onNavigate={onNavigate} collapsed={collapsed} />
      </div>

      <div className="space-y-3 pt-4 border-t border-sidebar-border">
        {/* Active Persona Indicator */}
        <div className={cn("rounded-lg bg-sidebar-accent/60", collapsed ? "p-1.5" : "p-2.5")}>
          <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2.5")}>
            <Initials name={me.name} className="size-8 text-xs font-bold" />
            {!collapsed && (
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-xs font-semibold text-sidebar-accent-foreground">
                  {me.name}
                </p>
                <p className="truncate text-[11px] text-sidebar-foreground/75">
                  {ROLE_LABEL[me.role]}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Demo Workspace info */}
        {!collapsed && (
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
                onClick={onNavigate}
                className="text-sidebar-primary hover:underline inline-flex items-center gap-1"
              >
                Product site <ArrowUpRight className="size-3" />
              </Link>
              <Link
                to="/login"
                onClick={onNavigate}
                className="text-sidebar-foreground/90 hover:underline"
              >
                Switch role
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const me = useMe();
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
    <div className="flex min-h-screen w-full overflow-x-hidden bg-background">
      {/* Desktop & Tablet Sidebar: Fixed w-64 on desktop (lg), collapsible on tablet/desktop */}
      <aside
        aria-label="Sidebar navigation"
        className={cn(
          "hidden shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:sticky md:top-0 md:block md:h-screen",
          sidebarCollapsed ? "md:w-16" : "md:w-64",
        )}
      >
        <SidebarBody collapsed={sidebarCollapsed} />
      </aside>

      {/* Mobile Slide-Out Navigation Drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-64 border-r border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
        >
          <SheetTitle className="sr-only">Main Navigation</SheetTitle>
          <SidebarBody onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b bg-card/90 px-3 backdrop-blur-md sm:gap-3 sm:px-6">
          {/* Mobile Hamburger Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden shrink-0"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </Button>

          {/* Tablet / Desktop Collapsible Sidebar Toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="size-4.5" />
            ) : (
              <PanelLeftClose className="size-4.5" />
            )}
          </Button>

          {/* Demo workspace pill (Required by tests and UX) */}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal-soft px-2.5 py-1 text-xs font-semibold text-accent-foreground truncate">
            <span className="size-1.5 shrink-0 rounded-full bg-teal animate-pulse" aria-hidden />{" "}
            <span className="truncate">Demo workspace</span>
          </span>

          <span className="hidden text-xs text-muted-foreground lg:inline truncate">
            Fictional demo dataset • Enterprise SaaS Preview
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
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
              <PopoverContent
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)] p-0 shadow-elevated"
              >
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">Notifications</p>
                      <span className="rounded bg-teal-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">
                        Simulated
                      </span>
                      {unreadCount > 0 && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {unreadCount} new
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Simulated demo notifications (in-browser)
                    </p>
                  </div>
                  {unreadCount > 0 && (
                    <button
                      onClick={() => markAllNotificationsRead(me.id)}
                      className="text-xs text-primary hover:underline font-medium shrink-0"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                <div className="max-h-72 divide-y overflow-y-auto">
                  {myNotifications.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground">
                      No simulated notifications
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
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {n.timestamp}
                          </span>
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
                <div className="border-t bg-muted/30 px-4 py-2 text-center text-[11px] text-muted-foreground">
                  Simulated in-browser alerts for demo preview only
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
              <div className="flex items-center gap-2 border-l pl-2 sm:pl-3">
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
                  <PopoverContent
                    align="end"
                    className="w-64 max-w-[calc(100vw-2rem)] p-2 shadow-elevated"
                  >
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
