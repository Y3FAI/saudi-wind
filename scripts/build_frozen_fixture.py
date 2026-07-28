#!/usr/bin/env python3
"""Build the one-time NOAA GFS fixture used by the Milestone 1 visual review.

Run with:
  uv run --python 3.12 --with eccodes --with numpy \
    scripts/build_frozen_fixture.py

This intentionally creates only the committed design fixture. The resilient live
ingestion pipeline belongs to Milestone 3.
"""

from __future__ import annotations

import hashlib
import json
import math
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from eccodes import (
    codes_get,
    codes_get_array,
    codes_grib_new_from_file,
    codes_release,
)


RUN_DATE = "20260728"
RUN_HOUR = "12"
BOUNDING_BOX = (33.0, 15.0, 57.0, 33.5)
BASE_URL = (
    f"https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{RUN_DATE}/"
    f"{RUN_HOUR}/atmos/gfs.t{RUN_HOUR}z.pgrb2.0p25.f000"
)
BOUNDARY_PATH = Path("public/data/saudi-boundary.geo.json")
GRID_PATH = Path("public/data/sample/wind-sample.bin")
MANIFEST_PATH = Path("public/data/sample/latest.json")


def fetch_bytes(url: str, byte_range: tuple[int, int] | None = None) -> bytes:
    headers = {"User-Agent": "saudi-wind-fixture-builder/1.0"}
    if byte_range:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def record_ranges(index_text: str) -> tuple[tuple[int, int], tuple[int, int]]:
    rows = []
    for line in index_text.splitlines():
        fields = line.split(":")
        if len(fields) >= 5:
            rows.append((int(fields[1]), fields[3], fields[4]))

    selected: dict[str, tuple[int, int]] = {}
    for index, (offset, variable, level) in enumerate(rows[:-1]):
        if variable in {"UGRD", "VGRD"} and level == "10 m above ground":
            selected[variable] = (offset, rows[index + 1][0] - 1)

    if set(selected) != {"UGRD", "VGRD"}:
        raise RuntimeError("Could not find both 10 m UGRD and VGRD records.")
    return selected["UGRD"], selected["VGRD"]


def decode_grib(payload: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    decoded: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
    with tempfile.NamedTemporaryFile(suffix=".grib2") as temporary:
        temporary.write(payload)
        temporary.flush()
        with open(temporary.name, "rb") as stream:
            while message := codes_grib_new_from_file(stream):
                try:
                    short_name = str(codes_get(message, "shortName"))
                    ni = int(codes_get(message, "Ni"))
                    nj = int(codes_get(message, "Nj"))
                    values = np.asarray(
                        codes_get_array(message, "values"),
                        dtype=np.float32,
                    ).reshape(nj, ni)
                    latitudes = np.asarray(
                        codes_get_array(message, "latitudes"),
                        dtype=np.float64,
                    ).reshape(nj, ni)
                    longitudes = np.asarray(
                        codes_get_array(message, "longitudes"),
                        dtype=np.float64,
                    ).reshape(nj, ni)
                    decoded[short_name] = (values, latitudes, longitudes)
                finally:
                    codes_release(message)

    if set(decoded) != {"10u", "10v"}:
        raise RuntimeError(f"Unexpected GRIB messages: {sorted(decoded)}")
    u, latitudes, longitudes = decoded["10u"]
    v = decoded["10v"][0]
    return u, v, latitudes, longitudes


def rings(geometry: dict[str, Any]) -> Iterable[list[list[float]]]:
    if geometry["type"] == "Polygon":
        yield from geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield from polygon
    else:
        raise RuntimeError(f"Unsupported geometry: {geometry['type']}")


def point_in_ring(longitude: float, latitude: float, ring: list[list[float]]) -> bool:
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous
        x2, y2 = current
        crosses = (y1 > latitude) != (y2 > latitude)
        if crosses:
            crossing_x = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < crossing_x:
                inside = not inside
        previous = current
    return inside


def contains(geometry: dict[str, Any], longitude: float, latitude: float) -> bool:
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    else:
        polygons = geometry["coordinates"]

    for polygon in polygons:
        if point_in_ring(longitude, latitude, polygon[0]):
            return not any(
                point_in_ring(longitude, latitude, hole)
                for hole in polygon[1:]
            )
    return False


def crop(
    u: np.ndarray,
    v: np.ndarray,
    latitudes: np.ndarray,
    longitudes: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    west, south, east, north = BOUNDING_BOX
    row_mask = (latitudes[:, 0] <= north) & (latitudes[:, 0] >= south)
    column_mask = (longitudes[0, :] >= west) & (longitudes[0, :] <= east)
    return (
        u[np.ix_(row_mask, column_mask)],
        v[np.ix_(row_mask, column_mask)],
        latitudes[np.ix_(row_mask, column_mask)],
        longitudes[np.ix_(row_mask, column_mask)],
    )


def main() -> None:
    index = fetch_bytes(f"{BASE_URL}.idx").decode("utf-8")
    u_range, v_range = record_ranges(index)
    payload = fetch_bytes(BASE_URL, (u_range[0], v_range[1]))
    u, v, latitudes, longitudes = crop(*decode_grib(payload))

    if u.shape != v.shape or u.size == 0:
        raise RuntimeError("The cropped wind components have invalid dimensions.")
    if not np.isfinite(u).all() or not np.isfinite(v).all():
        raise RuntimeError("The fixture contains non-finite wind vectors.")

    vectors = np.stack((u, v), axis=-1).astype("<f4", copy=False)
    speed_kmh = np.hypot(u, v) * 3.6
    boundary = json.loads(BOUNDARY_PATH.read_text(encoding="utf-8"))
    geometry = boundary["geometry"]

    weighted_sum = 0.0
    total_weight = 0.0
    maximum = 0.0
    for row, column in np.ndindex(speed_kmh.shape):
        longitude = float(longitudes[row, column])
        latitude = float(latitudes[row, column])
        if contains(geometry, longitude, latitude):
            speed = float(speed_kmh[row, column])
            weight = math.cos(math.radians(latitude))
            weighted_sum += speed * weight
            total_weight += weight
            maximum = max(maximum, speed)

    if total_weight == 0:
        raise RuntimeError("No GFS grid-cell centres were inside Saudi Arabia.")

    GRID_PATH.parent.mkdir(parents=True, exist_ok=True)
    grid_bytes = vectors.tobytes(order="C")
    GRID_PATH.write_bytes(grid_bytes)

    run_time = datetime.strptime(
        f"{RUN_DATE}{RUN_HOUR}",
        "%Y%m%d%H",
    ).replace(tzinfo=timezone.utc)
    manifest = {
        "schemaVersion": 1,
        "runId": f"gfs-{RUN_DATE}-{RUN_HOUR}-f000-sample",
        "provider": "NOAA_GFS",
        "modelRun": run_time.isoformat().replace("+00:00", "Z"),
        "validTime": run_time.isoformat().replace("+00:00", "Z"),
        "publishedAt": run_time.isoformat().replace("+00:00", "Z"),
        "heightMeters": 10,
        "sourceUnits": "m/s",
        "displayUnits": "km/h",
        "sample": True,
        "grid": {
            "west": float(longitudes[0, 0]),
            "east": float(longitudes[0, -1]),
            "south": float(latitudes[-1, 0]),
            "north": float(latitudes[0, 0]),
            "width": int(u.shape[1]),
            "height": int(u.shape[0]),
            "dx": 0.25,
            "dy": 0.25,
            "scan": "north-to-south-west-to-east",
        },
        "data": {
            "url": "/data/sample/wind-sample.bin",
            "encoding": "float32-le-uv-interleaved",
            "byteLength": len(grid_bytes),
            "sha256": hashlib.sha256(grid_bytes).hexdigest(),
        },
        "statistics": {
            "areaWeightedMeanKmh": round(weighted_sum / total_weight, 1),
            "maximumGridCellKmh": round(maximum, 1),
        },
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {u.shape[1]}x{u.shape[0]} fixture to {GRID_PATH} "
        f"({len(grid_bytes)} bytes)"
    )


if __name__ == "__main__":
    main()
