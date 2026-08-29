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
  /**
   * The advancing claimant per cell in raster player order (-1 where none)
   * and how far its claim has swept, from the political field smoother. The
   * border pass tints a contested line with a darker shade of the advancing
   * realm's color, so the direction of a push is readable from the border.
   */
  pushOwners: Int16Array;
  pushStrengths: Float32Array;
  /**
   * RGB per player in raster player order, three bytes each: the documented
   * color of the element each realm currently expresses. Sent per frame
   * rather than baked into the worker so a realm repaints the moment a
   * conquest forges it a new tier of element.
   */
  playerColors: Uint8Array;
  warMatrix: Uint8Array;
}

export interface TheaterRasterRequest extends RasterRequestBase {
  mode: "theaters";
  values: Float32Array;
}

export type MapRasterRequest = PoliticalRasterRequest | TheaterRasterRequest;

/**
 * Pixel buffers handed back to the worker once a frame has been composited.
 *
 * The interpolated display loop asks for many rasters a second, and each one
 * is megabytes of pixels; recycling the buffers keeps the steady state free of
 * large allocations on both sides, which is what keeps the garbage collector
 * out of the animation.
 */
export interface RasterBufferRecycle {
  type: "recycle";
  buffers: ArrayBuffer[];
}

export type MapRasterWorkerMessage = MapRasterRequest | RasterBufferRecycle;

export interface MapRasterResult {
  type: "rendered";
  requestId: number;
  mode: MapRasterRequest["mode"];
  rasterWidth: number;
  rasterHeight: number;
  fill: Uint8ClampedArray<ArrayBuffer>;
  borders: Uint8ClampedArray<ArrayBuffer> | null;
}
