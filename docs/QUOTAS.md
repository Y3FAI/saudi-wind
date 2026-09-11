# Infrastructure quotas

Capacity notes for the current five-day forecast. Provider figures were last
checked on 28 July 2026 and should be re-verified against the linked docs before
being relied on for planning.

## Per-run footprint

A publishable run is 41 frames × 3 grids = **123 grid objects**, each
**58,200 bytes**, plus one manifest and one validation report:

```text
123 × 58,200 bytes ≈ 7,158,600 bytes ≈ 6.8 MiB per run
```

## R2

The R2 Standard free tier includes 10 GB-month of storage, one million Class A
operations, ten million Class B operations, and free egress.

With the 30-day lifecycle on `grids/` and publication at most once per six-hour
cycle, roughly **120 runs** can be retained:

```text
120 runs × 7,158,600 bytes ≈ 0.86 GB ≈ 0.80 GiB
```

That is around **8% of the 10 GB-month storage allowance** at the ceiling (the
monthly average while the window fills is lower). Note that the publisher's
optional `--prune` flag is **not** enabled in the workflow; if it were enabled
at its 48-hour default, retained volume would drop to roughly eight runs
(≈ 55 MiB).

Class A operations per publish are on the order of a few hundred (a `HEAD` per
grid, a `PUT` per new grid, the manifest `PUT`, and a read-back). At roughly 120
publishes a month that is tens of thousands of operations — well under the one
million allowance. Class B reads come from the Pages Function; see below.

Source: [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Cloudflare Pages and Functions

The Pages Free plan allows 500 builds per month, 20,000 files per site, a
25 MiB maximum individual asset, and unlimited preview deployments. Saudi Wind
deploys well under 40 static files with no oversized assets.

Pages Function requests count against the Workers Free plan: **100,000 requests
per day** with 10 ms of CPU per invocation. Static assets do not consume the
request allowance. Per visit, the Function serves the manifest once and each
grid that the user actually views; the client caches decoded frames and preloads
the next frame, but scrubbing the full timeline across all three fields can
request many grids. A new uncached visit is two requests (manifest + one grid);
a full 41-frame playback across three fields approaches 123. Keep an eye on the
daily request count if traffic or per-session scrubbing grows.

Sources:

- [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

## GitHub Actions

The repository is public and uses standard `ubuntu-latest` runners, which GitHub
provides free of charge for public repositories. CI runs for pull requests and
`main`; ingestion checks hourly; the production monitor checks every six hours.

The full forecast makes ingestion materially heavier than the original
single-step run: each job now fetches one `.idx` per step plus five byte-range
requests per step (about 246 HTTP requests, sequentially) and decodes 41 frames.
The ingest job has a 15-minute timeout. If the job starts timing out after
checkout/network changes, that timeout — not the quota — is the first thing to
raise. NOAA egress through the AWS Open Data programme is free.

Source:
[GitHub Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage).

## Monitoring and alerts

- `Monitor production wind` validates freshness, manifest identity, grid
  geometry, and grid checksums every six hours. A failure appears in GitHub
  Actions and uses normal workflow-failure notifications.
- `Ingest NOAA wind` emits an Actions warning and exits safely when its R2
  credentials have not been configured.
- R2 per-bucket operations and storage remain available in the Cloudflare
  dashboard for the previous 31 days.
- Cloudflare pay-as-you-go budget alerts and GitHub account budgets are
  billing-owner choices. The project does not create or change a spending limit
  without the account owner selecting an amount.

Sources:

- [R2 metrics and analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [GitHub budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
