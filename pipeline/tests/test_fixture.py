from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
from saudi_wind_pipeline.core import (
    FrameSource,
    build_artifacts,
    decode_grib,
    normalize_and_crop,
    read_fixture,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "pipeline/fixtures/gfs-20260728-12-f000"
BOUNDARY = ROOT / "public/data/saudi-boundary.geo.json"
EXPECTED_GRID_SHA256 = (
    "7f333b2bf2749fbd16a28a184e140e0035ebc451ccc88838f5e6838a62e6cc78"
)


def _build():
    run, index_text, payload = read_fixture(FIXTURE)
    return build_artifacts(
        run=run,
        sources=[
            FrameSource(step=run.forecast_hour, index_text=index_text, payload=payload)
        ],
        boundary_path=BOUNDARY,
        fixture=True,
    )


def test_committed_fixture_rebuilds_the_reviewed_grid_exactly() -> None:
    artifacts = _build()
    grid_bytes = artifacts.grids["gfs-20260728-12-f000-wind-10m.bin"]

    assert hashlib.sha256(grid_bytes).hexdigest() == EXPECTED_GRID_SHA256
    assert len(grid_bytes) == 58200
    assert artifacts.manifest["grid"] == {
        "west": 33.0,
        "east": 57.0,
        "south": 15.0,
        "north": 33.5,
        "width": 97,
        "height": 75,
        "dx": 0.25,
        "dy": 0.25,
        "scan": "north-to-south-west-to-east",
    }
    assert artifacts.manifest["statistics"] == {
        "areaWeightedMeanKmh": 21.6,
        "maximumGridCellKmh": 44.2,
    }
    assert all(
        point["serializedMatch"]
        for point in artifacts.report["validation"]["comparisonPoints"]
    )
    assert "gustDirection" not in artifacts.report["validation"]


def test_fixture_manifest_is_v2_with_a_v1_compatible_mirror() -> None:
    artifacts = _build()
    manifest = artifacts.manifest
    first_grid = manifest["frames"][0]["grids"]["wind-10m"]

    assert manifest["schemaVersion"] == 2
    assert manifest["runId"] == "gfs-20260728-12"
    # Only what the run actually publishes: levels/variables are derived from the
    # frames, so the single 10 m field never advertises a grid it cannot serve.
    assert manifest["levels"] == [10]
    assert manifest["variables"] == ["wind"]
    assert manifest["heightMeters"] == 10
    assert manifest["validTime"] == manifest["frames"][0]["validTime"]
    assert manifest["data"] == first_grid
    assert manifest["statistics"] == manifest["frames"][0]["statistics"]["wind-10m"]
    assert first_grid["sha256"] == EXPECTED_GRID_SHA256
    assert first_grid["url"] == ("/api/wind/grids/gfs-20260728-12-f000-wind-10m.bin")


def test_every_frame_grid_reference_resolves_to_published_bytes() -> None:
    """No frame may point at a grid the run did not publish."""
    artifacts = _build()
    published = set(artifacts.grids)

    for frame in artifacts.manifest["frames"]:
        assert list(frame["grids"]) == ["wind-10m"]
        for field, metadata in frame["grids"].items():
            filename = metadata["url"].rsplit("/", 1)[-1]
            assert filename in published, f"{frame['step']} {field} is unresolvable"
            payload = artifacts.grids[filename]
            assert metadata["byteLength"] == len(payload)
            assert metadata["sha256"] == hashlib.sha256(payload).hexdigest()


def test_published_vectors_match_decoded_source_cells() -> None:
    _run, _index_text, payload = read_fixture(FIXTURE)
    decoded = decode_grib(payload)
    latitudes, longitudes = decoded.coordinates(["wind-10m-u", "wind-10m-v"])
    source = normalize_and_crop(
        decoded.fields["wind-10m-u"].values,
        decoded.fields["wind-10m-v"].values,
        latitudes,
        longitudes,
    )
    artifacts = _build()
    published = np.frombuffer(
        artifacts.grids["gfs-20260728-12-f000-wind-10m.bin"], dtype="<f4"
    ).reshape(source.u.shape[0], source.u.shape[1], 2)

    for row, column in [(0, 0), (35, 55), (74, 96)]:
        assert published[row, column, 0] == source.u[row, column]
        assert published[row, column, 1] == source.v[row, column]


def test_derived_levels_and_variables_follow_the_published_grids() -> None:
    """The manifest advertises exactly the grids its frames carry."""
    from saudi_wind_pipeline.core import _levels_for, _variables_for

    ten_metres = [{"grids": {"wind-10m": {}}}]

    assert _levels_for(ten_metres) == [10]
    assert _variables_for(ten_metres) == ["wind"]
    # A grid the run does not publish is not advertised.
    assert _levels_for([{"grids": {"wind-100m": {}}}]) == []
    assert _variables_for([{"grids": {"wind-100m": {}}}]) == ["wind"]
    assert _levels_for([{"grids": {}}]) == []
    assert _variables_for([{"grids": {}}]) == []
