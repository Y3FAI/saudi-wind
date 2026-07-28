from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
from saudi_wind_pipeline.core import (
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


def test_committed_fixture_rebuilds_the_reviewed_grid_exactly() -> None:
    run, index_text, payload = read_fixture(FIXTURE)
    artifacts = build_artifacts(
        run=run,
        index_text=index_text,
        source_payload=payload,
        boundary_path=BOUNDARY,
        fixture=True,
    )

    assert hashlib.sha256(artifacts.grid_bytes).hexdigest() == EXPECTED_GRID_SHA256
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


def test_published_vectors_match_decoded_source_cells() -> None:
    run, index_text, payload = read_fixture(FIXTURE)
    u, v, latitudes, longitudes = decode_grib(payload)
    source = normalize_and_crop(u, v, latitudes, longitudes)
    artifacts = build_artifacts(
        run=run,
        index_text=index_text,
        source_payload=payload,
        boundary_path=BOUNDARY,
        fixture=True,
    )
    published = np.frombuffer(artifacts.grid_bytes, dtype="<f4").reshape(
        source.u.shape[0], source.u.shape[1], 2
    )

    for row, column in [(0, 0), (35, 55), (74, 96)]:
        assert published[row, column, 0] == source.u[row, column]
        assert published[row, column, 1] == source.v[row, column]
