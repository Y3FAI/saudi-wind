import { describe, expect, it } from "vitest";

import {
  arabicCompass,
  normalizedDirection,
  sampleWind,
  speedKmh,
  validateManifest,
} from "./wind";
import type { WindManifestV1 } from "../types/wind";

const grid = {
  west: 40,
  east: 41,
  south: 20,
  north: 21,
  width: 2,
  height: 2,
  dx: 1,
  dy: 1,
  scan: "north-to-south-west-to-east" as const,
};

const manifest: WindManifestV1 = {
  schemaVersion: 1,
  runId: "fixture",
  provider: "NOAA_GFS",
  modelRun: "2026-07-28T12:00:00Z",
  validTime: "2026-07-28T12:00:00Z",
  publishedAt: "2026-07-28T12:00:00Z",
  heightMeters: 10,
  sourceUnits: "m/s",
  displayUnits: "km/h",
  sample: true,
  grid,
  data: {
    url: "/fixture.bin",
    encoding: "float32-le-uv-interleaved",
    byteLength: 32,
    sha256: "fixture",
  },
  statistics: {
    areaWeightedMeanKmh: 10,
    maximumGridCellKmh: 20,
  },
};

describe("wind calculations", () => {
  it("converts metres per second to kilometres per hour", () => {
    expect(speedKmh([3, 4])).toBeCloseTo(18);
  });

  it("uses the meteorological direction the wind comes from", () => {
    expect(normalizedDirection([0, -4])).toBeCloseTo(0);
    expect(normalizedDirection([-4, 0])).toBeCloseTo(90);
    expect(normalizedDirection([0, 4])).toBeCloseTo(180);
    expect(normalizedDirection([4, 0])).toBeCloseTo(270);
  });

  it("formats Arabic compass sectors", () => {
    expect(arabicCompass(0)).toBe("ش");
    expect(arabicCompass(90)).toBe("ق");
    expect(arabicCompass(225)).toBe("ج غ");
  });

  it("bilinearly interpolates a north-to-south grid", () => {
    const vectors = new Float32Array([0, 0, 2, 0, 0, 2, 2, 2]);

    expect(sampleWind(vectors, grid, 40.5, 20.5)).toEqual([1, 1]);
    expect(sampleWind(vectors, grid, 39, 20)).toBeNull();
  });

  it("accepts the version-one manifest contract", () => {
    expect(validateManifest(manifest)).toEqual(manifest);
  });

  it("rejects mismatched binary sizes", () => {
    expect(() =>
      validateManifest({
        ...manifest,
        data: { ...manifest.data, byteLength: 4 },
      }),
    ).toThrow("حجم شبكة الرياح");
  });
});
