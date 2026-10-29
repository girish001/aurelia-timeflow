import { createFileRoute, Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { useMe, useSessionId } from "@/lib/demo-store";
import { canAccess, pageFromPath, ROLE_LABEL } from "@/lib/rules";

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

function AppLayout() {
  const sessionId = useSessionId();
  const me = useMe();
  const path = useRouterState({ select: (r) => r.location.pathname });
  if (!sessionId || !me.id) return <Navigate to="/login" />;
  const page = pageFromPath(path);
  // UI-only guard for the demo. Production must enforce access on the server.
  const allowed = !page || canAccess(me.role, page);
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
