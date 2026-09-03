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
  // Terraformed ground appends after the worldgen six — the codes are
  // positional on the wire, so append-only keeps old captures decodable.
  "scorched",
  "marsh",
  "duneland",
  "terrace",
  "glacier",
  "basalt",
  "sporemire",
  "verdant",
];

export const RASTER_PLAYER_INDEX: ReadonlyMap<PlayerId, number> = new Map(
  RASTER_PLAYER_ORDER.map((id, index) => [id, index]),
);
export const RASTER_TERRAIN_INDEX: ReadonlyMap<TerrainId, number> = new Map(
  RASTER_TERRAIN_ORDER.map((id, index) => [id, index]),
);

/**
 * How many raster pixels one authoritative cell spans on each axis.
 *
 * The map is still not a picture of the world sampled at some display
 * resolution: every area is one flat block of its own attributes — terrain,
 * owner — and no sub-cell detail is ever invented. The raster is simply five
 * times finer than the grid so that *edges* can be drawn at sub-area width: a
 * realm's perimeter is a one-raster-pixel rim on the facing side of the
 * frontier area instead of a whole darkened area, and theater contours are
 * likewise thin. The raster is always `gridWidth * RASTER_SCALE` by
 * `gridHeight * RASTER_SCALE`.
 */
export const RASTER_SCALE = 5;

interface RasterRequestBase {
  type: "render";
  requestId: number;
  gridWidth: number;
  gridHeight: number;
  terrains: Uint8Array;
}
export interface PoliticalRasterRequest extends RasterRequestBase {
  mode: "political";
  selected: number;
  /** Owner per cell in raster player order, -1 where unowned. */
  owners: Int8Array;
  /**
   * RGB per player in raster player order, three bytes each: the documented
   * color of the element each realm currently expresses. Sent per frame
   * rather than baked into the worker so a realm repaints the moment a
   * conquest forges it a new tier of element.
   */
  playerColors: Uint8Array;
}

export interface TheaterRasterRequest extends RasterRequestBase {
  mode: "theaters";
  values: Float32Array;
}

export type MapRasterRequest = PoliticalRasterRequest | TheaterRasterRequest;

export type MapRasterWorkerMessage = MapRasterRequest;

export interface MapRasterResult {
  type: "rendered";
  requestId: number;
  mode: MapRasterRequest["mode"];
  /** Always the grid dimensions times RASTER_SCALE: one 5x5 block per area. */
  rasterWidth: number;
  rasterHeight: number;
  fill: Uint8ClampedArray<ArrayBuffer>;
}
