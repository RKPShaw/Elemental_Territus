import type { PlayerId, StructureType, WorldState } from "./types";

/**
 * Where every player's structures are, indexed once and reused.
 *
 * Asking "where are this player's factories" by sweeping the map costs a full
 * pass over seventeen thousand cells. The trade system asks it four times per
 * player per tick -- to build rail nodes, to spawn trains, to spawn ships --
 * so with a hundred players that is four hundred sweeps, seven million cell
 * visits, for a question one pass answers for everyone.
 *
 * Structures move rarely: they are built, upgraded, or change hands with the
 * ground under them. So rather than caching per tick and risking a stale answer
 * mid-tick, the index is invalidated explicitly by the handful of places that
 * move one, and rebuilt on the next request. In a normal tick that is at most a
 * couple of rebuilds instead of four hundred sweeps.
 */
export interface StructureIndex {
  byOwner: Map<PlayerId, Record<StructureType, number[]>>;
  /** Coastal land cells per owner, ascending; harbours and landings need them. */
  coastalByOwner: Map<PlayerId, number[]>;
}

const NO_SITES: Record<StructureType, number[]> = {
  city: [], fort: [], factory: [], harbor: [],
};
const NO_CELLS: readonly number[] = [];

const CACHE = new WeakMap<object, { revision: number; index: StructureIndex }>();
const REVISIONS = new WeakMap<object, number>();

/**
 * Call after changing a cell's owner, structure or structure level. Cheap: it
 * bumps a counter, and the index rebuilds only when something next reads it.
 */
export function markCellsChanged(state: Pick<WorldState, "cells">): void {
  REVISIONS.set(state.cells, (REVISIONS.get(state.cells) ?? 0) + 1);
}

/** Bumped whenever ground or structures move; lets callers memoize safely. */
export function cellRevision(state: Pick<WorldState, "cells">): number {
  return REVISIONS.get(state.cells) ?? 0;
}

function build(state: WorldState): StructureIndex {
  const byOwner = new Map<PlayerId, Record<StructureType, number[]>>();
  const coastalByOwner = new Map<PlayerId, number[]>();
  const cells = state.cells;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    const owner = cell.owner;
    if (owner === null) continue;
    if (cell.structure) {
      let sites = byOwner.get(owner);
      if (!sites) {
        sites = { city: [], fort: [], factory: [], harbor: [] };
        byOwner.set(owner, sites);
      }
      sites[cell.structure].push(index);
    }
    if (cell.coastal) {
      const coastal = coastalByOwner.get(owner);
      if (coastal) coastal.push(index);
      else coastalByOwner.set(owner, [index]);
    }
  }
  return { byOwner, coastalByOwner };
}

export function structureIndex(state: WorldState): StructureIndex {
  const revision = REVISIONS.get(state.cells) ?? 0;
  const cached = CACHE.get(state.cells);
  if (cached && cached.revision === revision) return cached.index;
  const index = build(state);
  CACHE.set(state.cells, { revision, index });
  return index;
}

/** A player's sites of one kind, ascending by cell index. */
export function sitesOf(
  state: WorldState,
  owner: PlayerId,
  structure: StructureType,
): readonly number[] {
  return (structureIndex(state).byOwner.get(owner) ?? NO_SITES)[structure];
}

export function coastalOf(state: WorldState, owner: PlayerId): readonly number[] {
  return structureIndex(state).coastalByOwner.get(owner) ?? NO_CELLS;
}
