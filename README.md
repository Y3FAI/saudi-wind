# Saudi Wind · رياح السعودية

An Arabic-first visualization of current surface wind across Saudi Arabia.
The project combines the restrained, monochrome character of Cameron
Beccario's Tokyo Air map with the clear data context of hint.fm/wind.

## Current milestone

Milestone 3 adds a reproducible Python 3.12 processor behind the approved
interactive wind map. It discovers complete NOAA cycles, downloads only the
10 m U/V GRIB records, validates and normalizes the Saudi crop, calculates
Saudi-only statistics, and publishes the provider-neutral browser artifacts
atomically. The review preview still uses a committed NOAA fixture; scheduled
live ingestion begins in Milestone 4.

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

Boundary preparation remains available through
`python3 scripts/prepare_boundary.py`.

The application is a static Vite build:

```sh
bun run build
```

Cloudflare Pages should use `bun run build` and publish `dist`.

## Milestone previews

| Milestone | Desktop                                                | Mobile                                                |
| --------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 1         | [1440 × 900](docs/screenshots/milestone-1-desktop.png) | [390 × 928](docs/screenshots/milestone-1-mobile.png)  |
| 2         | [1440 × 900](docs/screenshots/milestone-2-desktop.png) | [390 × 1056](docs/screenshots/milestone-2-mobile.png) |
| 3         | [1440 × 900](docs/screenshots/milestone-3-desktop.png) | [mobile](docs/screenshots/milestone-3-mobile.png)     |

See the [Milestone 3 review notes](docs/MILESTONE_3.md) for the active
approval checklist and known limitations.

## Data and accuracy

The current display uses an offline-reproducible processing fixture, not a
current observation. NOAA GFS is numerical weather-model output. Its animated
lines are an interpolation of a 0.25° grid and must not be interpreted as
measurements at every visible point.

See [data methodology](docs/DATA.md) and the
[approval-gated project plan](docs/PROJECT_PLAN.md).

## License

New project code is available under the [MIT License](LICENSE). The archived
reference projects remain excluded from this repository and keep their
original licenses.
