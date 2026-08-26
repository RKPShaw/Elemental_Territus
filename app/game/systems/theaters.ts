import {
  cellCoordinates,
  cellsWithin,
  neighborIndices,
  ownedNeighborCount,
} from "../grid";
import { frontierTargets } from "../frontier";
import { smoothCellNoise } from "../random";
import {
  CAMPAIGN_RULES,
  CLAIM_RULES,
  ENEMY_TERRAIN_COST,
  FORT_RADIUS,
  STRATEGIC_REGION_RULES,
  TERRAIN_RULES,
  WILDERNESS_TERRAIN_COST,
  clamp,
  normalizedCellLength,
} from "../rules";
import {
  campaignSubject,
  realmSubject,
  targetSubject,
  theaterSubject,
} from "../reporting";
import type {
  Campaign,
  CampaignTarget,
  LandTerrainId,
  SimulationContext,
  SimulationSystem,
  Theater,
  TheaterTerrainProfile,
  WorldState,
} from "../types";

interface TheaterDraft {
  regionId: number;
  boundaryCells: number[];
  objectiveCells: number[];
  centroidIndex: number;
  terrainProfile: TheaterTerrainProfile;
  effectiveLength: number;
  resistance: number;
  supplyQuality: number;
  observedValue: number;
}

function emptyTerrainProfile(): TheaterTerrainProfile {
  return { farmland: 0, plains: 0, forest: 0, hills: 0, mountains: 0 };
}

function targetOwnsCell(state: WorldState, index: number, target: CampaignTarget): boolean {
  const cell = state.cells[index]!;
  if (cell.terrain === "water") return false;
  return target === "wilderness" ? cell.owner === null : cell.owner === target;
}

/**
 * Cells the attacker can push into. Served from the per-tick frontier index,
 * which computes every player's frontier in a single pass over the map.
 */
export function campaignBoundaryTargets(
  state: WorldState,
  attacker: Campaign["attacker"],
  target: CampaignTarget,
): readonly number[] {
  return frontierTargets(state, attacker, target);
}

function isFortProtected(state: WorldState, index: number, target: CampaignTarget): boolean {
  if (target === "wilderness") return false;
  const radius = FORT_RADIUS / normalizedCellLength(state.config);
  return cellsWithin(state, index, radius).some((nearby) => {
    const cell = state.cells[nearby]!;
    return cell.owner === target && cell.structure === "fort";
  });
}

export function conquestCostAt(
  state: WorldState,
  index: number,
  target: CampaignTarget,
): number {
  const cell = state.cells[index]!;
  const terrain = cell.terrain as LandTerrainId;
  if (target === "wilderness") return WILDERNESS_TERRAIN_COST[terrain];
  const fort = isFortProtected(state, index, target) ? 2 : 1;
  const city = cell.structure === "city" ? 1.1 : 1;
  return ENEMY_TERRAIN_COST[terrain] * fort * city;
}

function infrastructureValue(state: WorldState, index: number): number {
  const cell = state.cells[index]!;
  const structure = cell.structure === "city"
    ? 30 + Math.max(0, cell.structureLevel - 1) * 14
    : cell.structure === "factory"
      ? 27
      : cell.structure === "harbor"
        ? 25
        : cell.structure === "fort"
          ? 5
          : 0;
  return structure + (cell.capitalOf ? 70 : 0);
}

function terrainOpportunity(terrain: LandTerrainId): number {
  const rule = TERRAIN_RULES[terrain];
  return rule.sustain * 2.9 + rule.goldYield * 1.9;
}

function distanceInCells(state: WorldState, first: number, second: number): number {
  const [ax, ay] = cellCoordinates(first, state.config.width);
  const [bx, by] = cellCoordinates(second, state.config.width);
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Coordinates are derived inline rather than through cellCoordinates: this runs
 * once per region cell per boundary cell while drafting a theater, so a
 * returned tuple per endpoint dominated it.
 */
function nearestDistanceInCells(state: WorldState, index: number, candidates: readonly number[]): number {
  const width = state.config.width;
  const ax = index % width;
  const ay = (index - ax) / width;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const bx = candidate % width;
    const by = (candidate - bx) / width;
    const distance = Math.hypot(ax - bx, ay - by);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Which cells carry rail, as a set.
 *
 * Every theater draft asked this, and each answer walked every trade route and
 * flattened every path -- thousands of cells copied per region per campaign. A
 * hundred players run a hundred campaigns across several regions each, so the
 * same set was rebuilt hundreds of times a tick from data that only the trade
 * system changes, and that system has already finished by the time theaters
 * refresh. Built once per tick and reused.
 */
const RAIL_CELLS = new WeakMap<object, { tick: number; cells: Set<number> }>();

function railCellsFor(state: WorldState): ReadonlySet<number> {
  const cached = RAIL_CELLS.get(state);
  if (cached && cached.tick === state.tick) return cached.cells;
  const cells = new Set<number>();
  for (const route of state.tradeRoutes) {
    if (route.kind !== "rail") continue;
    for (const index of route.pathIndices) cells.add(index);
  }
  RAIL_CELLS.set(state, { tick: state.tick, cells });
  return cells;
}

function theaterDraft(
  state: WorldState,
  campaign: Campaign,
  regionId: number,
  boundaryCells: number[],
): TheaterDraft {
  const region = state.strategicRegions[regionId]!;
  // Distance to the front is asked of every region cell twice -- once to pick
  // the corridor, once to score objectives -- and the objective score used to
  // be recomputed inside the sort comparator, so a region of a few hundred
  // cells paid for it O(n log n) times over. It is measured once here instead.
  const targetCells: number[] = [];
  const frontDistance = new Map<number, number>();
  for (const index of region.cells) {
    if (!targetOwnsCell(state, index, campaign.target)) continue;
    targetCells.push(index);
    frontDistance.set(index, nearestDistanceInCells(state, index, boundaryCells));
  }
  const corridor = targetCells.filter(
    (index) => frontDistance.get(index)! <= STRATEGIC_REGION_RULES.objectiveLookaheadCells,
  );
  const opportunityCells = corridor.length > 0 ? corridor : targetCells;
  const railCells = railCellsFor(state);
  const objectiveScore = (index: number): number => {
    const cell = state.cells[index]!;
    const rail = railCells.has(index) ? 10 : 0;
    const depth = Math.min(
      STRATEGIC_REGION_RULES.objectiveLookaheadCells,
      frontDistance.get(index)!,
    );
    return infrastructureValue(state, index) + terrainOpportunity(cell.terrain as LandTerrainId) * 2 + rail + depth * 0.18;
  };
  const ranked = opportunityCells.map((index) => ({ index, score: objectiveScore(index) }));
  ranked.sort((first, second) => second.score - first.score);
  const objectiveCells = ranked
    .slice(0, STRATEGIC_REGION_RULES.maximumObjectives)
    .map((entry) => entry.index);

  const terrainProfile = emptyTerrainProfile();
  let xTotal = 0;
  let yTotal = 0;
  let resistance = 0;
  let supply = 0;
  for (const index of boundaryCells) {
    const cell = state.cells[index]!;
    terrainProfile[cell.terrain as LandTerrainId] += 1;
    const [x, y] = cellCoordinates(index, state.config.width);
    xTotal += x;
    yTotal += y;
    resistance += conquestCostAt(state, index, campaign.target);
    supply += clamp(0.54 + ownedNeighborCount(state, index, campaign.attacker) * 0.22, 0.55, 1.3);
  }
  const centerX = xTotal / boundaryCells.length;
  const centerY = yTotal / boundaryCells.length;
  const centroidIndex = boundaryCells.reduce((best, index) => {
    const [x, y] = cellCoordinates(index, state.config.width);
    const [bestX, bestY] = cellCoordinates(best, state.config.width);
    return Math.hypot(x - centerX, y - centerY) < Math.hypot(bestX - centerX, bestY - centerY)
      ? index
      : best;
  });

  let landTotal = 0;
  let prizeTotal = 0;
  let railTotal = 0;
  for (const index of opportunityCells) {
    const cell = state.cells[index]!;
    landTotal += terrainOpportunity(cell.terrain as LandTerrainId);
    prizeTotal += infrastructureValue(state, index);
    if (railCells.has(index)) railTotal += 1;
  }
  const landAverage = landTotal / Math.max(1, opportunityCells.length);
  const observedValue =
    landAverage * 2.4 +
    Math.sqrt(prizeTotal) * 2.15 +
    Math.sqrt(railTotal) * 1.8 +
    Math.sqrt(opportunityCells.length) * 0.22;

  return {
    regionId,
    boundaryCells,
    objectiveCells,
    centroidIndex,
    terrainProfile,
    effectiveLength: Math.max(1, boundaryCells.length * normalizedCellLength(state.config)),
    resistance: resistance / boundaryCells.length,
    supplyQuality: supply / boundaryCells.length,
    observedValue,
  };
}

function filteredValue(
  previous: Theater | undefined,
  observation: number,
): { value: number; trend: number; history: number[] } {
  if (!previous) return { value: observation, trend: 0, history: [observation] };
  const prediction = previous.strategicValue + previous.valueTrend;
  const residual = observation - prediction;
  const value = Math.max(0.01, prediction + CAMPAIGN_RULES.theaterValueAlpha * residual);
  const trend = previous.valueTrend + CAMPAIGN_RULES.theaterTrendBeta * residual;
  return {
    value,
    trend,
    history: [...previous.valueHistory, value].slice(-CAMPAIGN_RULES.theaterHistoryLength),
  };
}

function refreshCampaignTheaters(context: SimulationContext, campaign: Campaign): Theater[] {
  const { state } = context;
  if (campaign.mode === "naval" && campaign.eta > 0) return [];
  const byRegion = new Map<number, number[]>();
  for (const index of campaignBoundaryTargets(state, campaign.attacker, campaign.target)) {
    const regionId = state.regionByCell[index]!;
    if (regionId < 0) continue;
    byRegion.set(regionId, [...(byRegion.get(regionId) ?? []), index]);
  }
  const previous = state.theaters.filter((theater) => theater.campaignId === campaign.id);
  const previousByRegion = new Map(previous.map((theater) => [theater.regionId, theater]));
  const active: Theater[] = [];

  for (const [regionId, boundaryCells] of [...byRegion].sort((a, b) => a[0] - b[0])) {
    const prior = previousByRegion.get(regionId);
    const draft = theaterDraft(state, campaign, regionId, boundaryCells);
    const filtered = filteredValue(prior, draft.observedValue);
    const theater: Theater = {
      id: prior?.id ?? `${campaign.id}:region:${regionId}`,
      campaignId: campaign.id,
      regionId,
      attacker: campaign.attacker,
      target: campaign.target,
      boundaryCells: draft.boundaryCells,
      objectiveCells: draft.objectiveCells,
      centroidIndex: draft.centroidIndex,
      terrainProfile: draft.terrainProfile,
      effectiveLength: draft.effectiveLength,
      resistance: draft.resistance,
      supplyQuality: draft.supplyQuality,
      strategicValue: filtered.value,
      valueTrend: filtered.trend,
      valueHistory: filtered.history,
      allocation: prior?.allocation ?? 0,
      formedAt: prior?.formedAt ?? state.tick,
      updatedAt: state.tick,
      lastAdvanceAt: prior?.lastAdvanceAt ?? state.tick,
      staleRefreshes: 0,
      captures: prior?.captures ?? 0,
      victoryReported: prior?.victoryReported ?? false,
    };

    if (!prior) {
      context.report({
        domain: "military",
        kind: "military.theater-formed",
        importance: "routine",
        storyKey: campaign.storyKey,
        initiator: realmSubject(campaign.attacker),
        targets: [theaterSubject(theater.id, theater.attacker, regionId), targetSubject(campaign.target)],
        participants: [campaignSubject(campaign)],
        links: { campaign: campaign.id, theater: theater.id, province: `region:${regionId}` },
        facts: {
          regionId,
          boundaryCells: theater.boundaryCells.length,
          centroidIndex: theater.centroidIndex,
          resistance: theater.resistance,
          supplyQuality: theater.supplyQuality,
          strategicValue: theater.strategicValue,
          objectives: theater.objectiveCells,
        },
        summary: `${theaterSubject(theater.id, theater.attacker, regionId).label} formed across natural region ${regionId}.`,
      });
    } else {
      const oldCells = new Set(prior.boundaryCells);
      const overlap = boundaryCells.filter((index) => oldCells.has(index)).length /
        Math.max(1, Math.min(boundaryCells.length, prior.boundaryCells.length));
      const valueShift = Math.abs(theater.strategicValue - prior.strategicValue) /
        Math.max(1, prior.strategicValue);
      if (overlap < 0.45 || valueShift > 0.28) {
        context.report({
          domain: "military",
          kind: "military.theater-realigned",
          importance: "routine",
          storyKey: campaign.storyKey,
          initiator: realmSubject(campaign.attacker),
          targets: [theaterSubject(theater.id, theater.attacker), targetSubject(campaign.target)],
          participants: [campaignSubject(campaign)],
          links: { campaign: campaign.id, theater: theater.id, province: `region:${regionId}` },
          facts: {
            regionId,
            previousBoundaryCells: prior.boundaryCells.length,
            boundaryCells: theater.boundaryCells.length,
            strategicValue: theater.strategicValue,
            valueTrend: theater.valueTrend,
          },
          summary: `${theaterSubject(theater.id, theater.attacker).label} advanced through natural region ${regionId}.`,
        });
      }
    }
    active.push(theater);
  }

  const activeRegions = new Set(active.map((theater) => theater.regionId));
  for (const theater of previous) {
    if (
      activeRegions.has(theater.regionId) ||
      theater.staleRefreshes < 2 ||
      theater.captures <= 0 ||
      theater.victoryReported
    ) continue;
    context.report({
      domain: "military",
      kind: "military.theater-victory",
      importance: theater.captures >= 25 ? "major" : "notable",
      storyKey: campaign.storyKey,
      initiator: realmSubject(campaign.attacker),
      targets: [theaterSubject(theater.id, theater.attacker), targetSubject(campaign.target)],
      participants: [campaignSubject(campaign)],
      links: { campaign: campaign.id, theater: theater.id, province: `region:${theater.regionId}` },
      facts: {
        regionId: theater.regionId,
        captures: theater.captures,
        duration: state.tick - theater.formedAt,
      },
      summary: `${theaterSubject(theater.id, theater.attacker).label} secured natural region ${theater.regionId}.`,
    });
  }

  const dormant = previous
    .filter((theater) => !activeRegions.has(theater.regionId) && theater.staleRefreshes < 2)
    .map((theater) => ({
      ...theater,
      allocation: 0,
      updatedAt: state.tick,
      staleRefreshes: theater.staleRefreshes + 1,
    }));
  return [...active, ...dormant];
}

function campaignUsablePower(state: WorldState, campaign: Campaign): number {
  const usable = Math.max(0, campaign.remaining - campaign.defenderRemaining);
  if (campaign.target !== "wilderness") return usable;
  const incoming = state.campaigns.reduce((total, candidate) => {
    if (candidate.target !== campaign.attacker || candidate.remaining <= 0) return total;
    return total + Math.max(0, candidate.remaining - candidate.defenderRemaining);
  }, 0);
  const emergency = Math.max(5_000, state.factions[campaign.attacker].troopCap * 0.22);
  return incoming > emergency ? 0 : usable;
}

function cappedShares(
  priorities: number[],
  baselineShare: number = CAMPAIGN_RULES.minimumTheaterShare,
): number[] {
  if (priorities.length === 0) return [];
  const baseline = Math.min(baselineShare, 1 / priorities.length);
  const shares = priorities.map(() => baseline);
  let remaining = Math.max(0, 1 - baseline * priorities.length);
  let eligible = priorities.map((_, index) => index);

  while (remaining > 0.0001 && eligible.length > 0) {
    const weight = eligible.reduce((sum, index) => sum + priorities[index]!, 0);
    if (weight <= 0) break;
    let spent = 0;
    const next: number[] = [];
    for (const index of eligible) {
      const proposed = remaining * (priorities[index]! / weight);
      const room = CAMPAIGN_RULES.maximumTheaterShare - shares[index]!;
      const granted = Math.min(room, proposed);
      shares[index]! += granted;
      spent += granted;
      if (room - granted > 0.0001) next.push(index);
    }
    if (spent <= 0.0001) break;
    remaining -= spent;
    eligible = next;
  }
  if (remaining > 0.0001) {
    const equal = remaining / shares.length;
    for (let index = 0; index < shares.length; index += 1) shares[index]! += equal;
  }
  return shares;
}

function allocateCampaign(state: WorldState, campaign: Campaign): void {
  const allTheaters = state.theaters.filter(
    (theater) => theater.campaignId === campaign.id && theater.staleRefreshes === 0,
  );
  const usable = campaignUsablePower(state, campaign);
  if (allTheaters.length === 0 || usable <= 0) {
    for (const theater of state.theaters) {
      if (theater.campaignId === campaign.id) theater.allocation = 0;
    }
    return;
  }

  const settledShare = 1 - state.cells.reduce(
    (total, cell) => total + Number(cell.terrain !== "water" && cell.owner === null),
    0,
  ) / Math.max(1, state.landTiles);
  const completionFloor = campaign.target === "wilderness"
    ? 0.8 + 8 * Math.pow(settledShare, CLAIM_RULES.completionUrgencyPower)
    : 0;
  const ranked = allTheaters.map((theater) => {
    const neglect = campaign.target === "wilderness"
      ? 1 + Math.min(2.5, (state.tick - theater.lastAdvanceAt) / CLAIM_RULES.neglectFullEffectTicks)
      : 1;
    const economicOpportunity = Math.pow(Math.max(0.01, theater.strategicValue), 1.32);
    const continuity = theater.allocation > 0 ? 1.08 : 1;
    const priority = Math.max(
      0.001,
      ((economicOpportunity + completionFloor) * theater.supplyQuality * neglect) /
        Math.max(0.25, theater.resistance),
    ) * continuity;
    return { theater, priority };
  }).sort((first, second) => second.priority - first.priority);
  const active = ranked.slice(0, CAMPAIGN_RULES.maximumActiveTheaters);
  const activeIds = new Set(active.map((candidate) => candidate.theater.id));
  for (const theater of allTheaters) {
    if (!activeIds.has(theater.id)) theater.allocation = 0;
  }
  const theaters = active.map((candidate) => candidate.theater);
  const priorities = active.map((candidate) => candidate.priority);
  const lateCompletionBaseline = campaign.target === "wilderness"
    ? Math.min(0.16, CAMPAIGN_RULES.minimumTheaterShare + Math.pow(settledShare, 4) * 0.11)
    : CAMPAIGN_RULES.minimumTheaterShare;
  const shares = cappedShares(priorities, lateCompletionBaseline);
  const smoothing = CAMPAIGN_RULES.allocationSmoothing;
  let smoothedTotal = 0;
  for (let index = 0; index < theaters.length; index += 1) {
    const target = usable * shares[index]!;
    const previous = theaters[index]!.allocation;
    theaters[index]!.allocation = previous > 0
      ? previous * (1 - smoothing) + target * smoothing
      : target;
    smoothedTotal += theaters[index]!.allocation;
  }
  const normalization = usable / Math.max(1, smoothedTotal);
  for (const theater of theaters) theater.allocation *= normalization;
}

/**
 * Distributes one conserved theater budget across its frontier. Terrain,
 * commerce objectives and a low-frequency geographic field create coherent
 * lobes that follow valleys rather than geometric radius expansion.
 */
export function theaterFrontWeights(
  state: WorldState,
  theater: Theater,
  targets: readonly number[],
): Map<number, number> {
  const objectives = theater.objectiveCells.filter((index) => targetOwnsCell(state, index, theater.target));
  const raw = targets.map((index) => {
    const cell = state.cells[index]!;
    const terrain = cell.terrain as LandTerrainId;
    const objectiveDistance = objectives.length > 0
      ? nearestDistanceInCells(state, index, objectives)
      : distanceInCells(state, index, state.strategicRegions[theater.regionId]!.centroidIndex);
    const objectivePull = 1 + 4.2 / (1 + objectiveDistance * 0.22);
    const landValue = terrainOpportunity(terrain);
    const immediatePrize = infrastructureValue(state, index);
    const localSupply = 0.72 + ownedNeighborCount(state, index, theater.attacker) * 0.12;
    const [x, y] = cellCoordinates(index, state.config.width);
    const contour = 0.68 + smoothCellNoise(
      state.seed ^ (theater.regionId * 0x9e3779b1),
      x,
      y,
      state.config.width / 31,
    ) * 0.64;
    const continuity = 1 + Math.min(1.4, cell.pressure) * 0.55;
    const desirability =
      (landValue * 0.7 + immediatePrize * 0.2 + objectivePull) *
      localSupply *
      contour *
      continuity /
      Math.max(0.35, conquestCostAt(state, index, theater.target));
    return { index, weight: Math.pow(Math.max(0.001, desirability), 2.15) };
  });
  const total = raw.reduce((sum, candidate) => sum + candidate.weight, 0);
  return new Map(raw.map((candidate) => [candidate.index, candidate.weight / Math.max(0.001, total)]));
}

export class TheaterSystem implements SimulationSystem {
  readonly id = "persistent-geographic-theaters";

  update(context: SimulationContext): void {
    const { state } = context;
    const campaignIds = new Set(state.campaigns.map((campaign) => campaign.id));
    state.theaters = state.theaters.filter((theater) => campaignIds.has(theater.campaignId));

    const needsTopologyRefresh =
      state.tick % CAMPAIGN_RULES.topologyRefreshTicks === 0 ||
      state.campaigns.some((campaign) =>
        campaign.target === "wilderness" &&
        state.tick % CAMPAIGN_RULES.wildernessTopologyRefreshTicks === 0
      ) ||
      state.campaigns.some((campaign) =>
        !state.theaters.some((theater) => theater.campaignId === campaign.id),
      );
    if (needsTopologyRefresh) {
      const refreshed: Theater[] = [];
      for (const campaign of state.campaigns) refreshed.push(...refreshCampaignTheaters(context, campaign));
      state.theaters = refreshed;
    }
    if (needsTopologyRefresh || state.tick % CAMPAIGN_RULES.allocationRefreshTicks === 0) {
      for (const campaign of state.campaigns) allocateCampaign(state, campaign);
    }
  }
}
