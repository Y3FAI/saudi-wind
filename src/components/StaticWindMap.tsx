import { geoContains, geoMercator, geoPath } from "d3-geo";
import { useEffect, useRef } from "react";

import { sampleWind, speedKmh } from "../lib/wind";
import type { SaudiBoundary } from "../types/geo";
import type { WindDataset } from "../types/wind";

interface StaticWindMapProps {
  boundary: SaudiBoundary;
  dataset: WindDataset;
}

const CITIES = [
  { name: "الرياض", coordinates: [46.6753, 24.7136], priority: 1 },
  { name: "جدة", coordinates: [39.1979, 21.4858], priority: 1 },
  { name: "مكة المكرمة", coordinates: [39.8579, 21.3891], priority: 1 },
  { name: "المدينة المنورة", coordinates: [39.5692, 24.5247], priority: 1 },
  { name: "الدمام", coordinates: [50.1033, 26.4207], priority: 1 },
  { name: "تبوك", coordinates: [36.5715, 28.3835], priority: 2 },
  { name: "أبها", coordinates: [42.5053, 18.2164], priority: 2 },
  { name: "بريدة", coordinates: [43.975, 26.3592], priority: 2 },
] as const;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function StaticWindMap({ boundary, dataset }: StaticWindMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    const render = async () => {
      await document.fonts.ready;
      if (cancelled) return;

      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);

      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, bounds.width, bounds.height);

      const mobile = bounds.width < 680;
      const inset = mobile ? 18 : 42;
      const projection = geoMercator().fitExtent(
        [
          [inset, inset],
          [bounds.width - inset, bounds.height - inset],
        ],
        boundary,
      );
      const path = geoPath(projection, context);

      context.save();
      context.beginPath();
      path(boundary);
      context.clip();
      context.fillStyle = "#272a29";
      context.fillRect(0, 0, bounds.width, bounds.height);

      const random = seededRandom(1446);
      const count = mobile ? 650 : Math.round(bounds.width * 1.8);
      const { grid } = dataset.manifest;

      for (let line = 0; line < count; line += 1) {
        let longitude = grid.west + random() * (grid.east - grid.west);
        let latitude = grid.south + random() * (grid.north - grid.south);
        if (!geoContains(boundary, [longitude, latitude])) continue;

        const start = projection([longitude, latitude]);
        if (!start) continue;

        const firstWind = sampleWind(
          dataset.vectors,
          grid,
          longitude,
          latitude,
        );
        if (!firstWind) continue;

        const intensity = Math.min(speedKmh(firstWind) / 42, 1);
        context.beginPath();
        context.moveTo(start[0], start[1]);
        context.strokeStyle = `rgba(229, 232, 230, ${0.055 + intensity * 0.12})`;
        context.lineWidth = mobile ? 0.55 : 0.7;

        for (let step = 0; step < 52; step += 1) {
          const wind = sampleWind(dataset.vectors, grid, longitude, latitude);
          if (!wind) break;

          const latitudeRadians = (latitude * Math.PI) / 180;
          longitude +=
            (wind[0] * 0.012) / Math.max(Math.cos(latitudeRadians), 0.35);
          latitude += wind[1] * 0.012;
          if (!geoContains(boundary, [longitude, latitude])) break;

          const point = projection([longitude, latitude]);
          if (!point) break;
          context.lineTo(point[0], point[1]);
        }
        context.stroke();
      }
      context.restore();

      context.beginPath();
      path(boundary);
      context.strokeStyle = "rgba(225, 229, 226, 0.5)";
      context.lineWidth = 0.85;
      context.stroke();

      context.textAlign = "center";
      context.textBaseline = "middle";
      CITIES.forEach((city) => {
        if (mobile && city.priority > 1) return;
        const point = projection(city.coordinates as [number, number]);
        if (!point) return;

        context.beginPath();
        context.fillStyle = "rgba(235, 237, 235, 0.62)";
        context.arc(point[0], point[1], 1.7, 0, Math.PI * 2);
        context.fill();
        context.font = `${mobile ? 10 : 12}px "IBM Plex Sans Arabic"`;
        context.fillStyle = "rgba(235, 237, 235, 0.48)";
        context.fillText(city.name, point[0], point[1] - 12);
      });
    };

    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    void render();

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [boundary, dataset]);

  return (
    <canvas
      ref={canvasRef}
      className="wind-map"
      aria-label="خريطة تجريبية ثابتة لحركة الرياح فوق السعودية"
    />
  );
}
