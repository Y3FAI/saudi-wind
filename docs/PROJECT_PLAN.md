# Saudi Wind — Approval-Gated Project Plan

## Product contract

Build an Arabic-only, current-condition wind visualization focused on Saudi
Arabia. It combines Tokyo Air's monochrome silhouette and particle aesthetic
with hint.fm's timestamp, legend, statistics, zoom, and point inspection.

Version 1 uses NOAA GFS, km/h only, and displays wind only inside Saudi Arabia.
GFS is identified as model output rather than live sensor observation. A
provider-neutral data contract will allow later transition to Saudi NCM.

## Approval workflow

Every milestone has its own branch, draft pull request, deployed preview,
screenshots, test report, limitations, and explicit approval gate. Revisions
remain in the active milestone. The next milestone does not begin before
approval.

## Milestones

1. **Foundation and visual direction:** React/Vite/Bun foundation, optimized
   Saudi boundary, local Arabic typography, frozen GFS fixture, responsive
   monochrome composition, information hierarchy, CI, and Pages preview.
2. **Animation and interaction:** custom WebGL2 renderer, bilinear
   interpolation, controlled zoom, point inspection, city labels, reduced
   motion, and unsupported-WebGL state.
3. **NOAA processing pipeline:** reproducible Python 3.12 processor, newest
   complete cycle discovery, ranged GRIB download, crop and normalization,
   Saudi-only statistics, validation, and deterministic fixtures.
4. **Live Cloudflare delivery:** private R2 bucket, read-only Pages Function,
   hourly GitHub Actions ingestion, atomic manifest publication, 30-day
   rollback data, and 12-hour staleness handling.
5. **Production hardening:** performance, browser coverage, accessibility,
   visual tests, methodology documentation, quota checks, release checklist,
   and `v1.0.0`.

## Version 1 data interface

The manifest is schema version 1 and identifies the provider, run and valid
times, 10 m height, grid bounds and scan order, binary encoding, checksum, and
Saudi-only mean and maximum statistics. Grid files contain interleaved
little-endian Float32 U/V pairs in metres per second.

## Exclusions

Version 1 excludes forecast timelines, history browsing, accounts, alerts,
databases, native mobile apps, additional weather layers, English UI, and NCM
integration.
