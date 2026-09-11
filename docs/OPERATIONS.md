# Operations

How Saudi Wind publishes data and how to diagnose it when it stops.

## Cloudflare resources

- Pages project: `saudi-wind`
- Production URL: `https://saudi-wind.pages.dev`
- Private R2 bucket: `saudi-wind-data` (binding `WIND_DATA`)
- Storage class: Standard
- Lifecycle: expire `grids/` after 30 days; abort incomplete multipart uploads
  after 7 days. `latest.json` is **not** covered by the expiry rule.

The bucket is private. Public traffic is served through the Pages Function;
`r2.dev` is not enabled or used.

## GitHub Actions secrets

`Ingest NOAA wind` reads these repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID` — required.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` — required by the workflow (S3
  API style, bucket-scoped Object Read & Write on `saudi-wind-data` only).

The publisher also accepts a single `CLOUDFLARE_API_TOKEN`; if both styles are
present, the API token wins. The workflow does not currently pass one.

Never store these values in repository files, workflow arguments, logs,
`archive/`, `.env`, or `.dev.vars`.

If any required secret is absent, the scheduled workflow emits a warning and
skips processing without touching R2. After the secrets are added, dispatch
`Ingest NOAA wind` manually once and confirm a `published` or `unchanged`
result.

## Publication sequence

1. Discover the newest GFS cycle whose **full five-day forecast** is published
   (all required records at every three-hour step). Earlier partial cycles are
   skipped.
2. For each step, fetch the `.idx` index and range-download only the required
   records (10 m and 100 m `UGRD`/`VGRD`, surface `GUST`).
3. Decode, crop, normalise, calculate statistics, validate, and checksum every
   frame **locally**.
4. Compare the candidate with the R2 `latest.json`.
5. Upload each immutable grid only when it is absent, and verify length +
   SHA-256 after upload.
6. Publish `latest.json` last.
7. Read the manifest back and verify its run ID.

A full run is **41 frames × 3 grids = 123 objects** (≈ 6.8 MiB) plus the
manifest and report. The workflow's concurrency group (`noaa-wind-ingestion`)
permits one ingestion at a time; GitHub's manual dispatch and rerun controls
provide manual retry.

Publisher outcomes to expect in the workflow log: `published`, `unchanged`
(same run and same grid hash), or `older-than-current` (a candidate run at or
before the published model time cannot roll the service back).

## Retention

Two independent mechanisms, only one of which is currently active:

| Mechanism                     | Window       | Active?                                   |
| ----------------------------- | ------------ | ----------------------------------------- |
| R2 lifecycle rule on `grids/` | 30 days      | **Yes** — this is the effective retention |
| Publisher `--prune` flag      | 48 h default | No — the workflow does not pass `--prune` |

`--prune` only deletes grids from runs older than `--max-run-age-hours`, and
never deletes the current run or any grid the live manifest references. Because
it is not enabled in the workflow, expect up to 30 days of runs (roughly 120
runs at four cycles a day) to accumulate in R2. Capacity implications are in
[QUOTAS.md](QUOTAS.md).

## Failure behaviour

- Discovery or processing failure: R2 is untouched.
- Grid upload or verification failure: the previous manifest remains current.
- Manifest upload failure: the previous manifest remains current.
- Pages Function cannot reach R2: the API returns Arabic JSON with HTTP 503.
- No manifest exists: the API returns HTTP 404 and the UI explains that no valid
  dataset is available.
- Valid data older than 12 hours: the UI keeps showing it and marks it stale.

## Diagnosing a stale or broken run

Start with the deployed manifest — it is the single source of truth for what the
site is actually serving:

```sh
curl -s https://saudi-wind.pages.dev/api/wind/latest | python3 -m json.tool | head -40
```

Then work outward:

1. **Is the site up?** `curl -I https://saudi-wind.pages.dev/` should return
   `200`. A `404`/`503` on `/api/wind/latest` means the bucket or binding is the
   problem, not the frontend.
2. **Is the run current?** Compare `modelRun` with the current UTC time. The
   monitor's rule is the deployed one: a `modelRun` older than **12 hours** is
   stale. Freshness is measured from `modelRun`, not from the last frame's
   `validTime` — a five-day forecast legitimately has future valid times.
3. **Did the shape change unexpectedly?** Check `schemaVersion` and
   `frameCount`. A single frame means the deployed manifest is still the legacy
   version-1 shape; 41 frames means the schema-v2 forecast is live.
4. **Is the data intact?** Run the production monitor, which validates identity,
   grid geometry, every grid of the first frame, and one grid from the last
   frame:

   ```sh
   bun run monitor:production
   ```

   It also runs every six hours as `Monitor production wind`.

5. **Did ingestion run?** Open the latest `Ingest NOAA wind` run in GitHub
   Actions. A warning that R2 secrets are missing means processing was skipped
   safely; a Python traceback means discovery, download, decode, or validation
   failed. `Discover latest complete` failures list the cycles it rejected and
   why.
6. **Is it an R2 problem?** Inspect the bucket directly:

   ```sh
   bunx wrangler r2 bucket info saudi-wind-data
   bunx wrangler r2 bucket lifecycle list saudi-wind-data
   bunx wrangler r2 object get saudi-wind-data/latest.json --file -
   ```

7. **Rollback.** Because grids are immutable and publication is
   manifest-last, recovery is usually "fix the pipeline and publish again".
   To republish an earlier run, restore that run's `latest.json` to R2 only
   after confirming its grids still exist and are inside the retention window.

## Manual verification

```sh
curl -I https://saudi-wind.pages.dev/api/wind/latest
curl -I https://saudi-wind.pages.dev/api/wind/grids/gfs-YYYYMMDD-HH-f000-wind-10m.bin
```

Expected:

- Manifest: `application/json`, `no-cache`, supports `HEAD` and `If-None-Match`.
- Grid: `application/octet-stream`, one-year immutable caching.
- `POST`: HTTP 405 with `Allow: GET, HEAD`.
- Invalid run ID or grid name: HTTP 404.

Use `bunx wrangler r2 bucket info saudi-wind-data` and
`bunx wrangler r2 bucket lifecycle list saudi-wind-data` to verify private
storage and retention.

## Production health monitor

`Monitor production wind` runs every six hours and can be dispatched manually.
It fails if the manifest identity is invalid, the grid geometry is inconsistent,
the `modelRun` is older than 12 hours, or any verified grid's length or SHA-256
differs from the manifest. It verifies every grid of the first frame and
spot-checks one grid from the last published frame so a truncated run is caught
without downloading the whole forecast.

## Credential rotation

1. Create a replacement bucket-scoped Object Read & Write R2 token.
2. Replace `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in GitHub Actions.
3. Manually dispatch `Ingest NOAA wind`.
4. Confirm an `unchanged` or `published` result and a passing production monitor.
5. Revoke the previous token in Cloudflare.

Rotation never requires a frontend build or manifest-format change.

Current capacity assumptions and provider links are in [QUOTAS.md](QUOTAS.md).
