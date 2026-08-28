/// <reference lib="webworker" />

import { PLAYERS } from "./players";
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

/**
 * Buffers returned by the display thread after compositing, reused for the
 * next frame instead of allocating megabytes per raster.
 */
const BUFFER_POOL: ArrayBuffer[] = [];
const BUFFER_POOL_LIMIT = 6;

function leasePixels(byteLength: number, zeroed: boolean): Uint8ClampedArray<ArrayBuffer> {
  for (let at = 0; at < BUFFER_POOL.length; at += 1) {
    if (BUFFER_POOL[at]!.byteLength !== byteLength) continue;
    const buffer = BUFFER_POOL.splice(at, 1)[0]!;
    const pixels = new Uint8ClampedArray(buffer);
    if (zeroed) pixels.fill(0);
    return pixels;
  }
  return new Uint8ClampedArray(byteLength);
}

const WATER_TERRAIN = RASTER_TERRAIN_ORDER.indexOf("water");

/**
 * Half-width of the coastline band, in land-fraction units. The land mask
 * moves from 0 to 1 across one grid cell, so at eight raster pixels per cell
 * this band draws a stroke roughly a pixel and a half wide.
 */
const COAST_BAND = 0.09;
/** Land-fraction span over which the fill anti-aliases from water to land. */
const COAST_AA = 0.05;

function fieldIndex(owner: number): number {
  return owner >= 0 ? owner : NEUTRAL_FIELD;
}

/** Exported for headless benchmarks and tests; the worker protocol is the real interface. */
export function renderPolitical(request: PoliticalRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight, rasterWidth, rasterHeight } = request;
  const cells = gridWidth * gridHeight;

  // Coasts used to be part of the claim field itself: water carried a claim,
  // the blur smeared it into the shore, and the land-water line came out as
  // soft as any contested border. Land-versus-water is a fact, not a contest,
  // so it now comes from this mask sampled bilinearly and cut at one half --
  // a crisp, anti-aliased coastline however far the raster is upscaled --
  // while the blurred claims decide only whose banner the land flies.
  const landMask = new Float32Array(cells);
  for (let index = 0; index < cells; index += 1) {
    landMask[index] = request.terrains[index] === WATER_TERRAIN ? 0 : 1;
  }
  // One gentle smoothing pass rounds the bilinear contour's 45-degree
  // chamfers into curves. It is light enough that a single-cell river channel
  // stays below the waterline (0.6 * 0 + 0.4 * 6/8 = 0.3), so no waterway is
  // ever smoothed shut.
  {
    const smoothed = new Float32Array(cells);
    for (let y = 0; y < gridHeight; y += 1) {
      for (let x = 0; x < gridWidth; x += 1) {
        const index = y * gridWidth + x;
        let sum = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          const ny = y + oy;
          if (ny < 0 || ny >= gridHeight) continue;
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox;
            if (nx < 0 || nx >= gridWidth || (ox === 0 && oy === 0)) continue;
            sum += landMask[ny * gridWidth + nx]!;
            count += 1;
          }
        }
        smoothed[index] = landMask[index]! * 0.6 + (count > 0 ? sum / count : landMask[index]!) * 0.4;
      }
    }
    landMask.set(smoothed);
  }

  // Two claims per land cell: who holds it, and who is pressing it.
  const rawIds = new Int16Array(cells * 2).fill(-1);
  const rawWeights = new Float32Array(cells * 2);
  for (let index = 0; index < request.owners.length; index += 1) {
    if (request.terrains[index] === WATER_TERRAIN) continue;
    const owner = fieldIndex(request.owners[index]!);
    const pressureOwner = request.pressureOwners[index]!;
    const pressure = pressureOwner >= 0 && pressureOwner !== request.owners[index]
      ? Math.max(0, Math.min(1, request.pressures[index]!))
      : 0;
    rawIds[index * 2] = owner;
    rawWeights[index * 2] = 1 - pressure;
    if (pressure > 0) {
      rawIds[index * 2 + 1] = fieldIndex(pressureOwner);
      rawWeights[index * 2 + 1] = pressure;
    }
  }

  const claims = blurClaims(rawIds, rawWeights, gridWidth, gridHeight);
  // Every fill pixel is written below; only the borders need a clean slate.
  const fill = leasePixels(rasterWidth * rasterHeight * 4, false);
  const borders = leasePixels(fill.length, true);
  // The bilinear corners, unrolled: this loop runs per raster pixel, and at
  // the sharper raster an object allocation per pixel is real GC pressure.
  const cornerCells = new Int32Array(4);
  const cornerShares = new Float64Array(4);
  // The union of the four corners' claims, rebuilt only when the pixel walk
  // crosses into a new cell quad. Deduplicating per pixel was the dominant
  // cost of the sharper raster; within a quad the id set never changes, only
  // the bilinear shares do, so each pixel is a few multiplies per claim.
  const quadIds = new Int16Array(CLAIMS_PER_CELL * 4);
  const quadWeights = new Float64Array(CLAIMS_PER_CELL * 4 * 4);
  let quadCount = 0;
  const water = rgb(TERRAIN_RULES.water.fill);
  const shore = rgb("#8fbcc4");
  const coastLine = { red: 20, green: 34, blue: 39 };
  const shoreline = mix(water, shore, 0.45);

  // Per-pixel color math ran through rgb()'s string-keyed cache and mix()'s
  // fresh object per call -- at the sharper raster that was over a million
  // allocations a frame. Everything is precomputed here into flat channel
  // tables: terrain fills by terrain index, each realm's overlay color and
  // blend strength by claim field, water by depth step. The terrain tint is
  // then blended bilinearly across the land corners of the sample -- colors,
  // never categories -- so the ground fades between biomes as smoothly as the
  // old low raster's upscale did, while coasts and borders stay sharp.
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
  for (let field = 0; field < fieldCount; field += 1) {
    const color = field < RASTER_PLAYER_ORDER.length
      ? rgb(PLAYERS[RASTER_PLAYER_ORDER[field]!]!.color)
      : rgb("#d8cfb1");
    overlayLut[field * 3] = color.red;
    overlayLut[field * 3 + 1] = color.green;
    overlayLut[field * 3 + 2] = color.blue;
    overlayAmount[field] = field < RASTER_PLAYER_ORDER.length ? 0.66 : 0.16;
  }
  const WATER_STEPS = 48;
  const waterLut = new Uint8ClampedArray(WATER_STEPS * 3);
  for (let step = 0; step < WATER_STEPS; step += 1) {
    const color = mix(water, shore, (step / (WATER_STEPS - 1)) * 0.45);
    waterLut[step * 3] = color.red;
    waterLut[step * 3 + 1] = color.green;
    waterLut[step * 3 + 2] = color.blue;
  }

  // Horizontal sampling depends only on the column, so the floor/clamp chain
  // runs once per column instead of once per pixel.
  const colX0 = new Int32Array(rasterWidth);
  const colX1 = new Int32Array(rasterWidth);
  const colTx = new Float64Array(rasterWidth);
  const colNearest = new Int32Array(rasterWidth);
  for (let px = 0; px < rasterWidth; px += 1) {
    const gridX = ((px + 0.5) / rasterWidth) * gridWidth - 0.5;
    const floorX = Math.floor(gridX);
    colX0[px] = Math.max(0, Math.min(gridWidth - 1, floorX));
    colX1[px] = Math.min(gridWidth - 1, colX0[px]! + 1);
    colTx[px] = Math.max(0, Math.min(1, gridX - floorX));
    colNearest[px] = Math.max(0, Math.min(gridWidth - 1, Math.round(gridX)));
  }

  for (let py = 0; py < rasterHeight; py += 1) {
    const gridY = ((py + 0.5) / rasterHeight) * gridHeight - 0.5;
    const floorY = Math.floor(gridY);
    const y0 = Math.max(0, Math.min(gridHeight - 1, floorY));
    const y1 = Math.min(gridHeight - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, gridY - floorY));
    const nearestY = Math.max(0, Math.min(gridHeight - 1, Math.round(gridY)));
    const rowTop = y0 * gridWidth;
    const rowBottom = y1 * gridWidth;
    const nearestRow = nearestY * gridWidth;
    let quadX = -1;
    for (let px = 0; px < rasterWidth; px += 1) {
      const x0 = colX0[px]!;
      const x1 = colX1[px]!;
      const tx = colTx[px]!;

      cornerCells[0] = rowTop + x0;
      cornerShares[0] = (1 - tx) * (1 - ty);
      cornerCells[1] = rowTop + x1;
      cornerShares[1] = tx * (1 - ty);
      cornerCells[2] = rowBottom + x0;
      cornerShares[2] = (1 - tx) * ty;
      cornerCells[3] = rowBottom + x1;
      cornerShares[3] = tx * ty;

      const landFraction =
        landMask[cornerCells[0]!]! * cornerShares[0]! +
        landMask[cornerCells[1]!]! * cornerShares[1]! +
        landMask[cornerCells[2]!]! * cornerShares[2]! +
        landMask[cornerCells[3]!]! * cornerShares[3]!;
      const pixel = (py * rasterWidth + px) * 4;

      // The coastline itself: one dark stroke exactly on the half contour,
      // drawn into the border layer so it sits above the fill like the
      // political lines do.
      const coastDepth = Math.abs(landFraction - 0.5);
      if (coastDepth < COAST_BAND) {
        const alpha = 0.9 * (1 - coastDepth / COAST_BAND);
        borders[pixel] = coastLine.red;
        borders[pixel + 1] = coastLine.green;
        borders[pixel + 2] = coastLine.blue;
        borders[pixel + 3] = Math.round(alpha * 255);
      }

      if (landFraction < 0.5) {
        // Open water: no claims to weigh. Shallows brighten toward the shore
        // so the coast reads as a beach line rather than a paint boundary.
        const shallow = Math.max(0, Math.min(1, landFraction / 0.5));
        const at = Math.round(shallow * (WATER_STEPS - 1)) * 3;
        fill[pixel] = waterLut[at]!;
        fill[pixel + 1] = waterLut[at + 1]!;
        fill[pixel + 2] = waterLut[at + 2]!;
        fill[pixel + 3] = 255;
        continue;
      }

      // Rebuilt lazily so runs of open water never pay for it.
      if (x0 !== quadX) {
        quadX = x0;
        quadCount = 0;
        quadWeights.fill(0, 0, CLAIMS_PER_CELL * 4 * 4);
        for (let corner = 0; corner < 4; corner += 1) {
          const base = cornerCells[corner]! * CLAIMS_PER_CELL;
          for (let slot = 0; slot < CLAIMS_PER_CELL; slot += 1) {
            const id = claims.ids[base + slot]!;
            if (id < 0) break;
            let at = -1;
            for (let e = 0; e < quadCount; e += 1) {
              if (quadIds[e] === id) { at = e; break; }
            }
            if (at < 0) { at = quadCount; quadIds[at] = id; quadCount += 1; }
            quadWeights[at * 4 + corner]! += claims.weights[base + slot]!;
          }
        }
      }

      let totalWeight = 0;
      let first = -1;
      let firstValue = 0;
      let second = -1;
      let secondValue = 0;
      for (let e = 0; e < quadCount; e += 1) {
        const row = e * 4;
        const value =
          quadWeights[row]! * cornerShares[0]! +
          quadWeights[row + 1]! * cornerShares[1]! +
          quadWeights[row + 2]! * cornerShares[2]! +
          quadWeights[row + 3]! * cornerShares[3]!;
        if (value <= 0) continue;
        totalWeight += value;
        if (first < 0 || value > firstValue) {
          second = first; secondValue = firstValue;
          first = quadIds[e]!; firstValue = value;
        } else if (second < 0 || value > secondValue) {
          second = quadIds[e]!; secondValue = value;
        }
      }
      // Terrain tint blended over the land corners of the sample; water
      // corners are excluded and the shares renormalized, so a coastal pixel
      // never borrows the sea's color -- that smudge is exactly what this
      // pass exists to remove.
      let terrainRed = 0;
      let terrainGreen = 0;
      let terrainBlue = 0;
      let terrainShare = 0;
      for (let corner = 0; corner < 4; corner += 1) {
        const cellIndex = cornerCells[corner]!;
        if (request.terrains[cellIndex] === WATER_TERRAIN) continue;
        const share = cornerShares[corner]!;
        const at = request.terrains[cellIndex]! * 3;
        terrainRed += terrainLut[at]! * share;
        terrainGreen += terrainLut[at + 1]! * share;
        terrainBlue += terrainLut[at + 2]! * share;
        terrainShare += share;
      }
      if (terrainShare > 0) {
        terrainRed /= terrainShare;
        terrainGreen /= terrainShare;
        terrainBlue /= terrainShare;
      } else {
        const at = request.terrains[nearestRow + colNearest[px]!]! * 3;
        terrainRed = terrainLut[at]!;
        terrainGreen = terrainLut[at + 1]!;
        terrainBlue = terrainLut[at + 2]!;
      }
      const field = first >= 0 && first < RASTER_PLAYER_ORDER.length ? first : NEUTRAL_FIELD;
      const amount = field === request.selected ? 0.76 : overlayAmount[field]!;
      const overlayBase = field * 3;
      let red = Math.round(terrainRed + (overlayLut[overlayBase]! - terrainRed) * amount);
      let green = Math.round(terrainGreen + (overlayLut[overlayBase + 1]! - terrainGreen) * amount);
      let blue = Math.round(terrainBlue + (overlayLut[overlayBase + 2]! - terrainBlue) * amount);
      // Anti-alias the last sliver of shoreline into the water color.
      if (landFraction < 0.5 + COAST_AA) {
        const blend = (landFraction - 0.5) / COAST_AA;
        red = Math.round(shoreline.red + (red - shoreline.red) * blend);
        green = Math.round(shoreline.green + (green - shoreline.green) * blend);
        blue = Math.round(shoreline.blue + (blue - shoreline.blue) * blend);
      }
      fill[pixel] = red;
      fill[pixel + 1] = green;
      fill[pixel + 2] = blue;
      fill[pixel + 3] = 255;

      if (second < 0) continue;
      // Weights are normalized before the border thresholds read them: near a
      // coast the water cells contribute no claims, and without this the
      // thinner total made every shoreline border read as contested. Deferred
      // to here so interior pixels skip the divisions.
      if (totalWeight > 0) {
        firstValue /= totalWeight;
        secondValue /= totalWeight;
      }
      if (secondValue < 0.055) continue;
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
      if (borders[pixel + 3]! < Math.round(alpha * 255)) {
        borders[pixel] = line.red;
        borders[pixel + 1] = line.green;
        borders[pixel + 2] = line.blue;
        borders[pixel + 3] = Math.round(alpha * 255);
      }
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
  const fill = leasePixels(rasterWidth * rasterHeight * 4, false);
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

self.addEventListener("message", (event: MessageEvent<MapRasterWorkerMessage>) => {
  if (event.data.type === "recycle") {
    for (const buffer of event.data.buffers) {
      if (BUFFER_POOL.length >= BUFFER_POOL_LIMIT) break;
      if (buffer.byteLength > 0) BUFFER_POOL.push(buffer);
    }
    return;
  }
  const result = event.data.mode === "political"
    ? renderPolitical(event.data)
    : renderTheaters(event.data);
  const transfer = result.borders
    ? [result.fill.buffer, result.borders.buffer]
    : [result.fill.buffer];
  self.postMessage(result, { transfer });
});
