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
  if (
    manifest.schemaVersion !== 1 ||
    manifest.provider !== "NOAA_GFS" ||
    manifest.sourceUnits !== "m/s" ||
    manifest.displayUnits !== "km/h" ||
    manifest.data?.encoding !== "float32-le-uv-interleaved" ||
    !manifest.grid ||
    manifest.grid.scan !== "north-to-south-west-to-east"
  ) {
    throw new Error("إصدار بيانات الرياح غير مدعوم.");
  }

  const expectedBytes =
    manifest.grid.width *
    manifest.grid.height *
    2 *
    Float32Array.BYTES_PER_ELEMENT;
  if (manifest.data.byteLength !== expectedBytes) {
    throw new Error("حجم شبكة الرياح لا يطابق وصفها.");
  }

  return manifest as WindManifestV1;
}

export async function loadWindDataset(
  manifestUrl = "/data/sample/latest.json",
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

  return {
    manifest,
    vectors: new Float32Array(buffer),
  };
}
