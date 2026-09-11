import { expect, test, type Page } from "@playwright/test";

import { gridName, openWithFixture } from "./helpers/windFixture";

/**
 * Height (10 m / 100 m) and gust toggles: which grid each selection requests, and
 * how a run that does not publish a level everywhere degrades instead of
 * breaking.
 */

const GRID_ALERT = 'p.freshness-warning[role="alert"]';

function requestedUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

test("switching the height requests the matching grid and marks the selection", async ({
  page,
}) => {
  const { runId } = await openWithFixture(page, { steps: [0, 3] });
  const urls = requestedUrls(page);

  const ten = page.locator('[data-level="10"]');
  const hundred = page.locator('[data-level="100"]');
  await expect(ten).toHaveAttribute("aria-checked", "true");
  await expect(hundred).toHaveAttribute("aria-checked", "false");

  await hundred.click();

  await expect(hundred).toHaveAttribute("aria-checked", "true");
  await expect(ten).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".source-line")).toContainText("ارتفاع 100 م");
  await expect
    .poll(() =>
      urls.some((url) => url.endsWith(`/${gridName(runId, 0, "wind-100m")}`)),
    )
    .toBe(true);

  await ten.click();
  await expect(ten).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() =>
      urls.some((url) => url.endsWith(`/${gridName(runId, 0, "wind-10m")}`)),
    )
    .toBe(true);
});

test("the gusts toggle requests the gust grid and reports its state", async ({
  page,
}) => {
  const { runId } = await openWithFixture(page, { steps: [0, 3] });
  const urls = requestedUrls(page);

  const gusts = page.locator(".wind-timeline__gusts");
  await expect(gusts).toBeEnabled();
  await expect(gusts).toHaveAttribute("aria-pressed", "false");

  await gusts.click();

  await expect(gusts).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".source-line")).toContainText("هبّات");
  await expect
    .poll(() =>
      urls.some((url) => url.endsWith(`/${gridName(runId, 0, "gust-10m")}`)),
    )
    .toBe(true);

  await gusts.click();
  await expect(gusts).toHaveAttribute("aria-pressed", "false");
});

test("disables a height the run does not publish instead of breaking", async ({
  page,
}) => {
  await openWithFixture(page, { steps: [0, 3], gridKeys: ["wind-10m"] });

  const ten = page.locator('[data-level="10"]');
  const hundred = page.locator('[data-level="100"]');
  const gusts = page.locator(".wind-timeline__gusts");

  await expect(ten).toBeEnabled();
  await expect(ten).toHaveAttribute("aria-checked", "true");
  await expect(hundred).toBeDisabled();
  await expect(hundred).toHaveAttribute("aria-checked", "false");
  await expect(gusts).toBeDisabled();

  // A run missing a level still renders the map and the timeline.
  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect(page.locator(".wind-timeline")).toBeVisible();
  await expect(page.locator(GRID_ALERT)).toHaveCount(0);
});

test("a height missing from a later frame falls back to the newest frame that has it", async ({
  page,
}) => {
  const { runId } = await openWithFixture(page, {
    steps: [0, 3],
    framesGridKeys: [["wind-10m", "wind-100m"], ["wind-10m"]],
  });
  const urls = requestedUrls(page);

  // 100 m is published somewhere in the run, so the toggle stays enabled.
  await page.locator('[data-level="100"]').click();
  await expect
    .poll(() =>
      urls.some((url) => url.endsWith(`/${gridName(runId, 0, "wind-100m")}`)),
    )
    .toBe(true);

  await page.locator(".wind-timeline__range").focus();
  await page.keyboard.press("End");

  await expect(page.locator(".wind-timeline")).toHaveAttribute(
    "data-frame-step",
    "3",
  );
  // The frame that carries 100 m is reused, so nothing errors and the map stays.
  await expect(page.locator(GRID_ALERT)).toHaveCount(0);
  await expect
    .poll(
      () =>
        urls.filter((url) =>
          url.endsWith(`/${gridName(runId, 0, "wind-100m")}`),
        ).length,
    )
    .toBeGreaterThanOrEqual(1);
});
