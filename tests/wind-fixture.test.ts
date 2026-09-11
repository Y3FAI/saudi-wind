import { describe, expect, it } from "vitest";

import { frameForTime, parseWindManifest } from "../src/lib/wind";
import {
  ALL_GRID_KEYS,
  buildManifest,
  currentHourModelRun,
  gridKeyFromName,
  gridName,
  gridReference,
  recentModelRun,
  RUN_GRID,
  validTimeFor,
} from "./helpers/windFixture";

/**
 * Guards the Playwright fixture builder itself: if the synthetic manifest stops
 * satisfying the real parser, the browser specs would fail for the wrong reason.
 */
describe("Playwright wind fixture", () => {
  it("builds a manifest the real parser accepts with every grid key", () => {
    const manifest = parseWindManifest(buildManifest({ steps: [0, 3, 6] }));

    expect(manifest.frames.map((frame) => frame.step)).toEqual([0, 3, 6]);
    expect(manifest.frames.map((frame) => frame.validTime)).toEqual([
      validTimeFor(manifest.modelRun, 0),
      validTimeFor(manifest.modelRun, 3),
      validTimeFor(manifest.modelRun, 6),
    ]);
    expect(manifest.levels).toEqual([10, 100]);
    expect(manifest.variables).toEqual(["wind", "gust"]);
    expect(manifest.grid.width).toBe(RUN_GRID.width);
    expect(manifest.data.url).toContain("-f000-wind-10m.bin");
    for (const frame of manifest.frames) {
      for (const key of ALL_GRID_KEYS) {
        const reference = frame.grids[key];
        expect(reference?.byteLength).toBe(
          RUN_GRID.width * RUN_GRID.height * 8,
        );
        expect(reference?.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it("builds a ten metre only run", () => {
    const manifest = parseWindManifest(
      buildManifest({ steps: [0, 3], gridKeys: ["wind-10m"] }),
    );

    expect(manifest.levels).toEqual([10]);
    expect(manifest.variables).toEqual(["wind"]);
    expect(manifest.frames[0].grids["wind-100m"]).toBeUndefined();
    expect(manifest.frames[0].grids["gust-10m"]).toBeUndefined();
  });

  it("builds a frame that omits the 100 m grid", () => {
    const manifest = parseWindManifest(
      buildManifest({
        steps: [0, 3],
        framesGridKeys: [["wind-10m", "wind-100m"], ["wind-10m"]],
      }),
    );

    expect(manifest.frames[0].grids["wind-100m"]).toBeDefined();
    expect(manifest.frames[1].grids["wind-100m"]).toBeUndefined();
    expect(manifest.levels).toEqual([10, 100]);
  });

  it("derives the run id and grid names from a model run", () => {
    const modelRun = currentHourModelRun(Date.parse("2026-09-10T12:34:56Z"));
    expect(modelRun).toBe("2026-09-10T12:00:00.000Z");
    const manifest = buildManifest({ modelRun }) as { runId: string };
    expect(manifest.runId).toBe("gfs-20260910-12");
    expect(gridName(manifest.runId, 3, "wind-100m")).toBe(
      "gfs-20260910-12-f003-wind-100m.bin",
    );
    expect(gridReference(manifest.runId, 3, "wind-100m").url).toBe(
      "/api/wind/grids/gfs-20260910-12-f003-wind-100m.bin",
    );
  });

  it("reads grid keys back out of file names", () => {
    expect(gridKeyFromName("gfs-20260910-12-f003-wind-100m.bin")).toBe(
      "wind-100m",
    );
    expect(gridKeyFromName("gfs-20260910-12-f120-gust-10m.bin")).toBe(
      "gust-10m",
    );
    expect(gridKeyFromName("latest.json")).toBeNull();
  });

  it("defaults a run pinned just before now to the current frame", () => {
    const now = Date.parse("2026-09-11T12:34:56Z");
    const frames = parseWindManifest(
      buildManifest({ steps: [0, 3, 6, 9], modelRun: recentModelRun(now) }),
    ).frames;

    // The map shows the frame nearest now; a run pinned a quarter hour back
    // resolves to its first step for the whole span a spec can take.
    expect(frameForTime(frames, now).step).toBe(0);
  });
});
