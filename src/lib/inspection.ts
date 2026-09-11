import type { WindGridMetadata } from "../types/wind";
import { sampleWind, speedKmh } from "./wind";

/**
 * The labelled cities and the point-inspection maths behind the information
 * panel's statistics.
 *
 * The catalogue lives here rather than inside `WindMap` so the labels the map
 * draws and the numbers the readout derives can never drift apart: both read
 * the same coordinates, and the fastest/slowest statistics break ties by this
 * array's order, which keeps them deterministic.
 */

export interface City {
  readonly name: string;
  readonly coordinates: [number, number];
  readonly priority: number;
}

export const CITIES: readonly City[] = [
  { name: "الرياض", coordinates: [46.6753, 24.7136], priority: 1 },
  { name: "جدة", coordinates: [39.1979, 21.4858], priority: 1 },
  { name: "مكة المكرمة", coordinates: [39.8579, 21.3891], priority: 1 },
  { name: "المدينة المنورة", coordinates: [39.5692, 24.5247], priority: 1 },
  { name: "الدمام", coordinates: [50.1033, 26.4207], priority: 1 },
  { name: "تبوك", coordinates: [36.5715, 28.3835], priority: 2 },
  { name: "أبها", coordinates: [42.5053, 18.2164], priority: 2 },
  { name: "بريدة", coordinates: [43.975, 26.3592], priority: 2 },
];

/** How close a click has to land to take a city's name. */
export const NEAREST_CITY_KM = 60;

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two `[longitude, latitude]` points, in km. */
export function distanceKm(
  first: readonly [number, number],
  second: readonly [number, number],
): number {
  const [[longitudeA, latitudeA], [longitudeB, latitudeB]] = [first, second];
  const deltaLatitude = toRadians(latitudeB - latitudeA);
  const deltaLongitude = toRadians(longitudeB - longitudeA);
  const sinLatitude = Math.sin(deltaLatitude / 2);
  const sinLongitude = Math.sin(deltaLongitude / 2);
  const square =
    sinLatitude * sinLatitude +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      sinLongitude *
      sinLongitude;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(square)));
}

/**
 * The nearest city within `thresholdKm` of a point, or `null` when the point is
 * farther than that from every city. Ties resolve to `CITIES` order.
 */
export function nearestCity(
  coordinates: readonly [number, number],
  thresholdKm: number = NEAREST_CITY_KM,
): City | null {
  let nearest: City | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const city of CITIES) {
    const distance = distanceKm(coordinates, city.coordinates);
    if (distance > thresholdKm) continue;
    if (nearest === null || distance < nearestDistance) {
      nearest = city;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export interface CitySpeed {
  city: City;
  speedKmh: number;
}

/**
 * Every labelled city the grid covers, with its sampled speed, in `CITIES`
 * order. A city outside the grid is skipped rather than reported as zero.
 */
export function citySpeeds(
  vectors: Float32Array,
  grid: WindGridMetadata,
): CitySpeed[] {
  const speeds: CitySpeed[] = [];
  for (const city of CITIES) {
    const wind = sampleWind(
      vectors,
      grid,
      city.coordinates[0],
      city.coordinates[1],
    );
    if (!wind) continue;
    speeds.push({ city, speedKmh: speedKmh(wind) });
  }
  return speeds;
}

/** The windiest labelled city; equal speeds resolve to `CITIES` order. */
export function fastestCity(
  vectors: Float32Array,
  grid: WindGridMetadata,
): CitySpeed | null {
  let fastest: CitySpeed | null = null;
  for (const candidate of citySpeeds(vectors, grid)) {
    if (fastest === null || candidate.speedKmh > fastest.speedKmh) {
      fastest = candidate;
    }
  }
  return fastest;
}

/** The calmest labelled city; equal speeds resolve to `CITIES` order. */
export function slowestCity(
  vectors: Float32Array,
  grid: WindGridMetadata,
): CitySpeed | null {
  let slowest: CitySpeed | null = null;
  for (const candidate of citySpeeds(vectors, grid)) {
    if (slowest === null || candidate.speedKmh < slowest.speedKmh) {
      slowest = candidate;
    }
  }
  return slowest;
}

/** One inspected map location, in degrees. */
export interface MapSelection {
  longitude: number;
  latitude: number;
}

/**
 * The grid's wind speed at one point, km/h, or `null` when the point falls
 * outside the grid.
 */
export function pointSpeedKmh(
  vectors: Float32Array,
  grid: WindGridMetadata,
  longitude: number,
  latitude: number,
): number | null {
  const wind = sampleWind(vectors, grid, longitude, latitude);
  return wind ? speedKmh(wind) : null;
}
