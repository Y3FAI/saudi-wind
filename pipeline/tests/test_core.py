from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from saudi_wind_pipeline.core import (
    ByteRange,
    GridValidationError,
    IncompleteCycleError,
    PipelineArtifacts,
    PipelineError,
    RunSpec,
    calculate_statistics,
    discover_latest_complete,
    download_wind_records,
    normalize_and_crop,
    parse_index,
    publish_artifacts,
    select_wind_ranges,
)

INDEX = """\
1:0:d=2026072812:TMP:surface:anl:
2:12:d=2026072812:UGRD:10 m above ground:anl:
3:24:d=2026072812:VGRD:10 m above ground:anl:
4:40:d=2026072812:ICEG:surface:anl:
"""


def test_parses_exact_uv_byte_ranges() -> None:
    records = parse_index(INDEX)
    ranges = select_wind_ranges(records)

    assert ranges == {
        "UGRD": ByteRange("UGRD", 12, 23),
        "VGRD": ByteRange("VGRD", 24, 39),
    }


@pytest.mark.parametrize(
    "index_text",
    [
        "1:0:d=2026072812:UGRD:10 m above ground:anl:\n",
        INDEX.replace("VGRD", "VVEL"),
        INDEX.replace("10 m above ground", "80 m above ground"),
    ],
)
def test_rejects_missing_or_incomplete_index(index_text: str) -> None:
    with pytest.raises(IncompleteCycleError):
        select_wind_ranges(parse_index(index_text))


def test_range_download_requests_only_selected_records() -> None:
    run = RunSpec("20260728", "12")
    calls: list[tuple[str, tuple[int, int] | None]] = []

    def fake_fetch(url: str, byte_range: tuple[int, int] | None) -> bytes:
        calls.append((url, byte_range))
        assert byte_range is not None
        return bytes(byte_range[1] - byte_range[0] + 1)

    payload = download_wind_records(
        run,
        {
            "UGRD": ByteRange("UGRD", 12, 23),
            "VGRD": ByteRange("VGRD", 24, 39),
        },
        fetcher=fake_fetch,
    )

    assert len(payload) == 28
    assert [call[1] for call in calls] == [(12, 23), (24, 39)]
    assert all(call[0] == run.base_url for call in calls)


def test_discovery_skips_incomplete_newest_cycle() -> None:
    calls: list[str] = []
    incomplete = INDEX.replace("VGRD", "VVEL")

    def fake_fetch(url: str, byte_range: tuple[int, int] | None) -> bytes:
        calls.append(url)
        if "gfs.20260728/18" in url and url.endswith(".idx"):
            return incomplete.encode()
        if url.endswith(".idx"):
            return INDEX.encode()
        assert byte_range in {(20, 23), (36, 39)}
        return bytes(4)

    run, _, ranges = discover_latest_complete(
        now=datetime(2026, 7, 28, 19, tzinfo=UTC),
        fetcher=fake_fetch,
    )

    assert run == RunSpec("20260728", "12")
    assert set(ranges) == {"UGRD", "VGRD"}
    assert any("gfs.20260728/18" in url for url in calls)
    assert any("gfs.20260728/12" in url for url in calls)


def test_discovery_reports_when_no_complete_cycle_exists() -> None:
    def missing_fetch(_: str, __: tuple[int, int] | None) -> bytes:
        raise PipelineError("not published")

    with pytest.raises(IncompleteCycleError, match="No complete GFS cycle"):
        discover_latest_complete(
            now=datetime(2026, 7, 28, 19, tzinfo=UTC),
            lookback_cycles=2,
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


def _artifacts(run_id: str, payload: bytes) -> PipelineArtifacts:
    checksum = hashlib.sha256(payload).hexdigest()
    return PipelineArtifacts(
        run_id=run_id,
        grid_bytes=payload,
        manifest={
            "runId": run_id,
            "data": {"sha256": checksum},
        },
        report={"runId": run_id, "validation": {"gridSha256": checksum}},
    )


def test_atomic_publication_preserves_previous_manifest_on_failure(
    tmp_path: Path,
) -> None:
    first = _artifacts("first", b"first-grid")
    publish_artifacts(first, tmp_path)
    previous = (tmp_path / "latest.json").read_bytes()

    with pytest.raises(PipelineError, match="Immutable grid collision"):
        publish_artifacts(_artifacts("first", b"corrupt-grid"), tmp_path)

    assert (tmp_path / "latest.json").read_bytes() == previous
    assert json.loads(previous)["runId"] == "first"
