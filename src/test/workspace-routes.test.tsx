import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouteComponent,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { endDemoSession, resetDemo, startDemoSession, type Role } from "@/lib/demo-store";
import { canAccess, pageFromPath, ROLE_LABEL } from "@/lib/rules";
import { Route as AppRoute } from "@/routes/app";
import { Route as ApprovalsRoute } from "@/routes/app.approvals";
import { Route as AuditRoute } from "@/routes/app.audit";
import { Route as CalendarRoute } from "@/routes/app.calendar";
import { Route as ClientsRoute } from "@/routes/app.clients";
import { Route as IndexRoute } from "@/routes/app.index";
import { Route as ProjectsRoute } from "@/routes/app.projects";
import { Route as ReportsRoute } from "@/routes/app.reports";
import { Route as SettingsRoute } from "@/routes/app.settings";
import { Route as TeamRoute } from "@/routes/app.team";
import { Route as TimeoffRoute } from "@/routes/app.timeoff";
import { Route as TimesheetRoute } from "@/routes/app.timesheet";

// Mounts the real /app layout and every real workspace page under a bare root route
// (the real root shell's stylesheet <link> never settles in jsdom). Registration of the
// real route tree is covered by app-routing.test.tsx and by `vite build`.
type Comp = { options: { component?: RouteComponent | undefined } };
const component = (r: Comp) => r.options.component as RouteComponent;

const pages: [string, string, Comp][] = [
  ["/app", "/", IndexRoute],
  ["/app/timesheet", "/timesheet", TimesheetRoute],
  ["/app/timeoff", "/timeoff", TimeoffRoute],
  ["/app/calendar", "/calendar", CalendarRoute],
  ["/app/approvals", "/approvals", ApprovalsRoute],
  ["/app/projects", "/projects", ProjectsRoute],
  ["/app/clients", "/clients", ClientsRoute],
  ["/app/reports", "/reports", ReportsRoute],
  ["/app/team", "/team", TeamRoute],
  ["/app/audit", "/audit", AuditRoute],
  ["/app/settings", "/settings", SettingsRoute],
];

function mount(path: string) {
  const root = createRootRoute({ component: Outlet });
  const login = createRoute({
    getParentRoute: () => root,
    path: "/login",
    component: () => <p>login page</p>,
  });
  const app = createRoute({
    getParentRoute: () => root,
    path: "/app",
    component: component(AppRoute),
  });
  const children = pages.map(([, sub, r]) =>
    createRoute({ getParentRoute: () => app, path: sub, component: component(r) }),
  );
  const router = createRouter({
    routeTree: root.addChildren([login, app.addChildren(children)]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

let errors: string[] = [];
const FATAL =
  /Maximum update depth|getSnapshot should be cached|Cannot read prop|is not defined|is not a function|Uncaught|TypeError|ReferenceError/;

beforeEach(() => {
  window.localStorage.clear();
  resetDemo();
  endDemoSession();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const personas: [Role, string][] = [
  ["Admin", "m6"],
  ["Manager", "m1"],
  ["Employee", "m2"],
];

describe.each(personas)("workspace as %s", (role, memberId) => {
  it.each(pages.map(([p]) => [p]))(
    "%s renders without crashing and honours role access",
    async (path) => {
      startDemoSession(memberId);
      const router = mount(path);

      // The shell shows once the session is accepted.
      expect((await screen.findAllByText("Demo workspace")).length).toBeGreaterThan(0);
      // Give effects and suspended content a moment to settle.
      await new Promise((r) => setTimeout(r, 150));

      expect(router.state.location.pathname.replace(/\/$/, "")).toBe(path);
      expect(screen.queryByText("Something went wrong!")).toBeNull();
      expect(errors.filter((m) => FATAL.test(m))).toEqual([]);

      const page = pageFromPath(path);
      const denied = screen.queryByText(`Not available for ${ROLE_LABEL[role]}`);
      if (page && !canAccess(role, page)) expect(denied).not.toBeNull();
      else expect(denied).toBeNull();
    },
  );
});
