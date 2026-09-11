import { useEffect, useMemo, useState } from "react";

import { WindMap } from "./components/WindMap";
import { formatKmh, formatSaudiDate } from "./lib/format";
import {
  fastestCity,
  nearestCity,
  pointSpeedKmh,
  slowestCity,
  type MapSelection,
} from "./lib/inspection";
import {
  availableGridKeys,
  frameForTime,
  frameGridIndex,
  loadWindManifest,
  reuseWindDataset,
} from "./lib/wind";
import { WindGridCache } from "./lib/windGridCache";
import type { SaudiBoundary } from "./types/geo";
import type { WindDataset, WindGridKey, WindManifest } from "./types/wind";

interface AppState {
  boundary: SaudiBoundary;
  manifest: WindManifest;
}

const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const WIND_MANIFEST_URL =
  import.meta.env.VITE_WIND_MANIFEST_URL ??
  (import.meta.env.DEV ? "/data/processed/latest.json" : "/api/wind/latest");

/**
 * The map renders one field: the 10 m wind. A run that does not publish 10 m
 * wind falls back to whichever grid it does publish, so a version-one or
 * 100 m-only manifest still renders instead of blanking.
 */
function primaryGridKey(manifest: WindManifest): WindGridKey | null {
  const keys = availableGridKeys(manifest.frames);
  return keys.includes("wind-10m") ? "wind-10m" : (keys[0] ?? null);
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [dataset, setDataset] = useState<WindDataset | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [selection, setSelection] = useState<MapSelection | null>(null);
  const [cache] = useState(() => new WindGridCache());

  useEffect(() => {
    let active = true;
    let currentRunId: string | null = null;

    const load = async () => {
      try {
        const [boundary, manifest] = await Promise.all([
          fetch("/data/saudi-boundary.geo.json").then((response) => {
            if (!response.ok) throw new Error("تعذر تحميل حدود المملكة.");
            return response.json() as Promise<SaudiBoundary>;
          }),
          loadWindManifest(WIND_MANIFEST_URL),
        ]);
        if (!active) return;
        const runChanged = currentRunId !== manifest.runId;
        if (!runChanged) {
          // Same run: keep the boundary object the map already renders. The
          // dataset effect below then reuses the decoded grid, so WindMap's
          // [boundary, dataset, reducedMotion] effect sees identical
          // dependencies and never disposes and rebuilds the WebGL renderer
          // (which would restart the particle trail).
          setState((previous) => ({
            boundary: previous?.boundary ?? boundary,
            manifest,
          }));
          setError(null);
          return;
        }
        currentRunId = manifest.runId;
        setState({ boundary, manifest });
        // The map shows the forecast frame nearest to now; there is no
        // timeline to scrub, so this is the only frame selection.
        const currentFrameIndex = manifest.frames.indexOf(
          frameForTime(manifest.frames, Date.now()),
        );
        setFrameIndex(Math.max(0, currentFrameIndex));
        setError(null);
      } catch {
        if (!active || currentRunId) return;
        setError(
          "لا تتوفر حالياً بيانات رياح صالحة. سنحاول مجدداً عند نشر دورة NOAA التالية.",
        );
      }
    };

    void load();
    const refresh = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(refresh);
    };
  }, []);

  const activeGridKey = useMemo(
    () => (state ? primaryGridKey(state.manifest) : null),
    [state],
  );

  useEffect(() => {
    if (!state || !activeGridKey) return;
    const { frames } = state.manifest;
    const index = frameGridIndex(
      frames,
      Math.min(frameIndex, frames.length - 1),
      activeGridKey,
    );
    if (index < 0) return;
    const frame = frames[index];
    const reference = frame.grids[activeGridKey];
    if (!reference) return;

    const cached = cache.peek(reference);
    if (cached) {
      setDataset((previous) =>
        reuseWindDataset(previous, {
          manifest: state.manifest,
          frame,
          vectors: cached,
        }),
      );
      setGridError(null);
      return;
    }

    let cancelled = false;
    cache
      .load(reference)
      .then((vectors) => {
        if (cancelled) return;
        setDataset((previous) =>
          reuseWindDataset(previous, {
            manifest: state.manifest,
            frame,
            vectors,
          }),
        );
        setGridError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setGridError(
          reason instanceof Error ? reason.message : "تعذر تحميل شبكة الرياح.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [activeGridKey, cache, frameIndex, state]);

  const displayedTime = dataset?.frame.validTime ?? state?.manifest.validTime;
  const stale = displayedTime
    ? Date.now() - Date.parse(displayedTime) > STALE_AFTER_MS
    : false;
  const statistics =
    dataset?.frame.statistics[activeGridKey ?? "wind-10m"] ??
    state?.manifest.statistics ??
    null;

  // A new run can publish a different grid, so an inspection from the previous
  // one would no longer describe the map; drop it.
  useEffect(() => {
    setSelection(null);
  }, [state?.manifest.runId]);

  const cityStats = useMemo(() => {
    if (!dataset) return null;
    return {
      fastest: fastestCity(dataset.vectors, dataset.manifest.grid),
      slowest: slowestCity(dataset.vectors, dataset.manifest.grid),
    };
  }, [dataset]);

  // Derived from the current frame rather than stored, so a new forecast step
  // updates the inspected speed the same way it updates the average.
  const inspectedKmh =
    dataset && selection
      ? pointSpeedKmh(
          dataset.vectors,
          dataset.manifest.grid,
          selection.longitude,
          selection.latitude,
        )
      : null;
  const inspecting = selection !== null && inspectedKmh !== null;
  const inspectedCity = selection
    ? nearestCity([selection.longitude, selection.latitude])
    : null;
  const headlineLabel = inspecting
    ? (inspectedCity?.name ?? "الموقع المحدد")
    : "متوسط السرعة";
  const headlineKmh = inspecting
    ? inspectedKmh
    : (statistics?.areaWeightedMeanKmh ?? null);

  return (
    <main className="app-shell">
      <section className="map-stage" aria-busy={!state && !error}>
        {state && dataset ? (
          <WindMap
            boundary={state.boundary}
            dataset={dataset}
            selection={selection}
            onSelectionChange={setSelection}
          />
        ) : (
          <div className="loading-state" role={error ? "alert" : "status"}>
            <span className="loading-mark" aria-hidden="true" />
            {error ?? "جارٍ إعداد خريطة الرياح…"}
          </div>
        )}

        {gridError && (
          <p className="freshness-warning" role="alert">
            {gridError}
          </p>
        )}

        {state && (
          <aside className="information-panel" aria-label="معلومات الرياح">
            <header>
              <h1>رياح السعودية</h1>
              <p className="timestamp">
                {displayedTime ? formatSaudiDate(displayedTime) : ""}
              </p>
              {stale && (
                <p className="freshness-warning" role="status">
                  آخر بيانات صالحة أقدم من 12 ساعة
                </p>
              )}
            </header>

            <dl className="statistics">
              <div data-selected={inspecting ? "true" : "false"}>
                <dt>{headlineLabel}</dt>
                <dd>
                  <bdi>
                    {headlineKmh !== null ? formatKmh(headlineKmh) : "—"}
                  </bdi>
                  <span>كم/س</span>
                </dd>
              </div>
              <div>
                <dt>أسرع مدينة</dt>
                <dd>
                  <bdi className="statistics-city">
                    {cityStats?.fastest ? cityStats.fastest.city.name : "—"}
                  </bdi>
                  <bdi>
                    {cityStats?.fastest
                      ? formatKmh(cityStats.fastest.speedKmh)
                      : "—"}
                  </bdi>
                  <span>كم/س</span>
                </dd>
              </div>
              <div>
                <dt>أبطأ مدينة</dt>
                <dd>
                  <bdi className="statistics-city">
                    {cityStats?.slowest ? cityStats.slowest.city.name : "—"}
                  </bdi>
                  <bdi>
                    {cityStats?.slowest
                      ? formatKmh(cityStats.slowest.speedKmh)
                      : "—"}
                  </bdi>
                  <span>كم/س</span>
                </dd>
              </div>
            </dl>

            <div className="source-line">
              <span>NOAA GFS</span>
              <span>دقة 0.25°</span>
            </div>
          </aside>
        )}

        <aside className="legend" aria-label="مفتاح سرعة الرياح">
          <span className="legend-title">السرعة</span>
          <div className="legend-row">
            <i className="legend-wind legend-wind--low" />
            <bdi>5</bdi>
          </div>
          <div className="legend-row">
            <i className="legend-wind legend-wind--medium" />
            <bdi>20</bdi>
          </div>
          <div className="legend-row">
            <i className="legend-wind legend-wind--high" />
            <bdi>40</bdi>
          </div>
          <span className="legend-unit">كم/س</span>
        </aside>

        <footer className="map-credit">
          بيانات نموذج{" "}
          <a
            href="https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast"
            rel="noreferrer"
          >
            NOAA GFS
          </a>{" "}
          · الحدود:{" "}
          <a
            href="https://www.naturalearthdata.com/about/terms-of-use/"
            rel="noreferrer"
          >
            Natural Earth
          </a>{" "}
          · الخط:{" "}
          <a href="/licenses/IBM-Plex-Sans-Arabic-OFL-1.1.txt">
            IBM Plex Sans Arabic
          </a>
        </footer>
      </section>
    </main>
  );
}
