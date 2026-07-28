from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

import boto3
from botocore.exceptions import ClientError

from .core import PipelineError

BUCKET_NAME = "saudi-wind-data"
RUN_ID_PATTERN = re.compile(r"^gfs-\d{8}-(?:00|06|12|18)-f000$")


class S3Client(Protocol):
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...

    def head_object(self, **kwargs: Any) -> dict[str, Any]: ...

    def put_object(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class R2PublishResult:
    run_id: str
    status: str
    grid_key: str


def _missing(error: ClientError) -> bool:
    code = str(error.response.get("Error", {}).get("Code", ""))
    return code in {"404", "NoSuchKey", "NotFound"}


def _read_json_body(response: dict[str, Any]) -> dict[str, Any]:
    return json.loads(response["Body"].read())


def _remote_manifest(client: S3Client) -> dict[str, Any] | None:
    try:
        return _read_json_body(client.get_object(Bucket=BUCKET_NAME, Key="latest.json"))
    except ClientError as error:
        if _missing(error):
            return None
        raise


def publish_directory(
    output_directory: Path,
    client: S3Client,
) -> R2PublishResult:
    manifest_path = output_directory / "latest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    run_id = manifest.get("runId")
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        raise PipelineError("Refusing to publish an invalid run ID.")

    data = manifest.get("data")
    if not isinstance(data, dict):
        raise PipelineError("Manifest data metadata is missing.")
    expected_url = f"/api/wind/grids/{run_id}.bin"
    expected_sha256 = data.get("sha256")
    expected_length = data.get("byteLength")
    if (
        data.get("url") != expected_url
        or not isinstance(expected_sha256, str)
        or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
        or not isinstance(expected_length, int)
        or expected_length <= 0
    ):
        raise PipelineError("Manifest grid metadata is unsafe or incomplete.")

    current = _remote_manifest(client)
    if current:
        current_run = current.get("runId")
        current_data = current.get("data")
        current_sha = (
            current_data.get("sha256") if isinstance(current_data, dict) else None
        )
        if current_run == run_id and current_sha == expected_sha256:
            return R2PublishResult(
                run_id=run_id,
                status="unchanged",
                grid_key=f"grids/{run_id}.bin",
            )
        current_time = datetime.fromisoformat(str(current["modelRun"]))
        candidate_time = datetime.fromisoformat(str(manifest["modelRun"]))
        if current_time >= candidate_time:
            return R2PublishResult(
                run_id=run_id,
                status="older-than-current",
                grid_key=f"grids/{run_id}.bin",
            )

    grid_key = f"grids/{run_id}.bin"
    grid_path = output_directory / "grids" / f"{run_id}.bin"
    grid_bytes = grid_path.read_bytes()
    actual_sha256 = hashlib.sha256(grid_bytes).hexdigest()
    if len(grid_bytes) != expected_length or actual_sha256 != expected_sha256:
        raise PipelineError("Local grid does not match its validated manifest.")

    try:
        existing = client.head_object(Bucket=BUCKET_NAME, Key=grid_key)
    except ClientError as error:
        if not _missing(error):
            raise
        existing = None

    if existing:
        metadata = existing.get("Metadata", {})
        if (
            existing.get("ContentLength") != expected_length
            or metadata.get("sha256") != expected_sha256
        ):
            raise PipelineError(
                f"Immutable R2 grid collision for {run_id}; refusing overwrite."
            )
    else:
        client.put_object(
            Bucket=BUCKET_NAME,
            Key=grid_key,
            Body=grid_bytes,
            ContentType="application/octet-stream",
            CacheControl="public, max-age=31536000, immutable",
            Metadata={"sha256": expected_sha256},
        )
        uploaded = client.head_object(Bucket=BUCKET_NAME, Key=grid_key)
        if (
            uploaded.get("ContentLength") != expected_length
            or uploaded.get("Metadata", {}).get("sha256") != expected_sha256
        ):
            raise PipelineError("R2 grid verification failed after upload.")

    client.put_object(
        Bucket=BUCKET_NAME,
        Key="latest.json",
        Body=manifest_bytes,
        ContentType="application/json; charset=utf-8",
        CacheControl="no-cache, max-age=0, must-revalidate",
        Metadata={"run-id": run_id, "grid-sha256": expected_sha256},
    )
    published = _remote_manifest(client)
    if not published or published.get("runId") != run_id:
        raise PipelineError("R2 manifest verification failed after publication.")

    return R2PublishResult(run_id=run_id, status="published", grid_key=grid_key)


def main() -> None:
    required = (
        "CLOUDFLARE_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise PipelineError(
            "Missing required R2 publication secrets: " + ", ".join(missing)
        )

    client = boto3.client(
        "s3",
        endpoint_url=(
            f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        ),
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    output = Path(os.environ.get("WIND_OUTPUT_DIRECTORY", ".wind-artifacts"))
    result = publish_directory(output, client)
    print(
        json.dumps(
            {
                "runId": result.run_id,
                "status": result.status,
                "gridKey": result.grid_key,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
