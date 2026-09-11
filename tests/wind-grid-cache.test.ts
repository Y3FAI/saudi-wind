import { describe, expect, it, vi } from "vitest";

import { sha256HexFallback } from "../src/lib/wind";
import { WindGridCache } from "../src/lib/windGridCache";
import type { WindGridReference } from "../src/types/wind";

function payload(values: number[]): ArrayBuffer {
  return Float32Array.from(values).buffer as ArrayBuffer;
}

function reference(
  buffer: ArrayBuffer,
  url = "/grids/a.bin",
): WindGridReference {
  return {
    url,
    encoding: "float32-le-uv-interleaved",
    byteLength: buffer.byteLength,
    sha256: sha256HexFallback(buffer),
  };
}

function responded(buffer: ArrayBuffer, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => buffer,
  } as unknown as Response;
}

describe("WindGridCache", () => {
  it("downloads a grid once and reuses the decoded vectors", async () => {
    const buffer = payload([1, 2, 3, 4]);
    const fetcher = vi.fn(async () => responded(buffer));
    const cache = new WindGridCache(fetcher);
    const grid = reference(buffer);

    const first = await cache.load(grid);
    const second = await cache.load(grid);

    expect(first).toBeInstanceOf(Float32Array);
    expect(Array.from(first)).toEqual([1, 2, 3, 4]);
    expect(second).toBe(first);
    expect(cache.peek(grid)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates concurrent requests for the same grid", async () => {
    const buffer = payload([5, 6]);
    const fetcher = vi.fn(async () => responded(buffer));
    const cache = new WindGridCache(fetcher);
    const grid = reference(buffer);

    const [a, b] = await Promise.all([cache.load(grid), cache.load(grid)]);

    expect(a).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches per URL so different frames fetch independently", async () => {
    const first = payload([1, 1]);
    const second = payload([2, 2]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      responded(String(input).endsWith("/grids/b.bin") ? second : first),
    );
    const cache = new WindGridCache(fetcher);

    await cache.load(reference(first, "/grids/a.bin"));
    await cache.load(reference(second, "/grids/b.bin"));
    await cache.load(reference(first, "/grids/a.bin"));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      Array.from(cache.peek(reference(second, "/grids/b.bin")) ?? []),
    ).toEqual([2, 2]);
  });

  it("rejects a shortened payload without caching it", async () => {
    const buffer = payload([1, 2, 3, 4]);
    const fetcher = vi.fn(async () => responded(payload([1, 2])));
    const cache = new WindGridCache(fetcher);

    await expect(cache.load(reference(buffer))).rejects.toThrow(
      "شبكة الرياح المحمّلة غير مكتملة",
    );
    expect(cache.peek(reference(buffer))).toBeNull();
  });

  it("rejects a checksum mismatch and reports the Arabic error", async () => {
    const buffer = payload([1, 2, 3, 4]);
    const fetcher = vi.fn(async () => responded(buffer));
    const cache = new WindGridCache(fetcher);
    const grid = reference(payload([9, 9, 9, 9]));

    await expect(cache.load(grid)).rejects.toThrow(
      "فشل التحقق من سلامة شبكة الرياح",
    );
    expect(cache.peek(grid)).toBeNull();
  });

  it("surfaces a failed HTTP response", async () => {
    const fetcher = vi.fn(async () => responded(payload([1]), false));
    const cache = new WindGridCache(fetcher);
    await expect(cache.load(reference(payload([1])))).rejects.toThrow(
      "تعذر تحميل شبكة الرياح",
    );
  });

  it("clears cached grids", async () => {
    const buffer = payload([1]);
    const cache = new WindGridCache(vi.fn(async () => responded(buffer)));
    const grid = reference(buffer);
    await cache.load(grid);
    cache.clear();
    expect(cache.peek(grid)).toBeNull();
  });
});
