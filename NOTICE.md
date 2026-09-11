# Third-party notices

Saudi Wind source code is distributed under the repository's [MIT License](LICENSE).

## NOAA GFS data

Forecast data comes from the **NOAA Global Forecast System (GFS)**, produced by
NOAA's National Centers for Environmental Prediction (NCEP), read from the
public `noaa-gfs-bdp-pds` bucket on AWS Open Data.

- GFS output is a **U.S. Government work and is in the public domain.** It
  carries no licence restrictions and requires no permission to reuse.
- Saudi Wind redistributes **derived** artifacts: cropped, re-serialized binary
  grids and computed statistics. It does not redistribute the original GRIB
  files.
- Attribution is offered as a matter of good practice. It does **not** imply
  that NOAA, NCEP, or the U.S. Government endorses Saudi Wind.

## Natural Earth

The Saudi boundary in `public/data/saudi-boundary.geo.json` is derived from
Natural Earth 1:10m Admin 0 data. Natural Earth publishes its raster and vector
map data in the **public domain**
(<https://www.naturalearthdata.com/about/terms-of-use/>).

## IBM Plex Sans Arabic

The bundled IBM Plex Sans Arabic font files are copyright 2019 IBM Corp. and are
distributed under the **SIL Open Font License 1.1**. The complete licence is
deployed with the site at
[`/licenses/IBM-Plex-Sans-Arabic-OFL-1.1.txt`](public/licenses/IBM-Plex-Sans-Arabic-OFL-1.1.txt).

## Build-time dependencies

The ingestion pipeline relies on ECMWF ecCodes, NumPy, and boto3, managed by
`uv` and pinned in `uv.lock`. These are not redistributed with the site; their
licences travel with the packages. The exact dependency set is in
`pyproject.toml` and `uv.lock`.
