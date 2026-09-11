import { expect, test, type Page } from "@playwright/test";

import {
  buildManifest,
  gridBytes,
  gridKeyFromName,
  installWindManifest,
} from "./helpers/windFixture";

/**
 * Resilience: a failed forecast grid must surface an error the user can read
 * without a broken page, and the next successful load must recover.
 *
 * The map renders a single frame — the forecast step nearest now — so the
 * failure is aimed at that frame's 10 m grid. There is no scrubber to step away
 * and back with any more; the user's retry is a reload, and `WindGridCache` keeps
 * decoded grids in memory only, so a reload re-requests the grid.
 */

const GRID_ALERT = 'p.freshness-warning[role="alert"]';
const GRID_ROUTE = "**/api/wind/grids/*.bin";
const STEPS = [0, 3];

interface Failure {
  /** Returns true while the request should fail. */
  active: () => boolean;
  /** `fulfill` returns a 503 with Arabic copy; `abort` drops the connection. */
  mode: "http" | "network";
}

/** Serves the fixture grids, failing the current frame's 10 m grid while `active`. */
async function serveGrids(page: Page, failure: Failure): Promise<void> {
  await page.route(GRID_ROUTE, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const key = gridKeyFromName(name);
    if (!key) return route.fulfill({ status: 404, body: "" });
    if (key === "wind-10m" && failure.active()) {
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

async function openWithFailingGrid(
  page: Page,
  failure: Failure,
): Promise<void> {
  const manifest = buildManifest({
    steps: STEPS,
    gridKeys: ["wind-10m"],
  }) as { runId: string };
  await installWindManifest(page, manifest);
  await serveGrids(page, failure);
  await page.goto("/");
}

test("shows the Arabic error state when a forecast grid fails and recovers on retry", async ({
  page,
}) => {
  let failing = true;
  await openWithFailingGrid(page, { active: () => failing, mode: "http" });
  const alert = page.locator(GRID_ALERT);

  await expect(alert).toContainText("تعذر تحميل شبكة الرياح.");
  // A failed grid never blanks the page: the shell and its error stay readable.
  await expect(
    page.getByRole("heading", { name: "رياح السعودية" }),
  ).toBeVisible();

  // The retry path: the next successful load renders the map and clears the error.
  failing = false;
  await page.reload();
  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("keeps the page usable when a grid request is dropped", async ({
  page,
}) => {
  let dropping = true;
  await openWithFailingGrid(page, { active: () => dropping, mode: "network" });
  const alert = page.locator(GRID_ALERT);

  await expect(alert).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "رياح السعودية" }),
  ).toBeVisible();

  dropping = false;
  await page.reload();
  await expect(page.locator(".map-canvas--wind")).toBeVisible();
  await expect(alert).toHaveCount(0);
});
