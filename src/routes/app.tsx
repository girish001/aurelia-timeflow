import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { ShieldOff } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { useMe, useSessionId, useDemo, getState, type State, type Member } from "@/lib/demo-store";
import { canAccess, pageFromPath, ROLE_LABEL } from "@/lib/rules";
import { weekKey } from "@/lib/time";

// Client-only: demo data and the demo persona live in this browser's localStorage.
export const Route = createFileRoute("/app")({
  ssr: false,
  pendingComponent: () => (
    <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
      Loading demo workspace…
    </div>
  ),
  component: AppLayout,
});

function logAppDiagnostics(params: {
  sessionId: string | null;
  me: Member;
  path: string;
  page: string | null;
  allowed: boolean;
  state: State;
}) {
  const currentWeek = weekKey(new Date());
  const activeSheet = params.state.timesheets.find(
    (t) => t.memberId === params.me.id && t.weekStart === currentWeek,
  );

  if (console.groupCollapsed) {
    console.groupCollapsed(
      `%c[TimeFlow Diagnostics] Session & State Loaded%c (${params.me.name || "Unknown"} · ${params.me.role || "No Role"})`,
      "color: #0d9488; font-weight: bold;",
      "color: gray; font-weight: normal;",
    );
  } else {
    console.log("[TimeFlow Diagnostics] Session & State Loaded");
  }

  console.log("Timestamp:", new Date().toISOString());
  console.log("Route Path:", params.path, "| Page:", params.page, "| Allowed:", params.allowed);
  console.log("Session State:", {
    sessionId: params.sessionId,
    hasValidSession: Boolean(params.sessionId && params.me.id),
  });
  console.log("Active User Persona:", {
    id: params.me.id,
    name: params.me.name,
    email: params.me.email,
    role: params.me.role,
    title: params.me.title,
    department: params.me.department,
    reportingManagerId: params.me.reportingManagerId,
  });
  console.log("Store Snapshot:", {
    clientsCount: params.state.clients.length,
    projectsCount: params.state.projects.length,
    membersCount: params.state.members.length,
    timesheetsCount: params.state.timesheets.length,
    leavesCount: params.state.leaves.length,
    allocationsCount: params.state.allocations.length,
    auditLogsCount: params.state.auditLogs.length,
    notificationsCount: params.state.notifications.length,
  });
  console.log("Active Week Coverage:", {
    currentWeek,
    hasActiveWeekTimesheet: Boolean(activeSheet),
    activeWeekStatus: activeSheet?.status ?? "none",
    activeWeekEntriesCount: activeSheet?.entries.length ?? 0,
  });

  if (console.groupEnd) {
    console.groupEnd();
  }
}

function AppLayout() {
  const sessionId = useSessionId();
  const me = useMe();
  const state = useDemo((s) => s);
  const path = useRouterState({ select: (r) => r.location.pathname });
  const page = pageFromPath(path);
  const allowed = !page || canAccess(me.role, page);

  useEffect(() => {
    if (sessionId && me.id) {
      logAppDiagnostics({ sessionId, me, path, page, allowed, state });
      if (typeof window !== "undefined") {
        (window as unknown as { __TIMEFLOW_DIAGNOSTICS__?: () => void }).__TIMEFLOW_DIAGNOSTICS__ =
          () => {
            logAppDiagnostics({ sessionId, me, path, page, allowed, state: getState() });
          };
      }
    } else {
      console.warn("[TimeFlow Diagnostics] Unauthenticated /app access attempt:", {
        sessionId,
        hasMemberId: Boolean(me.id),
        redirectingTo: "/login",
      });
    }
  }, [sessionId, me, path, page, allowed, state]);

  if (!sessionId || !me.id) return <Navigate to="/login" />;

  return (
    <AppShell>
      {allowed ? (
        <Outlet />
      ) : (
        <div
          className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center shadow-card"
          role="alert"
        >
          <span className="mx-auto grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive">
            <ShieldOff className="size-5" />
          </span>
          <h1 className="mt-3 text-lg font-semibold">Not available for {ROLE_LABEL[me.role]}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This page is hidden for your demo role. (Demo guard only — real access control must be
            enforced on the server.)
          </p>
          <Button asChild className="mt-5">
            <Link to="/app">Go to my dashboard</Link>
          </Button>
        </div>
      )}
    </AppShell>
  );
}
