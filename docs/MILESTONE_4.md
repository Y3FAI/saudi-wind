# Milestone 4 — Live Cloudflare delivery

## Delivered

- Private `saudi-wind-data` R2 Standard bucket.
- Thirty-day expiration for immutable `grids/` objects while preserving
  `latest.json`.
- Typed R2 binding generated from `wrangler.jsonc`.
- Read-only Pages Function endpoints for the manifest and strict run-ID grid
  paths.
- Explicit GET/HEAD-only policy, conditional ETag responses, secure response
  headers, and structured R2 failure logs.
- Hourly and manually dispatched GitHub Actions ingestion with non-overlapping
  execution.
- R2 publisher that rejects invalid paths, checksum mismatches, immutable
  collisions, duplicate runs, and rollback candidates.
- Atomic grid-first / manifest-last publication.
- Frontend loading from the live API with 15-minute revalidation.
- Twelve-hour stale indication while retaining the last valid grid.
- Arabic initial-unavailable state.
- Local-development fixture fallback without weakening production behavior.

## Live data

The seeded live manifest was processed directly from NOAA after Milestone 4
implementation. The preview reads it through the same Pages Function and
private R2 binding used by production.

## Validation

```sh
bun run check
bun run check:pipeline
bun run test:ui
```

- 18 TypeScript tests, including four read-only API tests.
- 18 Python pipeline tests, including four R2 atomic-publication tests.
- 18 desktop/mobile browser scenarios, including stale and unavailable data.
- Pages Function bundle compilation.
- Generated binding types checked against `wrangler.jsonc`.

## Review images

### Desktop

![Milestone 4 desktop preview](screenshots/milestone-4-desktop.png)

### Mobile

![Milestone 4 mobile preview](screenshots/milestone-4-mobile.png)

## Known limitations

- Scheduled ingestion requires the three repository Actions secrets documented
  in `OPERATIONS.md`.
- The UI shows only the newest valid analysis; history remains private rollback
  data and is not browsable.
- GitHub’s scheduled workflow timing is best-effort and may start later than
  the exact minute specified.
- GFS remains model analysis rather than live sensor observation.

## Approval checklist

- Real NOAA timestamp and values.
- Private R2 and read-only API behavior.
- Manifest/grid caching and checksums.
- Stale and never-loaded Arabic states.
- Failure recovery and previous-run preservation.
- Hourly automation and 30-day retention.
