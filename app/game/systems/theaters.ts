import {
  cellCoordinates,
  neighborIndices,
  ownedNeighborCount,
} from "../grid";
import { buildDistanceField } from "../distance-field";
import { sitesOf } from "../structure-index";
import { frontierTargets } from "../frontier";
import { sharedTradeForms } from "../elements";
import { powerDefenseFactor } from "../powers";
import { smoothCellNoise } from "../random";
import {
  CAMPAIGN_RULES,
  CLAIM_RULES,
  ELEMENT_RULES,
  ENEMY_TERRAIN_COST,
  FORT_RADIUS,
  STRATEGIC_REGION_RULES,
  STREAM_RULES,
  TERRAIN_RULES,
  WILDERNESS_TERRAIN_COST,
  clamp,
  emptyTerrainProfile,
  gridDensity,
  gridFineness,
  normalizedCellLength,
} from "../rules";
import { terrainAffinityFactor } from "../terraform";
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
  PlayerId,
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

/**
 * Whether one of the target's forts covers a cell.
 *
 * Asked for every front tile every tick, and it used to answer by walking the
 * whole disc around the tile looking for a fort -- a disc that grows with the
 * square of the grid's fineness. A realm's forts are a short list in the
 * structure index, so the same question is now a distance check per fort,
 * with the identical predicate cellsWithin applied.
 */
function isFortProtected(state: WorldState, index: number, target: CampaignTarget): boolean {
  if (target === "wilderness") return false;
  const forts = sitesOf(state, target, "fort");
  if (forts.length === 0) return false;
  const radius = FORT_RADIUS / normalizedCellLength(state.config);
  const width = state.config.width;
  const x = index % width;
  const y = (index - x) / width;
  for (const fort of forts) {
    const fx = fort % width;
    const fy = (fort - fx) / width;
    if (Math.hypot(x - fx, y - fy) <= radius) return true;
  }
  return false;
}

export function conquestCostAt(
  state: WorldState,
  index: number,
  target: CampaignTarget,
): number {
  const cell = state.cells[index]!;
  const terrain = cell.terrain as LandTerrainId;
  // A stream bank is dearer ground to take, wild or held, so frontiers of
  // both kinds tend to settle along the minor watercourses.
  if (target === "wilderness") {
    return WILDERNESS_TERRAIN_COST[terrain]
      * (cell.stream ? STREAM_RULES.wildernessCrossingCost : 1);
  }
  const fort = isFortProtected(state, index, target) ? 2 : 1;
  const city = cell.structure === "city" ? 1.1 : 1;
  const stream = cell.stream ? STREAM_RULES.enemyCrossingCost : 1;
  // The defender's elemental power prices its own ground: a geyser's banked
  // pressure stiffens it, a venting geyser's or a shattered obsidian's lies
  // soft, and the profile identities lean it inside the band. Terrain
  // affinity prices it again — obsidian ground on basalt fights harder,
  // fungus caught defending open scorch folds sooner.
  return ENEMY_TERRAIN_COST[terrain] * fort * city * stream
    * powerDefenseFactor(state, target)
    * terrainAffinityFactor(state.factions[target].expressedElement, terrain);
}

function infrastructureValue(state: WorldState, index: number, viewer?: PlayerId): number {
  const cell = state.cells[index]!;
  let structure = cell.structure === "city"
    ? 30 + Math.max(0, cell.structureLevel - 1) * 14
    : cell.structure === "factory"
      ? 27
      : cell.structure === "harbor"
        ? 25
        : cell.structure === "plant"
          ? 26
          : cell.structure === "skyport"
            ? 24
            : cell.structure === "fort"
              ? 5
              : 0;
  // Resonant conquest enters the valuation: an attacker weighs a rival's
  // works higher when their heritage trades the ways it does, because those
  // are the networks it could run natively the day they fall.
  if (
    viewer !== undefined &&
    cell.structureHeritage !== null &&
    cell.owner !== null &&
    cell.owner !== viewer &&
    sharedTradeForms(state.factions[viewer].expressedElement, cell.structureHeritage) > 0
  ) {
    structure *= ELEMENT_RULES.heritagePrizeWeight;
  }
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

/**
 * Distance from every target cell of a region to the nearest front cell.
 *
 * This was a pairwise minimum -- every region cell against every boundary
 * cell -- which grows with the product of the two counts and made theater
 * drafting quadratic in the grid's fineness. An exact distance transform over
 * the region's bounding box answers it in one pass regardless of how long the
 * front is.
 *
 * The transform yields exact squared distances, and the value read off them
 * must be the one the pairwise search produced: Math.hypot of the nearest
 * front cell, which can differ from the square root of the squared distance
 * in its last bit. So for the cells the draft actually measures -- those
 * inside the objective corridor -- the lattice points at exactly that
 * squared distance are enumerated and the true hypot taken, keeping the
 * result bit-identical to the pairwise minimum. Beyond the corridor the
 * depth is clamped anyway, so the square root serves.
 */
function frontDistances(
  state: WorldState,
  regionCells: readonly number[],
  targetCells: readonly number[],
  boundaryCells: readonly number[],
): Map<number, number> {
  const width = state.config.width;
  const distances = new Map<number, number>();
  if (boundaryCells.length === 0) {
    for (const index of targetCells) distances.set(index, Number.POSITIVE_INFINITY);
    return distances;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const list of [regionCells, boundaryCells]) {
    for (const index of list) {
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const seeds: number[] = [];
  const boundary = new Set<number>();
  for (const index of boundaryCells) {
    const x = index % width;
    const y = (index - x) / width;
    seeds.push((y - minY) * boxWidth + (x - minX));
    boundary.add(index);
  }
  const field = buildDistanceField(seeds, boxWidth, boxHeight);
  const corridorSquared = (STRATEGIC_REGION_RULES.objectiveLookaheadCells * gridFineness(state.config)) ** 2;
  for (const index of targetCells) {
    const x = index % width;
    const y = (index - x) / width;
    const squared = field.squared[(y - minY) * boxWidth + (x - minX)]!;
    if (squared > corridorSquared) {
      distances.set(index, Math.sqrt(squared));
      continue;
    }
    // Exact hypot of the nearest front cell. Math.hypot depends only on the
    // magnitudes, so every decomposition |dx|, |dy| of this squared distance
    // is tried once, and counts if any of its four mirror offsets lands on
    // the front; the smallest reading is what the pairwise minimum returned.
    const reach = Math.round(Math.sqrt(squared));
    let best = Number.POSITIVE_INFINITY;
    for (let dx = 0; dx <= reach; dx += 1) {
      const rest = squared - dx * dx;
      const dy = Math.round(Math.sqrt(rest));
      if (dy * dy !== rest) continue;
      const reading = Math.hypot(dx, dy);
      if (reading >= best) continue;
      let present = false;
      for (let sx = -1; sx <= 1 && !present; sx += 2) {
        if (dx === 0 && sx === 1) continue;
        const nx = x + dx * sx;
        if (nx < 0 || nx >= width) continue;
        for (let sy = -1; sy <= 1; sy += 2) {
          if (dy === 0 && sy === 1) continue;
          const ny = y + dy * sy;
          if (ny < 0 || ny >= state.config.height) continue;
          if (boundary.has(ny * width + nx)) { present = true; break; }
        }
      }
      if (present) best = reading;
    }
    distances.set(index, best);
  }
  return distances;
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
  for (const index of region.cells) {
    if (targetOwnsCell(state, index, campaign.target)) targetCells.push(index);
  }
  const frontDistance = frontDistances(state, region.cells, targetCells, boundaryCells);
  // Depths are read in tuned-world cells, so a corridor reaches the same
  // ground on any grid.
  const fineness = gridFineness(state.config);
  const lookahead = STRATEGIC_REGION_RULES.objectiveLookaheadCells * fineness;
  const corridor = targetCells.filter(
    (index) => frontDistance.get(index)! <= lookahead,
  );
  const opportunityCells = corridor.length > 0 ? corridor : targetCells;
  const railCells = railCellsFor(state);
  const objectiveScore = (index: number): number => {
    const cell = state.cells[index]!;
    const rail = railCells.has(index) ? 10 : 0;
    const depth = Math.min(lookahead, frontDistance.get(index)!);
    return infrastructureValue(state, index, campaign.attacker) + terrainOpportunity(cell.terrain as LandTerrainId) * 2 + rail + (depth / fineness) * 0.18;
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
    prizeTotal += infrastructureValue(state, index, campaign.attacker);
    if (railCells.has(index)) railTotal += 1;
  }
  const landAverage = landTotal / Math.max(1, opportunityCells.length);
  const observedValue =
    landAverage * 2.4 +
    Math.sqrt(prizeTotal) * 2.15 +
    Math.sqrt(railTotal) * 1.8 +
    Math.sqrt(opportunityCells.length / gridDensity(state.config)) * 0.22;

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
        initiator: realmSubject(state, campaign.attacker),
        targets: [theaterSubject(state, theater.id, theater.attacker, regionId), targetSubject(state, campaign.target)],
        participants: [campaignSubject(state, campaign)],
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
        summary: `${theaterSubject(state, theater.id, theater.attacker, regionId).label} formed across natural region ${regionId}.`,
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
          initiator: realmSubject(state, campaign.attacker),
          targets: [theaterSubject(state, theater.id, theater.attacker), targetSubject(state, campaign.target)],
          participants: [campaignSubject(state, campaign)],
          links: { campaign: campaign.id, theater: theater.id, province: `region:${regionId}` },
          facts: {
            regionId,
            previousBoundaryCells: prior.boundaryCells.length,
            boundaryCells: theater.boundaryCells.length,
            strategicValue: theater.strategicValue,
            valueTrend: theater.valueTrend,
          },
          summary: `${theaterSubject(state, theater.id, theater.attacker).label} advanced through natural region ${regionId}.`,
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
      initiator: realmSubject(state, campaign.attacker),
      targets: [theaterSubject(state, theater.id, theater.attacker), targetSubject(state, campaign.target)],
      participants: [campaignSubject(state, campaign)],
      links: { campaign: campaign.id, theater: theater.id, province: `region:${theater.regionId}` },
      facts: {
        regionId: theater.regionId,
        captures: theater.captures,
        duration: state.tick - theater.formedAt,
      },
      summary: `${theaterSubject(state, theater.id, theater.attacker).label} secured natural region ${theater.regionId}.`,
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
  // Blunting already cancelled attackers one for one when it happened;
  // deducting the defenders again would charge the same soldiers twice.
  const usable = Math.max(0, campaign.remaining);
  if (campaign.target !== "wilderness") return usable;
  const incoming = state.campaigns.reduce((total, candidate) => {
    if (candidate.target !== campaign.attacker || candidate.remaining <= 0) return total;
    return total + Math.max(0, candidate.remaining);
  }, 0);
  const emergency = Math.max(5_000, state.factions[campaign.attacker].troopCap * 0.22);
  // An invasion slows the frontier program, it no longer stops it: zeroing
  // settlement outright left half-claimed strips of wilderness frozen between
  // realms for as long as any war ran anywhere along the border.
  return incoming > emergency ? usable * 0.3 : usable;
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

/**
 * How much of the world's land is settled, once per tick.
 *
 * Every campaign's allocation reads it, and each used to sweep the whole grid
 * for it -- fifty sweeps of forty thousand cells a tick for one number that
 * cannot change between them, since nothing takes ground while allocations
 * are being set.
 */
const SETTLED_SHARE = new WeakMap<object, { tick: number; share: number }>();

function settledShareFor(state: WorldState): number {
  const cached = SETTLED_SHARE.get(state.cells);
  if (cached && cached.tick === state.tick) return cached.share;
  let unclaimed = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.terrain !== "water" && cell.owner === null) unclaimed += 1;
  }
  const share = 1 - unclaimed / Math.max(1, state.landTiles);
  SETTLED_SHARE.set(state.cells, { tick: state.tick, share });
  return share;
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

  const settledShare = settledShareFor(state);
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
  const fineness = gridFineness(state.config);
  const raw = targets.map((index) => {
    const cell = state.cells[index]!;
    const terrain = cell.terrain as LandTerrainId;
    const objectiveDistance = objectives.length > 0
      ? nearestDistanceInCells(state, index, objectives)
      : distanceInCells(state, index, state.strategicRegions[theater.regionId]!.centroidIndex);
    const objectivePull = 1 + 4.2 / (1 + (objectiveDistance / fineness) * 0.22);
    const landValue = terrainOpportunity(terrain);
    const immediatePrize = infrastructureValue(state, index, theater.attacker);
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
