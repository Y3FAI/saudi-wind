from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError
from saudi_wind_pipeline.core import PipelineError
from saudi_wind_pipeline.r2_publish import BUCKET_NAME, publish_directory


def missing(operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "404", "Message": "Not Found"}},
        operation,
    )


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, Any]] = {}
        self.operations: list[tuple[str, str]] = []
        self.fail_grid_put = False

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["Bucket"] == BUCKET_NAME
        key = kwargs["Key"]
        self.operations.append(("get", key))
        if key not in self.objects:
            raise missing("GetObject")
        return {"Body": io.BytesIO(self.objects[key]["Body"])}

    def head_object(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["Bucket"] == BUCKET_NAME
        key = kwargs["Key"]
        self.operations.append(("head", key))
        if key not in self.objects:
            raise missing("HeadObject")
        stored = self.objects[key]
        return {
            "ContentLength": len(stored["Body"]),
            "Metadata": stored.get("Metadata", {}),
        }

    def put_object(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["Bucket"] == BUCKET_NAME
        key = kwargs["Key"]
        self.operations.append(("put", key))
        if self.fail_grid_put and key.startswith("grids/"):
            raise ClientError(
                {"Error": {"Code": "InternalError", "Message": "failed"}},
                "PutObject",
            )
        body = kwargs["Body"]
        self.objects[key] = {
            **kwargs,
            "Body": body if isinstance(body, bytes) else bytes(body),
        }
        return {"ETag": '"etag"'}


def write_output(
    directory: Path,
    *,
    run_id: str = "gfs-20260728-12-f000",
    model_run: str = "2026-07-28T12:00:00Z",
    grid: bytes = b"validated-grid",
) -> dict[str, Any]:
    checksum = hashlib.sha256(grid).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "runId": run_id,
        "provider": "NOAA_GFS",
        "modelRun": model_run,
        "validTime": model_run,
        "publishedAt": model_run,
        "heightMeters": 10,
        "sourceUnits": "m/s",
        "displayUnits": "km/h",
        "grid": {},
        "data": {
            "url": f"/api/wind/grids/{run_id}.bin",
            "encoding": "float32-le-uv-interleaved",
            "byteLength": len(grid),
            "sha256": checksum,
        },
        "statistics": {},
    }
    (directory / "grids").mkdir(parents=True)
    (directory / "grids" / f"{run_id}.bin").write_bytes(grid)
    (directory / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def test_publishes_verified_grid_before_manifest(tmp_path: Path) -> None:
    manifest = write_output(tmp_path)
    client = FakeS3()

    result = publish_directory(tmp_path, client)

    grid_key = f"grids/{manifest['runId']}.bin"
    assert result.status == "published"
    assert client.operations.index(("put", grid_key)) < client.operations.index(
        ("put", "latest.json")
    )
    assert client.objects[grid_key]["CacheControl"].endswith("immutable")
    assert client.objects["latest.json"]["CacheControl"].startswith("no-cache")


def test_does_not_republish_an_unchanged_run(tmp_path: Path) -> None:
    manifest = write_output(tmp_path)
    client = FakeS3()
    client.objects["latest.json"] = {
        "Body": json.dumps(manifest).encode(),
        "Metadata": {},
    }

    result = publish_directory(tmp_path, client)

    assert result.status == "unchanged"
    assert not any(operation == "put" for operation, _ in client.operations)


def test_failed_grid_upload_preserves_previous_manifest(tmp_path: Path) -> None:
    write_output(tmp_path)
    previous = {
        "runId": "gfs-20260728-06-f000",
        "modelRun": "2026-07-28T06:00:00Z",
        "data": {"sha256": "0" * 64},
    }
    previous_bytes = json.dumps(previous).encode()
    client = FakeS3()
    client.objects["latest.json"] = {
        "Body": previous_bytes,
        "Metadata": {},
    }
    client.fail_grid_put = True

    with pytest.raises(ClientError):
        publish_directory(tmp_path, client)

    assert client.objects["latest.json"]["Body"] == previous_bytes
    assert ("put", "latest.json") not in client.operations


def test_rejects_an_immutable_grid_collision(tmp_path: Path) -> None:
    manifest = write_output(tmp_path)
    client = FakeS3()
    grid_key = f"grids/{manifest['runId']}.bin"
    client.objects[grid_key] = {
        "Body": b"different",
        "Metadata": {"sha256": "f" * 64},
    }

    with pytest.raises(PipelineError, match="Immutable R2 grid collision"):
        publish_directory(tmp_path, client)

    assert ("put", "latest.json") not in client.operations
