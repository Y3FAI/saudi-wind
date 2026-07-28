import { expect, test } from "@playwright/test";

test("loads with the complete Saudi framing and animated canvas", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "رياح السعودية" }),
  ).toBeVisible();
  const map = page.getByRole("application");
  await expect(map).toHaveAttribute("data-zoom", "1.00");
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

test("zooms and returns to the approved initial framing", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("application");

  await page.getByRole("button", { name: "تكبير" }).click();
  await expect(map).not.toHaveAttribute("data-zoom", "1.00");
  await page.getByRole("button", { name: "إعادة" }).click();
  await expect(map).toHaveAttribute("data-zoom", "1.00");
});

test("inspects an inside point and ignores an outside point", async ({
  page,
}) => {
  await page.goto("/");
  const map = page.getByRole("application");
  const bounds = await map.boundingBox();
  if (!bounds) throw new Error("Map bounds are unavailable.");

  await map.click({
    position: { x: bounds.width * 0.63, y: bounds.height * 0.51 },
  });
  await expect(page.getByText("الموقع المحدد")).toBeVisible();
  const readout = page.locator(".location-readout");
  const selectedText = await readout.textContent();

  await map.click({ position: { x: 10, y: 10 } });
  await expect(readout).toHaveText(selectedText ?? "");
});

test("shows a static frame when reduced motion is requested", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

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
