#!/usr/bin/env python3
"""Extract and simplify Saudi Arabia from Natural Earth 1:10m GeoJSON."""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path
from typing import Any


SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_10m_admin_0_countries.geojson"
)


def rounded(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 5)
    if isinstance(value, list):
        return [rounded(item) for item in value]
    return value


def extract_saudi(feature_collection: dict[str, Any]) -> dict[str, Any]:
    for feature in feature_collection["features"]:
        properties = feature.get("properties", {})
        if properties.get("ADM0_A3") == "SAU":
            return {
                "type": "Feature",
                "properties": {
                    "name": "Saudi Arabia",
                    "source": "Natural Earth 1:10m",
                },
                "geometry": {
                    "type": feature["geometry"]["type"],
                    "coordinates": rounded(feature["geometry"]["coordinates"]),
                },
            }
    raise RuntimeError("Saudi Arabia was not present in the Natural Earth dataset.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/data/saudi-boundary.geo.json"),
    )
    arguments = parser.parse_args()

    request = urllib.request.Request(
        SOURCE_URL,
        headers={"User-Agent": "saudi-wind-boundary-builder/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        source = json.load(response)

    boundary = extract_saudi(source)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(boundary, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {arguments.output}")


if __name__ == "__main__":
    main()
