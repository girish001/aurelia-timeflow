import { addDays, format, parseISO, startOfWeek } from "date-fns";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function mondayOf(d: Date): Date {
  return startOfWeek(d, { weekStartsOn: 1 });
}
export function isoDay(d: Date) {
  return format(d, "yyyy-MM-dd");
}
export function weekKey(d: Date) {
  return isoDay(mondayOf(d));
}
export function weekDates(weekStart: string): Date[] {
  const s = parseISO(weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}
export function weekLabel(weekStart: string) {
  const s = parseISO(weekStart);
  return `${format(s, "d MMM")} – ${format(addDays(s, 6), "d MMM yyyy")}`;
}

export type TimeFormat = "decimal" | "hhmm";
export function formatHours(h: number, fmt: TimeFormat = "decimal") {
  if (fmt === "hhmm") {
    const mins = Math.round(h * 60);
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  }
  const r = Math.round(h * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, "");
}

/** Parse one cell of hours. Empty = 0. Rules: number, 0–24, quarter-hour steps. */
export function parseHours(
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const v = raw.trim();
  if (v === "") return { ok: true, value: 0 };
  let n: number;
  if (/^\d{1,2}:\d{2}$/.test(v)) {
    const [h = 0, m = 0] = v.split(":").map(Number);
    if (m >= 60) return { ok: false, error: "Minutes must be under 60" };
    n = h + m / 60;
  } else if (/^-?\d*\.?\d+$/.test(v)) {
    n = Number(v);
  } else {
    return { ok: false, error: "Enter a number like 7.5 or 7:30" };
  }
  if (n < 0) return { ok: false, error: "Hours cannot be negative" };
  if (n > 24) return { ok: false, error: "Max 24 hours per day" };
  if (Math.abs(n * 4 - Math.round(n * 4)) > 1e-6)
    return { ok: false, error: "Use 15-minute steps (0.25)" };
  return { ok: true, value: n };
}

export function formatMoney(n: number, currency: "INR" | "USD") {
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}
