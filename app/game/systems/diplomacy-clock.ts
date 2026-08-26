
import { PLAYERS } from "../players";
import { realmSubject } from "../reporting";
import { DIPLOMACY_RULES } from "../rules";
import type { SimulationContext, SimulationSystem } from "../types";

export class DiplomacyClockSystem implements SimulationSystem {
  readonly id = "diplomacy-clock";

  update(context: SimulationContext): void {
    const { state } = context;
    for (const relation of Object.values(state.relations)) {
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
          initiator: realmSubject(offeredBy),
          targets: [realmSubject(receiver)],
          participants: relation.parties.map(realmSubject),
          links: { relation: relation.key },
          facts: { offeredAt: relation.truceOfferAt },
          summary: `${PLAYERS[receiver].realmName} allowed ${PLAYERS[offeredBy].realmName}'s alliance offer to expire.`,
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
        targets: relation.parties.map(realmSubject),
        participants: relation.parties.map(realmSubject),
        links: { relation: relation.key },
        facts: { duration: allianceDuration, tradeRemainedOpen: relation.tradeActive },
        summary: `${PLAYERS[relation.parties[0]].realmName} and ${PLAYERS[relation.parties[1]].realmName} completed their alliance without betrayal.`,
      });
      relation.storyKey = null;
      context.emit(
        `${PLAYERS[relation.parties[0]].realmName} and ${PLAYERS[relation.parties[1]].realmName} complete their ten-minute truce and return to ordinary peace.`,
        "treaty",
      );
    }
  }
}
