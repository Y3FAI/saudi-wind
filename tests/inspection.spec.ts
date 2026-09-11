import { expect, test, type Locator, type Page } from "@playwright/test";
import { geoContains, geoMercator, type GeoProjection } from "d3-geo";
import { readFileSync } from "node:fs";

import { formatKmh } from "../src/lib/format";
import {
  CITIES,
  fastestCity,
  nearestCity,
  pointSpeedKmh,
  slowestCity,
} from "../src/lib/inspection";
import type { SaudiBoundary } from "../src/types/geo";
import { RUN_GRID, gridVectors, openWithFixture } from "./helpers/windFixture";

/**
 * The information panel's statistics and the click-to-inspect readout.
 *
 * Both come from the decoded grid rather than the manifest, so this spec serves
 * its own deterministic fixture and recomputes every expected value with the
 * same sampling helpers the app uses: a different fastest city, or a readout
 * that ignores the click, fails by name.
 */

const boundary = JSON.parse(
  readFileSync(
    new URL("../public/data/saudi-boundary.geo.json", import.meta.url),
    "utf8",
  ),
) as SaudiBoundary;

const vectors = gridVectors("wind-10m");
const RIYADH = CITIES[0];
/** The Empty Quarter: inside the country and the grid, far from every label. */
const REMOTE_POINT: [number, number] = [48.5, 19.5];

/** The first stat row, the one click-to-inspect rewrites. */
function headline(page: Page): Locator {
  return page.locator(".statistics > div[data-selected]");
}

/** The dt of a stat row carrying `label`. */
function cityRow(page: Page, label: string): Locator {
  return page.locator(".statistics > div").filter({ hasText: label });
}

/**
 * The Mercator projection the map fits to its own container, so a spec can click
 * a geographic location. `inset` mirrors `createProjection` in `WindMap`, and
 * the box comes from the live layout.
 */
async function mapProjection(
  page: Page,
): Promise<{ projection: GeoProjection; box: { x: number; y: number } }> {
  const box = await page.getByRole("application").boundingBox();
  if (!box) throw new Error("the map has no layout box");
  const inset = box.width < 680 ? 18 : 42;
  const projection = geoMercator().fitExtent(
    [
      [inset, inset],
      [box.width - inset, box.height - inset],
    ],
    boundary,
  );
  return { projection, box };
}

/** The page coordinates of a location, with the location the click will invert to. */
async function projectToScreen(
  page: Page,
  coordinates: [number, number],
): Promise<{ x: number; y: number; inverted: [number, number] }> {
  const { projection, box } = await mapProjection(page);
  const point = projection(coordinates);
  const inverted = point ? projection.invert?.(point) : null;
  if (!point || !inverted) throw new Error("the projection is not invertible");
  return { x: box.x + point[0], y: box.y + point[1], inverted };
}

test("reports the fastest and slowest city from the decoded grid", async ({
  page,
}) => {
  const fastest = fastestCity(vectors, RUN_GRID);
  const slowest = slowestCity(vectors, RUN_GRID);
  expect(
    fastest,
    "the fixture grid must cover the labelled cities",
  ).not.toBeNull();
  expect(
    slowest,
    "the fixture grid must cover the labelled cities",
  ).not.toBeNull();

  await openWithFixture(page, { steps: [0], gridKeys: ["wind-10m"] });

  const fastestRow = cityRow(page, "أسرع مدينة");
  const slowestRow = cityRow(page, "أبطأ مدينة");
  await expect(fastestRow).toBeVisible();
  await expect(slowestRow).toBeVisible();

  // A city name and its speed, in the same shape as the average above them.
  await expect(fastestRow.locator(".statistics-city")).toHaveText(
    fastest?.city.name ?? "",
  );
  await expect(fastestRow.locator("dd bdi").nth(1)).toHaveText(
    formatKmh(fastest?.speedKmh ?? Number.NaN),
  );
  await expect(fastestRow.locator("dd bdi").nth(1)).toHaveText(/^\d+\.\d$/);
  await expect(fastestRow.locator("dd span")).toHaveText("كم/س");

  await expect(slowestRow.locator(".statistics-city")).toHaveText(
    slowest?.city.name ?? "",
  );
  await expect(slowestRow.locator("dd bdi").nth(1)).toHaveText(
    formatKmh(slowest?.speedKmh ?? Number.NaN),
  );
  await expect(slowestRow.locator("dd span")).toHaveText("كم/س");

  // The grid-cell maximum is gone from the panel.
  await expect(page.getByText("أعلى خلية في النموذج")).toHaveCount(0);
});

test("starts on the country average and names the clicked city on click", async ({
  page,
}) => {
  await openWithFixture(page, { steps: [0], gridKeys: ["wind-10m"] });

  await expect(headline(page)).toHaveAttribute("data-selected", "false");
  await expect(headline(page).locator("dt")).toHaveText("متوسط السرعة");
  await expect(headline(page).locator("dd bdi").first()).toHaveText("18.4");

  const target = await projectToScreen(page, RIYADH.coordinates);
  expect(
    geoContains(boundary, target.inverted),
    "the fixture boundary must contain the clicked city",
  ).toBe(true);

  await page.mouse.click(target.x, target.y);

  await expect(headline(page)).toHaveAttribute("data-selected", "true");
  await expect(headline(page).locator("dt")).toHaveText(RIYADH.name);
  await expect(headline(page).locator("dd bdi").first()).toHaveText(
    formatKmh(
      pointSpeedKmh(
        vectors,
        RUN_GRID,
        target.inverted[0],
        target.inverted[1],
      ) ?? Number.NaN,
    ),
  );
  await expect(headline(page).locator("dd bdi").first()).not.toHaveText("18.4");
  expect(nearestCity(target.inverted)?.name).toBe(RIYADH.name);
});

test("labels a click far from every city as الموقع المحدد", async ({
  page,
}) => {
  expect(nearestCity(REMOTE_POINT), "the point must be remote").toBeNull();
  expect(geoContains(boundary, REMOTE_POINT)).toBe(true);

  await openWithFixture(page, { steps: [0], gridKeys: ["wind-10m"] });
  const target = await projectToScreen(page, REMOTE_POINT);

  await page.mouse.click(target.x, target.y);

  await expect(headline(page)).toHaveAttribute("data-selected", "true");
  await expect(headline(page).locator("dt")).toHaveText("الموقع المحدد");
  await expect(headline(page).locator("dd bdi").first()).toHaveText(
    formatKmh(
      pointSpeedKmh(
        vectors,
        RUN_GRID,
        target.inverted[0],
        target.inverted[1],
      ) ?? Number.NaN,
    ),
  );
});

test("restores the country average on Escape and on a second click", async ({
  page,
}) => {
  await openWithFixture(page, { steps: [0], gridKeys: ["wind-10m"] });
  const target = await projectToScreen(page, RIYADH.coordinates);

  await page.mouse.click(target.x, target.y);
  await expect(headline(page)).toHaveAttribute("data-selected", "true");
  await expect(headline(page).locator("dt")).toHaveText(RIYADH.name);

  await page.keyboard.press("Escape");
  await expect(headline(page)).toHaveAttribute("data-selected", "false");
  await expect(headline(page).locator("dt")).toHaveText("متوسط السرعة");
  await expect(headline(page).locator("dd bdi").first()).toHaveText("18.4");

  await page.mouse.click(target.x, target.y);
  await expect(headline(page)).toHaveAttribute("data-selected", "true");
  await page.mouse.click(target.x, target.y);
  await expect(headline(page)).toHaveAttribute("data-selected", "false");
  await expect(headline(page).locator("dd bdi").first()).toHaveText("18.4");
});

test("ignores a click outside Saudi Arabia", async ({ page }) => {
  await openWithFixture(page, { steps: [0], gridKeys: ["wind-10m"] });

  const { projection, box } = await mapProjection(page);
  // The fitted top-left corner of the map: north-west of the country.
  const click = { x: box.x + 2, y: box.y + 2 };
  const inverted = projection.invert?.([2, 2]);
  expect(inverted, "the projection must be invertible").toBeTruthy();
  if (!inverted) return;
  expect(
    geoContains(boundary, inverted),
    "the clicked corner must fall outside the country",
  ).toBe(false);

  await page.mouse.click(click.x, click.y);

  await expect(headline(page)).toHaveAttribute("data-selected", "false");
  await expect(headline(page).locator("dt")).toHaveText("متوسط السرعة");
  await expect(headline(page).locator("dd bdi").first()).toHaveText("18.4");
});

test("does not inspect a point mid-drag", async ({ page }) => {
  await openWithFixture(page, { steps: [0], gridKeys: ["wind-10m"] });
  const target = await projectToScreen(page, RIYADH.coordinates);

  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 48, target.y + 32, { steps: 6 });
  await page.mouse.up();

  await expect(headline(page)).toHaveAttribute("data-selected", "false");
  await expect(headline(page).locator("dt")).toHaveText("متوسط السرعة");
});
