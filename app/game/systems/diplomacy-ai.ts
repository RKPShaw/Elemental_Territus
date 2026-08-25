import { otherParty, trucesFor, warsFor } from "../diplomacy";
import { ELEMENT_ORDER, realmMatchup } from "../elements";
import { borderLength } from "../grid";
import { DIPLOMACY_RULES, clamp } from "../rules";
import type { ElementId, RelationState, SimulationContext, SimulationSystem } from "../types";

function hasRoute(context: SimulationContext, actor: ElementId, target: ElementId): boolean {
  const self = context.state.factions[actor];
  const rival = context.state.factions[target];
  return borderLength(context.state, actor, target) > 0
    || (self.structures.harbor > 0 && rival.structures.harbor > 0);
}

function truceValue(context: SimulationContext, actor: ElementId, target: ElementId): number {
  const { state, random } = context;
  const self = state.factions[actor];
  const rival = state.factions[target];
  const powerRatio = self.troops / Math.max(1, rival.troops);
  const parity = 1 - clamp(Math.abs(Math.log2(Math.max(0.25, powerRatio))), 0, 1);
  const sharedBorder = borderLength(state, actor, target) > 0 ? 0.17 : 0;
  const tradePotential = clamp(
    (self.structures.factory + self.structures.harbor + rival.structures.factory + rival.structures.harbor) * 0.035,
    0,
    0.25,
  );
  const largestThirdParty = ELEMENT_ORDER
    .filter((id) => id !== actor && id !== target && state.factions[id].alive)
    .reduce((largest, id) => Math.max(largest, state.factions[id].territory / state.landTiles), 0);
  const commonThreat = largestThirdParty > 0.34 ? (largestThirdParty - 0.34) * 1.5 : 0;
  const conflictPenalty = (warsFor(state, actor).length + warsFor(state, target).length) * 0.18;
  const traitorPenalty = state.tick < rival.traitorUntil ? 0.32 : 0;
  return parity * 0.48 + sharedBorder + tradePotential + commonThreat
    - conflictPenalty - traitorPenalty + random.next() * 0.16;
}

function warDesire(
  context: SimulationContext,
  actor: ElementId,
  target: ElementId,
  relation: RelationState,
): number {
  const { state, random } = context;
  const self = state.factions[actor];
  const rival = state.factions[target];
  const readiness = self.troops / Math.max(1, self.troopCap);
  const troopEdge = clamp(self.troops / Math.max(1, rival.troops), 0.4, 2.2) - 1;
  const elementalEdge = realmMatchup(state, actor, target) - 1;
  const border = borderLength(state, actor, target);
  if (!hasRoute(context, actor, target)) return Number.NEGATIVE_INFINITY;
  const targetShare = rival.territory / state.landTiles;
  const containLeader = targetShare > 0.34 ? 0.26 : 0;
  const finishVulnerable = targetShare < DIPLOMACY_RULES.vulnerableRealmShare ? 0.2 : 0;
  const exposedTraitor = state.tick < rival.traitorUntil ? 0.48 : 0;
  const longPeace = clamp((state.tick - relation.since) / 320, 0, 0.38);
  const existingWars = warsFor(state, actor).length;
  return readiness * 0.88 + troopEdge * 0.38 + elementalEdge * 1.6
    + (border > 0 ? 0.14 : -0.05) + containLeader + finishVulnerable
    + exposedTraitor + longPeace - self.warWeariness * 0.72
    - existingWars * 0.34 + random.next() * 0.16;
}

function considerTradePolicy(
  context: SimulationContext,
  actor: ElementId,
  target: ElementId,
  relation: RelationState,
) {
  const { state, random } = context;
  const actorBlocked = relation.tradeDisabledBy.includes(actor);
  const powerRatio = state.factions[target].troops / Math.max(1, state.factions[actor].troops);
  if (actorBlocked) {
    if ((relation.status === "truce" || powerRatio < 1.45) && random.chance(0.2)) {
      state.commands.push({ type: "set-trade", actor, target, enabled: true });
    }
  } else if (relation.status === "peace" && powerRatio > 1.75 && random.chance(0.06)) {
    state.commands.push({ type: "set-trade", actor, target, enabled: false });
  }
}

export class DiplomacyAiSystem implements SimulationSystem {
  readonly id = "diplomacy-ai";

  update(context: SimulationContext): void {
    const { state, random } = context;
    if (state.tick % state.config.diplomacyInterval !== 0) return;
    const diplomaticallyEngaged = new Set(
      ELEMENT_ORDER.filter((id) => warsFor(state, id).length > 0),
    );

    for (const relation of Object.values(state.relations)) {
      const [a, b] = relation.parties;
      const factionA = state.factions[a];
      const factionB = state.factions[b];
      if (!factionA.alive || !factionB.alive) continue;

      if (relation.status !== "war") {
        considerTradePolicy(context, a, b, relation);
        considerTradePolicy(context, b, a, relation);
      }

      if (relation.status === "truce") {
        if (diplomaticallyEngaged.has(a) || diplomaticallyEngaged.has(b)) continue;
        const ratioA = factionA.troops / Math.max(1, factionB.troops);
        const ratioB = 1 / Math.max(0.01, ratioA);
        const shareA = factionA.territory / state.landTiles;
        const shareB = factionB.territory / state.landTiles;
        const bIsTraitor = state.tick < factionB.traitorUntil;
        const aIsTraitor = state.tick < factionA.traitorUntil;
        const aHasOpening = hasRoute(context, a, b) && (
          (bIsTraitor && ratioA > 1.05) ||
          (ratioA > 1.65 && shareB < shareA * 0.72 && random.chance(0.42))
        );
        const bHasOpening = hasRoute(context, b, a) && (
          (aIsTraitor && ratioB > 1.05) ||
          (ratioB > 1.65 && shareA < shareB * 0.72 && random.chance(0.42))
        );
        if (aHasOpening || bHasOpening) {
          const actor = aHasOpening && (!bHasOpening || ratioA >= ratioB) ? a : b;
          state.commands.push({ type: "declare-war", actor, target: otherParty(relation, actor) });
          diplomaticallyEngaged.add(a);
          diplomaticallyEngaged.add(b);
        }
        continue;
      }

      if (relation.status === "peace") {
        if (relation.truceOfferBy) {
          const receiver = otherParty(relation, relation.truceOfferBy);
          if (
            trucesFor(state, receiver).length < DIPLOMACY_RULES.maximumTrucesPerRealm &&
            truceValue(context, receiver, relation.truceOfferBy) > 0.68
          ) {
            state.commands.push({ type: "accept-truce", actor: receiver, target: relation.truceOfferBy });
          }
          continue;
        }

        if (
          state.tick >= 48 &&
          !diplomaticallyEngaged.has(a) &&
          !diplomaticallyEngaged.has(b) &&
          trucesFor(state, a).length < DIPLOMACY_RULES.maximumTrucesPerRealm &&
          trucesFor(state, b).length < DIPLOMACY_RULES.maximumTrucesPerRealm
        ) {
          const valueA = truceValue(context, a, b);
          const valueB = truceValue(context, b, a);
          if (Math.max(valueA, valueB) > 0.78 && random.chance(0.34)) {
            const actor = valueA >= valueB ? a : b;
            state.commands.push({ type: "offer-truce", actor, target: otherParty(relation, actor) });
            continue;
          }
        }

        if (
          state.tick < state.config.minimumPeaceTicks ||
          state.tick < relation.cooldownUntil ||
          diplomaticallyEngaged.has(a) ||
          diplomaticallyEngaged.has(b)
        ) continue;
        const desireA = warDesire(context, a, b, relation) * state.config.aggression;
        const desireB = warDesire(context, b, a, relation) * state.config.aggression;
        const threshold = 1.08 + random.next() * 0.14;
        if (Math.max(desireA, desireB) > threshold) {
          const actor = desireA >= desireB ? a : b;
          const target = actor === a ? b : a;
          state.commands.push({ type: "declare-war", actor, target });
          diplomaticallyEngaged.add(actor);
          diplomaticallyEngaged.add(target);
        }
        continue;
      }

      const warDuration = state.tick - relation.since;
      if (warDuration < DIPLOMACY_RULES.minimumWarTicks) continue;
      const activePairCampaigns = state.campaigns.filter(
        (campaign) =>
          campaign.target !== "wilderness" &&
          relation.parties.includes(campaign.attacker) &&
          relation.parties.includes(campaign.target),
      );
      const depletedA = factionA.troops / factionA.troopCap < 0.2;
      const depletedB = factionB.troops / factionB.troopCap < 0.2;
      const shareA = factionA.territory / state.landTiles;
      const shareB = factionB.territory / state.landTiles;
      const decisiveWar = Math.min(shareA, shareB) < DIPLOMACY_RULES.vulnerableRealmShare;
      const hegemonWar = Math.max(shareA, shareB) > DIPLOMACY_RULES.hegemonShare;
      const peaceResistance = decisiveWar || hegemonWar;
      const exhaustionThreshold = peaceResistance
        ? DIPLOMACY_RULES.decisiveExhaustionForPeace
        : DIPLOMACY_RULES.ordinaryExhaustionForPeace;
      const exhausted = factionA.warWeariness + factionB.warWeariness > exhaustionThreshold;
      const stalemate = activePairCampaigns.length === 0 && warDuration > DIPLOMACY_RULES.stalemateTicks;
      if (
        (depletedA && depletedB) || exhausted ||
        (!peaceResistance && stalemate && random.chance(DIPLOMACY_RULES.stalematePeaceChance))
      ) {
        const actor = depletedA || factionA.warWeariness >= factionB.warWeariness ? a : b;
        state.commands.push({ type: "make-peace", actor, target: otherParty(relation, actor) });
      }
    }
  }
}
