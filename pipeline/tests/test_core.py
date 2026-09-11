from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from saudi_wind_pipeline.core import (
    ENCODING,
    FORECAST_STEPS,
    ByteRange,
    FrameSource,
    GridValidationError,
    IncompleteCycleError,
    PipelineArtifacts,
    PipelineError,
    RunSpec,
    calculate_statistics,
    discover_latest_complete,
    download_wind_records,
    normalize_and_crop,
    ordered_record_keys,
    parse_index,
    publish_artifacts,
    record_key,
    select_wind_ranges,
    steps_from_spec,
)

INDEX = """\
1:0:d=2026072812:TMP:surface:anl:
2:12:d=2026072812:UGRD:10 m above ground:anl:
3:24:d=2026072812:VGRD:10 m above ground:anl:
4:40:d=2026072812:ICEG:surface:anl:
"""

MULTILEVEL_INDEX = """\
1:0:d=2026072812:PRMSL:mean sea level:anl:
2:100:d=2026072812:GUST:surface:anl:
3:200:d=2026072812:UGRD:10 m above ground:anl:
4:300:d=2026072812:VGRD:10 m above ground:anl:
5:400:d=2026072812:UGRD:100 m above ground:anl:
6:500:d=2026072812:VGRD:100 m above ground:anl:
7:600:d=2026072812:TMP:surface:anl:
"""


def index_for_step(step: int, *, template: str = MULTILEVEL_INDEX) -> str:
    label = "anl" if step == 0 else f"{step} hour fcst"
    return template.replace(":anl:", f":{label}:")


def test_forecast_steps_are_three_hourly_through_f120() -> None:
    assert FORECAST_STEPS == tuple(range(0, 121, 3))
    assert FORECAST_STEPS[0] == 0
    assert FORECAST_STEPS[-1] == 120
    assert len(FORECAST_STEPS) == 41


@pytest.mark.parametrize(
    ("specification", "expected"),
    [
        (None, FORECAST_STEPS),
        ("", FORECAST_STEPS),
        ("all", FORECAST_STEPS),
        ("0", (0,)),
        ("3,0, 6", (0, 3, 6)),
        ("120", (120,)),
    ],
)
def test_step_specification_parsing(
    specification: str | None, expected: tuple[int, ...]
) -> None:
    assert steps_from_spec(specification) == expected


@pytest.mark.parametrize("specification", ["5", "1", "126", "-3", "abc", "999"])
def test_step_specification_rejects_unaligned_steps(specification: str) -> None:
    with pytest.raises(ValueError):
        steps_from_spec(specification)


def test_runspec_accepts_forecast_steps_and_names_the_cycle() -> None:
    run = RunSpec("20260728", "12", 3)

    assert run.forecast_hour == 3
    assert run.run_id == "gfs-20260728-12"
    assert run.grid_filename(3, "wind-100m") == "gfs-20260728-12-f003-wind-100m.bin"
    assert run.base_url_for(3).endswith("gfs.t12z.pgrb2.0p25.f003")
    assert run.valid_time(3) == datetime(2026, 7, 28, 15, tzinfo=UTC)


@pytest.mark.parametrize("forecast_hour", [1, 5, 121, -3])
def test_runspec_rejects_unaligned_or_out_of_range_steps(forecast_hour: int) -> None:
    with pytest.raises(ValueError):
        RunSpec("20260728", "12", forecast_hour)


def test_parses_exact_uv_byte_ranges_for_the_analysis() -> None:
    records = parse_index(INDEX)
    ranges = select_wind_ranges(records, step=0, fields=("wind-10m",))

    assert ranges == {
        "wind-10m-u": ByteRange("wind-10m-u", 12, 23),
        "wind-10m-v": ByteRange("wind-10m-v", 24, 39),
    }


def test_selects_every_multilevel_and_gust_record() -> None:
    ranges = select_wind_ranges(parse_index(MULTILEVEL_INDEX), step=0)

    assert ranges == {
        "gust-10m-speed": ByteRange("gust-10m-speed", 100, 199),
        "wind-10m-u": ByteRange("wind-10m-u", 200, 299),
        "wind-10m-v": ByteRange("wind-10m-v", 300, 399),
        "wind-100m-u": ByteRange("wind-100m-u", 400, 499),
        "wind-100m-v": ByteRange("wind-100m-v", 500, 599),
    }
    assert ordered_record_keys() == (
        "wind-10m-u",
        "wind-10m-v",
        "wind-100m-u",
        "wind-100m-v",
        "gust-10m-speed",
    )
    assert record_key("gust-10m", "speed") == "gust-10m-speed"


def test_selects_forecast_step_labels_for_positive_steps() -> None:
    ranges = select_wind_ranges(parse_index(index_for_step(3)), step=3)

    assert set(ranges) == {
        "wind-10m-u",
        "wind-10m-v",
        "wind-100m-u",
        "wind-100m-v",
        "gust-10m-speed",
    }


@pytest.mark.parametrize(
    "index_text",
    [
        MULTILEVEL_INDEX.replace("UGRD:100 m above ground", "UGRD:80 m above ground"),
        MULTILEVEL_INDEX.replace("GUST:surface", "GUST:10 m above ground"),
        MULTILEVEL_INDEX.replace("GUST:surface", "GUST:surface:3 hour fcst"),
    ],
)
def test_rejects_missing_or_mislabeled_records(index_text: str) -> None:
    with pytest.raises(IncompleteCycleError):
        select_wind_ranges(parse_index(index_text), step=0)


def test_rejects_step_labels_that_do_not_match_the_requested_step() -> None:
    with pytest.raises(IncompleteCycleError):
        select_wind_ranges(parse_index(MULTILEVEL_INDEX), step=3)


def test_range_download_requests_only_selected_records() -> None:
    run = RunSpec("20260728", "12", 3)
    calls: list[tuple[str, tuple[int, int] | None]] = []

    def fake_fetch(url: str, byte_range: tuple[int, int] | None) -> bytes:
        calls.append((url, byte_range))
        assert byte_range is not None
        return bytes(byte_range[1] - byte_range[0] + 1)

    payload = download_wind_records(
        run,
        {
            "wind-10m-u": ByteRange("wind-10m-u", 200, 299),
            "wind-10m-v": ByteRange("wind-10m-v", 300, 399),
            "wind-100m-u": ByteRange("wind-100m-u", 400, 499),
            "wind-100m-v": ByteRange("wind-100m-v", 500, 599),
            "gust-10m-speed": ByteRange("gust-10m-speed", 100, 199),
        },
        step=3,
        fetcher=fake_fetch,
    )

    assert len(payload) == 500
    assert [call[1] for call in calls] == [
        (200, 299),
        (300, 399),
        (400, 499),
        (500, 599),
        (100, 199),
    ]
    assert all(call[0] == run.base_url_for(3) for call in calls)


def test_discovery_skips_incomplete_newest_cycle() -> None:
    calls: list[str] = []
    break_100m = MULTILEVEL_INDEX.replace(
        "UGRD:100 m above ground", "UGRD:80 m above ground"
    )

    def fake_fetch(url: str, byte_range: tuple[int, int] | None) -> bytes:
        calls.append(url)
        assert url.endswith(".idx")
        step = int(url.rsplit("f", 1)[-1].split(".")[0])
        if "gfs.20260728/18" in url:
            return index_for_step(step, template=break_100m).encode()
        return index_for_step(step).encode()

    plan = discover_latest_complete(
        now=datetime(2026, 7, 28, 19, tzinfo=UTC),
        steps=(0, 3, 120),
        fetcher=fake_fetch,
    )

    assert plan.run == RunSpec("20260728", "12")
    assert plan.steps == (0, 3, 120)
    assert any("gfs.20260728/18" in url for url in calls)
    assert any("gfs.20260728/12" in url for url in calls)


def test_discovery_reports_when_no_complete_cycle_exists() -> None:
    def missing_fetch(_: str, __: tuple[int, int] | None) -> bytes:
        raise PipelineError("not published")

    with pytest.raises(IncompleteCycleError, match="No complete GFS cycle"):
        discover_latest_complete(
            now=datetime(2026, 7, 28, 19, tzinfo=UTC),
            lookback_cycles=2,
            steps=(0, 3),
            fetcher=missing_fetch,
        )


def test_normalizes_rows_and_columns_to_contract_order() -> None:
    latitudes = np.repeat(
        np.array([[15.0], [16.0], [17.0]], dtype=np.float64), 3, axis=1
    )
    longitudes = np.repeat(np.array([[35.0, 34.0, 33.0]], dtype=np.float64), 3, axis=0)
    u = latitudes.astype(np.float32)
    v = longitudes.astype(np.float32)

    grid = normalize_and_crop(
        u, v, latitudes, longitudes, bounds=(33.0, 15.0, 35.0, 17.0)
    )

    assert grid.latitudes[:, 0].tolist() == [17.0, 16.0, 15.0]
    assert grid.longitudes[0, :].tolist() == [33.0, 34.0, 35.0]
    assert grid.u[0, 0] == 17.0
    assert grid.v[0, 0] == 33.0
    assert grid.dx == 1.0
    assert grid.dy == 1.0


@pytest.mark.parametrize(
    ("u_value", "v_value"),
    [(float("nan"), 1.0), (151.0, 0.0)],
)
def test_rejects_invalid_or_implausible_values(u_value: float, v_value: float) -> None:
    latitudes = np.repeat(np.array([[17.0], [16.0]], dtype=np.float64), 2, axis=1)
    longitudes = np.repeat(np.array([[33.0, 34.0]], dtype=np.float64), 2, axis=0)
    u = np.full((2, 2), u_value, dtype=np.float32)
    v = np.full((2, 2), v_value, dtype=np.float32)

    with pytest.raises(GridValidationError):
        normalize_and_crop(u, v, latitudes, longitudes, bounds=(33.0, 16.0, 34.0, 17.0))


def test_statistics_include_only_inside_centres_with_latitude_weighting() -> None:
    latitudes = np.array([[20.0, 20.0], [10.0, 10.0]], dtype=np.float64)
    longitudes = np.array([[40.0, 50.0], [40.0, 50.0]], dtype=np.float64)
    grid = normalize_and_crop(
        np.array([[3.0, 100.0], [4.0, 100.0]], dtype=np.float32),
        np.array([[4.0, 100.0], [0.0, 100.0]], dtype=np.float32),
        latitudes,
        longitudes,
        bounds=(40.0, 10.0, 50.0, 20.0),
    )
    geometry = {
        "type": "Polygon",
        "coordinates": [
            [[39.0, 9.0], [45.0, 9.0], [45.0, 21.0], [39.0, 21.0], [39.0, 9.0]]
        ],
    }

    mean, maximum, count = calculate_statistics(grid, geometry)
    expected = (18.0 * np.cos(np.radians(20.0)) + 14.4 * np.cos(np.radians(10.0))) / (
        np.cos(np.radians(20.0)) + np.cos(np.radians(10.0))
    )

    assert mean == pytest.approx(expected)
    assert maximum == pytest.approx(18.0)
    assert count == 2


def _artifacts(
    run_id: str, payload: bytes, *, step: int = 0
) -> PipelineArtifacts:
    checksum = hashlib.sha256(payload).hexdigest()
    filename = f"{run_id}-f{step:03d}-wind-10m.bin"
    grid = {
        "url": f"/api/wind/grids/{filename}",
        "encoding": ENCODING,
        "byteLength": len(payload),
        "sha256": checksum,
    }
    return PipelineArtifacts(
        run_id=run_id,
        grids={filename: payload},
        manifest={
            "schemaVersion": 2,
            "runId": run_id,
            "data": dict(grid),
            "frames": [{"step": step, "grids": {"wind-10m": dict(grid)}}],
        },
        report={"runId": run_id, "validation": {"gridSha256": checksum}},
    )


def test_atomic_publication_preserves_previous_manifest_on_failure(
    tmp_path: Path,
) -> None:
    first = _artifacts("gfs-20260728-12", b"first-grid")
    publish_artifacts(first, tmp_path)
    previous = (tmp_path / "latest.json").read_bytes()

    with pytest.raises(PipelineError, match="Immutable grid collision"):
        publish_artifacts(_artifacts("gfs-20260728-12", b"corrupt-grid"), tmp_path)

    assert (tmp_path / "latest.json").read_bytes() == previous
    assert json.loads(previous)["runId"] == "gfs-20260728-12"


def test_publication_writes_every_frame_grid_and_the_manifest_last(
    tmp_path: Path,
) -> None:
    artifacts = _artifacts("gfs-20260728-12", b"frame-0")
    paths = publish_artifacts(artifacts, tmp_path)

    assert paths[0] == tmp_path / "latest.json"
    assert (tmp_path / "grids" / "gfs-20260728-12-f000-wind-10m.bin").read_bytes() == (
        b"frame-0"
    )
    assert json.loads((tmp_path / "latest.json").read_bytes())["schemaVersion"] == 2


def test_frame_source_is_typed() -> None:
    source = FrameSource(step=3, index_text="index", payload=b"payload")

    assert source.step == 3
