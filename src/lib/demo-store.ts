import { useSyncExternalStore } from "react";
import { addDays, parseISO, subWeeks } from "date-fns";
import { isoDay, weekKey, type TimeFormat } from "./time";

export type Status = "active" | "inactive";
export interface Client {
  id: string;
  name: string;
  contact: string;
  email: string;
  country: string;
  status: Status;
}
export type ProjectStatus = "active" | "on-hold" | "completed";
export interface Project {
  id: string;
  name: string;
  clientId: string;
  managerId: string;
  status: ProjectStatus;
  budgetHours: number;
  rate: number;
  tasks: string[];
}
export type Role = "Admin" | "Manager" | "Employee";
export interface Member {
  id: string;
  name: string;
  email: string;
  title: string;
  role: Role;
  status: "active" | "invited" | "inactive";
}
export interface Entry {
  id: string;
  projectId: string;
  task: string;
  hours: number[];
  billable: boolean;
  notes: string;
}
export type SheetStatus = "draft" | "submitted" | "approved" | "rejected";
export interface Timesheet {
  id: string;
  memberId: string;
  weekStart: string;
  entries: Entry[];
  status: SheetStatus;
  submittedAt?: string | undefined;
  reviewedAt?: string | undefined;
  reviewComment?: string | undefined;
}
export interface Settings {
  companyName: string;
  companyEmail: string;
  country: string;
  timezone: string;
  weekStart: "monday";
  timeFormat: TimeFormat;
  currency: "INR" | "USD";
  dailyTarget: number;
}
export type LeaveType = "annual" | "sick" | "personal" | "unpaid";
export type LeaveStatus = "pending" | "approved" | "rejected";
export type DayPart = "full" | "am" | "pm";
export interface LeaveRequest {
  id: string;
  memberId: string;
  type: LeaveType;
  start: string;
  end: string;
  partial: DayPart;
  reason: string;
  status: LeaveStatus;
  createdAt: string;
  reviewedBy?: string | undefined;
  reviewComment?: string | undefined;
}
export type AllocationStatus = "tentative" | "confirmed";
export interface Allocation {
  id: string;
  memberId: string;
  projectId: string;
  date: string;
  hours: number;
  status: AllocationStatus;
}
export interface State {
  version: number;
  clients: Client[];
  projects: Project[];
  members: Member[];
  timesheets: Timesheet[];
  leaves: LeaveRequest[];
  allocations: Allocation[];
  settings: Settings;
}

const KEY = "aurelia-timeflow-demo-v2";
const SESSION_KEY = "aurelia-timeflow-demo-session";
const VERSION = 2;

export function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createSeed(now = new Date()): State {
  const clients: Client[] = [
    {
      id: "c1",
      name: "Northwind Retail (Demo)",
      contact: "Ananya Rao",
      email: "ananya@northwind.example",
      country: "India",
      status: "active",
    },
    {
      id: "c2",
      name: "Bluepeak Logistics (Demo)",
      contact: "Daniel Moore",
      email: "daniel@bluepeak.example",
      country: "United Kingdom",
      status: "active",
    },
    {
      id: "c3",
      name: "Kestrel Health (Demo)",
      contact: "Meera Iyer",
      email: "meera@kestrel.example",
      country: "India",
      status: "active",
    },
    {
      id: "c4",
      name: "Harbor Finance (Demo)",
      contact: "Sarah Chen",
      email: "sarah@harbor.example",
      country: "Singapore",
      status: "inactive",
    },
  ];
  const members: Member[] = [
    {
      id: "m1",
      name: "Priya Sharma",
      email: "priya@demo.aurelia.example",
      title: "Delivery Manager",
      role: "Manager",
      status: "active",
    },
    {
      id: "m2",
      name: "Arjun Mehta",
      email: "arjun@demo.aurelia.example",
      title: "Senior Developer",
      role: "Employee",
      status: "active",
    },
    {
      id: "m3",
      name: "Kavya Nair",
      email: "kavya@demo.aurelia.example",
      title: "UX Designer",
      role: "Employee",
      status: "active",
    },
    {
      id: "m4",
      name: "Rahul Verma",
      email: "rahul@demo.aurelia.example",
      title: "QA Engineer",
      role: "Employee",
      status: "active",
    },
    {
      id: "m5",
      name: "Emily Carter",
      email: "emily@demo.aurelia.example",
      title: "Project Manager",
      role: "Manager",
      status: "active",
    },
    {
      id: "m6",
      name: "Vikram Joshi",
      email: "vikram@demo.aurelia.example",
      title: "Operations Admin",
      role: "Admin",
      status: "active",
    },
    {
      id: "m7",
      name: "Neha Kapoor",
      email: "neha@demo.aurelia.example",
      title: "Founder & Business Owner",
      role: "Admin",
      status: "active",
    },
  ];
  const projects: Project[] = [
    {
      id: "p1",
      name: "E-commerce Replatform",
      clientId: "c1",
      managerId: "m1",
      status: "active",
      budgetHours: 1200,
      rate: 2800,
      tasks: ["Development", "Code review", "Meetings"],
    },
    {
      id: "p2",
      name: "Mobile App v2",
      clientId: "c1",
      managerId: "m5",
      status: "active",
      budgetHours: 800,
      rate: 2600,
      tasks: ["Development", "Design", "QA"],
    },
    {
      id: "p3",
      name: "Fleet Tracking Portal",
      clientId: "c2",
      managerId: "m5",
      status: "active",
      budgetHours: 950,
      rate: 3200,
      tasks: ["Development", "QA", "Support"],
    },
    {
      id: "p4",
      name: "Patient Intake Redesign",
      clientId: "c3",
      managerId: "m1",
      status: "active",
      budgetHours: 400,
      rate: 2400,
      tasks: ["Design", "Research", "Meetings"],
    },
    {
      id: "p5",
      name: "Compliance Dashboard",
      clientId: "c4",
      managerId: "m1",
      status: "completed",
      budgetHours: 300,
      rate: 3000,
      tasks: ["Development", "QA"],
    },
    {
      id: "p6",
      name: "Internal – Training & Admin",
      clientId: "",
      managerId: "m6",
      status: "active",
      budgetHours: 0,
      rate: 0,
      tasks: ["Training", "Admin", "Leave"],
    },
  ];
  const plan: Record<string, { p: string; t: string; b: boolean }[]> = {
    m1: [
      { p: "p1", t: "Meetings", b: true },
      { p: "p4", t: "Meetings", b: true },
      { p: "p6", t: "Admin", b: false },
    ],
    m2: [
      { p: "p1", t: "Development", b: true },
      { p: "p3", t: "Development", b: true },
      { p: "p6", t: "Training", b: false },
    ],
    m3: [
      { p: "p4", t: "Design", b: true },
      { p: "p2", t: "Design", b: true },
    ],
    m4: [
      { p: "p3", t: "QA", b: true },
      { p: "p2", t: "QA", b: true },
      { p: "p6", t: "Admin", b: false },
    ],
    m5: [
      { p: "p2", t: "Development", b: true },
      { p: "p3", t: "Support", b: true },
      { p: "p6", t: "Admin", b: false },
    ],
    m6: [
      { p: "p6", t: "Admin", b: false },
      { p: "p1", t: "Code review", b: true },
    ],
    m7: [{ p: "p6", t: "Admin", b: false }],
  };
  const notes: Record<string, string> = {
    Development: "Feature work and fixes",
    Design: "Wireframes and UI review",
    QA: "Regression testing",
    Meetings: "Client standups",
    Admin: "Internal coordination",
    Training: "Learning session",
    Support: "Production support tickets",
    Research: "User interviews",
    "Code review": "PR reviews",
  };

  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const thisWeek = weekKey(now);
  const timesheets: Timesheet[] = [];
  for (const m of members) {
    for (let w = 6; w >= 0; w--) {
      const ws = weekKey(subWeeks(parseISO(thisWeek), w));
      const lines = plan[m.id] ?? [];
      const entries: Entry[] = lines.map((l, i) => {
        const hours = Array.from({ length: 7 }, (_, d) => {
          if (d >= 5) return 0;
          const base = i === 0 ? 5 : i === 1 ? 2.5 : 0.5;
          return Math.max(0, Math.round((base + (rnd() - 0.5) * 2) * 4) / 4);
        });
        return {
          id: `e_${m.id}_${w}_${i}`,
          projectId: l.p,
          task: l.t,
          hours,
          billable: l.b,
          notes: notes[l.t] ?? "",
        };
      });
      let status: SheetStatus = "approved";
      if (w === 0) status = "draft";
      else if (w === 1)
        status =
          m.id === "m1" || m.id === "m6" ? "approved" : m.id === "m4" ? "rejected" : "submitted";
      else if (w === 2 && m.id === "m3") status = "submitted";
      if (w === 0) {
        // current week: only past days filled
        const today = (now.getDay() + 6) % 7;
        entries.forEach((e) => (e.hours = e.hours.map((h, d) => (d < today ? h : 0))));
      }
      const submitted = isoDay(addDays(parseISO(ws), 5));
      timesheets.push({
        id: `t_${m.id}_${ws}`,
        memberId: m.id,
        weekStart: ws,
        entries,
        status,
        submittedAt: status === "draft" ? undefined : submitted,
        reviewedAt:
          status === "approved" || status === "rejected"
            ? isoDay(addDays(parseISO(ws), 7))
            : undefined,
        reviewComment:
          status === "rejected"
            ? "Please split QA hours between Fleet Tracking and Mobile App."
            : undefined,
      });
    }
  }
  // ---- time off ----
  const mon = parseISO(thisWeek);
  const d = (n: number) => isoDay(addDays(mon, n));
  const leaves: LeaveRequest[] = [
    {
      id: "l1",
      memberId: "m2",
      type: "annual",
      start: d(9),
      end: d(11),
      partial: "full",
      reason: "Family function (demo)",
      status: "pending",
      createdAt: d(-2),
    },
    {
      id: "l2",
      memberId: "m3",
      type: "sick",
      start: d(-6),
      end: d(-6),
      partial: "full",
      reason: "Fever",
      status: "approved",
      createdAt: d(-6),
      reviewedBy: "m1",
      reviewComment: "Get well soon",
    },
    {
      id: "l3",
      memberId: "m4",
      type: "personal",
      start: d(8),
      end: d(8),
      partial: "pm",
      reason: "Bank appointment",
      status: "approved",
      createdAt: d(-3),
      reviewedBy: "m5",
    },
    {
      id: "l4",
      memberId: "m1",
      type: "annual",
      start: d(15),
      end: d(18),
      partial: "full",
      reason: "Vacation",
      status: "pending",
      createdAt: d(-1),
    },
    {
      id: "l5",
      memberId: "m2",
      type: "unpaid",
      start: d(-12),
      end: d(-11),
      partial: "full",
      reason: "Personal travel",
      status: "rejected",
      createdAt: d(-16),
      reviewedBy: "m1",
      reviewComment: "Release week — please pick other dates.",
    },
    {
      id: "l6",
      memberId: "m3",
      type: "annual",
      start: d(3),
      end: d(3),
      partial: "full",
      reason: "Long weekend",
      status: "approved",
      createdAt: d(-5),
      reviewedBy: "m1",
    },
  ];

  // ---- allocations: this week + next 3 weeks, weekdays ----
  const allocPlan: Record<string, [string, number][]> = {
    m1: [
      ["p1", 4],
      ["p4", 3],
    ],
    m2: [
      ["p1", 6],
      ["p3", 2],
    ],
    m3: [
      ["p4", 5],
      ["p2", 3],
    ],
    m4: [
      ["p3", 5],
      ["p2", 3],
    ],
    m5: [
      ["p2", 4],
      ["p3", 3],
    ],
    m6: [["p1", 2]],
  };
  const allocations: Allocation[] = [];
  for (let w = 0; w < 4; w++)
    for (let day = 0; day < 5; day++) {
      const date = d(w * 7 + day);
      for (const [mid, list] of Object.entries(allocPlan))
        list.forEach(([pid, h], i) =>
          allocations.push({
            id: `a_${mid}_${date}_${i}`,
            memberId: mid,
            projectId: pid,
            date,
            hours: h,
            status: w < 2 ? "confirmed" : "tentative",
          }),
        );
    }
  // a deliberate over-capacity day for the demo
  allocations.push({
    id: "a_conflict_1",
    memberId: "m2",
    projectId: "p3",
    date: d(2),
    hours: 3,
    status: "tentative",
  });

  return {
    version: VERSION,
    clients,
    projects,
    members,
    timesheets,
    leaves,
    allocations,
    settings: {
      companyName: "Demo Consulting Pvt Ltd",
      companyEmail: "ops@demo.aurelia.example",
      country: "India",
      timezone: "Asia/Kolkata",
      weekStart: "monday",
      timeFormat: "decimal",
      currency: "INR",
      dailyTarget: 8,
    },
  };
}

let state: State | null = null;
const listeners = new Set<() => void>();

function load(): State {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as State;
        if (parsed.version === VERSION) return parsed;
      }
    } catch {
      /* corrupted storage: fall back to seed */
    }
  }
  return createSeed();
}

export function getState(): State {
  if (!state) state = load();
  return state;
}

export function setState(fn: (s: State) => State) {
  state = fn(getState());
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable */
  }
  listeners.forEach((l) => l());
}

export function resetDemo() {
  state = createSeed();
  // keep the chosen demo persona; it exists in every seed
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDemo<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(getState()),
  );
}

// ---------- derived helpers ----------
export const sheetTotal = (t: Timesheet) =>
  t.entries.reduce((a, e) => a + e.hours.reduce((x, y) => x + y, 0), 0);
export const entryTotal = (e: Entry) => e.hours.reduce((x, y) => x + y, 0);

export interface FlatRow {
  date: string;
  weekStart: string;
  memberId: string;
  projectId: string;
  task: string;
  hours: number;
  billable: boolean;
  status: SheetStatus;
  notes: string;
}
export function flatten(s: State, opts: { includeDrafts?: boolean } = {}): FlatRow[] {
  const out: FlatRow[] = [];
  for (const t of s.timesheets) {
    if (t.status === "rejected") continue;
    if (t.status === "draft" && !opts.includeDrafts) continue;
    for (const e of t.entries)
      e.hours.forEach((h, d) => {
        if (h > 0)
          out.push({
            date: isoDay(addDays(parseISO(t.weekStart), d)),
            weekStart: t.weekStart,
            memberId: t.memberId,
            projectId: e.projectId,
            task: e.task,
            hours: h,
            billable: e.billable,
            status: t.status,
            notes: e.notes,
          });
      });
  }
  return out;
}

export function loggedHours(s: State, projectId: string) {
  return flatten(s, { includeDrafts: true })
    .filter((r) => r.projectId === projectId)
    .reduce((a, r) => a + r.hours, 0);
}

// ---------- actions ----------
export function upsertTimesheet(t: Timesheet) {
  setState((s) => ({
    ...s,
    timesheets: s.timesheets.some((x) => x.id === t.id)
      ? s.timesheets.map((x) => (x.id === t.id ? t : x))
      : [...s.timesheets, t],
  }));
}
export function reviewTimesheet(id: string, decision: "approved" | "rejected", comment: string) {
  setState((s) => ({
    ...s,
    timesheets: s.timesheets.map((t) =>
      t.id === id
        ? {
            ...t,
            status: decision,
            reviewComment: comment || undefined,
            reviewedAt: isoDay(new Date()),
          }
        : t,
    ),
  }));
}
export function upsertProject(p: Project) {
  setState((s) => ({
    ...s,
    projects: s.projects.some((x) => x.id === p.id)
      ? s.projects.map((x) => (x.id === p.id ? p : x))
      : [...s.projects, p],
  }));
}
export function upsertClient(c: Client) {
  setState((s) => ({
    ...s,
    clients: s.clients.some((x) => x.id === c.id)
      ? s.clients.map((x) => (x.id === c.id ? c : x))
      : [...s.clients, c],
  }));
}
export function addMember(m: Member) {
  setState((s) => ({ ...s, members: [...s.members, m] }));
}
export function updateMember(id: string, patch: Partial<Member>) {
  setState((s) => ({
    ...s,
    members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}
export function updateSettings(patch: Partial<Settings>) {
  setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
}

// ---------- time off & allocations ----------
export function addLeave(l: LeaveRequest) {
  setState((s) => ({ ...s, leaves: [l, ...s.leaves] }));
}
export function setLeave(l: LeaveRequest) {
  setState((s) => ({ ...s, leaves: s.leaves.map((x) => (x.id === l.id ? l : x)) }));
}
export function removeLeave(id: string) {
  setState((s) => ({ ...s, leaves: s.leaves.filter((x) => x.id !== id) }));
}
export function upsertAllocation(a: Allocation) {
  setState((s) => ({
    ...s,
    allocations: s.allocations.some((x) => x.id === a.id)
      ? s.allocations.map((x) => (x.id === a.id ? a : x))
      : [...s.allocations, a],
  }));
}
export function removeAllocation(id: string) {
  setState((s) => ({ ...s, allocations: s.allocations.filter((x) => x.id !== id) }));
}

// ---------- demo role preview session (NOT authentication) ----------
let session: string | null | undefined;
function loadSession(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
export function getSessionId(): string | null {
  if (session === undefined) session = loadSession();
  return session;
}
export function startDemoSession(memberId: string) {
  session = memberId;
  try {
    window.localStorage.setItem(SESSION_KEY, memberId);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}
export function endDemoSession() {
  session = null;
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}
export function useSessionId() {
  return useSyncExternalStore(subscribe, getSessionId, () => null);
}
/** The active demo persona. Only valid inside the /app layout, which guarantees a session. */
export function useMe(): Member {
  const id = useSessionId();
  const me = useDemo((s) => s.members.find((m) => m.id === id));
  return (
    me ?? { id: "", name: "Unknown", email: "", title: "", role: "Employee", status: "active" }
  );
}
