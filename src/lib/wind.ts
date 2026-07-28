import type {
  WindDataset,
  WindGridMetadata,
  WindManifestV1,
  WindVector,
} from "../types/wind";

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

  const at = (column: number, row: number): WindVector => {
    const index = (row * grid.width + column) * 2;
    return [vectors[index], vectors[index + 1]];
  };

  const a = at(x0, y0);
  const b = at(x1, y0);
  const c = at(x0, y1);
  const d = at(x1, y1);
  const topU = a[0] + (b[0] - a[0]) * tx;
  const topV = a[1] + (b[1] - a[1]) * tx;
  const bottomU = c[0] + (d[0] - c[0]) * tx;
  const bottomV = c[1] + (d[1] - c[1]) * tx;

  return [topU + (bottomU - topU) * ty, topV + (bottomV - topV) * ty];
}

export function validateManifest(value: unknown): WindManifestV1 {
  if (!value || typeof value !== "object") {
    throw new Error("بيانات وصف الرياح غير صالحة.");
  }

  const manifest = value as Partial<WindManifestV1>;
  const grid = manifest.grid;
  const data = manifest.data;
  const statistics = manifest.statistics;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.provider !== "NOAA_GFS" ||
    manifest.heightMeters !== 10 ||
    manifest.sourceUnits !== "m/s" ||
    manifest.displayUnits !== "km/h" ||
    data?.encoding !== "float32-le-uv-interleaved" ||
    !grid ||
    grid.scan !== "north-to-south-west-to-east"
  ) {
    throw new Error("إصدار بيانات الرياح غير مدعوم.");
  }

  const timestamps = [
    manifest.modelRun,
    manifest.validTime,
    manifest.publishedAt,
  ];
  if (
    typeof manifest.runId !== "string" ||
    !manifest.runId ||
    timestamps.some(
      (timestamp) =>
        typeof timestamp !== "string" ||
        !timestamp.endsWith("Z") ||
        !Number.isFinite(Date.parse(timestamp)),
    )
  ) {
    throw new Error("توقيت بيانات الرياح أو معرّفها غير صالح.");
  }

  const gridNumbers = [
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
    gridNumbers.some((number) => !Number.isFinite(number)) ||
    !Number.isInteger(grid.width) ||
    !Number.isInteger(grid.height) ||
    grid.width < 2 ||
    grid.height < 2 ||
    grid.west >= grid.east ||
    grid.south >= grid.north ||
    grid.dx <= 0 ||
    grid.dy <= 0 ||
    Math.abs((grid.east - grid.west) / grid.dx + 1 - grid.width) > 0.000_001 ||
    Math.abs((grid.north - grid.south) / grid.dy + 1 - grid.height) > 0.000_001
  ) {
    throw new Error("هندسة شبكة الرياح غير صالحة.");
  }

  const expectedBytes =
    grid.width * grid.height * 2 * Float32Array.BYTES_PER_ELEMENT;
  if (
    data.byteLength !== expectedBytes ||
    typeof data.url !== "string" ||
    !data.url ||
    !/^[a-f0-9]{64}$/.test(data.sha256)
  ) {
    throw new Error("حجم شبكة الرياح لا يطابق وصفها.");
  }

  if (
    !statistics ||
    !Number.isFinite(statistics.areaWeightedMeanKmh) ||
    !Number.isFinite(statistics.maximumGridCellKmh) ||
    statistics.areaWeightedMeanKmh < 0 ||
    statistics.maximumGridCellKmh < statistics.areaWeightedMeanKmh
  ) {
    throw new Error("إحصاءات الرياح غير صالحة.");
  }

  return manifest as WindManifestV1;
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

export async function loadWindDataset(
  manifestUrl = "/data/processed/latest.json",
): Promise<WindDataset> {
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error("تعذر تحميل وصف بيانات الرياح.");
  }

  const manifest = validateManifest(await manifestResponse.json());
  const gridResponse = await fetch(manifest.data.url);
  if (!gridResponse.ok) {
    throw new Error("تعذر تحميل شبكة الرياح.");
  }

  const buffer = await gridResponse.arrayBuffer();
  if (buffer.byteLength !== manifest.data.byteLength) {
    throw new Error("شبكة الرياح المحمّلة غير مكتملة.");
  }
  if ((await sha256Hex(buffer)) !== manifest.data.sha256) {
    throw new Error("فشل التحقق من سلامة شبكة الرياح.");
  }

  return {
    manifest,
    vectors: new Float32Array(buffer),
  };
}
