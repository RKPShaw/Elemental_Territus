import { cellCoordinates, cellIndex, neighborIndices, surroundingIndices } from "./grid";
import { STRATEGIC_REGION_RULES, TERRAIN_RULES } from "./rules";
import type {
  LandTerrainId,
  StrategicRegion,
  TheaterTerrainProfile,
  WorldState,
} from "./types";

interface RegionAnchor {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

interface FrontierNode {
  cost: number;
  travelCost: number;
  index: number;
  regionId: number;
}

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
  private readonly nodes: FrontierNode[] = [];

  push(node: FrontierNode): void {
    let index = this.nodes.push(node) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.nodes[parent]!.cost <= node.cost) break;
      this.nodes[index] = this.nodes[parent]!;
      index = parent;
    }
    this.nodes[index] = node;
  }

  pop(): FrontierNode | undefined {
    const first = this.nodes[0];
    const tail = this.nodes.pop();
    if (!first || !tail || this.nodes.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.nodes.length) break;
      const right = left + 1;
      const child = right < this.nodes.length && this.nodes[right]!.cost < this.nodes[left]!.cost
        ? right
        : left;
      if (this.nodes[child]!.cost >= tail.cost) break;
      this.nodes[index] = this.nodes[child]!;
      index = child;
    }
    this.nodes[index] = tail;
    return first;
  }

  get size(): number {
    return this.nodes.length;
  }
}

function emptyTerrainProfile(): TheaterTerrainProfile {
  return { farmland: 0, plains: 0, forest: 0, hills: 0, mountains: 0 };
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

function initialAnchors(
  state: Pick<WorldState, "cells" | "config">,
  heat: Float32Array,
  count: number,
): RegionAnchor[] {
  const land = state.cells.flatMap((cell, index) => cell.terrain === "water" ? [] : [index]);
  const anchors: RegionAnchor[] = [];
  const chosen = new Uint8Array(state.cells.length);
  let seed = land.reduce((best, index) => heat[index]! > heat[best]! ? index : best, land[0]!);

  for (let id = 0; id < count; id += 1) {
    const [x, y] = cellCoordinates(seed, state.config.width);
    anchors.push({ x, y, velocityX: 0, velocityY: 0 });
    chosen[seed] = 1;
    let best = -1;
    let bestScore = -1;
    for (const index of land) {
      if (chosen[index]) continue;
      const [candidateX, candidateY] = cellCoordinates(index, state.config.width);
      let nearest = Number.POSITIVE_INFINITY;
      for (const anchor of anchors) {
        nearest = Math.min(nearest, (candidateX - anchor.x) ** 2 + (candidateY - anchor.y) ** 2);
      }
      const score = nearest * (1 + heat[index]! * STRATEGIC_REGION_RULES.seedHeatBias);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
    if (best >= 0) seed = best;
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

function nearestLandIndex(
  state: Pick<WorldState, "cells" | "config">,
  anchor: RegionAnchor,
  excluded: Uint8Array,
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (excluded[index] || state.cells[index]!.terrain === "water") continue;
    const [x, y] = cellCoordinates(index, state.config.width);
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
  const landCount = state.cells.reduce((total, cell) => total + (cell.terrain === "water" ? 0 : 1), 0);
  const targetCapacity = landCount / anchors.length;
  const counts = anchors.map(() => 0);
  const labels = new Array<number>(state.cells.length).fill(-1);
  const seeded = new Uint8Array(state.cells.length);
  const anchorCells = new Int32Array(anchors.length);
  const heap = new FrontierHeap();

  for (let regionId = 0; regionId < anchors.length; regionId += 1) {
    const index = nearestLandIndex(state, anchors[regionId]!, seeded);
    if (index < 0) continue;
    seeded[index] = 1;
    anchorCells[regionId] = index;
    heap.push({ cost: 0, travelCost: 0, index, regionId });
  }

  while (heap.size > 0) {
    const node = heap.pop()!;
    if (labels[node.index] >= 0) continue;
    const fillRatio = counts[node.regionId]! / targetCapacity;
    const balancedCost = node.travelCost
      + STRATEGIC_REGION_RULES.areaBalanceStrength * fillRatio ** 4;
    // Frontier entries are repriced as their region grows. This is a soft
    // capacity constraint: every result remains connected, while fast-growing
    // regions yield space to smaller neighbors before areas diverge.
    if (balancedCost > node.cost + 0.01) {
      heap.push({ ...node, cost: balancedCost });
      continue;
    }
    labels[node.index] = node.regionId;
    counts[node.regionId]!++;
    const terrain = state.cells[node.index]!.terrain as LandTerrainId;
    for (const neighbor of surroundingIndices(node.index, state.config.width, state.config.height)) {
      if (labels[neighbor] >= 0 || state.cells[neighbor]!.terrain === "water") continue;
      const nextTerrain = state.cells[neighbor]!.terrain as LandTerrainId;
      const inertia = previous?.[neighbor] === node.regionId ? STRATEGIC_REGION_RULES.boundaryInertia : 0;
      const diagonal = Math.abs(neighbor - node.index) !== 1
        && Math.abs(neighbor - node.index) !== state.config.width;
      const geometricDistance = diagonal ? Math.SQRT2 : 1;
      const anchorCell = anchorCells[node.regionId]!;
      const basinAffinity = Math.abs(meta.relief[neighbor]! - meta.relief[anchorCell]!)
          * STRATEGIC_REGION_RULES.reliefBasinAffinity
        + Math.abs(meta.infrastructure[neighbor]! - meta.infrastructure[anchorCell]!)
          * STRATEGIC_REGION_RULES.infrastructureBasinAffinity;
      const step = Math.max(
        0.18,
        geometricDistance * (
          1
          + terrainTransitionCost(terrain, nextTerrain)
          + metaTransitionCost(meta, node.index, neighbor)
          + basinAffinity
        )
          - meta.value[neighbor]! * STRATEGIC_REGION_RULES.heatTravelAdvantage
          - inertia,
      );
      const travelCost = node.travelCost + step;
      heap.push({ cost: travelCost + STRATEGIC_REGION_RULES.areaBalanceStrength * fillRatio ** 4, travelCost, index: neighbor, regionId: node.regionId });
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
