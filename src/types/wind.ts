export interface WindGridMetadata {
  west: number;
  east: number;
  south: number;
  north: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
  scan: "north-to-south-west-to-east";
}

export const WIND_GRID_KEYS = ["wind-10m", "wind-100m", "gust-10m"] as const;

export type WindGridKey = (typeof WIND_GRID_KEYS)[number];

export interface WindGridReference {
  url: string;
  encoding: "float32-le-uv-interleaved";
  byteLength: number;
  sha256: string;
}

export interface WindStatistics {
  areaWeightedMeanKmh: number;
  maximumGridCellKmh: number;
}

/**
 * One forecast step. A run publishes the same grid metadata for every step, so
 * only the step, its valid time, and the per-variable binary references and
 * statistics live here.
 *
 * `grids`/`statistics` are partial on purpose: a run may omit a level (for
 * example no 100 m wind), and the client then disables that level instead of
 * throwing.
 */
export interface WindFrame {
  step: number;
  validTime: string;
  grids: Partial<Record<WindGridKey, WindGridReference>>;
  statistics: Partial<Record<WindGridKey, WindStatistics>>;
}

/**
 * Normalised manifest. Version 1 manifests are wrapped into a single frame at
 * step 0 so every consumer sees one shape.
 *
 * `validTime`, `data` and `statistics` mirror the first frame's 10 m wind grid,
 * matching the published contract; `validTime` is therefore the model run time
 * and drives the freshness badge.
 */
export interface WindManifest {
  schemaVersion: 1 | 2;
  runId: string;
  provider: "NOAA_GFS";
  modelRun: string;
  validTime: string;
  publishedAt: string;
  heightMeters: number;
  sourceUnits: "m/s";
  displayUnits: "km/h";
  sample: boolean;
  grid: WindGridMetadata;
  levels: number[];
  variables: string[];
  frames: WindFrame[];
  data: WindGridReference;
  statistics: WindStatistics;
}

/** The published version-one shape, kept for the tolerant compatibility entry point. */
export interface WindManifestV1 {
  schemaVersion: 1;
  runId: string;
  provider: "NOAA_GFS";
  modelRun: string;
  validTime: string;
  publishedAt: string;
  heightMeters: 10;
  sourceUnits: "m/s";
  displayUnits: "km/h";
  sample?: boolean;
  grid: WindGridMetadata;
  data: {
    url: string;
    encoding: "float32-le-uv-interleaved";
    byteLength: number;
    sha256: string;
  };
  statistics: {
    areaWeightedMeanKmh: number;
    maximumGridCellKmh: number;
  };
}

/**
 * A decoded grid paired with the manifest that produced it. The WebGL renderer
 * only reads `vectors` and `manifest.grid`, so swapping frames keeps working
 * without touching the renderer.
 */
export interface WindDataset {
  manifest: WindManifest;
  frame: WindFrame;
  vectors: Float32Array;
}

export type WindVector = readonly [u: number, v: number];
