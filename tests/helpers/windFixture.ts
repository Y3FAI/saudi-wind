import type { Page } from "@playwright/test";

import { sha256HexFallback } from "../../src/lib/wind";
import type {
  WindGridKey,
  WindGridMetadata,
  WindGridReference,
} from "../../src/types/wind";

/**
 * Deterministic version-two wind fixtures for the Playwright specs.
 *
 * The committed `public/data/processed/latest.json` is a frozen sample and may
 * be either schema version, with or without the 100 m and gust grids. Specs that
 * assert how levels, gusts and the scrubber behave therefore serve their own
 * manifest and grids through `page.route` so they never depend on which run is
 * checked in.
 */

export const RUN_GRID: WindGridMetadata = {
  west: 33,
  east: 57,
  south: 15,
  north: 33.5,
  width: 97,
  height: 75,
  dx: 0.25,
  dy: 0.25,
  scan: "north-to-south-west-to-east",
};

export const ALL_GRID_KEYS: WindGridKey[] = [
  "wind-10m",
  "wind-100m",
  "gust-10m",
];

const HOUR_MS = 3_600_000;

export interface FixtureOptions {
  /** Forecast steps in hours from the model run. */
  steps?: number[];
  /** Grid keys published on every frame. */
  gridKeys?: WindGridKey[];
  /**
   * Grid keys per frame, aligned with `steps`. Takes precedence over
   * `gridKeys`, and is how "a level this run does not publish everywhere" is
   * expressed.
   */
  framesGridKeys?: WindGridKey[][];
  /** Model run, ISO-8601 Z. Defaults to the top of the current hour. */
  modelRun?: string;
  runId?: string;
  sample?: boolean;
}

/** Top of the current UTC hour, so "now" is a real forecast step. */
export function currentHourModelRun(now: number = Date.now()): string {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
}

/**
 * A model run 15 minutes before now. `frameLabel` rounds the offset to whole
 * hours, so pinning the run a quarter hour back keeps `+3 س` / `+9 س` stable for
 * the whole span a test can realistically take, unlike a run on the hour whose
 * labels drift once the clock passes :31.
 */
export function recentModelRun(now: number = Date.now()): string {
  return new Date(now - 15 * 60_000).toISOString();
}

export function validTimeFor(modelRun: string, step: number): string {
  return new Date(Date.parse(modelRun) + step * HOUR_MS).toISOString();
}

export function runIdFor(modelRun: string): string {
  return `gfs-${modelRun.slice(0, 10).replace(/-/g, "")}-${modelRun.slice(11, 13)}`;
}

/** Canonical grid file name, e.g. `gfs-20260910-12-f003-wind-100m.bin`. */
export function gridName(
  runId: string,
  step: number,
  key: WindGridKey,
): string {
  return `${runId}-f${String(step).padStart(3, "0")}-${key}.bin`;
}

/** The grid key encoded in a grid file name, or `null` when unrecognised. */
export function gridKeyFromName(name: string): WindGridKey | null {
  const match = /-(wind-10m|wind-100m|gust-10m)\.bin$/.exec(name);
  return match ? (match[1] as WindGridKey) : null;
}

/** Deterministic, non-zero u/v vectors (m/s) for one grid key. */
export function gridVectors(key: WindGridKey): Float32Array {
  const cells = RUN_GRID.width * RUN_GRID.height;
  const vectors = new Float32Array(cells * 2);
  const base = key === "gust-10m" ? 9 : key === "wind-100m" ? 5 : 3;
  for (let index = 0; index < cells; index += 1) {
    vectors[index * 2] = base + Math.sin(index / 17);
    vectors[index * 2 + 1] = base * 0.5 + Math.cos(index / 23);
  }
  return vectors;
}

export function gridBytes(key: WindGridKey): ArrayBuffer {
  return gridVectors(key).buffer as ArrayBuffer;
}

export function gridReference(
  runId: string,
  step: number,
  key: WindGridKey,
): WindGridReference {
  const bytes = gridBytes(key);
  return {
    url: `/api/wind/grids/${gridName(runId, step, key)}`,
    encoding: "float32-le-uv-interleaved",
    byteLength: bytes.byteLength,
    sha256: sha256HexFallback(bytes),
  };
}

/**
 * A schema-version-two manifest that satisfies `parseWindManifest` and mirrors
 * the published contract (top-level `data`/`statistics` mirror the first frame's
 * 10 m wind).
 */
export function buildManifest(options: FixtureOptions = {}): unknown {
  const steps = options.steps ?? [0, 3, 6];
  const modelRun = options.modelRun ?? currentHourModelRun();
  const runId = options.runId ?? runIdFor(modelRun);
  const perFrame =
    options.framesGridKeys ??
    steps.map(() => options.gridKeys ?? ALL_GRID_KEYS);

  const frames = steps.map((step, index) => {
    const keys = perFrame[index] ?? [];
    const grids: Partial<Record<WindGridKey, WindGridReference>> = {};
    const statistics: Partial<
      Record<
        WindGridKey,
        { areaWeightedMeanKmh: number; maximumGridCellKmh: number }
      >
    > = {};
    for (const key of keys) {
      grids[key] = gridReference(runId, step, key);
      statistics[key] = { areaWeightedMeanKmh: 18.4, maximumGridCellKmh: 42.7 };
    }
    return { step, validTime: validTimeFor(modelRun, step), grids, statistics };
  });

  const keys = Array.from(new Set(perFrame.flat()));
  const primaryKey: WindGridKey = keys.includes("wind-10m")
    ? "wind-10m"
    : (keys[0] ?? "wind-10m");
  const levels = Array.from(
    new Set(keys.map((key) => Number(/(\d+)m$/.exec(key)?.[1] ?? 10))),
  ).sort((left, right) => left - right);
  const variables = Array.from(
    new Set(keys.map((key) => (key.startsWith("gust") ? "gust" : "wind"))),
  );

  return {
    schemaVersion: 2,
    runId,
    provider: "NOAA_GFS",
    modelRun,
    validTime: frames[0].validTime,
    publishedAt: new Date().toISOString(),
    heightMeters: 10,
    sourceUnits: "m/s",
    displayUnits: "km/h",
    sample: options.sample ?? false,
    grid: RUN_GRID,
    levels,
    variables,
    frames,
    data: frames[0].grids[primaryKey],
    statistics: frames[0].statistics[primaryKey],
  };
}

const MANIFEST_ROUTE = "**/data/processed/latest.json";
const GRID_ROUTE = "**/api/wind/grids/*.bin";

/** Serves `manifest` where the built app looks for it. */
export async function installWindManifest(
  page: Page,
  manifest: unknown,
): Promise<void> {
  await page.route(MANIFEST_ROUTE, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(manifest),
    }),
  );
}

/** Serves every fixture grid with the bytes its manifest reference describes. */
export async function installWindGrids(page: Page): Promise<void> {
  await page.route(GRID_ROUTE, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const key = gridKeyFromName(name);
    if (!key) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(gridBytes(key)),
    });
  });
}

/** Opens the app on a fresh fixture manifest and waits for the timeline. */
export async function openWithFixture(
  page: Page,
  options: FixtureOptions = {},
): Promise<{ runId: string; steps: number[] }> {
  const manifest = buildManifest(options) as { runId: string };
  const steps = options.steps ?? [0, 3, 6];
  await installWindManifest(page, manifest);
  await installWindGrids(page);
  await page.goto("/");
  await page.locator(".wind-timeline").waitFor({ state: "visible" });
  return { runId: manifest.runId, steps };
}
