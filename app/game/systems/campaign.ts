import { markCellsChanged } from "../structure-index";
import { openLens } from "../lenses";
import { PLAYERS } from "../players";
import { getRelation, isAtWar } from "../diplomacy";
import { realmMatchup } from "../elements";
import { ownedNeighborCount } from "../grid";
import {
  CAMPAIGN_RULES,
  CLAIM_RULES,
  SETTLE_PREFERENCE_FLOOR,
  SETTLE_PREFERENCE_RANGE,
  DIPLOMACY_RULES,
  compactNumber,
  clamp,
  normalizedCellArea,
  normalizedCellLength,
} from "../rules";
import {
  campaignSubject,
  realmSubject,
  structureSubject,
  targetSubject,
  theaterSubject,
} from "../reporting";
import type { Campaign, PlayerId, SimulationContext, SimulationSystem, Theater } from "../types";
import { campaignBoundaryTargets, conquestCostAt, theaterFrontWeights } from "./theaters";

function trackPressure(state: SimulationContext["state"], index: number): void {
  const cell = state.cells[index]!;
  if (cell.pressureTracked) return;
  cell.pressureTracked = true;
  state.activePressureCells.push(index);
}

/**
 * A realm falls with its capital: every tile still flying the defender's
 * banner passes to the captor at once. The accounting system sees the empty
 * realm on its next pass and handles the conquest itself -- absorption,
 * the realm-conquered report -- through the same path as any other fall.
 */
function annexRealm(
  context: SimulationContext,
  attacker: PlayerId,
  defender: PlayerId,
): number {
  const { state } = context;
  let annexed = 0;
  for (const cell of state.cells) {
    if (cell.owner !== defender) continue;
    cell.owner = attacker;
    cell.pressure = 0;
    cell.pressureBy = null;
    cell.capturedAt = state.tick;
    annexed += 1;
  }
  if (annexed === 0) return 0;
  markCellsChanged(state);
  state.factions[attacker].territory += annexed;
  state.factions[attacker].capturedTiles += annexed;
  state.factions[defender].territory = 0;
  return annexed;
}

function captureEnemyTile(
  context: SimulationContext,
  campaign: Campaign,
  theater: Theater | null,
  tileIndex: number,
): void {
  if (campaign.target === "wilderness") return;
  const { state } = context;
  const defender = campaign.target;
  const tile = state.cells[tileIndex]!;
  if (tile.owner !== defender) return;
  const capturedStructure = tile.structure;
  const capturedStructureLevel = tile.structureLevel;
  const capturedCapital = tile.capitalOf === defender;
  tile.owner = campaign.attacker;
  markCellsChanged(state);
  tile.pressure = 0;
  tile.pressureBy = null;
  tile.capturedAt = state.tick;
  campaign.captures += 1;
  if (theater) {
    theater.lastAdvanceAt = state.tick;
    theater.captures += 1;
  }
  state.factions[campaign.attacker].territory += 1;
  state.factions[campaign.attacker].momentum += 1;
  state.factions[campaign.attacker].capturedTiles += 1;
  state.factions[defender].territory = Math.max(0, state.factions[defender].territory - 1);
  state.factions[defender].momentum -= 1;
  state.factions[defender].lastConqueror = campaign.attacker;

  if (capturedStructure) {
    context.report({
      domain: "territory",
      kind: "territory.structure-captured",
      importance: capturedStructure === "fort" || capturedStructure === "city" ? "major" : "notable",
      storyKey: campaign.storyKey,
      initiator: realmSubject(campaign.attacker),
      targets: [structureSubject(capturedStructure, tileIndex, defender), realmSubject(defender)],
      participants: [campaignSubject(campaign)],
      links: {
        campaign: campaign.id,
        structure: `${capturedStructure}:${tileIndex}`,
        ...(theater ? { theater: theater.id } : {}),
      },
      facts: {
        tileIndex,
        structure: capturedStructure,
        structureLevel: capturedStructureLevel,
        campaignCaptures: campaign.captures,
      },
      summary: `${PLAYERS[campaign.attacker].realmName} captured a ${capturedStructure} belonging to ${PLAYERS[defender].realmName}.`,
    });
  }

  if (capturedCapital) {
    // The capital is the realm: taking it hands the captor everything that
    // still stood under the defender's banner.
    const annexedTiles = annexRealm(context, campaign.attacker, defender);
    context.report({
      domain: "territory",
      kind: "territory.capital-captured",
      importance: "historic",
      storyKey: campaign.storyKey,
      initiator: realmSubject(campaign.attacker),
      targets: [realmSubject(defender)],
      participants: [campaignSubject(campaign)],
      links: {
        campaign: campaign.id,
        ...(theater ? { theater: theater.id } : {}),
      },
      facts: { tileIndex, campaignCaptures: campaign.captures, annexedTiles },
      summary: `${PLAYERS[campaign.attacker].realmName} captured the capital of ${PLAYERS[defender].realmName} and the rest of the realm fell with it.`,
    });
  }

  if (capturedCapital) {
    context.emit(
      `${PLAYERS[campaign.attacker].realmName} storms the capital of ${PLAYERS[defender].realmName} -- the whole realm falls with it!`,
      "battle",
      campaign.attacker,
    );
  } else if (capturedStructure === "fort") {
    context.emit(
      `${PLAYERS[campaign.attacker].realmName} overruns a fortified sector after paying its doubled invasion cost.`,
      "battle",
      campaign.attacker,
    );
  } else if (campaign.captures % 70 === 0) {
    context.emit(
      `${PLAYERS[campaign.attacker].realmName} has pressed the border forward by ${campaign.captures} tiles in this campaign.`,
      "rise",
      campaign.attacker,
    );
  }
}

function settleWildernessTile(
  context: SimulationContext,
  campaign: Campaign,
  theater: Theater,
  tileIndex: number,
): void {
  const { state } = context;
  const tile = state.cells[tileIndex]!;
  if (campaign.target !== "wilderness" || tile.owner !== null || tile.terrain === "water") return;
  const cost = CLAIM_RULES.populationCostPerCell
    * normalizedCellArea(state.config)
    * conquestCostAt(state, tileIndex, "wilderness");
  if (campaign.remaining < cost) {
    tile.pressure = Math.min(tile.pressure, 0.96);
    return;
  }
  campaign.remaining -= cost;
  campaign.captures += 1;
  theater.lastAdvanceAt = state.tick;
  theater.captures += 1;
  tile.owner = campaign.attacker;
  markCellsChanged(state);
  tile.pressure = 0;
  tile.pressureBy = null;
  tile.capturedAt = state.tick;
  const faction = state.factions[campaign.attacker];
  faction.territory += 1;
  faction.claimedTiles += 1;
  faction.momentum += 1;
  if (faction.claimedTiles % 150 === 0) {
    context.report({
      domain: "territory",
      kind: "territory.settlement-milestone",
      importance: "notable",
      storyKey: campaign.storyKey,
      initiator: realmSubject(campaign.attacker),
      targets: [targetSubject("wilderness")],
      participants: [campaignSubject(campaign), theaterSubject(theater.id, theater.attacker)],
      links: { campaign: campaign.id, theater: theater.id },
      facts: {
        claimedTiles: faction.claimedTiles,
        campaignCaptures: campaign.captures,
        terrain: tile.terrain,
      },
      summary: `${PLAYERS[campaign.attacker].realmName} reached ${faction.claimedTiles} settled wilderness sectors.`,
    });
    context.emit(
      `${PLAYERS[campaign.attacker].realmName} settles its ${faction.claimedTiles}th piece of the unclaimed world.`,
      "rise",
      campaign.attacker,
    );
  }
}

function finishCampaign(
  context: SimulationContext,
  campaign: Campaign,
  returnRate: number,
  announce = false,
  outcome = "closed",
): void {
  const survivors = Math.max(0, campaign.remaining * returnRate);
  for (const theater of context.state.theaters) {
    if (
      theater.campaignId !== campaign.id ||
      theater.captures <= 0 ||
      theater.victoryReported
    ) continue;
    theater.victoryReported = true;
    context.report({
      domain: "military",
      kind: "military.theater-victory",
      importance: theater.captures >= 25 ? "major" : "notable",
      storyKey: campaign.storyKey,
      initiator: realmSubject(campaign.attacker),
      targets: [theaterSubject(theater.id, theater.attacker), targetSubject(campaign.target)],
      participants: [campaignSubject(campaign)],
      links: { campaign: campaign.id, theater: theater.id },
      facts: {
        captures: theater.captures,
        duration: context.state.tick - theater.formedAt,
        outcome,
      },
      summary: `${theaterSubject(theater.id, theater.attacker).label} closed after securing ${theater.captures} sectors.`,
    });
  }
  const relation = campaign.target === "wilderness"
    ? null
    : getRelation(context.state, campaign.attacker, campaign.target);
  context.report({
    domain: "military",
    kind: "military.campaign-concluded",
    importance: campaign.captures > 0 ? "major" : "notable",
    storyKey: campaign.storyKey,
    initiator: realmSubject(campaign.attacker),
    targets: [targetSubject(campaign.target)],
    participants: [campaignSubject(campaign)],
    links: {
      campaign: campaign.id,
      ...(relation ? { relation: relation.key } : {}),
    },
    facts: {
      outcome,
      mode: campaign.mode,
      initialCommitted: campaign.initialCommitted,
      initialDefenderCommitted: campaign.initialDefenderCommitted,
      captures: campaign.captures,
      casualties: campaign.casualties,
      survivors,
      duration: context.state.tick - campaign.launchedAt,
    },
    summary: campaign.target === "wilderness"
      ? `${PLAYERS[campaign.attacker].realmName}'s settlement campaign concluded after claiming ${campaign.captures} sectors.`
      : `${PLAYERS[campaign.attacker].realmName}'s campaign against ${PLAYERS[campaign.target].realmName} concluded after taking ${campaign.captures} sectors.`,
  });
  context.state.factions[campaign.attacker].troops += survivors;
  if (campaign.target !== "wilderness") {
    const defendersReturning = Math.max(0, campaign.defenderRemaining * 0.9);
    context.state.factions[campaign.target].troops += defendersReturning;
  }
  if (announce && campaign.captures > 0) {
    context.emit(
      campaign.target === "wilderness"
        ? `${PLAYERS[campaign.attacker].realmName} closes its settlement campaign after claiming ${campaign.captures} tiles; ${compactNumber(survivors)} settlers return home.`
        : `${PLAYERS[campaign.attacker].realmName} closes its campaign after taking ${campaign.captures} tiles; ${compactNumber(survivors)} troops return to the reserve.`,
      campaign.target === "wilderness" ? "rise" : "battle",
      campaign.attacker,
    );
  }
  campaign.remaining = 0;
  campaign.defenderRemaining = 0;
}

function applyDefensiveStunt(context: SimulationContext, campaign: Campaign): void {
  if (campaign.target === "wilderness" || campaign.defenderRemaining <= 0) return;
  const exchange = Math.min(
    campaign.remaining,
    campaign.defenderRemaining,
    Math.max(
      35,
      Math.min(campaign.remaining, campaign.defenderRemaining) * CAMPAIGN_RULES.defenderStuntRate,
    ),
  );
  campaign.remaining -= exchange;
  campaign.defenderRemaining -= exchange;
  campaign.casualties += exchange;
  context.state.factions[campaign.attacker].casualties += exchange;
  context.state.factions[campaign.target].casualties += exchange;
}

function applyCombatCosts(
  context: SimulationContext,
  campaign: Campaign,
  defenderLoss: number,
  attackerLoss: number,
): void {
  if (campaign.target === "wilderness") return;
  const defender = context.state.factions[campaign.target];
  const actualDefenderLoss = Math.min(defender.troops, defenderLoss);
  const actualAttackerLoss = Math.min(campaign.remaining, attackerLoss);
  defender.troops -= actualDefenderLoss;
  defender.casualties += actualDefenderLoss;
  campaign.remaining -= actualAttackerLoss;
  campaign.casualties += actualAttackerLoss;
  context.state.factions[campaign.attacker].casualties += actualAttackerLoss;
}

function processNavalCampaign(context: SimulationContext, campaign: Campaign): void {
  if (campaign.target === "wilderness") return;
  const { state, random } = context;
  const attacker = state.factions[campaign.attacker];
  const defender = state.factions[campaign.target];

  if (campaign.eta > 0) {
    const escort = 1 + attacker.warships * 0.42;
    const interceptionLoss =
      (defender.warships * 480 * (0.78 + random.next() * 0.44)) / escort;
    if (interceptionLoss > 0) {
      campaign.remaining = Math.max(0, campaign.remaining - interceptionLoss);
      campaign.casualties += interceptionLoss;
      attacker.casualties += interceptionLoss;
    }
    campaign.eta -= 1;
    if (campaign.remaining < 4_000) {
      context.report({
        domain: "military",
        kind: "military.naval-expedition-lost",
        importance: "major",
        storyKey: campaign.storyKey,
        initiator: realmSubject(campaign.attacker),
        targets: [realmSubject(campaign.target)],
        participants: [campaignSubject(campaign)],
        links: { campaign: campaign.id },
        facts: {
          casualties: campaign.casualties,
          warshipsAttacker: attacker.warships,
          warshipsDefender: defender.warships,
        },
        summary: `${PLAYERS[campaign.attacker].realmName}'s naval expedition was destroyed before making landfall.`,
      });
      context.emit(
        `${PLAYERS[campaign.attacker].realmName}'s transport fleet is scattered before reaching shore.`,
        "battle",
        campaign.target,
      );
      campaign.remaining = 0;
    }
    return;
  }

  const targetIndex = campaign.targetIndex;
  if (targetIndex === null || state.cells[targetIndex]!.owner !== campaign.target) {
    finishCampaign(context, campaign, 0.7, false, "no-landing-site");
    return;
  }

  const tile = state.cells[targetIndex]!;
  const cellArea = normalizedCellArea(state.config);
  // A landing costs more than a march, but is priced the same way: force over
  // the cost of the ground, with nothing about the defender's army in it.
  const defense = conquestCostAt(state, targetIndex, campaign.target)
    * CAMPAIGN_RULES.landingCostMultiplier;
  const traitorVulnerability = state.tick < defender.traitorUntil
    ? DIPLOMACY_RULES.traitorAttackMultiplier
    : 1;
  const landingTroops = Math.max(0, campaign.remaining);
  if (landingTroops <= 0) return;
  const progress =
    (landingTroops
      * realmMatchup(state, campaign.attacker, campaign.target)
      * traitorVulnerability
      * state.config.aggression)
    / (CAMPAIGN_RULES.troopsToTakeATile * Math.max(0.5, defense));
  trackPressure(state, targetIndex);
  tile.pressureBy = campaign.attacker;
  tile.pressure += progress;
  const defenderLoss = landingTroops * progress * 0.05 * defense * cellArea;
  const casualtyFactor = clamp(0.55 + defense * 0.28, 0.5, 1.45);
  applyCombatCosts(context, campaign, defenderLoss, defenderLoss * defense * casualtyFactor);

  if (tile.pressure >= 1) {
    captureEnemyTile(context, campaign, null, targetIndex);
    campaign.mode = "land";
    campaign.targetIndex = null;
    campaign.pathIndices = [];
    context.report({
      domain: "military",
      kind: "military.beachhead-established",
      importance: "major",
      storyKey: campaign.storyKey,
      initiator: realmSubject(campaign.attacker),
      targets: [realmSubject(campaign.target)],
      participants: [campaignSubject(campaign)],
      links: { campaign: campaign.id },
      facts: { tileIndex: targetIndex, troopsRemaining: campaign.remaining },
      summary: `${PLAYERS[campaign.attacker].realmName} established a beachhead in ${PLAYERS[campaign.target].realmName}.`,
    });
    context.emit(
      `${PLAYERS[campaign.attacker].realmName} establishes a beachhead with ${compactNumber(campaign.remaining)} troops still ashore.`,
      "battle",
      campaign.attacker,
    );
  }
}

function activeTheaters(context: SimulationContext, campaign: Campaign): Theater[] {
  return context.state.theaters.filter(
    (theater) =>
      theater.campaignId === campaign.id &&
      theater.staleRefreshes === 0 &&
      theater.allocation > 0 &&
      theater.boundaryCells.length > 0,
  );
}

function processSettlementCampaign(context: SimulationContext, campaign: Campaign): void {
  const { state } = context;
  const theaters = activeTheaters(context, campaign);
  if (theaters.length === 0) return;
  const currentBoundary = new Set(
    campaignBoundaryTargets(state, campaign.attacker, "wilderness"),
  );
  const boundaryByRegion = new Map<number, number[]>();
  for (const index of currentBoundary) {
    const regionId = state.regionByCell[index]!;
    if (regionId < 0) continue;
    const regionBoundary = boundaryByRegion.get(regionId) ?? [];
    regionBoundary.push(index);
    boundaryByRegion.set(regionId, regionBoundary);
  }
  const lengthScale = normalizedCellLength(state.config);
  const settle = openLens(state, campaign.attacker, "settle");

  for (const theater of theaters) {
    const targets = boundaryByRegion.get(theater.regionId) ?? [];
    if (targets.length === 0) continue;
    const weights = theaterFrontWeights(state, theater, targets);
    for (const targetIndex of targets) {
      const tile = state.cells[targetIndex]!;
      trackPressure(state, targetIndex);
      const cost = conquestCostAt(state, targetIndex, "wilderness");
      const compactness = 1 + ownedNeighborCount(state, targetIndex, campaign.attacker) * 0.045;
      const assignedTroops = theater.allocation * (weights.get(targetIndex) ?? 0);
      const readiness = clamp(assignedTroops / 850, 0.015, 1.45);
      // Settlers press hardest on the ground they most want. Preference comes
      // from the theater map rather than from terrain cost alone, so a tile is
      // judged by what its owner believes about the country around it as well
      // as by what the tile is: identical ground in a region thought rich and
      // open is taken before the same ground in one written off or unknown.
      const preference = SETTLE_PREFERENCE_FLOOR
        + settle.at(targetIndex) * SETTLE_PREFERENCE_RANGE;
      const progress =
        CLAIM_RULES.pressurePerTick *
        readiness *
        compactness *
        preference *
        state.config.aggression /
        (cost * Math.max(0.7, lengthScale));
      if (tile.pressureBy && tile.pressureBy !== campaign.attacker) {
        tile.pressure = Math.max(0, tile.pressure - progress);
        if (tile.pressure === 0) tile.pressureBy = campaign.attacker;
      } else {
        tile.pressureBy = campaign.attacker;
        tile.pressure += progress;
      }
      if (tile.pressure >= 1) settleWildernessTile(context, campaign, theater, targetIndex);
      if (campaign.remaining <= 0) return;
    }
  }
}

function processLandCampaign(context: SimulationContext, campaign: Campaign): void {
  if (campaign.target === "wilderness") return;
  const { state } = context;
  const defender = state.factions[campaign.target];
  const theaters = activeTheaters(context, campaign);
  const currentBoundary = new Set(
    campaignBoundaryTargets(state, campaign.attacker, campaign.target),
  );
  const boundaryByRegion = new Map<number, number[]>();
  for (const index of currentBoundary) {
    const regionId = state.regionByCell[index]!;
    if (regionId < 0) continue;
    const regionBoundary = boundaryByRegion.get(regionId) ?? [];
    regionBoundary.push(index);
    boundaryByRegion.set(regionId, regionBoundary);
  }
  const cellArea = normalizedCellArea(state.config);
  const traitorVulnerability = state.tick < defender.traitorUntil
    ? DIPLOMACY_RULES.traitorAttackMultiplier
    : 1;
  for (const theater of theaters) {
    const targets = boundaryByRegion.get(theater.regionId) ?? [];
    if (targets.length === 0) continue;
    const weights = theaterFrontWeights(state, theater, targets);
    for (const targetIndex of targets) {
      if (campaign.remaining <= 0 || defender.troops <= 0) return;
      const tile = state.cells[targetIndex]!;
      trackPressure(state, targetIndex);
      const defense = conquestCostAt(state, targetIndex, campaign.target);
      const localSupport = 1 + ownedNeighborCount(state, targetIndex, campaign.attacker) * 0.055;
      // The front's force is spread over the tiles it presses, weighted so the
      // push leans on what the theater judged worth taking.
      const assignedTroops = theater.allocation * (weights.get(targetIndex) ?? 0);
      const progress =
        (assignedTroops
          * realmMatchup(state, campaign.attacker, campaign.target)
          * traitorVulnerability
          * localSupport
          * state.config.aggression)
        / (CAMPAIGN_RULES.troopsToTakeATile * Math.max(0.5, defense));
      if (tile.pressureBy && tile.pressureBy !== campaign.attacker) {
        tile.pressure = Math.max(0, tile.pressure - progress * 0.9);
        if (tile.pressure === 0) tile.pressureBy = campaign.attacker;
      } else {
        tile.pressureBy = campaign.attacker;
        tile.pressure += progress;
      }

      // Losses follow the fighting: a contested push costs both sides, and a
      // one-sided one costs the loser most.
      // Ground changing hands costs lives on both sides, in proportion to how
      // hard it was to take rather than to how many people lived there.
      const defenderLoss = assignedTroops * progress * 0.05 * defense * cellArea;
      const casualtyFactor = clamp(0.55 + defense * 0.28, 0.5, 1.45);
      applyCombatCosts(context, campaign, defenderLoss, defenderLoss * defense * casualtyFactor);
      if (tile.pressure >= 1) captureEnemyTile(context, campaign, theater, targetIndex);
    }
  }
}

function campaignStillValid(context: SimulationContext, campaign: Campaign): boolean {
  const { state } = context;
  if (!state.factions[campaign.attacker].alive) return false;
  if (campaign.target === "wilderness") {
    return campaignBoundaryTargets(state, campaign.attacker, "wilderness").length > 0;
  }
  return state.factions[campaign.target].alive && isAtWar(state, campaign.attacker, campaign.target);
}

function conserveTheaterAllocation(context: SimulationContext, campaign: Campaign): void {
  const theaters = context.state.theaters.filter(
    (theater) => theater.campaignId === campaign.id && theater.staleRefreshes === 0,
  );
  const total = theaters.reduce((sum, theater) => sum + theater.allocation, 0);
  // Blunting already cancelled attackers one for one when it happened;
  // deducting the defenders again would charge the same soldiers twice.
  const usable = Math.max(0, campaign.remaining);
  if (total <= usable || total <= 0) return;
  const scale = usable / total;
  for (const theater of theaters) theater.allocation *= scale;
}

export class CampaignSystem implements SimulationSystem {
  readonly id = "target-campaign-theater-advance";

  update(context: SimulationContext): void {
    const { state } = context;
    for (const campaign of state.campaigns) {
      if (campaign.remaining <= 0) continue;
      if (!campaignStillValid(context, campaign)) {
        finishCampaign(
          context,
          campaign,
          campaign.target === "wilderness" ? 0.96 : 0.82,
          true,
          campaign.target === "wilderness" ? "frontier-complete" : "target-lost",
        );
        continue;
      }
      if (
        campaign.target !== "wilderness" &&
        state.tick - campaign.launchedAt > CAMPAIGN_RULES.maximumDurationTicks
      ) {
        finishCampaign(context, campaign, 0.68, true, "time-expired");
        continue;
      }
      const minimum = campaign.target === "wilderness"
        ? CLAIM_RULES.minimumCampaignCommitment * 0.2
        : Math.max(4_500, campaign.initialCommitted * 0.035);
      if (campaign.remaining < minimum) {
        finishCampaign(
          context,
          campaign,
          campaign.target === "wilderness" ? 0.9 : 0.45,
          true,
          "depleted",
        );
        continue;
      }

      applyDefensiveStunt(context, campaign);
      if (campaign.remaining <= 0) {
        finishCampaign(context, campaign, 0, false, "destroyed");
        continue;
      }

      if (campaign.mode === "naval") processNavalCampaign(context, campaign);
      else if (campaign.target === "wilderness") processSettlementCampaign(context, campaign);
      else processLandCampaign(context, campaign);
      conserveTheaterAllocation(context, campaign);
    }
    state.campaigns = state.campaigns.filter((campaign) => campaign.remaining > 0);
    const activeCampaignIds = new Set(state.campaigns.map((campaign) => campaign.id));
    state.theaters = state.theaters.filter((theater) => activeCampaignIds.has(theater.campaignId));
  }
}
