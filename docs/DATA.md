# Data methodology

## Milestone 1 fixture

The visual prototype uses a frozen NOAA Global Forecast System analysis:

- Model cycle: `2026-07-28 12:00 UTC`
- Forecast step: `f000` analysis
- Variables: 10 m U and V wind components
- Published grid: 0.25°
- Source: NOAA's `noaa-gfs-bdp-pds` public AWS dataset

Only the two required GRIB records are range-downloaded. They are cropped to
33°–57° E and 15°–33.5° N, normalized north-to-south and west-to-east, then
stored as interleaved little-endian Float32 `[u, v]` pairs in metres per
second.

The browser converts speed to kilometres per hour:

```text
speed = sqrt(u² + v²) × 3.6
```

The displayed mean is weighted by `cos(latitude)` and includes only model-grid
cell centres inside the Saudi polygon. The maximum is the highest included
grid-cell value; it is not a measured national wind record.

## Geography

The Saudi boundary is extracted from Natural Earth 1:10m Admin 0 data and
rounded to five decimal places for browser delivery.

## Interpretation

GFS is numerical model output. It represents broad atmospheric flow and does
not resolve street-level wind or every local terrain effect. The static trails
in Milestone 1 establish visual direction only. Animated advection and point
inspection will be implemented after visual approval.
