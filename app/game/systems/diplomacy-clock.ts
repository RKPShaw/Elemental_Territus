
import { realmTitle } from "../naming";
import { allRelations } from "../diplomacy";
import { PLAYERS } from "../players";
import { realmSubject } from "../reporting";
import { DIPLOMACY_RULES } from "../rules";
import type { SimulationContext, SimulationSystem } from "../types";

export class DiplomacyClockSystem implements SimulationSystem {
  readonly id = "diplomacy-clock";

  update(context: SimulationContext): void {
    const { state } = context;
    for (const relation of allRelations(state)) {
      if (
        relation.truceOfferBy &&
        state.tick - relation.truceOfferAt >= DIPLOMACY_RULES.truceOfferDurationTicks
      ) {
        const offeredBy = relation.truceOfferBy;
        const receiver = relation.parties.find((party) => party !== offeredBy)!;
        context.report({
          domain: "diplomacy",
          kind: "diplomacy.alliance-offer-expired",
          importance: "routine",
          storyKey: relation.storyKey ?? `alliance:${relation.key}:${relation.truceOfferAt}`,
          initiator: realmSubject(state, offeredBy),
          targets: [realmSubject(state, receiver)],
          participants: relation.parties.map((party) => realmSubject(state, party)),
          links: { relation: relation.key },
          facts: { offeredAt: relation.truceOfferAt },
          summary: `${realmTitle(state, receiver)} allowed ${realmTitle(state, offeredBy)}'s alliance offer to expire.`,
        });
        relation.truceOfferBy = null;
        relation.truceOfferAt = 0;
        relation.storyKey = null;
      }
      if (relation.status !== "truce" || state.tick < relation.truceUntil) continue;
      const allianceStoryKey = relation.storyKey ?? `alliance:${relation.key}:${relation.since}`;
      const allianceDuration = state.tick - relation.since;
      relation.status = "peace";
      relation.since = state.tick;
      relation.truceUntil = 0;
      context.report({
        domain: "diplomacy",
        kind: "diplomacy.alliance-expired",
        importance: "major",
        storyKey: allianceStoryKey,
        initiator: null,
        targets: relation.parties.map((party) => realmSubject(state, party)),
        participants: relation.parties.map((party) => realmSubject(state, party)),
        links: { relation: relation.key },
        facts: { duration: allianceDuration, tradeRemainedOpen: relation.tradeActive },
        summary: `${realmTitle(state, relation.parties[0])} and ${realmTitle(state, relation.parties[1])} completed their alliance without betrayal.`,
      });
      relation.storyKey = null;
      context.emit(
        `${realmTitle(state, relation.parties[0])} and ${realmTitle(state, relation.parties[1])} complete their ten-minute truce and return to ordinary peace.`,
        "treaty",
      );
    }
  }
}
