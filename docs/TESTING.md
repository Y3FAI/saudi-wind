# Testing

## What runs where

| Gate                 | Command                                    | Runs                             | Covers                                                                            |
| -------------------- | ------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------- |
| Types                | `bunx tsc -b` / `bun run typecheck`        | local + CI                       | `src/` and the Vite config                                                        |
| Functions types      | `bun run typecheck:functions`              | local + CI                       | `functions/`                                                                      |
| Unit + contract      | `bun run test` (Vitest)                    | local + CI                       | `src/**/*.test.ts`, `functions/**/*.test.ts`, `tests/**/*.test.ts`                |
| Format               | `bunx prettier --check .`                  | local + CI                       | every tracked file                                                                |
| Build                | `bun run build`                            | local + CI                       | production bundle                                                                 |
| Browser suite        | `bun run test:ui`                          | **CI only**                      | `tests/*.spec.ts` on desktop + mobile Chromium, plus Firefox/WebKit compatibility |
| Performance          | `bun run test:performance`                 | **CI only**                      | `tests/performance.spec.ts`, one worker                                           |
| Pipeline             | `bun run check:pipeline` (`uv run pytest`) | local + CI                       | `pipeline/`                                                                       |
| Production freshness | `Production freshness guard` job           | **CI only**, schedule + dispatch | deployed manifest age and shape                                                   |

`bun run check` is the single local command that runs the Vitest, type, format and
build gates; `bun run test` alone is the fast inner loop.

## Why no browser runs on the development VPS

The development box is a 3.7 GB VPS that also hosts the Hermes gateway. Headless
Chromium has OOM-killed the gateway, so **Playwright and any browser process are
never run there**. Write and type-check specs locally; CI and a normal developer
machine run them. `bun run test:ui` and `bun run test:performance` are CI gates,
not local gates.

Locally you may still run: `bunx tsc -b`, `bun run test`, `bun run build`,
`bunx prettier --check .`, `bun run typecheck:functions`, and `uv run pytest`.

## Running one spec on a dev machine

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium      # once
bunx playwright test tests/forecast-timeline.spec.ts --project=desktop-chromium
bunx playwright test tests/forecast-timeline.spec.ts --project=desktop-chromium \
  --grep "scrubbing"                              # a single case
bunx playwright test tests/performance.spec.ts --project=desktop-chromium --workers=1
bunx playwright test tests/mobile.spec.ts --project=mobile-chromium --headed
bunx playwright test --ui                         # interactive runner
```

Playwright boots a `webServer` before the run: it builds with
`VITE_WIND_MANIFEST_URL=/data/processed/latest.json` and serves `dist/` through
`tests/support/preview-server.mjs`. That server exists because `vite preview` has
no Cloudflare Functions: the committed manifest references
`/api/wind/grids/<name>.bin`, which `vite preview` answers with `index.html`, so
the grid length check fails and no dataset ever loads. The server maps
`/api/wind/latest` and `/api/wind/grids/*` onto the committed fixture under
`public/data/processed/` and mirrors Vite's SPA fallback. It needs no secrets.

## Spec collection rule

- `tests/**/*.spec.ts` are Playwright specs.
- `tests/**/*.test.ts` are Vitest specs.
- `tests/helpers/**` and `tests/support/**` are shared code, not tests.

`playwright.config.ts` pins `testMatch` to `*.spec.ts` so Playwright never tries
to collect a Vitest file (its default rule matches `*.test.ts` too). Keep new
Vitest files ending in `.test.ts` and new browser files ending in `.spec.ts`.

## Fixtures

The committed `public/data/processed/latest.json` is whatever run was last
published, so its schema version and available grids change over time. Specs that
assert how levels, gusts or the scrubber behave must not depend on it: they serve
their own manifest and grids through `page.route`, built by
`tests/helpers/windFixture.ts`. `tests/wind-fixture.test.ts` checks that the
synthetic manifest still satisfies the real `parseWindManifest`, so a contract
change breaks that unit test instead of the browser suite.

Specs that exercise the real stack (mobile layout, performance) use the served
fixture and are the ones that catch integration problems.

## Data-freshness guard

The failure it exists to catch: a 44-day-old run sat live because nothing on the
pull-request path looked at `modelRun`.

- Logic: `tests/helpers/freshness.ts` (`freshnessViolation`, `modelRunAgeHours`),
  unit-tested by `tests/freshness-budget.test.ts`, including the 44-day case.
- Enforced end to end by `tests/freshness.spec.ts` against the served manifest.
- Age is measured from `modelRun`, never from the last frame: a five-day forecast
  keeps future valid times, so the newest frame always looks recent.
- The committed fixture is a frozen sample, so its age is not enforced. The CI
  `Production freshness guard` job sets `WIND_MANIFEST_URL` to
  `https://saudi-wind.pages.dev/api/wind/latest` and `WIND_FRESHNESS_ENFORCE=1`,
  which turns the age check on; the job fails by name when the run is stale.

Run it locally against production (no browser is launched; the spec only makes an
HTTP request):

```sh
WIND_MANIFEST_URL=https://saudi-wind.pages.dev/api/wind/latest \
WIND_FRESHNESS_ENFORCE=1 \
bunx playwright test tests/freshness.spec.ts --project=desktop-chromium
```

Override the budget with `WIND_FRESHNESS_MAX_AGE_HOURS`.

## Performance budgets

`tests/performance.spec.ts` documents its thresholds in one `BUDGETS` object.
They are regression floors for a shared, GPU-less CI runner, not device targets;
the device targets and their rationale live in `src/lib/deviceProfile.ts` and
[`PERFORMANCE.md`](PERFORMANCE.md).

| Budget                               | Threshold | Rationale                                                  |
| ------------------------------------ | --------- | ---------------------------------------------------------- |
| first contentful paint               | ≤ 3000 ms | device target ~1800 ms; headless runners are slower        |
| interactive map (first decoded grid) | ≤ 5000 ms | measured to the timeline mounting, i.e. a dataset rendered |
| frame interval median, 120 frames    | ≤ 45 ms   | ~30 fps sustained even on a shared CPU                     |
| frame interval p95, 120 frames       | ≤ 90 ms   | tolerates a scheduling hiccup, not a stall                 |
| JS heap after 30 s                   | ≤ 220 MB  | decoded grids plus WebGL targets are tens of MB            |
| heap growth per 3 zoom/pan cycles    | ≤ 32 MB   | catches per-frame leaks without GC instrumentation         |

The animation frame-rate floor (`data-fps`) is separate: it honours
`PERFORMANCE_DESKTOP_FPS_MINIMUM` / `PERFORMANCE_MOBILE_FPS_MINIMUM` (CI sets 50
and 30). Set `PERFORMANCE_SKIP_BUDGETS=1` to skip the budget suite on a
known-slow runner while keeping the frame-rate floor. Every failure message names
the broken budget and the measured value.

## Resilience coverage

`tests/resilience.spec.ts` fails a forecast grid two ways — an HTTP 503 (the
Arabic copy `تعذر تحميل شبكة الرياح.`) and a dropped connection — and asserts the
previous frame stays on the map and that stepping away and back re-fetches and
recovers. A raw network abort surfaces the browser's own message rather than the
Arabic copy, because `fetchWindGrid` only localises HTTP and integrity failures.
