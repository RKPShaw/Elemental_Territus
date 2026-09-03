"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ELEMENTS } from "../game/elements";
import { realmLabel } from "../game/naming";
import { PLAYER_ORDER } from "../game/players";
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
  gridDensity,
  gridFineness,
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
} from "../game/map-raster-protocol";
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

/**
 * The zoom range of the display.
 *
 * The world raster is fixed at five pixels per area -- fine enough for thin
 * frontier rims, but still flat blocks -- so zoom never re-renders the ground
 * at a finer grain: it only scales the pixels. At 1x the whole
 * map fits the viewport; the range tops out where one area fills about
 * fifty-six CSS pixels, a large, flat square with nothing smaller inside it
 * to reveal. On a 252 by 156 world that is 12x from areas of under five
 * pixels; on the old 168 by 104 world it was 8x from areas of seven.
 */
const MIN_ZOOM = 1;
const LARGEST_AREA_CSS_PX = 56;

function maxZoomFor(state: WorldState): number {
  return Math.max(4, Math.round(LARGEST_AREA_CSS_PX / (MAP_WIDTH / state.config.width)));
}
/** One wheel notch (deltaY ~100) scales the view by about 17%. */
const WHEEL_ZOOM_RATE = 0.0016;
/** Pointer travel in CSS pixels past which a press is a pan, not a tap. */
const DRAG_SUPPRESS_TAP_PX = 5;
/** World ticks between refreshes of the theater appraisal while it is shown. */
const THEATER_MAP_REFRESH_TICKS = 4;

/**
 * The visible window onto the map: `x`/`y` is the top-left corner of the
 * window in map space, and the window spans `MAP_WIDTH / zoom` by
 * `MAP_HEIGHT / zoom` map units.
 */
interface MapView {
  zoom: number;
  x: number;
  y: number;
}

function clampView(view: MapView, maxZoom: number): MapView {
  const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, view.zoom));
  return {
    zoom,
    x: Math.max(0, Math.min(MAP_WIDTH - MAP_WIDTH / zoom, view.x)),
    y: Math.max(0, Math.min(MAP_HEIGHT - MAP_HEIGHT / zoom, view.y)),
  };
}

/**
 * The view after zooming to `zoom` while keeping the map point under the
 * viewport anchor (`anchorFx`, `anchorFy` in [0, 1]) stationary on screen.
 */
function zoomedView(
  view: MapView,
  zoom: number,
  anchorFx: number,
  anchorFy: number,
  maxZoom: number,
): MapView {
  const clamped = Math.max(MIN_ZOOM, Math.min(maxZoom, zoom));
  const mapX = view.x + anchorFx * (MAP_WIDTH / view.zoom);
  const mapY = view.y + anchorFy * (MAP_HEIGHT / view.zoom);
  return clampView({
    zoom: clamped,
    x: mapX - anchorFx * (MAP_WIDTH / clamped),
    y: mapY - anchorFy * (MAP_HEIGHT / clamped),
  }, maxZoom);
}

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

/**
 * Which cells carry decor, chosen once per snapshot.
 *
 * The display loop draws the decor every frame under the zoom transform, and
 * a full sweep of the grid per frame to find the few cells that carry a mark
 * or a structure grew with the higher-resolution world. The lists change only
 * when the world does, so they are indexed per snapshot.
 *
 * Terrain marks are scattered per unit of ground rather than per cell -- one
 * every 197 tuned-world cells, so a finer grid keeps the same sprinkle -- and
 * drawn at the size of a tuned-world cell, so they neither crowd nor shrink
 * when the grid is made finer.
 */
interface DecorIndex {
  marks: number[];
  structures: number[];
}

const DECOR_INDEX = new WeakMap<WorldState, DecorIndex>();

function decorIndexFor(state: WorldState): DecorIndex {
  const cached = DECOR_INDEX.get(state);
  if (cached) return cached;
  const stride = Math.max(1, Math.round(197 * gridDensity(state.config)));
  const marks: number[] = [];
  const structures: number[] = [];
  for (let index = 0; index < state.cells.length; index += 1) {
    if ((index * 17 + state.seed) % stride === 0) marks.push(index);
    const cell = state.cells[index]!;
    if (cell.structure && cell.owner) structures.push(index);
  }
  const built = { marks, structures };
  DECOR_INDEX.set(state, built);
  return built;
}

function drawTerrainTexture(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  index: number,
) {
  const cell = state.cells[index]!;
  const [x, y] = centerFor(index, state, shape);
  const radius = Math.min(shape.cellWidth, shape.cellHeight) * gridFineness(state.config);
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

/**
 * The minor rivers, drawn as thin lines rather than water: a darker bed with
 * a lighter thread over it, following each carved course. They sit under the
 * political layer, so a border resting on a stream reads as a border on a
 * river the way real ones do.
 */
function drawStreams(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
) {
  if (!state.streams || state.streams.length === 0) return;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const course of state.streams) {
    if (course.length < 2) continue;
    context.beginPath();
    traceSmoothedPath(context, state, shape, course);
    context.strokeStyle = "rgba(21, 48, 59, 0.5)";
    context.lineWidth = 2.3;
    context.stroke();
    context.strokeStyle = "rgba(84, 133, 149, 0.9)";
    context.lineWidth = 1.1;
    context.stroke();
  }
  context.restore();
}

const CAMPAIGN_LABEL_POSITIONS = new Map<string, { x: number; y: number }>();

function drawStructure(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  index: number,
) {
  const cell = state.cells[index]!;
  if (!cell.structure || !cell.owner) return;
  const [x, y] = centerFor(index, state, shape);
  // The marker wears the color of the element its owner currently expresses,
  // so a conquest that forges a new tier repaints the realm's marks along
  // with its territory. A capital's glyph still reads the expressed element
  // of the realm founded there, so a captured capital stays storied ground:
  // the conqueror's ring around the fallen realm's mark.
  const family = ELEMENTS[state.factions[cell.owner].expressedElement];
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

/**
 * Trade transports, each about the size of one area pixel, told apart by the
 * elemental signature of the ground they cross rather than by bulk:
 *
 * - a train is *earth*: a solid blocky square, flat on the land;
 * - a ship is *water*: a blunt rounded hull trailing a pale fading wake;
 * - a flyer is *air*: a slim swept chevron casting a small offset ground
 *   shadow, so it reads as above the map rather than on it;
 * - a pulse is *fire*: a white-hot core inside a warm ember glow, running
 *   its conduit like a spark down a wire.
 *
 * Every body still wears its owner's expressed-element color, so ownership
 * and transport kind read independently at a glance.
 */
function drawTradeVehicles(
  context: CanvasRenderingContext2D,
  state: WorldState,
  shape: MapGeometry,
  extrapolatedTicks = 0,
) {
  sweepPathGeometry();
  const px = Math.min(shape.cellWidth, shape.cellHeight);
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
    const color = ELEMENTS[state.factions[vehicle.owner].expressedElement].deepColor;
    if (vehicle.kind === "flyer") {
      // The air signature: the ground shadow falls down-right in map space,
      // detached from the body, before the body itself is drawn.
      context.save();
      context.translate(x + px * 0.32, y + px * 0.38);
      context.rotate(angle);
      context.fillStyle = "rgba(14, 27, 35, 0.28)";
      context.beginPath();
      context.ellipse(0, 0, px * 0.42, px * 0.2, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    if (vehicle.kind === "train") {
      // Earth: one solid square of ground-hauled cargo.
      context.fillStyle = color;
      context.strokeStyle = "rgba(38, 30, 18, 0.9)";
      context.lineWidth = px * 0.14;
      context.beginPath();
      context.rect(-px * 0.41, -px * 0.41, px * 0.82, px * 0.82);
      context.fill();
      context.stroke();
    } else if (vehicle.kind === "ship") {
      // Water: the wake astern, fading with distance, then the blunt hull.
      context.lineCap = "round";
      context.lineWidth = px * 0.18;
      context.strokeStyle = "rgba(214, 240, 252, 0.8)";
      context.beginPath();
      context.moveTo(-px * 0.5, 0);
      context.lineTo(-px * 0.85, 0);
      context.stroke();
      context.strokeStyle = "rgba(214, 240, 252, 0.35)";
      context.beginPath();
      context.moveTo(-px * 1.0, 0);
      context.lineTo(-px * 1.3, 0);
      context.stroke();
      context.fillStyle = color;
      context.strokeStyle = "rgba(255, 250, 226, 0.95)";
      context.lineWidth = px * 0.12;
      context.beginPath();
      context.moveTo(px * 0.5, 0);
      context.lineTo(px * 0.1, -px * 0.34);
      context.lineTo(-px * 0.42, -px * 0.3);
      context.lineTo(-px * 0.42, px * 0.3);
      context.lineTo(px * 0.1, px * 0.34);
      context.closePath();
      context.fill();
      context.stroke();
    } else if (vehicle.kind === "pulse") {
      // Fire: an ember glow around a white-hot core.
      const glow = context.createRadialGradient(0, 0, 0, 0, 0, px * 0.85);
      glow.addColorStop(0, "rgba(255, 244, 214, 0.95)");
      glow.addColorStop(0.4, "rgba(255, 176, 82, 0.65)");
      glow.addColorStop(1, "rgba(255, 140, 50, 0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(0, 0, px * 0.85, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = color;
      context.beginPath();
      context.arc(0, 0, px * 0.3, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "rgba(255, 248, 230, 0.95)";
      context.beginPath();
      context.arc(0, 0, px * 0.14, 0, Math.PI * 2);
      context.fill();
    } else {
      // Air: a slim swept chevron, drawn over its detached shadow.
      context.fillStyle = color;
      context.strokeStyle = "rgba(255, 250, 226, 0.95)";
      context.lineWidth = px * 0.1;
      context.beginPath();
      context.moveTo(px * 0.55, 0);
      context.lineTo(-px * 0.45, -px * 0.42);
      context.lineTo(-px * 0.18, 0);
      context.lineTo(-px * 0.45, px * 0.42);
      context.closePath();
      context.fill();
      context.stroke();
    }
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
    const family = ELEMENTS[state.factions[campaign.attacker].expressedElement];
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
      context.fillStyle = ELEMENTS[faction.expressedElement].deepColor;
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

function createRasterRequest(
  requestId: number,
  state: WorldState,
  selected: PlayerId,
  mapMode: MapMode,
  maps: TheaterCellMaps | null,
  theaterLayer: TheaterLayer,
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
    terrains,
  };
  if (mapMode === "theaters") {
    if (!maps) throw new Error("Theater raster requested without theater intelligence fields");
    return { ...common, mode: "theaters", values: maps[theaterLayer].slice() };
  }
  // One byte per area: who owns it. The worker derives the border from this
  // alone -- an owned area whose neighbour is anything else is perimeter.
  const owners = new Int8Array(state.cells.length).fill(-1);
  for (let index = 0; index < state.cells.length; index += 1) {
    const owner = state.cells[index]!.owner;
    if (owner) owners[index] = RASTER_PLAYER_INDEX.get(owner)!;
  }
  // The color each realm paints with is the documented color of the element
  // it currently expresses, read fresh every frame so an ascension repaints
  // the realm the moment the conquest forges its new tier.
  const playerColors = new Uint8Array(RASTER_PLAYER_ORDER.length * 3);
  for (let index = 0; index < RASTER_PLAYER_ORDER.length; index += 1) {
    const element = ELEMENTS[state.factions[RASTER_PLAYER_ORDER[index]!]!.expressedElement];
    const value = Number.parseInt(element.color.slice(1), 16);
    playerColors[index * 3] = (value >> 16) & 255;
    playerColors[index * 3 + 1] = (value >> 8) & 255;
    playerColors[index * 3 + 2] = value & 255;
  }
  return {
    ...common,
    mode: "political",
    selected: RASTER_PLAYER_INDEX.get(selected)!,
    owners,
    playerColors,
  };
}

function rasterTransferables(request: MapRasterRequest): Transferable[] {
  const transfer: Transferable[] = [request.terrains.buffer];
  if (request.mode === "theaters") {
    transfer.push(request.values.buffer);
  } else {
    transfer.push(request.owners.buffer, request.playerColors.buffer);
  }
  return transfer;
}

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
  const nextRasterRequestRef = useRef(0);
  const latestRasterRequestRef = useRef(0);
  /**
   * The rendered world raster, a flat five-by-five block of canvas pixels per
   * area. The display loop scales it with image smoothing off, so zooming in
   * makes the pixels larger instead of conjuring finer ones; the extra
   * resolution exists so borders and contours can be thin rims.
   */
  const fillCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef(state);
  const selectedRef = useRef(selected);
  const modeRef = useRef(mapMode);
  const theaterLayerRef = useRef(theaterLayer);
  const theaterMapsRef = useRef<TheaterCellMaps | null>(null);
  const playbackRef = useRef(playbackTicksPerSecond);
  const visualTickRef = useRef(state.tick);
  const visualSeedRef = useRef(state.seed);
  const lastAnimationAtRef = useRef(0);
  const fieldDirtyRef = useRef(true);
  const pixelScaleRef = useRef(1);
  const viewRef = useRef<MapView>({ zoom: 1, x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; clientX: number; clientY: number; travelled: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<number | null>(null);
  // Bumped whenever the view changes so React-positioned overlays (the
  // theater tooltip, the zoom readout) re-render; the canvas itself reads
  // viewRef directly every animation frame.
  const [, bumpViewVersion] = useReducer((version: number) => version + 1, 0);
  // The theater appraisal costs tens of milliseconds on the display thread at
  // the higher-resolution world, and snapshots arrive several times a second.
  // It is an appraisal, not a live feed, so it is refreshed once a second of
  // world time rather than on every snapshot.
  const theaterMapsCacheRef = useRef<{ key: string; tick: number; maps: TheaterCellMaps } | null>(null);
  const theaterMaps = useMemo(() => {
    if (mapMode !== "theaters") return null;
    const key = `${state.seed}|${selected}`;
    const cached = theaterMapsCacheRef.current;
    if (
      cached
      && cached.key === key
      && state.tick >= cached.tick
      && state.tick - cached.tick < THEATER_MAP_REFRESH_TICKS
      && cached.maps.composite.length === state.cells.length
    ) return cached.maps;
    const maps = evaluateTheaterCellMaps(state, selected);
    theaterMapsCacheRef.current = { key, tick: state.tick, maps };
    return maps;
  }, [mapMode, selected, state]);

  function applyView(view: MapView): void {
    viewRef.current = view;
    bumpViewVersion();
  }

  /**
   * The field render pump, called once per display frame.
   *
   * A frame is rendered only when the field is dirty -- a new snapshot, a new
   * selection, a mode or layer switch. Ownership is authoritative per cell,
   * so there is nothing to interpolate between snapshots: a cell wears its
   * owner's pixel until the tick it changes hands.
   */
  function maybeDispatchFieldFrame(): void {
    if (!fieldDirtyRef.current || rasterBusyRef.current) return;
    const worker = rasterWorkerRef.current;
    if (!worker) return;
    const mode = modeRef.current;
    if (mode === "theaters" && !theaterMapsRef.current) return;
    const requestId = nextRasterRequestRef.current + 1;
    nextRasterRequestRef.current = requestId;
    latestRasterRequestRef.current = requestId;
    const request = createRasterRequest(
      requestId,
      worldRef.current,
      selectedRef.current,
      mode,
      theaterMapsRef.current,
      theaterLayerRef.current,
    );
    fieldDirtyRef.current = false;
    rasterBusyRef.current = true;
    worker.postMessage(request, rasterTransferables(request));
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
      rasterBusyRef.current = false;
      if (event.data.requestId !== latestRasterRequestRef.current) return;
      const fillCanvas = fillCanvasRef.current ?? document.createElement("canvas");
      fillCanvasRef.current = fillCanvas;
      if (fillCanvas.width !== event.data.rasterWidth) fillCanvas.width = event.data.rasterWidth;
      if (fillCanvas.height !== event.data.rasterHeight) fillCanvas.height = event.data.rasterHeight;
      fillCanvas
        .getContext("2d")
        ?.putImageData(new ImageData(event.data.fill, event.data.rasterWidth, event.data.rasterHeight), 0, 0);
    };
    worker.addEventListener("message", handleRaster);
    return () => {
      worker.removeEventListener("message", handleRaster);
      worker.terminate();
      rasterWorkerRef.current = null;
      rasterBusyRef.current = false;
    };
  }, []);

  // Wheel zoom wants preventDefault, and React registers its wheel handlers
  // passively, so the listener is attached natively.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const view = viewRef.current;
      const anchorFx = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const anchorFy = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
      // Wheels report pixels, lines or pages depending on the browser.
      const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
      viewRef.current = zoomedView(
        view,
        view.zoom * Math.exp(-event.deltaY * deltaScale * WHEEL_ZOOM_RATE),
        anchorFx,
        anchorFy,
        maxZoomFor(worldRef.current),
      );
      // The ground under the pointer changed; a held tooltip would go stale.
      setHoveredCell(null);
      bumpViewVersion();
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    worldRef.current = state;
    selectedRef.current = selected;
    modeRef.current = mapMode;
    theaterLayerRef.current = theaterLayer;
    theaterMapsRef.current = theaterMaps;
    if (visualSeedRef.current !== state.seed) {
      visualSeedRef.current = state.seed;
      visualTickRef.current = state.tick;
      viewRef.current = { zoom: 1, x: 0, y: 0 };
      bumpViewVersion();
    } else {
      visualTickRef.current = Math.max(visualTickRef.current, state.tick);
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
        maybeDispatchFieldFrame();
        const scale = pixelScaleRef.current;
        const view = viewRef.current;
        const worldScale = scale * view.zoom;
        const applyWorldTransform = () => context.setTransform(
          worldScale,
          0,
          0,
          worldScale,
          -view.x * worldScale,
          -view.y * worldScale,
        );
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
        applyWorldTransform();
        const fillCanvas = fillCanvasRef.current;
        if (fillCanvas && fillCanvas.width > 0) {
          // Nearest-neighbour, always: an area is one flat pixel however far
          // the display magnifies it.
          context.save();
          context.imageSmoothingEnabled = false;
          context.drawImage(fillCanvas, 0, 0, MAP_WIDTH, MAP_HEIGHT);
          context.restore();
        }
        const shape = geometry(world);
        if (modeRef.current === "political") {
          const decor = decorIndexFor(world);
          for (const index of decor.marks) drawTerrainTexture(context, world, shape, index);
          drawStreams(context, world, shape);
          drawTradeRoutes(context, world, shape);
          drawAllianceChains(context, world, shape);
          for (const index of decor.structures) drawStructure(context, world, shape, index);
        }
        // The vignette frames the viewport, not the ground: screen space.
        context.setTransform(scale, 0, 0, scale, 0, 0);
        drawVignette(context);
        if (modeRef.current === "political") {
          applyWorldTransform();
          const extrapolatedTicks = Math.max(0, visualTickRef.current - world.tick);
          // Frame-rate-independent easing for the campaign labels.
          const labelBlend = 1 - Math.exp(-elapsedSeconds * 9);
          drawTradeVehicles(context, world, shape, extrapolatedTicks);
          drawCampaigns(context, world, shape, selectedRef.current, showAllTheaters, extrapolatedTicks, labelBlend);
          drawWarships(context, world, shape, world.tick + extrapolatedTicks);
          context.setTransform(scale, 0, 0, scale, 0, 0);
        }
        if (renderMarker !== undefined && fillCanvasRef.current) {
          canvas.dataset.renderedMarker = renderMarker;
        }
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
    if (bounds.width <= 0 || bounds.height <= 0) return -1;
    const view = viewRef.current;
    const mapX = view.x + ((event.clientX - bounds.left) / bounds.width) * (MAP_WIDTH / view.zoom);
    const mapY = view.y + ((event.clientY - bounds.top) / bounds.height) * (MAP_HEIGHT / view.zoom);
    const x = Math.max(0, Math.min(
      state.config.width - 1,
      Math.floor((mapX / MAP_WIDTH) * state.config.width),
    ));
    const y = Math.max(0, Math.min(
      state.config.height - 1,
      Math.floor((mapY / MAP_HEIGHT) * state.config.height),
    ));
    return y * state.config.width + x;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      travelled: 0,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (drag && drag.pointerId === event.pointerId && canvas) {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        const view = viewRef.current;
        const dx = event.clientX - drag.clientX;
        const dy = event.clientY - drag.clientY;
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        drag.travelled += Math.hypot(dx, dy);
        applyView(clampView({
          zoom: view.zoom,
          x: view.x - (dx / bounds.width) * (MAP_WIDTH / view.zoom),
          y: view.y - (dy / bounds.height) * (MAP_HEIGHT / view.zoom),
        }, maxZoomFor(state)));
      }
    }
    if (mapMode !== "theaters") return;
    const index = cellAtPointer(event);
    const next = index >= 0 && state.cells[index]?.terrain !== "water" ? index : null;
    setHoveredCell((previous) => previous === next ? previous : next);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // A press that travelled was a pan; only a tap selects.
    if (drag.travelled > DRAG_SUPPRESS_TAP_PX) return;
    const index = cellAtPointer(event);
    if (index < 0) return;
    if (mapMode === "theaters") {
      setHoveredCell(state.cells[index]?.terrain === "water" ? null : index);
      return;
    }
    const owner = state.cells[index]?.owner;
    if (owner) onSelect(owner);
  }

  function handlePointerCancel() {
    dragRef.current = null;
  }

  function zoomBy(factor: number) {
    const view = viewRef.current;
    applyView(zoomedView(view, view.zoom * factor, 0.5, 0.5, maxZoomFor(state)));
  }

  const view = viewRef.current;
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
    ? [
        (((hoveredPosition[0] + 0.5) * (MAP_WIDTH / state.config.width) - view.x) * view.zoom) / MAP_WIDTH,
        (((hoveredPosition[1] + 0.5) * (MAP_HEIGHT / state.config.height) - view.y) * view.zoom) / MAP_HEIGHT,
      ]
    : null;
  return (
    <div className="world-map-shell">
      <canvas
        ref={canvasRef}
        width={1180}
        height={730}
        className="world-map"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setHoveredCell(null)}
        aria-label={mapMode === "theaters"
          ? `${realmLabel(state, selected)} interpretation of the world's strategic theaters. Green is high value and red is low value.`
          : `Live political and terrain map of ${state.worldName}, one flat block per area. Select a colored player to inspect it; drag to pan and scroll to zoom.`}
      />
      <div className="map-zoom" role="group" aria-label="Map zoom">
        <button type="button" onClick={() => zoomBy(1.5)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => applyView({ zoom: 1, x: 0, y: 0 })} aria-label="Fit whole map">⤢</button>
        <span aria-hidden="true">{view.zoom >= 10 ? Math.round(view.zoom) : view.zoom.toFixed(1)}×</span>
      </div>
      {mapMode === "theaters" && hoveredValue !== null && hoveredBreakdown && tooltipPosition && (
        <div
          className="theater-tooltip"
          style={{
            left: `${tooltipPosition[0]! * 100}%`,
            top: `${tooltipPosition[1]! * 100}%`,
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
          ? `${realmLabel(state, selected)} · ${THEATER_LAYER_LABELS[theaterLayer]} · tick ${state.tick}`
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
          <span><i className="legend-peace" /> border · darker perimeter</span>
          <span><i className="legend-alliance" /> allied border</span>
          <span><i className="legend-earth" /> earth convoys {trains}</span>
          <span><i className="legend-water" /> water ships {ships}</span>
          <span><i className="legend-air" /> air flyers {flyers}</span>
          <span><i className="legend-fire" /> fire pulses {pulses}</span>
        </div>
      )}
      <div className="map-hint" aria-hidden="true">
        {mapMode === "theaters"
          ? "select a realm below to compare strategic values"
          : "drag to pan · scroll to zoom · tap a player to inspect"}
      </div>
    </div>
  );
}
