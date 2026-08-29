import { PLAYER_ORDER } from "../players";
import { allRelations, countRelationStatuses, otherParty } from "../diplomacy";
import { relationKey } from "../diplomacy";
import type { RelationCounts } from "../diplomacy";
import { ascensionAppetite, transmuting } from "../ascension";
import { realmMatchup } from "../elements";
import { frontierTargets } from "../frontier";
import { borderLength } from "../grid";
import { DIPLOMACY_RULES, ELEMENT_RULES, TRANSMUTATION_RULES, clamp, mobilizationCostFor } from "../rules";
import { strategyFactor } from "../strategy";
import type { PlayerId, RelationState, SimulationContext, SimulationSystem } from "../types";

/**
 * What a single diplomacy pass needs to know about the whole roster.
 *
 * Every relation is judged against the rest of the world -- how many wars each
 * party already holds, how big the largest outside power is -- and the relation
 * table is quadratic in the roster, so answering those per relation made the
 * system cubic: at a hundred players it walked the roster five thousand times
 * for facts that do not change while the pass runs. The planner only queues
 * commands, and commands are applied by a later system, so relation statuses
 * and territory are fixed for the whole pass and can be tallied once.
 */
interface DiplomacyPass {
  counts: RelationCounts;
  /** The three largest territory shares among living players, descending. */
  leaders: { id: PlayerId; share: number }[];
  /** Pairs with a live campaign between them, keyed by relation key. */
  contestedPairs: Set<string>;
}

function buildPass(state: SimulationContext["state"]): DiplomacyPass {
  const leaders: { id: PlayerId; share: number }[] = [];
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    const share = faction.territory / state.landTiles;
    // Only the top three can ever be the largest party outside a given pair.
    let slot = leaders.length;
    while (slot > 0 && leaders[slot - 1]!.share < share) slot -= 1;
    if (slot < 3) {
      leaders.splice(slot, 0, { id, share });
      if (leaders.length > 3) leaders.pop();
    }
  }

  const contestedPairs = new Set<string>();
  for (const campaign of state.campaigns) {
    if (campaign.target === "wilderness") continue;
    contestedPairs.add(relationKey(campaign.attacker, campaign.target));
  }

  return { counts: countRelationStatuses(state), leaders, contestedPairs };
}

function warCount(pass: DiplomacyPass, player: PlayerId): number {
  return pass.counts.wars.get(player) ?? 0;
}

function truceCount(pass: DiplomacyPass, player: PlayerId): number {
  return pass.counts.truces.get(player) ?? 0;
}

/** The largest territory share held by anyone other than these two. */
function largestShareExcluding(pass: DiplomacyPass, first: PlayerId, second: PlayerId): number {
  for (const leader of pass.leaders) {
    if (leader.id !== first && leader.id !== second) return leader.share;
  }
  return 0;
}

function hasRoute(context: SimulationContext, actor: PlayerId, target: PlayerId): boolean {
  const self = context.state.factions[actor];
  const rival = context.state.factions[target];
  return borderLength(context.state, actor, target) > 0
    || (self.structures.harbor > 0 && rival.structures.harbor > 0);
}

function truceValue(
  context: SimulationContext,
  pass: DiplomacyPass,
  actor: PlayerId,
  target: PlayerId,
): number {
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
  const largestThirdParty = largestShareExcluding(pass, actor, target);
  const commonThreat = largestThirdParty > 0.34 ? (largestThirdParty - 0.34) * 1.5 : 0;
  const conflictPenalty = (warCount(pass, actor) + warCount(pass, target)) * 0.18;
  const traitorPenalty = state.tick < rival.traitorUntil ? 0.32 : 0;
  // Priorities scale the whole appraisal: a diplomacy-minded court values the
  // same alliance more, and the acceptance thresholds below stay put.
  return (parity * 0.48 + sharedBorder + tradePotential + commonThreat
    - conflictPenalty - traitorPenalty + random.next() * 0.16)
    * strategyFactor(self.strategy, "diplomacy");
}

function warDesire(
  context: SimulationContext,
  pass: DiplomacyPass,
  actor: PlayerId,
  target: PlayerId,
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
  const existingWars = warCount(pass, actor);
  // Free land first: settlement is always cheaper than invasion, so a realm
  // whose wilderness frontier is still open prefers settling it. Frontiers
  // close at geography-dependent times, so this is one of the incentives that
  // staggers the opening wars instead of a schedule doing it.
  const openFrontier = frontierTargets(state, actor, "wilderness").length;
  const settlementPull = clamp(openFrontier / (self.territory * 0.1 + 8), 0, 1)
    * DIPLOMACY_RULES.openFrontierWarReluctance;
  // Opportunism: a target already at war with its host running thin invites
  // every other border to open too. This is what lets several realms fall on
  // one collapsing power at once instead of queueing politely.
  const targetWars = warCount(pass, target);
  const targetStretched = rival.troops / Math.max(1, rival.troopCap);
  const pileOn = targetWars > 0
    ? DIPLOMACY_RULES.pileOnWarDesire
      * Math.min(1.6, targetWars * (targetStretched < 0.45 ? 1 : 0.45))
    : 0;
  // Element mastery is pursued here: a target whose absorption advances the
  // realm's next tier is worth a war, scaled by how much the court cares.
  const ascensionPull = ascensionAppetite(state, actor, target)
    * ELEMENT_RULES.ascensionWarDesire
    * strategyFactor(self.strategy, "ascension");
  // War is funded: the declaration will spend the mobilization chest, and a
  // court whose treasury cannot yet cover it wants the war less. Treasuries
  // grow at genuinely different rates — terrain, trade, construction — so
  // this is the economic incentive that spreads attack timing across realms.
  const warChest = clamp(self.gold / mobilizationCostFor(self.troops), 0, 1);
  // A court mid-fusion turns inward: the transition sickness halves its
  // appetite for opening a new war until the transmutation completes.
  const fluxCaution = transmuting(self) ? TRANSMUTATION_RULES.warDesireFactor : 1;
  // A conquest-minded realm wants the same war more; near the declaration
  // threshold the sum is positive, so the factor moves decisions exactly there.
  return (readiness * 0.88 + troopEdge * 0.38 + elementalEdge * 1.6
    + (border > 0 ? 0.14 : -0.05) + containLeader + finishVulnerable
    + exposedTraitor + longPeace + ascensionPull + pileOn - self.warWeariness * 0.72
    - existingWars * 0.26 - settlementPull + random.next() * 0.16)
    * strategyFactor(self.strategy, "conquest")
    * (0.35 + 0.65 * warChest)
    * fluxCaution;
}

function considerTradePolicy(
  context: SimulationContext,
  actor: PlayerId,
  target: PlayerId,
  relation: RelationState,
) {
  const { state, random } = context;
  const actorBlocked = relation.tradeDisabledBy.includes(actor);
  const powerRatio = state.factions[target].troops / Math.max(1, state.factions[actor].troops);
  // A trading court reopens routes sooner and closes them more reluctantly.
  const tradeFactor = strategyFactor(state.factions[actor].strategy, "trade");
  if (actorBlocked) {
    if ((relation.status === "truce" || powerRatio < 1.45) && random.chance(clamp(0.2 * tradeFactor, 0, 1))) {
      state.commands.push({ type: "set-trade", actor, target, enabled: true });
    }
  } else if (relation.status === "peace" && powerRatio > 1.75 && random.chance(0.06 / tradeFactor)) {
    state.commands.push({ type: "set-trade", actor, target, enabled: false });
  }
}

export class DiplomacyAiSystem implements SimulationSystem {
  readonly id = "diplomacy-ai";

  update(context: SimulationContext): void {
    const { state, random } = context;
    if (state.tick % state.config.diplomacyInterval !== 0) return;
    const pass = buildPass(state);
    // The court's term budget: how many major diplomatic acts each realm may
    // still take this pass. There is no cap on wars held — only on actions
    // taken per sitting, so no court performs an unbounded burst in one term.
    const actionsTaken = new Map<PlayerId, number>();
    const hasAction = (id: PlayerId) =>
      (actionsTaken.get(id) ?? 0) < DIPLOMACY_RULES.courtActionsPerTerm;
    const spendAction = (id: PlayerId) =>
      actionsTaken.set(id, (actionsTaken.get(id) ?? 0) + 1);
    const warsHeld = (id: PlayerId) => warCount(pass, id);

    for (const relation of allRelations(state)) {
      const [a, b] = relation.parties;
      const factionA = state.factions[a];
      const factionB = state.factions[b];
      if (!factionA.alive || !factionB.alive) continue;

      if (relation.status !== "war") {
        considerTradePolicy(context, a, b, relation);
        considerTradePolicy(context, b, a, relation);
      }

      if (relation.status === "truce") {
        const ratioA = factionA.troops / Math.max(1, factionB.troops);
        const ratioB = 1 / Math.max(0.01, ratioA);
        const shareA = factionA.territory / state.landTiles;
        const shareB = factionB.territory / state.landTiles;
        const bIsTraitor = state.tick < factionB.traitorUntil;
        const aIsTraitor = state.tick < factionA.traitorUntil;
        // Betrayal is funded like any other war: no chest, no knife.
        const aHasOpening = hasAction(a)
          && factionA.gold >= mobilizationCostFor(factionA.troops)
          && hasRoute(context, a, b) && (
            (bIsTraitor && ratioA > 1.05) ||
            (ratioA > 1.65 && shareB < shareA * 0.72 && random.chance(0.42))
          );
        const bHasOpening = hasAction(b)
          && factionB.gold >= mobilizationCostFor(factionB.troops)
          && hasRoute(context, b, a) && (
            (aIsTraitor && ratioB > 1.05) ||
            (ratioB > 1.65 && shareA < shareB * 0.72 && random.chance(0.42))
          );
        if (aHasOpening || bHasOpening) {
          const actor = aHasOpening && (!bHasOpening || ratioA >= ratioB) ? a : b;
          state.commands.push({ type: "declare-war", actor, target: otherParty(relation, actor) });
          spendAction(actor);
        }
        continue;
      }

      if (relation.status === "peace") {
        if (relation.truceOfferBy) {
          const receiver = otherParty(relation, relation.truceOfferBy);
          if (
            hasAction(receiver) &&
            truceCount(pass, receiver) < DIPLOMACY_RULES.maximumTrucesPerRealm &&
            truceValue(context, pass, receiver, relation.truceOfferBy) > 0.68
          ) {
            state.commands.push({ type: "accept-truce", actor: receiver, target: relation.truceOfferBy });
            spendAction(receiver);
          }
          continue;
        }

        if (
          state.tick >= 48 &&
          warsHeld(a) === 0 &&
          warsHeld(b) === 0 &&
          truceCount(pass, a) < DIPLOMACY_RULES.maximumTrucesPerRealm &&
          truceCount(pass, b) < DIPLOMACY_RULES.maximumTrucesPerRealm
        ) {
          const valueA = truceValue(context, pass, a, b);
          const valueB = truceValue(context, pass, b, a);
          if (Math.max(valueA, valueB) > 0.78 && random.chance(0.34)) {
            const actor = valueA >= valueB ? a : b;
            if (hasAction(actor)) {
              state.commands.push({ type: "offer-truce", actor, target: otherParty(relation, actor) });
              spendAction(actor);
              continue;
            }
          }
        }

        if (
          state.tick < state.config.minimumPeaceTicks ||
          state.tick < relation.cooldownUntil
        ) continue;
        // Only the declarer's own term budget gates a declaration. Neither
        // side's war count does: a realm already fighting for its life is
        // exactly the one its other neighbours descend on, and a sprawling
        // conqueror may open as many fronts as its desire — weariness, the
        // per-war reluctance and the mobilization chest inside warDesire —
        // still clears.
        const desireA = hasAction(a)
          ? warDesire(context, pass, a, b, relation) * state.config.aggression
          : Number.NEGATIVE_INFINITY;
        const desireB = hasAction(b)
          ? warDesire(context, pass, b, a, relation) * state.config.aggression
          : Number.NEGATIVE_INFINITY;
        const threshold = 1.08 + random.next() * 0.14;
        if (Math.max(desireA, desireB) > threshold) {
          const actor = desireA >= desireB ? a : b;
          const target = actor === a ? b : a;
          state.commands.push({ type: "declare-war", actor, target });
          spendAction(actor);
        }
        continue;
      }

      const warDuration = state.tick - relation.since;
      if (warDuration < DIPLOMACY_RULES.minimumWarTicks) continue;
      const contested = pass.contestedPairs.has(relationKey(a, b));
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
      const stalemate = !contested && warDuration > DIPLOMACY_RULES.stalemateTicks;
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
