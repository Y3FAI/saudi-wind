# Documentation index

## Current

These describe the system as it is now. Start here.

| Document                           | Contents                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, file map, manifest contract, binary grid format, design decisions                        |
| [DATA.md](DATA.md)                 | Source, what is published, processing, validation, interpretation limits                         |
| [OPERATIONS.md](OPERATIONS.md)     | Cloudflare resources, secrets, publication sequence, retention, diagnosing a stale run, rotation |
| [QUOTAS.md](QUOTAS.md)             | Provider limits and the per-run R2/GitHub footprint                                              |
| [PERFORMANCE.md](PERFORMANCE.md)   | Device tiers and performance budgets — targets, not measured results                             |

## Historical

These record the approval-gated milestones that produced v1.0.0 (July 2026).
Some statements — especially "the display is not live", single-step `f000`
processing, and the frozen July fixture — describe that period and no longer
match the current build. They are kept as a delivery record, not as current
documentation.

| Document                                     | Period                                             |
| -------------------------------------------- | -------------------------------------------------- |
| [PROJECT_PLAN.md](PROJECT_PLAN.md)           | Version 1 scope and the milestone approval process |
| [MILESTONE_1.md](MILESTONE_1.md)             | Foundation and visual direction                    |
| [MILESTONE_2.md](MILESTONE_2.md)             | Animation and interaction                          |
| [MILESTONE_3.md](MILESTONE_3.md)             | NOAA processing pipeline (single-step, 10 m)       |
| [MILESTONE_4.md](MILESTONE_4.md)             | Live Cloudflare delivery                           |
| [MILESTONE_5.md](MILESTONE_5.md)             | Production hardening and the v1.0.0 release        |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | The v1.0.0 release checklist                       |

Milestone review screenshots live in [`screenshots/`](screenshots/).
