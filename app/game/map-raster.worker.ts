/// <reference lib="webworker" />

import { TERRAIN_RULES } from "./rules";
import {
  RASTER_PLAYER_ORDER,
  RASTER_TERRAIN_ORDER,
} from "./map-raster-protocol";
import type {
  MapRasterResult,
  MapRasterWorkerMessage,
  PoliticalRasterRequest,
  TheaterRasterRequest,
} from "./map-raster-protocol";

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

const COLOR_CACHE = new Map<string, RgbColor>();
const NEUTRAL_FIELD = RASTER_PLAYER_ORDER.length;

function rgb(hex: string): RgbColor {
  const cached = COLOR_CACHE.get(hex);
  if (cached) return cached;
  const value = Number.parseInt(hex.slice(1), 16);
  const color = {
    red: (value >> 16) & 255,
    green: (value >> 8) & 255,
    blue: value & 255,
  };
  COLOR_CACHE.set(hex, color);
  return color;
}

function mix(base: RgbColor, overlay: RgbColor, amount: number): RgbColor {
  return {
    red: Math.round(base.red + (overlay.red - base.red) * amount),
    green: Math.round(base.green + (overlay.green - base.green) * amount),
    blue: Math.round(base.blue + (overlay.blue - base.blue) * amount),
  };
}

const WATER_TERRAIN = RASTER_TERRAIN_ORDER.indexOf("water");

/**
 * How much darker a perimeter pixel is than its realm's interior.
 *
 * The border of a realm is not a drawn line: it is the outermost ring of the
 * realm's own areas, painted a darker shade of the realm's color. One factor,
 * applied to the composited pixel, keeps the hue readable — two realms meeting
 * still read as two colors, each rimmed in its own darker self.
 */
const PERIMETER_DARKEN = 0.58;

function fieldIndex(owner: number): number {
  return owner >= 0 ? owner : NEUTRAL_FIELD;
}

/**
 * The political map, one pixel per area.
 *
 * Ownership used to be treated as a probability field: claims were blurred
 * across the neighbourhood, sampled bilinearly at a display raster several
 * times the grid's size, and the border drawn where the two strongest claims
 * met. None of that survives here. Every cell of the world is exactly one
 * pixel wearing that area's attributes — its terrain tinted by its owner's
 * banner — and a realm's border is simply the perimeter of its territory:
 * any owned area touching ground that is not the same realm's is painted a
 * darker shade of the realm's color. Zoom happens on the display side by
 * scaling these pixels, never by re-rendering finer ones.
 *
 * Exported for headless benchmarks and tests; the worker protocol is the
 * real interface.
 */
export function renderPolitical(request: PoliticalRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight } = request;
  const cells = gridWidth * gridHeight;
  const fill = new Uint8ClampedArray(cells * 4);

  // Flat channel tables: terrain fills by terrain index, each realm's overlay
  // color and blend strength by claim field. Realm colors arrive with the
  // request — the documented color of the element each realm currently
  // expresses — so ascension repaints territory the frame it happens.
  const terrainCount = RASTER_TERRAIN_ORDER.length;
  const fieldCount = RASTER_PLAYER_ORDER.length + 1;
  const terrainLut = new Float64Array(terrainCount * 3);
  for (let index = 0; index < terrainCount; index += 1) {
    const terrainId = RASTER_TERRAIN_ORDER[index]!;
    const color = rgb(TERRAIN_RULES[terrainId === "water" ? "plains" : terrainId].fill);
    terrainLut[index * 3] = color.red;
    terrainLut[index * 3 + 1] = color.green;
    terrainLut[index * 3 + 2] = color.blue;
  }
  const overlayLut = new Float64Array(fieldCount * 3);
  const overlayAmount = new Float64Array(fieldCount);
  const neutral = rgb("#d8cfb1");
  for (let field = 0; field < fieldCount; field += 1) {
    const player = field < RASTER_PLAYER_ORDER.length;
    overlayLut[field * 3] = player ? request.playerColors[field * 3]! : neutral.red;
    overlayLut[field * 3 + 1] = player ? request.playerColors[field * 3 + 1]! : neutral.green;
    overlayLut[field * 3 + 2] = player ? request.playerColors[field * 3 + 2]! : neutral.blue;
    overlayAmount[field] = player ? 0.66 : 0.16;
  }
  const water = rgb(TERRAIN_RULES.water.fill);

  for (let y = 0; y < gridHeight; y += 1) {
    const row = y * gridWidth;
    for (let x = 0; x < gridWidth; x += 1) {
      const index = row + x;
      const pixel = index * 4;
      if (request.terrains[index] === WATER_TERRAIN) {
        fill[pixel] = water.red;
        fill[pixel + 1] = water.green;
        fill[pixel + 2] = water.blue;
        fill[pixel + 3] = 255;
        continue;
      }
      const owner = request.owners[index]!;
      const field = fieldIndex(owner);
      const amount = field === request.selected ? 0.76 : overlayAmount[field]!;
      const terrainBase = request.terrains[index]! * 3;
      const overlayBase = field * 3;
      let red = terrainLut[terrainBase]!
        + (overlayLut[overlayBase]! - terrainLut[terrainBase]!) * amount;
      let green = terrainLut[terrainBase + 1]!
        + (overlayLut[overlayBase + 1]! - terrainLut[terrainBase + 1]!) * amount;
      let blue = terrainLut[terrainBase + 2]!
        + (overlayLut[overlayBase + 2]! - terrainLut[terrainBase + 2]!) * amount;
      // The border: an owned area on the perimeter of its realm — any
      // cardinal neighbour inside the map that is not the same owner, water
      // and wilderness included — wears a darker shade of its realm's pixel.
      // The map edge is the end of the world, not a frontier, so it does not
      // darken.
      if (owner >= 0) {
        const perimeter =
          (x > 0 && request.owners[index - 1] !== owner) ||
          (x < gridWidth - 1 && request.owners[index + 1] !== owner) ||
          (y > 0 && request.owners[index - gridWidth] !== owner) ||
          (y < gridHeight - 1 && request.owners[index + gridWidth] !== owner);
        if (perimeter) {
          red *= PERIMETER_DARKEN;
          green *= PERIMETER_DARKEN;
          blue *= PERIMETER_DARKEN;
        }
      }
      fill[pixel] = Math.round(red);
      fill[pixel + 1] = Math.round(green);
      fill[pixel + 2] = Math.round(blue);
      fill[pixel + 3] = 255;
    }
  }
  return {
    type: "rendered",
    requestId: request.requestId,
    mode: request.mode,
    rasterWidth: gridWidth,
    rasterHeight: gridHeight,
    fill,
  };
}

function theaterHeat(value: number): RgbColor {
  const low = rgb("#c95550");
  const middle = rgb("#d7b854");
  const high = rgb("#3e9f68");
  if (value <= 0.5) return mix(low, middle, value * 2);
  return mix(middle, high, (value - 0.5) * 2);
}

/**
 * The theater-value map, one pixel per area like the political map: each land
 * cell wears its own banded heat tint, and a cell whose band steps down to a
 * cardinal neighbour darkens — a one-cell contour on the higher ground.
 */
export function renderTheaters(request: TheaterRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight } = request;
  const cells = gridWidth * gridHeight;
  const fill = new Uint8ClampedArray(cells * 4);
  const bands = new Int8Array(cells).fill(-1);
  const water = rgb(TERRAIN_RULES.water.fill);
  const neutral = rgb("#e1dac7");

  for (let index = 0; index < cells; index += 1) {
    if (request.terrains[index] === WATER_TERRAIN) continue;
    const value = Math.max(0, Math.min(1, request.values[index]!));
    bands[index] = Math.min(9, Math.floor(value * 10));
  }

  const contour = rgb("#1f2b2b");
  for (let y = 0; y < gridHeight; y += 1) {
    const row = y * gridWidth;
    for (let x = 0; x < gridWidth; x += 1) {
      const index = row + x;
      const pixel = index * 4;
      const band = bands[index]!;
      if (band < 0) {
        fill[pixel] = water.red;
        fill[pixel + 1] = water.green;
        fill[pixel + 2] = water.blue;
        fill[pixel + 3] = 255;
        continue;
      }
      const value = Math.max(0, Math.min(1, request.values[index]!));
      // A faint stepped tint makes each nested band legible while retaining a
      // continuous gradient inside it.
      const bandCenter = band / 10 + 0.05;
      const displayedValue = value * 0.72 + Math.min(1, bandCenter) * 0.28;
      let color = mix(neutral, theaterHeat(displayedValue), 0.9);
      // Contours at cell resolution: darken the higher band where it meets a
      // lower one, and the shoreline where land meets water.
      const coastline =
        (x > 0 && bands[index - 1] === -1) ||
        (x < gridWidth - 1 && bands[index + 1] === -1) ||
        (y > 0 && bands[index - gridWidth] === -1) ||
        (y < gridHeight - 1 && bands[index + gridWidth] === -1);
      const boundary =
        (x > 0 && bands[index - 1]! >= 0 && bands[index - 1]! < band) ||
        (x < gridWidth - 1 && bands[index + 1]! >= 0 && bands[index + 1]! < band) ||
        (y > 0 && bands[index - gridWidth]! >= 0 && bands[index - gridWidth]! < band) ||
        (y < gridHeight - 1 && bands[index + gridWidth]! >= 0 && bands[index + gridWidth]! < band);
      if (coastline || boundary) {
        color = mix(color, contour, coastline ? 0.84 : band % 2 === 0 ? 0.68 : 0.48);
      }
      fill[pixel] = color.red;
      fill[pixel + 1] = color.green;
      fill[pixel + 2] = color.blue;
      fill[pixel + 3] = 255;
    }
  }
  return {
    type: "rendered",
    requestId: request.requestId,
    mode: request.mode,
    rasterWidth: gridWidth,
    rasterHeight: gridHeight,
    fill,
  };
}

// Guarded so the module stays importable headlessly (tests, benchmarks);
// inside a real worker, `self` is the worker scope.
if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("message", (event: MessageEvent<MapRasterWorkerMessage>) => {
    const result = event.data.mode === "political"
      ? renderPolitical(event.data)
      : renderTheaters(event.data);
    self.postMessage(result, { transfer: [result.fill.buffer] });
  });
}
