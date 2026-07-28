# Saudi Wind · رياح السعودية

An Arabic-first visualization of current surface wind across Saudi Arabia.
The project combines the restrained, monochrome character of Cameron
Beccario's Tokyo Air map with the clear data context of hint.fm/wind.

## Current milestone

Milestone 4 connects the approved map and NOAA processor to live Cloudflare
delivery. A private R2 bucket retains 30 days of immutable grids, a read-only
Pages Function exposes only the current manifest and validated grid paths, and
an hourly GitHub Actions workflow publishes the newest complete NOAA cycle.
The UI continues to show the last valid grid with an Arabic stale warning
after 12 hours.

## Local development

Requirements:

- [Bun](https://bun.sh/) 1.3 or later
- [uv](https://docs.astral.sh/uv/) 0.11 or later

```sh
bun install
bun run dev
```

Quality checks:

```sh
bun run check
bun run check:pipeline
bun run test:ui
```

Rebuild the production-format data entirely offline from the committed source
fixture:

```sh
uv sync --all-groups
uv run saudi-wind-pipeline fixture
```

Process the newest complete NOAA cycle into a separate review directory:

```sh
uv run saudi-wind-pipeline latest --output /tmp/saudi-wind-latest
```

Test the complete Pages Function and local R2 integration:

```sh
bun run build
bunx wrangler pages dev dist
```

Boundary preparation remains available through
`python3 scripts/prepare_boundary.py`.

The application is a static Vite build:

```sh
bun run build
```

Cloudflare Pages should use `bun run build` and publish `dist`.

## Milestone previews

Milestone 4 review deployment:
<https://agent-milestone-4-live-cloud.saudi-wind.pages.dev>

| Milestone | Desktop                                                | Mobile                                                |
| --------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 1         | [1440 × 900](docs/screenshots/milestone-1-desktop.png) | [390 × 928](docs/screenshots/milestone-1-mobile.png)  |
| 2         | [1440 × 900](docs/screenshots/milestone-2-desktop.png) | [390 × 1056](docs/screenshots/milestone-2-mobile.png) |
| 3         | [1440 × 900](docs/screenshots/milestone-3-desktop.png) | [mobile](docs/screenshots/milestone-3-mobile.png)     |
| 4         | [1440 × 900](docs/screenshots/milestone-4-desktop.png) | [mobile](docs/screenshots/milestone-4-mobile.png)     |

See the [Milestone 4 review notes](docs/MILESTONE_4.md) for the active
approval checklist and known limitations.

## Data and accuracy

The live display uses the newest complete NOAA GFS `f000` analysis. NOAA GFS
is numerical weather-model output, not direct observation. Its animated lines
are an interpolation of a 0.25° grid and must not be interpreted as
measurements at every visible point.

See [data methodology](docs/DATA.md) and the
[approval-gated project plan](docs/PROJECT_PLAN.md). Operational setup and
recovery are documented in [operations](docs/OPERATIONS.md).

## License

New project code is available under the [MIT License](LICENSE). The archived
reference projects remain excluded from this repository and keep their
original licenses.
