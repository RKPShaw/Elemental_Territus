import { draftSites, elementAffinityField } from "./draft";
import { draftOrder, playerElement } from "./players";
import { buildStrategicMetaMap } from "./regions";
import { SPAWN_RULES, gridFineness, normalizedCellLength } from "./rules";
import type { Cell, PlayerId, SimulationConfig } from "./types";

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
 * Chooses a starting capital for every player, one at a time, through the
 * shared settlement draft (draft.ts) — the same engine a fission uses to
 * re-seat freed constituents inside a broken empire.
 *
 * Each player in turn takes the best site still available to it with full
 * knowledge of the map: the shared strategic value field, how well the
 * surrounding terrain suits its element, and the Catan cost of company — a
 * decaying crowding penalty toward everyone already seated, under the hard
 * separation radius that keeps realms from opening on top of each other.
 *
 * The pick order snakes across the elements (see `draftOrder`), which matters
 * because picking sequentially is inherently unfair to whoever picks last: a
 * snake gives that player the first pick of the following round.
 */
export function draftSpawnSites(world: SpawnWorld): SpawnSite[] {
  const meta = buildStrategicMetaMap(world);
  const picks = draftOrder().map((player) => ({
    key: player as string,
    element: playerElement(player),
  }));
  return draftSites(world, picks, {
    value: meta.value,
    affinityOf: (element) => elementAffinityField(world, element, SPAWN_RULES.affinityRadius * gridFineness(world.config)),
    valueWeight: SPAWN_RULES.valueWeight,
    affinityWeight: SPAWN_RULES.affinityWeight,
    crowdingWeight: SPAWN_RULES.crowdingWeight,
    crowdingFalloff: SPAWN_RULES.crowdingFalloff,
    separation: SPAWN_RULES.minimumSeparation,
    separationRelaxation: SPAWN_RULES.separationRelaxation,
  }).map((site) => ({
    player: site.key as PlayerId,
    index: site.index,
    value: site.value,
    affinity: site.affinity,
    score: site.score,
    separation: site.separation,
  }));
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
