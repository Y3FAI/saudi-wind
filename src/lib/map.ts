export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export type ScreenPoint = readonly [x: number, y: number];
export type ScreenBounds = readonly [ScreenPoint, ScreenPoint];

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4.5;

export function createMercatorProjector(scale: number, translate: ScreenPoint) {
  const radians = Math.PI / 180;
  return ([longitude, latitude]: ScreenPoint): [number, number] => {
    const latitudeRadians = latitude * radians;
    return [
      translate[0] + scale * longitude * radians,
      translate[1] -
        scale * Math.log(Math.tan((Math.PI / 2 + latitudeRadians) / 2)),
    ];
  };
}

export function applyViewTransform(
  point: ScreenPoint,
  view: ViewTransform,
): [number, number] {
  return [point[0] * view.scale + view.x, point[1] * view.scale + view.y];
}

export function invertViewTransform(
  point: ScreenPoint,
  view: ViewTransform,
): [number, number] {
  return [(point[0] - view.x) / view.scale, (point[1] - view.y) / view.scale];
}

export function clampViewTransform(
  view: ViewTransform,
  viewport: ScreenPoint,
  boundaryBounds: ScreenBounds,
): ViewTransform {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale));
  if (scale === MIN_ZOOM) return { scale, x: 0, y: 0 };

  const visibleMargin = Math.min(96, Math.min(viewport[0], viewport[1]) * 0.22);
  const [[west, north], [east, south]] = boundaryBounds;
  const minimumX = visibleMargin - east * scale;
  const maximumX = viewport[0] - visibleMargin - west * scale;
  const minimumY = visibleMargin - south * scale;
  const maximumY = viewport[1] - visibleMargin - north * scale;

  return {
    scale,
    x: Math.min(maximumX, Math.max(minimumX, view.x)),
    y: Math.min(maximumY, Math.max(minimumY, view.y)),
  };
}

export function zoomViewAt(
  view: ViewTransform,
  factor: number,
  anchor: ScreenPoint,
  viewport: ScreenPoint,
  boundaryBounds: ScreenBounds,
): ViewTransform {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
  const ratio = scale / view.scale;

  return clampViewTransform(
    {
      scale,
      x: anchor[0] - (anchor[0] - view.x) * ratio,
      y: anchor[1] - (anchor[1] - view.y) * ratio,
    },
    viewport,
    boundaryBounds,
  );
}

export function rectanglesOverlap(
  first: readonly [number, number, number, number],
  second: readonly [number, number, number, number],
  padding = 0,
): boolean {
  return !(
    first[2] + padding < second[0] ||
    first[0] - padding > second[2] ||
    first[3] + padding < second[1] ||
    first[1] - padding > second[3]
  );
}
