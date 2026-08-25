/// <reference lib="webworker" />

import { ELEMENTS } from "./elements";
import { TERRAIN_RULES } from "./rules";
import {
  RASTER_ELEMENT_ORDER,
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
const NEUTRAL_FIELD = RASTER_ELEMENT_ORDER.length;
const WATER_FIELD = RASTER_ELEMENT_ORDER.length + 1;

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

function blurOwnershipField(source: Float32Array, width: number, height: number): Float32Array {
  const channels = RASTER_ELEMENT_ORDER.length + 2;
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const left = (y * width + Math.max(0, x - 1)) * channels + channel;
        const center = (y * width + x) * channels + channel;
        const right = (y * width + Math.min(width - 1, x + 1)) * channels + channel;
        horizontal[center] = (source[left]! + source[center]! * 2 + source[right]!) / 4;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const top = (Math.max(0, y - 1) * width + x) * channels + channel;
        const center = (y * width + x) * channels + channel;
        const bottom = (Math.min(height - 1, y + 1) * width + x) * channels + channel;
        output[center] = (horizontal[top]! + horizontal[center]! * 2 + horizontal[bottom]!) / 4;
      }
    }
  }
  return output;
}

function fieldIndex(owner: number, terrain: number): number {
  if (owner >= 0) return owner;
  return RASTER_TERRAIN_ORDER[terrain] === "water" ? WATER_FIELD : NEUTRAL_FIELD;
}

function renderPolitical(request: PoliticalRasterRequest): MapRasterResult {
  const { gridWidth, gridHeight, rasterWidth, rasterHeight } = request;
  const channels = RASTER_ELEMENT_ORDER.length + 2;
  const raw = new Float32Array(gridWidth * gridHeight * channels);
  for (let index = 0; index < request.owners.length; index += 1) {
    const owner = fieldIndex(request.owners[index]!, request.terrains[index]!);
    const pressureOwner = request.pressureOwners[index]!;
    const pressure = pressureOwner >= 0 && pressureOwner !== request.owners[index]
      ? Math.max(0, Math.min(1, request.pressures[index]!))
      : 0;
    raw[index * channels + owner] = 1 - pressure;
    if (pressure > 0) raw[index * channels + fieldIndex(pressureOwner, request.terrains[index]!)] = pressure;
  }
  const scores = blurOwnershipField(raw, gridWidth, gridHeight);
  const fill = new Uint8ClampedArray(rasterWidth * rasterHeight * 4);
  const borders = new Uint8ClampedArray(fill.length);
  const sampled = new Float32Array(channels);

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
      let first = -1;
      let second = -1;
      for (let channel = 0; channel < channels; channel += 1) {
        const topLeft = scores[(y0 * gridWidth + x0) * channels + channel]!;
        const topRight = scores[(y0 * gridWidth + x1) * channels + channel]!;
        const bottomLeft = scores[(y1 * gridWidth + x0) * channels + channel]!;
        const bottomRight = scores[(y1 * gridWidth + x1) * channels + channel]!;
        sampled[channel] =
          (topLeft + (topRight - topLeft) * tx) * (1 - ty)
          + (bottomLeft + (bottomRight - bottomLeft) * tx) * ty;
        if (first < 0 || sampled[channel]! > sampled[first]!) {
          second = first;
          first = channel;
        } else if (second < 0 || sampled[channel]! > sampled[second]!) {
          second = channel;
        }
      }

      const nearestX = Math.max(0, Math.min(gridWidth - 1, Math.round(gridX)));
      const nearestY = Math.max(0, Math.min(gridHeight - 1, Math.round(gridY)));
      const terrainId = RASTER_TERRAIN_ORDER[request.terrains[nearestY * gridWidth + nearestX]!]!;
      const winner = first < RASTER_ELEMENT_ORDER.length ? RASTER_ELEMENT_ORDER[first]! : null;
      const terrain = rgb(TERRAIN_RULES[first === WATER_FIELD ? "water" : terrainId].fill);
      const fillColor = winner
        ? mix(terrain, rgb(ELEMENTS[winner].color), first === request.selected ? 0.76 : 0.66)
        : first === NEUTRAL_FIELD
          ? mix(terrain, rgb("#d8cfb1"), 0.16)
          : terrain;
      const pixel = (py * rasterWidth + px) * 4;
      fill[pixel] = fillColor.red;
      fill[pixel + 1] = fillColor.green;
      fill[pixel + 2] = fillColor.blue;
      fill[pixel + 3] = 255;

      if (second < 0 || sampled[second]! < 0.055) continue;
      const gap = sampled[first]! - sampled[second]!;
      const strength = Math.max(0, Math.min(1, 1 - gap / 0.25));
      if (strength <= 0) continue;
      const firstOwner = first < RASTER_ELEMENT_ORDER.length ? first : -1;
      const secondOwner = second < RASTER_ELEMENT_ORDER.length ? second : -1;
      const core = gap <= 0.16;
      const atWar = firstOwner >= 0 && secondOwner >= 0
        ? request.warMatrix[firstOwner * RASTER_ELEMENT_ORDER.length + secondOwner] === 1
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
