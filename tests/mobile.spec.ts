import { expect, test, type Page } from "@playwright/test";

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

test("keeps zoom, pan and inspection reachable without on-screen buttons", async ({
  page,
}) => {
  await page.goto("/");
  const map = page.getByRole("application");
  await expect(page.locator(".map-canvas--wind")).toBeVisible();

  // The zoom/reset buttons and the freshness pill were removed: the map itself
  // is the control surface, so no button may render on a phone.
  await expect(page.locator(".map-controls, .sample-badge")).toHaveCount(0);
  await expect(page.locator(".wind-map button, .map-stage button")).toHaveCount(
    0,
  );

  // All three stats render, the first one carrying the selection hook.
  await expect(page.locator(".statistics > div")).toHaveCount(3);
  await expect(
    page.locator(".statistics > div[data-selected]"),
  ).toHaveAttribute("data-selected", "false");

  // Zoom and reset survive the chrome removal, by double-tap and by keyboard.
  const box = await map.boundingBox();
  expect(box, "the map must have a layout box").not.toBeNull();
  if (!box) return;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(map).not.toHaveAttribute("data-zoom", "1.00");

  await map.focus();
  await page.keyboard.press("Home");
  await expect(map).toHaveAttribute("data-zoom", "1.00");

  await page.keyboard.press("+");
  await expect(map).not.toHaveAttribute("data-zoom", "1.00");
});
