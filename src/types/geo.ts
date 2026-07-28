export type Position = [longitude: number, latitude: number];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
}

export interface SaudiBoundary {
  type: "Feature";
  properties: {
    name: string;
    source: string;
  };
  geometry: PolygonGeometry | MultiPolygonGeometry;
}
