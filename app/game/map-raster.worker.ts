/// <reference lib="webworker" />

import { PLAYERS } from "./players";
import { TERRAIN_RULES } from "./rules";
import {
  RASTER_PLAYER_ORDER,
  RASTER_TERRAIN_ORDER,
} from "./map-raster-protocol";
import type {
  MapRasterRequest,
  MapRasterResult,
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
const WATER_FIELD = RASTER_PLAYER_ORDER.length + 1;

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

/**
 * Ownership as a sparse field, so smoothing costs the same at any roster size.
 *
 * Borders are drawn by treating ownership as a field, blurring it, and finding
 * where the two strongest claims meet. Held as one channel per realm that is
 * exact but wasteful: the field is one-hot, so of fifty-two channels at most a
 * couple are ever non-zero in a cell and at most a handful across the
 * neighbourhood a blur touches. Five elements made the waste affordable; fifty
 * realms made it seven times the work and eleven megabytes of churn a frame,
 * which is what turned the map to a stutter.
 *
 * Each cell keeps only the claims that exist on it, so the cost follows the
 * number of realms meeting at a point -- rarely more than three -- rather than
 * the number in the world.
 */
const CLAIMS_PER_CELL = 6;
/** Separable [1,2,1] applied twice, as one 3x3 pass. */
const BLUR_KERNEL = [1, 2, 1, 2, 4, 2, 1, 2, 1];

interface ClaimField {
  /** Field id per slot, -1 where a cell has fewer claims than slots. */
  ids: Int16Array;
  weights: Float32Array;
}

function blurClaims(
  rawIds: Int16Array,
  rawWeights: Float32Array,
  width: number,
  height: number,
): ClaimField {
  const cells = width * height;
  const ids = new Int16Array(cells * CLAIMS_PER_CELL).fill(-1);
  const weights = new Float32Array(cells * CLAIMS_PER_CELL);
  // At most two claims from each of nine neighbours.
  const scratchIds = new Int16Array(18);
  const scratchWeights = new Float64Array(18);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let found = 0;
      for (let k = 0; k < 9; k += 1) {
        const ny = Math.max(0, Math.min(height - 1, y + Math.floor(k / 3) - 1));
        const nx = Math.max(0, Math.min(width - 1, x + (k % 3) - 1));
        const weight = BLUR_KERNEL[k]! / 16;
        const source = (ny * width + nx) * 2;
        for (let slot = 0; slot < 2; slot += 1) {
          const id = rawIds[source + slot]!;
          if (id < 0) continue;
          const value = rawWeights[source + slot]! * weight;
          if (value <= 0) continue;
          let at = -1;
          for (let e = 0; e < found; e += 1) {
            if (scratchIds[e] === id) { at = e; break; }
          }
          if (at < 0) { at = found; scratchIds[at] = id; scratchWeights[at] = 0; found += 1; }
          scratchWeights[at]! += value;
        }
      }
      // Keep the strongest claims; anything past them cannot win a pixel.
      const target = (y * width + x) * CLAIMS_PER_CELL;
      const keep = Math.min(found, CLAIMS_PER_CELL);
      for (let slot = 0; slot < keep; slot += 1) {
        let best = -1;
        let bestValue = -1;
        for (let e = 0; e < found; e += 1) {
          if (scratchWeights[e]! > bestValue) { bestValue = scratchWeights[e]!; best = e; }
        }
        ids[target + slot] = scratchIds[best]!;
        weights[target + slot] = bestValue;
        scratchWeights[best] = -1;
      }
    }
  }
  return { ids, weights };
}

function fieldIndex(owner: number, terrain: number): number {
  if (owner >= 0) return owner;
  return RASTER_TERRAIN_ORDER[terrain] === "water" ? WATER_FIELD : NEUTRAL_FIELD;
}

function renderPolitical(request: PoliticalRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight, rasterWidth, rasterHeight } = request;
  const cells = gridWidth * gridHeight;
  // Two claims per cell: who holds it, and who is pressing it.
  const rawIds = new Int16Array(cells * 2).fill(-1);
  const rawWeights = new Float32Array(cells * 2);
  for (let index = 0; index < request.owners.length; index += 1) {
    const owner = fieldIndex(request.owners[index]!, request.terrains[index]!);
    const pressureOwner = request.pressureOwners[index]!;
    const pressure = pressureOwner >= 0 && pressureOwner !== request.owners[index]
      ? Math.max(0, Math.min(1, request.pressures[index]!))
      : 0;
    rawIds[index * 2] = owner;
    rawWeights[index * 2] = 1 - pressure;
    if (pressure > 0) {
      rawIds[index * 2 + 1] = fieldIndex(pressureOwner, request.terrains[index]!);
      rawWeights[index * 2 + 1] = pressure;
    }
  }

  const claims = blurClaims(rawIds, rawWeights, gridWidth, gridHeight);
  const fill = new Uint8ClampedArray(rasterWidth * rasterHeight * 4);
  const borders = new Uint8ClampedArray(fill.length);
  // Four corners of the bilinear sample, each carrying its own claims.
  const mergedIds = new Int16Array(CLAIMS_PER_CELL * 4);
  const mergedWeights = new Float64Array(CLAIMS_PER_CELL * 4);

  for (let py = 0; py < rasterHeight; py += 1) {
    const gridY = ((py + 0.5) / rasterHeight) * gridHeight - 0.5;
    const floorY = Math.floor(gridY);
    const y0 = Math.max(0, Math.min(gridHeight - 1, floorY));
    const y1 = Math.min(gridHeight - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, gridY - floorY));
    for (let px = 0; px < rasterWidth; px += 1) {
      const gridX = ((px + 0.5) / rasterWidth) * gridWidth - 0.5;
      const floorX = Math.floor(gridX);
      const x0 = Math.max(0, Math.min(gridWidth - 1, floorX));
      const x1 = Math.min(gridWidth - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, gridX - floorX));

      const corners = [
        { cell: y0 * gridWidth + x0, share: (1 - tx) * (1 - ty) },
        { cell: y0 * gridWidth + x1, share: tx * (1 - ty) },
        { cell: y1 * gridWidth + x0, share: (1 - tx) * ty },
        { cell: y1 * gridWidth + x1, share: tx * ty },
      ];
      let merged = 0;
      for (const corner of corners) {
        if (corner.share <= 0) continue;
        const base = corner.cell * CLAIMS_PER_CELL;
        for (let slot = 0; slot < CLAIMS_PER_CELL; slot += 1) {
          const id = claims.ids[base + slot]!;
          if (id < 0) break;
          const value = claims.weights[base + slot]! * corner.share;
          let at = -1;
          for (let e = 0; e < merged; e += 1) {
            if (mergedIds[e] === id) { at = e; break; }
          }
          if (at < 0) { at = merged; mergedIds[at] = id; mergedWeights[at] = 0; merged += 1; }
          mergedWeights[at]! += value;
        }
      }

      let first = -1;
      let firstValue = 0;
      let second = -1;
      let secondValue = 0;
      for (let e = 0; e < merged; e += 1) {
        const value = mergedWeights[e]!;
        if (first < 0 || value > firstValue) {
          second = first; secondValue = firstValue;
          first = mergedIds[e]!; firstValue = value;
        } else if (second < 0 || value > secondValue) {
          second = mergedIds[e]!; secondValue = value;
        }
      }

      const nearestX = Math.max(0, Math.min(gridWidth - 1, Math.round(gridX)));
      const nearestY = Math.max(0, Math.min(gridHeight - 1, Math.round(gridY)));
      const terrainId = RASTER_TERRAIN_ORDER[request.terrains[nearestY * gridWidth + nearestX]!]!;
      const winner = first >= 0 && first < RASTER_PLAYER_ORDER.length ? RASTER_PLAYER_ORDER[first]! : null;
      const terrain = rgb(TERRAIN_RULES[first === WATER_FIELD ? "water" : terrainId].fill);
      const fillColor = winner
        ? mix(terrain, rgb(PLAYERS[winner]!.color), first === request.selected ? 0.76 : 0.66)
        : first === NEUTRAL_FIELD
          ? mix(terrain, rgb("#d8cfb1"), 0.16)
          : terrain;
      const pixel = (py * rasterWidth + px) * 4;
      fill[pixel] = fillColor.red;
      fill[pixel + 1] = fillColor.green;
      fill[pixel + 2] = fillColor.blue;
      fill[pixel + 3] = 255;

      if (second < 0 || secondValue < 0.055) continue;
      const gap = firstValue - secondValue;
      const strength = Math.max(0, Math.min(1, 1 - gap / 0.25));
      if (strength <= 0) continue;
      const firstOwner = first < RASTER_PLAYER_ORDER.length ? first : -1;
      const secondOwner = second < RASTER_PLAYER_ORDER.length ? second : -1;
      const core = gap <= 0.16;
      const atWar = firstOwner >= 0 && secondOwner >= 0
        ? request.warMatrix[firstOwner * RASTER_PLAYER_ORDER.length + secondOwner] === 1
        : false;
      const line = core
        ? { red: 12, green: 16, blue: 18 }
        : atWar
          ? { red: 145, green: 55, blue: 58 }
          : { red: 12, green: 16, blue: 18 };
      const alpha = core ? 1 : Math.pow(strength, 0.72) * (atWar ? 0.9 : 0.78);
      borders[pixel] = line.red;
      borders[pixel + 1] = line.green;
      borders[pixel + 2] = line.blue;
      borders[pixel + 3] = Math.round(alpha * 255);
    }
  }
  return { type: "rendered", requestId: request.requestId, mode: request.mode, rasterWidth, rasterHeight, fill, borders };
}

function theaterHeat(value: number): RgbColor {
  const low = rgb("#c95550");
  const middle = rgb("#d7b854");
  const high = rgb("#3e9f68");
  if (value <= 0.5) return mix(low, middle, value * 2);
  return mix(middle, high, (value - 0.5) * 2);
}

function renderTheaters(request: TheaterRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight, rasterWidth, rasterHeight } = request;
  const fill = new Uint8ClampedArray(rasterWidth * rasterHeight * 4);
  const sampledValues = new Float32Array(rasterWidth * rasterHeight);
  const landMask = new Uint8Array(rasterWidth * rasterHeight);

  for (let py = 0; py < rasterHeight; py += 1) {
    const gridY = ((py + 0.5) / rasterHeight) * gridHeight - 0.5;
    const floorY = Math.floor(gridY);
    const y0 = Math.max(0, Math.min(gridHeight - 1, floorY));
    const y1 = Math.min(gridHeight - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, gridY - floorY));
    for (let px = 0; px < rasterWidth; px += 1) {
      const gridX = ((px + 0.5) / rasterWidth) * gridWidth - 0.5;
      const floorX = Math.floor(gridX);
      const x0 = Math.max(0, Math.min(gridWidth - 1, floorX));
      const x1 = Math.min(gridWidth - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, gridX - floorX));
      const nearestX = Math.max(0, Math.min(gridWidth - 1, Math.round(gridX)));
      const nearestY = Math.max(0, Math.min(gridHeight - 1, Math.round(gridY)));
      const terrainId = RASTER_TERRAIN_ORDER[request.terrains[nearestY * gridWidth + nearestX]!]!;
      const outputIndex = py * rasterWidth + px;
      const pixel = outputIndex * 4;
      if (terrainId === "water") {
        const water = rgb(TERRAIN_RULES.water.fill);
        fill[pixel] = water.red;
        fill[pixel + 1] = water.green;
        fill[pixel + 2] = water.blue;
        fill[pixel + 3] = 255;
        continue;
      }
      const topLeft = request.values[y0 * gridWidth + x0]!;
      const topRight = request.values[y0 * gridWidth + x1]!;
      const bottomLeft = request.values[y1 * gridWidth + x0]!;
      const bottomRight = request.values[y1 * gridWidth + x1]!;
      const value = Math.max(0, Math.min(1,
        (topLeft + (topRight - topLeft) * tx) * (1 - ty)
        + (bottomLeft + (bottomRight - bottomLeft) * tx) * ty,
      ));
      sampledValues[outputIndex] = value;
      landMask[outputIndex] = 1;
      // A faint stepped tint makes each nested band legible while retaining a
      // continuous gradient between the isolines.
      const bandCenter = Math.floor(value * 10) / 10 + 0.05;
      const displayedValue = value * 0.72 + Math.min(1, bandCenter) * 0.28;
      const neutral = rgb("#e1dac7");
      const color = mix(neutral, theaterHeat(displayedValue), 0.9);
      fill[pixel] = color.red;
      fill[pixel + 1] = color.green;
      fill[pixel + 2] = color.blue;
      fill[pixel + 3] = 255;
    }
  }

  const contour = { red: 31, green: 43, blue: 43 };
  for (let py = 0; py < rasterHeight; py += 1) {
    for (let px = 0; px < rasterWidth; px += 1) {
      const index = py * rasterWidth + px;
      if (!landMask[index]) continue;
      const band = Math.min(9, Math.floor(sampledValues[index]! * 10));
      let boundary = false;
      let coastline = false;
      for (let oy = -1; oy <= 1 && !coastline; oy += 1) {
        const y = py + oy;
        if (y < 0 || y >= rasterHeight) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const x = px + ox;
          if (x < 0 || x >= rasterWidth) continue;
          const neighbor = y * rasterWidth + x;
          if (!landMask[neighbor]) {
            coastline = true;
            break;
          }
          const neighborBand = Math.min(9, Math.floor(sampledValues[neighbor]! * 10));
          if (neighborBand !== band) boundary = true;
        }
      }
      if (!boundary && !coastline) continue;
      const pixel = index * 4;
      const existing = { red: fill[pixel]!, green: fill[pixel + 1]!, blue: fill[pixel + 2]! };
      const major = band % 2 === 0;
      const color = mix(existing, contour, coastline ? 0.84 : major ? 0.68 : 0.48);
      fill[pixel] = color.red;
      fill[pixel + 1] = color.green;
      fill[pixel + 2] = color.blue;
    }
  }
  return {
    type: "rendered",
    requestId: request.requestId,
    mode: request.mode,
    rasterWidth,
    rasterHeight,
    fill,
    borders: null,
  };
}

self.addEventListener("message", (event: MessageEvent<MapRasterRequest>) => {
  const result = event.data.mode === "political"
    ? renderPolitical(event.data)
    : renderTheaters(event.data);
  const transfer = result.borders
    ? [result.fill.buffer, result.borders.buffer]
    : [result.fill.buffer];
  self.postMessage(result, { transfer });
});
