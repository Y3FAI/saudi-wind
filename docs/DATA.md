# Data methodology

## Milestone 3 processing fixture

The current review build uses a frozen NOAA Global Forecast System analysis:

- Model cycle: `2026-07-28 12:00 UTC`
- Forecast step: `f000` analysis
- Variables: 10 m U and V wind components
- Published grid: 0.25°
- Source: NOAA's `noaa-gfs-bdp-pds` public AWS dataset

Only the exact byte ranges for the two required GRIB records are downloaded:

| Variable | Inclusive range       | Bytes   |
| -------- | --------------------- | ------- |
| UGRD     | `413206422–414185566` | 979,145 |
| VGRD     | `414185567–415140803` | 955,237 |

The source fields are cropped to 33°–57° E and 15°–33.5° N, normalized
north-to-south and west-to-east, then stored as interleaved little-endian
Float32 `[u, v]` pairs in metres per second.

The browser converts speed to kilometres per hour:

```text
speed = sqrt(u² + v²) × 3.6
```

The displayed mean is weighted by `cos(latitude)` and includes only model-grid
cell centres inside the Saudi polygon. The maximum is the highest included
grid-cell value; it is not a measured national wind record.

The processed grid is 97 × 75 cells (58,200 bytes). Of those cells, 2,742
centres fall inside the Saudi boundary. The generated values are:

- Area-weighted Saudi mean: 21.6 km/h
- Maximum included grid cell: 44.2 km/h
- Maximum speed anywhere in the buffered source crop: 18.3259 m/s
- Grid SHA-256:
  `7f333b2bf2749fbd16a28a184e140e0035ebc451ccc88838f5e6838a62e6cc78`

Decoded-to-published comparisons pass at representative Riyadh, Jeddah, and
Dammam grid cells. The committed validation report records their coordinates,
U/V components, derived speeds, and exact Float32 serialization match.

The browser validates the manifest, byte length, and SHA-256 before using the
grid.

## Reproducibility and publication

`uv run saudi-wind-pipeline fixture` performs the full decode, crop,
normalization, statistics, validation, and serialization path without network
access. Its output matches the reviewed grid byte-for-byte.

Network processing discovers candidate GFS cycles at 00, 06, 12, and 18 UTC,
rejects indexes without both required records, and downloads the U/V ranges
independently. The immutable grid and validation report are staged before
`latest.json` is atomically replaced. A failed run therefore leaves the
previous manifest intact.

## Geography

The Saudi boundary is extracted from Natural Earth 1:10m Admin 0 data and
rounded to five decimal places for browser delivery.

## Interpretation

GFS is numerical model output. It represents broad atmospheric flow and does
not resolve street-level wind or every local terrain effect. The trails are a
visual advection of interpolated model vectors, not literal particle travel or
sensor observations.
