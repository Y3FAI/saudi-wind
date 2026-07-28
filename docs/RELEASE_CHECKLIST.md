# Version 1 release checklist

## Source and review

- [ ] Milestone 5 pull request passes CI.
- [ ] Release commit is merged to `main`.
- [ ] Working tree and remote `main` identify the same commit.
- [ ] `v1.0.0` is an annotated tag on the release commit.

## Data and infrastructure

- [x] Production manifest uses schema version 1.
- [x] R2 bucket is private and `r2.dev` is disabled.
- [x] Public endpoints permit only GET and HEAD.
- [x] Grid length and SHA-256 match the production manifest.
- [x] Grid lifecycle expires `grids/` after 30 days.
- [x] Failed publication preserves the previous manifest.
- [x] Production monitor checks freshness and integrity every six hours.
- [ ] GitHub Actions R2 publication secrets are configured by the repository
      owner.

## Product quality

- [x] Desktop and mobile Chromium interaction tests pass.
- [x] Firefox, WebKit, mobile WebKit, and mobile Chromium smoke tests pass.
- [x] Automated desktop and mobile Arabic snapshots pass.
- [x] Automated WCAG A/AA scan reports no violations.
- [x] Keyboard zoom, pan, reset, and point inspection pass.
- [x] Reduced motion shows a static wind frame.
- [x] Coordinates use isolated bidirectional text.
- [x] Desktop animation meets the near-60 FPS test threshold.
- [x] Mobile animation meets the 30 FPS test threshold.
- [ ] Final Cloudflare preview and production deployment are visually checked.

## Documentation and release

- [x] Model-versus-observation distinction is documented.
- [x] Data freshness, 0.25° limits, 10 m wind height, and statistics are
      documented.
- [x] NOAA, Natural Earth, IBM Plex Sans Arabic, and MIT terms are identified.
- [x] Cloudflare, R2, Workers, Pages, and GitHub usage limits are documented.
- [x] Recovery and secret-rotation steps are documented.
- [ ] GitHub release is published from `v1.0.0`.
