import { expect, test, type Page } from "@playwright/test";

import {
  buildManifest,
  gridBytes,
  gridKeyFromName,
  gridName,
  installWindManifest,
} from "./helpers/windFixture";

/**
 * Resilience: a failed forecast grid must surface an error the user can read
 * without blanking the map, and the next successful load must recover.
 *
 * The single-frame version-one fixture has one grid, so these specs serve a
 * two-frame manifest and steer the failure at the second frame. `WindGridCache`
 * drops a failed entry on the next request, so stepping away and back re-fetches
 * it — that is the retry path the user has.
 */

const GRID_ALERT = 'p.freshness-warning[role="alert"]';
const GRID_ROUTE = "**/api/wind/grids/*.bin";
const STEPS = [0, 3];

interface Failure {
  /** Grid file the failure is aimed at. */
  target: string;
  /** Returns true while the request should fail. */
  active: () => boolean;
  /** `fulfill` returns a 503 with Arabic copy; `abort` drops the connection. */
  mode: "http" | "network";
}

/** Serves the fixture grids, failing the targeted request while `active`. */
async function serveGrids(page: Page, failure: Failure): Promise<void> {
  await page.route(GRID_ROUTE, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const key = gridKeyFromName(name);
    if (!key) return route.fulfill({ status: 404, body: "" });
    if (name === failure.target && failure.active()) {
      return failure.mode === "network"
        ? route.abort("connectionfailed")
        : route.fulfill({
            status: 503,
            contentType: "text/plain",
            body: "unavailable",
          });
    }
    return route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(gridBytes(key)),
    });
  });
}

async function openFailingFrame(
  page: Page,
  failure: Omit<Failure, "target">,
): Promise<void> {
  const manifest = buildManifest({ steps: STEPS, gridKeys: ["wind-10m"] }) as {
    runId: string;
  };
  await installWindManifest(page, manifest);
  await serveGrids(page, {
    ...failure,
    target: gridName(manifest.runId, STEPS[1], "wind-10m"),
  });
  await page.goto("/");
  await expect(page.locator(".wind-timeline")).toBeVisible();
}

/** Steps away from the failed frame and back, the in-app retry path. */
async function retrySecondFrame(page: Page): Promise<void> {
  await page.keyboard.press("Home");
  await expect(page.locator(GRID_ALERT)).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(page.locator(".wind-timeline")).toHaveAttribute(
    "data-frame-step",
    String(STEPS[1]),
  );
}

async function scrubToSecondFrame(page: Page): Promise<void> {
  await page.locator(".wind-timeline__range").focus();
  await page.keyboard.press("End");
  await expect(page.locator(".wind-timeline")).toHaveAttribute(
    "data-frame-step",
    String(STEPS[1]),
  );
}

test("shows the Arabic error state when a forecast grid fails and recovers on retry", async ({
  page,
}) => {
  let failing = true;
  await openFailingFrame(page, { active: () => failing, mode: "http" });
  const alert = page.locator(GRID_ALERT);
  await expect(alert).toHaveCount(0);

  await scrubToSecondFrame(page);

  await expect(alert).toContainText("تعذر تحميل شبكة الرياح.");
  // A failed grid never blanks the map: the previous frame stays up.
  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect(page.locator(".wind-timeline")).toBeVisible();

  failing = false;
  await retrySecondFrame(page);
  await expect(alert).toHaveCount(0);
});

test("keeps serving the last good frame when a grid request is dropped", async ({
  page,
}) => {
  let dropping = true;
  await openFailingFrame(page, { active: () => dropping, mode: "network" });
  const alert = page.locator(GRID_ALERT);

  await scrubToSecondFrame(page);
  await expect(alert).toBeVisible();
  await expect(page.locator(".map-canvas--wind")).toBeVisible();

  dropping = false;
  await retrySecondFrame(page);
  await expect(alert).toHaveCount(0);
});
