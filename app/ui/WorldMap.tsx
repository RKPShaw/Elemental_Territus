"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getRelation } from "../game/diplomacy";
import { ELEMENT_ORDER, ELEMENTS } from "../game/elements";
import {
  cellCoordinates,
  frontTargets,
  neighborIndices,
  structureCells,
  surroundingIndices,
} from "../game/grid";
import {
  STRUCTURE_RULES,
  TERRAIN_RULES,
  compactNumber,
} from "../game/rules";
import {
  THEATER_LAYER_LABELS,
  evaluateTheaterCellMaps,
} from "../game/theater-intelligence";
import type { TheaterCellMaps, TheaterIntelligence, TheaterLayer } from "../game/theater-intelligence";
import {
  RASTER_ELEMENT_ORDER,
  RASTER_TERRAIN_ORDER,
} from "../game/map-raster-protocol";
import type { MapRasterRequest, MapRasterResult } from "../game/map-raster-protocol";
import type { ElementId, WorldState } from "../game/types";
import { isValidWaterPath } from "../game/water-navigation";

export type MapMode = "political" | "theaters";

interface WorldMapProps {
  state: WorldState;
  selected: ElementId;
  onSelect: (element: ElementId) => void;
  showAllTheaters?: boolean;
  renderMarker?: string;
  mapMode?: MapMode;
  theaterLayer?: TheaterLayer;
  playbackTicksPerSecond?: number;
}

interface MapGeometry {
  cellWidth: number;
  cellHeight: number;
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

const COLOR_CACHE = new Map<string, RgbColor>();

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

// Two raster pixels per authoritative cell preserve curved frontiers while
// keeping snapshot work short enough for the 60 Hz display loop.
const STATIC_FIELD_GRID_SCALE = 2;

function geometry(state: WorldState, canvas: HTMLCanvasElement): MapGeometry {
  return {
    cellWidth: canvas.width / state.config.width,
    cellHeight: canvas.height / state.config.height,
  };
}

function centerFor(index: number, state: WorldState, shape: MapGeometry): [number, number] {
  const [x, y] = cellCoordinates(index, state.config.width);
  return [(x + 0.5) * shape.cellWidth, (y + 0.5) * shape.cellHeight];
}

function drawTerrainTexture(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  index: number,
) {
  const cell = state.cells[index]!;
  if ((index * 17 + state.seed) % 197 !== 0) return;
  const [x, y] = centerFor(index, state, shape);
  const radius = Math.min(shape.cellWidth, shape.cellHeight);
  context.save();
  context.strokeStyle = "rgba(25, 43, 48, 0.18)";
  context.fillStyle = "rgba(255, 248, 219, 0.28)";
  context.lineWidth = 0.8;
  if (cell.terrain === "water") {
    context.beginPath();
    context.moveTo(x - radius * 0.35, y);
    context.quadraticCurveTo(x, y - radius * 0.2, x + radius * 0.35, y);
    context.stroke();
  } else if (cell.terrain === "forest") {
    context.beginPath();
    context.moveTo(x, y - radius * 0.34);
    context.lineTo(x - radius * 0.26, y + radius * 0.24);
    context.lineTo(x + radius * 0.26, y + radius * 0.24);
    context.closePath();
    context.fill();
  } else if (cell.terrain === "mountains" || cell.terrain === "hills") {
    context.beginPath();
    context.moveTo(x - radius * 0.33, y + radius * 0.22);
    context.lineTo(x, y - radius * 0.3);
    context.lineTo(x + radius * 0.35, y + radius * 0.22);
    context.stroke();
  } else if (cell.terrain === "farmland") {
    context.beginPath();
    context.moveTo(x - radius * 0.3, y - radius * 0.2);
    context.lineTo(x + radius * 0.3, y + radius * 0.2);
    context.moveTo(x - radius * 0.3, y + radius * 0.12);
    context.lineTo(x + radius * 0.12, y + radius * 0.32);
    context.stroke();
  }
  context.restore();
}

const NEUTRAL_FIELD = ELEMENT_ORDER.length;
const WATER_FIELD = ELEMENT_ORDER.length + 1;

interface PoliticalField {
  fill: HTMLCanvasElement;
  borders: HTMLCanvasElement;
}

const CAMPAIGN_LABEL_POSITIONS = new Map<string, { x: number; y: number }>();

function fieldIndex(owner: ElementId | null, terrain: WorldState["cells"][number]["terrain"]): number {
  if (owner) return ELEMENT_ORDER.indexOf(owner);
  return terrain === "water" ? WATER_FIELD : NEUTRAL_FIELD;
}

function blurOwnershipField(source: Float32Array, width: number, height: number): Float32Array {
  const channels = ELEMENT_ORDER.length + 2;
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

function renderPoliticalField(
  state: WorldState,
  selected: ElementId,
  rasterWidth: number,
  rasterHeight: number,
): PoliticalField {
  const { width, height } = state.config;
  const channels = ELEMENT_ORDER.length + 2;
  const raw = new Float32Array(width * height * channels);
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    const owner = fieldIndex(cell.owner, cell.terrain);
    const pressure = cell.pressureBy && cell.pressureBy !== cell.owner
      ? Math.max(0, Math.min(1, cell.pressure))
      : 0;
    raw[index * channels + owner] = 1 - pressure;
    if (pressure > 0) raw[index * channels + fieldIndex(cell.pressureBy, cell.terrain)] = pressure;
  }
  const scores = blurOwnershipField(raw, width, height);
  const fill = document.createElement("canvas");
  const borders = document.createElement("canvas");
  fill.width = borders.width = rasterWidth;
  fill.height = borders.height = rasterHeight;
  const fillContext = fill.getContext("2d");
  const borderContext = borders.getContext("2d");
  if (!fillContext || !borderContext) return { fill, borders };
  const fillImage = fillContext.createImageData(rasterWidth, rasterHeight);
  const borderImage = borderContext.createImageData(rasterWidth, rasterHeight);
  const sampled = new Float32Array(channels);

  for (let py = 0; py < rasterHeight; py += 1) {
    const gridY = ((py + 0.5) / rasterHeight) * height - 0.5;
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(gridY)));
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, gridY - Math.floor(gridY)));
    for (let px = 0; px < rasterWidth; px += 1) {
      const gridX = ((px + 0.5) / rasterWidth) * width - 0.5;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(gridX)));
      const x1 = Math.min(width - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, gridX - Math.floor(gridX)));
      let first = -1;
      let second = -1;
      for (let channel = 0; channel < channels; channel += 1) {
        const topLeft = scores[(y0 * width + x0) * channels + channel]!;
        const topRight = scores[(y0 * width + x1) * channels + channel]!;
        const bottomLeft = scores[(y1 * width + x0) * channels + channel]!;
        const bottomRight = scores[(y1 * width + x1) * channels + channel]!;
        sampled[channel] =
          (topLeft + (topRight - topLeft) * tx) * (1 - ty) +
          (bottomLeft + (bottomRight - bottomLeft) * tx) * ty;
        if (first < 0 || sampled[channel]! > sampled[first]!) {
          second = first;
          first = channel;
        } else if (second < 0 || sampled[channel]! > sampled[second]!) {
          second = channel;
        }
      }

      const nearestX = Math.max(0, Math.min(width - 1, Math.round(gridX)));
      const nearestY = Math.max(0, Math.min(height - 1, Math.round(gridY)));
      const nearestCell = state.cells[nearestY * width + nearestX]!;
      const winner = first < ELEMENT_ORDER.length ? ELEMENT_ORDER[first]! : null;
      const terrain = rgb(TERRAIN_RULES[first === WATER_FIELD ? "water" : nearestCell.terrain].fill);
      const fillColor = winner
        ? mix(terrain, rgb(ELEMENTS[winner].color), winner === selected ? 0.76 : 0.66)
        : first === NEUTRAL_FIELD
          ? mix(terrain, rgb("#d8cfb1"), 0.16)
          : terrain;
      const pixel = (py * rasterWidth + px) * 4;
      fillImage.data[pixel] = fillColor.red;
      fillImage.data[pixel + 1] = fillColor.green;
      fillImage.data[pixel + 2] = fillColor.blue;
      fillImage.data[pixel + 3] = 255;

      if (second < 0 || sampled[second]! < 0.055) continue;
      const gap = sampled[first]! - sampled[second]!;
      const strength = Math.max(0, Math.min(1, 1 - gap / 0.25));
      if (strength <= 0) continue;
      const firstOwner = first < ELEMENT_ORDER.length ? ELEMENT_ORDER[first]! : null;
      const secondOwner = second < ELEMENT_ORDER.length ? ELEMENT_ORDER[second]! : null;
      const core = gap <= 0.16;
      const atWar = firstOwner && secondOwner
        ? getRelation(state, firstOwner, secondOwner).status === "war"
        : false;
      const line = core
        ? { red: 12, green: 16, blue: 18 }
        : atWar
          ? { red: 145, green: 55, blue: 58 }
          : { red: 12, green: 16, blue: 18 };
      // The opaque core makes every frontier unmistakable. At half-resolution
      // it becomes a smooth, two-display-pixel frontier after compositing.
      const alpha = core ? 1 : Math.pow(strength, 0.72) * (atWar ? 0.9 : 0.78);
      borderImage.data[pixel] = line.red;
      borderImage.data[pixel + 1] = line.green;
      borderImage.data[pixel + 2] = line.blue;
      borderImage.data[pixel + 3] = Math.round(alpha * 255);
    }
  }
  fillContext.putImageData(fillImage, 0, 0);
  borderContext.putImageData(borderImage, 0, 0);
  return { fill, borders };
}

function theaterHeat(value: number): RgbColor {
  const red = rgb("#d65a52");
  const middle = rgb("#dfbc55");
  const green = rgb("#4ba56f");
  if (value <= 0.5) return mix(red, middle, value * 2);
  return mix(middle, green, (value - 0.5) * 2);
}

function addRegionCandidate(
  ids: Int16Array,
  weights: Float32Array,
  count: number,
  regionId: number,
  weight: number,
): number {
  for (let candidate = 0; candidate < count; candidate += 1) {
    if (ids[candidate] !== regionId) continue;
    weights[candidate] += weight;
    return count;
  }
  ids[count] = regionId;
  weights[count] = weight;
  return count + 1;
}

function renderTheaterField(
  state: WorldState,
  evaluations: readonly TheaterIntelligence[],
  rasterWidth: number,
  rasterHeight: number,
): HTMLCanvasElement {
  const { width, height } = state.config;
  const values = new Map(evaluations.map((evaluation) => [evaluation.regionId, evaluation.normalizedValue]));
  const layer = document.createElement("canvas");
  layer.width = rasterWidth;
  layer.height = rasterHeight;
  const context = layer.getContext("2d");
  if (!context) return layer;
  const image = context.createImageData(rasterWidth, rasterHeight);
  const candidateIds = new Int16Array(4);
  const candidateWeights = new Float32Array(4);

  for (let py = 0; py < rasterHeight; py += 1) {
    const gridY = ((py + 0.5) / rasterHeight) * height - 0.5;
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(gridY)));
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, gridY - Math.floor(gridY)));
    for (let px = 0; px < rasterWidth; px += 1) {
      const gridX = ((px + 0.5) / rasterWidth) * width - 0.5;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(gridX)));
      const x1 = Math.min(width - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, gridX - Math.floor(gridX)));
      candidateIds.fill(-2);
      candidateWeights.fill(0);
      let candidateCount = 0;
      candidateCount = addRegionCandidate(candidateIds, candidateWeights, candidateCount, state.regionByCell[y0 * width + x0]!, (1 - tx) * (1 - ty));
      candidateCount = addRegionCandidate(candidateIds, candidateWeights, candidateCount, state.regionByCell[y0 * width + x1]!, tx * (1 - ty));
      candidateCount = addRegionCandidate(candidateIds, candidateWeights, candidateCount, state.regionByCell[y1 * width + x0]!, (1 - tx) * ty);
      candidateCount = addRegionCandidate(candidateIds, candidateWeights, candidateCount, state.regionByCell[y1 * width + x1]!, tx * ty);
      let winner = -1;
      let winnerWeight = -1;
      let runnerUp = -1;
      let runnerUpWeight = -1;
      for (let candidate = 0; candidate < candidateCount; candidate += 1) {
        const weight = candidateWeights[candidate]!;
        if (weight > winnerWeight) {
          runnerUp = winner;
          runnerUpWeight = winnerWeight;
          winner = candidateIds[candidate]!;
          winnerWeight = weight;
        } else if (weight > runnerUpWeight) {
          runnerUp = candidateIds[candidate]!;
          runnerUpWeight = weight;
        }
      }
      const nearestX = Math.max(0, Math.min(width - 1, Math.round(gridX)));
      const nearestY = Math.max(0, Math.min(height - 1, Math.round(gridY)));
      const nearestCell = state.cells[nearestY * width + nearestX]!;
      const neutralTerrain = rgb(nearestCell.terrain === "water" ? TERRAIN_RULES.water.fill : "#e4dcc6");
      const fillColor = winner < 0
        ? neutralTerrain
        : mix(neutralTerrain, theaterHeat(values.get(winner) ?? 0), 0.84);
      const pixel = (py * rasterWidth + px) * 4;
      image.data[pixel] = fillColor.red;
      image.data[pixel + 1] = fillColor.green;
      image.data[pixel + 2] = fillColor.blue;
      image.data[pixel + 3] = 255;

      if (runnerUp === winner || runnerUpWeight <= 0) continue;
      const gap = winnerWeight - runnerUpWeight;
      if (gap > 0.24) continue;
      const alpha = Math.max(0.35, 1 - gap / 0.24);
      const borderColor = mix(fillColor, { red: 13, green: 18, blue: 20 }, alpha);
      image.data[pixel] = borderColor.red;
      image.data[pixel + 1] = borderColor.green;
      image.data[pixel + 2] = borderColor.blue;
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return layer;
}

function drawTheaterLabels(
  context: CanvasRenderingContext2D,
  state: WorldState,
  evaluations: readonly TheaterIntelligence[],
  shape: MapGeometry,
): void {
  const scores = new Map(evaluations.map((evaluation) => [evaluation.regionId, evaluation.score]));
  context.save();
  context.font = "900 8px ui-rounded, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const region of state.strategicRegions) {
    const [x, y] = centerFor(region.centroidIndex, state, shape);
    const label = String(scores.get(region.id) ?? 0);
    const labelWidth = context.measureText(label).width + 7;
    context.fillStyle = "rgba(15, 23, 24, 0.72)";
    context.beginPath();
    context.roundRect(x - labelWidth / 2, y - 6, labelWidth, 12, 5);
    context.fill();
    context.fillStyle = "#fff8df";
    context.fillText(label, x, y + 0.4);
  }
  context.restore();
}

function drawFieldLayer(
  context: CanvasRenderingContext2D,
  layer: HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  smoothing = false,
) {
  context.save();
  context.imageSmoothingEnabled = smoothing;
  if (smoothing) context.imageSmoothingQuality = "high";
  context.drawImage(layer, 0, 0, canvas.width, canvas.height);
  context.restore();
}

function drawStructure(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  index: number,
) {
  const cell = state.cells[index]!;
  if (!cell.structure || !cell.owner) return;
  const [x, y] = centerFor(index, state, shape);
  const element = ELEMENTS[cell.owner];
  const radius = Math.max(5, Math.min(shape.cellWidth, shape.cellHeight) * 0.63);
  context.save();
  context.shadowColor = "rgba(14, 27, 35, 0.28)";
  context.shadowBlur = 4;
  context.fillStyle = cell.capitalOf ? element.deepColor : "rgba(255, 249, 226, 0.94)";
  context.strokeStyle = element.deepColor;
  context.lineWidth = 1.3;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.shadowColor = "transparent";
  context.fillStyle = cell.capitalOf ? "#fff5d9" : element.deepColor;
  context.font = `800 ${Math.max(8, radius * 1.05)}px ui-rounded, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    cell.capitalOf ? element.glyph : STRUCTURE_RULES[cell.structure].glyph,
    x,
    y + 0.3,
  );
  if (cell.structure === "city" && cell.structureLevel > 1) {
    context.fillStyle = element.deepColor;
    context.strokeStyle = "rgba(255, 249, 226, 0.98)";
    context.lineWidth = 2.5;
    context.font = `900 ${Math.max(7, radius * 0.7)}px ui-rounded, sans-serif`;
    context.strokeText(String(cell.structureLevel), x + radius * 0.72, y + radius * 0.72);
    context.fillText(String(cell.structureLevel), x + radius * 0.72, y + radius * 0.72);
  }
  context.restore();
}

function drawTradeRoutes(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
) {
  context.save();
  context.setLineDash([5, 5]);
  context.lineCap = "round";
  for (const route of state.tradeRoutes) {
    if (route.kind === "sea") continue;
    const path = route.pathIndices.length > 1
      ? route.pathIndices
      : [route.startIndex, route.endIndex];
    const [sx, sy] = centerFor(path[0]!, state, shape);
    context.strokeStyle = "rgba(255, 236, 169, 0.72)";
    context.lineWidth = 1.35;
    context.beginPath();
    context.moveTo(sx, sy);
    for (const index of path.slice(1)) {
      const [x, y] = centerFor(index, state, shape);
      context.lineTo(x, y);
    }
    context.stroke();
  }
  context.restore();
}

function drawTradeVehicles(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  extrapolatedTicks = 0,
) {
  for (const vehicle of state.tradeVehicles) {
    const path = vehicle.pathIndices.length > 1
      ? vehicle.pathIndices
      : [vehicle.startIndex, vehicle.endIndex];
    if (path.length < 2) continue;
    if (vehicle.kind === "ship" && !isValidWaterPath(state, path)) continue;
    const points = path.map((index) => centerFor(index, state, shape));
    const lengths: number[] = [];
    let totalLength = 0;
    for (let index = 1; index < points.length; index += 1) {
      const length = Math.hypot(
        points[index]![0] - points[index - 1]![0],
        points[index]![1] - points[index - 1]![1],
      );
      lengths.push(length);
      totalLength += length;
    }
    const visualDistance = vehicle.dwellRemaining > 0
      ? vehicle.distanceTravelled
      : Math.min(vehicle.totalDistance, vehicle.distanceTravelled + vehicle.velocity * extrapolatedTicks);
    const visualProgress = vehicle.totalDistance > 0 ? visualDistance / vehicle.totalDistance : vehicle.progress;
    const targetDistance = Math.min(0.9999, visualProgress) * totalLength;
    let segment = 0;
    let distanceBefore = 0;
    while (segment < lengths.length - 1 && distanceBefore + lengths[segment]! < targetDistance) {
      distanceBefore += lengths[segment]!;
      segment += 1;
    }
    const local = lengths[segment]! > 0
      ? (targetDistance - distanceBefore) / lengths[segment]!
      : 0;
    const [sx, sy] = points[segment]!;
    const [ex, ey] = points[segment + 1]!;
    const x = sx + (ex - sx) * local;
    const y = sy + (ey - sy) * local;
    const angle = Math.atan2(ey - sy, ex - sx);
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.fillStyle = ELEMENTS[vehicle.owner].deepColor;
    context.strokeStyle = "rgba(255,250,226,.95)";
    context.lineWidth = 1;
    context.beginPath();
    if (vehicle.kind === "train") context.roundRect(-5, -3, 10, 6, 2);
    else {
      context.moveTo(6, 0);
      context.lineTo(-4, -3.5);
      context.lineTo(-2, 3.5);
      context.closePath();
    }
    context.fill();
    context.stroke();
    context.restore();
  }
}

function allianceBorderAnchors(
  state: WorldState,
  first: ElementId,
  second: ElementId,
  shape: MapGeometry,
): Array<[number, number]> {
  const targets = frontTargets(state, first, second);
  const remaining = new Set(targets);
  const anchors: Array<[number, number]> = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as number;
    remaining.delete(seed);
    const component = [seed];
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      for (const neighbor of surroundingIndices(
        component[cursor]!,
        state.config.width,
        state.config.height,
      )) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        component.push(neighbor);
      }
    }
    const midpoints: Array<[number, number]> = [];
    for (const target of component) {
      const [tx, ty] = centerFor(target, state, shape);
      for (const neighbor of neighborIndices(target, state.config.width, state.config.height)) {
        if (state.cells[neighbor]!.owner !== first) continue;
        const [ax, ay] = centerFor(neighbor, state, shape);
        midpoints.push([(tx + ax) / 2, (ty + ay) / 2]);
      }
    }
    if (midpoints.length === 0) continue;
    anchors.push([
      midpoints.reduce((sum, point) => sum + point[0], 0) / midpoints.length,
      midpoints.reduce((sum, point) => sum + point[1], 0) / midpoints.length,
    ]);
  }
  return anchors;
}

function drawAllianceChains(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
) {
  const drawLink = (x: number, y: number, offset: number, angle: number) => {
    context.save();
    context.translate(x + offset, y);
    context.rotate(angle);
    context.beginPath();
    context.roundRect(-6, -3.2, 12, 6.4, 3.2);
    context.strokeStyle = "rgba(8, 18, 19, 0.88)";
    context.lineWidth = 5;
    context.stroke();
    context.strokeStyle = "#62c889";
    context.lineWidth = 2.6;
    context.stroke();
    context.restore();
  };
  for (const relation of Object.values(state.relations)) {
    if (relation.status !== "truce") continue;
    const [first, second] = relation.parties;
    for (const [x, y] of allianceBorderAnchors(state, first, second, shape)) {
      drawLink(x, y, -3.2, -0.36);
      drawLink(x, y, 3.2, 0.36);
    }
  }
}

function pointAlongPath(points: readonly [number, number][], progress: number): { x: number; y: number; angle: number } {
  if (points.length < 2) return { x: points[0]?.[0] ?? 0, y: points[0]?.[1] ?? 0, angle: 0 };
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    );
    lengths.push(length);
    total += length;
  }
  const target = Math.max(0, Math.min(0.9999, progress)) * total;
  let segment = 0;
  let before = 0;
  while (segment < lengths.length - 1 && before + lengths[segment]! < target) {
    before += lengths[segment]!;
    segment += 1;
  }
  const start = points[segment]!;
  const end = points[segment + 1]!;
  const local = lengths[segment]! > 0 ? (target - before) / lengths[segment]! : 0;
  return {
    x: start[0] + (end[0] - start[0]) * local,
    y: start[1] + (end[1] - start[1]) * local,
    angle: Math.atan2(end[1] - start[1], end[0] - start[0]),
  };
}

function drawCampaigns(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  selected: ElementId,
  showAllTheaters: boolean,
  extrapolatedTicks = 0,
) {
  const activeLabels = new Set<string>();
  for (const campaign of state.campaigns) {
    const element = ELEMENTS[campaign.attacker];
    if (campaign.mode === "naval" && campaign.originIndex !== null && campaign.targetIndex !== null) {
      if (!isValidWaterPath(state, campaign.pathIndices)) continue;
      const points = campaign.pathIndices.map((index) => centerFor(index, state, shape));
      const journey = campaign.initialEta > 0
        ? 1 - Math.max(0, campaign.eta - extrapolatedTicks) / campaign.initialEta
        : 1;
      const position = pointAlongPath(points, journey);
      context.save();
      context.translate(position.x, position.y);
      context.rotate(position.angle);
      context.fillStyle = "#fff6d8";
      context.strokeStyle = element.deepColor;
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(7, 0);
      context.lineTo(-5, -5);
      context.lineTo(-3, 0);
      context.lineTo(-5, 5);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
      context.save();
      context.fillStyle = "rgba(22, 37, 48, 0.9)";
      context.font = "700 10px ui-rounded, sans-serif";
      context.textAlign = "center";
      context.fillText(compactNumber(campaign.remaining), position.x, position.y - 10);
      context.restore();
      continue;
    }

    if (!showAllTheaters && campaign.target === "wilderness" && campaign.attacker !== selected) continue;
    const theaters = state.theaters.filter(
      (theater) =>
        theater.campaignId === campaign.id &&
        theater.staleRefreshes === 0 &&
        theater.allocation > 0,
    );
    for (const theater of theaters) {
      const [targetX, targetY] = centerFor(theater.centroidIndex, state, shape);
      const attackerNeighbors = neighborIndices(
        theater.centroidIndex,
        state.config.width,
        state.config.height,
      ).filter((neighbor) => state.cells[neighbor]!.owner === campaign.attacker);
      const attackerCenters = attackerNeighbors.map((neighbor) => centerFor(neighbor, state, shape));
      const attackerX = attackerCenters.length > 0
        ? attackerCenters.reduce((sum, point) => sum + point[0], 0) / attackerCenters.length
        : targetX;
      const attackerY = attackerCenters.length > 0
        ? attackerCenters.reduce((sum, point) => sum + point[1], 0) / attackerCenters.length
        : targetY;
      const desiredX = (targetX + attackerX) / 2;
      const desiredY = (targetY + attackerY) / 2;
      const previous = CAMPAIGN_LABEL_POSITIONS.get(theater.id);
      const x = previous ? previous.x + (desiredX - previous.x) * 0.12 : desiredX;
      const y = previous ? previous.y + (desiredY - previous.y) * 0.12 : desiredY;
      CAMPAIGN_LABEL_POSITIONS.set(theater.id, { x, y });
      activeLabels.add(theater.id);
      const label = campaign.target === "wilderness"
        ? `⌂ ${compactNumber(theater.allocation)}`
        : compactNumber(theater.allocation);
      context.save();
      context.font = "800 9px ui-rounded, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      const width = context.measureText(label).width + 8;
      context.fillStyle = campaign.target === "wilderness"
        ? "rgba(67, 67, 47, 0.78)"
        : "rgba(22, 37, 48, 0.9)";
      context.beginPath();
      context.roundRect(x - width / 2, y - 7, width, 14, 6);
      context.fill();
      context.fillStyle = "#fff6d8";
      context.fillText(label, x, y + 0.5);
      context.restore();
    }
  }
  for (const id of CAMPAIGN_LABEL_POSITIONS.keys()) {
    if (!activeLabels.has(id)) CAMPAIGN_LABEL_POSITIONS.delete(id);
  }
}

function drawWarships(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  visualTick = state.tick,
) {
  for (const id of ELEMENT_ORDER) {
    const faction = state.factions[id];
    if (faction.warships < 1) continue;
    const ports = structureCells(state, id, "harbor");
    if (ports.length === 0) continue;
    const [px, py] = centerFor(ports[0]!, state, shape);
    for (let ship = 0; ship < faction.warships; ship += 1) {
      const angle = visualTick * 0.025 + ship * 2.1;
      const x = px + Math.cos(angle) * (13 + ship * 3);
      const y = py + Math.sin(angle) * (9 + ship * 2);
      context.fillStyle = ELEMENTS[id].deepColor;
      context.beginPath();
      context.moveTo(x + 5, y);
      context.lineTo(x - 4, y - 3);
      context.lineTo(x - 2, y + 3);
      context.closePath();
      context.fill();
    }
  }
}

function drawVignette(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  const vignette = context.createRadialGradient(
    canvas.width / 2,
    canvas.height / 2,
    canvas.height * 0.25,
    canvas.width / 2,
    canvas.height / 2,
    canvas.width * 0.68,
  );
  vignette.addColorStop(0, "rgba(24, 35, 40, 0)");
  vignette.addColorStop(1, "rgba(18, 35, 44, 0.17)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, canvas.width, canvas.height);
}

function canvasFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const context = layer.getContext("2d");
  if (context) context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return layer;
}

function composeStaticWorld(
  state: WorldState,
  selected: ElementId,
  mapMode: MapMode,
  raster: MapRasterResult,
  width: number,
  height: number,
): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const context = layer.getContext("2d");
  if (!context) return layer;
  const shape = geometry(state, layer);
  drawFieldLayer(
    context,
    canvasFromPixels(raster.fill, raster.rasterWidth, raster.rasterHeight),
    layer,
    true,
  );
  if (mapMode === "theaters") {
    drawVignette(context, layer);
    return layer;
  }

  for (let index = 0; index < state.cells.length; index += 1) {
    drawTerrainTexture(context, state, shape, index);
  }
  drawTradeRoutes(context, state, shape);
  if (raster.borders) {
    drawFieldLayer(
      context,
      canvasFromPixels(raster.borders, raster.rasterWidth, raster.rasterHeight),
      layer,
      true,
    );
  }
  drawAllianceChains(context, state, shape);
  for (let index = 0; index < state.cells.length; index += 1) drawStructure(context, state, shape, index);
  drawVignette(context, layer);
  return layer;
}

interface RasterJob {
  request: MapRasterRequest;
  state: WorldState;
  selected: ElementId;
  mapMode: MapMode;
  canvasWidth: number;
  canvasHeight: number;
}

function createRasterRequest(
  requestId: number,
  state: WorldState,
  selected: ElementId,
  mapMode: MapMode,
  maps: TheaterCellMaps | null,
  theaterLayer: TheaterLayer,
  rasterWidth: number,
  rasterHeight: number,
): MapRasterRequest {
  const terrains = new Uint8Array(state.cells.length);
  for (let index = 0; index < state.cells.length; index += 1) {
    terrains[index] = RASTER_TERRAIN_ORDER.indexOf(state.cells[index]!.terrain);
  }
  const common = {
    type: "render" as const,
    requestId,
    gridWidth: state.config.width,
    gridHeight: state.config.height,
    rasterWidth,
    rasterHeight,
    terrains,
  };
  if (mapMode === "theaters") {
    if (!maps) throw new Error("Theater raster requested without theater intelligence fields");
    return { ...common, mode: "theaters", values: maps[theaterLayer].slice() };
  }
  const owners = new Int8Array(state.cells.length);
  const pressureOwners = new Int8Array(state.cells.length);
  const pressures = new Float32Array(state.cells.length);
  owners.fill(-1);
  pressureOwners.fill(-1);
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.owner) owners[index] = RASTER_ELEMENT_ORDER.indexOf(cell.owner);
    if (cell.pressureBy) pressureOwners[index] = RASTER_ELEMENT_ORDER.indexOf(cell.pressureBy);
    pressures[index] = cell.pressure;
  }
  const warMatrix = new Uint8Array(RASTER_ELEMENT_ORDER.length ** 2);
  for (const relation of Object.values(state.relations)) {
    if (relation.status !== "war") continue;
    const first = RASTER_ELEMENT_ORDER.indexOf(relation.parties[0]);
    const second = RASTER_ELEMENT_ORDER.indexOf(relation.parties[1]);
    warMatrix[first * RASTER_ELEMENT_ORDER.length + second] = 1;
    warMatrix[second * RASTER_ELEMENT_ORDER.length + first] = 1;
  }
  return {
    ...common,
    mode: "political",
    selected: RASTER_ELEMENT_ORDER.indexOf(selected),
    owners,
    pressureOwners,
    pressures,
    warMatrix,
  };
}

function rasterTransferables(request: MapRasterRequest): Transferable[] {
  const transfer: Transferable[] = [request.terrains.buffer];
  if (request.mode === "theaters") {
    transfer.push(request.values.buffer);
  } else {
    transfer.push(
      request.owners.buffer,
      request.pressureOwners.buffer,
      request.pressures.buffer,
      request.warMatrix.buffer,
    );
  }
  return transfer;
}

interface StaticFrames {
  previous: HTMLCanvasElement | null;
  current: HTMLCanvasElement | null;
  transitionStarted: number;
}

const STATIC_TRANSITION_MS = 240;

export function WorldMap({
  state,
  selected,
  onSelect,
  showAllTheaters = false,
  renderMarker,
  mapMode = "political",
  theaterLayer = "composite",
  playbackTicksPerSecond = 0,
}: WorldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rasterWorkerRef = useRef<Worker | null>(null);
  const rasterBusyRef = useRef(false);
  const queuedRasterRef = useRef<RasterJob | null>(null);
  const pendingRasterJobsRef = useRef(new Map<number, RasterJob>());
  const nextRasterRequestRef = useRef(0);
  const latestRasterRequestRef = useRef(0);
  const worldRef = useRef(state);
  const selectedRef = useRef(selected);
  const modeRef = useRef(mapMode);
  const playbackRef = useRef(playbackTicksPerSecond);
  const visualTickRef = useRef(state.tick);
  const visualSeedRef = useRef(state.seed);
  const lastAnimationAtRef = useRef(0);
  const framesRef = useRef<StaticFrames>({ previous: null, current: null, transitionStarted: 0 });
  const [hoveredCell, setHoveredCell] = useState<number | null>(null);
  const theaterMaps = useMemo(
    () => mapMode === "theaters" ? evaluateTheaterCellMaps(state, selected) : null,
    [mapMode, selected, state],
  );

  function dispatchRasterJob(job: RasterJob): void {
    const worker = rasterWorkerRef.current;
    if (!worker) {
      queuedRasterRef.current = job;
      return;
    }
    rasterBusyRef.current = true;
    pendingRasterJobsRef.current.set(job.request.requestId, job);
    worker.postMessage(job.request, rasterTransferables(job.request));
  }

  useEffect(() => {
    const worker = new Worker(new URL("../game/map-raster.worker.ts", import.meta.url), { type: "module" });
    rasterWorkerRef.current = worker;
    const handleRaster = (event: MessageEvent<MapRasterResult>) => {
      if (event.data.type !== "rendered") return;
      const job = pendingRasterJobsRef.current.get(event.data.requestId);
      pendingRasterJobsRef.current.delete(event.data.requestId);
      rasterBusyRef.current = false;
      if (job && event.data.requestId === latestRasterRequestRef.current) {
        const next = composeStaticWorld(
          job.state,
          job.selected,
          job.mapMode,
          event.data,
          job.canvasWidth,
          job.canvasHeight,
        );
        framesRef.current = {
          previous: framesRef.current.current,
          current: next,
          transitionStarted: performance.now(),
        };
      }
      const queued = queuedRasterRef.current;
      queuedRasterRef.current = null;
      if (queued) dispatchRasterJob(queued);
    };
    worker.addEventListener("message", handleRaster);
    const queued = queuedRasterRef.current;
    queuedRasterRef.current = null;
    if (queued) dispatchRasterJob(queued);
    return () => {
      worker.removeEventListener("message", handleRaster);
      worker.terminate();
      rasterWorkerRef.current = null;
      rasterBusyRef.current = false;
      queuedRasterRef.current = null;
      pendingRasterJobsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    worldRef.current = state;
    selectedRef.current = selected;
    modeRef.current = mapMode;
    if (visualSeedRef.current !== state.seed) {
      visualSeedRef.current = state.seed;
      visualTickRef.current = state.tick;
    } else {
      visualTickRef.current = Math.max(visualTickRef.current, state.tick);
    }
  }, [state, selected, mapMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const requestId = nextRasterRequestRef.current + 1;
    nextRasterRequestRef.current = requestId;
    latestRasterRequestRef.current = requestId;
    const fieldWidth = Math.max(1, Math.min(canvas.width, state.config.width * STATIC_FIELD_GRID_SCALE));
    const fieldHeight = Math.max(1, Math.min(canvas.height, state.config.height * STATIC_FIELD_GRID_SCALE));
    const job: RasterJob = {
      request: createRasterRequest(
        requestId,
        state,
        selected,
        mapMode,
        theaterMaps,
        theaterLayer,
        fieldWidth,
        fieldHeight,
      ),
      state,
      selected,
      mapMode,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
    if (rasterBusyRef.current) queuedRasterRef.current = job;
    else dispatchRasterJob(job);
  }, [state, selected, mapMode, theaterLayer, theaterMaps]);

  useEffect(() => {
    playbackRef.current = playbackTicksPerSecond;
  }, [playbackTicksPerSecond]);

  useEffect(() => {
    let frameId = 0;
    const drawFrame = (time: number) => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const world = worldRef.current;
      if (canvas && context) {
        const elapsedSeconds = lastAnimationAtRef.current > 0
          ? Math.max(0, Math.min(0.1, (time - lastAnimationAtRef.current) / 1_000))
          : 0;
        lastAnimationAtRef.current = time;
        visualTickRef.current = Math.max(
          world.tick,
          Math.min(world.tick + 8, visualTickRef.current + elapsedSeconds * playbackRef.current),
        );
        context.clearRect(0, 0, canvas.width, canvas.height);
        const frames = framesRef.current;
        const transition = Math.max(
          0,
          Math.min(1, (time - frames.transitionStarted) / STATIC_TRANSITION_MS),
        );
        if (frames.previous && transition >= 1) frames.previous = null;
        if (frames.previous && transition < 1) drawFieldLayer(context, frames.previous, canvas);
        if (frames.current) {
          context.save();
          context.globalAlpha = frames.previous ? transition : 1;
          drawFieldLayer(context, frames.current, canvas);
          context.restore();
        }
        if (modeRef.current === "political") {
          const shape = geometry(world, canvas);
          const extrapolatedTicks = Math.max(0, visualTickRef.current - world.tick);
          drawTradeVehicles(context, world, shape, extrapolatedTicks);
          drawCampaigns(context, world, shape, selectedRef.current, showAllTheaters, extrapolatedTicks);
          drawWarships(context, world, shape, world.tick + extrapolatedTicks);
        }
        if (renderMarker !== undefined) canvas.dataset.renderedMarker = renderMarker;
      }
      frameId = window.requestAnimationFrame(drawFrame);
    };
    frameId = window.requestAnimationFrame(drawFrame);
    return () => window.cancelAnimationFrame(frameId);
  }, [renderMarker, showAllTheaters]);

  function cellAtPointer(event: React.PointerEvent<HTMLCanvasElement>): number {
    const canvas = canvasRef.current;
    if (!canvas) return -1;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(
      state.config.width - 1,
      Math.floor(((event.clientX - bounds.left) / bounds.width) * state.config.width),
    ));
    const y = Math.max(0, Math.min(
      state.config.height - 1,
      Math.floor(((event.clientY - bounds.top) / bounds.height) * state.config.height),
    ));
    return y * state.config.width + x;
  }

  function handlePointer(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - bounds.left) / bounds.width) * state.config.width);
    const y = Math.floor(((event.clientY - bounds.top) / bounds.height) * state.config.height);
    const index = y * state.config.width + x;
    if (mapMode === "theaters") {
      setHoveredCell(state.cells[index]?.terrain === "water" ? null : index);
      return;
    }
    const owner = state.cells[index]?.owner;
    if (owner) onSelect(owner);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (mapMode !== "theaters") return;
    const index = cellAtPointer(event);
    const next = index >= 0 && state.cells[index]?.terrain !== "water" ? index : null;
    setHoveredCell((previous) => previous === next ? previous : next);
  }

  const wars = Object.values(state.relations).filter((relation) => relation.status === "war").length;
  const truces = Object.values(state.relations).filter((relation) => relation.status === "truce").length;
  const trains = state.tradeVehicles.filter((vehicle) => vehicle.kind === "train").length;
  const ships = state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship").length;
  const hoveredPosition = hoveredCell === null
    ? null
    : cellCoordinates(hoveredCell, state.config.width);
  const hoveredValue = hoveredCell === null || !theaterMaps
    ? null
    : theaterMaps[theaterLayer][hoveredCell] ?? null;
  const hoveredBreakdown = hoveredCell === null || !theaterMaps ? null : {
    composite: theaterMaps.composite[hoveredCell]!,
    productivity: theaterMaps.productivity[hoveredCell]!,
    terrain: theaterMaps.terrain[hoveredCell]!,
    infrastructure: theaterMaps.infrastructure[hoveredCell]!,
    access: theaterMaps.access[hoveredCell]!,
    affinity: theaterMaps.affinity[hoveredCell]!,
    opportunity: theaterMaps.opportunity[hoveredCell]!,
  };
  const percent = (value: number) => Math.round(value * 100);
  const tooltipPosition = hoveredPosition
    ? hoveredPosition
    : null;
  return (
    <div className="world-map-shell">
      <canvas
        ref={canvasRef}
        width={1180}
        height={730}
        className="world-map"
        onPointerDown={handlePointer}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoveredCell(null)}
        aria-label={mapMode === "theaters"
          ? `${ELEMENTS[selected].name} interpretation of the world's strategic theaters. Green is high value and red is low value.`
          : `Live political and terrain map of ${state.worldName}. Select a colored nation to inspect it.`}
      />
      {mapMode === "theaters" && hoveredValue !== null && hoveredBreakdown && tooltipPosition && (
        <div
          className="theater-tooltip"
          style={{
            left: `${((tooltipPosition[0] + 0.5) / state.config.width) * 100}%`,
            top: `${((tooltipPosition[1] + 0.5) / state.config.height) * 100}%`,
          }}
        >
          <strong>{THEATER_LAYER_LABELS[theaterLayer]} · {percent(hoveredValue)}</strong>
          <span>composite {percent(hoveredBreakdown.composite)} · land {percent(hoveredBreakdown.productivity)} · terrain {percent(hoveredBreakdown.terrain)}</span>
          <span>infrastructure {percent(hoveredBreakdown.infrastructure)} · access {percent(hoveredBreakdown.access)}</span>
          <span>element fit {percent(hoveredBreakdown.affinity)} · opportunity {percent(hoveredBreakdown.opportunity)}</span>
        </div>
      )}
      <div className={`map-status ${wars > 0 ? "at-war" : "at-peace"}`} aria-hidden="true">
        <span className="live-pip" />
        {mapMode === "theaters"
          ? `${ELEMENTS[selected].name} · ${THEATER_LAYER_LABELS[theaterLayer]} · tick ${state.tick}`
          : <>{wars === 0 ? "All nations at peace" : `${wars} active ${wars === 1 ? "war" : "wars"}`}
              {truces > 0 ? ` · ${truces} ${truces === 1 ? "alliance" : "alliances"}` : ""} · live tick {state.tick}</>}
      </div>
      {mapMode === "theaters" ? (
        <div className="map-legend theater-legend" aria-hidden="true">
          <span><i className="theater-low" /> low value</span>
          <span><i className="theater-mid" /> contested value</span>
          <span><i className="theater-high" /> high value</span>
        </div>
      ) : (
        <div className="map-legend" aria-hidden="true">
          <span><i className="legend-peace" /> border</span>
          <span><i className="legend-war" /> war front</span>
          <span><i className="legend-alliance" /> allied border</span>
          <span><i className="legend-trade" /> trains {trains}/300 · ships {ships}/1000</span>
        </div>
      )}
      <div className="map-hint" aria-hidden="true">
        {mapMode === "theaters" ? "select a realm below to compare strategic values" : "tap a nation to inspect its treasury & diplomacy"}
      </div>
    </div>
  );
}
