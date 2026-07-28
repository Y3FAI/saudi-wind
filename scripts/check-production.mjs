import { createHash } from "node:crypto";

const baseUrl = process.env.WIND_BASE_URL ?? "https://saudi-wind.pages.dev";
const staleAfterHours = Number(process.env.WIND_STALE_AFTER_HOURS ?? "12");
const runIdPattern = /^gfs-\d{8}-(?:00|06|12|18)-f000$/;

function fail(message) {
  throw new Error(`Production wind check failed: ${message}`);
}

const manifestResponse = await fetch(`${baseUrl}/api/wind/latest`, {
  cache: "no-store",
  headers: { Accept: "application/json" },
});
if (!manifestResponse.ok) {
  fail(`manifest returned HTTP ${manifestResponse.status}`);
}

const manifest = await manifestResponse.json();
if (
  manifest.schemaVersion !== 1 ||
  manifest.provider !== "NOAA_GFS" ||
  typeof manifest.runId !== "string" ||
  !runIdPattern.test(manifest.runId)
) {
  fail("manifest identity is invalid");
}

const validTime = Date.parse(manifest.validTime);
if (!Number.isFinite(validTime)) fail("validTime is invalid");
const ageHours = (Date.now() - validTime) / 3_600_000;
if (ageHours > staleAfterHours) {
  fail(
    `run ${manifest.runId} is ${ageHours.toFixed(1)} hours old (limit ${staleAfterHours})`,
  );
}

const expectedPath = `/api/wind/grids/${manifest.runId}.bin`;
if (manifest.data?.url !== expectedPath) fail("grid path is invalid");

const gridResponse = await fetch(new URL(expectedPath, baseUrl));
if (!gridResponse.ok) fail(`grid returned HTTP ${gridResponse.status}`);
const grid = Buffer.from(await gridResponse.arrayBuffer());
const sha256 = createHash("sha256").update(grid).digest("hex");
if (grid.byteLength !== manifest.data.byteLength) {
  fail(`grid length ${grid.byteLength} does not match the manifest`);
}
if (sha256 !== manifest.data.sha256) fail("grid checksum does not match");

console.log(
  JSON.stringify(
    {
      status: "healthy",
      runId: manifest.runId,
      validTime: manifest.validTime,
      ageHours: Number(ageHours.toFixed(2)),
      byteLength: grid.byteLength,
      sha256,
    },
    null,
    2,
  ),
);
