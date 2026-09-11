# Data methodology

What Saudi Wind reads, how it is processed, and how far the numbers can be
trusted. Contract-level detail is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Source

- **Provider:** NOAA Global Forecast System (GFS), produced by NOAA/NCEP.
- **Products:** 0.25° `pgrb2.0p25` forecast files, e.g.
  `gfs.t12z.pgrb2.0p25.f003`.
- **Access:** the public [`noaa-gfs-bdp-pds`](https://registry.opendata.aws/noaa-gfs-bdp-pds/)
  bucket on AWS (Open Data).
- **Licence:** GFS is a U.S. Government work in the public domain; see
  [NOTICE.md](../NOTICE.md). Attribution does not imply NOAA or NCEP
  endorsement.
- **Nature:** GFS is numerical model output. It is not a network of Saudi
  weather stations and is not a measurement at any specific point.

## What is published

Each run publishes a **five-day, three-hourly forecast**: 41 frames from `f000`
(analysis) to `f120`, at the model steps `0, 3, 6, … 120` hours after the cycle
time. Every frame carries one field:

| Grid key   | Quantity                         | GFS records                        |
| ---------- | -------------------------------- | ---------------------------------- |
| `wind-10m` | wind vector at 10 m above ground | `UGRD`/`VGRD` at 10 m above ground |

The 100 m wind and the 10 m gust layers were removed on 11 September 2026 so the
service does one thing well: a single 10 m wind field per frame.

## Processing

For each step, the pipeline parses the GRIB index, selects only the required
records, and downloads only their byte ranges. The records are decoded with
ecCodes, then:

1. **Cropped** to 33°–57° E and 15°–33.5° N.
2. **Normalised** to a north-to-south, west-to-east scan on the 0.25° grid.
3. **Kept in SI units** — metres per second on the wire.

The browser converts speed to kilometres per hour:

```text
speed = sqrt(u² + v²) × 3.6
```

### Validation

A grid is rejected if it contains non-finite values, if dimensions or spacing
are inconsistent, if any buffered-crop speed exceeds 150 m/s, or if serialized
bytes do not match the decoded source at representative cells (Riyadh, Jeddah,
Dammam). Serialization is interleaved little-endian Float32 `[u, v]` pairs.

### Statistics

The displayed mean is weighted by `cos(latitude)` and includes only model-grid
cell centres **inside** the Saudi polygon. The maximum is the highest included
grid-cell value; it is not a measured national wind record.

## Grid format

| Property    | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Encoding    | `float32-le-uv-interleaved`                                     |
| Geometry    | 97 × 75 cells, 0.25° spacing, 33–57° E / 15–33.5° N             |
| Scan        | north-to-south, west-to-east                                    |
| Byte length | 97 × 75 × 2 × 4 = **58,200 bytes** per grid                     |
| Integrity   | SHA-256 recorded in the manifest and re-verified in the browser |

The manifest that ties these together, including the schema-v1/v2 shapes and
frame fields, is documented in [ARCHITECTURE.md](ARCHITECTURE.md#manifest-latestjson).

## Deterministic offline fixture

`pipeline/fixtures/gfs-20260728-12-f000/` holds a committed NOAA source fixture:
the `.idx` index and the exact `UGRD`/`VGRD` byte ranges for the
**2026-07-28 12:00 UTC** cycle at `f000` (10 m only). `uv run
saudi-wind-pipeline fixture` decodes it without network access and regenerates a
single-frame manifest and reference grid.

| Check                              | Value                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| Dimensions                         | 97 × 75                                                            |
| Byte length                        | 58,200                                                             |
| Cell centres inside Saudi Arabia   | 2,742                                                              |
| Area-weighted Saudi mean           | 21.6 km/h                                                          |
| Maximum Saudi grid cell            | 44.2 km/h                                                          |
| Maximum speed in the buffered crop | 18.3259 m/s                                                        |
| Grid SHA-256                       | `7f333b2bf2749fbd16a28a184e140e0035ebc451ccc88838f5e6838a62e6cc78` |
| Source ranges                      | `UGRD` 413,206,422–414,185,566 (`VGRD` 414,185,567–415,140,803)    |

The machine-readable report is committed at
`public/data/processed/reports/gfs-20260728-12-f000.validation.json`. These
values describe that frozen fixture only; live runs have their own manifest and
per-run report.

`public/data/processed/` and `public/data/sample/` are **dev-only** trees: they
exist so `bun run dev` and the Playwright harness can render without Cloudflare
credentials. `bun run build` strips both from `dist/`, and
`scripts/check-dist-manifest.mjs` fails the build if a fixture (or any
`schemaVersion: 1` or zero-frame manifest) turns up in the bundle again.

## Live delivery

Validated output is published to the private `saudi-wind-data` R2 bucket and
served by two public API shapes:

- `/api/wind/latest` maps only to the R2 key `latest.json` and is revalidated.
- `/api/wind/grids/{name}.bin` accepts only the strict grid-name pattern and maps
  to the immutable `grids/{name}` key.

The Pages Function accepts only `GET` and `HEAD`; it exposes no bucket listing,
write operation, or arbitrary object path. The browser rechecks each grid's byte
length and SHA-256 after download.

GitHub Actions checks hourly. It uploads and verifies immutable grids before
replacing the manifest. Reprocessing the same run performs no writes, and a
candidate older than the published run cannot roll the service back. Retention
and pruning are described in [OPERATIONS.md](OPERATIONS.md#retention).

The interface considers the current data stale when its `modelRun` is more than
12 hours old. It continues showing the last valid frame with an Arabic warning
rather than replacing it with missing or unvalidated data.

## Interpretation and limits

- GFS represents broad atmospheric flow. It does not resolve street-level wind
  or every local terrain effect.
- The trails are a visual advection of interpolated model vectors, not literal
  particle travel and not sensor observations.
- “10 m wind” is the model wind represented ten metres above ground. It does
  not describe rooftop height, street canyons, gusts at a person's location, or
  any specific address.
- A 0.25° grid describes regional flow. Interpolation makes the display smooth
  but does not add local forecast detail.

## References

- [NOAA/NCEI GFS description and data access](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast)
- [NCEP operational GFS 0.25° products](https://www.nco.ncep.noaa.gov/pmb/products/gfs/)
- [NOAA GFS on the AWS Open Data Registry](https://registry.opendata.aws/noaa-gfs-bdp-pds/)
- [Natural Earth terms of use](https://www.naturalearthdata.com/about/terms-of-use/)
