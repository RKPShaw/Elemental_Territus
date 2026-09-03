import { ELEMENTS } from "./elements";
import { LAND_TERRAINS } from "./rules";
import { terrainLeanOf } from "./terraform";
import { RELATED_TERRAINS } from "./theater-intelligence";
import { OBSERVED_LAYERS, believedValue } from "./theater-map";
import type { ObservedLayer } from "./theater-map";
import type { LandTerrainId, PlayerId, WorldState } from "./types";

/**
 * How each system reads the shared map.
 *
 * The theater map publishes layers and no verdict, because its readers want
 * incompatible things from the same ground. A settler wants the best land it
 * can reach. The build planner wants to level a country -- works where yield is
 * poor, forts where it is rich and worth holding -- so it reads the same layer
 * inverted. A single "goodness" number could serve one of them and would
 * quietly mislead the other.
 *
 * A lens is that policy, named and kept in one place: a small combination of
 * what is common knowledge about a cell and what its owner believes about the
 * region around it.
 *
 * That composition is the point. Two tiles with identical terrain score
 * differently when they sit in different regions, because terrain is only what
 * the ground *is* -- the region's remembered infrastructure, how weakly it is
 * held, and what it is worth are what make it attractive. A player that has
 * never looked at a region gets the bare terrain reading, which is the right
 * answer for someone who knows nothing beyond the shape of the land.
 */

export const LENSES = ["settle", "composite"] as const;
export type LensName = (typeof LENSES)[number];

export interface Lens {
  /** Score for one cell. Higher is more attractive to this lens. */
  at(index: number): number;
}

/** How well a terrain suits a player, counting the elements it has absorbed. */
function elementFitOf(state: WorldState, viewer: PlayerId): (terrain: LandTerrainId) => number {
  const favoured = new Set<LandTerrainId>();
  const related = new Set<LandTerrainId>();
  for (const element of state.factions[viewer]!.absorbedElements) {
    const home = ELEMENTS[element].favoredTerrain;
    favoured.add(home);
    for (const near of RELATED_TERRAINS[home]) related.add(near);
    // Terraformed ground the element leans toward counts as home country
    // too, so an obsidian court settles toward basalt and a fungus court
    // toward its mires without either being told to.
    for (const terrain of LAND_TERRAINS) {
      const lean = terrainLeanOf(element, terrain);
      if (lean > 0.05) favoured.add(terrain);
      else if (lean > 0) related.add(terrain);
    }
  }
  return (terrain) => (favoured.has(terrain) ? 1 : related.has(terrain) ? 0.45 : 0);
}

/**
 * A player's beliefs about every region, read once.
 *
 * believedValue merges across a sight group, so asking it per cell would walk
 * the group and the roster for all forty thousand cells. Regions number in
 * the dozens, so the whole belief set is gathered up front and the per-cell
 * read is an array index.
 */
function beliefsOf(state: WorldState, viewer: PlayerId): Record<ObservedLayer, Float64Array> {
  const count = state.theaterMap.regionCount;
  const beliefs = {} as Record<ObservedLayer, Float64Array>;
  for (const layer of OBSERVED_LAYERS) {
    const values = new Float64Array(count);
    for (let regionId = 0; regionId < count; regionId += 1) {
      values[regionId] = believedValue(state, viewer, regionId, layer).value;
    }
    beliefs[layer] = values;
  }
  return beliefs;
}

const LENS_CACHE = new WeakMap<object, Map<string, { tick: number; lens: Lens }>>();

/**
 * A lens over the world as one player sees it.
 *
 * Cached for the tick: several campaigns belonging to one player ask the same
 * question about the same ground, and rebuilding the belief set per campaign
 * would put the roster back inside the per-cell loop.
 */
export function openLens(state: WorldState, viewer: PlayerId, name: LensName): Lens {
  const key = `${viewer}|${name}`;
  let cache = LENS_CACHE.get(state);
  if (!cache) {
    cache = new Map();
    LENS_CACHE.set(state, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.tick === state.tick) return cached.lens;

  const beliefs = beliefsOf(state, viewer);
  const fitOf = elementFitOf(state, viewer);
  const meta = state.strategicMeta;
  const regionByCell = state.regionByCell;
  const cells = state.cells;
  const lens = name === "settle"
    ? buildSettleLens(cells, meta, regionByCell, beliefs, fitOf)
    : buildCompositeLens(cells, meta, regionByCell, beliefs, fitOf);

  cache.set(key, { tick: state.tick, lens });
  return lens;
}

type CellFit = (terrain: LandTerrainId) => number;

/**
 * What a settler wants: productive, easy ground it suits, in a region worth
 * having and open enough to take.
 *
 * The region terms only ever add, so ground a player has never seen scores on
 * its terrain alone rather than being written off for being unknown -- an
 * unexplored valley should look like a valley, not like nothing.
 */
function buildSettleLens(
  cells: WorldState["cells"],
  meta: WorldState["strategicMeta"],
  regionByCell: readonly number[],
  beliefs: Record<ObservedLayer, Float64Array>,
  fitOf: CellFit,
): Lens {
  return {
    at(index: number): number {
      const cell = cells[index]!;
      if (cell.terrain === "water") return 0;
      const base = meta.productivity[index]! * 0.45
        + (1 - meta.relief[index]! * 0.78) * 0.3
        + fitOf(cell.terrain as LandTerrainId) * 0.25;
      const regionId = regionByCell[index]!;
      if (regionId < 0) return base;
      const shade = beliefs.prize[regionId]! * 0.3
        + beliefs.access[regionId]! * 0.2
        + beliefs.undefended[regionId]! * 0.15;
      return base * (1 + shade);
    },
  };
}

/**
 * The general-purpose reading, and what the intelligence overlay draws.
 *
 * This used to be a stored layer -- a blend kept in the world alongside its own
 * parts. It is a lens now, because a blend is a policy and the map holds none.
 */
function buildCompositeLens(
  cells: WorldState["cells"],
  meta: WorldState["strategicMeta"],
  regionByCell: readonly number[],
  beliefs: Record<ObservedLayer, Float64Array>,
  fitOf: CellFit,
): Lens {
  return {
    at(index: number): number {
      const cell = cells[index]!;
      if (cell.terrain === "water") return 0;
      const base = meta.productivity[index]! * 0.34
        + (1 - meta.relief[index]! * 0.78) * 0.2
        + fitOf(cell.terrain as LandTerrainId) * 0.2
        + meta.infrastructure[index]! * 0.26;
      const regionId = regionByCell[index]!;
      if (regionId < 0) return base;
      const shade = beliefs.prize[regionId]! * 0.25
        + beliefs.infrastructure[regionId]! * 0.2
        + beliefs.access[regionId]! * 0.15;
      return base * (1 + shade);
    },
  };
}
