import { useEffect, useMemo, useState } from "react";

import { WindMap, type WindSelection } from "./components/WindMap";
import { WindTimeline } from "./components/WindTimeline";
import { formatKmh, formatSaudiDate } from "./lib/format";
import {
  availableGridKeys,
  availableLevels,
  frameForTime,
  frameGridIndex,
  gridKeyForLevel,
  loadWindManifest,
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

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WindSelection | null>(null);
  const [level, setLevel] = useState(10);
  const [gusts, setGusts] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [dataset, setDataset] = useState<WindDataset | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
          setState({ boundary, manifest });
          setError(null);
          return;
        }
        currentRunId = manifest.runId;
        setSelection(null);
        setState({ boundary, manifest });
        setNow(Date.now());
        const levels = availableLevels(manifest.frames);
        setLevel((current) =>
          levels.includes(current) ? current : (levels[0] ?? 10),
        );
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

  const activeGridKey: WindGridKey = gridKeyForLevel(level, gusts);
  const gridKeys = useMemo(
    () => (state ? availableGridKeys(state.manifest.frames) : []),
    [state],
  );
  const levels = useMemo(
    () => (state ? availableLevels(state.manifest.frames) : [10]),
    [state],
  );
  const gustsAvailable = gridKeys.includes("gust-10m") && level === 10;

  useEffect(() => {
    if (!gustsAvailable && gusts) setGusts(false);
  }, [gusts, gustsAvailable]);

  useEffect(() => {
    if (!state) return;
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
      setDataset({ manifest: state.manifest, frame, vectors: cached });
      setGridError(null);
      return;
    }

    let cancelled = false;
    cache
      .load(reference)
      .then((vectors) => {
        if (cancelled) return;
        setDataset({ manifest: state.manifest, frame, vectors });
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

  useEffect(() => {
    if (!state || !dataset) return;
    const { frames } = state.manifest;
    const nextIndex = frameGridIndex(
      frames,
      Math.min(frameIndex + 1, frames.length - 1),
      activeGridKey,
    );
    if (nextIndex < 0) return;
    cache.preload(frames[nextIndex].grids[activeGridKey]);
  }, [activeGridKey, cache, dataset, frameIndex, state]);

  const displayedTime = dataset?.frame.validTime ?? state?.manifest.validTime;
  const stale = displayedTime
    ? Date.now() - Date.parse(displayedTime) > STALE_AFTER_MS
    : false;
  const badge = state?.manifest.sample
    ? "NOAA GFS · عينة معالجة"
    : stale
      ? "NOAA GFS · آخر بيانات متاحة"
      : "NOAA GFS · بيانات حديثة";
  const statistics =
    dataset?.frame.statistics[activeGridKey] ??
    state?.manifest.statistics ??
    null;

  return (
    <main className="app-shell">
      <section className="map-stage" aria-busy={!state && !error}>
        {state && dataset ? (
          <WindMap
            boundary={state.boundary}
            dataset={dataset}
            selection={selection}
            onSelection={setSelection}
          >
            <WindTimeline
              frames={state.manifest.frames}
              frameIndex={frameIndex}
              onFrameIndexChange={setFrameIndex}
              level={level}
              availableLevels={levels}
              onLevelChange={setLevel}
              gusts={gusts}
              gustsAvailable={gustsAvailable}
              onGustsChange={setGusts}
              now={now}
            />
          </WindMap>
        ) : (
          <div className="loading-state" role={error ? "alert" : "status"}>
            <span className="loading-mark" aria-hidden="true" />
            {error ?? "جارٍ إعداد خريطة الرياح…"}
          </div>
        )}

        <div
          className={
            stale ? "sample-badge sample-badge--stale" : "sample-badge"
          }
        >
          {badge}
        </div>

        {gridError && (
          <p className="freshness-warning" role="alert">
            {gridError}
          </p>
        )}

        {state && (
          <aside className="information-panel" aria-label="معلومات الرياح">
            <header>
              <p className="eyebrow">المملكة العربية السعودية</p>
              <h1>رياح السعودية</h1>
              <p className="timestamp">
                {displayedTime ? formatSaudiDate(displayedTime) : ""}
                <span>بتوقيت المملكة</span>
              </p>
              {stale && (
                <p className="freshness-warning" role="status">
                  آخر بيانات صالحة أقدم من 12 ساعة
                </p>
              )}
            </header>

            <dl className="statistics">
              <div>
                <dt>متوسط السرعة</dt>
                <dd>
                  <bdi>
                    {statistics
                      ? formatKmh(statistics.areaWeightedMeanKmh)
                      : "—"}
                  </bdi>
                  <span>كم/س</span>
                </dd>
              </div>
              <div>
                <dt>أعلى خلية في النموذج</dt>
                <dd>
                  <bdi>
                    {statistics
                      ? formatKmh(statistics.maximumGridCellKmh)
                      : "—"}
                  </bdi>
                  <span>كم/س</span>
                </dd>
              </div>
            </dl>

            <div
              className={
                selection
                  ? "location-readout location-readout--active"
                  : "location-readout"
              }
              aria-live="polite"
            >
              <span className="location-cross" aria-hidden="true">
                +
              </span>
              {selection ? (
                <div>
                  <p className="location-title">الموقع المحدد</p>
                  <p className="location-coordinates">
                    <bdi>{selection.latitude.toFixed(2)}°</bdi> شمالاً ·{" "}
                    <bdi>{selection.longitude.toFixed(2)}°</bdi> شرقاً
                  </p>
                  <p className="location-wind">
                    <strong>
                      <bdi>{formatKmh(selection.speedKmh)}</bdi>
                      <span> كم/س</span>
                    </strong>
                    <span>
                      {selection.directionLabel} ·{" "}
                      <bdi>{Math.round(selection.directionDegrees)}°</bdi>
                    </span>
                  </p>
                </div>
              ) : (
                <p>اضغط داخل المملكة لعرض اتجاه الرياح وسرعتها.</p>
              )}
            </div>

            <div className="source-line">
              <span>NOAA GFS</span>
              <span>دقة 0.25°</span>
              <span>ارتفاع {level} م</span>
              {gusts && <span>هبّات</span>}
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
