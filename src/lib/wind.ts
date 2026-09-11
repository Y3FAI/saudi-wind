import { WIND_GRID_KEYS } from "../types/wind";
import type {
  WindDataset,
  WindFrame,
  WindGridKey,
  WindGridMetadata,
  WindGridReference,
  WindManifest,
  WindManifestV1,
  WindStatistics,
  WindVector,
} from "../types/wind";

const GRID_SCAN = "north-to-south-west-to-east" as const;
const GRID_ENCODING = "float32-le-uv-interleaved" as const;
const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;
const KNOWN_VARIABLES = ["wind", "gust"] as const;
const HOUR_MS = 3_600_000;

const ARABIC_DIRECTIONS = [
  "ش",
  "ش ش ق",
  "ش ق",
  "ق ش ق",
  "ق",
  "ق ج ق",
  "ج ق",
  "ج ج ق",
  "ج",
  "ج ج غ",
  "ج غ",
  "غ ج غ",
  "غ",
  "غ ش غ",
  "ش غ",
  "ش ش غ",
] as const;

const ARABIC_DIRECTION_NAMES = [
  "شمالية",
  "شمالية شمالية شرقية",
  "شمالية شرقية",
  "شرقية شمالية شرقية",
  "شرقية",
  "شرقية جنوبية شرقية",
  "جنوبية شرقية",
  "جنوبية جنوبية شرقية",
  "جنوبية",
  "جنوبية جنوبية غربية",
  "جنوبية غربية",
  "غربية جنوبية غربية",
  "غربية",
  "غربية شمالية غربية",
  "شمالية غربية",
  "شمالية شمالية غربية",
] as const;

export function speedKmh([u, v]: WindVector): number {
  return Math.hypot(u, v) * 3.6;
}

export function meteorologicalDirection([u, v]: WindVector): number {
  return (Math.atan2(-u, -v) * 180) / Math.PI + 360;
}

export function normalizedDirection(vector: WindVector): number {
  return meteorologicalDirection(vector) % 360;
}

export function arabicCompass(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return ARABIC_DIRECTIONS[Math.round(normalized / 22.5) % 16];
}

export function arabicCompassName(degrees: number): string {
  const normalized = ((degrees % 360) + 360) % 360;
  return ARABIC_DIRECTION_NAMES[Math.round(normalized / 22.5) % 16];
}

export function sampleWind(
  vectors: Float32Array,
  grid: WindGridMetadata,
  longitude: number,
  latitude: number,
  output?: [u: number, v: number],
): WindVector | null {
  if (
    longitude < grid.west ||
    longitude > grid.east ||
    latitude < grid.south ||
    latitude > grid.north
  ) {
    return null;
  }

  const x = (longitude - grid.west) / grid.dx;
  const y = (grid.north - latitude) / grid.dy;
  const x0 = Math.max(0, Math.min(grid.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(y)));
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const a = (y0 * grid.width + x0) * 2;
  const b = (y0 * grid.width + x1) * 2;
  const c = (y1 * grid.width + x0) * 2;
  const d = (y1 * grid.width + x1) * 2;
  const topU = vectors[a] + (vectors[b] - vectors[a]) * tx;
  const topV = vectors[a + 1] + (vectors[b + 1] - vectors[a + 1]) * tx;
  const bottomU = vectors[c] + (vectors[d] - vectors[c]) * tx;
  const bottomV = vectors[c + 1] + (vectors[d + 1] - vectors[c + 1]) * tx;
  const result = output ?? [0, 0];
  result[0] = topU + (bottomU - topU) * ty;
  result[1] = topV + (bottomV - topV) * ty;
  return result;
}

function isIsoZ(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  );
}

function isWindGridKey(value: string): value is WindGridKey {
  return (WIND_GRID_KEYS as readonly string[]).includes(value);
}

function levelFromGridKey(key: WindGridKey): number {
  return Number(/(\d+)m$/.exec(key)?.[1] ?? 10);
}

function variableFromGridKey(key: WindGridKey): string {
  return key.startsWith("gust") ? "gust" : "wind";
}

function parseGridMetadata(value: unknown): WindGridMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("هندسة شبكة الرياح غير صالحة.");
  }
  const grid = value as Partial<WindGridMetadata>;
  const numbers = [
    grid.west,
    grid.east,
    grid.south,
    grid.north,
    grid.width,
    grid.height,
    grid.dx,
    grid.dy,
  ];
  if (
    numbers.some(
      (number) => typeof number !== "number" || !Number.isFinite(number),
    ) ||
    !Number.isInteger(grid.width) ||
    !Number.isInteger(grid.height) ||
    (grid.width as number) < 2 ||
    (grid.height as number) < 2 ||
    (grid.west as number) >= (grid.east as number) ||
    (grid.south as number) >= (grid.north as number) ||
    (grid.dx as number) <= 0 ||
    (grid.dy as number) <= 0 ||
    Math.abs(
      ((grid.east as number) - (grid.west as number)) / (grid.dx as number) +
        1 -
        (grid.width as number),
    ) > 0.000_001 ||
    Math.abs(
      ((grid.north as number) - (grid.south as number)) / (grid.dy as number) +
        1 -
        (grid.height as number),
    ) > 0.000_001
  ) {
    throw new Error("هندسة شبكة الرياح غير صالحة.");
  }
  return grid as WindGridMetadata;
}

function parseGridReference(
  value: unknown,
  expectedBytes: number,
): WindGridReference {
  const reference = value as Partial<WindGridReference> | null | undefined;
  const sha256 = typeof reference?.sha256 === "string" ? reference.sha256 : "";
  const url = typeof reference?.url === "string" ? reference.url : "";
  if (
    !reference ||
    typeof reference !== "object" ||
    reference.encoding !== GRID_ENCODING ||
    !url ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    reference.byteLength !== expectedBytes
  ) {
    throw new Error("حجم شبكة الرياح لا يطابق وصفها.");
  }
  return {
    url,
    encoding: GRID_ENCODING,
    byteLength: reference.byteLength,
    sha256,
  };
}

function parseStatistics(value: unknown): WindStatistics {
  const statistics = value as Partial<WindStatistics> | null | undefined;
  if (
    !statistics ||
    !Number.isFinite(statistics.areaWeightedMeanKmh) ||
    !Number.isFinite(statistics.maximumGridCellKmh) ||
    (statistics.areaWeightedMeanKmh as number) < 0 ||
    (statistics.maximumGridCellKmh as number) <
      (statistics.areaWeightedMeanKmh as number)
  ) {
    throw new Error("إحصاءات الرياح غير صالحة.");
  }
  return {
    areaWeightedMeanKmh: statistics.areaWeightedMeanKmh as number,
    maximumGridCellKmh: statistics.maximumGridCellKmh as number,
  };
}

function parseFrameGrids(
  frame: Record<string, unknown>,
  expectedBytes: number,
): Pick<WindFrame, "grids" | "statistics"> {
  const rawGrids = frame.grids;
  if (!rawGrids || typeof rawGrids !== "object" || Array.isArray(rawGrids)) {
    throw new Error("مفاتيح شبكات إطار الرياح غير صالحة.");
  }
  const keys = Object.keys(rawGrids as Record<string, unknown>);
  if (keys.length === 0) {
    throw new Error("مفاتيح شبكات إطار الرياح غير صالحة.");
  }
  const rawStatistics = (
    frame.statistics && typeof frame.statistics === "object"
      ? frame.statistics
      : {}
  ) as Record<string, unknown>;
  const grids: Partial<Record<WindGridKey, WindGridReference>> = {};
  const statistics: Partial<Record<WindGridKey, WindStatistics>> = {};
  for (const key of keys) {
    if (!isWindGridKey(key) || key in grids) {
      throw new Error("مفاتيح شبكات إطار الرياح غير صالحة.");
    }
    grids[key] = parseGridReference(
      (rawGrids as Record<string, unknown>)[key],
      expectedBytes,
    );
    statistics[key] = parseStatistics(rawStatistics[key]);
  }
  return { grids, statistics };
}

function parseVersionOneFrame(
  manifest: Record<string, unknown>,
  expectedBytes: number,
): WindFrame {
  if (manifest.heightMeters !== 10) {
    throw new Error("إصدار بيانات الرياح غير مدعوم.");
  }
  if (!isIsoZ(manifest.validTime)) {
    throw new Error("توقيت بيانات الرياح أو معرّفها غير صالح.");
  }
  return {
    step: 0,
    validTime: manifest.validTime,
    grids: { "wind-10m": parseGridReference(manifest.data, expectedBytes) },
    statistics: { "wind-10m": parseStatistics(manifest.statistics) },
  };
}

function parseVersionTwoFrames(
  manifest: Record<string, unknown>,
  modelRunMs: number,
  expectedBytes: number,
): WindFrame[] {
  const rawFrames = manifest.frames;
  if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
    throw new Error("إطارات بيانات الرياح غير صالحة.");
  }
  const frames: WindFrame[] = [];
  let previousStep = -1;
  for (const rawFrame of rawFrames) {
    if (!rawFrame || typeof rawFrame !== "object") {
      throw new Error("إطارات بيانات الرياح غير صالحة.");
    }
    const frame = rawFrame as Record<string, unknown>;
    const step = frame.step;
    if (
      typeof step !== "number" ||
      !Number.isInteger(step) ||
      step < 0 ||
      step <= previousStep
    ) {
      throw new Error("ترتيب إطارات بيانات الرياح غير صالح.");
    }
    previousStep = step;
    if (!isIsoZ(frame.validTime)) {
      throw new Error("توقيت بيانات الرياح أو معرّفها غير صالح.");
    }
    if (Date.parse(frame.validTime) !== modelRunMs + step * HOUR_MS) {
      throw new Error("توقيت إطار الرياح لا يطابق دورة النموذج.");
    }
    frames.push({
      step,
      validTime: frame.validTime,
      ...parseFrameGrids(frame, expectedBytes),
    });
  }
  return frames;
}

function parseLevels(
  value: unknown,
  frames: readonly WindFrame[],
  schemaVersion: 1 | 2,
): number[] {
  if (schemaVersion === 1) return [10];
  if (value === undefined) {
    const derived = new Set<number>();
    for (const key of availableGridKeys(frames)) {
      derived.add(levelFromGridKey(key));
    }
    if (derived.size === 0) {
      throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
    }
    return [...derived].sort((a, b) => a - b);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
  }
  const levels = new Set<number>();
  for (const level of value) {
    if (
      typeof level !== "number" ||
      !Number.isInteger(level) ||
      level <= 0 ||
      levels.has(level)
    ) {
      throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
    }
    levels.add(level);
  }
  return [...levels].sort((a, b) => a - b);
}

function parseVariables(
  value: unknown,
  frames: readonly WindFrame[],
  schemaVersion: 1 | 2,
): string[] {
  if (schemaVersion === 1) return ["wind"];
  if (value === undefined) {
    const derived = new Set<string>();
    for (const key of availableGridKeys(frames)) {
      derived.add(variableFromGridKey(key));
    }
    if (derived.size === 0) {
      throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
    }
    return [...derived];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
  }
  const variables = new Set<string>();
  for (const variable of value) {
    if (
      typeof variable !== "string" ||
      !variable ||
      !(KNOWN_VARIABLES as readonly string[]).includes(variable) ||
      variables.has(variable)
    ) {
      throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
    }
    variables.add(variable);
  }
  return [...variables];
}

/**
 * Tolerant-but-strict manifest parser for schema versions 1 and 2. It returns
 * one normalised shape; a version-one manifest becomes a single frame at step 0.
 */
export function parseWindManifest(value: unknown): WindManifest {
  if (!value || typeof value !== "object") {
    throw new Error("بيانات وصف الرياح غير صالحة.");
  }

  const manifest = value as Record<string, unknown>;
  const rawGrid = manifest.grid as { scan?: unknown } | null | undefined;
  if (
    (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) ||
    manifest.provider !== "NOAA_GFS" ||
    manifest.sourceUnits !== "m/s" ||
    manifest.displayUnits !== "km/h" ||
    rawGrid?.scan !== GRID_SCAN
  ) {
    throw new Error("إصدار بيانات الرياح غير مدعوم.");
  }
  const schemaVersion = manifest.schemaVersion;

  if (
    typeof manifest.runId !== "string" ||
    !manifest.runId ||
    !isIsoZ(manifest.modelRun) ||
    !isIsoZ(manifest.publishedAt)
  ) {
    throw new Error("توقيت بيانات الرياح أو معرّفها غير صالح.");
  }
  const runId = manifest.runId;
  const modelRun = manifest.modelRun;
  const publishedAt = manifest.publishedAt;

  const grid = parseGridMetadata(manifest.grid);
  const expectedBytes =
    grid.width * grid.height * 2 * Float32Array.BYTES_PER_ELEMENT;

  const frames =
    schemaVersion === 1
      ? [parseVersionOneFrame(manifest, expectedBytes)]
      : parseVersionTwoFrames(manifest, Date.parse(modelRun), expectedBytes);
  const keys = availableGridKeys(frames);
  if (keys.length === 0) {
    throw new Error("مفاتيح شبكات إطار الرياح غير صالحة.");
  }
  const levels = parseLevels(manifest.levels, frames, schemaVersion);
  const variables = parseVariables(manifest.variables, frames, schemaVersion);
  for (const key of keys) {
    if (
      !levels.includes(levelFromGridKey(key)) ||
      !variables.includes(variableFromGridKey(key))
    ) {
      throw new Error("مستويات بيانات الرياح أو متغيراتها غير صالحة.");
    }
  }

  const primaryKey: WindGridKey = frames[0].grids["wind-10m"]
    ? "wind-10m"
    : keys[0];

  return {
    schemaVersion,
    runId,
    provider: "NOAA_GFS",
    modelRun,
    validTime: frames[0].validTime,
    publishedAt,
    heightMeters:
      typeof manifest.heightMeters === "number" &&
      Number.isFinite(manifest.heightMeters) &&
      manifest.heightMeters > 0
        ? manifest.heightMeters
        : 10,
    sourceUnits: "m/s",
    displayUnits: "km/h",
    sample: manifest.sample === true,
    grid,
    levels,
    variables,
    frames,
    data: frames[0].grids[primaryKey] as WindGridReference,
    statistics: frames[0].statistics[primaryKey] as WindStatistics,
  };
}

/**
 * Compatibility entry point for the version-one call sites. It runs the full
 * parser and hands back the caller's own object so existing consumers keep
 * working unchanged.
 */
export function validateManifest(value: unknown): WindManifestV1 {
  parseWindManifest(value);
  return value as WindManifestV1;
}

/** Newest frame whose valid time is at or before `date`, else the first frame. */
export function frameForTime(
  frames: readonly WindFrame[],
  date: Date | number,
): WindFrame {
  if (frames.length === 0) {
    throw new Error("إطارات بيانات الرياح غير صالحة.");
  }
  const time = typeof date === "number" ? date : date.getTime();
  let candidate = frames[0];
  for (const frame of frames) {
    if (Date.parse(frame.validTime) <= time) {
      candidate = frame;
    } else {
      break;
    }
  }
  return candidate;
}

/** Short Arabic label for a frame: "الآن" for the current frame, otherwise "+6 س". */
export function frameLabel(
  frame: WindFrame,
  now: Date | number = Date.now(),
): string {
  const time = typeof now === "number" ? now : now.getTime();
  const deltaHours = (Date.parse(frame.validTime) - time) / HOUR_MS;
  if (frame.step === 0 || deltaHours <= 0.5) return "الآن";
  const hours = Math.round(deltaHours);
  if (hours < 24) return `+${hours} س`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `+${days} يوم` : `+${days} يوم ${remainder} س`;
}

/** The grid key that backs a level and the gusts toggle. */
export function gridKeyForLevel(level: number, gusts: boolean): WindGridKey {
  if (gusts) return "gust-10m";
  return level === 100 ? "wind-100m" : "wind-10m";
}

/** Grid keys published anywhere in the run, in the canonical order. */
export function availableGridKeys(frames: readonly WindFrame[]): WindGridKey[] {
  return WIND_GRID_KEYS.filter((key) =>
    frames.some((frame) => frame.grids[key] !== undefined),
  );
}

/** Levels published anywhere in the run, ascending. */
export function availableLevels(frames: readonly WindFrame[]): number[] {
  const levels = new Set<number>();
  for (const key of availableGridKeys(frames))
    levels.add(levelFromGridKey(key));
  return [...levels].sort((a, b) => a - b);
}

/**
 * Nearest frame that actually carries `key`, searching backwards first so a run
 * with a missing level degrades to the most recent frame that has it instead of
 * rendering nothing. Returns -1 when no frame carries the key.
 */
export function frameGridIndex(
  frames: readonly WindFrame[],
  index: number,
  key: WindGridKey,
): number {
  const bounded = Math.max(0, Math.min(frames.length - 1, index));
  if (frames[bounded]?.grids[key]) return bounded;
  for (let candidate = bounded - 1; candidate >= 0; candidate -= 1) {
    if (frames[candidate].grids[key]) return candidate;
  }
  for (let candidate = bounded + 1; candidate < frames.length; candidate += 1) {
    if (frames[candidate].grids[key]) return candidate;
  }
  return -1;
}

/** Downloads, length-checks, and verifies one binary grid. */
export async function fetchWindGrid(
  reference: WindGridReference,
  fetcher: typeof fetch = fetch,
): Promise<Float32Array> {
  const response = await fetcher(reference.url);
  if (!response.ok) {
    throw new Error("تعذر تحميل شبكة الرياح.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== reference.byteLength) {
    throw new Error("شبكة الرياح المحمّلة غير مكتملة.");
  }
  if ((await sha256Hex(buffer)) !== reference.sha256) {
    throw new Error("فشل التحقق من سلامة شبكة الرياح.");
  }
  return new Float32Array(buffer);
}

const SHA256_INITIAL: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

const SHA256_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

export function sha256HexFallback(buffer: ArrayBuffer): string {
  const input = new Uint8Array(buffer);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return sha256HexFallback(buffer);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function loadWindManifest(
  manifestUrl = "/api/wind/latest",
  fetcher: typeof fetch = fetch,
): Promise<WindManifest> {
  const manifestResponse = await fetcher(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error("تعذر تحميل وصف بيانات الرياح.");
  }
  return parseWindManifest(await manifestResponse.json());
}

/**
 * Convenience loader for the first usable grid of a run. The map itself uses
 * `WindGridCache` so it can swap frames without refetching decoded binaries.
 */
export async function loadWindDataset(
  manifestUrl = "/api/wind/latest",
  fetcher: typeof fetch = fetch,
): Promise<WindDataset> {
  const manifest = await loadWindManifest(manifestUrl, fetcher);
  const frame = frameForTime(manifest.frames, Date.now());
  const key = availableGridKeys(manifest.frames)[0];
  const reference = frame.grids[key];
  if (!reference) {
    throw new Error("تعذر تحميل شبكة الرياح.");
  }
  return { manifest, frame, vectors: await fetchWindGrid(reference, fetcher) };
}
