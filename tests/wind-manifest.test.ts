import { describe, expect, it } from "vitest";

import {
  availableGridKeys,
  availableLevels,
  frameForTime,
  frameGridIndex,
  parseWindManifest,
  validateManifest,
} from "../src/lib/wind";
import type { WindFrame } from "../src/types/wind";

const MODEL_RUN = "2026-09-10T12:00:00Z";
const EXPECTED_BYTES = 58200;

const grid = {
  west: 33,
  east: 57,
  south: 15,
  north: 33.5,
  width: 97,
  height: 75,
  dx: 0.25,
  dy: 0.25,
  scan: "north-to-south-west-to-east" as const,
};

const statistics = (mean: number, maximum: number) => ({
  areaWeightedMeanKmh: mean,
  maximumGridCellKmh: maximum,
});

const reference = (name: string) => ({
  url: `/api/wind/grids/${name}.bin`,
  encoding: "float32-le-uv-interleaved" as const,
  byteLength: EXPECTED_BYTES,
  sha256: "a".repeat(64),
});

const validTimeForStep = (step: number) =>
  new Date(Date.parse(MODEL_RUN) + step * 3_600_000).toISOString();

const framePrefix = (step: number) =>
  `gfs-20260910-12-f${String(step).padStart(3, "0")}`;

function buildFrame(step: number) {
  const prefix = framePrefix(step);
  return {
    step,
    validTime: validTimeForStep(step),
    grids: {
      "wind-10m": reference(`${prefix}-wind-10m`),
      "wind-100m": reference(`${prefix}-wind-100m`),
      "gust-10m": reference(`${prefix}-gust-10m`),
    },
    statistics: {
      "wind-10m": statistics(21.6, 44.2),
      "wind-100m": statistics(31.4, 61.8),
      "gust-10m": statistics(38.2, 79.5),
    },
  };
}

const v2Manifest = {
  schemaVersion: 2,
  runId: "gfs-20260910-12",
  provider: "NOAA_GFS",
  modelRun: MODEL_RUN,
  validTime: validTimeForStep(0),
  publishedAt: "2026-09-10T20:51:38Z",
  heightMeters: 10,
  sourceUnits: "m/s",
  displayUnits: "km/h",
  sample: false,
  grid,
  levels: [10, 100],
  variables: ["wind", "gust"],
  frames: [buildFrame(0), buildFrame(3), buildFrame(6)],
  data: reference("gfs-20260910-12-f000-wind-10m"),
  statistics: statistics(21.6, 44.2),
};

const v1Manifest = {
  schemaVersion: 1,
  runId: "gfs-20260728-12-f000",
  provider: "NOAA_GFS",
  modelRun: "2026-07-28T12:00:00Z",
  validTime: "2026-07-28T12:00:00Z",
  publishedAt: "2026-07-28T12:00:00Z",
  heightMeters: 10,
  sourceUnits: "m/s",
  displayUnits: "km/h",
  sample: true,
  grid: {
    west: 40,
    east: 41,
    south: 20,
    north: 21,
    width: 2,
    height: 2,
    dx: 1,
    dy: 1,
    scan: "north-to-south-west-to-east" as const,
  },
  data: {
    url: "/fixture.bin",
    encoding: "float32-le-uv-interleaved" as const,
    byteLength: 32,
    sha256: "0".repeat(64),
  },
  statistics: statistics(10, 20),
};

describe("parseWindManifest version one", () => {
  it("wraps a version-one manifest into a single frame at step 0", () => {
    const parsed = parseWindManifest(v1Manifest);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.runId).toBe("gfs-20260728-12-f000");
    expect(parsed.levels).toEqual([10]);
    expect(parsed.variables).toEqual(["wind"]);
    expect(parsed.validTime).toBe("2026-07-28T12:00:00Z");
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0].step).toBe(0);
    expect(parsed.frames[0].grids["wind-10m"]?.url).toBe("/fixture.bin");
    expect(parsed.frames[0].statistics["wind-10m"]).toEqual(statistics(10, 20));
    expect(parsed.sample).toBe(true);
  });

  it("keeps the compatibility entry point returning the caller's object", () => {
    expect(validateManifest(v1Manifest)).toBe(v1Manifest);
  });

  it("still rejects the version-one failure modes with the original Arabic copy", () => {
    expect(() => validateManifest(null)).toThrow("بيانات وصف الرياح");
    expect(() => validateManifest({ ...v1Manifest, schemaVersion: 3 })).toThrow(
      "إصدار بيانات الرياح",
    );
    expect(() =>
      validateManifest({ ...v1Manifest, heightMeters: 100 }),
    ).toThrow("إصدار بيانات الرياح");
    expect(() =>
      validateManifest({ ...v1Manifest, validTime: "not-a-date" }),
    ).toThrow("توقيت بيانات الرياح");
    expect(() =>
      validateManifest({
        ...v1Manifest,
        grid: { ...v1Manifest.grid, east: 42 },
      }),
    ).toThrow("هندسة شبكة الرياح");
    expect(() =>
      validateManifest({
        ...v1Manifest,
        data: { ...v1Manifest.data, byteLength: 4 },
      }),
    ).toThrow("حجم شبكة الرياح");
    expect(() =>
      validateManifest({ ...v1Manifest, data: { url: "/fixture.bin" } }),
    ).toThrow("حجم شبكة الرياح");
  });
});

describe("parseWindManifest version two", () => {
  it("accepts the frozen five-day contract and normalises every frame", () => {
    const parsed = parseWindManifest(v2Manifest);

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.runId).toBe("gfs-20260910-12");
    expect(parsed.frames.map((frame) => frame.step)).toEqual([0, 3, 6]);
    expect(parsed.frames[2].validTime).toBe(validTimeForStep(6));
    expect(parsed.levels).toEqual([10, 100]);
    expect(parsed.variables).toEqual(["wind", "gust"]);
    expect(parsed.validTime).toBe(parsed.frames[0].validTime);
    expect(parsed.data.url).toBe(
      "/api/wind/grids/gfs-20260910-12-f000-wind-10m.bin",
    );
    expect(parsed.statistics).toEqual(statistics(21.6, 44.2));
    expect(parsed.grid.width).toBe(97);
  });

  it("derives levels and variables when a run omits them", () => {
    const parsed = parseWindManifest({
      ...v2Manifest,
      levels: undefined,
      variables: undefined,
    });
    expect(parsed.levels).toEqual([10, 100]);
    expect(parsed.variables).toEqual(["wind", "gust"]);
  });

  it("tolerates a frame that omits a level without throwing", () => {
    const withoutHundred = buildFrame(3);
    delete (withoutHundred.grids as Record<string, unknown>)["wind-100m"];
    delete (withoutHundred.statistics as Record<string, unknown>)["wind-100m"];
    const parsed = parseWindManifest({
      ...v2Manifest,
      frames: [buildFrame(0), withoutHundred],
    });

    expect(availableGridKeys(parsed.frames)).toEqual([
      "wind-10m",
      "wind-100m",
      "gust-10m",
    ]);
    expect(parsed.frames[1].grids["wind-100m"]).toBeUndefined();
    expect(availableLevels(parsed.frames)).toEqual([10, 100]);
  });

  it("rejects a manifest with no frames", () => {
    expect(() => parseWindManifest({ ...v2Manifest, frames: [] })).toThrow(
      "إطارات بيانات الرياح",
    );
    expect(() =>
      parseWindManifest({ ...v2Manifest, frames: undefined }),
    ).toThrow("إطارات بيانات الرياح");
    expect(() => parseWindManifest({ ...v2Manifest, frames: [null] })).toThrow(
      "إطارات بيانات الرياح",
    );
  });

  it("rejects steps that are not strictly increasing non-negative integers", () => {
    const duplicate = { ...buildFrame(3), step: 0 };
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [buildFrame(0), duplicate],
      }),
    ).toThrow("ترتيب إطارات بيانات الرياح");
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [{ ...buildFrame(0), step: -3 }],
      }),
    ).toThrow("ترتيب إطارات بيانات الرياح");
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [{ ...buildFrame(0), step: 1.5 }],
      }),
    ).toThrow("ترتيب إطارات بيانات الرياح");
  });

  it("rejects a frame whose valid time disagrees with modelRun + step", () => {
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [{ ...buildFrame(0), validTime: validTimeForStep(6) }],
      }),
    ).toThrow("توقيت إطار الرياح");
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [{ ...buildFrame(0), validTime: "2026-09-10T12:00:00" }],
      }),
    ).toThrow("توقيت بيانات الرياح");
  });

  it("rejects unknown, empty, or duplicated grid keys", () => {
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [
          {
            ...buildFrame(0),
            grids: { "wind-10m": reference("gfs-20260910-12-f000-wind-10m") },
            statistics: { "wind-10m": statistics(21.6, 44.2) },
          },
        ],
      }),
    ).not.toThrow();

    const unknownKey = buildFrame(0);
    (unknownKey.grids as Record<string, unknown>)["wind-50m"] = reference(
      "gfs-20260910-12-f000-wind-50m",
    );
    (unknownKey.statistics as Record<string, unknown>)["wind-50m"] = statistics(
      21.6,
      44.2,
    );
    expect(() =>
      parseWindManifest({ ...v2Manifest, frames: [unknownKey] }),
    ).toThrow("مفاتيح شبكات إطار الرياح");

    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [{ ...buildFrame(0), grids: {}, statistics: {} }],
      }),
    ).toThrow("مفاتيح شبكات إطار الرياح");
  });

  it("applies the per-frame binary and statistics checks to every frame", () => {
    const wrongLength = buildFrame(3);
    wrongLength.grids["gust-10m"] = {
      ...wrongLength.grids["gust-10m"],
      byteLength: 4,
    };
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [buildFrame(0), wrongLength],
      }),
    ).toThrow("حجم شبكة الرياح");

    const badChecksum = buildFrame(3);
    badChecksum.grids["wind-100m"] = {
      ...badChecksum.grids["wind-100m"],
      sha256: "not-hex",
    };
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [buildFrame(0), badChecksum],
      }),
    ).toThrow("حجم شبكة الرياح");

    const badStatistics = buildFrame(3);
    badStatistics.statistics["wind-10m"] = statistics(50, 40);
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [buildFrame(0), badStatistics],
      }),
    ).toThrow("إحصاءات الرياح");

    const missingStatistics = buildFrame(3);
    delete (missingStatistics.statistics as Record<string, unknown>)[
      "gust-10m"
    ];
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        frames: [buildFrame(0), missingStatistics],
      }),
    ).toThrow("إحصاءات الرياح");
  });

  it("rejects unsane levels and variables", () => {
    expect(() => parseWindManifest({ ...v2Manifest, levels: [] })).toThrow(
      "مستويات بيانات الرياح أو متغيراتها غير صالحة",
    );
    expect(() =>
      parseWindManifest({ ...v2Manifest, levels: [10, "100"] }),
    ).toThrow("مستويات بيانات الرياح أو متغيراتها غير صالحة");
    expect(() => parseWindManifest({ ...v2Manifest, levels: [10] })).toThrow(
      "مستويات بيانات الرياح أو متغيراتها غير صالحة",
    );
    expect(() =>
      parseWindManifest({ ...v2Manifest, variables: ["wind"] }),
    ).toThrow("مستويات بيانات الرياح أو متغيراتها غير صالحة");
    expect(() =>
      parseWindManifest({ ...v2Manifest, variables: ["wind", "rain"] }),
    ).toThrow("مستويات بيانات الرياح أو متغيراتها غير صالحة");
  });

  it("rejects manifests that are not supported at all", () => {
    expect(() => parseWindManifest(undefined)).toThrow("بيانات وصف الرياح");
    expect(() => parseWindManifest("wind")).toThrow("بيانات وصف الرياح");
    expect(() =>
      parseWindManifest({ ...v2Manifest, provider: "ECMWF" }),
    ).toThrow("إصدار بيانات الرياح");
    expect(() =>
      parseWindManifest({ ...v2Manifest, displayUnits: "kt" }),
    ).toThrow("إصدار بيانات الرياح");
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        grid: { ...grid, scan: "south-to-north" },
      }),
    ).toThrow("إصدار بيانات الرياح");
    expect(() => parseWindManifest({ ...v2Manifest, runId: "" })).toThrow(
      "توقيت بيانات الرياح أو معرّفها",
    );
    expect(() =>
      parseWindManifest({ ...v2Manifest, modelRun: "2026-09-10T12:00:00" }),
    ).toThrow("توقيت بيانات الرياح أو معرّفها");
    expect(() =>
      parseWindManifest({
        ...v2Manifest,
        grid: { ...grid, width: 96 },
      }),
    ).toThrow("هندسة شبكة الرياح");
  });
});

describe("frameForTime", () => {
  const frames = parseWindManifest(v2Manifest).frames;

  it("returns the first frame before the run begins", () => {
    expect(frameForTime(frames, Date.parse("2026-09-10T00:00:00Z")).step).toBe(
      0,
    );
  });

  it("returns the frame exactly on a step", () => {
    expect(frameForTime(frames, Date.parse(validTimeForStep(3))).step).toBe(3);
    expect(frameForTime(frames, Date.parse(validTimeForStep(6))).step).toBe(6);
  });

  it("returns the previous frame between steps", () => {
    expect(
      frameForTime(frames, Date.parse(validTimeForStep(3)) + 60_000).step,
    ).toBe(3);
    expect(frameForTime(frames, Date.parse("2026-09-10T16:59:00Z")).step).toBe(
      3,
    );
  });

  it("returns the last frame after the last step", () => {
    expect(frameForTime(frames, Date.parse("2026-10-01T00:00:00Z")).step).toBe(
      6,
    );
  });

  it("refuses an empty frame list", () => {
    expect(() => frameForTime([], Date.now())).toThrow("إطارات بيانات الرياح");
  });
});

describe("frame selection helpers", () => {
  const parsed = parseWindManifest(v2Manifest);
  const withoutHundred = buildFrame(3);
  delete (withoutHundred.grids as Record<string, unknown>)["wind-100m"];
  delete (withoutHundred.statistics as Record<string, unknown>)["wind-100m"];
  const sparse: WindFrame[] = parseWindManifest({
    ...v2Manifest,
    frames: [buildFrame(0), withoutHundred],
  }).frames;

  it("reports the grid keys and levels published by a run", () => {
    expect(availableGridKeys(parsed.frames)).toEqual([
      "wind-10m",
      "wind-100m",
      "gust-10m",
    ]);
    expect(availableLevels(parsed.frames)).toEqual([10, 100]);
    expect(availableLevels([sparse[0]])).toEqual([10, 100]);
  });

  it("falls back to the nearest frame that carries a grid key", () => {
    expect(frameGridIndex(sparse, 1, "wind-100m")).toBe(0);
    expect(frameGridIndex(sparse, 0, "wind-100m")).toBe(0);
    expect(frameGridIndex(sparse, 1, "wind-10m")).toBe(1);
    expect(frameGridIndex(parsed.frames, 1, "wind-100m")).toBe(1);
  });

  it("falls forward when no earlier frame carries the key", () => {
    const sparseStart = { ...buildFrame(0) };
    delete (sparseStart.grids as Record<string, unknown>)["wind-100m"];
    delete (sparseStart.statistics as Record<string, unknown>)["wind-100m"];
    const frames = parseWindManifest({
      ...v2Manifest,
      frames: [sparseStart, buildFrame(3)],
    }).frames;
    expect(frameGridIndex(frames, 0, "wind-100m")).toBe(1);
  });

  it("returns -1 when no frame carries the key", () => {
    const withoutHundredAtAll = sparse.map((frame) => {
      const copy = {
        step: frame.step,
        validTime: frame.validTime,
        grids: { ...frame.grids },
        statistics: { ...frame.statistics },
      };
      delete (copy.grids as Record<string, unknown>)["wind-100m"];
      delete (copy.statistics as Record<string, unknown>)["wind-100m"];
      return copy as WindFrame;
    });
    expect(frameGridIndex(withoutHundredAtAll, 0, "wind-100m")).toBe(-1);
    expect(availableLevels(withoutHundredAtAll)).toEqual([10]);
  });
});
