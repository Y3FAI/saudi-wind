<!--
Thanks for the contribution. Keep the summary short and honest: what changed,
why, and what you verified.
-->

## Summary

<!-- One or two sentences. Link any related issue with "Closes #123". -->

## What changed

<!-- Bullet the concrete changes, including files or layers touched. -->

## Gates run

CI runs all of these; tick what you ran locally. `bun run check` already covers
prettier, TypeScript (app + Pages Functions), Vitest, and both builds.

- [ ] `bun run check` (prettier `format:check`, `tsc` app + functions, Vitest, production build, Pages Functions build)
- [ ] `bun run check:pipeline` (ruff format/check + pytest)
- [ ] `bun run test:ui` (Playwright: UI, accessibility, compatibility, visual)
- [ ] `bun run test:performance` (frame-rate regression floor)

## Contract changes

Tick if this pull request touches a published contract, and describe the
compatibility plan.

- [ ] Changes the manifest schema (`docs/ARCHITECTURE.md`) — schema version bumped / older version still readable
- [ ] Changes the binary grid format or geometry (`docs/DATA.md`)
- [ ] Changes the public API surface (`functions/`)
- [ ] Changes retention or publication ordering (`docs/OPERATIONS.md`)
- [ ] Updates `scripts/check-production.mjs` to match a manifest/API change
- [ ] Updates the relevant docs in `docs/`

## Data honesty

- [ ] No model output is described as live observation, and no data has been
      invented or extrapolated beyond what NOAA publishes.
- [ ] Any new user-visible number or claim is reproducible from the committed
      artifacts or a documented command.

## Visual changes

<!--
For UI changes, include a desktop and a mobile screenshot (drag images in).
If you could not produce a capture, say so and leave a clearly marked TODO
rather than linking an image that does not exist.
-->

- [ ] Screenshots attached, or no visual change

## Notes for reviewers

<!-- Known limitations, follow-ups, or anything you could not verify. -->
