import { describe, expect, it, vi } from "vitest";

import {
  GRID_NAME_PATTERN,
  gridObjectKey,
  RUN_ID_PATTERN,
  type WindReadBucket,
} from "../../_shared/responses";
import { handleGrid } from "./grids/[runId]";

function object(key: string, value: string): R2ObjectBody {
  const bytes = new TextEncoder().encode(value);
  return {
    key,
    version: "version-1",
    size: bytes.byteLength,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-07-28T12:00:00Z"),
    httpMetadata: {},
    customMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata: () => undefined,
    body: new Blob([bytes]).stream(),
    bodyUsed: false,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
    bytes: async () => bytes,
    text: async () => value,
    json: async <T>() => JSON.parse(value) as T,
    blob: async () => new Blob([bytes]),
  };
}

function bucket(value: R2ObjectBody | null): WindReadBucket {
  return {
    get: vi.fn(async () => value),
    head: vi.fn(async () => value),
  };
}

describe("run and grid names", () => {
  it("accepts the five-day forecast grid naming contract", () => {
    const names = [
      "gfs-20260910-12-f000-wind-10m.bin",
      "gfs-20260910-12-f003-wind-100m.bin",
      "gfs-20260910-12-f120-gust-10m.bin",
      "gfs-20260910-12-f018-wind-10m.bin",
    ];
    for (const name of names) {
      expect(GRID_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it("keeps resolving legacy version-one grid names", () => {
    expect(GRID_NAME_PATTERN.test("gfs-20260910-12-f000.bin")).toBe(true);
  });

  it("rejects traversal, malformed, and out-of-contract names", () => {
    const rejected = [
      "../latest.json.bin",
      "latest.json.bin",
      "gfs-20260910-12-f000-wind-100.bin",
      "gfs-20260910-12-f000-temperature-2m.bin",
      "gfs-20260910-13-f000-wind-10m.bin",
      "gfs-20260910-12-f000-WIND-10m.bin",
      "gfs-20260910-12-f000-wind-10m",
      "gfs-20260910-12-f00-wind-10m.bin",
      "grids/gfs-20260910-12-f000-wind-10m.bin",
    ];
    for (const name of rejected) {
      expect(GRID_NAME_PATTERN.test(name)).toBe(false);
    }
  });

  it("accepts run identifiers with and without a legacy step suffix", () => {
    expect(RUN_ID_PATTERN.test("gfs-20260910-12")).toBe(true);
    expect(RUN_ID_PATTERN.test("gfs-20260910-12-f000")).toBe(true);
    expect(RUN_ID_PATTERN.test("gfs-20260910-13")).toBe(false);
    expect(RUN_ID_PATTERN.test("gfs-20260910-12-f003-wind-10m")).toBe(false);
  });

  it("maps a grid name onto its immutable R2 key", () => {
    expect(gridObjectKey("gfs-20260910-12-f003-wind-100m.bin")).toBe(
      "grids/gfs-20260910-12-f003-wind-100m.bin",
    );
  });
});

describe("handleGrid with forecast grid names", () => {
  it("serves a per-frame per-level grid from R2", async () => {
    const name = "gfs-20260910-12-f003-wind-100m.bin";
    const storage = bucket(object(`grids/${name}`, "wind"));
    const response = await handleGrid(
      new Request(`https://example.com/api/wind/grids/${name}`),
      storage,
      name,
    );

    expect(response.status).toBe(200);
    expect(storage.get).toHaveBeenCalledWith(`grids/${name}`);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const invalid: WindReadBucket = bucket(object("anything", "wind"));
    const rejected = await handleGrid(
      new Request(
        "https://example.com/api/wind/grids/gfs-20260910-12-f003.bin",
      ),
      invalid,
      "gfs-20260910-12-f003-wind-10.bin",
    );
    expect(rejected.status).toBe(404);
    expect(invalid.get).not.toHaveBeenCalled();
  });
});
