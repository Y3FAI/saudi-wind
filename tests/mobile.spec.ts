import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Mobile layout and touch ergonomics, pinned to a 360x640 viewport regardless of
 * the project so a small phone is always covered. Uses the served fixture, so it
 * exercises the real boundary, grid and timeline wiring.
 */

test.use({
  viewport: { width: 360, height: 640 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});

const MIN_TAP_TARGET_PX = 44;

function tapTargets(page: Page): Locator {
  return page.locator(".map-controls button, .wind-timeline button");
}

test("fits the map on a 360x640 phone without horizontal page scroll", async ({
  page,
}) => {
  await page.goto("/");

  const map = page.getByRole("application");
  await expect(map).toBeVisible();
  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect(page.locator(".wind-timeline")).toBeVisible();

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

test("keeps every map and timeline control a reachable tap target", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".wind-timeline")).toBeVisible();

  const targets = tapTargets(page);
  const count = await targets.count();
  expect(count, "controls must render on a phone").toBeGreaterThanOrEqual(4);

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

  const range = await page.locator(".wind-timeline__range").boundingBox();
  expect(range, "the scrubber must be laid out").not.toBeNull();
  if (range) {
    expect(
      Math.round(range.height),
      `budget "touch target": the scrubber must be >= ${MIN_TAP_TARGET_PX}px tall`,
    ).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
  }
});

test("tap to inspect opens the readout and an outside tap does not", async ({
  page,
}) => {
  await page.goto("/");
  const map = page.getByRole("application");
  await expect(map).toBeVisible();
  const box = await map.boundingBox();
  expect(box, "the map must have a layout box").not.toBeNull();
  if (!box) return;

  await map.tap({ position: { x: box.width * 0.63, y: box.height * 0.51 } });

  await expect(page.getByText("الموقع المحدد")).toBeVisible();
  await expect(page.locator(".location-readout--active")).toBeVisible();
  await expect(page.locator(".location-coordinates bdi")).toHaveCount(2);
  const readout = page.locator(".location-readout");
  const selected = await readout.textContent();

  // A tap outside the Kingdom must not fabricate a new selection. There is no
  // explicit dismiss control: the last valid reading stays until the next one.
  await map.tap({ position: { x: box.width * 0.5, y: box.height - 8 } });
  await expect(readout).toHaveText(selected ?? "");
  await expect(page.locator(".location-readout--active")).toBeVisible();
});
