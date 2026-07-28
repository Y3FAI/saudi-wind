# Operations

## Cloudflare resources

- Pages project: `saudi-wind`
- Production URL: `https://saudi-wind.pages.dev`
- Private R2 bucket: `saudi-wind-data`
- R2 binding: `WIND_DATA`
- Storage class: Standard
- Grid lifecycle: expire `grids/` after 30 days
- Incomplete multipart uploads: expire after 7 days

The R2 bucket is private. Production traffic is served through the Pages
Function; `r2.dev` is not enabled or used.

## GitHub Actions secrets

The `Ingest NOAA wind` workflow requires these repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The R2 API token should be restricted to Object Read & Write for only
`saudi-wind-data`. Never store these values in repository files, workflow
arguments, logs, `archive/`, `.env`, or `.dev.vars`.

## Publication sequence

1. Discover the newest complete GFS cycle.
2. Download only the exact 10 m UGRD/VGRD ranges.
3. Decode, crop, calculate, validate, and checksum locally.
4. Compare the candidate with R2 `latest.json`.
5. Upload the immutable grid only when absent.
6. Verify its length and SHA-256 metadata.
7. Publish `latest.json`.
8. Read the manifest back and verify the run ID.

The workflow concurrency group permits only one ingestion run at a time.
GitHub’s manual dispatch and rerun controls provide manual retry.

## Failure behavior

- Discovery or processing failure: R2 is untouched.
- Grid upload or verification failure: the previous manifest remains current.
- Manifest upload failure: the previous manifest remains current.
- Pages Function cannot reach R2: API returns Arabic JSON with HTTP 503.
- No manifest exists: API returns HTTP 404 and the UI explains that no valid
  dataset is available.
- Valid data older than 12 hours: the UI continues showing it and marks it
  stale.

## Manual verification

```sh
curl -I https://saudi-wind.pages.dev/api/wind/latest
curl -I \
  https://saudi-wind.pages.dev/api/wind/grids/gfs-YYYYMMDD-HH-f000.bin
```

Expected:

- Manifest: `application/json`, `no-cache`
- Grid: `application/octet-stream`, one-year immutable caching
- POST: HTTP 405 with `Allow: GET, HEAD`
- Invalid run ID: HTTP 404

Use `bunx wrangler r2 bucket info saudi-wind-data` and
`bunx wrangler r2 bucket lifecycle list saudi-wind-data` to verify private
storage and retention. Use the GitHub Actions run log to confirm the processed
run ID and whether publication was `published`, `unchanged`, or
`older-than-current`.
