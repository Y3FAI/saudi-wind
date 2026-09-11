import { expect, test, type APIRequestContext } from "@playwright/test";

import { parseWindManifest } from "../src/lib/wind";
import {
  DEFAULT_MAX_AGE_HOURS,
  freshnessViolation,
  modelRunAgeHours,
} from "./helpers/freshness";

/**
 * Data-freshness guard.
 *
 * The failure this exists to catch: a 44-day-old run stayed live because nothing
 * on the pull-request path ever looked at `modelRun`. The scheduled
 * "Production freshness guard" job runs this spec against the deployed manifest
 * with `WIND_FRESHNESS_ENFORCE=1`; a stale run fails the job by name.
 */

const DEFAULT_MANIFEST_PATH = "/data/processed/latest.json";

function manifestUrl(): string {
  return process.env.WIND_MANIFEST_URL ?? DEFAULT_MANIFEST_PATH;
}

function maxAgeHours(): number {
  const configured = Number(
    process.env.WIND_FRESHNESS_MAX_AGE_HOURS ?? DEFAULT_MAX_AGE_HOURS,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_AGE_HOURS;
}

/**
 * Age is a deployment signal only for a live origin. The committed
 * `public/data/processed/latest.json` is a frozen sample, so `test:ui`, which
 * builds against it, must not fail on its age; the CI guard points
 * `WIND_MANIFEST_URL` at production and sets `WIND_FRESHNESS_ENFORCE=1`.
 */
function isLiveTarget(url: string): boolean {
  if (process.env.WIND_FRESHNESS_ENFORCE === "1") return true;
  try {
    const host = new URL(url, "http://127.0.0.1").hostname;
    return host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]";
  } catch {
    return true;
  }
}

async function loadServedManifest(request: APIRequestContext) {
  const target = manifestUrl();
  const response = await request.get(target, {
    headers: { Accept: "application/json" },
  });
  expect(
    response.status(),
    `budget "manifest availability": GET ${target} must return HTTP 200`,
  ).toBe(200);
  return parseWindManifest(await response.json());
}

test("serves a manifest the client can parse and render", async ({
  request,
}) => {
  const manifest = await loadServedManifest(request);

  expect(
    manifest.frames.length,
    `budget "manifest frames": ${manifestUrl()} must publish at least one forecast frame`,
  ).toBeGreaterThan(0);
  expect(
    manifest.levels.length,
    `budget "manifest levels": ${manifestUrl()} must publish at least one wind height`,
  ).toBeGreaterThan(0);
  expect(
    Number.isFinite(Date.parse(manifest.modelRun)),
    `budget "manifest modelRun": ${manifestUrl()} must carry an ISO-8601 Z modelRun`,
  ).toBe(true);
});

test("serves a model run inside the freshness budget", async ({ request }) => {
  const target = manifestUrl();
  test.skip(
    !isLiveTarget(target),
    "age is enforced against a live deployment, not the committed fixture",
  );

  const manifest = await loadServedManifest(request);
  const budget = maxAgeHours();
  const violation = freshnessViolation(manifest, { maxAgeHours: budget });
  const ageHours = modelRunAgeHours(manifest.modelRun);

  expect(
    violation,
    `budget "data freshness": ${target} newest modelRun must be <= ${budget} h old (measured ${ageHours.toFixed(
      1,
    )} h for ${manifest.runId})`,
  ).toBeNull();
});
