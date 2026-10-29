import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ShieldAlert, Building, FolderKanban, User, ArrowRight } from "lucide-react";
import { Initials, Logo } from "@/components/app/common";
import { startDemoSession, useDemo, useSessionId, type Role } from "@/lib/demo-store";
import { ROLE_LABEL } from "@/lib/rules";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () =>
    pageHead(
      "Demo role preview",
      "Choose a sample persona to preview Aurelia TimeFlow as an admin, project manager or employee.",
    ),
  component: DemoLogin,
});

const roles: { role: Role; icon: typeof User; text: string }[] = [
  {
    role: "Admin",
    icon: Building,
    text: "Company-wide dashboard, people, clients, projects, time-off approvals, allocations, reports and settings.",
  },
  {
    role: "Manager",
    icon: FolderKanban,
    text: "Managed projects and team, timesheet approvals, project calendar and team leave.",
  },
  {
    role: "Employee",
    icon: User,
    text: "Own timesheet, own time-off requests, own assignments and profile.",
  },
];

function DemoLogin() {
  // Select the store's stable array and derive the filtered list afterwards:
  // a selector that builds a new array on every call breaks useSyncExternalStore's
  // cached-snapshot contract and crashes the page with an infinite render loop.
  const allMembers = useDemo((s) => s.members);
  const members = useMemo(() => allMembers.filter((m) => m.status === "active"), [allMembers]);
  const current = useSessionId();
  const navigate = useNavigate();
  const choose = (id: string) => {
    startDemoSession(id);
    void navigate({ to: "/app" });
  };
  return (
    <div className="min-h-screen bg-hero">
      <header className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link to="/">
          <Logo />
        </Link>
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          Back to product site
        </Link>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
        <h1 className="text-3xl font-bold sm:text-4xl">Demo role preview</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Pick a sample persona to see the workspace the way that role would. You can switch at any
          time.
        </p>
        <div
          role="note"
          className="mt-5 flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <p>
            <strong>This is not a sign-in.</strong> There is no password or identity check — anyone
            can pick any persona. Role limits here only change what the demo shows; a real
            deployment needs secure authentication and server-side access control.
          </p>
        </div>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {roles.map((r) => (
            <section
              key={r.role}
              className="flex flex-col rounded-2xl border bg-card p-5 shadow-card"
              aria-labelledby={`role-${r.role}`}
            >
              <span className="grid size-10 place-items-center rounded-lg bg-secondary text-primary">
                <r.icon className="size-5" />
              </span>
              <h2 id={`role-${r.role}`} className="mt-3 text-lg font-semibold">
                {ROLE_LABEL[r.role]}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{r.text}</p>
              <ul className="mt-4 space-y-2">
                {members
                  .filter((m) => m.role === r.role)
                  .map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => choose(m.id)}
                        className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Initials name={m.name} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">
                            {m.name}
                            {m.id === current && (
                              <span className="ml-1 text-xs text-muted-foreground">(current)</span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {m.title}
                          </span>
                        </span>
                        <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
                        <span className="sr-only">
                          Preview as {m.name}, {ROLE_LABEL[r.role]}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          All personas and data are fictional. Your choice is remembered in this browser only.
        </p>
      </main>
    </div>
  );
}
