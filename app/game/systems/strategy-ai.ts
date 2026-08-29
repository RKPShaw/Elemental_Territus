import { realmLabel } from "../naming";
import { PLAYERS, PLAYER_ORDER } from "../players";
import { ascensionAppetite } from "../ascension";
import { otherParty, warsFor } from "../diplomacy";
import { realmMatchup } from "../elements";
import {
  coastalCells,
  neighborIndices,
  structureCells,
} from "../grid";
import { frontierTargets } from "../frontier";
import { CLAIM_RULES, ELEMENT_RULES, POPULATION_RULES, compactNumber, clamp } from "../rules";
import { strategyFactor } from "../strategy";
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
        return total + Math.max(0, campaign.remaining);
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

      // Defense first: blunt the heaviest campaign pressing inward. Throwing
      // troops at an invasion cancels attackers one for one, which is the only
      // way an army defends and is paid for in people. Ground near works the
      // realm cannot rebuild is always worth that price -- and a realm that
      // dwarfs its invader blunts anywhere, because clearing a pinprick fast
      // is what frees the host to counterattack and take the ground back.
      const incoming = state.campaigns.filter((campaign) => campaign.target === id);
      const incomingCampaign = [...incoming].sort((a, b) => b.remaining - a.remaining)[0];
      const totalIncoming = incoming.reduce((total, campaign) => total + campaign.remaining, 0);
      let defenseCommitment = 0;
      if (incomingCampaign) {
        const uncovered = Math.max(
          0,
          incomingCampaign.remaining - incomingCampaign.defenderRemaining,
        );
        const safeHomeReserve = faction.troopCap * 0.2;
        const available = Math.max(0, faction.troops - safeHomeReserve);
        const threatened = state.theaters.some((theater) => {
          if (theater.campaignId !== incomingCampaign.id) return false;
          if (theater.allocation <= 0) return false;
          return theater.objectiveCells.some((index) => {
            const cell = state.cells[index]!;
            return cell.owner === id && (cell.capitalOf !== null || cell.structure !== null);
          });
        });
        const overmatch = faction.troops > incomingCampaign.remaining * 1.8;
        // A defense-minded realm covers more of the pressing force; the clamp
        // keeps even the most martial court from spending itself dry here.
        const coverShare = clamp(0.62 * strategyFactor(faction.strategy, "defense"), 0.4, 0.9);
        const desired = threatened || overmatch
          ? Math.max(
              0,
              uncovered * (overmatch ? Math.max(coverShare, 0.8) : coverShare)
                - incomingCampaign.defenderRemaining,
            )
          : 0;
        defenseCommitment = Math.floor(Math.min(available, desired));
        if (defenseCommitment >= 8_000) {
          state.commands.push({
            type: "commit-defense",
            actor: id,
            target: incomingCampaign.attacker,
            troops: defenseCommitment,
          });
        }
      }

      // Offense: score every rival this realm is at war with -- its own
      // aggressions and its invaders alike. A counterattack against an
      // overmatched invader is the most attractive front there is: the larger
      // realm blunts the push, then marches back to retake its land and more.
      interface FrontCandidate { target: PlayerId; score: number }
      const fronts: FrontCandidate[] = [];
      for (const relation of wars) {
        const rivalId = otherParty(relation, id);
        const rival = state.factions[rivalId];
        if (!rival.alive) continue;
        // Marchable frontier, not raw adjacency: a border that is all river
        // counts for nothing here, which correctly deflates a front that
        // could only be pressed by sea.
        const border = frontierTargets(state, id, rivalId).length;
        const troopEdge = faction.troops / Math.max(1, rival.troops);
        const invasionBy = incoming.reduce(
          (total, campaign) => campaign.attacker === rivalId ? total + campaign.remaining : total,
          0,
        );
        const counterattack = invasionBy > 0 && faction.troops > invasionBy * 1.35;
        // Among live wars, the enemy whose absorption advances the next tier
        // is the one an ascension-minded realm presses hardest.
        const score =
          clamp(troopEdge, 0.25, 2.5) * 0.55 +
          (realmMatchup(state, id, rivalId) - 1) * 2.1 +
          Math.log2(border + 1) * 0.08 +
          (rival.territory / state.landTiles > 0.34 ? 0.35 : 0) +
          (counterattack ? 0.55 : 0) +
          (relation.lastAggressor !== id && !counterattack ? -0.3 : 0) +
          ascensionAppetite(state, id, rivalId)
            * ELEMENT_RULES.ascensionTargetPreference
            * strategyFactor(faction.strategy, "ascension") +
          random.next() * 0.16;
        fronts.push({ target: rivalId, score });
      }
      fronts.sort((first, second) => second.score - first.score);

      const filled = faction.troops / faction.troopCap;
      const overwhelmed = totalIncoming > faction.troops * 1.1;
      const recovering = filled < 0.24;
      const best = fronts[0];

      if (!best || overwhelmed || recovering) {
        faction.intent = {
          target: best?.target ?? incomingCampaign?.attacker ?? null,
          posture: overwhelmed || incomingCampaign ? "defending" : "recovering",
          confidence: 0.6,
          plannedCommitment: defenseCommitment,
          reason: overwhelmed
            ? `${compactNumber(totalIncoming)} attackers press inward against a thinner host. Blunt and hold the reserve.`
            : recovering
              ? "The available host is too thin. Let cities refill the army before spending more troops."
              : "Hold the home reserve until a front worth pressing opens.",
        };
        continue;
      }

      // Priorities size the blow: defense decides what stays home, conquest
      // decides how much of the rest marches, both inside hard bands. The
      // spendable host is split across up to two fronts, so a realm at war
      // with several rivals genuinely fights several rivals.
      const reserve = Math.max(
        faction.troopCap * 0.24 * strategyFactor(faction.strategy, "defense"),
        totalIncoming * 0.5,
      );
      let spendable = Math.max(0, faction.troops - defenseCommitment - reserve);
      const desiredTotal = faction.troops * clamp(
        clamp(0.55 + best.score * 0.06, 0.5, 0.8) * strategyFactor(faction.strategy, "conquest"),
        0.4,
        0.85,
      );
      spendable = Math.min(spendable, desiredTotal);

      const MAXIMUM_FRONTS = 2;
      let plannedCommitment = 0;
      let launched = 0;
      for (const front of fronts.slice(0, MAXIMUM_FRONTS)) {
        if (spendable < 15_000) break;
        if (front !== best && front.score <= 0) break;
        const outgoing = state.campaigns.find(
          (campaign) => campaign.attacker === id && campaign.target === front.target,
        );
        const reinforcementNeeded = outgoing && outgoing.remaining < outgoing.initialCommitted * 0.34;
        if (outgoing && !reinforcementNeeded) continue;
        const share = launched === 0 ? (fronts.length > 1 ? 0.66 : 1) : 1;
        const commitment = Math.floor(spendable * share);
        if (commitment < 15_000) continue;
        // A shared border only counts if an army can actually march over it:
        // the frontier index already refuses steps that cross a stream, so a
        // realm walled off behind a river mounts a naval crossing instead.
        const landBorder = frontierTargets(state, id, front.target).length;
        if (landBorder > 0) {
          state.commands.push({
            type: "launch-campaign",
            actor: id,
            target: front.target,
            troops: commitment,
            mode: "land",
          });
        } else {
          const routeAvailable = structureCells(state, id, "harbor").length > 0
            && coastalCells(state, front.target).length > 0;
          if (!routeAvailable) continue;
          state.commands.push({
            type: "launch-campaign",
            actor: id,
            target: front.target,
            troops: commitment,
            mode: "naval",
          });
        }
        spendable -= commitment;
        plannedCommitment += commitment;
        launched += 1;
      }

      const target = best.target;
      const outgoing = state.campaigns.find(
        (campaign) => campaign.attacker === id && campaign.target === target,
      );
      const counterTarget = incoming.some((campaign) => campaign.attacker === target);
      const route = frontierTargets(state, id, target).length > 0 ? "shared frontier" : "sea lane";
      faction.intent = {
        target,
        posture: outgoing || plannedCommitment > 0 ? "invading" : "mobilizing",
        confidence: clamp(0.5 + best.score * 0.08, 0.36, 0.94),
        plannedCommitment: plannedCommitment || defenseCommitment,
        reason: counterTarget
          ? `${realmLabel(state, target)}'s invasion has been blunted; the host counterattacks across the ${route} to take the ground back.`
          : outgoing
            ? `${compactNumber(outgoing.remaining)} committed troops are pushing the ${route}; reinforce only if momentum fades.`
            : `${realmLabel(state, target)} offers the best troop, terrain and elemental balance for the next ${route} campaign.`,
      };
    }
  }
}
