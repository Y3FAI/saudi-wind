import { fetchWindGrid } from "./wind";
import type { WindGridReference } from "../types/wind";

interface CacheEntry {
  status: "loading" | "ready" | "failed";
  vectors: Float32Array | null;
  promise: Promise<Float32Array> | null;
}

/**
 * Decoded-grid cache keyed by grid URL. URLs are immutable per run, so a grid
 * is downloaded and verified at most once and a second request for the same
 * grid reuses the decoded `Float32Array` instead of refetching it.
 */
export class WindGridCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The decoded grid if it is already available, otherwise null. */
  peek(reference: WindGridReference): Float32Array | null {
    const entry = this.entries.get(reference.url);
    return entry?.status === "ready" ? entry.vectors : null;
  }

  /** Loads and verifies a grid, de-duplicating concurrent requests for it. */
  load(reference: WindGridReference): Promise<Float32Array> {
    const existing = this.entries.get(reference.url);
    if (existing) {
      if (existing.status === "ready" && existing.vectors) {
        return Promise.resolve(existing.vectors);
      }
      if (existing.status === "loading" && existing.promise) {
        return existing.promise;
      }
      if (existing.status === "failed") {
        this.entries.delete(reference.url);
      }
    }

    const entry: CacheEntry = {
      status: "loading",
      vectors: null,
      promise: null,
    };
    entry.promise = fetchWindGrid(reference, this.fetcher).then(
      (vectors) => {
        entry.status = "ready";
        entry.vectors = vectors;
        return vectors;
      },
      (reason: unknown) => {
        entry.status = "failed";
        throw reason;
      },
    );
    this.entries.set(reference.url, entry);
    return entry.promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
