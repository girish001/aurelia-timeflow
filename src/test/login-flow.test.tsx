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
  const view = render(<RouterProvider router={router} />);
  return { router, container: view.container };
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
  it("renders /login with Admin, Manager and Employee role cards (without demo user lists), phrasing-only button markup, and disabled Continue button initially", async () => {
    const { container } = mount("/login");

    expect(await screen.findByRole("heading", { name: "Demo role preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Business Admin" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Project Manager" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Employee" })).toBeInTheDocument();

    // Ensure individual demo user lists are not displayed inside the role cards
    expect(screen.queryByText(/Demo persona/i)).not.toBeInTheDocument();

    // Verify no nested buttons or block elements inside buttons
    expect(container.querySelectorAll("button button").length).toBe(0);
    expect(container.querySelectorAll("button div, button h2, button p").length).toBe(0);

    const continueBtn = screen.getByRole("button", { name: /Continue to Demo/i });
    expect(continueBtn).toBeDisabled();
    expect(reactErrors.some((m) => m.includes("getSnapshot should be cached"))).toBe(false);
  });

  it("supports selecting each of the three roles via click or keyboard (Enter / Space) and launching the workspace on Continue to Demo", async () => {
    const { router } = mount("/login");

    const adminRoleBtn = await screen.findByRole("button", { name: /^Business Admin/i });
    const managerRoleBtn = screen.getByRole("button", { name: /^Project Manager/i });
    const employeeRoleBtn = screen.getByRole("button", { name: /^Employee/i });
    const continueBtn = screen.getByRole("button", { name: /Continue to Demo/i });

    expect(adminRoleBtn).toHaveAttribute("aria-pressed", "false");
    expect(managerRoleBtn).toHaveAttribute("aria-pressed", "false");
    expect(employeeRoleBtn).toHaveAttribute("aria-pressed", "false");
    expect(continueBtn).toBeDisabled();

    // 1. Select Business Admin via Enter key
    adminRoleBtn.focus();
    fireEvent.keyDown(adminRoleBtn, { key: "Enter" });
    expect(adminRoleBtn).toHaveAttribute("aria-pressed", "true");
    expect(continueBtn).toBeEnabled();

    // 2. Select Project Manager via Space key
    managerRoleBtn.focus();
    fireEvent.keyDown(managerRoleBtn, { key: " " });
    expect(managerRoleBtn).toHaveAttribute("aria-pressed", "true");
    expect(adminRoleBtn).toHaveAttribute("aria-pressed", "false");

    // 3. Select Employee via click and then switch back to Business Admin
    fireEvent.click(employeeRoleBtn);
    expect(employeeRoleBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(adminRoleBtn);
    expect(adminRoleBtn).toHaveAttribute("aria-pressed", "true");

    // 4. Click Continue to Demo -> launches Business Admin session (m6)
    fireEvent.click(continueBtn);

    await waitFor(() => expect(router.state.location.pathname).toBe("/app"));
    expect(getSessionId()).toBe("m6");
    expect(window.localStorage.getItem("aurelia-timeflow-demo-session")).toBe("m6");
    expect((await screen.findAllByText("Demo workspace")).length).toBeGreaterThan(0);
  });

  it("redirects /app to /login when there is no demo session", async () => {
    const { router } = mount("/app");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await screen.findByRole("heading", { name: "Demo role preview" })).toBeInTheDocument();
  });

  it("redirects /app to /login when the stored session id matches no member", async () => {
    window.localStorage.setItem("aurelia-timeflow-demo-session", "ghost");
    const { router } = mount("/app");

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await screen.findByRole("heading", { name: "Demo role preview" })).toBeInTheDocument();
  });

  it("restores a stored demo session from localStorage on a fresh page load", async () => {
    window.localStorage.setItem("aurelia-timeflow-demo-session", "m2");
    vi.resetModules();
    const fresh = await import("@/lib/demo-store");

    expect(fresh.getSessionId()).toBe("m2");
  });
});
