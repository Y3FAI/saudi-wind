import { describe, expect, it, vi } from "vitest";

import type { WindReadBucket } from "../../_shared/responses";
import { handleGrid } from "./grids/[runId]";
import { handleLatest } from "./latest";

function object(key: string, value: string): R2ObjectBody {
  const bytes = new TextEncoder().encode(value);
  const arrayBuffer = new Uint8Array(bytes).buffer;
  const body = new Blob([bytes]).stream();
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
    body,
    bodyUsed: false,
    arrayBuffer: async () => arrayBuffer,
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

describe("wind data Pages Functions", () => {
  it("serves and conditionally caches only the latest manifest", async () => {
    const storage = bucket(object("latest.json", '{"schemaVersion":1}'));
    const response = await handleLatest(
      new Request("https://example.com/api/wind/latest"),
      storage,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"schemaVersion":1}');
    expect(response.headers.get("Cache-Control")).toContain("no-cache");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(storage.get).toHaveBeenCalledWith("latest.json");

    const conditional = await handleLatest(
      new Request("https://example.com/api/wind/latest", {
        headers: { "If-None-Match": '"etag-1"' },
      }),
      bucket(object("latest.json", "{}")),
    );
    expect(conditional.status).toBe(304);
  });

  it("supports HEAD and refuses writes or listings", async () => {
    const storage = bucket(object("latest.json", "{}"));
    const head = await handleLatest(
      new Request("https://example.com/api/wind/latest", { method: "HEAD" }),
      storage,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(storage.head).toHaveBeenCalledWith("latest.json");

    const rejectedStorage = bucket(object("latest.json", "{}"));
    const rejected = await handleLatest(
      new Request("https://example.com/api/wind/latest", { method: "POST" }),
      rejectedStorage,
    );
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("Allow")).toBe("GET, HEAD");
    expect(rejectedStorage.get).not.toHaveBeenCalled();
    expect(rejectedStorage.head).not.toHaveBeenCalled();
  });

  it("maps only valid run IDs to immutable grid keys", async () => {
    const storage = bucket(object("grids/gfs-20260728-12-f000.bin", "wind"));
    const response = await handleGrid(
      new Request(
        "https://example.com/api/wind/grids/gfs-20260728-12-f000.bin",
      ),
      storage,
      "gfs-20260728-12-f000.bin",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(storage.get).toHaveBeenCalledWith("grids/gfs-20260728-12-f000.bin");

    const invalidStorage = bucket(object("anything", "wind"));
    const invalid = await handleGrid(
      new Request("https://example.com/api/wind/grids/invalid.bin"),
      invalidStorage,
      "../latest.json.bin",
    );
    expect(invalid.status).toBe(404);
    expect(invalidStorage.get).not.toHaveBeenCalled();
    expect(invalidStorage.head).not.toHaveBeenCalled();
  });

  it("returns explicit unavailable responses for missing or failed R2 reads", async () => {
    const missing = await handleGrid(
      new Request(
        "https://example.com/api/wind/grids/gfs-20260728-12-f000.bin",
      ),
      bucket(null),
      "gfs-20260728-12-f000.bin",
    );
    expect(missing.status).toBe(404);

    const logging = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed: WindReadBucket = {
      get: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
      head: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    };
    const unavailable = await handleLatest(
      new Request("https://example.com/api/wind/latest"),
      failed,
    );
    expect(unavailable.status).toBe(503);
    expect(logging).toHaveBeenCalledOnce();
    logging.mockRestore();
  });
});
