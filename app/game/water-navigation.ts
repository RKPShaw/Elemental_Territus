import { neighborIndices } from "./grid";
import type { WorldState } from "./types";

/**
 * Sea lanes are planned with a weighted A* over the water grid rather than a
 * plain breadth-first search. BFS counted hops, and in open water every
 * monotone staircase between two harbors has the same hop count -- so the
 * reconstructed route degenerated into an "L" that sailed to a corner of the
 * bounding box and turned once. The weighted search measures real distance,
 * may sail diagonally, and pays a premium for hugging the coast, so a voyage
 * now swings a little offshore and rounds the continent on a near-geodesic
 * course to the harbor it is actually bound for.
 */

const WATER_PATH_CACHE = new Map<string, number[] | null>();
const WATER_PATH_CACHE_LIMIT = 10_000;
let cacheSeed: number | null = null;

function cacheFor(state: WorldState): Map<string, number[] | null> {
  if (cacheSeed !== state.seed || WATER_PATH_CACHE.size > WATER_PATH_CACHE_LIMIT) {
    WATER_PATH_CACHE.clear();
    cacheSeed = state.seed;
    shoreDistance = null;
  }
  return WATER_PATH_CACHE;
}

function cacheKey(start: number, destinations: readonly number[]): string {
  return `${start}:${[...destinations].sort((a, b) => a - b).join(",")}`;
}

/**
 * Navigable water is the open sea plus the stream network: streams are minor
 * rivers flagged on land cells, and a transport or merchant ship may sail up
 * one the way it sails the coast, which is what lets a river be crossed --
 * and traded on -- only by ship.
 */
function isNavigableCell(cell: { terrain: string; stream: boolean }): boolean {
  return cell.terrain === "water" || cell.stream;
}

/**
 * Steps from each navigable cell to the nearest unnavigable land, measured
 * cardinally. Land is fixed for a world's lifetime, so the field is computed
 * once per seed and shared by every route search; it is what lets the lane
 * cost prefer open water without re-discovering the coastline on every voyage.
 */
let shoreDistance: Int32Array | null = null;

function shoreDistanceField(state: WorldState): Int32Array {
  if (shoreDistance && shoreDistance.length === state.cells.length) return shoreDistance;
  const { width, height } = state.config;
  const field = new Int32Array(state.cells.length).fill(-1);
  const queue = new Int32Array(state.cells.length);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (!isNavigableCell(state.cells[index]!)) {
      field[index] = 0;
      queue[tail] = index;
      tail += 1;
    }
  }
  while (head < tail) {
    const index = queue[head]!;
    head += 1;
    const x = index % width;
    const y = (index - x) / width;
    const distance = field[index]! + 1;
    if (x > 0 && field[index - 1] < 0) { field[index - 1] = distance; queue[tail] = index - 1; tail += 1; }
    if (x < width - 1 && field[index + 1] < 0) { field[index + 1] = distance; queue[tail] = index + 1; tail += 1; }
    if (y > 0 && field[index - width] < 0) { field[index - width] = distance; queue[tail] = index - width; tail += 1; }
    if (y < height - 1 && field[index + width] < 0) { field[index + width] = distance; queue[tail] = index + width; tail += 1; }
  }
  shoreDistance = field;
  return field;
}

/**
 * The premium a lane pays for sailing this close to land. Shore-adjacent water
 * is markedly dearer than the open sea, so a route only touches the coast to
 * dock or to thread a strait it cannot sail around.
 */
function clearanceWeight(distanceToShore: number): number {
  if (distanceToShore <= 1) return 1.7;
  if (distanceToShore === 2) return 1.2;
  return 1;
}

/** Binary min-heap over cell indices; priorities live in a parallel array. */
class NavHeap {
  private cells = new Int32Array(1024);
  private priorities = new Float64Array(1024);
  private size = 0;

  clear(): void {
    this.size = 0;
  }

  push(cell: number, priority: number): void {
    if (this.size === this.cells.length) this.grow();
    let index = this.size;
    this.size += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent]! <= priority) break;
      this.cells[index] = this.cells[parent]!;
      this.priorities[index] = this.priorities[parent]!;
      index = parent;
    }
    this.cells[index] = cell;
    this.priorities[index] = priority;
  }

  /** Returns the lowest-priority cell, or -1 when empty. */
  pop(): number {
    if (this.size === 0) return -1;
    const root = this.cells[0]!;
    this.size -= 1;
    if (this.size === 0) return root;
    const cell = this.cells[this.size]!;
    const priority = this.priorities[this.size]!;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      const child = right < this.size && this.priorities[right]! < this.priorities[left]! ? right : left;
      if (this.priorities[child]! >= priority) break;
      this.cells[index] = this.cells[child]!;
      this.priorities[index] = this.priorities[child]!;
      index = child;
    }
    this.cells[index] = cell;
    this.priorities[index] = priority;
    return root;
  }

  private grow(): void {
    const cells = new Int32Array(this.cells.length * 2);
    const priorities = new Float64Array(this.priorities.length * 2);
    cells.set(this.cells);
    priorities.set(this.priorities);
    this.cells = cells;
    this.priorities = priorities;
  }
}

// Search scratch reused between calls; a generation stamp marks visited cells
// so a search only pays for the water it actually touches.
const navHeap = new NavHeap();
let navCost = new Float64Array(0);
let navPrevious = new Int32Array(0);
let navStamp = new Int32Array(0);
let navGeneration = 0;

function beginNavSearch(size: number): void {
  if (navCost.length !== size) {
    navCost = new Float64Array(size);
    navPrevious = new Int32Array(size);
    navStamp = new Int32Array(size);
    navGeneration = 0;
  }
  if (navGeneration >= 0x7fffffff) {
    navStamp.fill(0);
    navGeneration = 0;
  }
  navGeneration += 1;
  navHeap.clear();
}

function reconstructWaterPath(reached: number): number[] {
  const reversed: number[] = [];
  for (let index = reached; index >= 0; index = navPrevious[index]!) reversed.push(index);
  return reversed.reverse();
}

/**
 * Finds a contiguous water route that leaves one land cell, remains in water,
 * and lands on any supplied destination cell. The land endpoints are retained
 * in the returned path so renderers never need to invent a shortcut. Interior
 * legs may run diagonally but never cut a land corner; the docking steps at
 * either end stay cardinal so a ship visibly leaves and enters along a berth.
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

  const cache = cacheFor(state);
  const key = cacheKey(startLandCell, destinations);
  if (cache.has(key)) return cache.get(key) ?? null;

  const { width, height } = state.config;
  const starts = neighborIndices(startLandCell, width, height)
    .filter((index) => isNavigableCell(state.cells[index]!));
  const landingByWater = new Map<number, number>();
  for (const destination of destinations) {
    for (const neighbor of neighborIndices(destination, width, height)) {
      if (isNavigableCell(state.cells[neighbor]!) && !landingByWater.has(neighbor)) {
        landingByWater.set(neighbor, destination);
      }
    }
  }
  if (starts.length === 0 || landingByWater.size === 0) {
    cache.set(key, null);
    return null;
  }

  // With few goals the search aims straight at the nearest one; a broad goal
  // set (a whole invaded coastline) degrades gracefully to Dijkstra.
  const goalCoordinates: number[] = [];
  if (landingByWater.size <= 8) {
    for (const landing of landingByWater.keys()) {
      goalCoordinates.push(landing % width, Math.floor(landing / width));
    }
  }
  const heuristic = (x: number, y: number): number => {
    if (goalCoordinates.length === 0) return 0;
    let best = Number.POSITIVE_INFINITY;
    for (let at = 0; at < goalCoordinates.length; at += 2) {
      const distance = Math.hypot(goalCoordinates[at]! - x, goalCoordinates[at + 1]! - y);
      if (distance < best) best = distance;
    }
    return best;
  };

  const shore = shoreDistanceField(state);
  const cells = state.cells;
  const isWater = (index: number): boolean => isNavigableCell(cells[index]!);
  beginNavSearch(cells.length);
  for (const start of starts) {
    navCost[start] = 0;
    navPrevious[start] = -1;
    navStamp[start] = navGeneration;
    navHeap.push(start, heuristic(start % width, Math.floor(start / width)));
  }

  let reached = -1;
  while (reached < 0) {
    const current = navHeap.pop();
    if (current < 0) break;
    if (landingByWater.has(current)) {
      reached = current;
      break;
    }
    const cost = navCost[current]!;
    const x = current % width;
    const y = (current - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const neighbor = ny * width + nx;
        if (!isWater(neighbor)) continue;
        // A diagonal step is only open when both flanking cells are water,
        // so a lane never slips between two touching land corners.
        if (dx !== 0 && dy !== 0 && (!isWater(y * width + nx) || !isWater(ny * width + x))) continue;
        const stepLength = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
        const proposed = cost + stepLength * clearanceWeight(shore[neighbor]!);
        if (navStamp[neighbor] === navGeneration && proposed >= navCost[neighbor]!) continue;
        navStamp[neighbor] = navGeneration;
        navCost[neighbor] = proposed;
        navPrevious[neighbor] = current;
        navHeap.push(neighbor, proposed + heuristic(nx, ny));
      }
    }
  }

  if (reached < 0) {
    cache.set(key, null);
    return null;
  }
  const destination = landingByWater.get(reached)!;
  const path = [startLandCell, ...reconstructWaterPath(reached), destination];
  cache.set(key, path);
  return path;
}

export function waterPathBetweenLandCells(
  state: WorldState,
  startLandCell: number,
  endLandCell: number,
): number[] | null {
  return waterPathToAnyLandCell(state, startLandCell, [endLandCell]);
}

/**
 * True only when the endpoints are land, every interior cell is navigable
 * water (sea, river, or a stream cell), the docking steps at either end are
 * cardinal, and every interior step is at most one cell in each axis without
 * cutting a land corner.
 */
export function isValidWaterPath(state: WorldState, path: readonly number[]): boolean {
  if (path.length < 3) return false;
  const { width } = state.config;
  const cells = state.cells;
  if (cells[path[0]!]!.terrain === "water" || cells[path[path.length - 1]!]!.terrain === "water") {
    return false;
  }
  for (let position = 1; position < path.length - 1; position += 1) {
    if (!isNavigableCell(cells[path[position]!]!)) return false;
  }
  for (let position = 1; position < path.length; position += 1) {
    const from = path[position - 1]!;
    const to = path[position]!;
    const fx = from % width;
    const fy = (from - fx) / width;
    const tx = to % width;
    const ty = (to - tx) / width;
    const dx = tx - fx;
    const dy = ty - fy;
    if (dx === 0 && dy === 0) return false;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
    const docking = position === 1 || position === path.length - 1;
    if (docking && dx !== 0 && dy !== 0) return false;
    if (dx !== 0 && dy !== 0) {
      const across = fy * width + tx;
      const down = ty * width + fx;
      if (!isNavigableCell(cells[across]!) || !isNavigableCell(cells[down]!)) return false;
    }
  }
  return true;
}
