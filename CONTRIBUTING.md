# Contributing

Thanks for taking a look at Saudi Wind. This project is a small, focused tool —
an Arabic-first wind map for Saudi Arabia — and contributions that keep it
honest and useful are welcome.

## Ground rules

- Keep the map clipped to Saudi Arabia and Arabic/RTL as first-class.
- Never describe model output as live observation. GFS is a forecast model, not
  a network of Saudi weather stations, and the UI, docs, and comments must say
  so.
- Prefer removing a claim over leaving an unverified one.
- Do not widen the public API surface: the Pages Functions stay read-only and
  only ever serve the manifest and named grids.

## Environment

- **Bun** 1.3+ — package manager, frontend tests, builds.
- **uv** 0.11+ — manages Python 3.12 and the pipeline's dependencies.

```sh
bun install
uv sync --all-groups
```

## Workflow

1. Branch from `main`.
2. Make a focused change.
3. Run the gates locally (below).
4. Open a pull request using the template. Screenshots are welcome for visual
   changes.

## Gates

These are exactly what CI runs; a green PR means all of them pass.

```sh
bun run check            # prettier --check, tsc (app + functions), vitest, build, functions build
bun run check:pipeline   # ruff format --check, ruff check, pytest
bun run test:ui          # Playwright: UI, accessibility, compatibility, visual
bun run test:performance # Playwright frame-rate regression floor
```

Notes:

- `bun run check` includes `bun run format:check`. Run `bun run format` first if
  prettier fails.
- Browser suites run in CI across desktop and mobile Chromium, Firefox, desktop
  WebKit, and mobile WebKit (`playwright.config.ts`). Install browsers with
  `bunx playwright install`.
- The performance suite enforces a relaxed FPS floor on CI runners; it is a
  regression guard, not a benchmark.

## Data and secrets

- Never commit API tokens, Cloudflare credentials, or future NCM credentials.
  Use GitHub Actions and Cloudflare secret stores.
- Generated weather assets must carry provider, model run, valid time, height,
  grid resolution, and checksum metadata — this is enforced by the manifest
  parser and the production monitor.
- `archive/` is ignored reference material, not a secret store.

## Changing data handling

The ingestion and publication code lives in `pipeline/`. If you add a field or a
provider, update the manifest contract and its tests together:

- `pipeline/saudi_wind_pipeline/core.py` — discovery, decode, assembly.
- `src/types/wind.ts` and `src/lib/wind.ts` — the client parser.
- `scripts/check-production.mjs` — the production validator.
- `docs/ARCHITECTURE.md` and `docs/DATA.md` — the contract documentation.

The binary grid format and the manifest are a published contract. Changing
either is a breaking change: bump the schema version and keep the older version
readable, as v2 does for v1.
