import { neighborIndices } from "./grid";
import type { WorldState } from "./types";

const WATER_PATH_CACHE = new Map<string, number[] | null>();

function cacheKey(state: WorldState, start: number, destinations: readonly number[]): string {
  return `${state.seed}:${start}:${[...destinations].sort((a, b) => a - b).join(",")}`;
}

function reconstructWaterPath(previous: Int32Array, reached: number): number[] {
  const reversed: number[] = [];
  for (let index = reached; index >= 0; index = previous[index]!) reversed.push(index);
  return reversed.reverse();
}

/**
 * Finds a contiguous cardinal route that leaves one land cell, remains in
 * water, and lands on any supplied destination cell. The land endpoints are
 * retained in the returned path so renderers never need to invent a shortcut.
 */
export function waterPathToAnyLandCell(
  state: WorldState,
  startLandCell: number,
  destinationLandCells: readonly number[],
): number[] | null {
  const destinations = destinationLandCells.filter((index) => {
    const cell = state.cells[index];
    return cell !== undefined && cell.terrain !== "water";
  });
  if (destinations.length === 0 || state.cells[startLandCell]?.terrain === "water") return null;

  const key = cacheKey(state, startLandCell, destinations);
  if (WATER_PATH_CACHE.has(key)) return WATER_PATH_CACHE.get(key) ?? null;

  const starts = neighborIndices(startLandCell, state.config.width, state.config.height)
    .filter((index) => state.cells[index]!.terrain === "water");
  const landingByWater = new Map<number, number>();
  for (const destination of destinations) {
    for (const neighbor of neighborIndices(destination, state.config.width, state.config.height)) {
      if (state.cells[neighbor]!.terrain === "water" && !landingByWater.has(neighbor)) {
        landingByWater.set(neighbor, destination);
      }
    }
  }
  if (starts.length === 0 || landingByWater.size === 0) {
    WATER_PATH_CACHE.set(key, null);
    return null;
  }

  const previous = new Int32Array(state.cells.length);
  previous.fill(-2);
  const queue = [...starts];
  for (const start of starts) previous[start] = -1;
  let reached = -1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!;
    if (landingByWater.has(index)) {
      reached = index;
      break;
    }
    for (const neighbor of neighborIndices(index, state.config.width, state.config.height)) {
      if (previous[neighbor] !== -2 || state.cells[neighbor]!.terrain !== "water") continue;
      previous[neighbor] = index;
      queue.push(neighbor);
    }
  }

  if (reached < 0) {
    WATER_PATH_CACHE.set(key, null);
    return null;
  }
  const destination = landingByWater.get(reached)!;
  const path = smoothWaterPath(
    state,
    [startLandCell, ...reconstructWaterPath(previous, reached), destination],
  );
  WATER_PATH_CACHE.set(key, path);
  return path;
}

/** Every cell a straight line between two cells passes through. */
function lineCells(state: WorldState, from: number, to: number): number[] {
  const width = state.config.width;
  const ax = from % width;
  const ay = (from - ax) / width;
  const bx = to % width;
  const by = (to - bx) / width;
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  const cells: number[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    const x = Math.round(ax + (bx - ax) * t);
    const y = Math.round(ay + (by - ay) * t);
    const index = y * width + x;
    if (cells[cells.length - 1] !== index) cells.push(index);
  }
  return cells;
}

/** True when a vessel can sail straight between two cells without crossing land. */
function clearWaterRun(state: WorldState, from: number, to: number): boolean {
  const cells = lineCells(state, from, to);
  for (let position = 1; position < cells.length - 1; position += 1) {
    if (state.cells[cells[position]!]!.terrain !== "water") return false;
  }
  return true;
}

/**
 * Turns a cardinal search path into sea lanes.
 *
 * The search walks north-south-east-west, so its route around a headland is a
 * staircase hugging the shore. Drawn as straight lines between cell centres
 * that reads as a ship grinding along the coast and clipping every corner,
 * because the line between two diagonal steps cuts inside the land they were
 * stepping around. Waypoints a vessel can simply sail past are dropped, which
 * leaves the long straight runs an actual sea route is made of.
 */
function smoothWaterPath(state: WorldState, path: readonly number[]): number[] {
  if (path.length <= 2) return [...path];
  const smoothed = [path[0]!];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let furthest = anchor + 1;
    for (let candidate = path.length - 1; candidate > anchor + 1; candidate -= 1) {
      if (clearWaterRun(state, path[anchor]!, path[candidate]!)) {
        furthest = candidate;
        break;
      }
    }
    smoothed.push(path[furthest]!);
    anchor = furthest;
  }
  return smoothed;
}

export function waterPathBetweenLandCells(
  state: WorldState,
  startLandCell: number,
  endLandCell: number,
): number[] | null {
  return waterPathToAnyLandCell(state, startLandCell, [endLandCell]);
}

/** True only when endpoints are land, every interior cell is water, and each step is cardinally adjacent. */
export function isValidWaterPath(state: WorldState, path: readonly number[]): boolean {
  if (path.length < 3) return false;
  if (state.cells[path[0]!]!.terrain === "water" || state.cells[path[path.length - 1]!]!.terrain === "water") {
    return false;
  }
  for (let position = 1; position < path.length - 1; position += 1) {
    if (state.cells[path[position]!]!.terrain !== "water") return false;
  }
  // Legs are sailed, not stepped: a route is valid when open water lies between
  // each pair of waypoints. Requiring cardinal adjacency instead rejected every
  // smoothed route, and a rejected route is a ship the map declines to draw --
  // which is what made vessels wink out and reappear.
  for (let position = 1; position < path.length; position += 1) {
    if (!clearWaterRun(state, path[position - 1]!, path[position]!)) return false;
  }
  return true;
}
