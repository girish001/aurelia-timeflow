import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, ShieldOff } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import {
  checkServerSession,
  isProductionEnvironment,
  type AuthSessionResponse,
} from "@/lib/auth-client";
import { useMe, useSessionId, useDemo, getState, type State, type Member } from "@/lib/demo-store";
import { canAccess, pageFromPath, ROLE_LABEL } from "@/lib/rules";
import { weekKey } from "@/lib/time";

export const Route = createFileRoute("/app")({
  ssr: false,
  pendingComponent: () => (
    <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
      Loading workspace…
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
  isRealSession: boolean;
}) {
  const currentWeek = weekKey(new Date());
  const activeSheet = params.state.timesheets.find(
    (t) => t.memberId === params.me.id && t.weekStart === currentWeek,
  );

  if (console.groupCollapsed) {
    console.groupCollapsed(
      `%c[TimeFlow Diagnostics] Session & State Loaded%c (${params.me.name || "Unknown"} · ${params.me.role || "No Role"})${params.isRealSession ? " [SERVER AUTH]" : " [DEMO]"}`,
      "color: #0d9488; font-weight: bold;",
      "color: gray; font-weight: normal;",
    );
  } else {
    console.log("[TimeFlow Diagnostics] Session & State Loaded");
  }

  console.log("Timestamp:", new Date().toISOString());
  console.log("Route Path:", params.path, "| Page:", params.page, "| Allowed:", params.allowed);
  console.log(
    "Auth Mode:",
    params.isRealSession ? "Real Server Session" : "Local Development Sandbox",
  );
  console.log("Active User Persona:", {
    id: params.me.id,
    name: params.me.name,
    email: params.me.email,
    role: params.me.role,
    title: params.me.title,
    department: params.me.department,
  });

  if (console.groupEnd) {
    console.groupEnd();
  }
}

function AppLayout() {
  const isProd = isProductionEnvironment();
  const [sessionChecking, setSessionChecking] = useState(true);
  const [serverSession, setServerSession] = useState<AuthSessionResponse | null>(null);

  const sessionId = useSessionId();
  const me = useMe();
  const state = useDemo((s) => s);
  const path = useRouterState({ select: (r) => r.location.pathname });
  const page = pageFromPath(path);
  const allowed = !page || canAccess(me.role, page);

  useEffect(() => {
    let mounted = true;
    checkServerSession()
      .then((session) => {
        if (!mounted) return;
        setServerSession(session);
        setSessionChecking(false);
      })
      .catch(() => {
        if (!mounted) return;
        setServerSession(null);
        setSessionChecking(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const hasValidServerSession = Boolean(serverSession?.authenticated);
  const hasValidDemoSession = Boolean(!isProd && sessionId && me.id);
  const isAuthenticated = hasValidServerSession || hasValidDemoSession;

  useEffect(() => {
    if (!sessionChecking && isAuthenticated) {
      logAppDiagnostics({
        sessionId: hasValidServerSession ? (serverSession?.session?.id ?? sessionId) : sessionId,
        me,
        path,
        page,
        allowed,
        state,
        isRealSession: hasValidServerSession,
      });
    }
  }, [
    sessionChecking,
    isAuthenticated,
    hasValidServerSession,
    serverSession,
    sessionId,
    me,
    path,
    page,
    allowed,
    state,
  ]);

  if (sessionChecking) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="font-medium">Validating workspace session…</p>
        </div>
      </div>
    );
  }

  // Production strictly prohibits demo sessions — must have real server authentication
  if (isProd && !hasValidServerSession) {
    return <Navigate to="/login" />;
  }

  // Development requires either server session or dev demo session
  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

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
            This page is restricted for your role. Contact your organization administrator for
            access.
          </p>
          <Button asChild className="mt-5">
            <Link to="/app">Go to my dashboard</Link>
          </Button>
        </div>
      )}
    </AppShell>
  );
}
