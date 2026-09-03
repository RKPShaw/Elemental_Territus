/// <reference lib="webworker" />

import { TERRAIN_RULES } from "./rules";
import {
  RASTER_PLAYER_ORDER,
  RASTER_SCALE,
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
 * How much darker a perimeter rim pixel is than its realm's interior.
 *
 * The border of a realm is not a drawn line: it is the outermost rim of the
 * realm's own areas, painted a darker shade of the realm's color. One factor,
 * applied to the composited pixel, keeps the hue readable — two realms meeting
 * still read as two colors, each rimmed in its own darker self. At five raster
 * pixels per area the rim is one raster pixel wide, on only the sides that
 * actually face foreign ground.
 */
const PERIMETER_DARKEN = 0.58;

/**
 * Paints one area's block of the raster: a flat `RASTER_SCALE`-square of the
 * area's color, with a one-raster-pixel rim in the rim color on each side
 * (and corner) whose bit is set in `edges`: 1 left, 2 right, 4 up, 8 down,
 * 16 up-left, 32 up-right, 64 down-left, 128 down-right.
 */
function paintBlock(
  fill: Uint8ClampedArray,
  rasterWidth: number,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  edges: number,
  rimRed: number,
  rimGreen: number,
  rimBlue: number,
) {
  const last = RASTER_SCALE - 1;
  for (let sy = 0; sy <= last; sy += 1) {
    let base = (((y * RASTER_SCALE) + sy) * rasterWidth + x * RASTER_SCALE) * 4;
    for (let sx = 0; sx <= last; sx += 1) {
      const rim = edges !== 0 && (
        ((edges & 1) !== 0 && sx === 0) ||
        ((edges & 2) !== 0 && sx === last) ||
        ((edges & 4) !== 0 && sy === 0) ||
        ((edges & 8) !== 0 && sy === last) ||
        ((edges & 16) !== 0 && sx === 0 && sy === 0) ||
        ((edges & 32) !== 0 && sx === last && sy === 0) ||
        ((edges & 64) !== 0 && sx === 0 && sy === last) ||
        ((edges & 128) !== 0 && sx === last && sy === last)
      );
      fill[base] = Math.round(rim ? rimRed : red);
      fill[base + 1] = Math.round(rim ? rimGreen : green);
      fill[base + 2] = Math.round(rim ? rimBlue : blue);
      fill[base + 3] = 255;
      base += 4;
    }
  }
}

function fieldIndex(owner: number): number {
  return owner >= 0 ? owner : NEUTRAL_FIELD;
}

/**
 * The political map, one flat block per area at five raster pixels per axis.
 *
 * Ownership used to be treated as a probability field: claims were blurred
 * across the neighbourhood, sampled bilinearly at a display raster several
 * times the grid's size, and the border drawn where the two strongest claims
 * met. None of that survives here. Every cell of the world is one flat block
 * wearing that area's attributes — its terrain tinted by its owner's banner —
 * and a realm's border is simply the perimeter of its territory. The five
 * raster pixels per area exist so the perimeter can be an edge instead of an
 * area: only the one-raster-pixel rim on the sides (and outward corners) that
 * actually face foreign ground darkens, so the frontier is a thin line of the
 * realm's own darker self rather than a whole darkened area. Zoom still
 * happens on the display side by scaling these pixels, never by re-rendering
 * finer ones.
 *
 * Exported for headless benchmarks and tests; the worker protocol is the
 * real interface.
 */
export function renderPolitical(request: PoliticalRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight } = request;
  const cells = gridWidth * gridHeight;
  const rasterWidth = gridWidth * RASTER_SCALE;
  const rasterHeight = gridHeight * RASTER_SCALE;
  const fill = new Uint8ClampedArray(cells * RASTER_SCALE * RASTER_SCALE * 4);

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
      if (request.terrains[index] === WATER_TERRAIN) {
        paintBlock(fill, rasterWidth, x, y, water.red, water.green, water.blue, 0, 0, 0, 0);
        continue;
      }
      const owner = request.owners[index]!;
      const field = fieldIndex(owner);
      const amount = field === request.selected ? 0.76 : overlayAmount[field]!;
      const terrainBase = request.terrains[index]! * 3;
      const overlayBase = field * 3;
      const red = terrainLut[terrainBase]!
        + (overlayLut[overlayBase]! - terrainLut[terrainBase]!) * amount;
      const green = terrainLut[terrainBase + 1]!
        + (overlayLut[overlayBase + 1]! - terrainLut[terrainBase + 1]!) * amount;
      const blue = terrainLut[terrainBase + 2]!
        + (overlayLut[overlayBase + 2]! - terrainLut[terrainBase + 2]!) * amount;
      // The border: an owned area on the perimeter of its realm rims the
      // sides that face ground that is not the same realm's — water and
      // wilderness included — in a darker shade of its own pixel. Outward
      // corners rim too so two frontier lines meet without a notch. The map
      // edge is the end of the world, not a frontier, so it does not darken.
      let edges = 0;
      if (owner >= 0) {
        const left = x > 0;
        const right = x < gridWidth - 1;
        const up = y > 0;
        const down = y < gridHeight - 1;
        if (left && request.owners[index - 1] !== owner) edges |= 1;
        if (right && request.owners[index + 1] !== owner) edges |= 2;
        if (up && request.owners[index - gridWidth] !== owner) edges |= 4;
        if (down && request.owners[index + gridWidth] !== owner) edges |= 8;
        if (left && up && request.owners[index - gridWidth - 1] !== owner) edges |= 16;
        if (right && up && request.owners[index - gridWidth + 1] !== owner) edges |= 32;
        if (left && down && request.owners[index + gridWidth - 1] !== owner) edges |= 64;
        if (right && down && request.owners[index + gridWidth + 1] !== owner) edges |= 128;
      }
      paintBlock(
        fill,
        rasterWidth,
        x,
        y,
        red,
        green,
        blue,
        edges,
        red * PERIMETER_DARKEN,
        green * PERIMETER_DARKEN,
        blue * PERIMETER_DARKEN,
      );
    }
  }
  return {
    type: "rendered",
    requestId: request.requestId,
    mode: request.mode,
    rasterWidth,
    rasterHeight,
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
 * The theater-value map, one flat block per area like the political map: each
 * land cell wears its own banded heat tint, and a cell whose band steps down
 * to a cardinal neighbour rims the facing side — a thin contour line on the
 * higher ground, one raster pixel wide at five per area.
 */
export function renderTheaters(request: TheaterRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight } = request;
  const cells = gridWidth * gridHeight;
  const rasterWidth = gridWidth * RASTER_SCALE;
  const rasterHeight = gridHeight * RASTER_SCALE;
  const fill = new Uint8ClampedArray(cells * RASTER_SCALE * RASTER_SCALE * 4);
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
      const band = bands[index]!;
      if (band < 0) {
        paintBlock(fill, rasterWidth, x, y, water.red, water.green, water.blue, 0, 0, 0, 0);
        continue;
      }
      const value = Math.max(0, Math.min(1, request.values[index]!));
      // A faint stepped tint makes each nested band legible while retaining a
      // continuous gradient inside it.
      const bandCenter = band / 10 + 0.05;
      const displayedValue = value * 0.72 + Math.min(1, bandCenter) * 0.28;
      const color = mix(neutral, theaterHeat(displayedValue), 0.9);
      // Contours as edges: the higher band rims the sides where it meets a
      // lower one, and the shoreline rims where land faces water. Only the
      // facing rim of the block darkens, so the contour is a thin line.
      let coastline = false;
      let edges = 0;
      const step = (neighbourBand: number, bit: number) => {
        if (neighbourBand === -1) {
          coastline = true;
          edges |= bit;
        } else if (neighbourBand < band) {
          edges |= bit;
        }
      };
      if (x > 0) step(bands[index - 1]!, 1);
      if (x < gridWidth - 1) step(bands[index + 1]!, 2);
      if (y > 0) step(bands[index - gridWidth]!, 4);
      if (y < gridHeight - 1) step(bands[index + gridWidth]!, 8);
      if (x > 0 && y > 0) step(bands[index - gridWidth - 1]!, 16);
      if (x < gridWidth - 1 && y > 0) step(bands[index - gridWidth + 1]!, 32);
      if (x > 0 && y < gridHeight - 1) step(bands[index + gridWidth - 1]!, 64);
      if (x < gridWidth - 1 && y < gridHeight - 1) step(bands[index + gridWidth + 1]!, 128);
      const rim = mix(color, contour, coastline ? 0.84 : band % 2 === 0 ? 0.68 : 0.48);
      paintBlock(
        fill,
        rasterWidth,
        x,
        y,
        color.red,
        color.green,
        color.blue,
        edges,
        rim.red,
        rim.green,
        rim.blue,
      );
    }
  }
  return {
    type: "rendered",
    requestId: request.requestId,
    mode: request.mode,
    rasterWidth,
    rasterHeight,
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
