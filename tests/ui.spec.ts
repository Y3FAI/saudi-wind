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

  // A tap on the map is inert now: it must not blank the moving trails.
  await map.click({
    position: { x: bounds.width * 0.63, y: bounds.height * 0.51 },
  });
  await page.waitForTimeout(80);
  const afterTap = await countVisibleTrailPixels(canvas);
  expect(afterTap).toBeGreaterThan(before * 0.35);

  await page.getByRole("button", { name: "تكبير" }).click();
  await page.waitForTimeout(80);
  const afterZoom = await countVisibleTrailPixels(canvas);
  expect(afterZoom).toBeGreaterThan(before * 0.15);
});

test("zooms and returns to the approved initial framing", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("application");

  await page.getByRole("button", { name: "تكبير" }).click();
  await expect(map).not.toHaveAttribute("data-zoom", "1.00");
  await page.getByRole("button", { name: "إعادة" }).click();
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
  // frame whose validTime is not modelRun + step hours, so age the frame too.
  const staleRun = "2020-01-01T00:00:00Z";
  await page.route(`**${SAMPLE_MANIFEST_PATH}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...original,
        sample: false,
        modelRun: staleRun,
        validTime: staleRun,
        publishedAt: "2020-01-01T04:00:00Z",
        frames: (original.frames as Array<Record<string, unknown>>).map(
          (frame) => ({ ...frame, validTime: staleRun }),
        ),
      }),
    }),
  );
  await page.goto("/");

  await expect(page.getByText("NOAA GFS · آخر بيانات متاحة")).toBeVisible();
  await expect(
    page.getByText("آخر بيانات صالحة أقدم من 12 ساعة"),
  ).toBeVisible();
  await expect(page.getByRole("application")).toBeVisible();
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
