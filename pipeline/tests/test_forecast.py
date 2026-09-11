from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import numpy as np
import pytest
from saudi_wind_pipeline.core import (
    ENCODING,
    WIND_FIELDS,
    GridValidationError,
    NormalizedGrid,
    RunSpec,
    assemble_manifest,
    build_frame,
    field_grids,
    gust_vector,
)

RUN = RunSpec("20260728", "12")
GEOMETRY = {
    "type": "Polygon",
    "coordinates": [
        [[32.0, 14.0], [58.0, 14.0], [58.0, 34.0], [32.0, 34.0], [32.0, 14.0]]
    ],
}


def _grid(height: int = 2, width: int = 3, offset: float = 0.0) -> NormalizedGrid:
    latitudes = np.repeat(
        np.array([[33.0 - index for index in range(height)]], dtype=np.float64).T,
        width,
        axis=1,
    )
    longitudes = np.repeat(
        np.array([[33.0 + index for index in range(width)]], dtype=np.float64),
        height,
        axis=0,
    )
    return NormalizedGrid(
        u=np.full((height, width), 1.0 + offset, dtype=np.float32),
        v=np.full((height, width), 2.0 + offset, dtype=np.float32),
        latitudes=latitudes,
        longitudes=longitudes,
        dx=1.0,
        dy=1.0,
    )


def _frame(step: int, fields: tuple[str, ...] = WIND_FIELDS) -> dict:
    return build_frame(
        grids={field: _grid(offset=step * 0.5) for field in fields},
        geometry=GEOMETRY,
        run=RUN,
        step=step,
    )


def _payloads(frame: dict) -> dict[str, bytes]:
    return {
        field: metadata.pop("_bytes") for field, metadata in frame["grids"].items()
    }


def test_multi_frame_manifest_reference_order_and_hashes() -> None:
    frames = [_frame(step) for step in (6, 0, 3)]
    for frame in frames:
        _payloads(frame)  # drop the transient payloads before assembly

    manifest = assemble_manifest(
        run=RUN,
        frames=frames,
        published_at=datetime(2026, 7, 28, 13, tzinfo=UTC),
        grid={"west": 33.0, "east": 57.0, "south": 15.0, "north": 33.5,
              "width": 97, "height": 75, "dx": 0.25, "dy": 0.25},
    )

    assert manifest["schemaVersion"] == 2
    assert manifest["runId"] == "gfs-20260728-12"
    assert manifest["provider"] == "NOAA_GFS"
    assert manifest["modelRun"] == "2026-07-28T12:00:00Z"
    assert manifest["publishedAt"] == "2026-07-28T13:00:00Z"
    assert manifest["sourceUnits"] == "m/s"
    assert manifest["displayUnits"] == "km/h"
    assert manifest["sample"] is False
    assert manifest["levels"] == [10, 100]
    assert manifest["variables"] == ["wind", "gust"]
    assert [frame["step"] for frame in manifest["frames"]] == [0, 3, 6]
    assert [frame["validTime"] for frame in manifest["frames"]] == [
        "2026-07-28T12:00:00Z",
        "2026-07-28T15:00:00Z",
        "2026-07-28T18:00:00Z",
    ]
    for frame in manifest["frames"]:
        assert list(frame["grids"]) == list(WIND_FIELDS)
        for metadata in frame["grids"].values():
            assert metadata["encoding"] == ENCODING
            assert metadata["byteLength"] == 2 * 3 * 8
            assert len(metadata["sha256"]) == 64
        for statistics in frame["statistics"].values():
            assert set(statistics) == {"areaWeightedMeanKmh", "maximumGridCellKmh"}


def test_grid_hashes_match_the_serialized_vectors() -> None:
    frame = _frame(0)
    payloads = _payloads(frame)
    manifest = assemble_manifest(
        run=RUN,
        frames=[frame],
        published_at=RUN.model_run,
        grid={"west": 33.0, "east": 57.0, "south": 15.0, "north": 33.5,
              "width": 97, "height": 75, "dx": 0.25, "dy": 0.25},
    )

    for field, payload in payloads.items():
        metadata = manifest["frames"][0]["grids"][field]
        assert metadata["byteLength"] == len(payload)
        assert metadata["sha256"] == hashlib.sha256(payload).hexdigest()
        assert metadata["url"] == f"/api/wind/grids/gfs-20260728-12-f000-{field}.bin"


def test_single_step_manifest_keeps_the_v1_compatible_mirror() -> None:
    frame = _frame(0)
    _payloads(frame)
    manifest = assemble_manifest(
        run=RUN,
        frames=[frame],
        published_at=RUN.model_run,
        grid={"west": 33.0, "east": 57.0, "south": 15.0, "north": 33.5,
              "width": 97, "height": 75, "dx": 0.25, "dy": 0.25},
    )

    assert len(manifest["frames"]) == 1
    assert manifest["data"] == manifest["frames"][0]["grids"]["wind-10m"]
    assert manifest["statistics"] == manifest["frames"][0]["statistics"]["wind-10m"]
    assert manifest["heightMeters"] == 10
    assert manifest["validTime"] == manifest["frames"][0]["validTime"]
    for key in ("url", "encoding", "byteLength", "sha256"):
        assert key in manifest["data"]


def test_assemble_manifest_rejects_an_empty_frame_list() -> None:
    with pytest.raises(GridValidationError):
        assemble_manifest(
            run=RUN,
            frames=[],
            published_at=RUN.model_run,
            grid={},
        )


def test_gust_vector_preserves_direction_at_gust_magnitude() -> None:
    gust_u, gust_v = gust_vector(
        np.array([[10.0]], dtype=np.float32),
        np.array([[3.0]], dtype=np.float32),
        np.array([[4.0]], dtype=np.float32),
    )

    assert gust_u[0, 0] == pytest.approx(6.0)
    assert gust_v[0, 0] == pytest.approx(8.0)
    assert float(np.hypot(gust_u[0, 0], gust_v[0, 0])) == pytest.approx(10.0)


def test_gust_vector_is_zero_when_the_wind_is_calm() -> None:
    gust_u, gust_v = gust_vector(
        np.array([[10.0]], dtype=np.float32),
        np.array([[0.0]], dtype=np.float32),
        np.array([[0.0]], dtype=np.float32),
    )

    assert gust_u[0, 0] == 0.0
    assert gust_v[0, 0] == 0.0


def test_field_grids_requires_every_requested_field() -> None:
    with pytest.raises(GridValidationError):
        field_grids(
            WIND_FIELDS,
            {
                "wind-10m": (
                    _grid().u,
                    _grid().v,
                    _grid().latitudes,
                    _grid().longitudes,
                )
            },
        )
