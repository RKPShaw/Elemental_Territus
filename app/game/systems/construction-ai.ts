import { PLAYER_ORDER } from "../players";
import { livingTroopsFor } from "../campaigns";
import { getRelation, warsFor } from "../diplomacy";
import { buildDistanceField, distanceAt } from "../distance-field";
import type { DistanceField } from "../distance-field";
import { buildAffinityOf } from "../elements";
import { frontierTargets } from "../frontier";
import { sitesOf } from "../structure-index";

import {
  canPlaceStructureSite,
  cellsWithin,
  distanceBetween,
  isFrontierCell,
} from "../grid";
import {
  ELEMENT_RULES,
  FORT_RADIUS,
  TERRAIN_RULES,
  TRADE_RULES,
  WARSHIP_COST,
  clamp,
  nextStructureCost,
  normalizedCellArea,
  normalizedCellLength,
} from "../rules";
import { strategyQuotaFactor } from "../strategy";
import type {
  PlayerId,
  SimulationContext,
  SimulationSystem,
  StructureCounts,
  StructureType,
} from "../types";

/**
 * Minimum distance from a tile to any of a set of sites, via a prepared
 * distance field. The field answers for every tile at once, so scoring no
 * longer walks the site list per candidate.
 */
function nearestFromField(
  state: SimulationContext["state"],
  field: DistanceField,
  index: number,
  fallback = Number.POSITIVE_INFINITY,
): number {
  const cells = distanceAt(field, index);
  return Number.isFinite(cells) ? cells * normalizedCellLength(state.config) : fallback;
}

function nearestDistance(
  context: SimulationContext,
  index: number,
  candidates: readonly number[],
  fallback = Number.POSITIVE_INFINITY,
): number {
  // Scored once per candidate tile against lists that reach into the thousands
  // of rail cells, so this runs a plain loop: mapping to a temporary array and
  // spreading it into Math.min allocated on every one of those calls.
  if (candidates.length === 0) return fallback;
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = distanceBetween(context.state, index, candidate);
    if (distance < nearest) nearest = distance;
  }
  return nearest;
}

interface BuildIndex {
  /** Land cells each player owns, ascending, so scans stay in map order. */
  cellsByOwner: Map<PlayerId, number[]>;
  /** Structure sites each player owns, by type. */
  structuresByOwner: Map<PlayerId, Record<StructureType, number[]>>;
}

/**
 * One pass over the map, shared by every player's planning this tick.
 *
 * The planner used to re-scan all seventeen thousand cells for each player, for
 * each candidate project, and again for each rival whose trade hubs it wanted
 * to sit near. That is affordable with five players and ruinous with fifty.
 */
function buildIndex(state: SimulationContext["state"]): BuildIndex {
  const cellsByOwner = new Map<PlayerId, number[]>();
  const structuresByOwner = new Map<PlayerId, Record<StructureType, number[]>>();
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    const owner = cell.owner;
    if (!owner) continue;
    let owned = cellsByOwner.get(owner);
    if (!owned) {
      owned = [];
      cellsByOwner.set(owner, owned);
      structuresByOwner.set(owner, { city: [], fort: [], factory: [], harbor: [], plant: [], skyport: [] });
    }
    owned.push(index);
    if (cell.structure) structuresByOwner.get(owner)![cell.structure].push(index);
  }
  return { cellsByOwner, structuresByOwner };
}

const NO_STRUCTURES: Record<StructureType, number[]> = {
  city: [], fort: [], factory: [], harbor: [], plant: [], skyport: [],
};

/** Boundary cells of the invasions actually pressing into this realm now. */
function pressedBoundaryCells(context: SimulationContext, owner: PlayerId): number[] {
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

/** Structures a fort is built to stand over. A fort does not guard forts. */
const FORT_PRIZES: readonly StructureType[] = ["city", "factory", "harbor", "plant", "skyport"];

/** How many approaches a realm keeps under guard, richest first. */
const FORTIFIED_APPROACHES = 10;

/**
 * What an invader gains by breaking in at this cell: the developed ground a
 * fort here would stand over, plus a little for the country itself so that
 * approaches still rank against each other before anything is built.
 */
function approachWorth(state: SimulationContext["state"], index: number, owner: PlayerId): number {
  let worth = TERRAIN_RULES[state.cells[index]!.terrain].sustain * 0.25;
  for (const structure of FORT_PRIZES) {
    for (const site of sitesOf(state, owner, structure)) {
      if (distanceBetween(state, index, site) > FORT_RADIUS) continue;
      const cell = state.cells[site]!;
      worth += cell.capitalOf !== null
        ? 8
        : structure === "city"
          ? 3 + Math.max(0, cell.structureLevel - 1) * 1.5
          : 2;
    }
  }
  return worth;
}

/**
 * The ground worth walling: where a rival would march, not only where one is
 * already marching.
 *
 * A theater is chosen for what it opens divided by what it costs to force
 * (see the priority in theaters.ts), and a fort doubles the cost of every
 * cell in its radius. So a wall on a rich approach moves that quotient twice
 * over: it argues the invasion somewhere else, and it charges double for the
 * ground and double in casualties if the argument fails. That is what the
 * approaches below are ranked for — the realm's own frontier, worth first.
 *
 * Forts used to be wanted only where a campaign was already inside the
 * border, which is why a whole world built barely one: by the time the
 * appetite existed the wall was a monument rather than a defense, and a court
 * at peace with a treasury full never wanted one at all. Ground under attack
 * still comes first and unranked — it is answered because it is burning — and
 * everything after it is the preventive half that was missing.
 */
function fortifiableApproaches(context: SimulationContext, owner: PlayerId): number[] {
  const { state } = context;
  const pressed = pressedBoundaryCells(context, owner);
  const seen = new Set<number>(pressed);
  const ranked: { index: number; worth: number }[] = [];
  for (const rival of PLAYER_ORDER) {
    if (rival === owner || !state.factions[rival].alive) continue;
    // The frontier index answers "which of my cells can this rival step
    // into" for every pair in one pass, and it already refuses the steps a
    // river forbids — so an approach only ranks if an army could really come
    // that way.
    for (const index of frontierTargets(state, rival, owner)) {
      if (seen.has(index)) continue;
      seen.add(index);
      ranked.push({ index, worth: approachWorth(state, index, owner) });
    }
  }
  // Ties break on cell index so the ranking is total and the world stays
  // reproducible.
  ranked.sort((first, second) => second.worth - first.worth || first.index - second.index);
  for (const entry of ranked.slice(0, FORTIFIED_APPROACHES)) pressed.push(entry.index);
  return pressed;
}

function bestBuildTile(
  context: SimulationContext,
  owner: PlayerId,
  structure: StructureType,
  reserved: ReadonlySet<number>,
  sites: BuildIndex,
  railField: DistanceField,
  requireRail = false,
): number | null {
  const { state } = context;
  let bestIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const atWar = warsFor(state, owner).length > 0;
  const ownSites = sites.structuresByOwner.get(owner) ?? NO_STRUCTURES;
  const ownFactories = ownSites.factory;
  const ownCities = ownSites.city;
  const vulnerable = fortifiableApproaches(context, owner);
  const peacefulForeignHubs = PLAYER_ORDER
    .filter((id) => {
      if (id === owner) return false;
      // A keyed lookup, not a scan over every pair in the world.
      const relation = getRelation(state, owner, id);
      return relation.status !== "war" && relation.tradeActive;
    })
    .flatMap((id) => {
      const hubs = sites.structuresByOwner.get(id) ?? NO_STRUCTURES;
      return [...hubs.factory, ...hubs.city];
    });

  // Every placement preference that answers to a trade network is expressed
  // against that carrier's reach rather than in bare world units. The scales
  // here are 1 at the reaches these preferences were originally tuned for (a
  // five-unit train radius, a five-and-a-half-unit conduit), so every
  // coefficient below still evaluates to the literal it used to be -- but
  // when the reach changes the whole build pattern rescales with it instead
  // of keeping slopes that no longer mean anything.
  //
  // That is not cosmetic. Reach was divided by six for the slower economy,
  // and a preference that sheds half a point per world unit cannot tell a
  // good site from a bad one across a network less than a world unit wide:
  // factories scattered over territory they could no longer lay track across,
  // and rail all but stopped forming.
  const railScale = TRADE_RULES.trainRadius / 5;
  const conduitScale = TRADE_RULES.conduitRadius / 5.5;
  // Skyports want a partner inside the flight band; the middle of it is the
  // gap the placement aims for.
  const idealSkyportGap =
    (TRADE_RULES.minimumFlightDistance + TRADE_RULES.flightRadius) / 2;

  for (const index of sites.cellsByOwner.get(owner) ?? []) {
    const cell = state.cells[index]!;
    if (cell.terrain === "water" || reserved.has(index)) continue;

    const stackingCity = structure === "city" && cell.structure === "city";
    if (!stackingCity && !canPlaceStructureSite(state, index, reserved)) continue;
    if (structure !== "city" && cell.structure) continue;
    if (structure === "harbor" && !cell.coastal) continue;

    const frontier = isFrontierCell(state, index);
    if (
      (structure === "city" || structure === "factory" || structure === "plant" || structure === "skyport")
      && frontier && !stackingCity
    ) continue;

    // Only forts and stacking cities read the threat distance, and `vulnerable`
    // is every boundary cell of every theater aimed at this player -- thousands
    // late in a large game. Computing it for candidates that never look at it
    // was the planner's dominant cost.
    let threatDistance = -1;
    const nearestThreat = () => {
      if (threatDistance < 0) threatDistance = nearestDistance(context, index, vulnerable);
      return threatDistance;
    };
    if (structure === "fort") {
      if (vulnerable.length === 0 || nearestThreat() > FORT_RADIUS * 1.45) continue;
    }

    let score = context.random.next() * 0.35;
    if (structure === "city") {
      const nearestRail = nearestFromField(state, railField, index);
      if (stackingCity) {
        // Spread cities are stronger station economics. Stacking becomes the
        // deliberate defensive choice when an important urban site is exposed.
        score += -3.2 - Math.max(1, cell.structureLevel) * 0.7;
        if (atWar) score += 4.8;
        if (nearestThreat() < 8) score += 4.2 - nearestThreat() * 0.35;
        if (cell.capitalOf === owner) score += 1.2;
      } else {
        // Cities belong on the line itself: a station the trains pass through,
        // not a town beside the track that every journey skips.
        if (requireRail && nearestRail !== 0) continue;
        score += TERRAIN_RULES[cell.terrain].sustain * 2.4;
        score += Number.isFinite(nearestRail)
          ? Math.max(0, 5.5 - nearestRail * (1.15 / railScale))
          : 0;
        const citySpacing = nearestDistance(context, index, ownCities);
        score += Number.isFinite(citySpacing)
          ? Math.max(0, 2.6 - Math.abs(citySpacing - 4.2 * railScale) * (0.48 / railScale))
          : 0;
      }
    }
    if (structure === "factory") {
      score += TERRAIN_RULES[cell.terrain].goldYield * 0.7;
      const desiredFactoryGap = TRADE_RULES.trainRadius * 1.85;
      const desiredCityGap = TRADE_RULES.trainRadius * 0.9;
      const nearestFactory = nearestDistance(context, index, ownFactories, desiredFactoryGap);
      const nearestCity = nearestDistance(context, index, ownCities, desiredCityGap);
      const nearestRail = nearestFromField(state, railField, index);
      const nearestForeign = nearestDistance(context, index, peacefulForeignHubs);
      score += Math.max(
        0,
        6.2 - Math.abs(nearestFactory - desiredFactoryGap) * (0.52 / railScale),
      );
      score += Math.max(
        0,
        4.4 - Math.abs(nearestCity - desiredCityGap) * (0.48 / railScale),
      );
      score += Number.isFinite(nearestRail)
        ? Math.max(
          0,
          3.2 - Math.abs(nearestRail - TRADE_RULES.trainRadius * 0.75) * (0.34 / railScale),
        )
        : 0;
      score += Number.isFinite(nearestForeign)
        ? Math.max(
          0,
          4.2 - Math.abs(nearestForeign - TRADE_RULES.trainRadius * 1.5) * (0.36 / railScale),
        )
        : 0;
    }
    if (structure === "harbor") {
      score += 3 + TERRAIN_RULES[cell.terrain].goldYield * 0.35;
      score += nearestDistance(context, index, ownCities) < 8 ? 1.2 : 0;
    }
    if (structure === "plant") {
      // A plant is dead wire without a station in conduit reach, so it sits
      // in the thick of its own network and spaces itself from its siblings
      // roughly a conduit apart.
      const nearestStation = Math.min(
        nearestDistance(context, index, ownCities),
        nearestDistance(context, index, ownFactories),
      );
      if (nearestStation > TRADE_RULES.conduitRadius * 0.85) continue;
      score += TERRAIN_RULES[cell.terrain].goldYield * 0.4;
      score += Math.max(0, 4.5 - nearestStation * (0.9 / conduitScale));
      const nearestPlant = nearestDistance(context, index, ownSites.plant);
      score += Number.isFinite(nearestPlant)
        ? Math.max(
          0,
          3 - Math.abs(nearestPlant - TRADE_RULES.conduitRadius) * (0.5 / conduitScale),
        )
        : 0;
    }
    if (structure === "skyport") {
      // Skyports serve people and want a partner in reach: beside a city, and
      // spaced inside the flight band -- far enough apart that a flight is
      // worth wings, near enough that the apron has anywhere to fly at all.
      // Aprons used to be pushed as far from each other as the map allowed,
      // which was free advice while flights were unbounded and is now the one
      // way to build a skyport that never launches: past flightRadius its
      // siblings stop being destinations. So the reward peaks in the middle of
      // the band and falls to nothing at either edge of it.
      const nearestCity = nearestDistance(context, index, ownCities);
      score += nearestCity < 5 * railScale ? 2.2 - nearestCity * (0.3 / railScale) : 0;
      const nearestSkyport = nearestDistance(context, index, ownSites.skyport);
      score += Number.isFinite(nearestSkyport)
        ? Math.max(
          0,
          3.2 - Math.abs(nearestSkyport - idealSkyportGap) * (3.2 / idealSkyportGap),
        )
        : 1.5;
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
      score += Math.max(0, 7 - nearestThreat()) * 1.5;
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
  owner: PlayerId,
  counts: StructureCounts,
  allowFort = true,
): StructureType | null {
  const { state } = context;
  const faction = state.factions[owner];
  const physicalTerritory = faction.territory * normalizedCellArea(state.config);
  // Quotas lean the way the realm's priorities lean: cities carry the troop
  // cap for conquest, trade buildings carry the economy, forts the defense.
  // The damped factor keeps the drift gentle — a program, not a lurch.
  const cityQuota = strategyQuotaFactor(faction.strategy, "conquest");
  const tradeQuota = (
    strategyQuotaFactor(faction.strategy, "economy")
    + strategyQuotaFactor(faction.strategy, "trade")
  ) / 2;
  const fortQuota = strategyQuotaFactor(faction.strategy, "defense");
  // Trade forms lean the same program toward their carriers: a waterway realm
  // wants half again the harbor share, and matched carriers jump the build
  // queue through the shortfall weights below without changing the totals the
  // quotas ask for.
  const affinity = buildAffinityOf(faction.expressedElement);
  const desiredCities = clamp(Math.ceil((physicalTerritory / 8) * cityQuota), 2, 90);
  const desiredTrade = clamp(Math.ceil(desiredCities * 0.8 * tradeQuota), 2, 100);
  const desiredHarbors = Math.min(20, Math.ceil(desiredTrade * affinity.harborShare));
  // The exclusive carriers: only a realm holding the form wants any at all,
  // which the zero affinity weight already encodes.
  const desiredPlants = affinity.plant > 0
    ? Math.min(ELEMENT_RULES.plantCap, Math.max(1, Math.ceil(desiredTrade * ELEMENT_RULES.plantTradeShare)))
    : 0;
  const desiredSkyports = affinity.skyport > 0
    ? Math.min(
      ELEMENT_RULES.skyportCap,
      Math.max(ELEMENT_RULES.skyportFloor, Math.ceil(counts.city / ELEMENT_RULES.skyportCityDivisor)),
    )
    : 0;
  const tradeBuildings = counts.factory + counts.harbor;
  const approaches = fortifiableApproaches(context, owner);
  const pressed = pressedBoundaryCells(context, owner);
  // A few developed places, well held -- not a wall per building. The appetite
  // follows what the realm has worth defending rather than the length of its
  // border, so a sprawling realm with one city wants one wall and a compact
  // realm with six wants several, and a realm with nowhere an army could come
  // wants none.
  //
  // A treasury with nothing better to do fortifies harder. That used to be a
  // bypass -- a rich realm returned "fort" whatever it already held, so the
  // ceiling below was not a ceiling and the wealthiest empires walled without
  // end, one fort per building. It lifts the appetite instead. The threshold
  // is gold, so the twentyfold income cut stranded it the way it stranded the
  // fort's own price and STRATEGY_RULES.richTreasuryFloor: at 1,250,000 no
  // realm in a ten-game sweep came within a factor of eight of it, and
  // divided by that same twenty it means what it always meant.
  const developedSites = counts.city + counts.factory + counts.harbor + counts.plant + counts.skyport;
  const wealthPush = faction.gold >= 62_500 ? 1.35 : 1;
  const desiredForts = approaches.length === 0
    ? 0
    : clamp(Math.ceil(developedSites * 0.25 * fortQuota * wealthPush), 1, 18);

  // A burning border pre-empts the whole program: ground already being taken
  // is answered before anything is bought for the future. A quiet one does
  // not -- a preventive wall competes for the same purse as a city or a
  // factory through the shortfall weights below, which is what keeps a realm
  // that is merely near a rival from walling instead of building.
  if (allowFort && pressed.length > 0 && counts.fort < desiredForts) return "fort";
  if (counts.city === 0) return "city";

  // The founding capital is an inheritance, not a purchase. nextStructureCost
  // already refuses to let it climb the ladder, and the appetite has to agree:
  // counting it as the realm's first city met half the city program before the
  // game began, while the trade program opened at a full shortfall and won
  // every early comparison by construction. A ten-game sweep to tick 6,000
  // built 0.9 cities in a whole world against thirty factories, and the
  // either/or the ladder is priced for was not one. Measured against cities
  // the realm has actually raised, both programs open level and the choice
  // falls where it should — to the element's own leaning and to how hard the
  // population is pressing the ceiling.
  const cityProgram = Math.max(1, desiredCities - 1);
  const raisedCities = Math.max(0, counts.city - 1);
  const cityShortfall = Math.max(0, (cityProgram - raisedCities) / cityProgram);
  const tradeShortfall = Math.max(0, (desiredTrade - tradeBuildings) / desiredTrade);
  const plantShortfall = desiredPlants > 0
    ? Math.max(0, (desiredPlants - counts.plant) / desiredPlants)
    : 0;
  const skyportShortfall = desiredSkyports > 0
    ? Math.max(0, (desiredSkyports - counts.skyport) / desiredSkyports)
    : 0;
  // Every program competes through its weighted shortfall, so the trade-form
  // affinity composes with the quota-driven appetites instead of gating them.
  // The opening purchase is deliberately part of that competition: a first
  // factory used to be hard-coded here, and with the ladder pricing a city
  // and a factory identically the game's first savings milestone is meant to
  // be a real decision, not a script.
  //
  // What tips it is capacity pressure: the 10K of troop cap a city carries
  // is worth most when home population presses the ceiling. The term is
  // neutral at the 65% growth sweet spot, lifts the city program as a realm
  // packs toward its cap, and discounts it while there is still room — so a
  // hemmed-in realm buys space to raise an army while a sprawling one buys
  // the income, and a court that chose economy really is thinner on troops
  // when a neighbor who chose the city comes across the border.
  //
  // Living strength, not the home ratio: a court that keeps its people in the
  // growth band by marching a third of them to a front is genuinely pressing
  // its ground, and reading only the half at home would have it stop buying
  // capacity exactly when its armies are largest.
  const capPressure = clamp(
    livingTroopsFor(state, faction.id) / Math.max(1, faction.troopCap),
    0,
    1,
  );
  const cityPriority = cityShortfall * affinity.city * (0.55 + capPressure * 0.7);
  const tradePriority = tradeShortfall * affinity.trade;
  // The preventive wall, competing on the same terms as the rest. It is
  // weighted by the realm's own appetite for defense, so a martial court
  // builds walls where a mercantile one builds works and both are answering
  // the same border.
  const fortShortfall = desiredForts > 0
    ? Math.max(0, (desiredForts - counts.fort) / desiredForts)
    : 0;
  const fortPriority = allowFort ? fortShortfall * fortQuota : 0;
  // The exclusive carriers still wait for a first factory: a conduit or a
  // flight network needs an economy underneath it before it earns.
  const plantPriority = tradeBuildings > 0 ? plantShortfall * affinity.plant : 0;
  const skyportPriority = tradeBuildings > 0 ? skyportShortfall * affinity.skyport : 0;
  const best = Math.max(cityPriority, tradePriority, plantPriority, skyportPriority, fortPriority);
  if (best <= 0) return null;
  if (fortPriority === best) return "fort";
  if (plantPriority === best) return "plant";
  if (skyportPriority === best) return "skyport";
  if (cityPriority >= tradePriority) return "city";
  if (
    counts.factory >= affinity.harborPrerequisite &&
    counts.harbor < desiredHarbors &&
    counts.harbor < tradeBuildings * affinity.harborCap
  ) return "harbor";
  return "factory";
}

export class ConstructionAiSystem implements SimulationSystem {
  readonly id = "construction-ai";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.tick === 0 || state.tick % state.config.constructionInterval !== 0) return;

    const sites = buildIndex(state);
    const { width, height } = state.config;
    const railNodes = [...new Set(state.tradeRoutes.flatMap((route) => route.pathIndices))];
    const railField = buildDistanceField(railNodes, width, height);
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const shadowCounts = { ...faction.structures };
      const reserved = new Set<number>();
      let budget = faction.gold;

      // New cities go on laid track first, so stations sit on the line the
      // trains actually run. Only a realm the rails have not reached yet may
      // found a city on open ground.
      const findTile = (structure: StructureType): number | null => {
        if (structure === "city") {
          const onRail = bestBuildTile(context, id, structure, reserved, sites, railField, true);
          if (onRail !== null) return onRail;
        }
        return bestBuildTile(context, id, structure, reserved, sites, railField);
      };

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
        let tileIndex = findTile(desired);

        if (tileIndex === null && desired === "fort") {
          desired = desiredInfrastructure(context, id, shadowCounts, false);
          if (!desired) break;
          cost = nextStructureCost(desired, shadowCounts);
          tileIndex = budget >= cost ? findTile(desired) : null;
        }

        // A realm should not stall its whole program because no harbor,
        // plant or skyport site is currently available; continue growing the
        // land network instead.
        if (tileIndex === null && (desired === "harbor" || desired === "plant" || desired === "skyport")) {
          desired = "factory";
          cost = nextStructureCost(desired, shadowCounts);
          tileIndex = budget >= cost ? findTile(desired) : null;
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
