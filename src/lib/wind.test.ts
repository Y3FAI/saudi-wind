import { describe, expect, it } from "vitest";

import {
  arabicCompass,
  arabicCompassName,
  normalizedDirection,
  sampleWind,
  sha256Hex,
  sha256HexFallback,
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
    sha256: "0".repeat(64),
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

  it("provides full Arabic direction names for the point readout", () => {
    expect(arabicCompassName(0)).toBe("شمالية");
    expect(arabicCompassName(135)).toBe("جنوبية شرقية");
    expect(arabicCompassName(270)).toBe("غربية");
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

  it("rejects malformed timestamps and grid geometry", () => {
    expect(() =>
      validateManifest({ ...manifest, validTime: "not-a-date" }),
    ).toThrow("توقيت بيانات الرياح");
    expect(() =>
      validateManifest({
        ...manifest,
        grid: { ...manifest.grid, east: 42 },
      }),
    ).toThrow("هندسة شبكة الرياح");
  });

  it("computes a lowercase SHA-256 checksum for downloaded grids", async () => {
    const buffer = new TextEncoder().encode("saudi-wind").buffer;
    await expect(sha256Hex(buffer)).resolves.toBe(
      "89635e7e1ba8e3a8ebbb8d2d3487313a2b2ef90bdf5b54a140f1e9d1c212c105",
    );
    expect(sha256HexFallback(buffer)).toBe(
      "89635e7e1ba8e3a8ebbb8d2d3487313a2b2ef90bdf5b54a140f1e9d1c212c105",
    );
  });
});
