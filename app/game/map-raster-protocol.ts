import type { ElementId, TerrainId } from "./types";

export const RASTER_ELEMENT_ORDER: readonly ElementId[] = ["ember", "tide", "grove", "stone", "gale"];
export const RASTER_TERRAIN_ORDER: readonly TerrainId[] = [
  "water",
  "farmland",
  "plains",
  "forest",
  "hills",
  "mountains",
];

interface RasterRequestBase {
  type: "render";
  requestId: number;
  gridWidth: number;
  gridHeight: number;
  rasterWidth: number;
  rasterHeight: number;
  terrains: Uint8Array;
}

export interface PoliticalRasterRequest extends RasterRequestBase {
  mode: "political";
  selected: number;
  owners: Int8Array;
  pressureOwners: Int8Array;
  pressures: Float32Array;
  warMatrix: Uint8Array;
}

export interface TheaterRasterRequest extends RasterRequestBase {
  mode: "theaters";
  values: Float32Array;
}

export type MapRasterRequest = PoliticalRasterRequest | TheaterRasterRequest;

export interface MapRasterResult {
  type: "rendered";
  requestId: number;
  mode: MapRasterRequest["mode"];
  rasterWidth: number;
  rasterHeight: number;
  fill: Uint8ClampedArray;
  borders: Uint8ClampedArray | null;
}
