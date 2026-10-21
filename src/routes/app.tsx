import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app/AppShell";

// Client-only: demo data lives in this browser's localStorage, so rendering on
// the server would produce different markup than the visitor's saved state.
export const Route = createFileRoute("/app")({
  ssr: false,
  pendingComponent: () => (
    <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading demo workspace…</div>
  ),
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
