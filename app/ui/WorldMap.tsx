"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ELEMENTS } from "../game/elements";
import { PLAYERS, PLAYER_ORDER, playerElement } from "../game/players";
import {
  cellCoordinates,
  frontTargets,
  neighborIndices,
  structureCells,
  surroundingIndices,
} from "../game/grid";
import {
  STRUCTURE_RULES,
  compactNumber,
} from "../game/rules";
import {
  THEATER_LAYER_LABELS,
  evaluateTheaterCellMaps,
} from "../game/theater-intelligence";
import type { TheaterCellMaps, TheaterLayer } from "../game/theater-intelligence";
import {
  RASTER_PLAYER_INDEX,
  RASTER_PLAYER_ORDER,
  RASTER_TERRAIN_INDEX,
} from "../game/map-raster-protocol";
import type {
  MapRasterRequest,
  MapRasterResult,
  RasterBufferRecycle,
} from "../game/map-raster-protocol";
import { politicalFieldArrays } from "../game/political-field";
import type { PlayerId, WorldState } from "../game/types";
import { isValidWaterPath } from "../game/water-navigation";

export type MapMode = "political" | "theaters";

interface WorldMapProps {
  state: WorldState;
  selected: PlayerId;
  onSelect: (player: PlayerId) => void;
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

/**
 * Raster pixels per authoritative cell.
 *
 * Two was chosen when the ownership field cost one channel per realm and the
 * whole raster had to stay affordable; the map was drawn at 336 by 208 and
 * stretched to fill the canvas, which five broad regions survived and fifty
 * intricate frontiers do not. Now that the field is sparse, the expensive half
 * -- blurring -- is per cell and does not grow with this at all, so doubling
 * the linear resolution costs only the sampling pass and still lands well under
 * what the dense field cost at half the size.
 */
const STATIC_FIELD_GRID_SCALE = 4;

/**
 * The map's logical coordinate space, in CSS pixels.
 *
 * The canvas backing store is this times the device pixel ratio, and every
 * drawing context is scaled to match, so all draw code works in one stable
 * space while glyphs, borders and moving vehicles stay crisp on dense
 * displays -- sub-pixel motion that a 1x backing store rounds into visible
 * one-pixel steps.
 */
const MAP_WIDTH = 1180;
const MAP_HEIGHT = 730;

function geometry(state: WorldState): MapGeometry {
  return {
    cellWidth: MAP_WIDTH / state.config.width,
    cellHeight: MAP_HEIGHT / state.config.height,
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

const CAMPAIGN_LABEL_POSITIONS = new Map<string, { x: number; y: number }>();

function drawFieldLayer(
  context: CanvasRenderingContext2D,
  layer: HTMLCanvasElement,
  smoothing = false,
) {
  context.save();
  context.imageSmoothingEnabled = smoothing;
  if (smoothing) context.imageSmoothingQuality = "high";
  context.drawImage(layer, 0, 0, MAP_WIDTH, MAP_HEIGHT);
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
  // The marker wears the owner's family colors — identity never repaints —
  // while a capital's glyph reads the expressed element of the realm founded
  // there, so ascension shows on the map and a captured capital stays storied
  // ground: the conqueror's ring around the fallen realm's mark.
  const family = ELEMENTS[playerElement(cell.owner)];
  const capitalGlyph = cell.capitalOf
    ? ELEMENTS[state.factions[cell.capitalOf].expressedElement].glyph
    : null;
  const radius = Math.max(5, Math.min(shape.cellWidth, shape.cellHeight) * 0.63);
  context.save();
  context.shadowColor = "rgba(14, 27, 35, 0.28)";
  context.shadowBlur = 4;
  context.fillStyle = capitalGlyph ? family.deepColor : "rgba(255, 249, 226, 0.94)";
  context.strokeStyle = family.deepColor;
  context.lineWidth = 1.3;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.shadowColor = "transparent";
  context.fillStyle = capitalGlyph ? "#fff5d9" : family.deepColor;
  context.font = `800 ${Math.max(8, radius * 1.05)}px ui-rounded, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    capitalGlyph ?? STRUCTURE_RULES[cell.structure].glyph,
    x,
    y + 0.3,
  );
  if (cell.structure === "city" && cell.structureLevel > 1) {
    context.fillStyle = family.deepColor;
    context.strokeStyle = "rgba(255, 249, 226, 0.98)";
    context.lineWidth = 2.5;
    context.font = `900 ${Math.max(7, radius * 0.7)}px ui-rounded, sans-serif`;
    context.strokeText(String(cell.structureLevel), x + radius * 0.72, y + radius * 0.72);
    context.fillText(String(cell.structureLevel), x + radius * 0.72, y + radius * 0.72);
  }
  context.restore();
}

/** Traces a path of cell centers as a smoothed curve through segment midpoints. */
function traceSmoothedPath(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  path: readonly number[],
) {
  const [sx, sy] = centerFor(path[0]!, state, shape);
  context.moveTo(sx, sy);
  let [px, py] = [sx, sy];
  for (let at = 1; at < path.length - 1; at += 1) {
    const [x, y] = centerFor(path[at]!, state, shape);
    context.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
    [px, py] = [x, y];
  }
  const [ex, ey] = centerFor(path[path.length - 1]!, state, shape);
  context.quadraticCurveTo(px, py, ex, ey);
}

function drawTradeRoutes(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
) {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const route of state.tradeRoutes) {
    if (route.kind === "sea") continue;
    const path = route.pathIndices.length > 1
      ? route.pathIndices
      : [route.startIndex, route.endIndex];
    if (route.kind === "conduit") {
      // A conduit is a strung line, not a laid road: one straight bright
      // wire with a faint dark shadow under it.
      const [sx, sy] = centerFor(path[0]!, state, shape);
      const [ex, ey] = centerFor(path[path.length - 1]!, state, shape);
      context.beginPath();
      context.moveTo(sx, sy);
      context.lineTo(ex, ey);
      context.setLineDash([]);
      context.strokeStyle = "rgba(40, 52, 46, 0.4)";
      context.lineWidth = 2;
      context.stroke();
      context.setLineDash([1.6, 2.6]);
      context.strokeStyle = "rgba(151, 227, 255, 0.9)";
      context.lineWidth = 1.1;
      context.stroke();
      continue;
    }
    // A railway reads as one: a darker roadbed underneath, then a bright
    // dashed running line over it, both following the same smoothed curve.
    context.beginPath();
    traceSmoothedPath(context, state, shape, path);
    context.setLineDash([]);
    context.strokeStyle = "rgba(58, 47, 28, 0.55)";
    context.lineWidth = 2.6;
    context.stroke();
    context.setLineDash([4, 3.2]);
    context.strokeStyle = "rgba(255, 236, 169, 0.85)";
    context.lineWidth = 1.2;
    context.stroke();
  }
  context.restore();
}

/**
 * Per-path render geometry, cached between animation frames.
 *
 * The display loop repositions up to 1,300 vehicles at 60 Hz, and it used to
 * re-validate every ship's water route and rebuild its point and length arrays
 * on every frame -- most of the frame budget went to redoing work whose inputs
 * never change. A vehicle's path is fixed for its lifetime, so the projected
 * points, cumulative lengths and validity are computed once per path and
 * reused until the canvas geometry changes.
 */
interface PathRenderGeometry {
  points: Float32Array;
  cumulative: Float32Array;
  total: number;
  valid: boolean;
  cellWidth: number;
  cellHeight: number;
  lastSeen: number;
}

const PATH_GEOMETRY = new Map<string, PathRenderGeometry>();
const PATH_GEOMETRY_SWEEP_FRAMES = 600;
let pathGeometryFrame = 0;

function pathRenderGeometry(
  key: string,
  state: WorldState,
  shape: MapGeometry,
  path: readonly number[],
  validateWater: boolean,
): PathRenderGeometry {
  const cached = PATH_GEOMETRY.get(key);
  if (cached && cached.cellWidth === shape.cellWidth && cached.cellHeight === shape.cellHeight) {
    cached.lastSeen = pathGeometryFrame;
    return cached;
  }
  const valid = cached?.valid ?? (!validateWater || isValidWaterPath(state, path));
  const points = new Float32Array(path.length * 2);
  const cumulative = new Float32Array(path.length);
  let total = 0;
  for (let at = 0; at < path.length; at += 1) {
    const [x, y] = centerFor(path[at]!, state, shape);
    points[at * 2] = x;
    points[at * 2 + 1] = y;
    if (at > 0) total += Math.hypot(x - points[at * 2 - 2]!, y - points[at * 2 - 1]!);
    cumulative[at] = total;
  }
  const geometry: PathRenderGeometry = {
    points,
    cumulative,
    total,
    valid,
    cellWidth: shape.cellWidth,
    cellHeight: shape.cellHeight,
    lastSeen: pathGeometryFrame,
  };
  PATH_GEOMETRY.set(key, geometry);
  return geometry;
}

function sweepPathGeometry(): void {
  pathGeometryFrame += 1;
  if (pathGeometryFrame % PATH_GEOMETRY_SWEEP_FRAMES !== 0) return;
  for (const [key, geometry] of PATH_GEOMETRY) {
    if (pathGeometryFrame - geometry.lastSeen > PATH_GEOMETRY_SWEEP_FRAMES) PATH_GEOMETRY.delete(key);
  }
}

function positionAlong(
  geometry: PathRenderGeometry,
  progress: number,
): { x: number; y: number; angle: number } {
  const { points, cumulative } = geometry;
  const target = Math.max(0, Math.min(0.9999, progress)) * geometry.total;
  // Binary search for the segment holding the target distance.
  let low = 0;
  let high = cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid]! <= target) low = mid;
    else high = mid;
  }
  const segmentLength = cumulative[low + 1]! - cumulative[low]!;
  const local = segmentLength > 0 ? (target - cumulative[low]!) / segmentLength : 0;
  const sx = points[low * 2]!;
  const sy = points[low * 2 + 1]!;
  const ex = points[low * 2 + 2]!;
  const ey = points[low * 2 + 3]!;
  return {
    x: sx + (ex - sx) * local,
    y: sy + (ey - sy) * local,
    angle: Math.atan2(ey - sy, ex - sx),
  };
}

function drawTradeVehicles(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  extrapolatedTicks = 0,
) {
  sweepPathGeometry();
  for (const vehicle of state.tradeVehicles) {
    const path = vehicle.pathIndices.length > 1
      ? vehicle.pathIndices
      : [vehicle.startIndex, vehicle.endIndex];
    if (path.length < 2) continue;
    const geometry = pathRenderGeometry(vehicle.id, state, shape, path, vehicle.kind === "ship");
    if (!geometry.valid) continue;
    const visualDistance = vehicle.dwellRemaining > 0
      ? vehicle.distanceTravelled
      : Math.min(vehicle.totalDistance, vehicle.distanceTravelled + vehicle.velocity * extrapolatedTicks);
    const visualProgress = vehicle.totalDistance > 0 ? visualDistance / vehicle.totalDistance : vehicle.progress;
    const { x, y, angle } = positionAlong(geometry, visualProgress);
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.fillStyle = ELEMENTS[playerElement(vehicle.owner)].deepColor;
    context.strokeStyle = "rgba(255,250,226,.95)";
    context.lineWidth = 1;
    context.beginPath();
    if (vehicle.kind === "train") context.roundRect(-5, -3, 10, 6, 2);
    else if (vehicle.kind === "pulse") context.arc(0, 0, 2.6, 0, Math.PI * 2);
    else if (vehicle.kind === "flyer") {
      context.moveTo(7, 0);
      context.lineTo(-5, -4.5);
      context.lineTo(-2.5, 0);
      context.lineTo(-5, 4.5);
      context.closePath();
    } else {
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
  first: PlayerId,
  second: PlayerId,
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

function drawCampaigns(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  selected: PlayerId,
  showAllTheaters: boolean,
  extrapolatedTicks = 0,
  labelBlend = 0.12,
) {
  const activeLabels = new Set<string>();
  for (const campaign of state.campaigns) {
    const family = ELEMENTS[playerElement(campaign.attacker)];
    if (campaign.mode === "naval" && campaign.originIndex !== null && campaign.targetIndex !== null) {
      const geometry = pathRenderGeometry(campaign.id, state, shape, campaign.pathIndices, true);
      if (!geometry.valid) continue;
      const journey = campaign.initialEta > 0
        ? 1 - Math.max(0, campaign.eta - extrapolatedTicks) / campaign.initialEta
        : 1;
      const position = positionAlong(geometry, journey);
      context.save();
      context.translate(position.x, position.y);
      context.rotate(position.angle);
      context.fillStyle = "#fff6d8";
      context.strokeStyle = family.deepColor;
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
      const x = previous ? previous.x + (desiredX - previous.x) * labelBlend : desiredX;
      const y = previous ? previous.y + (desiredY - previous.y) * labelBlend : desiredY;
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
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (faction.warships < 1) continue;
    const ports = structureCells(state, id, "harbor");
    if (ports.length === 0) continue;
    const [px, py] = centerFor(ports[0]!, state, shape);
    for (let ship = 0; ship < faction.warships; ship += 1) {
      const angle = visualTick * 0.025 + ship * 2.1;
      const x = px + Math.cos(angle) * (13 + ship * 3);
      const y = py + Math.sin(angle) * (9 + ship * 2);
      context.fillStyle = ELEMENTS[playerElement(id)].deepColor;
      context.beginPath();
      context.moveTo(x + 5, y);
      context.lineTo(x - 4, y - 3);
      context.lineTo(x - 2, y + 3);
      context.closePath();
      context.fill();
    }
  }
}

function drawVignette(context: CanvasRenderingContext2D) {
  const vignette = context.createRadialGradient(
    MAP_WIDTH / 2,
    MAP_HEIGHT / 2,
    MAP_HEIGHT * 0.25,
    MAP_WIDTH / 2,
    MAP_HEIGHT / 2,
    MAP_WIDTH * 0.68,
  );
  vignette.addColorStop(0, "rgba(24, 35, 40, 0)");
  vignette.addColorStop(1, "rgba(18, 35, 44, 0.17)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
}

/**
 * Reused canvases for compositing static frames.
 *
 * The interpolated display pipeline composes a new static frame many times a
 * second; allocating fresh canvases for each one made the garbage collector a
 * regular guest in the animation. Three pooled layers cover the crossfade pair
 * plus the frame being composed, the scratch pair holds the raster pixels on
 * their way to the GPU, and the decor pair caches everything that only changes
 * per authoritative snapshot -- terrain marks, trade routes, structures,
 * alliance chains and the vignette -- so a field frame costs four blits.
 */
interface MapLayerResources {
  pool: HTMLCanvasElement[];
  poolIndex: number;
  fillScratch: HTMLCanvasElement | null;
  borderScratch: HTMLCanvasElement | null;
  decorFor: WorldState | null;
  underDecor: HTMLCanvasElement | null;
  overDecor: HTMLCanvasElement | null;
}

function createLayerResources(): MapLayerResources {
  return {
    pool: [],
    poolIndex: 0,
    fillScratch: null,
    borderScratch: null,
    decorFor: null,
    underDecor: null,
    overDecor: null,
  };
}

function sizedCanvas(
  existing: HTMLCanvasElement | null,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = existing ?? document.createElement("canvas");
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

function acquirePooledLayer(
  resources: MapLayerResources,
  width: number,
  height: number,
): HTMLCanvasElement {
  while (resources.pool.length < 3) resources.pool.push(document.createElement("canvas"));
  const layer = sizedCanvas(resources.pool[resources.poolIndex]!, width, height);
  resources.pool[resources.poolIndex] = layer;
  resources.poolIndex = (resources.poolIndex + 1) % resources.pool.length;
  return layer;
}

function composeDecorLayers(
  resources: MapLayerResources,
  state: WorldState,
  scale: number,
  width: number,
  height: number,
): void {
  const shape = geometry(state);
  const under = sizedCanvas(resources.underDecor, width, height);
  const over = sizedCanvas(resources.overDecor, width, height);
  resources.underDecor = under;
  resources.overDecor = over;
  const underContext = under.getContext("2d");
  const overContext = over.getContext("2d");
  if (!underContext || !overContext) return;
  underContext.setTransform(scale, 0, 0, scale, 0, 0);
  underContext.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  for (let index = 0; index < state.cells.length; index += 1) {
    drawTerrainTexture(underContext, state, shape, index);
  }
  drawTradeRoutes(underContext, state, shape);
  overContext.setTransform(scale, 0, 0, scale, 0, 0);
  overContext.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  drawAllianceChains(overContext, state, shape);
  for (let index = 0; index < state.cells.length; index += 1) {
    drawStructure(overContext, state, shape, index);
  }
  drawVignette(overContext);
  resources.decorFor = state;
}

function composeStaticWorld(
  resources: MapLayerResources,
  job: RasterJob,
  raster: MapRasterResult,
  scale: number,
): HTMLCanvasElement {
  const layer = acquirePooledLayer(resources, job.canvasWidth, job.canvasHeight);
  const context = layer.getContext("2d");
  if (!context) return layer;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  const fillScratch = sizedCanvas(resources.fillScratch, raster.rasterWidth, raster.rasterHeight);
  resources.fillScratch = fillScratch;
  fillScratch
    .getContext("2d")
    ?.putImageData(new ImageData(raster.fill, raster.rasterWidth, raster.rasterHeight), 0, 0);
  drawFieldLayer(context, fillScratch, true);
  if (job.mapMode === "theaters") {
    drawVignette(context);
    return layer;
  }

  if (
    resources.decorFor !== job.state ||
    resources.underDecor?.width !== job.canvasWidth ||
    resources.underDecor?.height !== job.canvasHeight
  ) {
    composeDecorLayers(resources, job.state, scale, job.canvasWidth, job.canvasHeight);
  }
  if (resources.underDecor) drawFieldLayer(context, resources.underDecor);
  if (raster.borders) {
    const borderScratch = sizedCanvas(resources.borderScratch, raster.rasterWidth, raster.rasterHeight);
    resources.borderScratch = borderScratch;
    const borderContext = borderScratch.getContext("2d");
    if (borderContext) {
      borderContext.putImageData(
        new ImageData(raster.borders, raster.rasterWidth, raster.rasterHeight),
        0,
        0,
      );
      drawFieldLayer(context, borderScratch, true);
    }
  }
  if (resources.overDecor) drawFieldLayer(context, resources.overDecor);
  return layer;
}

interface RasterJob {
  request: MapRasterRequest;
  state: WorldState;
  selected: PlayerId;
  mapMode: MapMode;
  canvasWidth: number;
  canvasHeight: number;
}

function createRasterRequest(
  requestId: number,
  state: WorldState,
  previous: WorldState | null,
  blend: number,
  selected: PlayerId,
  mapMode: MapMode,
  maps: TheaterCellMaps | null,
  theaterLayer: TheaterLayer,
  rasterWidth: number,
  rasterHeight: number,
): MapRasterRequest {
  const terrains = new Uint8Array(state.cells.length);
  for (let index = 0; index < state.cells.length; index += 1) {
    terrains[index] = RASTER_TERRAIN_INDEX.get(state.cells[index]!.terrain)!;
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
  const { owners, pressureOwners, pressures } = politicalFieldArrays(previous, state, blend);
  const warMatrix = new Uint8Array(RASTER_PLAYER_ORDER.length ** 2);
  for (const relation of Object.values(state.relations)) {
    if (relation.status !== "war") continue;
    const first = RASTER_PLAYER_INDEX.get(relation.parties[0])!;
    const second = RASTER_PLAYER_INDEX.get(relation.parties[1])!;
    warMatrix[first * RASTER_PLAYER_ORDER.length + second] = 1;
    warMatrix[second * RASTER_PLAYER_ORDER.length + first] = 1;
  }
  return {
    ...common,
    mode: "political",
    selected: RASTER_PLAYER_INDEX.get(selected)!,
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
  /** Crossfade length, matched to how quickly field frames actually arrive. */
  transitionDuration: number;
}

/**
 * The two most recent authoritative snapshots, and the wall-clock rhythm they
 * arrive at. The display loop renders the field at a moment gliding from the
 * older to the newer one, so fronts move continuously instead of stepping
 * once per snapshot.
 */
interface FieldTimeline {
  previous: WorldState | null;
  current: WorldState;
  arrivedAt: number;
  intervalMs: number;
}

const STATIC_TRANSITION_FALLBACK_MS = 240;
/** Floor between field renders; the raster worker's own pace is the ceiling. */
const FIELD_FRAME_MIN_GAP_MS = 30;
/** Skip re-rendering the field until the blend has moved at least this far. */
const FIELD_FRAME_MIN_BLEND_STEP = 0.05;

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
  const theaterLayerRef = useRef(theaterLayer);
  const theaterMapsRef = useRef<TheaterCellMaps | null>(null);
  const playbackRef = useRef(playbackTicksPerSecond);
  const visualTickRef = useRef(state.tick);
  const visualSeedRef = useRef(state.seed);
  const lastAnimationAtRef = useRef(0);
  const framesRef = useRef<StaticFrames>({
    previous: null,
    current: null,
    transitionStarted: 0,
    transitionDuration: STATIC_TRANSITION_FALLBACK_MS,
  });
  const resourcesRef = useRef<MapLayerResources>(createLayerResources());
  const timelineRef = useRef<FieldTimeline>({
    previous: null,
    current: state,
    arrivedAt: 0,
    intervalMs: 250,
  });
  const fieldDirtyRef = useRef(true);
  const dispatchedBlendRef = useRef(1);
  const lastDispatchAtRef = useRef(0);
  const lastStaticFrameAtRef = useRef(0);
  const pixelScaleRef = useRef(1);
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

  /**
   * The field render pump, called once per display frame.
   *
   * A frame is rendered when something changed (a new snapshot, a new
   * selection, a mode switch) or while the political field is still gliding
   * between the previous and current snapshot. The worker's own pace, a
   * modest floor, and a minimum blend step together decide the actual rate,
   * so a fast machine gets fluid fronts and a slow one degrades to exactly
   * the old snapshot-at-a-time behaviour.
   */
  function maybeDispatchFieldFrame(now: number): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const timeline = timelineRef.current;
    const mode = modeRef.current;
    const blend = timeline.previous
      ? Math.max(0, Math.min(1, (now - timeline.arrivedAt) / timeline.intervalMs))
      : 1;
    const interpolating = mode === "political"
      && timeline.previous !== null
      && dispatchedBlendRef.current < 1;
    if (!fieldDirtyRef.current && !interpolating) return;
    if (rasterBusyRef.current) return;
    if (now - lastDispatchAtRef.current < FIELD_FRAME_MIN_GAP_MS) return;
    if (
      !fieldDirtyRef.current &&
      blend < 1 &&
      blend - dispatchedBlendRef.current < FIELD_FRAME_MIN_BLEND_STEP
    ) return;
    if (mode === "theaters" && !theaterMapsRef.current) return;
    const current = timeline.current;
    const requestId = nextRasterRequestRef.current + 1;
    nextRasterRequestRef.current = requestId;
    latestRasterRequestRef.current = requestId;
    const fieldWidth = Math.max(1, Math.min(canvas.width, current.config.width * STATIC_FIELD_GRID_SCALE));
    const fieldHeight = Math.max(1, Math.min(canvas.height, current.config.height * STATIC_FIELD_GRID_SCALE));
    const job: RasterJob = {
      request: createRasterRequest(
        requestId,
        current,
        mode === "political" ? timeline.previous : null,
        blend,
        selectedRef.current,
        mode,
        theaterMapsRef.current,
        theaterLayerRef.current,
        fieldWidth,
        fieldHeight,
      ),
      state: current,
      selected: selectedRef.current,
      mapMode: mode,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
    fieldDirtyRef.current = false;
    dispatchedBlendRef.current = blend;
    lastDispatchAtRef.current = now;
    dispatchRasterJob(job);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    pixelScaleRef.current = scale;
    const width = Math.round(MAP_WIDTH * scale);
    const height = Math.round(MAP_HEIGHT * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("../game/map-raster.worker.ts", import.meta.url), { type: "module" });
    rasterWorkerRef.current = worker;
    const handleRaster = (event: MessageEvent<MapRasterResult>) => {
      if (event.data.type !== "rendered") return;
      const job = pendingRasterJobsRef.current.get(event.data.requestId);
      pendingRasterJobsRef.current.delete(event.data.requestId);
      rasterBusyRef.current = false;
      if (job && event.data.requestId === latestRasterRequestRef.current) {
        const now = performance.now();
        const next = composeStaticWorld(
          resourcesRef.current,
          job,
          event.data,
          pixelScaleRef.current,
        );
        framesRef.current = {
          previous: framesRef.current.current,
          current: next,
          transitionStarted: now,
          transitionDuration: lastStaticFrameAtRef.current > 0
            ? Math.max(40, Math.min(320, now - lastStaticFrameAtRef.current))
            : STATIC_TRANSITION_FALLBACK_MS,
        };
        lastStaticFrameAtRef.current = now;
      }
      // The pixels have been composited; hand the buffers back for reuse.
      const buffers: ArrayBuffer[] = [event.data.fill.buffer];
      if (event.data.borders) buffers.push(event.data.borders.buffer);
      worker.postMessage({ type: "recycle", buffers } satisfies RasterBufferRecycle, buffers);
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
    theaterLayerRef.current = theaterLayer;
    theaterMapsRef.current = theaterMaps;
    const now = performance.now();
    const timeline = timelineRef.current;
    if (visualSeedRef.current !== state.seed) {
      visualSeedRef.current = state.seed;
      visualTickRef.current = state.tick;
      timelineRef.current = {
        previous: null,
        current: state,
        arrivedAt: now,
        intervalMs: timeline.intervalMs,
      };
      dispatchedBlendRef.current = 1;
    } else {
      visualTickRef.current = Math.max(visualTickRef.current, state.tick);
      if (timeline.current !== state) {
        const gap = Math.max(90, Math.min(1000, now - timeline.arrivedAt));
        timelineRef.current = {
          // Only glide when the world actually advanced; a re-published tick
          // (pausing, aggression changes) has nothing to interpolate.
          previous: state.tick > timeline.current.tick ? timeline.current : null,
          current: state,
          arrivedAt: now,
          intervalMs: timeline.arrivedAt > 0
            ? timeline.intervalMs * 0.5 + gap * 0.5
            : timeline.intervalMs,
        };
        dispatchedBlendRef.current = 0;
      }
    }
    fieldDirtyRef.current = true;
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
        maybeDispatchFieldFrame(time);
        const scale = pixelScaleRef.current;
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
        const frames = framesRef.current;
        const transition = Math.max(
          0,
          Math.min(1, (time - frames.transitionStarted) / frames.transitionDuration),
        );
        if (frames.previous && transition >= 1) frames.previous = null;
        if (frames.previous && transition < 1) drawFieldLayer(context, frames.previous);
        if (frames.current) {
          context.save();
          context.globalAlpha = frames.previous ? transition : 1;
          drawFieldLayer(context, frames.current);
          context.restore();
        }
        if (modeRef.current === "political") {
          const shape = geometry(world);
          const extrapolatedTicks = Math.max(0, visualTickRef.current - world.tick);
          // Frame-rate-independent easing for the campaign labels.
          const labelBlend = 1 - Math.exp(-elapsedSeconds * 9);
          drawTradeVehicles(context, world, shape, extrapolatedTicks);
          drawCampaigns(context, world, shape, selectedRef.current, showAllTheaters, extrapolatedTicks, labelBlend);
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
  const pulses = state.tradeVehicles.filter((vehicle) => vehicle.kind === "pulse").length;
  const flyers = state.tradeVehicles.filter((vehicle) => vehicle.kind === "flyer").length;
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
          ? `${PLAYERS[selected]!.name} interpretation of the world's strategic theaters. Green is high value and red is low value.`
          : `Live political and terrain map of ${state.worldName}. Select a colored player to inspect it.`}
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
          ? `${PLAYERS[selected]!.name} · ${THEATER_LAYER_LABELS[theaterLayer]} · tick ${state.tick}`
          : <>{wars === 0 ? "All players at peace" : `${wars} active ${wars === 1 ? "war" : "wars"}`}
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
          <span><i className="legend-trade" /> convoys {trains} · ships {ships} · pulses {pulses} · flyers {flyers}</span>
        </div>
      )}
      <div className="map-hint" aria-hidden="true">
        {mapMode === "theaters" ? "select a realm below to compare strategic values" : "tap a player to inspect its treasury & diplomacy"}
      </div>
    </div>
  );
}
