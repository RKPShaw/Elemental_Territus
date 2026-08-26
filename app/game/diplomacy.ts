import type { PlayerId, RelationState, WorldState } from "./types";

export function relationKey(first: PlayerId, second: PlayerId): string {
  return [first, second].sort().join(":");
}

export function getRelation(
  state: WorldState,
  first: PlayerId,
  second: PlayerId,
): RelationState {
  return state.relations[relationKey(first, second)]!;
}

export function isAtWar(state: WorldState, first: PlayerId, second: PlayerId): boolean {
  return getRelation(state, first, second).status === "war";
}

const ADJACENCY = new WeakMap<object, Map<PlayerId, RelationState[]>>();
const NO_RELATIONS: readonly RelationState[] = [];

/**
 * The relations touching each player.
 *
 * Which two players a relation joins never changes once a world exists -- only
 * its status, timers and trade flags do -- so this adjacency is built once and
 * reused for the life of the world.
 *
 * It matters because the table is quadratic in the roster: P(P-1)/2 entries,
 * which is 10 relations for five players but 4,950 for a hundred. Answering
 * "which wars is this player in" by walking the whole table costs O(P^2) per
 * player and O(P^3) per system per tick, and it allocates a fresh array of
 * every relation in the world each time it is asked. Through the adjacency the
 * same question costs O(P).
 *
 * Iteration order matches a walk of the full table, so the relation lists are
 * identical to what filtering the table produced and the simulation is
 * unchanged.
 */
function adjacency(state: WorldState): Map<PlayerId, RelationState[]> {
  const cached = ADJACENCY.get(state.relations);
  if (cached) return cached;
  const built = new Map<PlayerId, RelationState[]>();
  for (const relation of Object.values(state.relations)) {
    for (const party of relation.parties) {
      const existing = built.get(party);
      if (existing) existing.push(relation);
      else built.set(party, [relation]);
    }
  }
  ADJACENCY.set(state.relations, built);
  return built;
}

const ALL_RELATIONS = new WeakMap<object, RelationState[]>();

/**
 * Every relation in the world, as a stable array.
 *
 * The set of relations is fixed once a world exists, so systems that must sweep
 * all of them can reuse one array instead of materialising P(P-1)/2 entries
 * afresh every tick.
 */
export function allRelations(state: WorldState): readonly RelationState[] {
  const cached = ALL_RELATIONS.get(state.relations);
  if (cached) return cached;
  const built = Object.values(state.relations);
  ALL_RELATIONS.set(state.relations, built);
  return built;
}

/** Every relation this player is a party to, in world order. */
export function relationsFor(state: WorldState, faction: PlayerId): readonly RelationState[] {
  return adjacency(state).get(faction) ?? NO_RELATIONS;
}

function bothAlive(state: WorldState, relation: RelationState): boolean {
  return state.factions[relation.parties[0]]!.alive && state.factions[relation.parties[1]]!.alive;
}

export function warsFor(state: WorldState, faction: PlayerId): RelationState[] {
  const result: RelationState[] = [];
  for (const relation of relationsFor(state, faction)) {
    if (relation.status === "war" && bothAlive(state, relation)) result.push(relation);
  }
  return result;
}

export function peacefulRelationsFor(
  state: WorldState,
  faction: PlayerId,
): RelationState[] {
  const result: RelationState[] = [];
  for (const relation of relationsFor(state, faction)) {
    if (relation.status !== "war" && bothAlive(state, relation)) result.push(relation);
  }
  return result;
}

export function trucesFor(state: WorldState, faction: PlayerId): RelationState[] {
  const result: RelationState[] = [];
  for (const relation of relationsFor(state, faction)) {
    if (relation.status === "truce" && bothAlive(state, relation)) result.push(relation);
  }
  return result;
}

export function otherParty(relation: RelationState, faction: PlayerId): PlayerId {
  return relation.parties[0] === faction ? relation.parties[1] : relation.parties[0];
}

/**
 * How many live wars and truces each player holds, counted in one pass.
 *
 * The diplomacy planner asks both of a player several times per relation, and
 * the roster has a quadratic number of relations, so asking through warsFor and
 * trucesFor allocated thousands of throwaway arrays a tick. Nothing in the
 * planner changes a relation -- it queues commands, which are applied later --
 * so a tally taken once at the top of a pass stays correct for the whole of it.
 */
export interface RelationCounts {
  wars: Map<PlayerId, number>;
  truces: Map<PlayerId, number>;
}

export function countRelationStatuses(state: WorldState): RelationCounts {
  const wars = new Map<PlayerId, number>();
  const truces = new Map<PlayerId, number>();
  for (const relation of allRelations(state)) {
    if (relation.status !== "war" && relation.status !== "truce") continue;
    if (!bothAlive(state, relation)) continue;
    const tally = relation.status === "war" ? wars : truces;
    for (const party of relation.parties) {
      tally.set(party, (tally.get(party) ?? 0) + 1);
    }
  }
  return { wars, truces };
}
