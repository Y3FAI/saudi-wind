import { useEffect, useState } from "react";

import { WindMap, type WindSelection } from "./components/WindMap";
import { formatKmh, formatSaudiDate } from "./lib/format";
import { loadWindDataset } from "./lib/wind";
import type { SaudiBoundary } from "./types/geo";
import type { WindDataset } from "./types/wind";

interface AppState {
  boundary: SaudiBoundary;
  dataset: WindDataset;
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

  useEffect(() => {
    let active = true;
    let currentRunId: string | null = null;

    const load = async () => {
      try {
        const [boundary, dataset] = await Promise.all([
          fetch("/data/saudi-boundary.geo.json").then((response) => {
            if (!response.ok) throw new Error("تعذر تحميل حدود المملكة.");
            return response.json() as Promise<SaudiBoundary>;
          }),
          loadWindDataset(WIND_MANIFEST_URL),
        ]);
        if (!active) return;
        if (currentRunId && currentRunId !== dataset.manifest.runId) {
          setSelection(null);
        }
        currentRunId = dataset.manifest.runId;
        setState({ boundary, dataset });
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

  const stale = state
    ? Date.now() - Date.parse(state.dataset.manifest.validTime) > STALE_AFTER_MS
    : false;
  const badge = state?.dataset.manifest.sample
    ? "NOAA GFS · عينة معالجة"
    : stale
      ? "NOAA GFS · آخر بيانات متاحة"
      : "NOAA GFS · بيانات حديثة";

  return (
    <main className="app-shell">
      <section className="map-stage" aria-busy={!state && !error}>
        {state ? (
          <WindMap
            boundary={state.boundary}
            dataset={state.dataset}
            selection={selection}
            onSelection={setSelection}
          />
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

        {state && (
          <aside className="information-panel" aria-label="معلومات الرياح">
            <header>
              <p className="eyebrow">المملكة العربية السعودية</p>
              <h1>رياح السعودية</h1>
              <p className="timestamp">
                {formatSaudiDate(state.dataset.manifest.validTime)}
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
                    {formatKmh(
                      state.dataset.manifest.statistics.areaWeightedMeanKmh,
                    )}
                  </bdi>
                  <span>كم/س</span>
                </dd>
              </div>
              <div>
                <dt>أعلى خلية في النموذج</dt>
                <dd>
                  <bdi>
                    {formatKmh(
                      state.dataset.manifest.statistics.maximumGridCellKmh,
                    )}
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
              <span>ارتفاع 10 م</span>
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
          بيانات نموذج NOAA GFS · الحدود: Natural Earth
        </footer>
      </section>
    </main>
  );
}
