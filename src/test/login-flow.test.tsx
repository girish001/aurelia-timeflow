import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouteComponent,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { endDemoSession, getSessionId, resetDemo } from "@/lib/demo-store";
import { Route as AppRoute } from "@/routes/app";
import { Route as AppIndexRoute } from "@/routes/app.index";
import { Route as LoginRoute } from "@/routes/login";

// The real root route renders an <html> shell and a stylesheet <link> that never
// finishes loading in jsdom, which suspends React forever. So these tests mount the
// real /login, /app layout and /app index components under a bare root route instead.
// Route registration itself is covered by app-routing.test.tsx and by `vite build`.
// Every route imported here defines a component; options.component is typed as optional.
const component = (r: { options: { component?: RouteComponent | undefined } }) =>
  r.options.component as RouteComponent;

function mount(path: string) {
  const root = createRootRoute({ component: Outlet });
  const login = createRoute({
    getParentRoute: () => root,
    path: "/login",
    component: component(LoginRoute),
  });
  const app = createRoute({
    getParentRoute: () => root,
    path: "/app",
    component: component(AppRoute),
  });
  const appIndex = createRoute({
    getParentRoute: () => app,
    path: "/",
    component: component(AppIndexRoute),
  });
  const router = createRouter({
    routeTree: root.addChildren([login, app.addChildren([appIndex])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

let reactErrors: string[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetDemo();
  endDemoSession();
  reactErrors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    reactErrors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("demo role preview flow", () => {
  it("renders /login with Admin, Manager and Employee role cards, disabled Continue button initially, and no render loop", async () => {
    mount("/login");

    expect(await screen.findByRole("heading", { name: "Demo role preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Business Admin" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project Manager" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Employee" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview as Vikram Joshi/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview as Priya Sharma/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview as Arjun Mehta/ })).toBeInTheDocument();

    const continueBtn = screen.getByRole("button", { name: /Continue to Demo/i });
    expect(continueBtn).toBeDisabled();
    expect(reactErrors.some((m) => m.includes("getSnapshot should be cached"))).toBe(false);
  });

  it("selecting a role enables Continue to Demo, and clicking Continue starts the demo session and opens /app", async () => {
    const router = mount("/login");

    const continueBtn = await screen.findByRole("button", { name: /Continue to Demo/i });
    expect(continueBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Preview as Vikram Joshi/ }));
    expect(continueBtn).toBeEnabled();

    fireEvent.click(continueBtn);

    await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
    expect(getSessionId()).toBe("m6");
    expect(window.localStorage.getItem("aurelia-timeflow-demo-session")).toBe("m6");
    expect((await screen.findAllByText("Demo workspace")).length).toBeGreaterThan(0);
  });

  it("redirects /app to /login when there is no demo session", async () => {
    const router = mount("/app");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await screen.findByRole("heading", { name: "Demo role preview" })).toBeInTheDocument();
  });

  it("redirects /app to /login when the stored session id matches no member", async () => {
    window.localStorage.setItem("aurelia-timeflow-demo-session", "ghost");
    const router = mount("/app");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await screen.findByRole("heading", { name: "Demo role preview" })).toBeInTheDocument();
  });

  it("restores a stored demo session from localStorage on a fresh page load", async () => {
    window.localStorage.setItem("aurelia-timeflow-demo-session", "m2");
    // A browser refresh re-evaluates the module with an empty in-memory cache.
    vi.resetModules();
    const fresh = await import("@/lib/demo-store");

    expect(fresh.getSessionId()).toBe("m2");
  });
});
