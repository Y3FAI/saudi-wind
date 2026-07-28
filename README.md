# Saudi Wind · رياح السعودية

An Arabic-first visualization of current surface wind across Saudi Arabia.
The project combines the restrained, monochrome character of Cameron
Beccario's Tokyo Air map with the clear data context of hint.fm/wind.

## Current milestone

Milestone 1 is a non-live visual prototype. It uses a frozen NOAA GFS 0.25°
analysis at 10 metres and is clearly labelled as sample data. Live ingestion,
animation, and inspection are intentionally reserved for later approval-gated
milestones.

## Local development

Requirements:

- [Bun](https://bun.sh/) 1.3 or later

```sh
bun install
bun run dev
```

Quality checks:

```sh
bun run check
```

Create the committed source assets:

```sh
python3 scripts/prepare_boundary.py
uv run --python 3.12 --with eccodes --with numpy \
  scripts/build_frozen_fixture.py
```

The application is a static Vite build:

```sh
bun run build
```

Cloudflare Pages should use `bun run build` and publish `dist`.

## Milestone 1 preview

| Desktop                                                | Mobile                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| [1440 × 900](docs/screenshots/milestone-1-desktop.png) | [390 × 928](docs/screenshots/milestone-1-mobile.png) |

See the [Milestone 1 review notes](docs/MILESTONE_1.md) for the approval
checklist and known limitations.

## Data and accuracy

The Milestone 1 display is a design fixture, not current observation data.
NOAA GFS is numerical weather-model output. Its smooth lines are an
interpolation of a 0.25° grid and must not be interpreted as measurements at
every visible point.

See [data methodology](docs/DATA.md) and the
[approval-gated project plan](docs/PROJECT_PLAN.md).

## License

New project code is available under the [MIT License](LICENSE). The archived
reference projects remain excluded from this repository and keep their
original licenses.
