/**
 * Build guard for the deployed Pages bundle.
 *
 * Cloudflare Pages uploads `dist/` verbatim, so `dist/` must never contain a
 * dev-only wind fixture. The failure this exists to catch: the frozen July
 * `schemaVersion: 1` manifest (and the `data/sample` pair) lived in `public/`,
 * so every build shipped them and
 * `https://saudi-wind.pages.dev/data/processed/latest.json` served a four-month
 * old, frame-less analysis instead of the R2-backed API.
 *
 * `vite.config.ts` strips those directories from the build output; this script
 * runs after `vite build` in `bun run build` and fails loudly if any of them —
 * or any legacy/empty manifest — is present anyway.
 *
 * Dev and test keep working: the fixtures still live in `public/` for
 * `bun run dev`, `tests/support/preview-server.mjs` and `tests/ui.spec.ts`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
/** Directories under `public/` that exist only for local development. */
const DEV_ONLY_PREFIXES = ["data/processed", "data/sample"];
const LATEST_JSON = /(?:^|\/)latest\.json$/;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

if (!existsSync(DIST)) {
  console.error(
    "check-dist-manifest: dist/ is missing — run `vite build` first.",
  );
  process.exit(1);
}

const relativeFiles = walk(DIST).map((path) =>
  relative(DIST, path).split(sep).join("/"),
);
const problems = [];

for (const prefix of DEV_ONLY_PREFIXES) {
  if (relativeFiles.some((file) => file.startsWith(`${prefix}/`))) {
    problems.push(`${prefix}/ — dev-only fixture directory in the bundle`);
  }
}

for (const file of relativeFiles) {
  if (!file.toLowerCase().endsWith(".json")) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(DIST, file), "utf8"));
  } catch {
    continue; // not something this guard has an opinion about
  }
  if (manifest?.schemaVersion === 1) {
    problems.push(`${file} — legacy schemaVersion 1 manifest`);
  }
  if (
    LATEST_JSON.test(file) &&
    Array.isArray(manifest?.frames) &&
    manifest.frames.length === 0
  ) {
    problems.push(`${file} — manifest publishes zero frames`);
  }
}

if (problems.length > 0) {
  console.error("check-dist-manifest: refusing to ship a stale wind fixture");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    status: "ok",
    dist: "dist/",
    scannedFiles: relativeFiles.length,
    devOnlyFixtures: "absent",
    legacySchemaVersion1Manifests: 0,
  }),
);
