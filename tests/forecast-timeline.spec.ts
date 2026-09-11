import { expect, test, type Page } from "@playwright/test";

import {
  gridName,
  openWithFixture,
  recentModelRun,
} from "./helpers/windFixture";

/**
 * Forecast timeline: the scrubber, its label, the grid it requests, playback and
 * keyboard stepping.
 *
 * The manifest is pinned 15 minutes before now so "now" is a real forecast step
 * and the Arabic hour labels are stable; see `recentModelRun`.
 */

const STEPS = [0, 3, 6, 9];
const LAST_STEP = STEPS[STEPS.length - 1];
const MODEL_RUN = recentModelRun();

async function openTimeline(page: Page) {
  return openWithFixture(page, { steps: STEPS, modelRun: MODEL_RUN });
}

function requestedUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

test("defaults the scrubber to the forecast frame nearest now", async ({
  page,
}) => {
  await openTimeline(page);

  const timeline = page.locator(".wind-timeline");
  await expect(timeline).toHaveAttribute("data-frame-step", "0");
  await expect(page.locator(".wind-timeline__range")).toHaveValue("0");
  await expect(page.locator(".wind-timeline__range")).toBeEnabled();
  await expect(page.locator(".wind-timeline__label")).toHaveText("الآن");
  await expect(page.locator(".wind-timeline")).toHaveAttribute(
    "data-playing",
    "false",
  );
});

test("scrubbing changes the label and requests the matching forecast grid", async ({
  page,
}) => {
  const { runId } = await openTimeline(page);
  const urls = requestedUrls(page);
  const range = page.locator(".wind-timeline__range");

  await range.focus();
  await page.keyboard.press("ArrowRight");

  await expect(page.locator(".wind-timeline")).toHaveAttribute(
    "data-frame-step",
    "3",
  );
  await expect(page.locator(".wind-timeline__label")).toHaveText("+3 س");
  await expect
    .poll(() =>
      urls.some((url) => url.endsWith(`/${gridName(runId, 3, "wind-10m")}`)),
    )
    .toBe(true);

  await page.keyboard.press("End");
  await expect(page.locator(".wind-timeline")).toHaveAttribute(
    "data-frame-step",
    String(LAST_STEP),
  );
  await expect(page.locator(".wind-timeline__label")).toHaveText("+9 س");
  await expect
    .poll(() =>
      urls.some((url) =>
        url.endsWith(`/${gridName(runId, LAST_STEP, "wind-10m")}`),
      ),
    )
    .toBe(true);
});

test("play advances the forecast and stops on the final frame", async ({
  page,
}) => {
  await openTimeline(page);

  const timeline = page.locator(".wind-timeline");
  const play = page.locator(".wind-timeline__play");
  await expect(play).toHaveAttribute("aria-label", "تشغيل العرض الزمني");

  await play.click();
  await expect(timeline).toHaveAttribute("data-playing", "true");
  await expect(play).toHaveAttribute("aria-label", "إيقاف العرض الزمني");

  await expect(timeline).toHaveAttribute("data-frame-step", String(LAST_STEP), {
    timeout: 15_000,
  });
  await expect(timeline).toHaveAttribute("data-playing", "false", {
    timeout: 15_000,
  });

  // Stopping at the end means it did not wrap back to the first frame.
  await page.waitForTimeout(1_200);
  await expect(timeline).toHaveAttribute("data-frame-step", String(LAST_STEP));
});

test("arrow keys step the scrubber without panning the map", async ({
  page,
}) => {
  await openTimeline(page);

  const timeline = page.locator(".wind-timeline");
  const map = page.getByRole("application");
  await page.locator(".wind-timeline__range").focus();

  await page.keyboard.press("ArrowRight");
  await expect(timeline).toHaveAttribute("data-frame-step", "3");
  await page.keyboard.press("ArrowRight");
  await expect(timeline).toHaveAttribute("data-frame-step", "6");
  await page.keyboard.press("ArrowLeft");
  await expect(timeline).toHaveAttribute("data-frame-step", "3");
  await page.keyboard.press("Home");
  await expect(timeline).toHaveAttribute("data-frame-step", "0");

  // The timeline stops the key event: the map must not pan underneath it.
  await expect(map).toHaveAttribute("data-zoom", "1.00");
});
