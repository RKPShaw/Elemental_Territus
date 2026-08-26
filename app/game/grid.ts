import type { PlayerId, WorldState } from "./types";
import { STRUCTURE_MIN_SPACING, normalizedCellLength } from "./rules";

const CARDINAL = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

const SURROUNDING = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

export function cellIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

export function cellCoordinates(index: number, width: number): [number, number] {
  return [index % width, Math.floor(index / width)];
}

function neighborsFrom(
  index: number,
  width: number,
  height: number,
  offsets: readonly (readonly [number, number])[],
): number[] {
  const [x, y] = cellCoordinates(index, width);
  const result: number[] = [];
  for (const [dx, dy] of offsets) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
      result.push(cellIndex(nx, ny, width));
    }
  }
  return result;
}

export function neighborIndices(index: number, width: number, height: number): number[] {
  return neighborsFrom(index, width, height, CARDINAL);
}

export function surroundingIndices(index: number, width: number, height: number): number[] {
  return neighborsFrom(index, width, height, SURROUNDING);
}

export function isFrontierCell(state: WorldState, index: number): boolean {
  const owner = state.cells[index]!.owner;
  if (!owner) return false;
  return neighborIndices(index, state.config.width, state.config.height).some(
    (neighbor) => state.cells[neighbor]!.owner !== owner,
  );
}

export function borderLength(
  state: WorldState,
  first: PlayerId,
  second: PlayerId,
): number {
  let edges = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index]!.owner !== first) continue;
    for (const neighbor of neighborIndices(index, state.config.width, state.config.height)) {
      if (state.cells[neighbor]!.owner === second) edges += 1;
    }
  }
  return edges;
}

export function frontTargets(
  state: WorldState,
  attacker: PlayerId,
  defender: PlayerId,
): number[] {
  const targets: number[] = [];
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index]!.owner !== defender) continue;
    if (
      neighborIndices(index, state.config.width, state.config.height).some(
        (neighbor) => state.cells[neighbor]!.owner === attacker,
      )
    ) {
      targets.push(index);
    }
  }
  return targets;
}

export function ownedNeighborCount(
  state: WorldState,
  index: number,
  owner: PlayerId,
): number {
  return neighborIndices(index, state.config.width, state.config.height).reduce(
    (total, neighbor) => total + (state.cells[neighbor]!.owner === owner ? 1 : 0),
    0,
  );
}

export function cellsWithin(
  state: WorldState,
  centerIndex: number,
  radius: number,
): number[] {
  const [cx, cy] = cellCoordinates(centerIndex, state.config.width);
  const result: number[] = [];
  const minY = Math.max(0, Math.ceil(cy - radius));
  const maxY = Math.min(state.config.height - 1, Math.floor(cy + radius));
  const minX = Math.max(0, Math.ceil(cx - radius));
  const maxX = Math.min(state.config.width - 1, Math.floor(cx + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (Math.hypot(x - cx, y - cy) <= radius) result.push(cellIndex(x, y, state.config.width));
    }
  }
  return result;
}

export function distanceBetween(state: WorldState, first: number, second: number): number {
  // Coordinates are derived inline rather than through cellCoordinates: this is
  // called millions of times per tick by the build and trade planners, and a
  // returned tuple per endpoint dominated its cost.
  const width = state.config.width;
  const ax = first % width;
  const ay = (first - ax) / width;
  const bx = second % width;
  const by = (second - bx) / width;
  return Math.hypot(ax - bx, ay - by) * normalizedCellLength(state.config);
}

export function structureCells(
  state: WorldState,
  owner: PlayerId,
  structure: WorldState["cells"][number]["structure"],
): number[] {
  const result: number[] = [];
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.owner === owner && cell.structure === structure) result.push(index);
  }
  return result;
}

/** A new physical site must be spaced from every structure. City stacking is validated separately. */
export function canPlaceStructureSite(
  state: WorldState,
  index: number,
  reserved: ReadonlySet<number> = new Set(),
): boolean {
  if (reserved.has(index)) return false;
  const cell = state.cells[index];
  if (!cell || cell.terrain === "water" || cell.structure) return false;
  const searchRadius = STRUCTURE_MIN_SPACING / normalizedCellLength(state.config);
  for (const candidate of cellsWithin(state, index, searchRadius)) {
    if (!state.cells[candidate]!.structure && !reserved.has(candidate)) continue;
    if (distanceBetween(state, index, candidate) < STRUCTURE_MIN_SPACING) return false;
  }
  return true;
}

export function coastalCells(state: WorldState, owner: PlayerId): number[] {
  const result: number[] = [];
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.owner === owner && cell.coastal) result.push(index);
  }
  return result;
}
