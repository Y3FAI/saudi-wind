import { describe, expect, it } from "vitest";

import {
  CITIES,
  NEAREST_CITY_KM,
  citySpeeds,
  distanceKm,
  fastestCity,
  nearestCity,
  pointSpeedKmh,
  slowestCity,
} from "./inspection";
import type { WindGridMetadata } from "../types/wind";

/**
 * The city statistics have to be deterministic: the same decoded grid must
 * always name the same fastest and slowest city. These tests pin that with a
 * grid whose wind is an exactly known function of latitude, so the expected
 * speed of every city can be derived by hand.
 */

const GRID: WindGridMetadata = {
  west: 33,
  east: 57,
  south: 15,
  north: 33.5,
  width: 97,
  height: 75,
  dx: 0.25,
  dy: 0.25,
  scan: "north-to-south-west-to-east",
};

/**
 * `u = north - latitude` (`v = 0`), so the field strengthens toward the south
 * and bilinear sampling is exact: the speed at a latitude is
 * `3.6 * (north - latitude)` km/h.
 */
function latitudeGradientVectors(): Float32Array {
  const vectors = new Float32Array(GRID.width * GRID.height * 2);
  for (let row = 0; row < GRID.height; row += 1) {
    for (let column = 0; column < GRID.width; column += 1) {
      const index = (row * GRID.width + column) * 2;
      vectors[index] = row * GRID.dy;
      vectors[index + 1] = 0;
    }
  }
  return vectors;
}

function uniformVectors(u: number, v: number): Float32Array {
  const vectors = new Float32Array(GRID.width * GRID.height * 2);
  for (let index = 0; index < vectors.length; index += 2) {
    vectors[index] = u;
    vectors[index + 1] = v;
  }
  return vectors;
}

function speedAtLatitude(latitude: number): number {
  return 3.6 * (GRID.north - latitude);
}

function cityByName(name: string) {
  const city = CITIES.find((candidate) => candidate.name === name);
  if (!city) throw new Error(`unknown city in the catalogue: ${name}`);
  return city;
}

describe("city wind statistics", () => {
  it("ranks the city with the strongest sampled wind fastest", () => {
    const vectors = latitudeGradientVectors();
    const fastest = fastestCity(vectors, GRID);
    const slowest = slowestCity(vectors, GRID);

    // The field strengthens toward the south, so أبها is windiest and تبوك calmest.
    expect(fastest?.city.name).toBe("أبها");
    expect(slowest?.city.name).toBe("تبوك");
    expect(fastest?.speedKmh).toBeCloseTo(
      speedAtLatitude(cityByName("أبها").coordinates[1]),
      9,
    );
    expect(slowest?.speedKmh).toBeCloseTo(
      speedAtLatitude(cityByName("تبوك").coordinates[1]),
      9,
    );
    expect(fastest?.speedKmh).toBeGreaterThan(slowest?.speedKmh ?? 0);
  });

  it("reports every city the grid covers in catalogue order", () => {
    const speeds = citySpeeds(latitudeGradientVectors(), GRID);
    expect(speeds.map((entry) => entry.city.name)).toEqual(
      CITIES.map((city) => city.name),
    );
    for (const entry of speeds) {
      expect(entry.speedKmh).toBeCloseTo(
        speedAtLatitude(entry.city.coordinates[1]),
        9,
      );
    }
  });

  it("breaks equal speeds by the catalogue order", () => {
    const vectors = uniformVectors(5, 0);
    const fastest = fastestCity(vectors, GRID);
    const slowest = slowestCity(vectors, GRID);

    expect(fastest?.city.name).toBe(CITIES[0].name);
    expect(slowest?.city.name).toBe(CITIES[0].name);
    expect(fastest?.speedKmh).toBeCloseTo(18, 9);
  });

  it("returns the identical ranking on every call", () => {
    const vectors = latitudeGradientVectors();
    const runs = Array.from({ length: 5 }, () => ({
      fastest: fastestCity(vectors, GRID),
      slowest: slowestCity(vectors, GRID),
    }));

    for (const run of runs) {
      expect(run.fastest?.city.name).toBe(runs[0].fastest?.city.name);
      expect(run.fastest?.speedKmh).toBe(runs[0].fastest?.speedKmh);
      expect(run.slowest?.city.name).toBe(runs[0].slowest?.city.name);
      expect(run.slowest?.speedKmh).toBe(runs[0].slowest?.speedKmh);
    }
  });

  it("has nothing to report for a grid that covers no city", () => {
    const offshore: WindGridMetadata = {
      ...GRID,
      west: 5,
      east: 20,
      south: 5,
      north: 12,
      width: 61,
      height: 29,
    };
    const vectors = new Float32Array(offshore.width * offshore.height * 2);
    expect(fastestCity(vectors, offshore)).toBeNull();
    expect(slowestCity(vectors, offshore)).toBeNull();
  });
});

describe("nearest city", () => {
  it("names the city a point sits on or beside", () => {
    const riyadh = cityByName("الرياض");
    expect(nearestCity(riyadh.coordinates)?.name).toBe("الرياض");
    const besideTabuk: [number, number] = [
      cityByName("تبوك").coordinates[0],
      cityByName("تبوك").coordinates[1] - 0.2,
    ];
    expect(nearestCity(besideTabuk)?.name).toBe("تبوك");
  });

  it("returns null for a point farther than the threshold from every city", () => {
    // The Empty Quarter: ~600 km from الرياض, the nearest label.
    expect(nearestCity([48.5, 19.5])).toBeNull();
    // The same point is inside a widened threshold.
    expect(nearestCity([48.5, 19.5], 900)?.name).toBe("الرياض");
  });

  it("measures great-circle distance symmetrically", () => {
    const jeddah = cityByName("جدة").coordinates;
    const mecca = cityByName("مكة المكرمة").coordinates;
    const there = distanceKm(jeddah, mecca);
    expect(there).toBeCloseTo(distanceKm(mecca, jeddah), 9);
    expect(there).toBeGreaterThan(50);
    expect(there).toBeLessThan(100);
    expect(NEAREST_CITY_KM).toBe(60);
  });
});

describe("point inspection", () => {
  it("samples the grid speed at a point inside it", () => {
    const vectors = latitudeGradientVectors();
    const riyadh = cityByName("الرياض");
    expect(
      pointSpeedKmh(
        vectors,
        GRID,
        riyadh.coordinates[0],
        riyadh.coordinates[1],
      ),
    ).toBeCloseTo(speedAtLatitude(riyadh.coordinates[1]), 9);
  });

  it("returns null outside the grid so the click can be ignored", () => {
    const vectors = latitudeGradientVectors();
    expect(pointSpeedKmh(vectors, GRID, 20, 24)).toBeNull();
    expect(pointSpeedKmh(vectors, GRID, 46.6753, 40)).toBeNull();
  });
});
