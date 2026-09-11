# Performance budgets

Read this as a statement of **design targets and guards**, not as a benchmark
report: no real-hardware frame-time measurement is committed to this repository,
and a headless CI host cannot produce one. What _is_ measured here is the
transfer cost, which is reproducible anywhere with `bun run build`.

The renderer's own knobs live in `src/lib/windStyle.ts` (`FLOW_WIND_STYLE`) and
`src/lib/webglWindRenderer.ts` (particle budget governor); `WindMap.tsx` caps the
device pixel ratio at 2.

## Design targets

| Budget                      | Target                                        | Where it is enforced                                   |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Initial JS for the map view | ≤ 260 kB raw / ≤ 90 kB gzip                   | build output (see the measurement below)               |
| First interactive (phone)   | ≤ 2.5 s on a simulated 4G profile             | not automated                                          |
| Steady-state frame time     | ≤ 16.7 ms desktop / ≤ 22 ms mobile            | particle governor thresholds (12 ms / 24 ms)           |
| Particles                   | desktop 1,800–2,600, mobile 1,100–1,550       | `FLOW_WIND_STYLE.density` (screen area ÷ 340)          |
| Peak CPU typed arrays       | ≈ 250 kB of particle state at 2,600 particles | 24 Float32 values per particle, plus one 58,200 B grid |

The governor samples the renderer's own frame duration at most every 250 ms: over
budget (12 ms desktop, 24 ms mobile) it drops 20% of the active particles, never
below 600 desktop / 450 mobile; comfortably under budget it grows back by at
least 60 or 8% of the target. The animation starts at 900 desktop / 700 mobile
particles and climbs, so the first frames after load are the cheapest.

## Measured transfer cost

Measured on 11 September 2026 with `bun run build` on the committed tree
(raw bytes; gzip is `gzip -9` of the built file):

| Artifact                                 | Raw           | Gzip         |
| ---------------------------------------- | ------------- | ------------ |
| `index.html`                             | 789 B         | 499 B        |
| single JS chunk                          | 254,005 B     | 81,685 B     |
| single CSS chunk                         | 7,560 B       | 2,316 B      |
| **initial document payload (sum)**       | **262,354 B** | **84,500 B** |
| 6 web-font subsets (3 Arabic, 3 Latin)   | 192,728 B     | —            |
| `data/saudi-boundary.geo.json`           | 47,011 B      | 17,418 B     |
| `latest.json`, 41-frame single-field run | 21,758 B      | —            |
| one wind grid                            | 58,200 B      | —            |

A first visit therefore pulls the document (≈ 84.5 kB gzip), the boundary (≈ 17 kB
gzip), one manifest and one 58,200 B grid. Fonts are the largest fixed cost and
are frozen with the visual design.

## What CI can and cannot check

CI enforces a **regression floor**, not a performance guarantee. GitHub-hosted
runners do not provide representative GPU timing, so `ci.yml` runs the
performance spec with relaxed minimums:

- `PERFORMANCE_DESKTOP_FPS_MINIMUM=30`
- `PERFORMANCE_MOBILE_FPS_MINIMUM=30`

The runner's measured ceiling sits near 48 FPS: CI run
[34555430406](https://github.com/Y3FAI/saudi-wind/actions/runs/34555430406)
logged desktop samples 47, 48, 48.2 (median 48) — software rendering on a shared
CPU, no GPU — and mobile samples 60, 60, 60 (median 60). A 50 FPS desktop floor
therefore failed a runner that was behaving exactly as expected, so CI uses the
same ~30 FPS shared-runner target the frame-interval budget encodes; it still
catches a real regression without failing on the runner's own ceiling.

Locally, with no environment override, the spec defaults to a 55 FPS desktop /
30 FPS mobile minimum and samples the renderer-reported FPS three times, taking
the median (`tests/performance.spec.ts`). The 55 FPS desktop / 30 FPS mobile
device targets are unchanged: the env override only relaxes CI.

The full budget object CI asserts is documented in
[TESTING.md](TESTING.md#performance-budgets): first contentful paint ≤ 3000 ms,
interactive map ≤ 5000 ms, frame-interval median ≤ 45 ms, p95 ≤ 90 ms, heap after
30 s ≤ 220 MB, and heap growth across three zoom/pan cycles ≤ 32 MB.

CI therefore catches large regressions. It does **not** validate frame time,
first-interactive, or memory numbers on real hardware.

## Open item

No real-device performance report (representative Android, iPhone, and desktop
GPU) is committed. Until one is produced and linked here, treat every numeric
budget above as a target rather than a measured result.
