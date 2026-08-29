import { ELEMENTS } from "./elements";
import { cellsWithin } from "./grid";
import { normalizedCellLength } from "./rules";
import { terrainLeanOf } from "./terraform";
import type { Cell, ElementId, LandTerrainId, SimulationConfig } from "./types";

/**
 * The settlement draft: how anyone picks ground, at the dawn of the world and
 * ever after.
 *
 * Sequential picks with full knowledge, the way a Catan table seats itself.
 * Each pick in turn takes the best site still available to it, scoring the
 * shared strategic value of the ground against how well the surrounding
 * country suits its element, MINUS the cost of company — a decaying penalty
 * for every seat already taken, so later picks weigh good land against
 * sharing borders with everyone before them. A hard separation radius keeps
 * seats from stacking; when a fragmented map can't satisfy it, the radius
 * relaxes and the round retries, so every pick is always seated somewhere.
 *
 * The world-creation spawn draft and the fission draft (freed constituents
 * re-seating themselves inside a broken empire) are the same call with a
 * different candidate mask and prior seats. Fully deterministic: ties break
 * to the lowest cell index, and nothing here consumes an RNG stream.
 */

export interface DraftWorld {
  cells: Cell[];
  config: SimulationConfig;
}

export interface DraftPick {
  key: string;
  element: ElementId;
}

export interface DraftOptions {
  /** Shared strategic value per cell, 0..1. */
  value: ArrayLike<number>;
  /** Per-element affinity field, 0..1 per cell; cached by the caller. */
  affinityOf: (element: ElementId) => ArrayLike<number>;
  valueWeight: number;
  affinityWeight: number;
  /** Weight of the decaying proximity cost to every earlier seat. */
  crowdingWeight: number;
  /** World units over which a neighbour's crowding cost decays by e. */
  crowdingFalloff: number;
  /** Hard starting separation between seats, world units. */
  separation: number;
  /** Factor the separation shrinks by when no site qualifies. */
  separationRelaxation: number;
  /** Extra candidate mask; water is always excluded regardless. */
  candidate?: (index: number) => boolean;
  /** Seats standing before the first pick (e.g. a rump capital); they block and crowd. */
  priorSites?: readonly number[];
}

export interface DraftedSite {
  key: string;
  element: ElementId;
  index: number;
  /** Shared strategic value of the site, 0..1. */
  value: number;
  /** How well the surrounding terrain suits the element, 0..1. */
  affinity: number;
  /** The crowding cost paid to earlier seats. */
  crowding: number;
  score: number;
  /** Separation actually achieved, in world units; Infinity for a lone first pick. */
  separation: number;
}

/**
 * How much of the land around each cell suits an element: its favoured
 * terrain counts in full, and any terrain its composed lean points toward
 * counts by the lean — so a draft understands terraformed country exactly as
 * well as combat and the economy do.
 */
export function elementAffinityField(
  world: DraftWorld,
  element: ElementId,
  radius: number,
): Float32Array {
  const favoured = ELEMENTS[element].favoredTerrain;
  const field = new Float32Array(world.cells.length);
  for (let index = 0; index < world.cells.length; index += 1) {
    if (world.cells[index]!.terrain === "water") continue;
    let matching = 0;
    let land = 0;
    for (const nearby of cellsWithin(world, index, radius)) {
      const cell = world.cells[nearby]!;
      if (cell.terrain === "water") continue;
      land += 1;
      const terrain = cell.terrain as LandTerrainId;
      const lean = terrainLeanOf(element, terrain);
      matching += Math.max(terrain === favoured ? 1 : 0, Math.min(1, Math.max(0, lean)));
    }
    field[index] = land > 0 ? matching / land : 0;
  }
  return field;
}

/** Marks every cell within `separation` world units of a taken site. */
function blockAround(
  world: DraftWorld,
  blocked: Uint8Array,
  taken: readonly number[],
  separation: number,
): void {
  blocked.fill(0);
  const radiusInCells = separation / normalizedCellLength(world.config);
  for (const index of taken) {
    for (const nearby of cellsWithin(world, index, radiusInCells)) blocked[nearby] = 1;
  }
}

export function draftSites(
  world: DraftWorld,
  picks: readonly DraftPick[],
  options: DraftOptions,
): DraftedSite[] {
  const cellLength = normalizedCellLength(world.config);
  const width = world.config.width;
  const blocked = new Uint8Array(world.cells.length);
  const taken: number[] = [...(options.priorSites ?? [])];
  const sites: DraftedSite[] = [];
  const affinityCache = new Map<ElementId, ArrayLike<number>>();

  const crowdingAt = (index: number): number => {
    if (taken.length === 0 || options.crowdingWeight === 0) return 0;
    const x = index % width;
    const y = (index - x) / width;
    let cost = 0;
    for (const other of taken) {
      const ox = other % width;
      const oy = (other - ox) / width;
      const distance = Math.hypot(x - ox, y - oy) * cellLength;
      cost += Math.exp(-distance / options.crowdingFalloff);
    }
    return cost;
  };

  for (const pick of picks) {
    let field = affinityCache.get(pick.element);
    if (!field) {
      field = options.affinityOf(pick.element);
      affinityCache.set(pick.element, field);
    }

    let separation = options.separation;
    blockAround(world, blocked, taken, separation);
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestParts = { value: 0, affinity: 0, crowding: 0 };
    let exhausted = false;

    while (bestIndex < 0) {
      for (let index = 0; index < world.cells.length; index += 1) {
        if (blocked[index] || world.cells[index]!.terrain === "water") continue;
        if (options.candidate && !options.candidate(index)) continue;
        const value = options.value[index] ?? 0;
        const affinity = field[index] ?? 0;
        const crowding = crowdingAt(index);
        const score = value * options.valueWeight
          + affinity * options.affinityWeight
          - crowding * options.crowdingWeight;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
          bestParts = { value, affinity, crowding };
        }
      }
      if (bestIndex >= 0 || exhausted) break;
      separation *= options.separationRelaxation;
      // Below a cell's width the constraint cannot exclude anything, so the
      // ground genuinely has no room left and any free candidate will do. If
      // even that pass seats nobody, the candidate set itself is empty and
      // this pick goes unseated.
      if (separation < cellLength) {
        blocked.fill(0);
        for (const index of taken) blocked[index] = 1;
        exhausted = true;
        continue;
      }
      blockAround(world, blocked, taken, separation);
    }
    if (bestIndex < 0) continue;

    let closest = Number.POSITIVE_INFINITY;
    for (const other of taken) {
      const ax = bestIndex % width;
      const ay = (bestIndex - ax) / width;
      const bx = other % width;
      const by = (other - bx) / width;
      closest = Math.min(closest, Math.hypot(ax - bx, ay - by) * cellLength);
    }

    sites.push({
      key: pick.key,
      element: pick.element,
      index: bestIndex,
      value: bestParts.value,
      affinity: bestParts.affinity,
      crowding: bestParts.crowding,
      score: bestScore,
      separation: closest,
    });
    taken.push(bestIndex);
  }

  return sites;
}
