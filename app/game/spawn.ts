import { ELEMENTS } from "./elements";
import { cellsWithin } from "./grid";
import { draftOrder, playerElement } from "./players";
import { buildStrategicMetaMap } from "./regions";
import { SPAWN_RULES, normalizedCellLength } from "./rules";
import type { Cell, ElementId, PlayerId, SimulationConfig } from "./types";

interface SpawnWorld {
  cells: Cell[];
  config: SimulationConfig;
}

export interface SpawnSite {
  player: PlayerId;
  index: number;
  /** Shared strategic value of the site, 0..1. */
  value: number;
  /** How well the surrounding terrain suits the player's element, 0..1. */
  affinity: number;
  score: number;
  /** Separation actually achieved, in world units; Infinity for the first pick. */
  separation: number;
}

/**
 * How much of the land around each cell matches an element's favoured terrain.
 *
 * Sampled over a neighbourhood rather than the single cell, because a realm
 * lives off the country around its capital, not the one tile under it.
 */
function affinityField(world: SpawnWorld, element: ElementId): Float32Array {
  const favoured = ELEMENTS[element].favoredTerrain;
  const field = new Float32Array(world.cells.length);
  for (let index = 0; index < world.cells.length; index += 1) {
    if (world.cells[index]!.terrain === "water") continue;
    let matching = 0;
    let land = 0;
    for (const nearby of cellsWithin(world, index, SPAWN_RULES.affinityRadius)) {
      const cell = world.cells[nearby]!;
      if (cell.terrain === "water") continue;
      land += 1;
      if (cell.terrain === favoured) matching += 1;
    }
    field[index] = land > 0 ? matching / land : 0;
  }
  return field;
}

/** Marks every cell within `separation` world units of a taken site as unavailable. */
function blockAround(
  world: SpawnWorld,
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

/**
 * Chooses a starting capital for every player, one at a time.
 *
 * Each player in turn takes the best site still available to it, scoring the
 * shared strategic value field against how well the surrounding terrain suits
 * its element. Sites already claimed block a radius around them, so realms open
 * apart rather than on top of each other.
 *
 * The pick order snakes across the elements (see `draftOrder`), which matters
 * because picking sequentially is inherently unfair to whoever picks last: a
 * snake gives that player the first pick of the following round.
 *
 * When no site satisfies the separation -- a fragmented world, or simply the
 * last few picks -- the requirement relaxes and the round is retried, so every
 * player is always seated somewhere.
 */
export function draftSpawnSites(world: SpawnWorld): SpawnSite[] {
  const meta = buildStrategicMetaMap(world);
  const affinity: Partial<Record<ElementId, Float32Array>> = {};
  const blocked = new Uint8Array(world.cells.length);
  const taken: number[] = [];
  const sites: SpawnSite[] = [];
  const cellLength = normalizedCellLength(world.config);

  for (const player of draftOrder()) {
    const element = playerElement(player);
    affinity[element] ??= affinityField(world, element);
    const field = affinity[element]!;

    let separation = SPAWN_RULES.minimumSeparation;
    blockAround(world, blocked, taken, separation);
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    while (bestIndex < 0) {
      for (let index = 0; index < world.cells.length; index += 1) {
        if (blocked[index] || world.cells[index]!.terrain === "water") continue;
        const score = meta.value[index]! * SPAWN_RULES.valueWeight
          + field[index]! * SPAWN_RULES.affinityWeight;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0) break;
      separation *= SPAWN_RULES.separationRelaxation;
      // Below a cell's width the constraint cannot exclude anything, so the
      // world genuinely has no room left and any free land will do.
      if (separation < cellLength) {
        blocked.fill(0);
        for (const index of taken) blocked[index] = 1;
        continue;
      }
      blockAround(world, blocked, taken, separation);
    }

    let closest = Number.POSITIVE_INFINITY;
    for (const other of taken) {
      const ax = bestIndex % world.config.width;
      const ay = (bestIndex - ax) / world.config.width;
      const bx = other % world.config.width;
      const by = (other - bx) / world.config.width;
      closest = Math.min(closest, Math.hypot(ax - bx, ay - by) * cellLength);
    }

    sites.push({
      player,
      index: bestIndex,
      value: meta.value[bestIndex]!,
      affinity: field[bestIndex]!,
      score: bestScore,
      separation: closest,
    });
    taken.push(bestIndex);
  }

  return sites;
}

/**
 * Assigns opening territory: each land cell falls to the nearest start within
 * the opening radius, leaving the rest of the world as wilderness to settle.
 */
export function claimInitialTerritory(
  world: SpawnWorld,
  sites: readonly SpawnSite[],
): void {
  const { width } = world.config;
  const radius = SPAWN_RULES.initialRegionRadius / normalizedCellLength(world.config);
  for (let index = 0; index < world.cells.length; index += 1) {
    const cell = world.cells[index]!;
    if (cell.terrain === "water") continue;
    const x = index % width;
    const y = (index - x) / width;
    let owner: PlayerId | null = null;
    let bestDistance = radius;
    for (const site of sites) {
      const sx = site.index % width;
      const sy = (site.index - sx) / width;
      const distance = Math.hypot(x - sx, y - sy);
      if (distance <= bestDistance) {
        bestDistance = distance;
        owner = site.player;
      }
    }
    cell.owner = owner;
  }
}
