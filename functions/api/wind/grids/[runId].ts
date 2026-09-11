import {
  GRID_NAME_PATTERN,
  gridObjectKey,
  hasBody,
  isNotModified,
  methodNotAllowed,
  notFound,
  objectHeaders,
  serviceUnavailable,
  type WindReadBucket,
} from "../../../_shared/responses";

function parseGridName(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return GRID_NAME_PATTERN.test(value) ? value : null;
}

export async function handleGrid(
  request: Request,
  bucket: WindReadBucket,
  parameter: string | string[] | undefined,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }
  const gridName = parseGridName(parameter);
  if (!gridName) return notFound();

  try {
    const key = gridObjectKey(gridName);
    const object =
      request.method === "HEAD"
        ? await bucket.head(key)
        : await bucket.get(key);
    if (!object) return notFound();

    const headers = objectHeaders(object, {
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "application/octet-stream",
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
        event: "wind_grid_read_failed",
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    return serviceUnavailable();
  }
}

export const onRequest: PagesFunction<Env, "runId"> = ({
  request,
  env,
  params,
}) => handleGrid(request, env.WIND_DATA, params.runId);
