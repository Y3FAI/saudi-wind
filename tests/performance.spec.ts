import { expect, test, type Page } from "@playwright/test";

/**
 * CI performance budgets.
 *
 * These are regression floors, not device targets. GitHub-hosted runners share a
 * CPU and have no GPU, so the thresholds are deliberately generous; the device
 * targets the renderer actually aims at live in `src/lib/windStyle.ts` and are
 * confirmed on real hardware. Every assertion names the budget it broke, and
 * `PERFORMANCE_SKIP_BUDGETS=1` skips the budget suite on a known-slow runner
 * while still running the frame-rate floor below.
 *
 * The frame-rate floor is an env override because CI's ceiling is below the
 * device target: a shared, software-rendered runner sustains roughly 48 FPS
 * (CI run 34555430406: desktop 47/48/48.2, median 48). CI therefore sets
 * `PERFORMANCE_DESKTOP_FPS_MINIMUM=30` — the same ~30 FPS shared-runner target
 * the `frameIntervalMedianMs` budget encodes — while the in-spec desktop
 * default stays 55 FPS for local and device runs. See `docs/PERFORMANCE.md`.
 */

const BUDGETS = {
  /** First contentful paint, ms. Device target ~1800; shared runner 3000. */
  firstContentfulPaintMs: 3_000,
  /** Time until the first decoded forecast grid is on the map, ms. */
  interactiveMapMs: 5_000,
  /** Median requestAnimationFrame interval over 120 frames, ms (>= ~30 fps). */
  frameIntervalMedianMs: 45,
  /** 95th-percentile requestAnimationFrame interval over 120 frames, ms. */
  frameIntervalP95Ms: 90,
  /** Used JS heap after 30 s of animation, MB. */
  heapAfter30sMb: 220,
  /** Heap growth allowed across three zoom/pan cycles, MB. */
  heapGrowthPerThreeCyclesMb: 32,
} as const;

const FRAME_SAMPLES = 120;
const MEGABYTE = 1024 * 1024;
const skipBudgets = process.env.PERFORMANCE_SKIP_BUDGETS === "1";

interface FrameStats {
  median: number;
  p95: number;
  worst: number;
  samples: number;
}

async function frameStats(page: Page, count: number): Promise<FrameStats> {
  return page.evaluate(async (sampleCount: number) => {
    const next = () =>
      new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const deltas: number[] = [];
    let previous = await next();
    for (let index = 0; index < sampleCount; index += 1) {
      const current = await next();
      deltas.push(current - previous);
      previous = current;
    }
    deltas.sort((left, right) => left - right);
    const at = (quantile: number) =>
      deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * quantile))];
    return {
      median: at(0.5),
      p95: at(0.95),
      worst: deltas[deltas.length - 1],
      samples: deltas.length,
    };
  }, count);
}

async function usedHeapMb(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize: number };
      }
    ).memory;
    return memory ? memory.usedJSHeapSize : null;
  });
}

/** One zoom, drag and reset cycle: the churn a user generates while exploring. */
async function churnOnce(page: Page): Promise<void> {
  const map = page.getByRole("application");
  await page.getByRole("button", { name: "تكبير" }).click();
  const box = await map.boundingBox();
  if (box) {
    const startX = box.x + box.width * 0.6;
    const startY = box.y + box.height * 0.45;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY + 24, { steps: 5 });
    await page.mouse.up();
  }
  await page.getByRole("button", { name: "إعادة" }).click();
}

test("sustains the animation frame-rate target @performance", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const canvas = page.locator(".map-canvas--wind");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-fps", /\d/, { timeout: 10_000 });

  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    await page.waitForTimeout(1100);
    const value = Number(await canvas.getAttribute("data-fps"));
    expect(Number.isFinite(value)).toBe(true);
    samples.push(value);
  }
  samples.sort((left, right) => left - right);
  const median = samples[1];
  const configuredMinimum = Number(
    process.env[
      isMobile
        ? "PERFORMANCE_MOBILE_FPS_MINIMUM"
        : "PERFORMANCE_DESKTOP_FPS_MINIMUM"
    ],
  );
  const minimum =
    Number.isFinite(configuredMinimum) && configuredMinimum > 0
      ? configuredMinimum
      : isMobile
        ? 30
        : 55;
  console.info(
    `${isMobile ? "mobile" : "desktop"} animation FPS: ${samples.join(", ")} (median ${median})`,
  );

  // CI overrides the 55 FPS desktop device target via
  // PERFORMANCE_DESKTOP_FPS_MINIMUM (30) because a shared, GPU-less runner tops
  // out near 48 FPS. With no override the desktop floor stays 55.
  expect(
    median,
    `budget "animation fps": ${isMobile ? "mobile" : "desktop"} FPS samples: ${samples.join(", ")}`,
  ).toBeGreaterThanOrEqual(minimum);
  await expect(canvas).toHaveAttribute("data-particles", /\d+/);
});

test("keeps first contentful paint inside the budget @performance", async ({
  page,
}) => {
  test.skip(skipBudgets, "PERFORMANCE_SKIP_BUDGETS=1");

  await page.goto("/");
  await page.waitForFunction(
    () => performance.getEntriesByName("first-contentful-paint").length > 0,
    null,
    { timeout: 10_000 },
  );
  const fcp = await page.evaluate(
    () =>
      performance.getEntriesByName("first-contentful-paint")[0]?.startTime ??
      Number.NaN,
  );

  expect(
    Number.isFinite(fcp),
    'budget "first-contentful-paint": the paint entry must be measurable',
  ).toBe(true);
  expect(
    fcp,
    `budget "first-contentful-paint": <= ${BUDGETS.firstContentfulPaintMs} ms (measured ${fcp.toFixed(0)} ms)`,
  ).toBeLessThanOrEqual(BUDGETS.firstContentfulPaintMs);
});

test("reaches an interactive map inside the budget @performance", async ({
  page,
}) => {
  test.skip(skipBudgets, "PERFORMANCE_SKIP_BUDGETS=1");

  await page.goto("/");
  // The wind canvas mounts only once the first forecast grid is decoded and on
  // the map, so its appearance is the user-visible "map is ready" signal.
  await expect(page.locator(".map-canvas--wind")).toBeVisible({
    timeout: 15_000,
  });
  const interactive = await page.evaluate(() => performance.now());

  expect(
    interactive,
    `budget "interactive map": <= ${BUDGETS.interactiveMapMs} ms to the first decoded grid (measured ${interactive.toFixed(0)} ms)`,
  ).toBeLessThanOrEqual(BUDGETS.interactiveMapMs);
});

test("holds steady frame time over the animation sample @performance", async ({
  page,
}) => {
  test.skip(skipBudgets, "PERFORMANCE_SKIP_BUDGETS=1");

  await page.goto("/");
  await expect(page.locator(".map-canvas--wind")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(500);

  const stats = await frameStats(page, FRAME_SAMPLES);
  console.info(
    `frame intervals over ${stats.samples} frames: median ${stats.median.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, worst ${stats.worst.toFixed(1)} ms`,
  );

  expect(
    stats.samples,
    `budget "frame time": expected ${FRAME_SAMPLES} animation frames`,
  ).toBe(FRAME_SAMPLES);
  expect(
    stats.median,
    `budget "frame time (median)": <= ${BUDGETS.frameIntervalMedianMs} ms between frames (measured ${stats.median.toFixed(1)} ms)`,
  ).toBeLessThanOrEqual(BUDGETS.frameIntervalMedianMs);
  expect(
    stats.p95,
    `budget "frame time (p95)": <= ${BUDGETS.frameIntervalP95Ms} ms between frames (measured ${stats.p95.toFixed(1)} ms)`,
  ).toBeLessThanOrEqual(BUDGETS.frameIntervalP95Ms);
});

test("holds the JS heap after thirty seconds of animation @performance", async ({
  page,
}) => {
  // Default 30 s test timeout is shorter than navigation + the 30 s observation window below.
  test.setTimeout(120_000);
  test.skip(skipBudgets, "PERFORMANCE_SKIP_BUDGETS=1");

  await page.goto("/");
  await expect(page.locator(".map-canvas--wind")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(30_000);

  const heap = await usedHeapMb(page);
  test.skip(heap === null, "performance.memory is unavailable in this browser");

  const heapMb = (heap ?? 0) / MEGABYTE;
  console.info(`used JS heap after 30 s: ${heapMb.toFixed(1)} MB`);
  expect(
    heapMb,
    `budget "heap after 30 s": <= ${BUDGETS.heapAfter30sMb} MB (measured ${heapMb.toFixed(1)} MB)`,
  ).toBeLessThanOrEqual(BUDGETS.heapAfter30sMb);
});

test("does not grow the JS heap across three zoom and pan cycles @performance", async ({
  page,
}) => {
  test.skip(skipBudgets, "PERFORMANCE_SKIP_BUDGETS=1");

  await page.goto("/");
  await expect(page.locator(".map-canvas--wind")).toBeVisible({
    timeout: 15_000,
  });

  // Warm up so first-cycle allocations (render targets, buffers) are not
  // mistaken for a leak.
  await churnOnce(page);
  const before = await usedHeapMb(page);
  test.skip(
    before === null,
    "performance.memory is unavailable in this browser",
  );

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await churnOnce(page);
  }
  const after = await usedHeapMb(page);

  const growthMb = ((after ?? 0) - (before ?? 0)) / MEGABYTE;
  console.info(`heap growth across three cycles: ${growthMb.toFixed(1)} MB`);
  expect(
    growthMb,
    `budget "heap growth per 3 cycles": <= ${BUDGETS.heapGrowthPerThreeCyclesMb} MB (measured ${growthMb.toFixed(1)} MB)`,
  ).toBeLessThanOrEqual(BUDGETS.heapGrowthPerThreeCyclesMb);
});
