export const MANIFEST_KEY = "latest.json";

/**
 * Provider run identifier: `gfs-YYYYMMDD-HH`. A legacy version-one manifest
 * used `gfs-YYYYMMDD-HH-f000`; both are accepted.
 */
export const RUN_ID_PATTERN = /^gfs-\d{8}-(?:00|06|12|18)(?:-f\d{3})?$/;

/**
 * Grid object name served by `/api/wind/grids/<name>`:
 * `gfs-YYYYMMDD-HH-fNNN-<variable>-<level>m.bin`, for example
 * `gfs-20260910-12-f003-wind-100m.bin`. The variable/level suffix is optional so
 * version-one runs (`...-f000.bin`) keep resolving.
 */
export const GRID_NAME_PATTERN =
  /^gfs-\d{8}-(?:00|06|12|18)-f\d{3}(?:-(?:wind|gust)-\d{1,4}m)?\.bin$/;

/** R2 object key backing a validated grid name. */
export function gridObjectKey(gridName: string): string {
  return `grids/${gridName}`;
}

export interface WindReadBucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export function methodNotAllowed(): Response {
  return Response.json(
    { error: "الطريقة غير مسموحة." },
    {
      status: 405,
      headers: {
        ...SECURITY_HEADERS,
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
      },
    },
  );
}

export function notFound(): Response {
  return Response.json(
    { error: "بيانات الرياح المطلوبة غير متوفرة." },
    {
      status: 404,
      headers: {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-store",
      },
    },
  );
}

export function serviceUnavailable(): Response {
  return Response.json(
    { error: "تعذر الوصول إلى بيانات الرياح حالياً." },
    {
      status: 503,
      headers: {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-store",
      },
    },
  );
}

export function isNotModified(request: Request, etag: string): boolean {
  const candidates = request.headers.get("If-None-Match");
  if (!candidates) return false;
  return candidates
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}

export function hasBody(object: R2Object): object is R2ObjectBody {
  return "body" in object && object.body instanceof ReadableStream;
}

export function objectHeaders(
  object: R2Object,
  { cacheControl, contentType }: { cacheControl: string; contentType: string },
): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", object.httpMetadata?.contentType ?? contentType);
  headers.set("Cache-Control", cacheControl);
  headers.set("Content-Length", object.size.toString());
  headers.set("ETag", object.httpEtag);
  return headers;
}
