import { warsFor } from "../diplomacy";
import { ELEMENT_ORDER } from "../elements";
import {
  canPlaceStructureSite,
  cellsWithin,
  distanceBetween,
  isFrontierCell,
  structureCells,
} from "../grid";
import {
  FORT_RADIUS,
  TERRAIN_RULES,
  TRADE_RULES,
  WARSHIP_COST,
  clamp,
  nextStructureCost,
  normalizedCellArea,
  normalizedCellLength,
} from "../rules";
import type {
  ElementId,
  SimulationContext,
  SimulationSystem,
  StructureCounts,
  StructureType,
} from "../types";

function nearestDistance(
  context: SimulationContext,
  index: number,
  candidates: readonly number[],
  fallback = Number.POSITIVE_INFINITY,
): number {
  if (candidates.length === 0) return fallback;
  return Math.min(...candidates.map((candidate) => distanceBetween(context.state, index, candidate)));
}

function vulnerableBoundaryCells(context: SimulationContext, owner: ElementId): number[] {
  const campaignIds = new Set(
    context.state.campaigns
      .filter((campaign) => campaign.target === owner && campaign.remaining > 0)
      .map((campaign) => campaign.id),
  );
  return context.state.theaters
    .filter((theater) => campaignIds.has(theater.campaignId) && theater.staleRefreshes === 0)
    .sort((a, b) => b.strategicValue * b.allocation - a.strategicValue * a.allocation)
    .flatMap((theater) => theater.boundaryCells);
}

function bestBuildTile(
  context: SimulationContext,
  owner: ElementId,
  structure: StructureType,
  reserved: ReadonlySet<number>,
): number | null {
  const { state } = context;
  let bestIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const atWar = warsFor(state, owner).length > 0;
  const ownFactories = structureCells(state, owner, "factory");
  const ownCities = structureCells(state, owner, "city");
  const vulnerable = vulnerableBoundaryCells(context, owner);
  const peacefulForeignHubs = ELEMENT_ORDER
    .filter((id) => id !== owner)
    .filter((id) => Object.values(state.relations).some(
      (relation) => relation.parties.includes(owner) &&
        relation.parties.includes(id) &&
        relation.status !== "war" &&
        relation.tradeActive,
    ))
    .flatMap((id) => [
      ...structureCells(state, id, "factory"),
      ...structureCells(state, id, "city"),
    ]);
  const railNodes = [...new Set(state.tradeRoutes.flatMap((route) => route.pathIndices))];

  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.owner !== owner || cell.terrain === "water" || reserved.has(index)) continue;

    const stackingCity = structure === "city" && cell.structure === "city";
    if (!stackingCity && !canPlaceStructureSite(state, index, reserved)) continue;
    if (structure !== "city" && cell.structure) continue;
    if (structure === "harbor" && !cell.coastal) continue;

    const frontier = isFrontierCell(state, index);
    if ((structure === "city" || structure === "factory") && frontier && !stackingCity) continue;

    const nearestThreat = nearestDistance(context, index, vulnerable);
    if (structure === "fort") {
      if (vulnerable.length === 0 || nearestThreat > FORT_RADIUS * 1.45) continue;
    }

    let score = context.random.next() * 0.35;
    if (structure === "city") {
      const nearestRail = nearestDistance(context, index, railNodes);
      if (stackingCity) {
        // Spread cities are stronger station economics. Stacking becomes the
        // deliberate defensive choice when an important urban site is exposed.
        score += -3.2 - Math.max(1, cell.structureLevel) * 0.7;
        if (atWar) score += 4.8;
        if (nearestThreat < 8) score += 4.2 - nearestThreat * 0.35;
        if (cell.capitalOf === owner) score += 1.2;
      } else {
        score += TERRAIN_RULES[cell.terrain].sustain * 2.4;
        score += Number.isFinite(nearestRail) ? Math.max(0, 5.5 - nearestRail * 1.15) : 0;
        const citySpacing = nearestDistance(context, index, ownCities);
        score += Number.isFinite(citySpacing)
          ? Math.max(0, 2.6 - Math.abs(citySpacing - 4.2) * 0.48)
          : 0;
      }
    }
    if (structure === "factory") {
      score += TERRAIN_RULES[cell.terrain].goldYield * 0.7;
      const desiredFactoryGap = TRADE_RULES.trainRadius * 1.85;
      const desiredCityGap = TRADE_RULES.trainRadius * 0.9;
      const nearestFactory = nearestDistance(context, index, ownFactories, desiredFactoryGap);
      const nearestCity = nearestDistance(context, index, ownCities, desiredCityGap);
      const nearestRail = nearestDistance(context, index, railNodes);
      const nearestForeign = nearestDistance(context, index, peacefulForeignHubs);
      score += Math.max(0, 6.2 - Math.abs(nearestFactory - desiredFactoryGap) * 0.52);
      score += Math.max(0, 4.4 - Math.abs(nearestCity - desiredCityGap) * 0.48);
      score += Number.isFinite(nearestRail)
        ? Math.max(0, 3.2 - Math.abs(nearestRail - TRADE_RULES.trainRadius * 0.75) * 0.34)
        : 0;
      score += Number.isFinite(nearestForeign)
        ? Math.max(0, 4.2 - Math.abs(nearestForeign - TRADE_RULES.trainRadius * 1.5) * 0.36)
        : 0;
    }
    if (structure === "harbor") {
      score += 3 + TERRAIN_RULES[cell.terrain].goldYield * 0.35;
      score += nearestDistance(context, index, ownCities) < 8 ? 1.2 : 0;
    }
    if (structure === "fort") {
      const nearbyInfrastructure = cellsWithin(
        state,
        index,
        6 / normalizedCellLength(state.config),
      ).reduce((total, nearby) => {
        const nearbyCell = state.cells[nearby]!;
        if (nearbyCell.owner !== owner || !nearbyCell.structure) return total;
        return total + (nearbyCell.structure === "city" ? 2 + nearbyCell.structureLevel : 1);
      }, 0);
      score += TERRAIN_RULES[cell.terrain].defenseCost * 1.8;
      score += Math.max(0, 7 - nearestThreat) * 1.5;
      score += Math.min(6, nearbyInfrastructure * 0.65);
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function desiredInfrastructure(
  context: SimulationContext,
  owner: ElementId,
  counts: StructureCounts,
  allowFort = true,
): StructureType | null {
  const { state } = context;
  const faction = state.factions[owner];
  const physicalTerritory = faction.territory * normalizedCellArea(state.config);
  const desiredCities = clamp(Math.ceil(physicalTerritory / 8), 2, 90);
  const desiredTrade = clamp(Math.ceil(desiredCities * 0.8), 2, 100);
  const desiredHarbors = Math.min(20, Math.ceil(desiredTrade * 0.22));
  const tradeBuildings = counts.factory + counts.harbor;
  const vulnerable = vulnerableBoundaryCells(context, owner);
  const desiredForts = Math.min(18, Math.max(0, Math.ceil(vulnerable.length / 18)));
  const defensiveResourceDump = vulnerable.length > 0 && faction.gold >= 1_250_000;

  if (allowFort && (counts.fort < desiredForts || defensiveResourceDump) && vulnerable.length > 0) return "fort";
  if (counts.city === 0) return "city";
  if (tradeBuildings === 0) return "factory";

  const cityShortfall = Math.max(0, (desiredCities - counts.city) / desiredCities);
  const tradeShortfall = Math.max(0, (desiredTrade - tradeBuildings) / desiredTrade);
  if (cityShortfall <= 0 && tradeShortfall <= 0) return null;
  if (cityShortfall >= tradeShortfall) return "city";
  if (
    counts.factory >= 3 &&
    counts.harbor < desiredHarbors &&
    counts.harbor * 4 < tradeBuildings
  ) return "harbor";
  return "factory";
}

export class ConstructionAiSystem implements SimulationSystem {
  readonly id = "construction-ai";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.tick === 0 || state.tick % state.config.constructionInterval !== 0) return;

    for (const id of ELEMENT_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const shadowCounts = { ...faction.structures };
      const reserved = new Set<number>();
      let budget = faction.gold;

      // Mature trade economies may place several projects in one planning
      // window, while the cost ladders naturally throttle young realms.
      for (let project = 0; project < 4; project += 1) {
        let desired = desiredInfrastructure(context, id, shadowCounts);
        if (!desired) break;
        let cost = nextStructureCost(desired, shadowCounts);
        if (budget < cost && desired === "fort") {
          desired = desiredInfrastructure(context, id, shadowCounts, false);
          if (!desired) break;
          cost = nextStructureCost(desired, shadowCounts);
        }
        if (budget < cost) break;
        let tileIndex = bestBuildTile(context, id, desired, reserved);

        if (tileIndex === null && desired === "fort") {
          desired = desiredInfrastructure(context, id, shadowCounts, false);
          if (!desired) break;
          cost = nextStructureCost(desired, shadowCounts);
          tileIndex = budget >= cost ? bestBuildTile(context, id, desired, reserved) : null;
        }

        // An inland realm should not stall its whole program because no harbor
        // site is currently available; continue growing the rail network.
        if (tileIndex === null && desired === "harbor") {
          desired = "factory";
          cost = nextStructureCost(desired, shadowCounts);
          tileIndex = budget >= cost ? bestBuildTile(context, id, desired, reserved) : null;
        }
        if (tileIndex === null) break;

        state.commands.push({ type: "build-structure", actor: id, structure: desired, tileIndex });
        reserved.add(tileIndex);
        budget -= cost;
        shadowCounts[desired] += 1;
      }

      const wars = warsFor(state, id);
      if (
        faction.structures.harbor > 0 &&
        wars.length > 0 &&
        faction.warships < Math.min(3, wars.length + 1) &&
        budget >= WARSHIP_COST
      ) {
        state.commands.push({ type: "build-warship", actor: id });
      }
    }
  }
}
