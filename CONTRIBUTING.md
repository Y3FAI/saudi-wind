# Contributing

Saudi Wind is developed through approval-gated milestones.

## Workflow

1. Create a focused branch from `main`.
2. Keep changes within the currently approved milestone.
3. Run `bun run check`.
4. Open a draft pull request with a Cloudflare Pages preview.
5. Include desktop and mobile screenshots, checks, and known limitations.
6. Do not begin the next milestone until the current preview is explicitly
   approved.

## Data and secrets

- Never commit API tokens, Cloudflare credentials, or future NCM credentials.
- Use GitHub Actions and Cloudflare secret stores.
- `archive/` is ignored reference material, not a secret store.
- Generated weather assets must include provider, model run, valid time,
  height, grid resolution, and checksum metadata.

## Design principles

- Arabic and right-to-left layout are first-class.
- The wind must remain visually clipped to Saudi Arabia.
- Model output must never be described as direct live observation.
- Information should remain quiet, legible, and subordinate to the wind.
