import { createHash } from "node:crypto";

const baseUrl = process.env.WIND_BASE_URL ?? "https://saudi-wind.pages.dev";
const staleAfterHours = Number(process.env.WIND_STALE_AFTER_HOURS ?? "12");
const runIdPattern = /^gfs-\d{8}-(?:00|06|12|18)(?:-f\d{3})?$/;
const gridNamePattern =
  /^gfs-\d{8}-(?:00|06|12|18)-f\d{3}(?:-(?:wind|gust)-\d{1,4}m)?\.bin$/;
const gridKeys = ["wind-10m", "wind-100m", "gust-10m"];
const hourMs = 3_600_000;

function fail(message) {
  throw new Error(`Production wind check failed: ${message}`);
}

function isIsoZ(value) {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  );
}

function validateGridReference(reference, expectedBytes, where) {
  if (!reference || typeof reference !== "object") {
    fail(`${where} grid reference is missing`);
  }
  if (reference.encoding !== "float32-le-uv-interleaved") {
    fail(`${where} grid encoding is invalid`);
  }
  if (typeof reference.url !== "string" || !reference.url) {
    fail(`${where} grid url is missing`);
  }
  if (!gridNamePattern.test(reference.url.split("/").pop() ?? "")) {
    fail(`${where} grid url does not match the grid naming contract`);
  }
  if (reference.byteLength !== expectedBytes) {
    fail(
      `${where} byteLength ${reference.byteLength} does not match the grid geometry`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(reference.sha256))) {
    fail(`${where} sha256 is not lowercase hex`);
  }
  return reference;
}

function validateStatistics(statistics, where) {
  if (
    !statistics ||
    !Number.isFinite(statistics.areaWeightedMeanKmh) ||
    !Number.isFinite(statistics.maximumGridCellKmh) ||
    statistics.areaWeightedMeanKmh < 0 ||
    statistics.maximumGridCellKmh < statistics.areaWeightedMeanKmh
  ) {
    fail(`${where} statistics are invalid`);
  }
}

/** Normalises a version-one or version-two manifest into a frame list. */
function normaliseFrames(manifest, expectedBytes) {
  if (manifest.schemaVersion === 1) {
    validateGridReference(manifest.data, expectedBytes, "data");
    validateStatistics(manifest.statistics, "data");
    return [
      {
        step: 0,
        validTime: manifest.validTime,
        grids: { "wind-10m": manifest.data },
        statistics: { "wind-10m": manifest.statistics },
      },
    ];
  }
  const frames = manifest.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    fail("manifest frames are missing or empty");
  }
  const modelRunMs = Date.parse(manifest.modelRun);
  let previousStep = -1;
  return frames.map((frame, position) => {
    if (!frame || typeof frame !== "object") {
      fail(`frame ${position} is not an object`);
    }
    if (
      !Number.isInteger(frame.step) ||
      frame.step < 0 ||
      frame.step <= previousStep
    ) {
      fail(`frame ${position} step is not a strictly increasing integer`);
    }
    previousStep = frame.step;
    if (!isIsoZ(frame.validTime)) {
      fail(`frame ${position} validTime is not ISO Z`);
    }
    if (Date.parse(frame.validTime) !== modelRunMs + frame.step * hourMs) {
      fail(`frame ${position} validTime does not match modelRun + step`);
    }
    if (!frame.grids || typeof frame.grids !== "object") {
      fail(`frame ${position} grids are missing`);
    }
    const keys = Object.keys(frame.grids);
    if (keys.length === 0) {
      fail(`frame ${position} has no grids`);
    }
    for (const key of keys) {
      if (!gridKeys.includes(key)) {
        fail(`frame ${position} has an unknown grid key ${key}`);
      }
      validateGridReference(
        frame.grids[key],
        expectedBytes,
        `frame ${position} ${key}`,
      );
      validateStatistics(frame.statistics?.[key], `frame ${position} ${key}`);
    }
    return frame;
  });
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
  (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) ||
  manifest.provider !== "NOAA_GFS" ||
  typeof manifest.runId !== "string" ||
  !runIdPattern.test(manifest.runId)
) {
  fail("manifest identity is invalid");
}
if (!isIsoZ(manifest.modelRun) || !isIsoZ(manifest.publishedAt)) {
  fail("manifest timestamps must be ISO Z");
}

// The newest model run is what the pipeline is judged on: a five-day forecast
// keeps future validTimes, so freshness is measured from modelRun, not from the
// last frame.
const modelRunMs = Date.parse(manifest.modelRun);
const ageHours = (Date.now() - modelRunMs) / hourMs;
if (ageHours > staleAfterHours) {
  fail(
    `newest modelRun ${manifest.modelRun} for ${manifest.runId} is ${ageHours.toFixed(1)} hours old (limit ${staleAfterHours})`,
  );
}

const grid = manifest.grid;
const gridNumbers = [
  grid?.west,
  grid?.east,
  grid?.south,
  grid?.north,
  grid?.width,
  grid?.height,
  grid?.dx,
  grid?.dy,
];
if (
  !grid ||
  grid.scan !== "north-to-south-west-to-east" ||
  gridNumbers.some((value) => !Number.isFinite(value)) ||
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
  fail("grid geometry is invalid");
}
const expectedBytes =
  grid.width * grid.height * 2 * Float32Array.BYTES_PER_ELEMENT;

const frames = normaliseFrames(manifest, expectedBytes);

if (manifest.schemaVersion === 2) {
  if (manifest.validTime !== frames[0].validTime) {
    fail("top-level validTime does not mirror the first frame");
  }
  const primary =
    frames[0].grids["wind-10m"] ?? Object.values(frames[0].grids)[0];
  const primaryStatistics = frames[0].statistics["wind-10m"];
  const dataMirrors =
    manifest.data === undefined ||
    (manifest.data?.url === primary?.url &&
      manifest.data?.sha256 === primary?.sha256 &&
      manifest.data?.byteLength === primary?.byteLength);
  const statisticsMirror =
    manifest.statistics === undefined ||
    (manifest.statistics?.areaWeightedMeanKmh ===
      primaryStatistics?.areaWeightedMeanKmh &&
      manifest.statistics?.maximumGridCellKmh ===
        primaryStatistics?.maximumGridCellKmh);
  if (!dataMirrors) {
    fail("top-level data does not mirror the first frame's 10 m wind");
  }
  if (!statisticsMirror) {
    fail("top-level statistics do not mirror the first frame's 10 m wind");
  }
}

/** Downloads one grid and verifies its length and checksum. */
async function verifyGridReference(reference) {
  const path = new URL(reference.url, baseUrl).pathname;
  const response = await fetch(new URL(reference.url, baseUrl));
  if (!response.ok) {
    fail(`grid ${path} returned HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength !== reference.byteLength) {
    fail(
      `grid ${path} length ${buffer.byteLength} does not match the manifest`,
    );
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== reference.sha256) {
    fail(`grid ${path} checksum does not match the manifest`);
  }
  return { path, byteLength: buffer.byteLength, sha256 };
}

// Verify every grid of the first frame, then spot-check the last published
// frame so a truncated run is caught without fetching the whole forecast.
const checks = [];
for (const [key, reference] of Object.entries(frames[0].grids)) {
  checks.push(await verifyGridReference(reference));
}
const tailFrame = frames[frames.length - 1];
const tailKey = Object.keys(tailFrame.grids).sort()[0];
checks.push(await verifyGridReference(tailFrame.grids[tailKey]));

console.log(
  JSON.stringify(
    {
      status: "healthy",
      runId: manifest.runId,
      schemaVersion: manifest.schemaVersion,
      modelRun: manifest.modelRun,
      validTime: frames[0].validTime,
      ageHours: Number(ageHours.toFixed(2)),
      frameCount: frames.length,
      levels: manifest.levels ?? [10],
      gridKeys: Object.keys(frames[0].grids),
      verifiedGrids: checks,
    },
    null,
    2,
  ),
);
