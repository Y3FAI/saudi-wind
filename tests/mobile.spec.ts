import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Mobile layout and touch ergonomics, pinned to a 360x640 viewport regardless of
 * the project so a small phone is always covered. Uses the served fixture, so it
 * exercises the real boundary, grid and frame wiring.
 */

test.use({
  viewport: { width: 360, height: 640 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});

const MIN_TAP_TARGET_PX = 44;

function tapTargets(page: Page): Locator {
  return page.locator(".map-controls button");
}

test("fits the map on a 360x640 phone without horizontal page scroll", async ({
  page,
}) => {
  await page.goto("/");

  const map = page.getByRole("application");
  await expect(map).toBeVisible();
  await expect(page.locator(".map-canvas--wind")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `budget "mobile layout": document must not scroll horizontally at 360x640 (scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);

  const viewport = page.viewportSize();
  const box = await map.boundingBox();
  expect(box, "the map must have a layout box").not.toBeNull();
  if (!box || !viewport) return;
  expect(
    Math.round(box.x),
    'budget "mobile layout": the map must not be clipped on the left',
  ).toBeGreaterThanOrEqual(-1);
  expect(
    Math.round(box.x + box.width),
    'budget "mobile layout": the map must not be clipped on the right',
  ).toBeLessThanOrEqual(viewport.width + 1);
});

test("keeps every map control a reachable tap target", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".map-canvas--wind")).toBeVisible();

  const targets = tapTargets(page);
  const count = await targets.count();
  expect(count, "controls must render on a phone").toBeGreaterThanOrEqual(3);

  for (let index = 0; index < count; index += 1) {
    const target = targets.nth(index);
    const label =
      (await target.getAttribute("aria-label")) ??
      (await target.textContent()) ??
      `control ${index}`;
    const box = await target.boundingBox();
    expect(box, `control "${label}" must be laid out`).not.toBeNull();
    if (!box) continue;
    expect(
      Math.round(box.height),
      `budget "touch target": control "${label}" must be >= ${MIN_TAP_TARGET_PX}px tall`,
    ).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(
      Math.round(box.width),
      `budget "touch target": control "${label}" must be >= ${MIN_TAP_TARGET_PX}px wide`,
    ).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
  }
});
