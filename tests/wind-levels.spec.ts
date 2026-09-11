import { expect, test, type Page } from "@playwright/test";

import type { WindGridKey } from "../src/types/wind";
import { gridName, openWithFixture } from "./helpers/windFixture";

/**
 * Grid resolution for the single-field map.
 *
 * The map renders one field — the 10 m wind — so a run that publishes only that
 * grid renders it and requests it exactly once, and a run that does not publish
 * 10 m wind falls back to whatever it does publish instead of blanking.
 */

const GRID_ALERT = 'p.freshness-warning[role="alert"]';

function requestedUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

function fetchesOf(urls: string[], runId: string, key: WindGridKey): number {
  return urls.filter((url) => url.endsWith(`/${gridName(runId, 0, key)}`))
    .length;
}

test("renders and requests the 10 m grid for a ten metre only run", async ({
  page,
}) => {
  const urls = requestedUrls(page);
  const { runId } = await openWithFixture(page, {
    steps: [0, 3],
    gridKeys: ["wind-10m"],
  });

  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect.poll(() => fetchesOf(urls, runId, "wind-10m")).toBe(1);
  await expect(page.locator(GRID_ALERT)).toHaveCount(0);
});

test("falls back to the published grid when a run has no 10 m wind", async ({
  page,
}) => {
  const urls = requestedUrls(page);
  const { runId } = await openWithFixture(page, {
    steps: [0, 3],
    gridKeys: ["wind-100m"],
  });

  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect.poll(() => fetchesOf(urls, runId, "wind-100m")).toBe(1);
  await expect(page.locator(GRID_ALERT)).toHaveCount(0);
});
