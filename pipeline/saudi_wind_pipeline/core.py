from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
from eccodes import (
    codes_get,
    codes_get_array,
    codes_grib_new_from_file,
    codes_release,
)

NOAA_BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
GRID_BOUNDS = (33.0, 15.0, 57.0, 33.5)
MAX_PLAUSIBLE_SPEED_MS = 150.0
USER_AGENT = "saudi-wind-pipeline/0.3 (+https://github.com/Y3FAI/saudi-wind)"


class PipelineError(RuntimeError):
    """Base error for a rejected or unavailable source run."""


class IncompleteCycleError(PipelineError):
    """The requested GFS cycle does not expose both required records."""


class GridValidationError(PipelineError):
    """Decoded or normalized grid data failed validation."""


@dataclass(frozen=True)
class RunSpec:
    date: str
    hour: str
    forecast_hour: int = 0

    def __post_init__(self) -> None:
        datetime.strptime(self.date, "%Y%m%d").replace(tzinfo=UTC)
        if self.hour not in {"00", "06", "12", "18"}:
            raise ValueError("GFS hour must be 00, 06, 12, or 18.")
        if self.forecast_hour != 0:
            raise ValueError("Version 1 processes only the f000 analysis.")

    @property
    def model_run(self) -> datetime:
        return datetime.strptime(f"{self.date}{self.hour}", "%Y%m%d%H").replace(
            tzinfo=UTC
        )

    @property
    def run_id(self) -> str:
        return f"gfs-{self.date}-{self.hour}-f{self.forecast_hour:03d}"

    @property
    def base_url(self) -> str:
        filename = f"gfs.t{self.hour}z.pgrb2.0p25.f{self.forecast_hour:03d}"
        return f"{NOAA_BUCKET}/gfs.{self.date}/{self.hour}/atmos/{filename}"


@dataclass(frozen=True)
class IndexRecord:
    number: int
    offset: int
    reference: str
    variable: str
    level: str
    forecast: str


@dataclass(frozen=True)
class ByteRange:
    variable: str
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1


@dataclass(frozen=True)
class NormalizedGrid:
    u: np.ndarray
    v: np.ndarray
    latitudes: np.ndarray
    longitudes: np.ndarray
    dx: float
    dy: float


@dataclass(frozen=True)
class PipelineArtifacts:
    run_id: str
    grid_bytes: bytes
    manifest: dict[str, Any]
    report: dict[str, Any]


FetchBytes = Callable[[str, tuple[int, int] | None], bytes]


def fetch_bytes(
    url: str,
    byte_range: tuple[int, int] | None = None,
    *,
    timeout: float = 90,
) -> bytes:
    headers = {"User-Agent": USER_AGENT}
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", response.getcode())
            if byte_range is not None and status != 206:
                raise PipelineError(f"NOAA ignored requested byte range for {url}.")
            payload = response.read()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
        raise PipelineError(f"Could not fetch NOAA source: {url}") from error

    if byte_range is not None:
        expected = byte_range[1] - byte_range[0] + 1
        if len(payload) != expected:
            raise PipelineError(
                f"NOAA byte range was incomplete: expected {expected}, "
                f"received {len(payload)}."
            )
    return payload


def parse_index(index_text: str) -> list[IndexRecord]:
    records: list[IndexRecord] = []
    for line_number, line in enumerate(index_text.splitlines(), start=1):
        if not line.strip():
            continue
        fields = line.split(":")
        if len(fields) < 6:
            raise IncompleteCycleError(
                f"Malformed GRIB index row {line_number}: {line!r}"
            )
        try:
            number = int(fields[0])
            offset = int(fields[1])
        except ValueError as error:
            raise IncompleteCycleError(
                f"Invalid GRIB index offset on row {line_number}."
            ) from error
        records.append(
            IndexRecord(
                number=number,
                offset=offset,
                reference=fields[2],
                variable=fields[3],
                level=fields[4],
                forecast=fields[5],
            )
        )

    if len(records) < 2:
        raise IncompleteCycleError("GRIB index does not contain enough records.")
    if any(
        current.offset >= following.offset for current, following in pairwise(records)
    ):
        raise IncompleteCycleError("GRIB index offsets are not increasing.")
    return records


def select_wind_ranges(records: Sequence[IndexRecord]) -> dict[str, ByteRange]:
    selected: dict[str, ByteRange] = {}
    for index, record in enumerate(records[:-1]):
        if (
            record.variable in {"UGRD", "VGRD"}
            and record.level == "10 m above ground"
            and record.forecast in {"anl", "0 hour fcst"}
        ):
            selected[record.variable] = ByteRange(
                variable=record.variable,
                start=record.offset,
                end=records[index + 1].offset - 1,
            )
    if set(selected) != {"UGRD", "VGRD"}:
        raise IncompleteCycleError(
            "Cycle is incomplete: 10 m UGRD and VGRD f000 are required."
        )
    return selected


def discover_latest_complete(
    *,
    now: datetime | None = None,
    lookback_cycles: int = 12,
    fetcher: FetchBytes = fetch_bytes,
) -> tuple[RunSpec, str, dict[str, ByteRange]]:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    candidate_hour = (current.hour // 6) * 6
    candidate = current.replace(hour=candidate_hour, minute=0, second=0, microsecond=0)

    errors: list[str] = []
    for cycle_index in range(lookback_cycles):
        instant = candidate - timedelta(hours=cycle_index * 6)
        run = RunSpec(instant.strftime("%Y%m%d"), instant.strftime("%H"))
        try:
            index_text = fetcher(f"{run.base_url}.idx", None).decode("utf-8")
            ranges = select_wind_ranges(parse_index(index_text))
            for byte_range in ranges.values():
                fetcher(
                    run.base_url,
                    (max(byte_range.start, byte_range.end - 3), byte_range.end),
                )
            return run, index_text, ranges
        except (PipelineError, UnicodeDecodeError) as error:
            errors.append(f"{run.run_id}: {error}")

    raise IncompleteCycleError(
        "No complete GFS cycle found in the configured lookback. " + " | ".join(errors)
    )


def download_wind_records(
    run: RunSpec,
    ranges: Mapping[str, ByteRange],
    *,
    fetcher: FetchBytes = fetch_bytes,
) -> bytes:
    payloads = []
    for variable in ("UGRD", "VGRD"):
        byte_range = ranges[variable]
        payloads.append(fetcher(run.base_url, (byte_range.start, byte_range.end)))
    return b"".join(payloads)


def decode_grib(
    payload: bytes,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
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
                        codes_get_array(message, "values"), dtype=np.float32
                    ).reshape(nj, ni)
                    latitudes = np.asarray(
                        codes_get_array(message, "latitudes"), dtype=np.float64
                    ).reshape(nj, ni)
                    longitudes = np.asarray(
                        codes_get_array(message, "longitudes"), dtype=np.float64
                    ).reshape(nj, ni)
                    decoded[short_name] = (values, latitudes, longitudes)
                finally:
                    codes_release(message)

    if set(decoded) != {"10u", "10v"}:
        raise GridValidationError(
            f"Expected only 10u and 10v; decoded {sorted(decoded)}."
        )
    u, latitudes, longitudes = decoded["10u"]
    v, v_latitudes, v_longitudes = decoded["10v"]
    if not np.array_equal(latitudes, v_latitudes) or not np.array_equal(
        longitudes, v_longitudes
    ):
        raise GridValidationError("U and V coordinates do not match.")
    return u, v, latitudes, longitudes


def normalize_and_crop(
    u: np.ndarray,
    v: np.ndarray,
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    bounds: tuple[float, float, float, float] = GRID_BOUNDS,
) -> NormalizedGrid:
    arrays = (u, v, latitudes, longitudes)
    if any(array.ndim != 2 for array in arrays):
        raise GridValidationError("Wind components and coordinates must be 2D.")
    if len({array.shape for array in arrays}) != 1 or u.size == 0:
        raise GridValidationError("Wind component dimensions do not match.")
    if not all(np.isfinite(array).all() for array in arrays):
        raise GridValidationError("Grid contains non-finite values.")
    if float(np.max(np.hypot(u, v))) > MAX_PLAUSIBLE_SPEED_MS:
        raise GridValidationError("Grid contains implausible wind speeds.")

    row_latitudes = latitudes[:, 0]
    column_longitudes = longitudes[0, :]
    if not np.allclose(latitudes, row_latitudes[:, None], atol=1e-6):
        raise GridValidationError("Latitude rows are not rectilinear.")
    if not np.allclose(longitudes, column_longitudes[None, :], atol=1e-6):
        raise GridValidationError("Longitude columns are not rectilinear.")

    west, south, east, north = bounds
    row_indices = np.flatnonzero((row_latitudes >= south) & (row_latitudes <= north))
    column_indices = np.flatnonzero(
        (column_longitudes >= west) & (column_longitudes <= east)
    )
    if row_indices.size < 2 or column_indices.size < 2:
        raise GridValidationError("Saudi crop contains too few grid cells.")

    row_indices = row_indices[np.argsort(row_latitudes[row_indices])[::-1]]
    column_indices = column_indices[np.argsort(column_longitudes[column_indices])]
    cropped_latitudes = latitudes[np.ix_(row_indices, column_indices)]
    cropped_longitudes = longitudes[np.ix_(row_indices, column_indices)]
    cropped_u = u[np.ix_(row_indices, column_indices)]
    cropped_v = v[np.ix_(row_indices, column_indices)]

    latitude_axis = cropped_latitudes[:, 0]
    longitude_axis = cropped_longitudes[0, :]
    dy_values = -np.diff(latitude_axis)
    dx_values = np.diff(longitude_axis)
    if (
        np.any(dy_values <= 0)
        or np.any(dx_values <= 0)
        or not np.allclose(dy_values, dy_values[0], atol=1e-6)
        or not np.allclose(dx_values, dx_values[0], atol=1e-6)
    ):
        raise GridValidationError("Normalized grid spacing is inconsistent.")

    return NormalizedGrid(
        u=cropped_u,
        v=cropped_v,
        latitudes=cropped_latitudes,
        longitudes=cropped_longitudes,
        dx=float(dx_values[0]),
        dy=float(dy_values[0]),
    )


def _point_in_ring(
    longitude: float, latitude: float, ring: Sequence[Sequence[float]]
) -> bool:
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > latitude) != (y2 > latitude):
            crossing_x = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < crossing_x:
                inside = not inside
        previous = current
    return inside


def contains(geometry: Mapping[str, Any], longitude: float, latitude: float) -> bool:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        polygons = [coordinates]
    elif geometry_type == "MultiPolygon":
        polygons = coordinates
    else:
        raise GridValidationError(f"Unsupported geometry: {geometry_type}")

    for polygon in polygons:
        if _point_in_ring(longitude, latitude, polygon[0]):
            return not any(
                _point_in_ring(longitude, latitude, hole) for hole in polygon[1:]
            )
    return False


def calculate_statistics(
    grid: NormalizedGrid, geometry: Mapping[str, Any]
) -> tuple[float, float, int]:
    speed_kmh = np.hypot(grid.u, grid.v) * 3.6
    weighted_sum = 0.0
    total_weight = 0.0
    maximum = 0.0
    included_cells = 0
    for row, column in np.ndindex(speed_kmh.shape):
        longitude = float(grid.longitudes[row, column])
        latitude = float(grid.latitudes[row, column])
        if not contains(geometry, longitude, latitude):
            continue
        speed = float(speed_kmh[row, column])
        weight = math.cos(math.radians(latitude))
        weighted_sum += speed * weight
        total_weight += weight
        maximum = max(maximum, speed)
        included_cells += 1
    if not total_weight:
        raise GridValidationError("No GFS grid-cell centres are inside Saudi Arabia.")
    return weighted_sum / total_weight, maximum, included_cells


def _iso8601(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _geometry_from_path(boundary_path: Path) -> Mapping[str, Any]:
    boundary = json.loads(boundary_path.read_text(encoding="utf-8"))
    geometry = boundary.get("geometry", boundary)
    if not isinstance(geometry, dict):
        raise GridValidationError("Saudi boundary is invalid.")
    return geometry


def build_artifacts(
    *,
    run: RunSpec,
    index_text: str,
    source_payload: bytes,
    boundary_path: Path,
    data_url_prefix: str = "/data/processed/grids",
    published_at: datetime | None = None,
    fixture: bool = False,
) -> PipelineArtifacts:
    ranges = select_wind_ranges(parse_index(index_text))
    u, v, latitudes, longitudes = decode_grib(source_payload)
    grid = normalize_and_crop(u, v, latitudes, longitudes)
    mean, maximum, included_cells = calculate_statistics(
        grid, _geometry_from_path(boundary_path)
    )

    vectors = np.stack((grid.u, grid.v), axis=-1).astype("<f4", copy=False)
    grid_bytes = vectors.tobytes(order="C")
    expected_bytes = grid.u.shape[0] * grid.u.shape[1] * 8
    if len(grid_bytes) != expected_bytes:
        raise GridValidationError("Serialized grid length is invalid.")
    published_vectors = np.frombuffer(grid_bytes, dtype="<f4").reshape(
        grid.u.shape[0], grid.u.shape[1], 2
    )
    comparison_points = []
    for name, longitude, latitude in (
        ("Riyadh grid cell", 46.75, 24.75),
        ("Jeddah grid cell", 39.25, 21.5),
        ("Dammam grid cell", 50.0, 26.5),
    ):
        column = round((longitude - float(grid.longitudes[0, 0])) / grid.dx)
        row = round((float(grid.latitudes[0, 0]) - latitude) / grid.dy)
        source_vector = np.array(
            [grid.u[row, column], grid.v[row, column]], dtype="<f4"
        )
        serialized_vector = published_vectors[row, column]
        comparison_points.append(
            {
                "name": name,
                "longitude": longitude,
                "latitude": latitude,
                "uMs": round(float(source_vector[0]), 4),
                "vMs": round(float(source_vector[1]), 4),
                "speedKmh": round(float(np.hypot(*source_vector) * 3.6), 1),
                "serializedMatch": bool(
                    np.array_equal(source_vector, serialized_vector)
                ),
            }
        )
    if not all(point["serializedMatch"] for point in comparison_points):
        raise GridValidationError(
            "Serialized comparison points differ from decoded source values."
        )

    run_time = run.model_run
    grid_name = f"{run.run_id}.bin"
    manifest = {
        "schemaVersion": 1,
        "runId": run.run_id,
        "provider": "NOAA_GFS",
        "modelRun": _iso8601(run_time),
        "validTime": _iso8601(run_time),
        "publishedAt": _iso8601(published_at or run_time),
        "heightMeters": 10,
        "sourceUnits": "m/s",
        "displayUnits": "km/h",
        "sample": fixture,
        "grid": {
            "west": float(grid.longitudes[0, 0]),
            "east": float(grid.longitudes[0, -1]),
            "south": float(grid.latitudes[-1, 0]),
            "north": float(grid.latitudes[0, 0]),
            "width": int(grid.u.shape[1]),
            "height": int(grid.u.shape[0]),
            "dx": grid.dx,
            "dy": grid.dy,
            "scan": "north-to-south-west-to-east",
        },
        "data": {
            "url": f"{data_url_prefix}/{grid_name}",
            "encoding": "float32-le-uv-interleaved",
            "byteLength": len(grid_bytes),
            "sha256": hashlib.sha256(grid_bytes).hexdigest(),
        },
        "statistics": {
            "areaWeightedMeanKmh": round(mean, 1),
            "maximumGridCellKmh": round(maximum, 1),
        },
    }
    report = {
        "runId": run.run_id,
        "source": {
            "provider": "NOAA_GFS",
            "url": run.base_url,
            "indexUrl": f"{run.base_url}.idx",
            "indexSha256": hashlib.sha256(index_text.encode()).hexdigest(),
            "recordRanges": {
                variable: {
                    "start": byte_range.start,
                    "end": byte_range.end,
                    "byteLength": byte_range.length,
                }
                for variable, byte_range in ranges.items()
            },
            "downloadedByteLength": len(source_payload),
            "downloadedSha256": hashlib.sha256(source_payload).hexdigest(),
        },
        "validation": {
            "dimensions": [int(grid.u.shape[1]), int(grid.u.shape[0])],
            "scan": "north-to-south-west-to-east",
            "finiteValues": True,
            "maximumSourceSpeedMs": round(float(np.max(np.hypot(grid.u, grid.v))), 4),
            "plausibleSpeedLimitMs": MAX_PLAUSIBLE_SPEED_MS,
            "insideSaudiCellCount": included_cells,
            "gridByteLength": len(grid_bytes),
            "gridSha256": manifest["data"]["sha256"],
            "comparisonPoints": comparison_points,
        },
        "statistics": manifest["statistics"],
    }
    return PipelineArtifacts(run.run_id, grid_bytes, manifest, report)


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    ).encode("utf-8")


def publish_artifacts(
    artifacts: PipelineArtifacts, output_directory: Path
) -> tuple[Path, Path, Path]:
    output_directory.mkdir(parents=True, exist_ok=True)
    grids_directory = output_directory / "grids"
    reports_directory = output_directory / "reports"
    grids_directory.mkdir(exist_ok=True)
    reports_directory.mkdir(exist_ok=True)

    grid_path = grids_directory / f"{artifacts.run_id}.bin"
    report_path = reports_directory / f"{artifacts.run_id}.validation.json"
    manifest_path = output_directory / "latest.json"
    if grid_path.exists() and grid_path.read_bytes() != artifacts.grid_bytes:
        raise PipelineError(
            f"Immutable grid collision for {artifacts.run_id}; refusing overwrite."
        )

    with tempfile.TemporaryDirectory(
        prefix=".publish-", dir=output_directory
    ) as staging_name:
        staging = Path(staging_name)
        staged_grid = staging / grid_path.name
        staged_report = staging / report_path.name
        staged_manifest = staging / manifest_path.name
        staged_grid.write_bytes(artifacts.grid_bytes)
        staged_report.write_bytes(_json_bytes(artifacts.report))
        staged_manifest.write_bytes(_json_bytes(artifacts.manifest))

        if (
            hashlib.sha256(staged_grid.read_bytes()).hexdigest()
            != (artifacts.manifest["data"]["sha256"])
        ):
            raise PipelineError("Staged grid checksum verification failed.")
        os.replace(staged_grid, grid_path)
        os.replace(staged_report, report_path)
        os.replace(staged_manifest, manifest_path)

    return manifest_path, grid_path, report_path


def read_fixture(
    fixture_directory: Path,
) -> tuple[RunSpec, str, bytes]:
    metadata = json.loads(
        (fixture_directory / "metadata.json").read_text(encoding="utf-8")
    )
    run = RunSpec(metadata["date"], metadata["hour"])
    index_text = (fixture_directory / "source.idx").read_text(encoding="utf-8")
    payload = (fixture_directory / "wind-records.grib2").read_bytes()
    expected = metadata["sourceSha256"]
    actual = hashlib.sha256(payload).hexdigest()
    if actual != expected:
        raise PipelineError(
            f"Fixture checksum mismatch: expected {expected}, received {actual}."
        )
    return run, index_text, payload


def capture_fixture(
    *,
    run: RunSpec,
    fixture_directory: Path,
    fetcher: FetchBytes = fetch_bytes,
) -> None:
    index_text = fetcher(f"{run.base_url}.idx", None).decode("utf-8")
    ranges = select_wind_ranges(parse_index(index_text))
    payload = download_wind_records(run, ranges, fetcher=fetcher)
    fixture_directory.mkdir(parents=True, exist_ok=True)
    (fixture_directory / "source.idx").write_text(index_text, encoding="utf-8")
    (fixture_directory / "wind-records.grib2").write_bytes(payload)
    metadata = {
        "date": run.date,
        "hour": run.hour,
        "forecastHour": run.forecast_hour,
        "sourceUrl": run.base_url,
        "sourceSha256": hashlib.sha256(payload).hexdigest(),
    }
    (fixture_directory / "metadata.json").write_bytes(_json_bytes(metadata))
