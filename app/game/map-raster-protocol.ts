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
 * One raster pixel per authoritative cell.
 *
 * The map is not a picture of the world sampled at some display resolution;
 * it *is* the world grid. Every pixel in the raster is exactly one area with
 * that area's attributes — terrain, owner, perimeter — and zooming the map
 * scales those pixels up or down on the display without ever inventing
 * sub-cell detail. The raster therefore has no width or height of its own:
 * it is always `gridWidth` by `gridHeight`.
 */
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
  /** Always the grid dimensions: one pixel per area. */
  rasterWidth: number;
  rasterHeight: number;
  fill: Uint8ClampedArray<ArrayBuffer>;
}
