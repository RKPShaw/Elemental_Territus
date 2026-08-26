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

export function warsFor(state: WorldState, faction: PlayerId): RelationState[] {
  return Object.values(state.relations).filter(
    (relation) =>
      relation.status === "war" &&
      relation.parties.includes(faction) &&
      relation.parties.every((id) => state.factions[id].alive),
  );
}

export function peacefulRelationsFor(
  state: WorldState,
  faction: PlayerId,
): RelationState[] {
  return Object.values(state.relations).filter(
    (relation) =>
      relation.status !== "war" &&
      relation.parties.includes(faction) &&
      relation.parties.every((id) => state.factions[id].alive),
  );
}

export function trucesFor(state: WorldState, faction: PlayerId): RelationState[] {
  return Object.values(state.relations).filter(
    (relation) =>
      relation.status === "truce" &&
      relation.parties.includes(faction) &&
      relation.parties.every((id) => state.factions[id].alive),
  );
}

export function otherParty(relation: RelationState, faction: PlayerId): PlayerId {
  return relation.parties[0] === faction ? relation.parties[1] : relation.parties[0];
}
