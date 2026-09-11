from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from .core import (
    FrameSource,
    PipelineArtifacts,
    RunSpec,
    build_artifacts,
    capture_fixture,
    discover_latest_complete,
    frames_from_plan,
    publish_artifacts,
    read_fixture,
    steps_from_spec,
)

DEFAULT_BOUNDARY = Path("public/data/saudi-boundary.geo.json")
#: The committed dev fixture doubles as the pipeline's default output directory,
#: so `fixture` regenerates it in place and `process`/`latest` review runs land
#: somewhere the R2 publisher already points at. It is excluded from the Pages
#: build (see `vite.config.ts`) and guarded by `scripts/check-dist-manifest.mjs`.
DEFAULT_OUTPUT = Path("public/data/processed")
DEFAULT_FIXTURE = Path("pipeline/fixtures/gfs-20260728-12-f000")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="saudi-wind-pipeline",
        description="Build the Saudi 10 m wind artifacts from NOAA GFS.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    fixture = subparsers.add_parser(
        "fixture", help="Process the committed source fixture without network."
    )
    fixture.add_argument("--fixture-dir", type=Path, default=DEFAULT_FIXTURE)
    fixture.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    fixture.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)

    process = subparsers.add_parser(
        "process", help="Download and process a specified GFS cycle."
    )
    process.add_argument("--date", required=True)
    process.add_argument("--hour", required=True)
    process.add_argument(
        "--steps",
        default="all",
        help="Comma-separated 3-hourly steps (default: 0,3,...,120).",
    )
    process.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    process.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    process.add_argument("--data-url-prefix", default="/api/wind/grids")

    latest = subparsers.add_parser(
        "latest", help="Discover and process the newest complete GFS cycle."
    )
    latest.add_argument(
        "--steps",
        default="all",
        help="Comma-separated 3-hourly steps (default: 0,3,...,120).",
    )
    latest.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    latest.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    latest.add_argument("--data-url-prefix", default="/api/wind/grids")

    capture = subparsers.add_parser(
        "capture-fixture",
        help="Capture exact 10 m wind records for deterministic offline tests.",
    )
    capture.add_argument("--date", required=True)
    capture.add_argument("--hour", required=True)
    capture.add_argument("--step", type=int, default=0)
    capture.add_argument("--fixture-dir", type=Path, default=DEFAULT_FIXTURE)
    return parser


def _summary(
    artifacts: PipelineArtifacts, paths: tuple[Path, ...]
) -> dict[str, object]:
    return {
        "runId": artifacts.run_id,
        "schemaVersion": artifacts.manifest["schemaVersion"],
        "frames": len(artifacts.manifest["frames"]),
        "steps": [frame["step"] for frame in artifacts.manifest["frames"]],
        "gridsPublished": len(artifacts.grids),
        "bytesPublished": artifacts.grid_byte_length,
        "paths": [str(path) for path in paths],
    }


def _process_run(
    run: RunSpec,
    *,
    steps: tuple[int, ...],
    output: Path,
    boundary: Path,
    data_url_prefix: str,
    indexes: dict[int, str] | None = None,
) -> dict[str, object]:
    sources = frames_from_plan(run, steps, indexes)
    artifacts = build_artifacts(
        run=run,
        sources=sources,
        boundary_path=boundary,
        data_url_prefix=data_url_prefix,
        published_at=datetime.now(UTC),
    )
    paths = publish_artifacts(artifacts, output)
    result = _summary(artifacts, paths)
    result["mode"] = "network"
    return result


def main() -> None:
    args = _parser().parse_args()
    if args.command == "capture-fixture":
        run = RunSpec(args.date, args.hour, args.step)
        metadata = capture_fixture(run=run, fixture_directory=args.fixture_dir)
        result: dict[str, object] = {
            "runId": run.run_id,
            "fixture": str(args.fixture_dir),
            "forecastHour": run.forecast_hour,
            "downloadedByteLength": metadata["downloadedByteLength"],
        }
    elif args.command == "fixture":
        run, index_text, payload = read_fixture(args.fixture_dir)
        artifacts = build_artifacts(
            run=run,
            sources=[
                FrameSource(
                    step=run.forecast_hour, index_text=index_text, payload=payload
                )
            ],
            boundary_path=args.boundary,
            fixture=True,
        )
        paths = publish_artifacts(artifacts, args.output)
        result = _summary(artifacts, paths)
        result["mode"] = "offline-fixture"
    elif args.command == "process":
        result = _process_run(
            RunSpec(args.date, args.hour),
            steps=steps_from_spec(args.steps),
            output=args.output,
            boundary=args.boundary,
            data_url_prefix=args.data_url_prefix,
        )
    else:
        plan = discover_latest_complete(steps=steps_from_spec(args.steps))
        result = _process_run(
            plan.run,
            steps=plan.steps,
            output=args.output,
            boundary=args.boundary,
            data_url_prefix=args.data_url_prefix,
            indexes=dict(plan.indexes),
        )
        result["mode"] = "latest-complete"

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
