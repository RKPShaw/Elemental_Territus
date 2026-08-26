import { PLAYERS, PLAYER_ORDER } from "../players";
import { otherParty, warsFor } from "../diplomacy";
import { realmMatchup } from "../elements";
import {
  borderLength,
  coastalCells,
  neighborIndices,
  structureCells,
} from "../grid";
import { CLAIM_RULES, POPULATION_RULES, compactNumber, clamp } from "../rules";
import type { PlayerId, SimulationContext, SimulationSystem } from "../types";

export class StrategyAiSystem implements SimulationSystem {
  readonly id = "military-strategy-ai";

  update(context: SimulationContext): void {
    const { state, random } = context;
    if (state.tick !== 1 && state.tick % state.config.decisionInterval !== 0) return;

    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const homeRatio = faction.troops / Math.max(1, faction.troopCap);
      const wars = warsFor(state, id);
      const hasOpenFrontier = state.cells.some((cell, index) =>
        cell.owner === null &&
        cell.terrain !== "water" &&
        neighborIndices(index, state.config.width, state.config.height)
          .some((neighbor) => state.cells[neighbor]!.owner === id),
      );
      const settlementCampaign = state.campaigns.find(
        (campaign) => campaign.attacker === id && campaign.target === "wilderness",
      );
      const incomingPressure = state.campaigns.reduce((total, campaign) => {
        if (campaign.target !== id) return total;
        return total + Math.max(0, campaign.remaining - campaign.defenderRemaining);
      }, 0);
      const defendingEmergency = incomingPressure > Math.max(5_000, faction.troopCap * 0.22);
      let settlementCommitment = 0;
      if (hasOpenFrontier && !defendingEmergency) {
        const desiredFieldStrength = Math.max(
          CLAIM_RULES.minimumCampaignCommitment,
          faction.troopCap * 0.1,
        );
        const needsSettlement = !settlementCampaign ||
          settlementCampaign.remaining < desiredFieldStrength * 0.7;
        const foundingPush = state.tick === 1 && !settlementCampaign;
        if (
          needsSettlement &&
          (foundingPush || homeRatio >= POPULATION_RULES.minimumExpansionRatio)
        ) {
          // Young realms may press outward modestly, while mature realms bank
          // enough population to remain close to the 65% growth sweet spot.
          const reserveRatio = foundingPush
            ? 0.12
            : homeRatio >= 0.55
            ? POPULATION_RULES.matureExpansionReserveRatio
            : POPULATION_RULES.minimumExpansionRatio;
          const homeReserve = Math.max(CLAIM_RULES.minimumHomePopulation, faction.troopCap * reserveRatio);
          const available = Math.max(0, faction.troops - homeReserve);
          const fieldShortfall = settlementCampaign
            ? Math.max(0, desiredFieldStrength - settlementCampaign.remaining)
            : desiredFieldStrength;
          settlementCommitment = Math.floor(
            Math.min(
              available,
              Math.max(CLAIM_RULES.minimumCampaignCommitment, fieldShortfall),
            ),
          );
          if (settlementCommitment >= CLAIM_RULES.minimumCampaignCommitment) {
            state.commands.push({
              type: "launch-campaign",
              actor: id,
              target: "wilderness",
              troops: settlementCommitment,
              mode: "settlement",
            });
          }
        }
      }
      if (wars.length === 0) {
        const filled = faction.troops / faction.troopCap;
        const theaterCount = settlementCampaign
          ? state.theaters.filter((theater) => theater.campaignId === settlementCampaign.id && theater.staleRefreshes === 0).length
          : 0;
        faction.intent = {
          target: null,
          posture: hasOpenFrontier ? "expanding" : filled > 0.7 ? "mobilizing" : "trading",
          confidence: 0.66,
          plannedCommitment: settlementCommitment,
          reason:
            hasOpenFrontier
              ? homeRatio < POPULATION_RULES.minimumExpansionRatio
                ? "Pause settlement until the population recovers above 20% of capacity; overcommitting now would cripple growth."
                : `Pace wilderness commitments while the troop assigner balances ${Math.max(1, theaterCount)} automatic geographic ${theaterCount === 1 ? "theater" : "theaters"}, including difficult mountains.`
              : filled > 0.7
              ? "Peace holds, but the troop cap is nearly full. Study neighbors before the host goes idle."
              : "No wars are declared. Grow troops, earn gold and strengthen peaceful trade routes.",
        };
        continue;
      }

      const incoming = state.campaigns.filter((campaign) => campaign.target === id);
      const incomingCampaign = incoming.sort((a, b) => b.remaining - a.remaining)[0];
      if (incomingCampaign) {
        const uncovered = Math.max(
          0,
          incomingCampaign.remaining - incomingCampaign.defenderRemaining,
        );
        const safeHomeReserve = faction.troopCap * 0.2;
        const available = Math.max(0, faction.troops - safeHomeReserve);
        const desired = Math.max(0, uncovered * 0.62 - incomingCampaign.defenderRemaining);
        const plannedCommitment = Math.floor(Math.min(available, desired));
        if (plannedCommitment >= 8_000) {
          state.commands.push({
            type: "commit-defense",
            actor: id,
            target: incomingCampaign.attacker,
            troops: plannedCommitment,
          });
        }
        faction.intent = {
          target: incomingCampaign.attacker,
          posture: "defending",
          confidence: clamp(0.48 + incomingCampaign.defenderRemaining / Math.max(1, incomingCampaign.remaining) * 0.4, 0.4, 0.9),
          plannedCommitment,
          reason: `${compactNumber(incomingCampaign.defenderRemaining)} reserved defenders cancel the invading wave one-for-one; ${compactNumber(uncovered)} attackers remain able to press the line.`,
        };
        continue;
      }

      let target: PlayerId | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const relation of wars) {
        if (relation.lastAggressor !== id) continue;
        const rivalId = otherParty(relation, id);
        const rival = state.factions[rivalId];
        if (!rival.alive) continue;
        const border = borderLength(state, id, rivalId);
        const troopEdge = faction.troops / Math.max(1, rival.troops);
        const score =
          clamp(troopEdge, 0.25, 2.5) * 0.55 +
          (realmMatchup(state, id, rivalId) - 1) * 2.1 +
          Math.log2(border + 1) * 0.08 +
          (rival.territory / state.landTiles > 0.34 ? 0.35 : 0) +
          random.next() * 0.16;
        if (score > bestScore) {
          bestScore = score;
          target = rivalId;
        }
      }

      if (!target) {
        const defensiveWar = wars.find((relation) => relation.lastAggressor !== id);
        faction.intent = {
          target: defensiveWar ? otherParty(defensiveWar, id) : null,
          posture: "defending",
          confidence: 0.62,
          plannedCommitment: 0,
          reason: "Hold the home reserve until the aggressor commits troops to a single advancing front.",
        };
        continue;
      }
      const outgoing = state.campaigns.find(
        (campaign) => campaign.attacker === id && campaign.target === target,
      );
      const incomingThreat = 0;
      const filled = faction.troops / faction.troopCap;
      const defending = incomingThreat > faction.troops * 0.24;
      const recovering = filled < 0.24;

      let posture: typeof faction.intent.posture = "mobilizing";
      if (defending) posture = "defending";
      else if (recovering) posture = "recovering";
      else if (outgoing) posture = "invading";

      let plannedCommitment = 0;
      if (!recovering && !defending) {
        const reserve = Math.max(faction.troopCap * 0.24, incomingThreat * 0.65);
        const spendable = Math.max(0, faction.troops - reserve);
        const desired = faction.troops * clamp(0.3 + bestScore * 0.045, 0.28, 0.48);
        const reinforcementNeeded = outgoing && outgoing.remaining < outgoing.initialCommitted * 0.34;
        if (!outgoing || reinforcementNeeded) {
          plannedCommitment = Math.floor(Math.min(spendable, desired));
        }
      }

      if (plannedCommitment >= 15_000) {
        const landBorder = borderLength(state, id, target);
        if (landBorder > 0) {
          state.commands.push({
            type: "launch-campaign",
            actor: id,
            target,
            troops: plannedCommitment,
            mode: "land",
          });
        } else {
          const routeAvailable = structureCells(state, id, "harbor").length > 0
            && coastalCells(state, target).length > 0;
          if (routeAvailable) {
            state.commands.push({
              type: "launch-campaign",
              actor: id,
              target,
              troops: plannedCommitment,
              mode: "naval",
            });
          }
        }
      }

      const route = borderLength(state, id, target) > 0 ? "shared frontier" : "sea lane";
      faction.intent = {
        target,
        posture,
        confidence: clamp(0.5 + bestScore * 0.08, 0.36, 0.94),
        plannedCommitment,
        reason: defending
          ? `${PLAYERS[target].realmName} has ${compactNumber(incomingThreat)} troops pressing inward. Preserve the reserve.`
          : recovering
            ? `The available host is too thin. Let cities refill the army before spending more troops.`
            : outgoing
              ? `${compactNumber(outgoing.remaining)} committed troops are pushing the ${route}; reinforce only if momentum fades.`
              : `${PLAYERS[target].name} offers the best troop, terrain and elemental balance for the next ${route} campaign.`,
      };
    }
  }
}
