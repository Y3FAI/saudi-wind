from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from botocore.exceptions import ClientError

from .core import ENCODING, PipelineError

BUCKET_NAME = "saudi-wind-data"
MANIFEST_KEY = "latest.json"
GRID_PREFIX = "grids/"
GRID_URL_PREFIX = "/api/wind/grids/"
R2_API_BASE = "https://api.cloudflare.com/client/v4/accounts"
MAX_RUN_AGE_HOURS = 48
RUN_ID_PATTERN = re.compile(r"^gfs-\d{8}-(?:00|06|12|18)(?:-f\d{3})?$")
RUN_ID_IN_KEY = re.compile(r"^(gfs-\d{8}-(?:00|06|12|18))-f\d{3}")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class R2Client(Protocol):
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...

    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...

    def put_object(self, **kwargs: Any) -> dict[str, Any]: ...

    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]: ...

    def delete_object(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class GridReference:
    key: str
    sha256: str
    byteLength: int


@dataclass(frozen=True)
class R2PublishResult:
    run_id: str
    status: str
    grid_keys: tuple[str, ...] = ()
    bytes_published: int = 0
    pruned: tuple[str, ...] = ()

    @property
    def grid_key(self) -> str:
        return self.grid_keys[0] if self.grid_keys else ""


def _missing(error: ClientError) -> bool:
    code = str(error.response.get("Error", {}).get("Code", ""))
    return code in {"404", "NoSuchKey", "NotFound"}


def _read_json_body(response: Mapping[str, Any]) -> dict[str, Any]:
    return json.loads(response["Body"].read())


def _remote_manifest(client: R2Client) -> dict[str, Any] | None:
    try:
        return _read_json_body(client.get_object(Bucket=BUCKET_NAME, Key=MANIFEST_KEY))
    except ClientError as error:
        if _missing(error):
            return None
        raise


def _grid_key_from_url(url: Any) -> str | None:
    if not isinstance(url, str) or not url.startswith(GRID_URL_PREFIX):
        return None
    filename = url[len(GRID_URL_PREFIX) :]
    if not filename or "/" in filename or ".." in filename:
        return None
    return f"{GRID_PREFIX}{filename}"


def _grid_reference(metadata: Any, label: str) -> GridReference:
    if not isinstance(metadata, Mapping):
        raise PipelineError(f"Manifest grid metadata for {label} is missing.")
    key = _grid_key_from_url(metadata.get("url"))
    sha256 = metadata.get("sha256")
    byte_length = metadata.get("byteLength")
    if (
        key is None
        or metadata.get("encoding") != ENCODING
        or not isinstance(sha256, str)
        or not SHA256_PATTERN.fullmatch(sha256)
        or not isinstance(byte_length, int)
        or byte_length <= 0
    ):
        raise PipelineError(
            f"Manifest grid metadata for {label} is unsafe or incomplete."
        )
    return GridReference(key=key, sha256=sha256, byteLength=byte_length)


def grid_references(manifest: Mapping[str, Any]) -> tuple[GridReference, ...]:
    """Collect every immutable grid the manifest refers to, in manifest order."""
    frames = manifest.get("frames")
    if frames is None:
        # Legacy v1 manifest: a single analysis grid at ``data``.
        return (_grid_reference(manifest.get("data"), "data"),)

    if not isinstance(frames, Sequence) or not frames:
        raise PipelineError("Manifest frames must be a non-empty list.")
    references: list[GridReference] = []
    for index, frame in enumerate(frames):
        if not isinstance(frame, Mapping):
            raise PipelineError(f"Manifest frame {index} is not an object.")
        grids = frame.get("grids")
        if not isinstance(grids, Mapping) or not grids:
            raise PipelineError(f"Manifest frame {index} has no grids.")
        for field, metadata in grids.items():
            references.append(_grid_reference(metadata, f"frames[{index}].{field}"))

    # The v1-compatible mirror must point at frame 0's 10 m wind grid exactly.
    first_wind = frames[0]["grids"].get("wind-10m")
    if manifest.get("data") != first_wind:
        raise PipelineError("Manifest data mirror does not match frames[0] wind-10m.")

    if len({reference.key for reference in references}) != len(references):
        raise PipelineError("Manifest refers to the same grid key twice.")
    return tuple(references)


def _remote_grid_state(
    client: R2Client, key: str
) -> tuple[int | None, str | None] | None:
    try:
        head = client.head_object(Bucket=BUCKET_NAME, Key=key)
    except ClientError as error:
        if _missing(error):
            return None
        raise
    return head.get("ContentLength"), head.get("Metadata", {}).get("sha256")


def _publish_grid(client: R2Client, reference: GridReference, payload: bytes) -> bool:
    """Upload one immutable grid. Returns True when bytes were transferred."""
    state = _remote_grid_state(client, reference.key)
    if state is not None:
        length, sha256 = state
        if length != reference.byteLength or sha256 != reference.sha256:
            raise PipelineError(
                f"Immutable R2 grid collision for {reference.key}; refusing overwrite."
            )
        return False

    client.put_object(
        Bucket=BUCKET_NAME,
        Key=reference.key,
        Body=payload,
        ContentType="application/octet-stream",
        CacheControl="public, max-age=31536000, immutable",
        Metadata={"sha256": reference.sha256},
    )
    uploaded = _remote_grid_state(client, reference.key)
    if uploaded != (reference.byteLength, reference.sha256):
        raise PipelineError("R2 grid verification failed after upload.")
    return True


def publish_directory(
    output_directory: Path,
    client: R2Client,
    *,
    prune: bool = False,
    now: datetime | None = None,
    max_run_age_hours: int = MAX_RUN_AGE_HOURS,
) -> R2PublishResult:
    manifest_path = output_directory / "latest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    run_id = manifest.get("runId")
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        raise PipelineError("Refusing to publish an invalid run ID.")

    references = grid_references(manifest)
    wind_reference = references[0]

    current = _remote_manifest(client)
    if current:
        current_run = current.get("runId")
        current_data = current.get("data")
        current_sha = (
            current_data.get("sha256") if isinstance(current_data, Mapping) else None
        )
        if current_run == run_id and current_sha == wind_reference.sha256:
            return R2PublishResult(run_id=run_id, status="unchanged")
        try:
            current_time = datetime.fromisoformat(str(current["modelRun"]))
            candidate_time = datetime.fromisoformat(str(manifest["modelRun"]))
        except (KeyError, ValueError) as error:
            raise PipelineError("Manifest model run time is invalid.") from error
        if current_time >= candidate_time:
            return R2PublishResult(run_id=run_id, status="older-than-current")

    grids_directory = output_directory / "grids"
    bytes_published = 0
    for reference in references:
        grid_path = grids_directory / Path(reference.key).name
        grid_bytes = grid_path.read_bytes()
        if (
            len(grid_bytes) != reference.byteLength
            or hashlib.sha256(grid_bytes).hexdigest() != reference.sha256
        ):
            raise PipelineError(
                f"Local grid {grid_path.name} does not match its validated manifest."
            )
        if _publish_grid(client, reference, grid_bytes):
            bytes_published += len(grid_bytes)

    client.put_object(
        Bucket=BUCKET_NAME,
        Key=MANIFEST_KEY,
        Body=manifest_bytes,
        ContentType="application/json; charset=utf-8",
        CacheControl="no-cache, max-age=0, must-revalidate",
        Metadata={"run-id": run_id, "grid-sha256": wind_reference.sha256},
    )
    published = _remote_manifest(client)
    if not published or published.get("runId") != run_id:
        raise PipelineError("R2 manifest verification failed after publication.")

    pruned: tuple[str, ...] = ()
    if prune:
        pruned = tuple(
            prune_old_runs(
                client,
                current_run_id=run_id,
                referenced_keys={reference.key for reference in references},
                now=now,
                max_run_age_hours=max_run_age_hours,
            )
        )

    return R2PublishResult(
        run_id=run_id,
        status="published",
        grid_keys=tuple(reference.key for reference in references),
        bytes_published=bytes_published,
        pruned=pruned,
    )


def _run_id_from_key(key: str) -> str | None:
    if not key.startswith(GRID_PREFIX):
        return None
    match = RUN_ID_IN_KEY.match(key[len(GRID_PREFIX) :])
    return match.group(1) if match else None


def _run_time(run_id: str) -> datetime | None:
    match = re.fullmatch(r"gfs-(\d{8})-(\d{2})", run_id)
    if not match:
        return None
    return datetime.strptime(f"{match.group(1)}{match.group(2)}", "%Y%m%d%H").replace(
        tzinfo=UTC
    )


def list_grid_keys(client: R2Client, prefix: str = GRID_PREFIX) -> list[str]:
    keys: list[str] = []
    token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": BUCKET_NAME, "Prefix": prefix}
        if token is not None:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        contents = response.get("Contents") or []
        keys.extend(str(item["Key"]) for item in contents)
        token = (
            str(response["NextContinuationToken"])
            if response.get("NextContinuationToken")
            else None
        )
        if not response.get("IsTruncated") or token is None:
            break
    return keys


def prune_old_runs(
    client: R2Client,
    *,
    current_run_id: str,
    referenced_keys: set[str],
    now: datetime | None = None,
    max_run_age_hours: int = MAX_RUN_AGE_HOURS,
    prefix: str = GRID_PREFIX,
) -> list[str]:
    """Delete grids from runs older than the retention window.

    The current run and every grid the live manifest references are always
    kept; objects whose key does not encode a GFS run are left alone.
    """
    instant = (now or datetime.now(UTC)).astimezone(UTC)
    cutoff = instant - timedelta(hours=max_run_age_hours)
    deleted: list[str] = []
    for key in sorted(list_grid_keys(client, prefix)):
        if key in referenced_keys:
            continue
        run_id = _run_id_from_key(key)
        if run_id is None or run_id == current_run_id:
            continue
        run_time = _run_time(run_id)
        if run_time is None or run_time >= cutoff:
            continue
        client.delete_object(Bucket=BUCKET_NAME, Key=key)
        deleted.append(key)
    return deleted


def _raise_client_error(error: urllib.error.HTTPError) -> None:
    raise ClientError(
        {"Error": {"Code": str(error.code), "Message": str(error.reason or "")}},
        "R2Rest",
    ) from error


class ApiTokenR2Client:
    """Minimal R2 REST client using a Cloudflare API token.

    Cloudflare's object endpoint always rewrites the whole object, so the
    publisher keeps its "grids first, manifest last" ordering intact. Custom
    object metadata is not settable through this API, so integrity is verified
    by re-hashing the object body instead of reading it from metadata.
    """

    def __init__(
        self,
        account_id: str,
        api_token: str,
        *,
        bucket: str = BUCKET_NAME,
        opener: Callable[[urllib.request.Request], Any] | None = None,
    ) -> None:
        self.account_id = account_id
        self.api_token = api_token
        self.bucket = bucket
        self._opener = opener or urllib.request.urlopen

    def _url(self, key: str = "", query: str = "") -> str:
        base = f"{R2_API_BASE}/{self.account_id}/r2/buckets/{self.bucket}/objects"
        if key:
            base = f"{base}/{urllib.parse.quote(key, safe='')}"
        return f"{base}{query}"

    def _request(
        self,
        method: str,
        url: str,
        *,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={"Authorization": f"Bearer {self.api_token}", **(headers or {})},
        )
        try:
            return self._opener(request)
        except urllib.error.HTTPError as error:
            _raise_client_error(error)
            raise AssertionError("unreachable")  # pragma: no cover

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        response = self._request("GET", self._url(str(kwargs["Key"])))
        return {"Body": io.BytesIO(response.read())}

    def head_object(self, **kwargs: Any) -> dict[str, Any]:
        payload = self.get_object(**kwargs)["Body"].read()
        return {
            "ContentLength": len(payload),
            "Metadata": {"sha256": hashlib.sha256(payload).hexdigest()},
        }

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        body = kwargs["Body"]
        payload = body if isinstance(body, bytes) else bytes(body)
        headers = {
            "Content-Type": str(kwargs.get("ContentType", "application/octet-stream")),
            "Cache-Control": str(kwargs.get("CacheControl", "")),
        }
        response = self._request(
            "PUT", self._url(str(kwargs["Key"])), body=payload, headers=headers
        )
        response.read()
        return {"ETag": ""}

    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]:
        prefix = str(kwargs.get("Prefix", ""))
        per_page = 1000
        page = int(kwargs.get("ContinuationToken") or 1)
        query = (
            f"?prefix={urllib.parse.quote(prefix, safe='')}"
            f"&per_page={per_page}&page={page}"
        )
        response = self._request("GET", self._url("", query))
        data = json.loads(response.read())
        if data.get("success") is False:
            raise PipelineError(
                "R2 list objects failed: "
                + "; ".join(
                    str(item.get("message", item)) for item in data.get("errors", [])
                )
            )
        result = data.get("result") or []
        if isinstance(result, Mapping):
            result = result.get("objects") or result.get("keys") or []
        contents = [
            {
                "Key": str(item["key"]),
                "Size": int(item.get("size", 0)),
                "LastModified": item.get("last_modified"),
            }
            for item in result
        ]
        info = data.get("result_info") or {}
        total = int(info.get("total_count") or len(contents))
        truncated = page * per_page < total
        return {
            "Contents": contents,
            "IsTruncated": truncated,
            **({"NextContinuationToken": str(page + 1)} if truncated else {}),
        }

    def delete_object(self, **kwargs: Any) -> dict[str, Any]:
        response = self._request("DELETE", self._url(str(kwargs["Key"])))
        response.read()
        return {}


def resolve_credentials(environ: Mapping[str, str]) -> tuple[str, str, str]:
    """Pick the publication credential set; the API token wins when both exist.

    Returns ``(mode, account_id, secret)`` where mode is ``api-token`` or
    ``s3`` and ``secret`` is the API token or ``access:secret`` pair.
    """
    account_id = environ.get("CLOUDFLARE_ACCOUNT_ID")
    api_token = environ.get("CLOUDFLARE_API_TOKEN")
    access_key = environ.get("R2_ACCESS_KEY_ID")
    secret_key = environ.get("R2_SECRET_ACCESS_KEY")

    if not account_id:
        raise PipelineError(
            "Missing R2 publication credentials: CLOUDFLARE_ACCOUNT_ID is not set, "
            "and either CLOUDFLARE_API_TOKEN or R2_ACCESS_KEY_ID/"
            "R2_SECRET_ACCESS_KEY must be provided."
        )
    if api_token:
        return "api-token", account_id, api_token
    if access_key and secret_key:
        return "s3", account_id, f"{access_key}:{secret_key}"
    raise PipelineError(
        "Missing R2 publication credentials: set CLOUDFLARE_API_TOKEN (API token) "
        "or both R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (S3)."
    )


def build_client(
    environ: Mapping[str, str] | None = None,
    *,
    opener: Callable[[urllib.request.Request], Any] | None = None,
) -> tuple[R2Client, str]:
    environment = os.environ if environ is None else environ
    mode, account_id, secret = resolve_credentials(environment)
    if mode == "api-token":
        return ApiTokenR2Client(account_id, secret, opener=opener), mode

    access_key, secret_key = secret.split(":", 1)
    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )
    return client, mode


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="saudi-wind-r2-publish",
        description="Publish validated Saudi wind grids and the latest manifest to R2.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(os.environ.get("WIND_OUTPUT_DIRECTORY", ".wind-artifacts")),
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help=f"Delete grids from runs older than {MAX_RUN_AGE_HOURS} h.",
    )
    parser.add_argument("--max-run-age-hours", type=int, default=MAX_RUN_AGE_HOURS)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    client, mode = build_client()
    result = publish_directory(
        args.output,
        client,
        prune=args.prune,
        max_run_age_hours=args.max_run_age_hours,
    )
    print(
        json.dumps(
            {
                "runId": result.run_id,
                "status": result.status,
                "credentialMode": mode,
                "gridCount": len(result.grid_keys),
                "bytesPublished": result.bytes_published,
                "pruned": list(result.pruned),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
