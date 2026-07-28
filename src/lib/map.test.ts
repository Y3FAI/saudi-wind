import { describe, expect, it } from "vitest";

import {
  applyViewTransform,
  clampViewTransform,
  invertViewTransform,
  rectanglesOverlap,
  zoomViewAt,
} from "./map";

const viewport = [800, 600] as const;
const boundaryBounds = [
  [100, 50],
  [700, 550],
] as const;

describe("map view transforms", () => {
  it("round-trips screen coordinates", () => {
    const view = { scale: 2.25, x: -140, y: 80 };
    const point = [420, 175] as const;

    expect(invertViewTransform(applyViewTransform(point, view), view)).toEqual(
      point,
    );
  });

  it("keeps the initial Saudi framing fixed at minimum zoom", () => {
    expect(
      clampViewTransform(
        { scale: 0.5, x: 300, y: -500 },
        viewport,
        boundaryBounds,
      ),
    ).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("zooms around the pointer anchor", () => {
    const anchor = [250, 220] as const;
    const next = zoomViewAt(
      { scale: 1, x: 0, y: 0 },
      2,
      anchor,
      viewport,
      boundaryBounds,
    );

    expect(next.scale).toBe(2);
    expect(applyViewTransform(anchor, next)).toEqual(anchor);
  });

  it("constrains extreme pans so part of Saudi Arabia remains visible", () => {
    const next = clampViewTransform(
      { scale: 3, x: 20_000, y: -20_000 },
      viewport,
      boundaryBounds,
    );

    expect(next.x).toBeLessThan(600);
    expect(next.y).toBeGreaterThan(-1_600);
  });
});

describe("label collision", () => {
  it("detects overlapping label rectangles with padding", () => {
    expect(rectanglesOverlap([0, 0, 20, 10], [21, 0, 40, 10], 2)).toBe(true);
    expect(rectanglesOverlap([0, 0, 20, 10], [30, 0, 50, 10], 2)).toBe(false);
  });
});
