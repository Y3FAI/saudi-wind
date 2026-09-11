/**
 * Freshness budget shared by the Playwright guard (`tests/freshness.spec.ts`)
 * and its unit test (`tests/freshness-budget.test.ts`).
 *
 * A five-day forecast keeps future valid times, so freshness is measured from
 * the newest `modelRun`, never from the last frame: a 44-day-old run can still
 * carry valid times that look recent.
 */

export const DEFAULT_MAX_AGE_HOURS = 12;

const HOUR_MS = 3_600_000;

export interface FreshnessInput {
  runId?: unknown;
  modelRun?: unknown;
}

export interface FreshnessOptions {
  /** Clock override, mostly for tests. */
  now?: number;
  /** Budget in hours; defaults to {@link DEFAULT_MAX_AGE_HOURS}. */
  maxAgeHours?: number;
}

export function modelRunAgeHours(
  modelRun: string,
  now: number = Date.now(),
): number {
  return (now - Date.parse(modelRun)) / HOUR_MS;
}

/**
 * Returns a human-readable violation naming the run and its age, or `null` when
 * the served manifest is inside budget.
 *
 * An unparseable `modelRun` is a violation rather than a pass so a malformed
 * manifest can never silently satisfy the guard.
 */
export function freshnessViolation(
  manifest: FreshnessInput,
  options: FreshnessOptions = {},
): string | null {
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const now = options.now ?? Date.now();
  const runId =
    typeof manifest.runId === "string" && manifest.runId
      ? manifest.runId
      : "unknown run";

  if (
    typeof manifest.modelRun !== "string" ||
    !Number.isFinite(Date.parse(manifest.modelRun))
  ) {
    return `run ${runId} has no parseable modelRun (${String(manifest.modelRun)})`;
  }

  const ageHours = modelRunAgeHours(manifest.modelRun, now);
  if (ageHours > maxAgeHours) {
    return `run ${runId} modelRun ${manifest.modelRun} is ${ageHours.toFixed(
      1,
    )} h old (budget ${maxAgeHours} h)`;
  }
  return null;
}
