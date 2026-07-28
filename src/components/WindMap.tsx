import { geoContains, geoMercator, geoPath, type GeoProjection } from "d3-geo";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  applyViewTransform,
  clampViewTransform,
  invertViewTransform,
  rectanglesOverlap,
  zoomViewAt,
  type ScreenBounds,
  type ViewTransform,
} from "../lib/map";
import { WebglWindRenderer } from "../lib/webglWindRenderer";
import {
  arabicCompassName,
  normalizedDirection,
  sampleWind,
  speedKmh,
} from "../lib/wind";
import { FLOW_WIND_STYLE } from "../lib/windStyle";
import type { SaudiBoundary } from "../types/geo";
import type { WindDataset } from "../types/wind";

interface WindMapProps {
  boundary: SaudiBoundary;
  dataset: WindDataset;
  selection: WindSelection | null;
  onSelection: (selection: WindSelection) => void;
}

export interface WindSelection {
  longitude: number;
  latitude: number;
  speedKmh: number;
  directionDegrees: number;
  directionLabel: string;
}

interface Size {
  width: number;
  height: number;
  ratio: number;
}

const INITIAL_VIEW: ViewTransform = { scale: 1, x: 0, y: 0 };

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

function createProjection(
  boundary: SaudiBoundary,
  width: number,
  height: number,
): GeoProjection {
  const mobile = width < 680;
  const inset = mobile ? 18 : 42;
  return geoMercator().fitExtent(
    [
      [inset, inset],
      [width - inset, height - inset],
    ],
    boundary,
  );
}

function drawStaticWind(
  context: CanvasRenderingContext2D,
  boundary: SaudiBoundary,
  dataset: WindDataset,
  projection: GeoProjection,
  width: number,
) {
  const random = seededRandom(1446);
  const count = width < 680 ? 720 : Math.round(width * 1.75);
  const { grid } = dataset.manifest;

  for (let line = 0; line < count; line += 1) {
    let longitude = grid.west + random() * (grid.east - grid.west);
    let latitude = grid.south + random() * (grid.north - grid.south);
    if (!geoContains(boundary, [longitude, latitude])) continue;
    const start = projection([longitude, latitude]);
    if (!start) continue;
    const firstWind = sampleWind(dataset.vectors, grid, longitude, latitude);
    if (!firstWind) continue;

    context.beginPath();
    context.moveTo(start[0], start[1]);
    const intensity = Math.min(speedKmh(firstWind) / 42, 1);
    context.strokeStyle = `rgba(229, 232, 230, ${0.06 + intensity * 0.15})`;
    context.lineWidth = width < 680 ? 0.55 : 0.7;
    for (let step = 0; step < 48; step += 1) {
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
}

function drawBaseMap(
  canvas: HTMLCanvasElement,
  boundary: SaudiBoundary,
  dataset: WindDataset,
  projection: GeoProjection,
  size: Size,
  view: ViewTransform,
  selection: WindSelection | null,
  reducedMotion: boolean,
) {
  canvas.width = Math.round(size.width * size.ratio);
  canvas.height = Math.round(size.height * size.ratio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.save();
  context.translate(view.x, view.y);
  context.scale(view.scale, view.scale);
  const path = geoPath(projection, context);
  context.beginPath();
  path(boundary);
  context.fillStyle = "#272a29";
  context.fill();

  if (reducedMotion) {
    context.save();
    context.beginPath();
    path(boundary);
    context.clip();
    drawStaticWind(context, boundary, dataset, projection, size.width);
    context.restore();
  }

  context.beginPath();
  path(boundary);
  context.strokeStyle = "rgba(225, 229, 226, 0.58)";
  context.lineWidth = 0.9 / view.scale;
  context.stroke();
  context.restore();

  context.textAlign = "center";
  context.textBaseline = "middle";
  const occupied: Array<[number, number, number, number]> = [];
  CITIES.forEach((city) => {
    if (city.priority > 1 && view.scale < 1.35) return;
    const projected = projection(city.coordinates as [number, number]);
    if (!projected) return;
    const point = applyViewTransform(projected, view);
    if (
      point[0] < 0 ||
      point[0] > size.width ||
      point[1] < 0 ||
      point[1] > size.height
    ) {
      return;
    }
    const fontSize = size.width < 680 ? 10 : 12;
    context.font = `${fontSize}px "IBM Plex Sans Arabic"`;
    const labelWidth = context.measureText(city.name).width;
    const labelBounds: [number, number, number, number] = [
      point[0] - labelWidth / 2,
      point[1] - 22,
      point[0] + labelWidth / 2,
      point[1] - 8,
    ];
    if (occupied.some((bounds) => rectanglesOverlap(bounds, labelBounds, 4))) {
      return;
    }
    occupied.push(labelBounds);
    context.beginPath();
    context.fillStyle = "rgba(235, 237, 235, 0.7)";
    context.arc(point[0], point[1], 1.8, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "rgba(235, 237, 235, 0.56)";
    context.fillText(city.name, point[0], point[1] - 14);
  });

  if (selection) {
    const projected = projection([selection.longitude, selection.latitude]);
    if (projected) {
      const [x, y] = applyViewTransform(projected, view);
      context.strokeStyle = "rgba(244, 246, 244, 0.9)";
      context.lineWidth = 1;
      context.beginPath();
      context.arc(x, y, 7, 0, Math.PI * 2);
      context.moveTo(x - 11, y);
      context.lineTo(x + 11, y);
      context.moveTo(x, y - 11);
      context.lineTo(x, y + 11);
      context.stroke();
    }
  }
}

export function WindMap({
  boundary,
  dataset,
  selection,
  onSelection,
}: WindMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const windCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebglWindRenderer | null>(null);
  const rendererSceneRef = useRef("");
  const projectionRef = useRef<GeoProjection | null>(null);
  const boundaryBoundsRef = useRef<ScreenBounds>([
    [0, 0],
    [1, 1],
  ]);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({ startX: 0, startY: 0, moved: false });
  const [size, setSize] = useState<Size>({ width: 0, height: 0, ratio: 1 });
  const [view, setView] = useState<ViewTransform>(INITIAL_VIEW);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [webglError, setWebglError] = useState<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      setSize({
        width,
        height,
        ratio: Math.min(window.devicePixelRatio || 1, 2),
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      setWebglError(null);
      return;
    }
    const canvas = windCanvasRef.current;
    if (!canvas) return;
    try {
      const renderer = new WebglWindRenderer(
        canvas,
        boundary,
        dataset,
        FLOW_WIND_STYLE,
      );
      rendererRef.current = renderer;
      rendererSceneRef.current = "";
      setWebglError(null);
      return () => {
        renderer.destroy();
        if (rendererRef.current === renderer) rendererRef.current = null;
      };
    } catch (reason) {
      setWebglError(
        reason instanceof Error
          ? reason.message
          : "تعذر تشغيل حركة الرياح في هذا المتصفح.",
      );
    }
  }, [boundary, dataset, reducedMotion]);

  useEffect(() => {
    if (!size.width || !size.height) return;
    const projection = createProjection(boundary, size.width, size.height);
    projectionRef.current = projection;
    boundaryBoundsRef.current = geoPath(projection).bounds(
      boundary,
    ) as ScreenBounds;
    const constrained = clampViewTransform(
      view,
      [size.width, size.height],
      boundaryBoundsRef.current,
    );
    if (
      constrained.scale !== view.scale ||
      constrained.x !== view.x ||
      constrained.y !== view.y
    ) {
      setView(constrained);
      return;
    }
    const canvas = baseCanvasRef.current;
    if (canvas) {
      drawBaseMap(
        canvas,
        boundary,
        dataset,
        projection,
        size,
        view,
        selection,
        reducedMotion,
      );
    }
    const renderer = rendererRef.current;
    if (renderer && !reducedMotion) {
      const sceneKey = [
        size.width,
        size.height,
        size.ratio,
        view.scale,
        view.x,
        view.y,
      ].join(":");
      if (rendererSceneRef.current !== sceneKey) {
        rendererSceneRef.current = sceneKey;
        renderer.setViewport({
          ...size,
          project: (coordinates) =>
            projection(coordinates) as [number, number] | null,
          view,
        });
      }
      renderer.start();
    }
  }, [boundary, dataset, reducedMotion, selection, size, view]);

  const zoomAt = useCallback(
    (factor: number, anchor: readonly [number, number]) => {
      if (!size.width || !size.height) return;
      setView((current) =>
        zoomViewAt(
          current,
          factor,
          anchor,
          [size.width, size.height],
          boundaryBoundsRef.current,
        ),
      );
    },
    [size.height, size.width],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = container.getBoundingClientRect();
      const anchor: [number, number] = [
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ];
      zoomAt(Math.exp(-event.deltaY * 0.0013), anchor);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [zoomAt]);

  const inspect = (x: number, y: number) => {
    const projection = projectionRef.current;
    if (!projection) return;
    const base = invertViewTransform([x, y], view);
    const coordinates = projection.invert?.(base);
    if (!coordinates || !geoContains(boundary, coordinates)) return;
    const wind = sampleWind(
      dataset.vectors,
      dataset.manifest.grid,
      coordinates[0],
      coordinates[1],
    );
    if (!wind) return;
    const directionDegrees = normalizedDirection(wind);
    onSelection({
      longitude: coordinates[0],
      latitude: coordinates[1],
      speedKmh: speedKmh(wind),
      directionDegrees,
      directionLabel: arabicCompassName(directionDegrees),
    });
  };

  const pointerPosition = (event: ReactPointerEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointerPosition(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size === 1) {
      gestureRef.current = {
        startX: point.x,
        startY: point.y,
        moved: false,
      };
    } else {
      gestureRef.current.moved = true;
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointersRef.current.get(event.pointerId);
    if (!previous || !size.width || !size.height) return;
    const point = pointerPosition(event);
    const previousPointers = [...pointersRef.current.values()];
    pointersRef.current.set(event.pointerId, point);
    const currentPointers = [...pointersRef.current.values()];
    const distanceFromStart = Math.hypot(
      point.x - gestureRef.current.startX,
      point.y - gestureRef.current.startY,
    );
    if (distanceFromStart > 5) gestureRef.current.moved = true;

    if (currentPointers.length === 1) {
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      setView((current) =>
        clampViewTransform(
          { ...current, x: current.x + dx, y: current.y + dy },
          [size.width, size.height],
          boundaryBoundsRef.current,
        ),
      );
      return;
    }

    if (currentPointers.length === 2 && previousPointers.length === 2) {
      const previousDistance = Math.hypot(
        previousPointers[0].x - previousPointers[1].x,
        previousPointers[0].y - previousPointers[1].y,
      );
      const currentDistance = Math.hypot(
        currentPointers[0].x - currentPointers[1].x,
        currentPointers[0].y - currentPointers[1].y,
      );
      const previousMiddle: [number, number] = [
        (previousPointers[0].x + previousPointers[1].x) / 2,
        (previousPointers[0].y + previousPointers[1].y) / 2,
      ];
      const currentMiddle: [number, number] = [
        (currentPointers[0].x + currentPointers[1].x) / 2,
        (currentPointers[0].y + currentPointers[1].y) / 2,
      ];
      setView((current) => {
        const translated = {
          ...current,
          x: current.x + currentMiddle[0] - previousMiddle[0],
          y: current.y + currentMiddle[1] - previousMiddle[1],
        };
        return zoomViewAt(
          translated,
          previousDistance ? currentDistance / previousDistance : 1,
          currentMiddle,
          [size.width, size.height],
          boundaryBoundsRef.current,
        );
      });
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointerPosition(event);
    const inspectPoint =
      pointersRef.current.size === 1 && !gestureRef.current.moved;
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (inspectPoint) inspect(point.x, point.y);
  };

  const resetView = () => setView(INITIAL_VIEW);

  return (
    <div
      ref={containerRef}
      className="wind-map"
      role="application"
      aria-label="خريطة تفاعلية لحركة الرياح فوق السعودية"
      data-zoom={view.scale.toFixed(2)}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-wind-style={FLOW_WIND_STYLE.id}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        zoomAt(1.5, [event.clientX - bounds.left, event.clientY - bounds.top]);
      }}
    >
      <canvas ref={baseCanvasRef} className="map-canvas map-canvas--base" />
      <canvas
        ref={windCanvasRef}
        className="map-canvas map-canvas--wind"
        aria-hidden="true"
      />

      {webglError && (
        <div className="webgl-error" role="alert">
          <strong>تعذر تحريك الرياح</strong>
          <span>{webglError}</span>
        </div>
      )}

      {reducedMotion && (
        <div className="motion-note">تم إيقاف الحركة حسب إعدادات الجهاز</div>
      )}

      <div
        className="map-controls"
        aria-label="أدوات تكبير الخريطة"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="تكبير"
          onClick={() => zoomAt(1.35, [size.width / 2, size.height / 2])}
        >
          +
        </button>
        <button
          type="button"
          aria-label="تصغير"
          onClick={() => zoomAt(1 / 1.35, [size.width / 2, size.height / 2])}
        >
          −
        </button>
        <button
          type="button"
          className="reset-control"
          onClick={resetView}
          disabled={view.scale === 1}
        >
          إعادة
        </button>
      </div>

      <p className="interaction-hint">اسحب للتنقل · اضغط لقراءة الرياح</p>
    </div>
  );
}
