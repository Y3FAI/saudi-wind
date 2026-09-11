import { describe, expect, it, vi } from "vitest";

import {
  frameForTime,
  frameGridIndex,
  parseWindManifest,
  reuseWindDataset,
} from "../src/lib/wind";
import { WindGridCache } from "../src/lib/windGridCache";
import type { WindDataset } from "../src/types/wind";
import {
  buildManifest,
  gridBytes,
  gridKeyFromName,
} from "./helpers/windFixture";

/**
 * The 15-minute revalidation loop re-parses `latest.json` on every tick, so an
 * unchanged run still arrives as brand-new objects. `App` keeps the boundary
 * and the decoded dataset by reference when the run, the forecast step and the
 * grid are unchanged, because `WindMap` keys its WebGL renderer on
 * `[boundary, dataset, reducedMotion]`: without that the effect re-runs, the
 * renderer is disposed and rebuilt, and the particle trail restarts.
 */

const RUN = { runId: "gfs-20260911-00", modelRun: "2026-09-11T00:00:00Z" };
const NOW = Date.parse("2026-09-11T01:30:00Z");

/** A fresh object per call, exactly like a new manifest response. */
function manifestPayload(options: {
  runId: string;
  modelRun: string;
}): unknown {
  return JSON.parse(
    JSON.stringify(
      buildManifest({ ...options, steps: [0, 3, 6], gridKeys: ["wind-10m"] }),
    ),
  );
}

function gridFetcher() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split("/").pop() ?? "";
    const key = gridKeyFromName(name);
    if (!key) throw new Error(`unexpected grid request: ${name}`);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => gridBytes(key),
    } as unknown as Response;
  });
}

/** Mirrors App's frame/grid selection and dataset write for one tick. */
async function datasetFor(
  cache: WindGridCache,
  raw: unknown,
  now = NOW,
): Promise<WindDataset> {
  const manifest = parseWindManifest(raw);
  const currentFrameIndex = manifest.frames.indexOf(
    frameForTime(manifest.frames, now),
  );
  const frameIndex = frameGridIndex(
    manifest.frames,
    Math.max(0, Math.min(currentFrameIndex, manifest.frames.length - 1)),
    "wind-10m",
  );
  const frame = manifest.frames[frameIndex];
  const reference = frame.grids["wind-10m"];
  if (!reference) throw new Error("fixture frame has no wind-10m grid");
  const vectors = await cache.load(reference);
  return { manifest, frame, vectors };
}

/** React re-runs an effect unless every dependency is Object.is-equal. */
function effectReruns(
  previous: readonly unknown[],
  next: readonly unknown[],
): boolean {
  return previous.some((value, index) => !Object.is(value, next[index]));
}

describe("unchanged 15-minute revalidation", () => {
  it("keeps the dataset — and its decoded grid — by reference", async () => {
    const cache = new WindGridCache(gridFetcher());

    const first = await datasetFor(cache, manifestPayload(RUN));
    const second = await datasetFor(cache, manifestPayload(RUN));

    // Two independent parses, so only the decoded grid is shared by identity.
    expect(second.manifest).not.toBe(first.manifest);
    expect(second.frame).not.toBe(first.frame);
    expect(second.vectors).toBe(first.vectors);

    expect(reuseWindDataset(null, first)).toBe(first);
    expect(reuseWindDataset(first, second)).toBe(first);
  });

  it("leaves WindMap's renderer effect dependencies unchanged", async () => {
    const cache = new WindGridCache(gridFetcher());
    const boundary = { type: "Feature" };

    const first = await datasetFor(cache, manifestPayload(RUN));
    const second = await datasetFor(cache, manifestPayload(RUN));

    // WindMap keys its renderer effect on [boundary, dataset, reducedMotion].
    // App reuses the boundary object and reuseWindDataset reuses the dataset,
    // so the effect must not re-run and the particle trail keeps its age.
    const previousDeps = [boundary, first, false];
    const nextDeps = [boundary, reuseWindDataset(first, second), false];

    expect(effectReruns(previousDeps, nextDeps)).toBe(false);
  });

  it("still swaps the dataset when the run, frame step or grid changes", async () => {
    const cache = new WindGridCache(gridFetcher());
    const first = await datasetFor(cache, manifestPayload(RUN));

    const nextRun = await datasetFor(
      cache,
      manifestPayload({
        runId: "gfs-20260911-06",
        modelRun: "2026-09-11T06:00:00Z",
      }),
    );
    expect(reuseWindDataset(first, nextRun)).toBe(nextRun);

    const laterFrame = await datasetFor(
      cache,
      manifestPayload(RUN),
      Date.parse("2026-09-11T03:30:00Z"),
    );
    expect(laterFrame.frame.step).toBe(3);
    expect(reuseWindDataset(first, laterFrame)).toBe(laterFrame);

    const otherGrid: WindDataset = {
      ...first,
      vectors: new Float32Array(first.vectors.length),
    };
    expect(reuseWindDataset(first, otherGrid)).toBe(otherGrid);
  });
});
