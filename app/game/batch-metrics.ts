import { PLAYER_ORDER } from "./players";
import { committedTroopsFor, livingTroopsFor } from "./campaigns";
import { getRelation } from "./diplomacy";

import { isFrontierCell } from "./grid";
import {
  ECONOMY_RULES,
  populationGrowthEfficiency,
} from "./rules";
import { ELEMENTS } from "./elements";
import { STRATEGIC_DOMAINS } from "./strategy";
import type {
  ElementId,
  ElementTier,
  PlayerId,
  StrategicDomain,
  StructureCounts,
  StructureType,
  WorldReportEvent,
  WorldState,
} from "./types";

export interface PlayerCumulativeMetrics {
  structuresBuilt: StructureCounts;
  citySitesBuilt: number;
  structuresCaptured: StructureCounts;
  citySitesCaptured: number;
  structuresLost: StructureCounts;
  citySitesLost: number;
  structureSpend: number;
  warshipSpend: number;
  navalSpend: number;
  nominalPassiveIncome: number;
  trainIncomeEarned: number;
  trainIncomeHosted: number;
  shipIncomeEarned: number;
  shipIncomeHosted: number;
  pulseIncomeEarned: number;
  pulseIncomeHosted: number;
  flyerIncomeEarned: number;
  flyerIncomeHosted: number;
  /** Foreign deliveries this realm hosted at a trade-form-resonant share. */
  resonantVoyagesHosted: number;
  domesticStopsServed: number;
  foreignStopsServed: number;
  foreignStopsHosted: number;
  trainsCompleted: number;
  shipsCompleted: number;
  pulsesCompleted: number;
  flyersCompleted: number;
  warsDeclared: number;
  peaceTreaties: number;
  alliancesOffered: number;
  alliancesFormed: number;
  alliancesBetrayed: number;
  campaignsLaunched: number;
  campaignsReinforced: number;
  attackingTroopsCommitted: number;
  defendingTroopsCommitted: number;
  theatersFormed: number;
  theatersWon: number;
  capitalsCaptured: number;
  realmsConquered: number;
  ticksAlive: number;
  ticksAtWar: number;
  ticksAllied: number;
  ticksTraitorExposed: number;
  ticksTreasuryCapped: number;
  ticksPopulationBelow20: number;
  ticksPopulation20To50: number;
  ticksPopulationNearPeak: number;
  ticksPopulationOver82: number;
  homeRatioTotal: number;
  committedRatioTotal: number;
  growthEfficiencyTotal: number;
  strategyChanges: number;
  ticksByFocus: Record<StrategicDomain, number>;
  /** Elemental ascensions this realm achieved, tier 2 and 3 together. */
  ascensions: number;
}

export interface PlayerBalanceSnapshot {
  id: PlayerId;
  alive: boolean;
  landShare: number;
  territory: number;
  sustainableLand: number;
  frontierCells: number;
  homePopulation: number;
  committedPopulation: number;
  livingPopulation: number;
  populationCap: number;
  homeRatio: number;
  committedRatio: number;
  growthEfficiency: number;
  troopGrowth: number;
  powerShare: number;
  gold: number;
  currentIncome: number;
  warWeariness: number;
  casualties: number;
  absorbedElements: number;
  expressedElement: ElementId;
  expressedTier: ElementTier;
  strategicFocus: StrategicDomain;
  structuresOwned: StructureCounts;
  citySitesOwned: number;
  stackedCityLevelsOwned: number;
  activeCampaigns: number;
  incomingCampaigns: number;
  activeTheaters: number;
  activeTrains: number;
  activeShips: number;
  activePulses: number;
  activeFlyers: number;
  activeWars: number;
  activeAlliances: number;
  cumulative: PlayerCumulativeMetrics;
}

export interface WorldBalanceSnapshot {
  tick: number;
  minute: number;
  champion: PlayerId | null;
  aliveRealms: number;
  settledShare: number;
  leader: PlayerId | null;
  leaderLandShare: number;
  landConcentrationHhi: number;
  treasuryGini: number;
  /** Living realms by the tier of the element they express. */
  tierCounts: Record<"1" | "2" | "3", number>;
  populationConcentrationHhi: number;
  totalHomePopulation: number;
  totalCommittedPopulation: number;
  totalPopulationCap: number;
  averageHomeRatio: number;
  averageGrowthEfficiency: number;
  totalTreasury: number;
  structuresOwned: StructureCounts;
  citySitesOwned: number;
  stackedCityLevelsOwned: number;
  citiesBuilt: number;
  citySitesBuilt: number;
  citiesCaptured: number;
  citySitesCaptured: number;
  citiesLost: number;
  structureSpend: number;
  nominalPassiveIncome: number;
  trainIncome: number;
  shipIncome: number;
  pulseIncome: number;
  flyerIncome: number;
  activeWars: number;
  activeAlliances: number;
  activeCampaigns: number;
  activeTheaters: number;
  activeTrains: number;
  activeShips: number;
  activePulses: number;
  activeFlyers: number;
  railEdges: number;
  conduitEdges: number;
  /** Living realms by current strategic focus. */
  focusCounts: Record<StrategicDomain, number>;
  eventCounts: Record<string, number>;
  firstEventTicks: Record<string, number>;
  milestones: Record<string, number>;
  players: Record<PlayerId, PlayerBalanceSnapshot>;
}

function emptyStructures(): StructureCounts {
  return { city: 0, fort: 0, factory: 0, harbor: 0, plant: 0, skyport: 0 };
}

function emptyFocusCounts(): Record<StrategicDomain, number> {
  return Object.fromEntries(
    STRATEGIC_DOMAINS.map((domain) => [domain, 0]),
  ) as Record<StrategicDomain, number>;
}

function emptyPlayerMetrics(): PlayerCumulativeMetrics {
  return {
    structuresBuilt: emptyStructures(),
    citySitesBuilt: 0,
    structuresCaptured: emptyStructures(),
    citySitesCaptured: 0,
    structuresLost: emptyStructures(),
    citySitesLost: 0,
    structureSpend: 0,
    warshipSpend: 0,
    navalSpend: 0,
    nominalPassiveIncome: 0,
    trainIncomeEarned: 0,
    trainIncomeHosted: 0,
    shipIncomeEarned: 0,
    shipIncomeHosted: 0,
    pulseIncomeEarned: 0,
    pulseIncomeHosted: 0,
    flyerIncomeEarned: 0,
    flyerIncomeHosted: 0,
    resonantVoyagesHosted: 0,
    domesticStopsServed: 0,
    foreignStopsServed: 0,
    foreignStopsHosted: 0,
    trainsCompleted: 0,
    shipsCompleted: 0,
    pulsesCompleted: 0,
    flyersCompleted: 0,
    warsDeclared: 0,
    peaceTreaties: 0,
    alliancesOffered: 0,
    alliancesFormed: 0,
    alliancesBetrayed: 0,
    campaignsLaunched: 0,
    campaignsReinforced: 0,
    attackingTroopsCommitted: 0,
    defendingTroopsCommitted: 0,
    theatersFormed: 0,
    theatersWon: 0,
    capitalsCaptured: 0,
    realmsConquered: 0,
    ticksAlive: 0,
    ticksAtWar: 0,
    ticksAllied: 0,
    ticksTraitorExposed: 0,
    ticksTreasuryCapped: 0,
    ticksPopulationBelow20: 0,
    ticksPopulation20To50: 0,
    ticksPopulationNearPeak: 0,
    ticksPopulationOver82: 0,
    homeRatioTotal: 0,
    committedRatioTotal: 0,
    growthEfficiencyTotal: 0,
    strategyChanges: 0,
    ticksByFocus: emptyFocusCounts(),
    ascensions: 0,
  };
}

function realmFromTarget(event: WorldReportEvent): PlayerId | null {
  return event.targets.find((target) => target.type === "realm")?.realmId ?? null;
}

function structureFrom(event: WorldReportEvent): StructureType | null {
  const structure = event.facts.structure;
  return structure === "city" || structure === "fort" || structure === "factory"
    || structure === "harbor" || structure === "plant" || structure === "skyport"
    ? structure
    : null;
}

function cloneCumulative(metrics: PlayerCumulativeMetrics): PlayerCumulativeMetrics {
  return {
    ...metrics,
    structuresBuilt: { ...metrics.structuresBuilt },
    structuresCaptured: { ...metrics.structuresCaptured },
    structuresLost: { ...metrics.structuresLost },
    ticksByFocus: { ...metrics.ticksByFocus },
  };
}

function concentration(values: number[]): number {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return 0;
  return values.reduce((sum, value) => sum + Math.pow(Math.max(0, value) / total, 2), 0);
}

function gini(values: number[]): number {
  const sorted = values.map((value) => Math.max(0, value)).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || sorted.length <= 1) return 0;
  const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

function addStructure(target: StructureCounts, structure: StructureType, levels = 1): void {
  target[structure] += levels;
}

export class BatchMetricsCollector {
  private readonly players = Object.fromEntries(
    PLAYER_ORDER.map((id) => [id, emptyPlayerMetrics()]),
  ) as Record<PlayerId, PlayerCumulativeMetrics>;
  private readonly tradeIncomeThisTick = Object.fromEntries(
    PLAYER_ORDER.map((id) => [id, 0]),
  ) as Record<PlayerId, number>;
  private readonly eventCounts: Record<string, number> = {};
  private readonly firstEventTicks: Record<string, number> = {};
  private readonly milestones: Record<string, number> = {};

  record = (event: WorldReportEvent): void => {
    this.eventCounts[event.kind] = (this.eventCounts[event.kind] ?? 0) + 1;
    this.firstEventTicks[event.kind] ??= event.tick;
    const actor = event.initiator?.realmId ?? null;
    const target = realmFromTarget(event);

    if (event.kind === "infrastructure.structure-built" && actor) {
      const structure = structureFrom(event);
      if (structure) {
        addStructure(this.players[actor].structuresBuilt, structure);
        this.players[actor].structureSpend += Number(event.facts.cost ?? 0);
        if (structure === "city" && event.facts.stacked !== true) this.players[actor].citySitesBuilt += 1;
      }
    }
    if (event.kind === "territory.structure-captured" && actor && target) {
      const structure = structureFrom(event);
      if (structure) {
        const levels = structure === "city" ? Math.max(1, Number(event.facts.structureLevel ?? 1)) : 1;
        addStructure(this.players[actor].structuresCaptured, structure, levels);
        addStructure(this.players[target].structuresLost, structure, levels);
        if (structure === "city") {
          this.players[actor].citySitesCaptured += 1;
          this.players[target].citySitesLost += 1;
        }
      }
    }
    if (event.kind === "military.warship-built" && actor) {
      this.players[actor].warshipSpend += Number(event.facts.cost ?? 0);
    }
    if ((event.kind === "military.campaign-launched" || event.kind === "military.campaign-reinforced") && actor) {
      this.players[actor].navalSpend += Number(event.facts.goldCost ?? 0);
      this.players[actor].attackingTroopsCommitted += Number(event.facts.troops ?? 0);
      if (event.kind === "military.campaign-launched") this.players[actor].campaignsLaunched += 1;
      else this.players[actor].campaignsReinforced += 1;
    }
    if (event.kind === "military.defense-committed" && actor) {
      this.players[actor].defendingTroopsCommitted += Number(event.facts.troops ?? 0);
    }
    if (event.kind === "military.theater-formed" && actor) this.players[actor].theatersFormed += 1;
    if (event.kind === "military.theater-victory" && actor) this.players[actor].theatersWon += 1;
    if (event.kind === "territory.capital-captured" && actor) this.players[actor].capitalsCaptured += 1;
    if (event.kind === "territory.realm-conquered" && actor) this.players[actor].realmsConquered += 1;
    if (event.kind === "diplomacy.war-declared" && actor) this.players[actor].warsDeclared += 1;
    if (event.kind === "diplomacy.peace-made" && actor) this.players[actor].peaceTreaties += 1;
    if (event.kind === "diplomacy.alliance-offered" && actor) this.players[actor].alliancesOffered += 1;
    if (event.kind === "diplomacy.alliance-formed" && actor) this.players[actor].alliancesFormed += 1;
    if (event.kind === "diplomacy.alliance-betrayed" && actor) this.players[actor].alliancesBetrayed += 1;
    if (event.kind === "leadership.strategy-adopted" && actor) this.players[actor].strategyChanges += 1;
    if (event.kind === "dynasty.element-ascended" && actor) this.players[actor].ascensions += 1;

    if (event.kind === "trade.train-stop-served" && actor) {
      const ownerIncome = Number(event.facts.ownerIncome ?? 0);
      this.players[actor].trainIncomeEarned += ownerIncome;
      this.tradeIncomeThisTick[actor] += ownerIncome;
      if (event.facts.foreign === true) this.players[actor].foreignStopsServed += 1;
      else this.players[actor].domesticStopsServed += 1;
      if (target && target !== actor) {
        const hostIncome = Number(event.facts.hostIncome ?? 0);
        this.players[target].trainIncomeHosted += hostIncome;
        this.players[target].foreignStopsHosted += 1;
        this.tradeIncomeThisTick[target] += hostIncome;
      }
    }
    if (event.kind === "trade.journey-completed" && actor) {
      const kind = event.facts.vehicleKind;
      if (kind === "train") this.players[actor].trainsCompleted += 1;
      if (kind === "ship" || kind === "pulse" || kind === "flyer") {
        const ownerIncome = Number(event.facts.income ?? 0);
        if (kind === "ship") {
          this.players[actor].shipsCompleted += 1;
          this.players[actor].shipIncomeEarned += ownerIncome;
        } else if (kind === "pulse") {
          this.players[actor].pulsesCompleted += 1;
          this.players[actor].pulseIncomeEarned += ownerIncome;
        } else {
          this.players[actor].flyersCompleted += 1;
          this.players[actor].flyerIncomeEarned += ownerIncome;
        }
        this.tradeIncomeThisTick[actor] += ownerIncome;
        if (target && target !== actor) {
          const hostIncome = Number(event.facts.hostIncome ?? 0);
          if (kind === "ship") this.players[target].shipIncomeHosted += hostIncome;
          else if (kind === "pulse") this.players[target].pulseIncomeHosted += hostIncome;
          else this.players[target].flyerIncomeHosted += hostIncome;
          this.tradeIncomeThisTick[target] += hostIncome;
          if (Number(event.facts.sharedForms ?? 0) > 0) {
            this.players[target].resonantVoyagesHosted += 1;
          }
        }
      }
    }
  };

  tick = (state: WorldState): void => {
    let activeWarPairs = 0;
    let activeAlliancePairs = 0;
    for (const relation of Object.values(state.relations)) {
      if (!relation.parties.every((id) => state.factions[id].alive)) continue;
      if (relation.status === "war") activeWarPairs += 1;
      if (relation.status === "truce") activeAlliancePairs += 1;
    }
    if (activeWarPairs > 0) this.milestones.firstWarTick ??= state.tick;
    if (activeAlliancePairs > 0) this.milestones.firstAllianceTick ??= state.tick;

    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      const metrics = this.players[id];
      if (!faction.alive) {
        this.tradeIncomeThisTick[id] = 0;
        continue;
      }
      metrics.ticksAlive += 1;
      metrics.ticksByFocus[faction.strategy.focus] += 1;
      const committed = committedTroopsFor(state, id);
      const homeRatio = faction.troops / Math.max(1, faction.troopCap);
      const committedRatio = committed / Math.max(1, faction.troopCap);
      metrics.homeRatioTotal += homeRatio;
      metrics.committedRatioTotal += committedRatio;
      metrics.growthEfficiencyTotal += populationGrowthEfficiency(homeRatio);
      if (homeRatio < 0.2) metrics.ticksPopulationBelow20 += 1;
      else if (homeRatio < 0.5) metrics.ticksPopulation20To50 += 1;
      else if (homeRatio <= 0.75) metrics.ticksPopulationNearPeak += 1;
      else if (homeRatio > 0.82) metrics.ticksPopulationOver82 += 1;
      const warCount = Object.values(state.relations).filter(
        (relation) => relation.status === "war" && relation.parties.includes(id),
      ).length;
      const allianceCount = Object.values(state.relations).filter(
        (relation) => relation.status === "truce" && relation.parties.includes(id),
      ).length;
      if (warCount > 0) metrics.ticksAtWar += 1;
      if (allianceCount > 0) metrics.ticksAllied += 1;
      if (state.tick < faction.traitorUntil) metrics.ticksTraitorExposed += 1;
      if (faction.gold >= ECONOMY_RULES.maximumTreasury - 1) metrics.ticksTreasuryCapped += 1;
      metrics.nominalPassiveIncome += Math.max(0, faction.goldRate - this.tradeIncomeThisTick[id]);
      this.tradeIncomeThisTick[id] = 0;

      const cityLevels = faction.structures.city;
      const tradeBuildings = faction.structures.factory + faction.structures.harbor;
      for (const threshold of [1, 5, 10, 25, 50, 80]) {
        if (cityLevels >= threshold) this.milestones[`${id}.cities.${threshold}`] ??= state.tick;
      }
      for (const threshold of [1, 5, 10, 25, 50, 100]) {
        if (tradeBuildings >= threshold) this.milestones[`${id}.trade.${threshold}`] ??= state.tick;
      }
    }

    // Settlement thresholds are sampled every 30 seconds to avoid turning a
    // balance observer into another full-grid simulation system.
    if (state.tick % 30 === 0) {
      const unclaimed = state.cells.reduce(
        (total, cell) => total + (cell.terrain !== "water" && cell.owner === null ? 1 : 0),
        0,
      );
      const settled = 1 - unclaimed / state.landTiles;
      for (const threshold of [0.8, 0.9, 0.98, 1]) {
        if (settled >= threshold) this.milestones[`world.settled.${threshold}`] ??= state.tick;
      }
    }
  };

  snapshot(state: WorldState): WorldBalanceSnapshot {
    const citySites = Object.fromEntries(PLAYER_ORDER.map((id) => [id, 0])) as Record<PlayerId, number>;
    const frontierCells = Object.fromEntries(PLAYER_ORDER.map((id) => [id, 0])) as Record<PlayerId, number>;
    let unclaimed = 0;
    for (let index = 0; index < state.cells.length; index += 1) {
      const cell = state.cells[index]!;
      if (cell.terrain !== "water" && cell.owner === null) unclaimed += 1;
      if (!cell.owner) continue;
      if (cell.structure === "city") citySites[cell.owner] += 1;
      if (isFrontierCell(state, index)) frontierCells[cell.owner] += 1;
    }
    const livingByNation = PLAYER_ORDER.map((id) => livingTroopsFor(state, id));
    const totalLiving = livingByNation.reduce((sum, value) => sum + value, 0);
    const playerSnapshots = {} as Record<PlayerId, PlayerBalanceSnapshot>;
    for (const [position, id] of PLAYER_ORDER.entries()) {
      const faction = state.factions[id];
      const committed = committedTroopsFor(state, id);
      const homeRatio = faction.troops / Math.max(1, faction.troopCap);
      playerSnapshots[id] = {
        id,
        alive: faction.alive,
        landShare: faction.territory / state.landTiles,
        territory: faction.territory,
        sustainableLand: faction.sustainableLand,
        frontierCells: frontierCells[id],
        homePopulation: faction.troops,
        committedPopulation: committed,
        livingPopulation: livingByNation[position]!,
        populationCap: faction.troopCap,
        homeRatio,
        committedRatio: committed / Math.max(1, faction.troopCap),
        growthEfficiency: populationGrowthEfficiency(homeRatio),
        troopGrowth: faction.troopGrowth,
        powerShare: totalLiving > 0 ? livingByNation[position]! / totalLiving : 0,
        gold: faction.gold,
        currentIncome: faction.goldRate,
        warWeariness: faction.warWeariness,
        casualties: faction.casualties,
        absorbedElements: faction.absorbedElements.length,
        expressedElement: faction.expressedElement,
        expressedTier: ELEMENTS[faction.expressedElement].tier,
        strategicFocus: faction.strategy.focus,
        structuresOwned: { ...faction.structures },
        citySitesOwned: citySites[id],
        stackedCityLevelsOwned: Math.max(0, faction.structures.city - citySites[id]),
        activeCampaigns: state.campaigns.filter((campaign) => campaign.attacker === id).length,
        incomingCampaigns: state.campaigns.filter((campaign) => campaign.target === id).length,
        activeTheaters: state.theaters.filter((theater) => theater.attacker === id && theater.staleRefreshes === 0).length,
        activeTrains: state.tradeVehicles.filter((vehicle) => vehicle.owner === id && vehicle.kind === "train").length,
        activeShips: state.tradeVehicles.filter((vehicle) => vehicle.owner === id && vehicle.kind === "ship").length,
        activePulses: state.tradeVehicles.filter((vehicle) => vehicle.owner === id && vehicle.kind === "pulse").length,
        activeFlyers: state.tradeVehicles.filter((vehicle) => vehicle.owner === id && vehicle.kind === "flyer").length,
        activeWars: PLAYER_ORDER.filter((other) => other !== id && getRelation(state, id, other).status === "war").length,
        activeAlliances: PLAYER_ORDER.filter((other) => other !== id && getRelation(state, id, other).status === "truce").length,
        cumulative: cloneCumulative(this.players[id]),
      };
    }

    const alive = PLAYER_ORDER.filter((id) => state.factions[id].alive);
    const focusCounts = emptyFocusCounts();
    for (const id of alive) focusCounts[state.factions[id].strategy.focus] += 1;
    const tierCounts: Record<"1" | "2" | "3", number> = { 1: 0, 2: 0, 3: 0 };
    for (const id of alive) {
      tierCounts[String(ELEMENTS[state.factions[id].expressedElement].tier) as "1" | "2" | "3"] += 1;
    }
    const leader = [...alive].sort(
      (first, second) => state.factions[second].territory - state.factions[first].territory,
    )[0] ?? null;
    const structuresOwned = emptyStructures();
    for (const id of PLAYER_ORDER) {
      for (const structure of Object.keys(structuresOwned) as StructureType[]) {
        structuresOwned[structure] += state.factions[id].structures[structure];
      }
    }
    const cumulative = PLAYER_ORDER.map((id) => this.players[id]);
    const total = (selector: (metrics: PlayerCumulativeMetrics) => number) =>
      cumulative.reduce((sum, metrics) => sum + selector(metrics), 0);
    const totalHome = PLAYER_ORDER.reduce((sum, id) => sum + state.factions[id].troops, 0);
    const totalCommitted = PLAYER_ORDER.reduce((sum, id) => sum + committedTroopsFor(state, id), 0);
    const totalCap = PLAYER_ORDER.reduce((sum, id) => sum + state.factions[id].troopCap, 0);

    return {
      tick: state.tick,
      minute: state.tick / 60,
      champion: state.champion,
      aliveRealms: alive.length,
      settledShare: 1 - unclaimed / state.landTiles,
      leader,
      leaderLandShare: leader ? state.factions[leader].territory / state.landTiles : 0,
      landConcentrationHhi: concentration(PLAYER_ORDER.map((id) => state.factions[id].territory)),
      treasuryGini: gini(alive.map((id) => state.factions[id].gold)),
      tierCounts,
      populationConcentrationHhi: concentration(livingByNation),
      totalHomePopulation: totalHome,
      totalCommittedPopulation: totalCommitted,
      totalPopulationCap: totalCap,
      averageHomeRatio: alive.length > 0
        ? alive.reduce((sum, id) => sum + playerSnapshots[id].homeRatio, 0) / alive.length
        : 0,
      averageGrowthEfficiency: alive.length > 0
        ? alive.reduce((sum, id) => sum + playerSnapshots[id].growthEfficiency, 0) / alive.length
        : 0,
      totalTreasury: PLAYER_ORDER.reduce((sum, id) => sum + state.factions[id].gold, 0),
      structuresOwned,
      citySitesOwned: Object.values(citySites).reduce((sum, value) => sum + value, 0),
      stackedCityLevelsOwned: Math.max(0, structuresOwned.city - Object.values(citySites).reduce((sum, value) => sum + value, 0)),
      citiesBuilt: total((metrics) => metrics.structuresBuilt.city),
      citySitesBuilt: total((metrics) => metrics.citySitesBuilt),
      citiesCaptured: total((metrics) => metrics.structuresCaptured.city),
      citySitesCaptured: total((metrics) => metrics.citySitesCaptured),
      citiesLost: total((metrics) => metrics.structuresLost.city),
      structureSpend: total((metrics) => metrics.structureSpend),
      nominalPassiveIncome: total((metrics) => metrics.nominalPassiveIncome),
      trainIncome: total((metrics) => metrics.trainIncomeEarned + metrics.trainIncomeHosted),
      shipIncome: total((metrics) => metrics.shipIncomeEarned + metrics.shipIncomeHosted),
      pulseIncome: total((metrics) => metrics.pulseIncomeEarned + metrics.pulseIncomeHosted),
      flyerIncome: total((metrics) => metrics.flyerIncomeEarned + metrics.flyerIncomeHosted),
      activeWars: Object.values(state.relations).filter(
        (relation) => relation.status === "war" && relation.parties.every((id) => state.factions[id].alive),
      ).length,
      activeAlliances: Object.values(state.relations).filter(
        (relation) => relation.status === "truce" && relation.parties.every((id) => state.factions[id].alive),
      ).length,
      activeCampaigns: state.campaigns.length,
      activeTheaters: state.theaters.filter((theater) => theater.staleRefreshes === 0).length,
      activeTrains: state.tradeVehicles.filter((vehicle) => vehicle.kind === "train").length,
      activeShips: state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship").length,
      activePulses: state.tradeVehicles.filter((vehicle) => vehicle.kind === "pulse").length,
      activeFlyers: state.tradeVehicles.filter((vehicle) => vehicle.kind === "flyer").length,
      railEdges: state.tradeRoutes.filter((route) => route.kind === "rail").length,
      conduitEdges: state.tradeRoutes.filter((route) => route.kind === "conduit").length,
      focusCounts,
      eventCounts: { ...this.eventCounts },
      firstEventTicks: { ...this.firstEventTicks },
      milestones: { ...this.milestones },
      players: playerSnapshots,
    };
  }
}
