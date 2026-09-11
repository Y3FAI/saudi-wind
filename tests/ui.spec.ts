import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const SAMPLE_MANIFEST_PATH = "/data/processed/latest.json";

async function countVisibleTrailPixels(
  canvas: import("@playwright/test").Locator,
) {
  return canvas.evaluate((element) => {
    const windCanvas = element as HTMLCanvasElement;
    const context = windCanvas.getContext("webgl2");
    if (!context) return 0;

    const pixels = new Uint8Array(windCanvas.width * windCanvas.height * 4);
    context.readPixels(
      0,
      0,
      windCanvas.width,
      windCanvas.height,
      context.RGBA,
      context.UNSIGNED_BYTE,
      pixels,
    );

    let visible = 0;
    for (let index = 3; index < pixels.length; index += 16) {
      if (pixels[index] > 2) visible += 1;
    }
    return visible;
  });
}

test("loads with the complete Saudi framing and animated canvas", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "رياح السعودية" }),
  ).toBeVisible();
  const map = page.getByRole("application");
  await expect(map).toHaveAttribute("data-zoom", "1.00");
  await expect(map).toHaveAttribute("data-wind-style", "flow");
  await expect(map.locator(".map-canvas--wind")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("advances the visible wind trails between frames", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("application");
  await page.waitForTimeout(300);
  const firstFrame = await map.screenshot();
  await page.waitForTimeout(220);
  const secondFrame = await map.screenshot();

  expect(Buffer.compare(firstFrame, secondFrame)).not.toBe(0);
});

test("keeps trails populated through a tap and zoom", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("application");
  const canvas = map.locator(".map-canvas--wind");
  const bounds = await map.boundingBox();
  if (!bounds) throw new Error("Map bounds are unavailable.");

  await page.waitForTimeout(900);
  const before = await countVisibleTrailPixels(canvas);
  expect(before).toBeGreaterThan(200);

  // A tap is an inspection now, not a zoom: it must not blank the moving trails.
  await map.click({
    position: { x: bounds.width * 0.63, y: bounds.height * 0.51 },
  });
  await page.waitForTimeout(80);
  const afterTap = await countVisibleTrailPixels(canvas);
  expect(afterTap).toBeGreaterThan(before * 0.35);

  // The on-screen zoom buttons were removed; the keyboard is the surviving
  // control surface.
  await map.focus();
  await page.keyboard.press("+");
  await page.waitForTimeout(80);
  const afterZoom = await countVisibleTrailPixels(canvas);
  expect(afterZoom).toBeGreaterThan(before * 0.15);
});

test("zooms and returns to the approved initial framing", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("application");

  await map.focus();
  await page.keyboard.press("+");
  await expect(map).not.toHaveAttribute("data-zoom", "1.00");
  await page.keyboard.press("Home");
  await expect(map).toHaveAttribute("data-zoom", "1.00");
});

test("supports keyboard navigation", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("application");
  await map.focus();

  await page.keyboard.press("+");
  await expect(map).not.toHaveAttribute("data-zoom", "1.00");
  await page.keyboard.press("Home");
  await expect(map).toHaveAttribute("data-zoom", "1.00");
});

test("shows a static frame when reduced motion is requested", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  // The map mounts only once a grid has loaded, so wait for it before probing
  // the attribute rather than racing the first fetch.
  await expect(page.getByRole("application")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("application")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
  await expect(
    page.getByText("تم إيقاف الحركة حسب إعدادات الجهاز"),
  ).toBeVisible();
});

test("explains when WebGL2 is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      ...options: unknown[]
    ) {
      if (contextId === "webgl2") return null;
      return original.call(this, contextId, ...options);
    } as typeof original;
  });
  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("تعذر تحريك الرياح");
});

test("marks the last valid grid stale after twelve hours", async ({ page }) => {
  const original = JSON.parse(
    await readFile(
      new URL("../public/data/processed/latest.json", import.meta.url),
      "utf8",
    ),
  );
  // A stale manifest has to stay internally consistent: the parser rejects any
  // frame whose validTime is not modelRun + step hours, so age the run *and*
  // shift every frame by its own step instead of flattening them all.
  const staleRun = Date.parse("2020-01-01T00:00:00Z");
  const agedFrame = (frame: Record<string, unknown>) => ({
    ...frame,
    validTime: new Date(
      staleRun + Number(frame.step) * 3_600_000,
    ).toISOString(),
  });
  await page.route(`**${SAMPLE_MANIFEST_PATH}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...original,
        sample: false,
        modelRun: new Date(staleRun).toISOString(),
        validTime: new Date(staleRun).toISOString(),
        publishedAt: new Date(staleRun + 4 * 3_600_000).toISOString(),
        frames: (original.frames as Array<Record<string, unknown>>).map(
          agedFrame,
        ),
      }),
    }),
  );
  await page.goto("/");

  // The freshness pill was removed; the panel's own stale warning is the
  // surviving signal, and no badge may reintroduce the old chrome.
  //
  // The panel only renders once a grid has loaded, so wait for the map first
  // rather than racing the first fetch (this spec failed intermittently under
  // CI load when it asserted straight after goto).
  await expect(page.getByRole("application")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("آخر بيانات صالحة أقدم من 12 ساعة"),
  ).toBeVisible();
  await expect(page.locator(".sample-badge")).toHaveCount(0);
  await expect(page.getByText("NOAA GFS · بيانات حديثة")).toHaveCount(0);
});

test("explains when no valid dataset has ever loaded", async ({ page }) => {
  await page.route(`**${SAMPLE_MANIFEST_PATH}`, (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText(
    "لا تتوفر حالياً بيانات رياح صالحة",
  );
  await expect(page.getByRole("application")).toHaveCount(0);
});
