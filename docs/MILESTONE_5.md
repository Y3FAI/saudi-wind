# Milestone 5 — Production hardening and release

## Delivered

- Reused WebGL buffers and cached shader locations to remove avoidable
  per-frame allocation and lookup work.
- Exposed one-second renderer FPS and particle-count samples for deterministic
  performance verification.
- Added keyboard pan, zoom, reset, and centre-point inspection with visible
  focus and Arabic instructions.
- Raised low-contrast informational text while retaining the monochrome
  hierarchy.
- Increased map control targets to at least 44 CSS pixels.
- Reduced the critical font CSS by importing only Arabic and Latin subsets.
- Added a restrictive Content Security Policy, HSTS, permissions policy,
  asset caching, and other response hardening.
- Added automated WCAG A/AA scanning and desktop/mobile Arabic visual
  baselines.
- Added Chromium desktop/mobile, Firefox, desktop WebKit, and mobile WebKit
  browser profiles.
- Added a six-hour production freshness and checksum monitor.
- Added infrastructure quota review, operations guidance, and the v1 release
  checklist.

## Validation

The final preview URL, browser versions, Lighthouse results, frame-rate
samples, screenshots, CI run, and exact release commit are recorded here
after deployment.

## Browser interpretation

Playwright Chromium represents current Chrome and Android Chrome behavior.
Playwright WebKit represents the Safari rendering engine on desktop and an
iPhone viewport. Playwright Firefox covers the current Firefox engine. These
automated profiles do not replace testing on every physical GPU or iPhone.

## Known limitation

Hourly ingestion remains safely skipped until the repository owner adds the
three R2 GitHub Actions secrets listed in `OPERATIONS.md`. The current
validated grid remains available, stale data is visibly labelled after 12
hours, and the production monitor reports the condition.
