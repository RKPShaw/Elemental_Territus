import { PLAYER_ORDER } from "./players";
import type { PlayerId, TerrainId } from "./types";

/**
 * Owner codes on the wire, one per player.
 *
 * It was one per element back when a player was an element; with ten players to
 * an element that made every realm of a family paint the same colour and the
 * war matrix meaningless. Owners are signed bytes, so this holds up to a
 * hundred and twenty-seven realms.
 */
export const RASTER_PLAYER_ORDER: readonly PlayerId[] = PLAYER_ORDER;
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
