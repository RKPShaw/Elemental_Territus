import { cellCoordinates, cellIndex, neighborIndices, surroundingIndices } from "./grid";
import { STRATEGIC_REGION_RULES, TERRAIN_RULES, emptyTerrainProfile } from "./rules";
import type {
  LandTerrainId,
  StrategicRegion,
  TheaterTerrainProfile,
  WorldState,
} from "./types";

/**
 * The eight neighbour offsets as flat dx, dy pairs, in the same order
 * `surroundingIndices` returns them. The partition walks these inline to avoid
 * allocating a neighbour array for every cell it settles.
 */
const SURROUNDING_OFFSETS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1] as const;

interface RegionAnchor {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

/**
 * Frontier entry fields, held in parallel arrays.
 *
 * The partition repeatedly reprices and re-pushes frontier entries, so it
 * performs far more pushes than there are cells. One object per push made the
 * partition the most expensive thing in the simulation, so the heap stores
 * plain numbers and reports the popped entry through its `popped*` fields.
 */

export interface StrategicMetaMap {
  /** Combined attraction used by the anchor estimator. */
  value: Float32Array;
  /** Smoothed carrying capacity and economic yield. */
  productivity: Float32Array;
  /** Smoothed terrain height/roughness. */
  relief: Float32Array;
  /** Smoothed structures, capitals, and rail density. */
  infrastructure: Float32Array;
}

class FrontierHeap {
  private cost = new Float64Array(4096);
  private travelCost = new Float64Array(4096);
  private cell = new Int32Array(4096);
  private region = new Int32Array(4096);
  private length = 0;

  poppedCost = 0;
  poppedTravelCost = 0;
  poppedCell = 0;
  poppedRegion = 0;

  push(cost: number, travelCost: number, cell: number, region: number): void {
    if (this.length === this.cost.length) this.grow();
    let index = this.length;
    this.length += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.cost[parent]! <= cost) break;
      this.cost[index] = this.cost[parent]!;
      this.travelCost[index] = this.travelCost[parent]!;
      this.cell[index] = this.cell[parent]!;
      this.region[index] = this.region[parent]!;
      index = parent;
    }
    this.cost[index] = cost;
    this.travelCost[index] = travelCost;
    this.cell[index] = cell;
    this.region[index] = region;
  }

  /** Moves the cheapest entry into the `popped*` fields; false when empty. */
  pop(): boolean {
    if (this.length === 0) return false;
    this.poppedCost = this.cost[0]!;
    this.poppedTravelCost = this.travelCost[0]!;
    this.poppedCell = this.cell[0]!;
    this.poppedRegion = this.region[0]!;
    this.length -= 1;
    if (this.length === 0) return true;
    const cost = this.cost[this.length]!;
    const travelCost = this.travelCost[this.length]!;
    const cell = this.cell[this.length]!;
    const region = this.region[this.length]!;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.length) break;
      const right = left + 1;
      const child = right < this.length && this.cost[right]! < this.cost[left]! ? right : left;
      if (this.cost[child]! >= cost) break;
      this.cost[index] = this.cost[child]!;
      this.travelCost[index] = this.travelCost[child]!;
      this.cell[index] = this.cell[child]!;
      this.region[index] = this.region[child]!;
      index = child;
    }
    this.cost[index] = cost;
    this.travelCost[index] = travelCost;
    this.cell[index] = cell;
    this.region[index] = region;
    return true;
  }

  get size(): number {
    return this.length;
  }

  private grow(): void {
    const capacity = this.cost.length * 2;
    const cost = new Float64Array(capacity);
    const travelCost = new Float64Array(capacity);
    const cell = new Int32Array(capacity);
    const region = new Int32Array(capacity);
    cost.set(this.cost);
    travelCost.set(this.travelCost);
    cell.set(this.cell);
    region.set(this.region);
    this.cost = cost;
    this.travelCost = travelCost;
    this.cell = cell;
    this.region = region;
  }
}

function terrainHeat(terrain: LandTerrainId): number {
  const rule = TERRAIN_RULES[terrain];
  return rule.sustain * 0.34 + rule.goldYield * 0.22;
}

const TERRAIN_RELIEF: Record<LandTerrainId, number> = {
  farmland: 0.08,
  plains: 0.18,
  forest: 0.4,
  hills: 0.7,
  mountains: 1,
  scorched: 0.2,
  marsh: 0.12,
  duneland: 0.22,
  terrace: 0.55,
  glacier: 0.95,
  basalt: 0.75,
  sporemire: 0.3,
  verdant: 0.3,
};

function normalizeLayer(layer: Float32Array): Float32Array {
  let maximum = 0;
  for (const value of layer) maximum = Math.max(maximum, value);
  if (maximum <= 0) return layer;
  for (let index = 0; index < layer.length; index += 1) layer[index] /= maximum;
  return layer;
}

function smoothLayer(
  state: Pick<WorldState, "cells" | "config">,
  input: Float32Array,
  passes: number,
): Float32Array {
  let source = input;
  for (let pass = 0; pass < passes; pass += 1) {
    const output = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      if (state.cells[index]!.terrain === "water") continue;
      let total = source[index]! * 5;
      let weight = 5;
      for (const neighbor of surroundingIndices(index, state.config.width, state.config.height)) {
        if (state.cells[neighbor]!.terrain === "water") continue;
        const diagonal = Math.abs(neighbor - index) !== 1
          && Math.abs(neighbor - index) !== state.config.width;
        const neighborWeight = diagonal ? 0.7 : 1;
        total += source[neighbor]! * neighborWeight;
        weight += neighborWeight;
      }
      output[index] = total / weight;
    }
    source = output;
  }
  return source;
}

/**
 * The shared theater board is a meta-map, not a geometric overlay. These
 * independent data layers let borders settle on ridges, economic basin edges,
 * and changes in productive terrain instead of radiating from point sources.
 */
export function buildStrategicMetaMap(
  state: Pick<WorldState, "cells" | "config"> & Partial<Pick<WorldState, "tradeRoutes">>,
): StrategicMetaMap {
  const productivityRaw = new Float32Array(state.cells.length);
  const reliefRaw = new Float32Array(state.cells.length);
  const infrastructureRaw = new Float32Array(state.cells.length);
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.terrain === "water") continue;
    productivityRaw[index] = terrainHeat(cell.terrain);
    reliefRaw[index] = TERRAIN_RELIEF[cell.terrain];
    if (cell.capitalOf) infrastructureRaw[index] += 8;
    if (cell.structure === "city") infrastructureRaw[index] += 4.8 + cell.structureLevel * 2.4;
    else if (cell.structure === "factory") infrastructureRaw[index] += 6.4;
    else if (cell.structure === "harbor") infrastructureRaw[index] += 5.8;
    else if (cell.structure === "plant") infrastructureRaw[index] += 6;
    else if (cell.structure === "skyport") infrastructureRaw[index] += 5.4;
    else if (cell.structure === "fort") infrastructureRaw[index] += 1.8;
  }
  for (const route of state.tradeRoutes ?? []) {
    if (route.kind !== "rail") continue;
    for (const index of route.pathIndices) infrastructureRaw[index] += 1.1;
  }

  const productivity = normalizeLayer(smoothLayer(
    state,
    productivityRaw,
    STRATEGIC_REGION_RULES.terrainSmoothingPasses,
  ));
  const relief = smoothLayer(state, reliefRaw, STRATEGIC_REGION_RULES.terrainSmoothingPasses);
  const infrastructure = normalizeLayer(smoothLayer(
    state,
    infrastructureRaw,
    STRATEGIC_REGION_RULES.infrastructureSmoothingPasses,
  ));
  const valueRaw = new Float32Array(state.cells.length);
  for (let index = 0; index < valueRaw.length; index += 1) {
    if (state.cells[index]!.terrain === "water") continue;
    valueRaw[index] = productivity[index]! * STRATEGIC_REGION_RULES.productivityValueWeight
      + Math.sqrt(infrastructure[index]!) * STRATEGIC_REGION_RULES.infrastructureValueWeight;
  }
  const value = normalizeLayer(smoothLayer(state, valueRaw, 1));
  return { value, productivity, relief, infrastructure };
}

/**
 * Shared, political-neutral value field. Individual realms interpret the
 * resulting regions separately; this field only decides where geography bends.
 */
export function strategicHeatField(
  state: Pick<WorldState, "cells" | "config"> & Partial<Pick<WorldState, "tradeRoutes">>,
): Float32Array {
  return buildStrategicMetaMap(state).value;
}

/**
 * Splits the land into its separate landmasses (8-connected components).
 * Regions can only grow within a landmass, so anchor placement must respect
 * where the sea actually divides the world.
 */
function landComponents(state: Pick<WorldState, "cells" | "config">): number[][] {
  const { width, height } = state.config;
  const seen = new Uint8Array(state.cells.length);
  const components: number[][] = [];
  for (let start = 0; start < state.cells.length; start += 1) {
    if (seen[start] || state.cells[start]!.terrain === "water") continue;
    const component = [start];
    seen[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      for (const neighbor of surroundingIndices(component[cursor]!, width, height)) {
        if (seen[neighbor] || state.cells[neighbor]!.terrain === "water") continue;
        seen[neighbor] = 1;
        component.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function initialAnchors(
  state: Pick<WorldState, "cells" | "config">,
  heat: Float32Array,
  count: number,
): RegionAnchor[] {
  // Anchors are budgeted to each landmass by its share of the world's land
  // (largest-remainder rounding keeps the total exact). Farthest-point
  // sampling over all land together handed sprawling continents more anchors
  // than their area warranted, and every region on them then opened under the
  // common area budget with no way for the partition to fix it -- regions
  // cannot grow across the sea.
  const components = landComponents(state).sort((a, b) => b.length - a.length);
  const landTotal = components.reduce((total, component) => total + component.length, 0);
  const budgets = components.map((component) =>
    Math.floor((count * component.length) / landTotal),
  );
  const remainders = components.map((component, index) =>
    (count * component.length) / landTotal - budgets[index]!,
  );
  let assigned = budgets.reduce((total, budget) => total + budget, 0);
  while (assigned < count) {
    let best = 0;
    for (let index = 1; index < remainders.length; index += 1) {
      if (remainders[index]! > remainders[best]!) best = index;
    }
    budgets[best]! += 1;
    remainders[best] = -1;
    assigned += 1;
  }

  const anchors: RegionAnchor[] = [];
  for (let componentId = 0; componentId < components.length; componentId += 1) {
    const land = components[componentId]!;
    const budget = budgets[componentId]!;
    if (budget === 0) continue;
    let seed = land.reduce((best, index) => heat[index]! > heat[best]! ? index : best, land[0]!);
    const placed: RegionAnchor[] = [];
    const seedCells: number[] = [];
    // Distance is walked over the land itself rather than measured through the
    // air: a peninsula behind a mountain choke is far away on foot however
    // close it sits on the map, and it needs its own anchor or the one region
    // that can reach it is forced over the area budget.
    const distance = new Int32Array(state.cells.length);
    const { width, height } = state.config;
    for (let id = 0; id < budget; id += 1) {
      const [x, y] = cellCoordinates(seed, state.config.width);
      placed.push({ x, y, velocityX: 0, velocityY: 0 });
      seedCells.push(seed);
      distance.fill(-1);
      const queue: number[] = [...seedCells];
      for (const cell of seedCells) distance[cell] = 0;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        for (const neighbor of surroundingIndices(queue[cursor]!, width, height)) {
          if (distance[neighbor] >= 0 || state.cells[neighbor]!.terrain === "water") continue;
          distance[neighbor] = distance[queue[cursor]!]! + 1;
          queue.push(neighbor);
        }
      }
      let best = -1;
      let bestScore = -1;
      for (const index of land) {
        if (distance[index]! <= 0) continue;
        const score = distance[index]! * distance[index]!
          * (1 + heat[index]! * STRATEGIC_REGION_RULES.seedHeatBias);
        if (score > bestScore) {
          best = index;
          bestScore = score;
        }
      }
      if (best >= 0) seed = best;
    }
    anchors.push(...placed);
  }
  return anchors;
}

function filteredAnchors(
  state: Pick<WorldState, "cells" | "config" | "strategicRegions">,
  heat: Float32Array,
): RegionAnchor[] {
  return state.strategicRegions.map((region) => {
    let xTotal = 0;
    let yTotal = 0;
    let weightTotal = 0;
    for (const index of region.cells) {
      const [x, y] = cellCoordinates(index, state.config.width);
      const weight = 1 + heat[index]! * STRATEGIC_REGION_RULES.criticalValuePull;
      xTotal += x * weight;
      yTotal += y * weight;
      weightTotal += weight;
    }
    const observedX = xTotal / Math.max(1, weightTotal);
    const observedY = yTotal / Math.max(1, weightTotal);
    const residualX = observedX - region.anchorX;
    const residualY = observedY - region.anchorY;
    let velocityX = region.velocityX * STRATEGIC_REGION_RULES.velocityDamping
      + residualX * STRATEGIC_REGION_RULES.filterBeta;
    let velocityY = region.velocityY * STRATEGIC_REGION_RULES.velocityDamping
      + residualY * STRATEGIC_REGION_RULES.filterBeta;
    let stepX = residualX * STRATEGIC_REGION_RULES.filterAlpha + velocityX;
    let stepY = residualY * STRATEGIC_REGION_RULES.filterAlpha + velocityY;
    const length = Math.hypot(stepX, stepY);
    if (length > STRATEGIC_REGION_RULES.maximumAnchorStep) {
      const scale = STRATEGIC_REGION_RULES.maximumAnchorStep / length;
      stepX *= scale;
      stepY *= scale;
      velocityX *= scale;
      velocityY *= scale;
    }
    return {
      x: region.anchorX + stepX,
      y: region.anchorY + stepY,
      velocityX,
      velocityY,
    };
  });
}

/**
 * Seeds one region on the free land cell closest to its anchor.
 *
 * Runs once per region against the same land set, so it walks a prepared list
 * of land cells and derives coordinates inline rather than re-testing every
 * cell in the world and allocating a coordinate pair for each.
 */
function nearestLandIndex(
  width: number,
  anchor: RegionAnchor,
  excluded: Uint8Array,
  landCells: Int32Array,
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let cursor = 0; cursor < landCells.length; cursor += 1) {
    const index = landCells[cursor]!;
    if (excluded[index]) continue;
    const x = index % width;
    const y = (index - x) / width;
    const distance = (x - anchor.x) ** 2 + (y - anchor.y) ** 2;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function terrainTransitionCost(first: LandTerrainId, second: LandTerrainId): number {
  if (first === second) return 0;
  const lowland = (terrain: LandTerrainId) => terrain === "farmland" || terrain === "plains";
  if (lowland(first) && lowland(second)) return 0.04;
  if ((first === "hills" && second === "mountains") || (first === "mountains" && second === "hills")) return 0.08;
  return STRATEGIC_REGION_RULES.terrainTransitionCost;
}

function metaTransitionCost(
  meta: StrategicMetaMap,
  first: number,
  second: number,
): number {
  return Math.abs(meta.relief[first]! - meta.relief[second]!)
      * STRATEGIC_REGION_RULES.reliefGradientCost
    + Math.abs(meta.infrastructure[first]! - meta.infrastructure[second]!)
      * STRATEGIC_REGION_RULES.infrastructureGradientCost
    + Math.abs(meta.productivity[first]! - meta.productivity[second]!)
      * STRATEGIC_REGION_RULES.productivityGradientCost;
}

function repairCardinalConnectivity(
  state: Pick<WorldState, "cells" | "config">,
  labels: number[],
  regionCount: number,
): void {
  for (let regionId = 0; regionId < regionCount; regionId += 1) {
    const visited = new Uint8Array(labels.length);
    const components: number[][] = [];
    for (let seed = 0; seed < labels.length; seed += 1) {
      if (labels[seed] !== regionId || visited[seed]) continue;
      const component = [seed];
      visited[seed] = 1;
      for (let cursor = 0; cursor < component.length; cursor += 1) {
        for (const neighbor of neighborIndices(
          component[cursor]!,
          state.config.width,
          state.config.height,
        )) {
          if (labels[neighbor] !== regionId || visited[neighbor]) continue;
          visited[neighbor] = 1;
          component.push(neighbor);
        }
      }
      components.push(component);
    }
    if (components.length <= 1) continue;
    components.sort((first, second) => second.length - first.length);
    for (const orphan of components.slice(1)) {
      const sharedEdges = new Map<number, number>();
      for (const index of orphan) {
        for (const neighbor of neighborIndices(index, state.config.width, state.config.height)) {
          const neighborRegion = labels[neighbor]!;
          if (neighborRegion < 0 || neighborRegion === regionId) continue;
          sharedEdges.set(neighborRegion, (sharedEdges.get(neighborRegion) ?? 0) + 1);
        }
      }
      const recipient = [...sharedEdges]
        .sort((first, second) => second[1] - first[1])[0]?.[0];
      if (recipient === undefined) continue;
      for (const index of orphan) labels[index] = recipient;
    }
  }
}

function partitionLand(
  state: Pick<WorldState, "cells" | "config">,
  anchors: readonly RegionAnchor[],
  meta: StrategicMetaMap,
  previous: readonly number[] | null,
): number[] {
  // Land cells are collected once, ascending, and shared by every region's
  // seed search instead of each one re-testing the whole world.
  const landCells = new Int32Array(state.cells.length);
  let landCount = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index]!.terrain === "water") continue;
    landCells[landCount] = index;
    landCount += 1;
  }
  const land = landCells.subarray(0, landCount);
  const targetCapacity = landCount / anchors.length;
  const counts = anchors.map(() => 0);
  const labels = new Array<number>(state.cells.length).fill(-1);
  const seeded = new Uint8Array(state.cells.length);
  const anchorCells = new Int32Array(anchors.length);
  const heap = new FrontierHeap();

  for (let regionId = 0; regionId < anchors.length; regionId += 1) {
    const index = nearestLandIndex(state.config.width, anchors[regionId]!, seeded, land);
    if (index < 0) continue;
    seeded[index] = 1;
    anchorCells[regionId] = index;
    heap.push(0, 0, index, regionId);
  }

  const { width, height } = state.config;
  while (heap.pop()) {
    const nodeCost = heap.poppedCost;
    const nodeTravelCost = heap.poppedTravelCost;
    const nodeIndex = heap.poppedCell;
    const nodeRegion = heap.poppedRegion;
    if (labels[nodeIndex] >= 0) continue;
    const fillRatio = counts[nodeRegion]! / targetCapacity;
    const balancedCost = nodeTravelCost
      + STRATEGIC_REGION_RULES.areaBalanceStrength * fillRatio ** 4;
    // Frontier entries are repriced as their region grows. This is a soft
    // capacity constraint: every result remains connected, while fast-growing
    // regions yield space to smaller neighbors before areas diverge.
    if (balancedCost > nodeCost + 0.01) {
      heap.push(balancedCost, nodeTravelCost, nodeIndex, nodeRegion);
      continue;
    }
    labels[nodeIndex] = nodeRegion;
    counts[nodeRegion]!++;
    const terrain = state.cells[nodeIndex]!.terrain as LandTerrainId;
    const anchorCell = anchorCells[nodeRegion]!;
    const balancePenalty = STRATEGIC_REGION_RULES.areaBalanceStrength * fillRatio ** 4;
    // Neighbours are walked inline, in the same order surroundingIndices
    // yields them, because the push order decides how equal costs settle.
    const nodeX = nodeIndex % width;
    const nodeY = (nodeIndex - nodeX) / width;
    for (let offset = 0; offset < SURROUNDING_OFFSETS.length; offset += 2) {
      const nx = nodeX + SURROUNDING_OFFSETS[offset]!;
      const ny = nodeY + SURROUNDING_OFFSETS[offset + 1]!;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbor = ny * width + nx;
      if (labels[neighbor] >= 0 || state.cells[neighbor]!.terrain === "water") continue;
      const nextTerrain = state.cells[neighbor]!.terrain as LandTerrainId;
      const inertia = previous?.[neighbor] === nodeRegion ? STRATEGIC_REGION_RULES.boundaryInertia : 0;
      const diagonal = Math.abs(neighbor - nodeIndex) !== 1
        && Math.abs(neighbor - nodeIndex) !== width;
      const geometricDistance = diagonal ? Math.SQRT2 : 1;
      const basinAffinity = Math.abs(meta.relief[neighbor]! - meta.relief[anchorCell]!)
          * STRATEGIC_REGION_RULES.reliefBasinAffinity
        + Math.abs(meta.infrastructure[neighbor]! - meta.infrastructure[anchorCell]!)
          * STRATEGIC_REGION_RULES.infrastructureBasinAffinity;
      const step = Math.max(
        0.18,
        geometricDistance * (
          1
          + terrainTransitionCost(terrain, nextTerrain)
          + metaTransitionCost(meta, nodeIndex, neighbor)
          + basinAffinity
        )
          - meta.value[neighbor]! * STRATEGIC_REGION_RULES.heatTravelAdvantage
          - inertia,
      );
      const travelCost = nodeTravelCost + step;
      heap.push(travelCost + balancePenalty, travelCost, neighbor, nodeRegion);
    }
  }
  repairCardinalConnectivity(state, labels, anchors.length);
  return labels;
}

function materializeRegions(
  state: Pick<WorldState, "cells" | "config">,
  labels: number[],
  anchors: readonly RegionAnchor[],
  updatedAt: number,
): StrategicRegion[] {
  const grouped = anchors.map(() => [] as number[]);
  for (let index = 0; index < labels.length; index += 1) {
    const id = labels[index]!;
    if (id >= 0) grouped[id]!.push(index);
  }
  return grouped.map((cells, id): StrategicRegion => {
    const profile = emptyTerrainProfile();
    let xTotal = 0;
    let yTotal = 0;
    let productivity = 0;
    for (const index of cells) {
      const terrain = state.cells[index]!.terrain as LandTerrainId;
      profile[terrain] += 1;
      const [x, y] = cellCoordinates(index, state.config.width);
      xTotal += x;
      yTotal += y;
      productivity += TERRAIN_RULES[terrain].sustain * 1.7 + TERRAIN_RULES[terrain].goldYield;
    }
    const centerX = xTotal / Math.max(1, cells.length);
    const centerY = yTotal / Math.max(1, cells.length);
    let centroidIndex = cells[0] ?? 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const index of cells) {
      const [x, y] = cellCoordinates(index, state.config.width);
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance < bestDistance) {
        centroidIndex = index;
        bestDistance = distance;
      }
    }
    const dominantTerrain = (Object.entries(profile) as Array<[LandTerrainId, number]>)
      .sort((first, second) => second[1] - first[1])[0]![0];
    const anchor = anchors[id]!;
    return {
      id,
      cells,
      centroidIndex,
      dominantTerrain,
      terrainProfile: profile,
      baseProductivity: productivity / Math.max(1, cells.length),
      anchorX: anchor.x,
      anchorY: anchor.y,
      velocityX: anchor.velocityX,
      velocityY: anchor.velocityY,
      updatedAt,
    };
  });
}

export function createStrategicRegions(
  state: Pick<WorldState, "seed" | "cells" | "config">,
): { regions: StrategicRegion[]; regionByCell: number[]; meta: StrategicMetaMap } {
  const meta = buildStrategicMetaMap(state);
  const landCount = state.cells.reduce((total, cell) => total + (cell.terrain === "water" ? 0 : 1), 0);
  const count = Math.max(
    STRATEGIC_REGION_RULES.minimumRegionCount,
    Math.round(landCount / STRATEGIC_REGION_RULES.targetCellsPerRegion),
  );
  let anchors = initialAnchors(state, meta.value, count);
  let regionByCell = partitionLand(state, anchors, meta, null);
  let regions = materializeRegions(state, regionByCell, anchors, 0);
  // A few strong Lloyd-style observations remove coastline size bias before
  // the first frame. Runtime movement then switches to the gentler filter.
  for (let pass = 0; pass < STRATEGIC_REGION_RULES.initialRelaxationPasses; pass += 1) {
    anchors = regions.map((region) => {
      let xTotal = 0;
      let yTotal = 0;
      let weightTotal = 0;
      for (const index of region.cells) {
        const [x, y] = cellCoordinates(index, state.config.width);
        const weight = 1 + meta.value[index]! * STRATEGIC_REGION_RULES.criticalValuePull;
        xTotal += x * weight;
        yTotal += y * weight;
        weightTotal += weight;
      }
      return {
        x: region.anchorX + (xTotal / weightTotal - region.anchorX) * STRATEGIC_REGION_RULES.initialRelaxationGain,
        y: region.anchorY + (yTotal / weightTotal - region.anchorY) * STRATEGIC_REGION_RULES.initialRelaxationGain,
        velocityX: 0,
        velocityY: 0,
      };
    });
    regionByCell = partitionLand(state, anchors, meta, regionByCell);
    regions = materializeRegions(state, regionByCell, anchors, 0);
  }
  return { regions, regionByCell, meta };
}

export function updateStrategicRegions(state: WorldState): void {
  if (state.tick === 0 || state.tick % STRATEGIC_REGION_RULES.repartitionTicks !== 0) return;
  const meta = buildStrategicMetaMap(state);
  const anchors = filteredAnchors(state, meta.value);
  const regionByCell = partitionLand(state, anchors, meta, state.regionByCell);
  state.strategicRegions = materializeRegions(state, regionByCell, anchors, state.tick);
  state.regionByCell = regionByCell;
  state.strategicMeta = { ...meta, updatedAt: state.tick };
}

/** Useful in tests and debug tools that need a compact region raster. */
export function regionAtCoordinates(
  state: Pick<WorldState, "regionByCell" | "config">,
  x: number,
  y: number,
): number {
  return state.regionByCell[cellIndex(x, y, state.config.width)] ?? -1;
}
