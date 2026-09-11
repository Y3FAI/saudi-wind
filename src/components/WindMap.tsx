import { geoContains, geoMercator, geoPath, type GeoProjection } from "d3-geo";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  detectDeviceProfile,
  effectivePixelRatio,
  type DeviceProfile,
} from "../lib/deviceProfile";
import {
  applyViewTransform,
  clampViewTransform,
  createMercatorProjector,
  invertViewTransform,
  projectMercatorInto,
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
  /** Overlay controls rendered inside the map stage (e.g. the forecast timeline). */
  children?: ReactNode;
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

/** Pointer travel (CSS px) above which a gesture counts as a pan, not a tap. */
const TAP_SLOP = 6;
/** Window used to estimate fling velocity on release. */
const MOMENTUM_SAMPLE_MS = 120;
/** Exponential fling decay per millisecond (half-life ~154 ms). */
const MOMENTUM_DECAY_PER_MS = 0.0045;
/** Fling speed cap in CSS px/ms. */
const MOMENTUM_MAX_SPEED = 2.6;
/** Fling stops below this speed (CSS px/ms). */
const MOMENTUM_MIN_SPEED = 0.02;

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

/**
 * Reduced-motion fallback: a single static frame of streamlines with arrowheads
 * so wind direction is still readable without any animation.
 */
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
    let tipX = start[0];
    let tipY = start[1];
    let previousX = start[0];
    let previousY = start[1];
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
      previousX = tipX;
      previousY = tipY;
      tipX = point[0];
      tipY = point[1];
      context.lineTo(tipX, tipY);
    }
    context.stroke();

    // Arrowhead so direction reads without motion.
    const dx = tipX - previousX;
    const dy = tipY - previousY;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude < 0.6) continue;
    const unitX = dx / magnitude;
    const unitY = dy / magnitude;
    const headLength = 3.4 + intensity * 2.2;
    const headSpread = headLength * 0.5;
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(
      tipX - unitX * headLength + unitY * headSpread,
      tipY - unitY * headLength - unitX * headSpread,
    );
    context.lineTo(
      tipX - unitX * headLength - unitY * headSpread,
      tipY - unitY * headLength + unitX * headSpread,
    );
    context.closePath();
    context.fillStyle = `rgba(229, 232, 230, ${0.09 + intensity * 0.2})`;
    context.fill();
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
  children,
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
  const pinchRef = useRef<{
    distance: number;
    mid: { x: number; y: number };
    view: ViewTransform;
  } | null>(null);
  const moveSamplesRef = useRef<Array<{ t: number; x: number; y: number }>>([]);
  const momentumRef = useRef({ frame: 0, vx: 0, vy: 0 });

  const [profile] = useState<DeviceProfile>(() => detectDeviceProfile());
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
      if (!width || !height) return;
      const ratio = effectivePixelRatio(
        window.devicePixelRatio || 1,
        profile,
        width,
        height,
      );
      setSize((current) =>
        current.width === width &&
        current.height === height &&
        current.ratio === ratio
          ? current
          : { width, height, ratio },
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [profile]);

  useEffect(() => {
    // Free any in-flight fling when the component unmounts.
    return () => {
      if (momentumRef.current.frame) {
        cancelAnimationFrame(momentumRef.current.frame);
        momentumRef.current.frame = 0;
      }
    };
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
        {
          profile,
          onContextLost: () =>
            setWebglError(
              "انقطع اتصال الرسوم مؤقتاً بسبب ضغط على الجهاز. سنستعيد الحركة تلقائياً.",
            ),
          onContextRestored: () => setWebglError(null),
          onContextRestoreFailed: (message) => setWebglError(message),
        },
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
  }, [boundary, dataset, reducedMotion, profile]);

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
      const scale = projection.scale();
      const translate = projection.translate() as [number, number];
      const projectWind = createMercatorProjector(scale, translate);
      // Allocation-free projection for the particle hot loop: raw Mercator then
      // the pan/zoom transform, all written into the renderer's own buffer.
      const projectWindInto = (
        longitude: number,
        latitude: number,
        output: [number, number],
      ) => {
        projectMercatorInto(scale, translate, longitude, latitude, output);
        const x = output[0] * view.scale + view.x;
        const y = output[1] * view.scale + view.y;
        output[0] = x;
        output[1] = y;
        return true;
      };
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
          project: projectWind,
          projectInto: projectWindInto,
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

  const cancelMomentum = () => {
    if (momentumRef.current.frame) {
      cancelAnimationFrame(momentumRef.current.frame);
      momentumRef.current.frame = 0;
    }
  };

  const recordSample = (point: { x: number; y: number }) => {
    const now = performance.now();
    const samples = moveSamplesRef.current;
    samples.push({ t: now, x: point.x, y: point.y });
    while (samples.length > 2 && now - samples[0].t > MOMENTUM_SAMPLE_MS) {
      samples.shift();
    }
  };

  const startMomentum = () => {
    const samples = moveSamplesRef.current;
    moveSamplesRef.current = [];
    if (samples.length < 2) return;
    const last = samples[samples.length - 1];
    const first =
      samples.find((sample) => last.t - sample.t <= MOMENTUM_SAMPLE_MS) ??
      samples[0];
    const elapsed = last.t - first.t;
    if (elapsed <= 0) return;
    let vx = (last.x - first.x) / elapsed;
    let vy = (last.y - first.y) / elapsed;
    const speed = Math.hypot(vx, vy);
    if (speed < MOMENTUM_MIN_SPEED) return;
    if (speed > MOMENTUM_MAX_SPEED) {
      vx = (vx / speed) * MOMENTUM_MAX_SPEED;
      vy = (vy / speed) * MOMENTUM_MAX_SPEED;
    }
    const momentum = momentumRef.current;
    momentum.vx = vx;
    momentum.vy = vy;
    let previousTime = performance.now();
    const step = (time: number) => {
      const elapsedMs = Math.min(50, time - previousTime);
      previousTime = time;
      const decay = Math.exp(-MOMENTUM_DECAY_PER_MS * elapsedMs);
      momentum.vx *= decay;
      momentum.vy *= decay;
      if (Math.hypot(momentum.vx, momentum.vy) < MOMENTUM_MIN_SPEED) {
        momentum.frame = 0;
        return;
      }
      setView((current) =>
        clampViewTransform(
          {
            ...current,
            x: current.x + momentum.vx * elapsedMs,
            y: current.y + momentum.vy * elapsedMs,
          },
          [size.width, size.height],
          boundaryBoundsRef.current,
        ),
      );
      momentum.frame = requestAnimationFrame(step);
    };
    momentum.frame = requestAnimationFrame(step);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cancelMomentum();
    const point = pointerPosition(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point);
    moveSamplesRef.current = [{ t: performance.now(), x: point.x, y: point.y }];
    if (pointersRef.current.size === 1) {
      gestureRef.current = {
        startX: point.x,
        startY: point.y,
        moved: false,
      };
      pinchRef.current = null;
      return;
    }
    gestureRef.current.moved = true;
    const pointers = [...pointersRef.current.values()];
    if (pointers.length === 2) {
      pinchRef.current = {
        distance: Math.max(
          1,
          Math.hypot(
            pointers[0].x - pointers[1].x,
            pointers[0].y - pointers[1].y,
          ),
        ),
        mid: {
          x: (pointers[0].x + pointers[1].x) / 2,
          y: (pointers[0].y + pointers[1].y) / 2,
        },
        view,
      };
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const previousPointers = [...pointersRef.current.values()];
    const point = pointerPosition(event);
    pointersRef.current.set(event.pointerId, point);
    const currentPointers = [...pointersRef.current.values()];
    if (!size.width || !size.height) return;

    const gesture = gestureRef.current;
    if (
      Math.hypot(point.x - gesture.startX, point.y - gesture.startY) > TAP_SLOP
    ) {
      gesture.moved = true;
    }

    if (currentPointers.length === 1) {
      const previous = previousPointers[0];
      if (!previous) return;
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if (!dx && !dy) return;
      recordSample(point);
      setView((current) =>
        clampViewTransform(
          { ...current, x: current.x + dx, y: current.y + dy },
          [size.width, size.height],
          boundaryBoundsRef.current,
        ),
      );
      return;
    }

    if (currentPointers.length >= 2) {
      const currentMid = {
        x: (currentPointers[0].x + currentPointers[1].x) / 2,
        y: (currentPointers[0].y + currentPointers[1].y) / 2,
      };
      const distance = Math.max(
        1,
        Math.hypot(
          currentPointers[0].x - currentPointers[1].x,
          currentPointers[0].y - currentPointers[1].y,
        ),
      );
      const pinch = pinchRef.current;
      if (!pinch) {
        pinchRef.current = { distance, mid: currentMid, view };
        return;
      }
      // Zoom around the focal point, using the gesture baseline so the pinch
      // does not compound frame to frame.
      const factor = distance / pinch.distance;
      const translated = {
        scale: pinch.view.scale,
        x: pinch.view.x + (currentMid.x - pinch.mid.x),
        y: pinch.view.y + (currentMid.y - pinch.mid.y),
      };
      setView(
        zoomViewAt(
          translated,
          factor,
          [currentMid.x, currentMid.y],
          [size.width, size.height],
          boundaryBoundsRef.current,
        ),
      );
    }
  };

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointersRef.current.delete(event.pointerId);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointerPosition(event);
    const wasSingle = pointersRef.current.size === 1;
    const tapped = wasSingle && !gestureRef.current.moved;
    const panned = wasSingle && gestureRef.current.moved;
    releasePointer(event);

    if (tapped) {
      moveSamplesRef.current = [];
      inspect(point.x, point.y);
      return;
    }

    if (pointersRef.current.size === 0) {
      pinchRef.current = null;
      if (panned && !reducedMotion) startMomentum();
      else moveSamplesRef.current = [];
      return;
    }

    // A finger remains after a pinch: restart single-finger panning from here.
    pinchRef.current = null;
    gestureRef.current = { startX: point.x, startY: point.y, moved: true };
    moveSamplesRef.current = [{ t: performance.now(), x: point.x, y: point.y }];
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event);
    if (pointersRef.current.size === 0) pinchRef.current = null;
    moveSamplesRef.current = [];
  };

  const resetView = () => setView(INITIAL_VIEW);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panDistance = 28;
    const pan = (x: number, y: number) =>
      setView((current) =>
        clampViewTransform(
          { ...current, x: current.x + x, y: current.y + y },
          [size.width, size.height],
          boundaryBoundsRef.current,
        ),
      );

    switch (event.key) {
      case "ArrowLeft":
        pan(-panDistance, 0);
        break;
      case "ArrowRight":
        pan(panDistance, 0);
        break;
      case "ArrowUp":
        pan(0, -panDistance);
        break;
      case "ArrowDown":
        pan(0, panDistance);
        break;
      case "+":
      case "=":
        zoomAt(1.35, [size.width / 2, size.height / 2]);
        break;
      case "-":
      case "_":
        zoomAt(1 / 1.35, [size.width / 2, size.height / 2]);
        break;
      case "Home":
        resetView();
        break;
      case "Enter":
      case " ":
        inspect(size.width / 2, size.height / 2);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      className="wind-map"
      role="application"
      aria-label="خريطة تفاعلية لحركة الرياح فوق السعودية"
      aria-describedby="wind-map-keyboard-help"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - Home Enter"
      tabIndex={0}
      data-zoom={view.scale.toFixed(2)}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-wind-style={FLOW_WIND_STYLE.id}
      data-device-tier={profile.tier}
      data-dpr={size.ratio.toFixed(2)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onDoubleClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        zoomAt(1.5, [event.clientX - bounds.left, event.clientY - bounds.top]);
      }}
    >
      <p id="wind-map-keyboard-help" className="visually-hidden">
        استخدم أسهم لوحة المفاتيح للتنقل، وزري زائد وناقص للتكبير والتصغير،
        ومفتاح البداية لإعادة العرض، ومفتاح الإدخال لقراءة الرياح في وسط
        الخريطة.
      </p>
      <canvas
        ref={baseCanvasRef}
        className="map-canvas map-canvas--base"
        aria-hidden="true"
      />
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
        role="group"
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

      {children}
    </div>
  );
}
