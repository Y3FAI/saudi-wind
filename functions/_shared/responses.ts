export const MANIFEST_KEY = "latest.json";
export const RUN_ID_PATTERN = /^gfs-\d{8}-(?:00|06|12|18)-f000$/;

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
