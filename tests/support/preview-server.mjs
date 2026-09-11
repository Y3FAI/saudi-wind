/**
 * Static preview server for the Playwright suite.
 *
 * `vite preview` serves `dist/` but has no Functions, so production grid URLs
 * (`/api/wind/grids/<name>.bin`) fall through to the SPA and return `index.html`
 * with a 200. `fetchWindGrid` then rejects on the length check and the map never
 * loads a dataset, which breaks every spec that needs the real fixture.
 *
 * `dist/` deliberately excludes the dev-only wind fixtures (`vite.config.ts`
 * strips them; `scripts/check-dist-manifest.mjs` fails the build if they come
 * back), so the built site is served from `dist/` while the fixture is served
 * from `public/`:
 *   /api/wind/latest                -> public/data/processed/latest.json
 *   /api/wind/grids/<grid-name>.bin -> public/data/processed/grids/<grid-name>.bin
 *   /data/processed/*, /data/sample/* -> public/data/* (dev-only paths)
 *
 * It deliberately mirrors `vite preview`: unknown paths fall back to
 * `index.html`, known directories 404. No secrets, no network access.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));
/** `public/` is where the dev-only wind fixtures live. */
const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));
const HOST = process.env.PREVIEW_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PREVIEW_PORT ?? "4173");

const GRID_NAME =
  /^gfs-\d{8}-(?:00|06|12|18)(?:-f\d{3})?(?:-(?:wind|gust)-\d{1,4}m)?\.bin$/;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(path) {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

/**
 * Candidate files for a request path, best root first: the built site in
 * `dist/`, then the dev-only fixture tree in `public/`. Returns an empty list
 * when the path must 404.
 */
function resolveCandidates(pathname) {
  const decoded = decodeURIComponent(pathname);
  const gridMatch = /^\/api\/wind\/grids\/(.+)$/.exec(decoded);
  if (gridMatch) {
    if (!GRID_NAME.test(gridMatch[1])) return [];
    return [join(PUBLIC, "data", "processed", "grids", gridMatch[1])];
  }
  if (decoded === "/api/wind/latest") {
    return [join(PUBLIC, "data", "processed", "latest.json")];
  }
  const candidates = [];
  for (const root of [DIST, PUBLIC]) {
    const candidate = join(root, normalize(decoded));
    if (candidate === root || candidate.startsWith(root + sep)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function send(response, status, file, method) {
  if (status !== 200 || !file) {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : "");
    return;
  }
  const { size } = statSync(file);
  response.writeHead(200, {
    "Content-Type": contentType(file),
    "Content-Length": size,
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const pathname = new URL(request.url ?? "/", `http://${HOST}`).pathname;
  const file = resolveCandidates(pathname).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );

  if (file) {
    send(response, 200, file, method);
    return;
  }

  // Mirror vite preview: a request that looks like a file 404s, everything else
  // falls back to the single-page app shell.
  if (extname(pathname)) {
    send(response, 404, null, method);
    return;
  }
  send(response, 200, join(DIST, "index.html"), method);
});

server.listen(PORT, HOST, () => {
  console.log(`preview server listening on http://${HOST}:${PORT}`);
});
