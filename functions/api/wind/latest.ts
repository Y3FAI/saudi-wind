import {
  hasBody,
  isNotModified,
  MANIFEST_KEY,
  methodNotAllowed,
  notFound,
  objectHeaders,
  serviceUnavailable,
  type WindReadBucket,
} from "../../_shared/responses";

export async function handleLatest(
  request: Request,
  bucket: WindReadBucket,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  try {
    const object =
      request.method === "HEAD"
        ? await bucket.head(MANIFEST_KEY)
        : await bucket.get(MANIFEST_KEY);
    if (!object) return notFound();

    const headers = objectHeaders(object, {
      cacheControl: "no-cache, max-age=0, must-revalidate",
      contentType: "application/json; charset=utf-8",
    });
    if (isNotModified(request, object.httpEtag)) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }
    if (!hasBody(object)) return serviceUnavailable();
    return new Response(object.body, { headers });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "wind_manifest_read_failed",
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    return serviceUnavailable();
  }
}

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  handleLatest(request, env.WIND_DATA);
