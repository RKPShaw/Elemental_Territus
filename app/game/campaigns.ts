import type { NationId, WorldState } from "./types";

/** Troops currently reserved into active attacks and absent from home growth. */
export function committedTroopsFor(state: WorldState, faction: NationId): number {
  return state.campaigns.reduce(
    (total, campaign) =>
      total +
      (campaign.attacker === faction ? campaign.remaining : 0) +
      (campaign.target === faction ? campaign.defenderRemaining : 0),
    0,
  );
}

/** All living troops, whether at home or currently committed to a campaign. */
export function livingTroopsFor(state: WorldState, faction: NationId): number {
  return state.factions[faction].troops + committedTroopsFor(state, faction);
}
