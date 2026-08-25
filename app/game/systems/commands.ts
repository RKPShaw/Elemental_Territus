import { getRelation } from "../diplomacy";
import { ELEMENTS } from "../elements";
import { canPlaceStructureSite, coastalCells, distanceBetween, structureCells } from "../grid";
import {
  campaignSubject,
  realmSubject,
  structureSubject,
  targetSubject,
  theaterSubject,
} from "../reporting";
import {
  CAMPAIGN_RULES,
  DIPLOMACY_RULES,
  STRUCTURE_RULES,
  WARSHIP_COST,
  compactNumber,
  nextStructureCost,
} from "../rules";
import type { Campaign, ElementId, SimulationContext, SimulationSystem, WorldReportDraft } from "../types";
import { isValidWaterPath, waterPathToAnyLandCell } from "../water-navigation";

interface NavalJourney {
  originIndex: number;
  targetIndex: number;
  pathIndices: number[];
  distance: number;
}

function selectNavalJourney(
  context: SimulationContext,
  attacker: ElementId,
  defender: ElementId,
): NavalJourney | null {
  const ports = structureCells(context.state, attacker, "harbor");
  const coast = coastalCells(context.state, defender);
  let best: NavalJourney | null = null;
  for (const port of ports) {
    const pathIndices = waterPathToAnyLandCell(context.state, port, coast);
    if (!pathIndices || !isValidWaterPath(context.state, pathIndices)) continue;
    const distance = pathIndices.slice(1).reduce(
      (total, index, position) => total + distanceBetween(context.state, pathIndices[position]!, index),
      0,
    );
    if (!best || distance < best.distance) {
      best = {
        originIndex: port,
        targetIndex: pathIndices[pathIndices.length - 1]!,
        pathIndices,
        distance,
      };
    }
  }
  return best;
}

export class CommandExecutionSystem implements SimulationSystem {
  readonly id = "command-execution";

  update(context: SimulationContext): void {
    const { state } = context;
    const commands = state.commands;
    state.commands = [];

    for (const command of commands) {
      const actor = state.factions[command.actor];
      if (!actor.alive) continue;
      const report = (draft: WorldReportDraft) => context.report({
        ...draft,
        links: { action: command.type, ...(draft.links ?? {}) },
        facts: { actionType: command.type, ...(draft.facts ?? {}) },
      });

      if (command.type === "declare-war") {
        const relation = getRelation(state, command.actor, command.target);
        const betrayingTruce = relation.status === "truce" && state.tick < relation.truceUntil;
        const previousRelationSince = relation.since;
        if (relation.status === "war") continue;
        if (!betrayingTruce && state.tick < relation.cooldownUntil) continue;
        const targetIsExposedTraitor = state.tick < state.factions[command.target].traitorUntil;
        const allianceStoryKey = relation.storyKey;
        if (betrayingTruce && !targetIsExposedTraitor) {
          actor.traitorUntil = Math.max(
            actor.traitorUntil,
            state.tick + DIPLOMACY_RULES.traitorDurationTicks,
          );
        }
        relation.status = "war";
        relation.since = state.tick;
        relation.truceUntil = 0;
        relation.truceOfferBy = null;
        relation.truceOfferAt = 0;
        relation.lastAggressor = command.actor;
        relation.tradeActive = false;
        relation.tradeDisabledBy = [...relation.parties];
        if (betrayingTruce) {
          report({
            domain: "diplomacy",
            kind: "diplomacy.alliance-betrayed",
            importance: "historic",
            storyKey: allianceStoryKey ?? `alliance:${relation.key}:${relation.since}`,
            initiator: realmSubject(command.actor),
            targets: [realmSubject(command.target)],
            participants: relation.parties.map(realmSubject),
            links: { relation: relation.key },
            facts: {
              targetAlreadyTraitor: targetIsExposedTraitor,
              traitorPenaltyApplied: !targetIsExposedTraitor,
              traitorDuration: targetIsExposedTraitor ? 0 : DIPLOMACY_RULES.traitorDurationTicks,
              allianceDuration: state.tick - previousRelationSince,
            },
            summary: `${ELEMENTS[command.actor].realmName} broke its alliance with ${ELEMENTS[command.target].realmName}.`,
          });
        }
        relation.storyKey = `war:${relation.key}:${state.tick}`;
        report({
          domain: "diplomacy",
          kind: "diplomacy.war-declared",
          importance: betrayingTruce ? "historic" : "major",
          storyKey: relation.storyKey,
          initiator: realmSubject(command.actor),
          targets: [realmSubject(command.target)],
          participants: relation.parties.map(realmSubject),
          links: { relation: relation.key },
          facts: {
            betrayal: betrayingTruce,
            targetAlreadyTraitor: targetIsExposedTraitor,
            tradeStopped: true,
          },
          summary: `${ELEMENTS[command.actor].realmName} declared war on ${ELEMENTS[command.target].realmName}${betrayingTruce ? " by breaking their alliance" : ""}.`,
        });
        context.emit(
          betrayingTruce
            ? targetIsExposedTraitor
              ? `${ELEMENTS[command.actor].realmName} turns on the exposed traitor ${ELEMENTS[command.target].realmName} without staining its own honor.`
              : `${ELEMENTS[command.actor].realmName} betrays its truce with ${ELEMENTS[command.target].realmName}. For 30 seconds, every rival can strike the traitor more easily.`
            : `${ELEMENTS[command.actor].realmName} formally declares war on ${ELEMENTS[command.target].realmName}. Trade stops at once.`,
          "battle",
          command.actor,
        );
        continue;
      }

      if (command.type === "offer-truce") {
        const relation = getRelation(state, command.actor, command.target);
        if (
          relation.status !== "peace" ||
          relation.truceOfferBy !== null ||
          !state.factions[command.target].alive
        ) continue;
        relation.truceOfferBy = command.actor;
        relation.truceOfferAt = state.tick;
        relation.storyKey = `alliance:${relation.key}:${state.tick}`;
        report({
          domain: "diplomacy",
          kind: "diplomacy.alliance-offered",
          importance: "notable",
          storyKey: relation.storyKey,
          initiator: realmSubject(command.actor),
          targets: [realmSubject(command.target)],
          participants: relation.parties.map(realmSubject),
          links: { relation: relation.key },
          facts: { offerExpiresIn: DIPLOMACY_RULES.truceOfferDurationTicks },
          summary: `${ELEMENTS[command.actor].realmName} offered ${ELEMENTS[command.target].realmName} an alliance.`,
        });
        context.emit(
          `${ELEMENTS[command.actor].realmName} offers ${ELEMENTS[command.target].realmName} a ten-minute alliance truce.`,
          "treaty",
          command.actor,
        );
        continue;
      }

      if (command.type === "accept-truce") {
        const relation = getRelation(state, command.actor, command.target);
        if (relation.status !== "peace" || relation.truceOfferBy !== command.target) continue;
        relation.status = "truce";
        relation.since = state.tick;
        relation.truceUntil = state.tick + DIPLOMACY_RULES.truceDurationTicks;
        relation.truceOfferBy = null;
        relation.truceOfferAt = 0;
        relation.tradeDisabledBy = [];
        relation.tradeActive = true;
        relation.storyKey ??= `alliance:${relation.key}:${state.tick}`;
        report({
          domain: "diplomacy",
          kind: "diplomacy.alliance-formed",
          importance: "major",
          storyKey: relation.storyKey,
          initiator: realmSubject(command.actor),
          targets: [realmSubject(command.target)],
          participants: relation.parties.map(realmSubject),
          links: { relation: relation.key },
          facts: {
            duration: DIPLOMACY_RULES.truceDurationTicks,
            tradeOpened: true,
          },
          summary: `${ELEMENTS[command.actor].realmName} accepted ${ELEMENTS[command.target].realmName}'s alliance offer.`,
        });
        context.emit(
          `${ELEMENTS[command.actor].realmName} accepts ${ELEMENTS[command.target].realmName}'s alliance. Their truce and favored trade begin now.`,
          "treaty",
          command.actor,
        );
        continue;
      }

      if (command.type === "set-trade") {
        const relation = getRelation(state, command.actor, command.target);
        if (relation.status === "war") continue;
        const blockers = new Set(relation.tradeDisabledBy);
        if (command.enabled) blockers.delete(command.actor);
        else blockers.add(command.actor);
        relation.tradeDisabledBy = [...blockers];
        relation.tradeActive = relation.tradeDisabledBy.length === 0;
        const tradeStoryKey = relation.status === "truce" && relation.storyKey
          ? relation.storyKey
          : `trade-policy:${relation.key}:${Math.floor(state.tick / 240)}`;
        report({
          domain: "diplomacy",
          kind: "diplomacy.trade-policy-changed",
          importance: "notable",
          storyKey: tradeStoryKey,
          initiator: realmSubject(command.actor),
          targets: [realmSubject(command.target)],
          participants: relation.parties.map(realmSubject),
          links: { relation: relation.key },
          facts: {
            enabled: command.enabled,
            relationStatus: relation.status,
          },
          summary: `${ELEMENTS[command.actor].realmName} ${command.enabled ? "reopened" : "closed"} trade with ${ELEMENTS[command.target].realmName}.`,
        });
        context.emit(
          `${ELEMENTS[command.actor].realmName} ${command.enabled ? "reopens" : "closes"} trade with ${ELEMENTS[command.target].realmName}.`,
          "economy",
          command.actor,
        );
        continue;
      }

      if (command.type === "make-peace") {
        const relation = getRelation(state, command.actor, command.target);
        if (relation.status !== "war") continue;
        const warStoryKey = relation.storyKey ?? `war:${relation.key}:${relation.since}`;
        const warStartedAt = relation.since;
        relation.status = "peace";
        relation.since = state.tick;
        relation.cooldownUntil = state.tick + DIPLOMACY_RULES.peaceCooldownTicks;
        relation.truceUntil = 0;
        relation.truceOfferBy = null;
        relation.truceOfferAt = 0;
        relation.tradeDisabledBy = [];
        relation.tradeActive = true;
        for (const campaign of state.campaigns) {
          if (
            campaign.target !== "wilderness" &&
            relation.parties.includes(campaign.attacker) &&
            relation.parties.includes(campaign.target)
          ) {
            for (const theater of state.theaters) {
              if (
                theater.campaignId !== campaign.id ||
                theater.captures <= 0 ||
                theater.victoryReported
              ) continue;
              theater.victoryReported = true;
              report({
                domain: "military",
                kind: "military.theater-victory",
                importance: theater.captures >= 25 ? "major" : "notable",
                storyKey: campaign.storyKey,
                initiator: realmSubject(campaign.attacker),
                targets: [theaterSubject(theater.id, theater.attacker), targetSubject(campaign.target)],
                participants: [campaignSubject(campaign)],
                links: { campaign: campaign.id, theater: theater.id, relation: relation.key },
                facts: {
                  captures: theater.captures,
                  duration: state.tick - theater.formedAt,
                  outcome: "peace",
                },
                summary: `${theaterSubject(theater.id, theater.attacker).label} closed with ${theater.captures} captured sectors when peace was signed.`,
              });
            }
            report({
              domain: "military",
              kind: "military.campaign-concluded",
              importance: campaign.captures > 0 ? "major" : "notable",
              storyKey: campaign.storyKey,
              initiator: realmSubject(campaign.attacker),
              targets: [targetSubject(campaign.target)],
              participants: [campaignSubject(campaign)],
              links: { campaign: campaign.id, relation: relation.key },
              facts: {
                outcome: "peace",
                captures: campaign.captures,
                casualties: campaign.casualties,
                attackersRemaining: campaign.remaining,
                defendersRemaining: campaign.defenderRemaining,
              },
              summary: `${ELEMENTS[campaign.attacker].realmName}'s campaign ended when peace was signed after ${campaign.captures} captured sectors.`,
            });
            state.factions[campaign.attacker].troops += campaign.remaining * 0.75;
            state.factions[campaign.target].troops += campaign.defenderRemaining * 0.9;
            campaign.remaining = 0;
            campaign.defenderRemaining = 0;
          }
        }
        state.campaigns = state.campaigns.filter((campaign) => campaign.remaining > 0);
        report({
          domain: "diplomacy",
          kind: "diplomacy.peace-made",
          importance: "major",
          storyKey: warStoryKey,
          initiator: realmSubject(command.actor),
          targets: [realmSubject(command.target)],
          participants: relation.parties.map(realmSubject),
          links: { relation: relation.key },
          facts: {
            warDuration: state.tick - warStartedAt,
            tradeReopened: true,
          },
          summary: `${ELEMENTS[command.actor].realmName} and ${ELEMENTS[command.target].realmName} ended their war in peace.`,
        });
        relation.storyKey = null;
        context.emit(
          `${ELEMENTS[command.actor].realmName} and ${ELEMENTS[command.target].realmName} sign a peace. Their trade lines may run again.`,
          "treaty",
          command.actor,
        );
        continue;
      }

      if (command.type === "launch-campaign") {
        const settling = command.target === "wilderness";
        let storyKey = "";
        if (settling && command.mode !== "settlement") continue;
        if (command.target !== "wilderness") {
          const defender = state.factions[command.target];
          const relation = getRelation(state, command.actor, command.target);
          if (
            !defender.alive ||
            relation.status !== "war" ||
            relation.lastAggressor !== command.actor ||
            command.mode === "settlement"
          ) continue;
          relation.storyKey ??= `war:${relation.key}:${relation.since}`;
          storyKey = relation.storyKey;
        }
        const troops = Math.floor(
          Math.min(command.troops, actor.troops * (settling ? 0.58 : 0.72)),
        );
        if (troops < (settling ? 2_000 : 10_000)) continue;
        const navalJourney = command.mode === "naval"
          ? selectNavalJourney(context, command.actor, command.target as ElementId)
          : null;
        if (command.mode === "naval") {
          if (
            actor.structures.harbor < 1 ||
            navalJourney === null ||
            actor.gold < 15_000
          ) {
            continue;
          }
          actor.gold -= 15_000;
        }
        actor.troops -= troops;

        const existing = state.campaigns.find(
          (campaign) =>
            campaign.attacker === command.actor &&
            campaign.target === command.target &&
            campaign.remaining > 0,
        );
        if (existing) {
          existing.initialCommitted += troops;
          existing.remaining += troops;
          report({
            domain: "military",
            kind: "military.campaign-reinforced",
            importance: "notable",
            storyKey: existing.storyKey,
            initiator: realmSubject(command.actor),
            targets: [targetSubject(command.target)],
            participants: [campaignSubject(existing)],
            links: { campaign: existing.id },
            facts: {
              troops,
              totalCommitted: existing.initialCommitted,
              mode: existing.mode,
              goldCost: command.mode === "naval" ? 15_000 : 0,
            },
            summary: `${ELEMENTS[command.actor].realmName} reinforced its ${settling ? "wilderness" : ELEMENTS[command.target as ElementId].name} campaign with ${compactNumber(troops)} troops.`,
          });
          context.emit(
            settling
              ? `${ELEMENTS[command.actor].realmName} sends ${compactNumber(troops)} more settlers into its wilderness campaign.`
              : `${ELEMENTS[command.actor].realmName} sends ${compactNumber(troops)} more troops into the front against ${ELEMENTS[command.target as ElementId].name}.`,
            settling ? "rise" : "battle",
            command.actor,
          );
          continue;
        }

        const initialEta = navalJourney
          ? Math.max(16, Math.round(navalJourney.distance / CAMPAIGN_RULES.navalTransportVelocity))
          : 0;
        const campaignId = `${state.tick}:${command.actor}:${command.target}:${state.campaigns.length}`;
        if (settling) storyKey = `expansion:${command.actor}`;
        const campaign: Campaign = {
          id: campaignId,
          attacker: command.actor,
          target: command.target,
          mode: command.mode,
          initialCommitted: troops,
          remaining: troops,
          initialDefenderCommitted: 0,
          defenderRemaining: 0,
          launchedAt: state.tick,
          captures: 0,
          casualties: 0,
          originIndex: navalJourney?.originIndex ?? null,
          targetIndex: navalJourney?.targetIndex ?? null,
          pathIndices: navalJourney?.pathIndices ?? [],
          eta: initialEta,
          initialEta,
          storyKey,
        };
        state.campaigns.push(campaign);
        report({
          domain: "military",
          kind: "military.campaign-launched",
          importance: settling ? "notable" : "major",
          storyKey: campaign.storyKey,
          initiator: realmSubject(command.actor),
          targets: [targetSubject(command.target)],
          participants: [campaignSubject(campaign)],
          links: { campaign: campaign.id },
          facts: {
            troops,
            mode: command.mode,
            goldCost: command.mode === "naval" ? 15_000 : 0,
            originIndex: campaign.originIndex ?? -1,
            targetIndex: campaign.targetIndex ?? -1,
            waterRouteCells: campaign.pathIndices.length,
            waterRouteDistance: navalJourney?.distance ?? 0,
          },
          summary: `${ELEMENTS[command.actor].realmName} initiated a ${command.mode} campaign against ${command.target === "wilderness" ? "the wilderness" : ELEMENTS[command.target].realmName} with ${compactNumber(troops)} troops.`,
        });
        context.emit(
          settling
            ? `${ELEMENTS[command.actor].realmName} commits ${compactNumber(troops)} people to settle every automatically discovered wilderness theater.`
            : command.mode === "naval"
            ? `${ELEMENTS[command.actor].realmName} loads ${compactNumber(troops)} troops into transport boats bound for ${ELEMENTS[command.target as ElementId].realmName}.`
            : `${ELEMENTS[command.actor].realmName} commits ${compactNumber(troops)} troops to push the frontier into ${ELEMENTS[command.target as ElementId].realmName}.`,
          settling ? "rise" : "battle",
          command.actor,
        );
        continue;
      }

      if (command.type === "commit-defense") {
        const relation = getRelation(state, command.actor, command.target);
        if (relation.status !== "war" || relation.lastAggressor === command.actor) continue;
        const campaign = state.campaigns.find(
          (candidate) =>
            candidate.attacker === command.target &&
            candidate.target === command.actor &&
            candidate.remaining > 0,
        );
        if (!campaign) continue;
        const troops = Math.floor(Math.min(command.troops, actor.troops * 0.68));
        if (troops < 8_000) continue;
        actor.troops -= troops;
        campaign.initialDefenderCommitted += troops;
        campaign.defenderRemaining += troops;
        report({
          domain: "military",
          kind: "military.defense-committed",
          importance: "major",
          storyKey: campaign.storyKey,
          initiator: realmSubject(command.actor),
          targets: [realmSubject(command.target)],
          participants: [campaignSubject(campaign)],
          links: { campaign: campaign.id },
          facts: {
            troops,
            totalDefenderCommitted: campaign.initialDefenderCommitted,
            attackersRemaining: campaign.remaining,
          },
          summary: `${ELEMENTS[command.actor].realmName} committed ${compactNumber(troops)} defenders against ${ELEMENTS[command.target].realmName}'s campaign.`,
        });
        context.emit(
          `${ELEMENTS[command.actor].realmName} reserves ${compactNumber(troops)} troops to stunt ${ELEMENTS[command.target].name}'s advancing front.`,
          "battle",
          command.actor,
        );
        continue;
      }

      if (command.type === "build-structure") {
        const cell = state.cells[command.tileIndex];
        const rule = STRUCTURE_RULES[command.structure];
        const stackingCity = Boolean(
          cell &&
          command.structure === "city" &&
          cell.owner === command.actor &&
          cell.structure === "city",
        );
        const cost = nextStructureCost(command.structure, actor.structures);
        if (
          !cell ||
          cell.owner !== command.actor ||
          cell.terrain === "water" ||
          actor.gold < cost ||
          (!stackingCity && !canPlaceStructureSite(state, command.tileIndex)) ||
          (command.structure === "harbor" && !cell.coastal)
        ) {
          continue;
        }
        actor.gold -= cost;
        if (stackingCity) {
          cell.structureLevel = Math.max(1, cell.structureLevel) + 1;
        } else {
          cell.structure = command.structure;
          cell.structureLevel = 1;
        }
        actor.structures[command.structure] += 1;
        report({
          domain: "infrastructure",
          kind: "infrastructure.structure-built",
          importance: command.structure === "city" || command.structure === "fort" ? "major" : "notable",
          storyKey: `development:${command.actor}:${Math.floor(state.tick / 240)}`,
          initiator: realmSubject(command.actor),
          targets: [structureSubject(command.structure, command.tileIndex, command.actor)],
          participants: [realmSubject(command.actor)],
          links: { structure: `${command.structure}:${command.tileIndex}` },
          facts: {
            structure: command.structure,
            tileIndex: command.tileIndex,
            cost,
            terrain: cell.terrain,
            coastal: cell.coastal,
            stacked: stackingCity,
            structureLevel: cell.structureLevel,
          },
          summary: stackingCity
            ? `${ELEMENTS[command.actor].realmName} developed city level ${cell.structureLevel} at sector ${command.tileIndex}.`
            : `${ELEMENTS[command.actor].realmName} completed a ${rule.name.toLowerCase()} at sector ${command.tileIndex}.`,
        });
        context.emit(
          stackingCity
            ? `${ELEMENTS[command.actor].realmName} stacks another city district into a defensible urban center.`
            : `${ELEMENTS[command.actor].realmName} completes a new ${rule.name.toLowerCase()}.`,
          "economy",
          command.actor,
        );
        continue;
      }

      if (command.type === "build-warship") {
        if (actor.structures.harbor < 1 || actor.gold < WARSHIP_COST) continue;
        actor.gold -= WARSHIP_COST;
        actor.warships += 1;
        report({
          domain: "military",
          kind: "military.warship-built",
          importance: "notable",
          storyKey: `development:${command.actor}:${Math.floor(state.tick / 240)}`,
          initiator: realmSubject(command.actor),
          targets: [],
          participants: [realmSubject(command.actor)],
          links: {},
          facts: { cost: WARSHIP_COST, totalWarships: actor.warships },
          summary: `${ELEMENTS[command.actor].realmName} launched warship ${actor.warships}.`,
        });
        context.emit(
          `${ELEMENTS[command.actor].realmName} launches a patrol warship from its harbor.`,
          "economy",
          command.actor,
        );
      }
    }
  }
}
