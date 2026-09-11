# Performance budgets

`src/lib/deviceProfile.ts` classifies the viewing device into a render budget and
references this document. Read this as a statement of **design targets and
guards**, not as a benchmark report: no real-hardware measurement is committed
to this repository, and a headless CI host cannot produce one.

## Design targets

| Budget                        | Target                                               |
| ----------------------------- | ---------------------------------------------------- |
| Initial JS for the map view   | ≤ 260 kB raw / ≤ 90 kB gzip                          |
| First interactive (mid phone) | ≤ 2.5 s on a simulated 4G profile                    |
| Steady-state frame time       | ≤ 16.7 ms desktop, ≤ 22 ms mobile (per tier)         |
| Particles per tier            | low 400–900, mid 600–1900, high 900–2600             |
| Peak GPU / CPU memory         | ≤ 26 MB WebGL render targets, ≤ 3 MB JS typed arrays |

These are heuristics derived from screen area, device pixel ratio, core count,
and (where the browser exposes it) `navigator.deviceMemory`.

## Device tiers

From `TIER_SETTINGS` in `src/lib/deviceProfile.ts`:

| Tier | DPR cap | Particle scale | Frame budget | Governor floor (mobile / desktop) |
| ---- | ------- | -------------- | ------------ | --------------------------------- |
| low  | 1.5     | 0.45           | 26 ms        | 380 / 520                         |
| mid  | 2       | 0.72           | 22 ms        | 450 / 600                         |
| high | 2       | 1.0            | 16.7 ms      | 450 / 600                         |

Render-target pixels are additionally capped at `MAX_RENDER_PIXELS` (5.2 Mpx,
roughly 26 MB of colour + stencil memory) so large retina desktops stay bounded
without changing the 1440×900 desktop baseline.

## What CI can and cannot check

CI enforces a **regression floor**, not a performance guarantee. GitHub-hosted
runners do not provide representative GPU timing, so `ci.yml` runs the
performance spec with relaxed minimums:

- `PERFORMANCE_DESKTOP_FPS_MINIMUM=50`
- `PERFORMANCE_MOBILE_FPS_MINIMUM=30`

Locally, with no environment override, the spec defaults to a 55 FPS desktop /
30 FPS mobile minimum and samples the renderer-reported FPS three times, taking
the median (`tests/performance.spec.ts`).

CI therefore catches large regressions. It does **not** validate frame time,
first-interactive, or memory numbers on real hardware.

## Open item

No real-device performance report (representative Android, iPhone, and desktop
GPU) is committed. Until one is produced and linked here, treat every numeric
budget above as a target rather than a measured result.
