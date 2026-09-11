import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_AGE_HOURS,
  freshnessViolation,
  modelRunAgeHours,
} from "./helpers/freshness";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-09-11T12:00:00Z");

function hoursAgo(hours: number): string {
  return new Date(NOW - hours * HOUR_MS).toISOString();
}

describe("freshnessViolation", () => {
  it("passes a model run inside the twelve hour budget", () => {
    expect(
      freshnessViolation(
        { runId: "gfs-20260911-06", modelRun: hoursAgo(3) },
        { now: NOW },
      ),
    ).toBeNull();
  });

  it("passes a model run exactly on the budget boundary", () => {
    expect(
      freshnessViolation(
        { runId: "gfs-20260911-00", modelRun: hoursAgo(DEFAULT_MAX_AGE_HOURS) },
        { now: NOW },
      ),
    ).toBeNull();
  });

  it("fails a run just past the budget and names the run and age", () => {
    const violation = freshnessViolation(
      { runId: "gfs-20260910-23", modelRun: hoursAgo(12.5) },
      { now: NOW },
    );

    expect(violation).toContain("gfs-20260910-23");
    expect(violation).toContain("12.5 h old");
    expect(violation).toContain("budget 12 h");
  });

  it("fails the 44-day-old run that sat live", () => {
    const violation = freshnessViolation(
      { runId: "gfs-20260728-12", modelRun: hoursAgo(44 * 24) },
      { now: NOW },
    );

    expect(violation).not.toBeNull();
    expect(violation).toContain("gfs-20260728-12");
    expect(violation).toContain("1056.0 h old");
    expect(modelRunAgeHours(hoursAgo(44 * 24), NOW)).toBeCloseTo(1056, 5);
  });

  it("honours a configured budget", () => {
    expect(
      freshnessViolation(
        { runId: "gfs-20260911-06", modelRun: hoursAgo(20) },
        { now: NOW, maxAgeHours: 24 },
      ),
    ).toBeNull();
    expect(
      freshnessViolation(
        { runId: "gfs-20260911-06", modelRun: hoursAgo(20) },
        { now: NOW, maxAgeHours: 6 },
      ),
    ).toContain("budget 6 h");
  });

  it("treats a malformed modelRun as a violation, never a pass", () => {
    expect(
      freshnessViolation(
        { runId: "gfs-bad", modelRun: "not-a-date" },
        { now: NOW },
      ),
    ).toContain("gfs-bad");
    expect(freshnessViolation({ runId: "gfs-bad" }, { now: NOW })).toContain(
      "gfs-bad",
    );
    expect(freshnessViolation({ modelRun: 12345 }, { now: NOW })).toContain(
      "unknown run",
    );
  });
});
