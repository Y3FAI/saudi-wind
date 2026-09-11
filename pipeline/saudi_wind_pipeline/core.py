from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
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
USER_AGENT = "saudi-wind-pipeline/0.4 (+https://github.com/Y3FAI/saudi-wind)"

MANIFEST_SCHEMA_VERSION = 2
ENCODING = "float32-le-uv-interleaved"
DEFAULT_DATA_URL_PREFIX = "/api/wind/grids"

#: The frozen multi-level field set: two wind levels plus 10 m wind gusts.
WIND_FIELDS: tuple[str, ...] = ("wind-10m", "wind-100m", "gust-10m")

#: Published levels and variable families advertised in the manifest.
PUBLISHED_LEVELS: tuple[int, ...] = (10, 100)
PUBLISHED_VARIABLES: tuple[str, ...] = ("wind", "gust")

#: 3-hourly forecast steps, f000 through f120 inclusive (41 frames).
FORECAST_STEPS: tuple[int, ...] = tuple(range(0, 121, 3))
MAX_FORECAST_STEP = FORECAST_STEPS[-1]
STEP_INTERVAL_HOURS = 3

#: GRIB index selectors: (field, component, index variable, index level).
RECORD_SELECTORS: tuple[tuple[str, str, str, str], ...] = (
    ("wind-10m", "u", "UGRD", "10 m above ground"),
    ("wind-10m", "v", "VGRD", "10 m above ground"),
    ("wind-100m", "u", "UGRD", "100 m above ground"),
    ("wind-100m", "v", "VGRD", "100 m above ground"),
    ("gust-10m", "speed", "GUST", "surface"),
)


class PipelineError(RuntimeError):
    """Base error for a rejected or unavailable source run."""


class IncompleteCycleError(PipelineError):
    """The requested GFS cycle does not expose every required record."""


class GridValidationError(PipelineError):
    """Decoded or normalized grid data failed validation."""


def record_key(field: str, component: str) -> str:
    """Canonical byte-range / decode key for one GRIB record."""
    return f"{field}-{component}"


def grid_filename(run_id: str, step: int, field: str) -> str:
    return f"{run_id}-f{step:03d}-{field}.bin"


def valid_time(model_run: datetime, step: int) -> datetime:
    return model_run + timedelta(hours=step)


@dataclass(frozen=True)
class RunSpec:
    date: str
    hour: str
    forecast_hour: int = 0

    def __post_init__(self) -> None:
        datetime.strptime(self.date, "%Y%m%d").replace(tzinfo=UTC)
        if self.hour not in {"00", "06", "12", "18"}:
            raise ValueError("GFS hour must be 00, 06, 12, or 18.")
        if (
            self.forecast_hour < 0
            or self.forecast_hour > MAX_FORECAST_STEP
            or self.forecast_hour % STEP_INTERVAL_HOURS
        ):
            raise ValueError(
                "GFS forecast hour must be a 3-hourly step between 0 and "
                f"{MAX_FORECAST_STEP}."
            )

    @property
    def model_run(self) -> datetime:
        return datetime.strptime(f"{self.date}{self.hour}", "%Y%m%d%H").replace(
            tzinfo=UTC
        )

    @property
    def run_id(self) -> str:
        # Contract: runId identifies the cycle, frames carry the step suffix.
        return f"gfs-{self.date}-{self.hour}"

    def grid_filename(self, step: int, field: str) -> str:
        return grid_filename(self.run_id, step, field)

    def valid_time(self, step: int) -> datetime:
        return valid_time(self.model_run, step)

    def base_url_for(self, step: int) -> str:
        filename = f"gfs.t{self.hour}z.pgrb2.0p25.f{step:03d}"
        return f"{NOAA_BUCKET}/gfs.{self.date}/{self.hour}/atmos/{filename}"

    @property
    def base_url(self) -> str:
        return self.base_url_for(self.forecast_hour)


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
class GribField:
    name: str
    values: np.ndarray
    latitudes: np.ndarray
    longitudes: np.ndarray


@dataclass(frozen=True)
class DecodedGrib:
    """Decoded GRIB messages keyed by canonical record key."""

    fields: Mapping[str, GribField]

    def require(self, *names: str) -> None:
        missing = [name for name in names if name not in self.fields]
        if missing:
            raise GridValidationError(
                f"GRIB payload is missing required records: {sorted(missing)}."
            )

    def coordinates(self, names: Sequence[str]) -> tuple[np.ndarray, np.ndarray]:
        reference = self.fields[names[0]]
        for name in names[1:]:
            candidate = self.fields[name]
            if not np.array_equal(reference.latitudes, candidate.latitudes) or (
                not np.array_equal(reference.longitudes, candidate.longitudes)
            ):
                raise GridValidationError(
                    f"GRIB coordinates for {name} do not match {names[0]}."
                )
        return reference.latitudes, reference.longitudes


@dataclass(frozen=True)
class FrameSource:
    """Everything needed to build one forecast frame."""

    step: int
    index_text: str
    payload: bytes


@dataclass(frozen=True)
class ForecastPlan:
    run: RunSpec
    steps: tuple[int, ...]
    indexes: Mapping[int, str]


@dataclass(frozen=True)
class PipelineArtifacts:
    run_id: str
    grids: Mapping[str, bytes]
    manifest: dict[str, Any]
    report: dict[str, Any]

    @property
    def grid_byte_length(self) -> int:
        return sum(len(payload) for payload in self.grids.values())


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


def forecast_labels(step: int) -> frozenset[str]:
    """Accepted GRIB index forecast labels for one step."""
    if step == 0:
        return frozenset({"anl", "0 hour fcst"})
    return frozenset({f"{step} hour fcst"})


def select_wind_ranges(
    records: Sequence[IndexRecord],
    step: int = 0,
    fields: Sequence[str] = WIND_FIELDS,
) -> dict[str, ByteRange]:
    """Select the byte range of every required record for one forecast step.

    Returns a mapping keyed by :func:`record_key` (e.g. ``wind-100m-u``,
    ``gust-10m-speed``) so the downloader and decoder agree on identity.
    """
    labels = forecast_labels(step)
    selectable = {
        (variable, level): record_key(field, component)
        for field, component, variable, level in RECORD_SELECTORS
        if field in fields
    }
    selected: dict[str, ByteRange] = {}
    for index, record in enumerate(records[:-1]):
        key = selectable.get((record.variable, record.level))
        if key is None or record.forecast not in labels:
            continue
        selected[key] = ByteRange(
            variable=key,
            start=record.offset,
            end=records[index + 1].offset - 1,
        )

    expected = set(selectable.values())
    if set(selected) != expected:
        missing = sorted(expected - set(selected))
        raise IncompleteCycleError(
            f"Cycle is incomplete at f{step:03d}: missing {missing}."
        )
    return selected


def ordered_record_keys(fields: Sequence[str] = WIND_FIELDS) -> tuple[str, ...]:
    return tuple(
        record_key(field, component)
        for field, component, _, _ in RECORD_SELECTORS
        if field in fields
    )


def discover_latest_complete(
    *,
    now: datetime | None = None,
    lookback_cycles: int = 12,
    steps: Sequence[int] = FORECAST_STEPS,
    fields: Sequence[str] = WIND_FIELDS,
    fetcher: FetchBytes = fetch_bytes,
) -> ForecastPlan:
    """Find the newest GFS cycle whose full 5-day forecast is published."""
    current = (now or datetime.now(UTC)).astimezone(UTC)
    candidate_hour = (current.hour // 6) * 6
    candidate = current.replace(hour=candidate_hour, minute=0, second=0, microsecond=0)

    errors: list[str] = []
    for cycle_index in range(lookback_cycles):
        instant = candidate - timedelta(hours=cycle_index * 6)
        run = RunSpec(instant.strftime("%Y%m%d"), instant.strftime("%H"))
        indexes: dict[int, str] = {}
        try:
            for step in steps:
                index_text = fetcher(f"{run.base_url_for(step)}.idx", None).decode(
                    "utf-8"
                )
                select_wind_ranges(parse_index(index_text), step, fields)
                indexes[step] = index_text
            return ForecastPlan(run=run, steps=tuple(steps), indexes=indexes)
        except (PipelineError, UnicodeDecodeError) as error:
            errors.append(f"{run.run_id} f{step:03d}: {error}")

    raise IncompleteCycleError(
        "No complete GFS cycle found in the configured lookback. " + " | ".join(errors)
    )


def download_wind_records(
    run: RunSpec,
    ranges: Mapping[str, ByteRange],
    *,
    step: int | None = None,
    fields: Sequence[str] = WIND_FIELDS,
    fetcher: FetchBytes = fetch_bytes,
) -> bytes:
    """Fetch every selected record with S3 byte-range GETs (concatenated)."""
    forecast_step = run.forecast_hour if step is None else step
    url = run.base_url_for(forecast_step)
    order = [key for key in ordered_record_keys(fields) if key in ranges]
    if set(order) != set(ranges):
        raise IncompleteCycleError("Requested byte ranges do not match the record set.")
    payloads = []
    for key in order:
        byte_range = ranges[key]
        payloads.append(fetcher(url, (byte_range.start, byte_range.end)))
    return b"".join(payloads)


def _canonical_record_key(
    short_name: str, type_of_level: str, level: int
) -> str | None:
    """Map a decoded GRIB message onto a canonical record key.

    NOAA publishes 10 m wind as ``10u``/``10v`` but the 100 m wind as the
    generic ``u``/``v`` at ``heightAboveGround`` level 100, so the short name
    alone is not enough to disambiguate the level.
    """
    if short_name == "gust" and type_of_level == "surface":
        return "gust-10m-speed"
    if type_of_level != "heightAboveGround":
        return None
    if short_name in {"u", "10u"}:
        component = "u"
    elif short_name in {"v", "10v"}:
        component = "v"
    else:
        return None
    if level not in PUBLISHED_LEVELS:
        return None
    return f"wind-{level}m-{component}"


def decode_grib(payload: bytes) -> DecodedGrib:
    """Decode wind/gust records, tolerating any level mix in the payload."""
    decoded: dict[str, GribField] = {}
    with tempfile.NamedTemporaryFile(suffix=".grib2") as temporary:
        temporary.write(payload)
        temporary.flush()
        with open(temporary.name, "rb") as stream:
            while message := codes_grib_new_from_file(stream):
                try:
                    short_name = str(codes_get(message, "shortName"))
                    type_of_level = str(codes_get(message, "typeOfLevel"))
                    level = int(codes_get(message, "level"))
                    key = _canonical_record_key(short_name, type_of_level, level)
                    if key is None:
                        raise GridValidationError(
                            "GRIB payload contains an unexpected record: "
                            f"{short_name} at {type_of_level} {level}."
                        )
                    if key in decoded:
                        raise GridValidationError(
                            f"GRIB payload repeats the {key} record."
                        )
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
                    decoded[key] = GribField(
                        name=key,
                        values=values,
                        latitudes=latitudes,
                        longitudes=longitudes,
                    )
                finally:
                    codes_release(message)

    if not decoded:
        raise GridValidationError("GRIB payload contains no decodable records.")
    return DecodedGrib(fields=decoded)


def gust_vector(
    gust_speed: np.ndarray, u: np.ndarray, v: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Derive a gust UV vector from the gust speed and 10 m wind direction.

    NOAA's ``GUST`` record carries speed only, while the on-wire grid format is
    UV-interleaved. We keep the 10 m wind direction and resample it to the gust
    magnitude (zeros where the 10 m wind is calm, so direction is undefined).
    """
    magnitude = np.hypot(u, v)
    calm = magnitude <= 0.0
    safe = np.where(calm, 1.0, magnitude)
    gust_u = np.where(calm, 0.0, gust_speed * u / safe)
    gust_v = np.where(calm, 0.0, gust_speed * v / safe)
    return gust_u.astype(np.float32), gust_v.astype(np.float32)


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


def _serialize_uv(vector: NormalizedGrid) -> bytes:
    vectors = np.stack((vector.u, vector.v), axis=-1).astype("<f4", copy=False)
    return vectors.tobytes(order="C")


def field_grids(
    fields: Sequence[str],
    components: Mapping[str, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
) -> dict[str, NormalizedGrid]:
    """Normalize + crop every requested field for one frame.

    ``components`` maps a field name onto ``(u, v, latitudes, longitudes)``.
    """
    grids: dict[str, NormalizedGrid] = {}
    for field in fields:
        if field not in components:
            raise GridValidationError(f"Frame is missing the {field} field.")
        u, v, latitudes, longitudes = components[field]
        grids[field] = normalize_and_crop(u, v, latitudes, longitudes)
    return grids


def build_frame(
    *,
    grids: Mapping[str, NormalizedGrid],
    geometry: Mapping[str, Any],
    run: RunSpec,
    step: int,
    data_url_prefix: str = DEFAULT_DATA_URL_PREFIX,
) -> dict[str, Any]:
    """Serialize one frame's grids and compute its per-field statistics."""
    frame_grids: dict[str, Any] = {}
    frame_statistics: dict[str, Any] = {}
    for field, grid in grids.items():
        grid_bytes = _serialize_uv(grid)
        expected_bytes = grid.u.shape[0] * grid.u.shape[1] * 8
        if len(grid_bytes) != expected_bytes:
            raise GridValidationError("Serialized grid length is invalid.")
        mean, maximum, _ = calculate_statistics(grid, geometry)
        frame_grids[field] = {
            "url": f"{data_url_prefix}/{run.grid_filename(step, field)}",
            "encoding": ENCODING,
            "byteLength": len(grid_bytes),
            "sha256": hashlib.sha256(grid_bytes).hexdigest(),
            "_bytes": grid_bytes,
        }
        frame_statistics[field] = {
            "areaWeightedMeanKmh": round(mean, 1),
            "maximumGridCellKmh": round(maximum, 1),
        }
    return {
        "step": step,
        "validTime": _iso8601(run.valid_time(step)),
        "grids": frame_grids,
        "statistics": frame_statistics,
    }


def assemble_manifest(
    *,
    run: RunSpec,
    frames: Sequence[Mapping[str, Any]],
    published_at: datetime,
    grid: Mapping[str, Any],
    fixture: bool = False,
) -> dict[str, Any]:
    """Assemble the frozen v2 manifest with its v1-compatible top-level mirror."""
    ordered = sorted(frames, key=lambda frame: int(frame["step"]))
    if not ordered:
        raise GridValidationError("A manifest requires at least one frame.")
    first = ordered[0]
    first_wind = first["grids"]["wind-10m"]
    return {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "runId": run.run_id,
        "provider": "NOAA_GFS",
        "modelRun": _iso8601(run.model_run),
        "validTime": first["validTime"],
        "publishedAt": _iso8601(published_at),
        "heightMeters": 10,
        "sourceUnits": "m/s",
        "displayUnits": "km/h",
        "sample": fixture,
        "grid": {
            "west": float(grid["west"]),
            "east": float(grid["east"]),
            "south": float(grid["south"]),
            "north": float(grid["north"]),
            "width": int(grid["width"]),
            "height": int(grid["height"]),
            "dx": float(grid["dx"]),
            "dy": float(grid["dy"]),
            "scan": "north-to-south-west-to-east",
        },
        "levels": list(PUBLISHED_LEVELS),
        "variables": list(PUBLISHED_VARIABLES),
        "frames": [
            {
                "step": frame["step"],
                "validTime": frame["validTime"],
                "grids": {
                    field: {
                        "url": metadata["url"],
                        "encoding": metadata["encoding"],
                        "byteLength": metadata["byteLength"],
                        "sha256": metadata["sha256"],
                    }
                    for field, metadata in frame["grids"].items()
                },
                "statistics": dict(frame["statistics"]),
            }
            for frame in ordered
        ],
        # Back-compat mirror: the currently-deployed v1 client reads these.
        "data": {
            "url": first_wind["url"],
            "encoding": first_wind["encoding"],
            "byteLength": first_wind["byteLength"],
            "sha256": first_wind["sha256"],
        },
        "statistics": dict(first["statistics"]["wind-10m"]),
    }


def build_artifacts(
    *,
    run: RunSpec,
    sources: Sequence[FrameSource],
    boundary_path: Path,
    data_url_prefix: str = DEFAULT_DATA_URL_PREFIX,
    published_at: datetime | None = None,
    fixture: bool = False,
    fields: Sequence[str] = WIND_FIELDS,
) -> PipelineArtifacts:
    """Build every forecast frame plus the v2 manifest and a report."""
    geometry = _geometry_from_path(boundary_path)
    grids: dict[str, bytes] = {}
    frames: list[dict[str, Any]] = []
    report_frames: list[dict[str, Any]] = []
    comparison_points: list[dict[str, Any]] = []
    reference_grid: NormalizedGrid | None = None

    for source in sorted(sources, key=lambda item: item.step):
        step = source.step
        ranges = select_wind_ranges(parse_index(source.index_text), step, fields)
        decoded = decode_grib(source.payload)
        components: dict[
            str, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]
        ] = {}
        for field in fields:
            if field == "gust-10m":
                decoded.require("wind-10m-u", "wind-10m-v", "gust-10m-speed")
                latitudes, longitudes = decoded.coordinates(
                    ["wind-10m-u", "gust-10m-speed"]
                )
                gust_u, gust_v = gust_vector(
                    decoded.fields["gust-10m-speed"].values,
                    decoded.fields["wind-10m-u"].values,
                    decoded.fields["wind-10m-v"].values,
                )
                components[field] = (gust_u, gust_v, latitudes, longitudes)
            else:
                decoded.require(f"{field}-u", f"{field}-v")
                latitudes, longitudes = decoded.coordinates(
                    [f"{field}-u", f"{field}-v"]
                )
                components[field] = (
                    decoded.fields[f"{field}-u"].values,
                    decoded.fields[f"{field}-v"].values,
                    latitudes,
                    longitudes,
                )

        frame_grids = field_grids(fields, components)
        frame = build_frame(
            grids=frame_grids,
            geometry=geometry,
            run=run,
            step=step,
            data_url_prefix=data_url_prefix,
        )
        if reference_grid is None:
            reference_grid = frame_grids["wind-10m"]

        for field, metadata in frame["grids"].items():
            grids[metadata["url"].rsplit("/", 1)[-1]] = metadata.pop("_bytes")
        frames.append(frame)

        frame_report = {
            "step": step,
            "validTime": frame["validTime"],
            "grids": {
                field: {
                    "url": metadata["url"],
                    "byteLength": metadata["byteLength"],
                    "sha256": metadata["sha256"],
                }
                for field, metadata in frame["grids"].items()
            },
            "source": {
                "url": run.base_url_for(step),
                "indexUrl": f"{run.base_url_for(step)}.idx",
                "indexSha256": hashlib.sha256(source.index_text.encode()).hexdigest(),
                "recordRanges": {
                    variable: {
                        "start": byte_range.start,
                        "end": byte_range.end,
                        "byteLength": byte_range.length,
                    }
                    for variable, byte_range in ranges.items()
                },
                "downloadedByteLength": len(source.payload),
                "downloadedSha256": hashlib.sha256(source.payload).hexdigest(),
            },
            "statistics": dict(frame["statistics"]),
        }
        report_frames.append(frame_report)

        if step == 0:
            published_wind = np.frombuffer(
                grids[run.grid_filename(0, "wind-10m")], dtype="<f4"
            ).reshape(
                frame_grids["wind-10m"].u.shape[0],
                frame_grids["wind-10m"].u.shape[1],
                2,
            )
            comparison_points = _comparison_points(
                frame_grids["wind-10m"], published_wind
            )

    if reference_grid is None:
        raise GridValidationError("No frames were provided to build artifacts.")
    if "wind-10m" not in {field for frame in frames for field in frame["grids"]}:
        raise GridValidationError("The wind-10m frame grid is required.")
    if not all(point["serializedMatch"] for point in comparison_points):
        raise GridValidationError(
            "Serialized comparison points differ from decoded source values."
        )

    grid_metadata = {
        "west": float(reference_grid.longitudes[0, 0]),
        "east": float(reference_grid.longitudes[0, -1]),
        "south": float(reference_grid.latitudes[-1, 0]),
        "north": float(reference_grid.latitudes[0, 0]),
        "width": int(reference_grid.u.shape[1]),
        "height": int(reference_grid.u.shape[0]),
        "dx": reference_grid.dx,
        "dy": reference_grid.dy,
    }
    manifest = assemble_manifest(
        run=run,
        frames=frames,
        published_at=published_at or run.model_run,
        grid=grid_metadata,
        fixture=fixture,
    )
    report = {
        "runId": run.run_id,
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "fields": list(fields),
        "steps": [frame["step"] for frame in frames],
        "frames": report_frames,
        "validation": {
            "dimensions": [
                int(reference_grid.u.shape[1]),
                int(reference_grid.u.shape[0]),
            ],
            "scan": "north-to-south-west-to-east",
            "finiteValues": True,
            "maximumSourceSpeedMs": round(
                float(np.max(np.hypot(reference_grid.u, reference_grid.v))), 4
            ),
            "plausibleSpeedLimitMs": MAX_PLAUSIBLE_SPEED_MS,
            "gustDirection": "derived-from-wind-10m",
            "comparisonPoints": comparison_points,
        },
        "statistics": dict(manifest["statistics"]),
    }
    return PipelineArtifacts(
        run_id=run.run_id, grids=grids, manifest=manifest, report=report
    )


def _comparison_points(
    grid: NormalizedGrid, published_vectors: np.ndarray
) -> list[dict[str, Any]]:
    points = []
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
        points.append(
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
    return points


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    ).encode("utf-8")


def publish_artifacts(
    artifacts: PipelineArtifacts,
    output_directory: Path,
    *,
    report_name: str | None = None,
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=True)
    grids_directory = output_directory / "grids"
    reports_directory = output_directory / "reports"
    grids_directory.mkdir(exist_ok=True)
    reports_directory.mkdir(exist_ok=True)

    report_path = reports_directory / (
        report_name or f"{artifacts.run_id}.validation.json"
    )
    manifest_path = output_directory / "latest.json"

    expected_sha256 = {
        grid["url"].rsplit("/", 1)[-1]: grid["sha256"]
        for frame in artifacts.manifest.get("frames", [])
        for grid in frame["grids"].values()
    }
    if "data" in artifacts.manifest:
        expected_sha256.setdefault(
            artifacts.manifest["data"]["url"].rsplit("/", 1)[-1],
            artifacts.manifest["data"]["sha256"],
        )

    written: list[Path] = []
    for filename, payload in artifacts.grids.items():
        grid_path = grids_directory / filename
        if grid_path.exists() and grid_path.read_bytes() != payload:
            raise PipelineError(
                f"Immutable grid collision for {filename}; refusing overwrite."
            )
        written.append(grid_path)

    with tempfile.TemporaryDirectory(
        prefix=".publish-", dir=output_directory
    ) as staging_name:
        staging = Path(staging_name)
        staged_manifest = staging / manifest_path.name
        staged_report = staging / report_path.name
        staged_manifest.write_bytes(_json_bytes(artifacts.manifest))
        staged_report.write_bytes(_json_bytes(artifacts.report))

        for grid_path in written:
            if grid_path.exists():
                continue
            staged_grid = staging / grid_path.name
            staged_grid.write_bytes(artifacts.grids[grid_path.name])
            digest = hashlib.sha256(staged_grid.read_bytes()).hexdigest()
            if digest != expected_sha256.get(grid_path.name):
                raise PipelineError(
                    f"Staged grid checksum verification failed for {grid_path.name}."
                )
            os.replace(staged_grid, grid_path)

        os.replace(staged_report, report_path)
        os.replace(staged_manifest, manifest_path)

    return (manifest_path, *written, report_path)


def read_fixture(
    fixture_directory: Path,
    *,
    forecast_hour: int | None = None,
) -> tuple[RunSpec, str, bytes]:
    metadata = json.loads(
        (fixture_directory / "metadata.json").read_text(encoding="utf-8")
    )
    step = metadata["forecastHour"] if forecast_hour is None else forecast_hour
    run = RunSpec(metadata["date"], metadata["hour"], int(step))
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
    fields: Sequence[str] = WIND_FIELDS,
    fetcher: FetchBytes = fetch_bytes,
) -> dict[str, Any]:
    step = run.forecast_hour
    index_text = fetcher(f"{run.base_url_for(step)}.idx", None).decode("utf-8")
    ranges = select_wind_ranges(parse_index(index_text), step, fields)
    payload = download_wind_records(
        run, ranges, step=step, fields=fields, fetcher=fetcher
    )
    fixture_directory.mkdir(parents=True, exist_ok=True)
    (fixture_directory / "source.idx").write_text(index_text, encoding="utf-8")
    (fixture_directory / "wind-records.grib2").write_bytes(payload)
    metadata = {
        "date": run.date,
        "hour": run.hour,
        "forecastHour": step,
        "fields": list(fields),
        "sourceUrl": run.base_url_for(step),
        "sourceSha256": hashlib.sha256(payload).hexdigest(),
        "recordRanges": {
            variable: {
                "start": byte_range.start,
                "end": byte_range.end,
                "byteLength": byte_range.length,
            }
            for variable, byte_range in ranges.items()
        },
        "downloadedByteLength": len(payload),
    }
    (fixture_directory / "metadata.json").write_bytes(_json_bytes(metadata))
    return metadata


def steps_from_spec(specification: str | None) -> tuple[int, ...]:
    """Parse a ``0,3,6`` step list (or ``all``/empty for the full forecast)."""
    if specification is None or specification.strip() in {"", "all"}:
        return FORECAST_STEPS
    steps: list[int] = []
    for token in specification.replace(" ", "").split(","):
        if not token:
            continue
        try:
            step = int(token)
        except ValueError as error:
            raise ValueError(f"Invalid forecast step: {token!r}") from error
        if step not in FORECAST_STEPS:
            raise ValueError(
                f"Forecast step f{step:03d} is outside 0..{MAX_FORECAST_STEP} by 3."
            )
        steps.append(step)
    if not steps:
        raise ValueError("At least one forecast step is required.")
    return tuple(sorted(dict.fromkeys(steps)))


def frames_from_plan(
    run: RunSpec,
    steps: Iterable[int],
    indexes: Mapping[int, str] | None = None,
    *,
    fetcher: FetchBytes = fetch_bytes,
    fields: Sequence[str] = WIND_FIELDS,
) -> list[FrameSource]:
    """Fetch the index (unless cached) and byte-range payload for every step."""
    sources: list[FrameSource] = []
    for step in steps:
        if indexes is not None and step in indexes:
            index_text = indexes[step]
        else:
            index_text = fetcher(f"{run.base_url_for(step)}.idx", None).decode("utf-8")
        ranges = select_wind_ranges(parse_index(index_text), step, fields)
        payload = download_wind_records(
            run, ranges, step=step, fields=fields, fetcher=fetcher
        )
        sources.append(FrameSource(step=step, index_text=index_text, payload=payload))
    return sources
