import { describe, expect, it } from "vitest";
import { parseHours } from "@/lib/time";
import { toCsv } from "@/lib/csv";

describe("hour entry validation", () => {
  it("rejects negative hours", () => expect(parseHours("-1").ok).toBe(false));
  it("rejects more than 24 hours in a cell", () => expect(parseHours("25").ok).toBe(false));
  it("rejects non-numeric text", () => expect(parseHours("abc").ok).toBe(false));
  it("rejects non-15-minute steps", () => expect(parseHours("1.1").ok).toBe(false));
  it("accepts h:mm format", () => expect(parseHours("7:30")).toEqual({ ok: true, value: 7.5 }));
  it("treats empty as zero", () => expect(parseHours("")).toEqual({ ok: true, value: 0 }));
});

describe("CSV export", () => {
  it("quotes values containing commas and quotes", () => {
    expect(toCsv([["a,b", 'say "hi"', 3]])).toBe('"a,b","say ""hi""",3');
  });
});
