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
  sample: boolean;
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

export interface WindDataset {
  manifest: WindManifestV1;
  vectors: Float32Array;
}

export type WindVector = readonly [u: number, v: number];
