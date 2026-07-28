from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from .core import (
    RunSpec,
    build_artifacts,
    capture_fixture,
    discover_latest_complete,
    download_wind_records,
    fetch_bytes,
    parse_index,
    publish_artifacts,
    read_fixture,
    select_wind_ranges,
)

DEFAULT_BOUNDARY = Path("public/data/saudi-boundary.geo.json")
DEFAULT_OUTPUT = Path("public/data/processed")
DEFAULT_FIXTURE = Path("pipeline/fixtures/gfs-20260728-12-f000")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="saudi-wind-pipeline",
        description="Build provider-neutral Saudi wind artifacts from NOAA GFS.",
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
    process.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    process.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    process.add_argument("--data-url-prefix", default="/api/wind/grids")

    latest = subparsers.add_parser(
        "latest", help="Discover and process the newest complete GFS cycle."
    )
    latest.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    latest.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    latest.add_argument("--data-url-prefix", default="/api/wind/grids")

    capture = subparsers.add_parser(
        "capture-fixture",
        help="Capture exact U/V records for deterministic offline tests.",
    )
    capture.add_argument("--date", required=True)
    capture.add_argument("--hour", required=True)
    capture.add_argument("--fixture-dir", type=Path, default=DEFAULT_FIXTURE)
    return parser


def _process_network(
    run: RunSpec,
    *,
    output: Path,
    boundary: Path,
    data_url_prefix: str,
) -> dict[str, object]:
    index_text = fetch_bytes(f"{run.base_url}.idx").decode("utf-8")
    ranges = select_wind_ranges(parse_index(index_text))
    payload = download_wind_records(run, ranges)
    artifacts = build_artifacts(
        run=run,
        index_text=index_text,
        source_payload=payload,
        boundary_path=boundary,
        data_url_prefix=data_url_prefix,
        published_at=datetime.now(UTC),
    )
    paths = publish_artifacts(artifacts, output)
    return {"runId": run.run_id, "paths": [str(path) for path in paths]}


def main() -> None:
    args = _parser().parse_args()
    if args.command == "capture-fixture":
        run = RunSpec(args.date, args.hour)
        capture_fixture(run=run, fixture_directory=args.fixture_dir)
        result: dict[str, object] = {
            "runId": run.run_id,
            "fixture": str(args.fixture_dir),
        }
    elif args.command == "fixture":
        run, index_text, payload = read_fixture(args.fixture_dir)
        artifacts = build_artifacts(
            run=run,
            index_text=index_text,
            source_payload=payload,
            boundary_path=args.boundary,
            fixture=True,
        )
        paths = publish_artifacts(artifacts, args.output)
        result = {
            "runId": run.run_id,
            "mode": "offline-fixture",
            "paths": [str(path) for path in paths],
        }
    elif args.command == "process":
        result = _process_network(
            RunSpec(args.date, args.hour),
            output=args.output,
            boundary=args.boundary,
            data_url_prefix=args.data_url_prefix,
        )
    else:
        run, index_text, ranges = discover_latest_complete()
        payload = download_wind_records(run, ranges)
        artifacts = build_artifacts(
            run=run,
            index_text=index_text,
            source_payload=payload,
            boundary_path=args.boundary,
            data_url_prefix=args.data_url_prefix,
            published_at=datetime.now(UTC),
        )
        paths = publish_artifacts(artifacts, args.output)
        result = {
            "runId": run.run_id,
            "mode": "latest-complete",
            "paths": [str(path) for path in paths],
        }

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
