import { fetchWindGrid } from "./wind";
import type { WindFrame, WindGridKey, WindGridReference } from "../types/wind";

interface CacheEntry {
  status: "loading" | "ready" | "failed";
  vectors: Float32Array | null;
  promise: Promise<Float32Array> | null;
  error: string | null;
}

const IDLE_DELAY_MS = 150;

function scheduleIdle(callback: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (
        handler: () => void,
        options?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    idle(callback, { timeout: 1_000 });
    return;
  }
  globalThis.setTimeout(callback, IDLE_DELAY_MS);
}

/**
 * Decoded-grid cache keyed by grid URL. URLs are immutable per run, so a grid
 * is downloaded and verified at most once; switching frames or levels reuses the
 * decoded `Float32Array` and never blanks the map while a new grid loads.
 */
export class WindGridCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The decoded grid if it is already available, otherwise null. */
  peek(reference: WindGridReference): Float32Array | null {
    const entry = this.entries.get(reference.url);
    return entry?.status === "ready" ? entry.vectors : null;
  }

  has(reference: WindGridReference): boolean {
    return this.entries.get(reference.url)?.status === "ready";
  }

  get pending(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "loading") count += 1;
    }
    return count;
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
      error: null,
    };
    entry.promise = fetchWindGrid(reference, this.fetcher).then(
      (vectors) => {
        entry.status = "ready";
        entry.vectors = vectors;
        return vectors;
      },
      (reason: unknown) => {
        entry.status = "failed";
        entry.error =
          reason instanceof Error ? reason.message : "تعذر تحميل شبكة الرياح.";
        throw reason;
      },
    );
    this.entries.set(reference.url, entry);
    return entry.promise;
  }

  /**
   * Fire-and-forget preload used to warm the next frame on an idle callback.
   * Failures are swallowed because the frame that needs the grid will surface
   * the error itself.
   */
  preload(reference: WindGridReference | undefined): boolean {
    if (!reference || this.has(reference)) return false;
    scheduleIdle(() => {
      void this.load(reference).catch(() => undefined);
    });
    return true;
  }

  /** Warms one grid key of a specific frame; no-op when the key is absent. */
  preloadFrame(frame: WindFrame | undefined, key: WindGridKey): boolean {
    return this.preload(frame?.grids[key]);
  }

  clear(): void {
    this.entries.clear();
  }
}
