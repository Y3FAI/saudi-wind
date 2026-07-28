# Saudi Wind · رياح السعودية

An Arabic-first visualization of current surface wind across Saudi Arabia.
The project combines the restrained, monochrome character of Cameron
Beccario's Tokyo Air map with the clear data context of hint.fm/wind.

## Version 1 release

Saudi Wind v1 combines the approved animated map, reproducible NOAA processor,
private Cloudflare delivery, stale-data handling, keyboard and reduced-motion
accessibility, cross-browser checks, and production monitoring. A private R2
bucket retains 30 days of immutable grids and a read-only Pages Function
exposes only the current manifest and validated grid paths.

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
bun run test:performance
bun run monitor:production
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

Production: <https://saudi-wind.pages.dev>

| Milestone | Desktop                                                | Mobile                                                |
| --------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 1         | [1440 × 900](docs/screenshots/milestone-1-desktop.png) | [390 × 928](docs/screenshots/milestone-1-mobile.png)  |
| 2         | [1440 × 900](docs/screenshots/milestone-2-desktop.png) | [390 × 1056](docs/screenshots/milestone-2-mobile.png) |
| 3         | [1440 × 900](docs/screenshots/milestone-3-desktop.png) | [mobile](docs/screenshots/milestone-3-mobile.png)     |
| 4         | [1440 × 900](docs/screenshots/milestone-4-desktop.png) | [mobile](docs/screenshots/milestone-4-mobile.png)     |
| 5         | [1440 × 900](docs/screenshots/milestone-5-desktop.png) | [mobile](docs/screenshots/milestone-5-mobile.png)     |

See the [Milestone 5 review notes](docs/MILESTONE_5.md) and
[release checklist](docs/RELEASE_CHECKLIST.md).

## Data and accuracy

The live display uses the newest complete NOAA GFS `f000` analysis. NOAA GFS
is numerical weather-model output, not direct observation. Its animated lines
are an interpolation of a 0.25° grid and must not be interpreted as
measurements at every visible point.

See [data methodology](docs/DATA.md) and the
[approval-gated project plan](docs/PROJECT_PLAN.md). Operational setup and
recovery are documented in [operations](docs/OPERATIONS.md), with current
free-tier assumptions in [infrastructure quotas](docs/QUOTAS.md).

## License

New project code is available under the [MIT License](LICENSE). The archived
reference projects remain excluded from this repository and keep their
original licenses.
