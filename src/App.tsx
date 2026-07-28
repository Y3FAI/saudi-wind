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

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WindSelection | null>(null);

  useEffect(() => {
    let active = true;

    Promise.all([
      fetch("/data/saudi-boundary.geo.json").then((response) => {
        if (!response.ok) throw new Error("تعذر تحميل حدود المملكة.");
        return response.json() as Promise<SaudiBoundary>;
      }),
      loadWindDataset(),
    ])
      .then(([boundary, dataset]) => {
        if (active) setState({ boundary, dataset });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "حدث خطأ أثناء تحميل التصوّر.",
        );
      });

    return () => {
      active = false;
    };
  }, []);

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

        <div className="sample-badge">نموذج بصري · بيانات مجمّدة</div>

        {state && (
          <aside className="information-panel" aria-label="معلومات الرياح">
            <header>
              <p className="eyebrow">المملكة العربية السعودية</p>
              <h1>رياح السعودية</h1>
              <p className="timestamp">
                {formatSaudiDate(state.dataset.manifest.validTime)}
                <span>بتوقيت المملكة</span>
              </p>
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
          بيانات نموذجية: NOAA GFS · الحدود: Natural Earth
        </footer>
      </section>
    </main>
  );
}
