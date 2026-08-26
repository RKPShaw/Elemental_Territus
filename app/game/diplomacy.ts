import type { NationId, RelationState, WorldState } from "./types";

export function relationKey(first: NationId, second: NationId): string {
  return [first, second].sort().join(":");
}

export function getRelation(
  state: WorldState,
  first: NationId,
  second: NationId,
): RelationState {
  return state.relations[relationKey(first, second)]!;
}

export function isAtWar(state: WorldState, first: NationId, second: NationId): boolean {
  return getRelation(state, first, second).status === "war";
}

export function warsFor(state: WorldState, faction: NationId): RelationState[] {
  return Object.values(state.relations).filter(
    (relation) =>
      relation.status === "war" &&
      relation.parties.includes(faction) &&
      relation.parties.every((id) => state.factions[id].alive),
  );
}

export function peacefulRelationsFor(
  state: WorldState,
  faction: NationId,
): RelationState[] {
  return Object.values(state.relations).filter(
    (relation) =>
      relation.status !== "war" &&
      relation.parties.includes(faction) &&
      relation.parties.every((id) => state.factions[id].alive),
  );
}

export function trucesFor(state: WorldState, faction: NationId): RelationState[] {
  return Object.values(state.relations).filter(
    (relation) =>
      relation.status === "truce" &&
      relation.parties.includes(faction) &&
      relation.parties.every((id) => state.factions[id].alive),
  );
}

export function otherParty(relation: RelationState, faction: NationId): NationId {
  return relation.parties[0] === faction ? relation.parties[1] : relation.parties[0];
}
