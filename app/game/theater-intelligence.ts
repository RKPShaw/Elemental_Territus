import { NATIONS, NATION_ORDER } from "./nations";
import { getRelation } from "./diplomacy";
import { ELEMENTS, realmMatchup } from "./elements";
import { cellCoordinates, distanceBetween, neighborIndices, surroundingIndices } from "./grid";
import type { NationId, LandTerrainId, WorldState } from "./types";

export const THEATER_LAYERS = [
  "composite",
  "productivity",
  "terrain",
  "infrastructure",
  "access",
  "affinity",
  "opportunity",
] as const;

export type TheaterLayer = (typeof THEATER_LAYERS)[number];

export const THEATER_LAYER_LABELS: Record<TheaterLayer, string> = {
  composite: "Composite",
  productivity: "Land yield",
  terrain: "Terrain ease",
  infrastructure: "Infrastructure",
  access: "Access",
  affinity: "Element fit",
  opportunity: "Opportunity",
};

export interface TheaterCellMaps {
  composite: Float32Array;
  productivity: Float32Array;
  terrain: Float32Array;
  infrastructure: Float32Array;
  access: Float32Array;
  affinity: Float32Array;
  opportunity: Float32Array;
}

export interface TheaterIntelligence {
  regionId: number;
  rawValue: number;
  normalizedValue: number;
  score: number;
  productivity: number;
  infrastructure: number;
  access: number;
  affinity: number;
  ownership: number;
}

const INFRASTRUCTURE_VALUE = {
  city: 24,
  factory: 21,
  harbor: 19,
  fort: 7,
} as const;

const RELATED_TERRAINS: Record<LandTerrainId, readonly LandTerrainId[]> = {
  farmland: ["plains"],
  plains: ["farmland", "hills"],
  forest: ["hills"],
  hills: ["plains", "forest", "mountains"],
  mountains: ["hills"],
};

function normalizeCellLayer(state: WorldState, source: Float32Array): Float32Array {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < source.length; index += 1) {
    if (state.cells[index]!.terrain === "water") continue;
    minimum = Math.min(minimum, source[index]!);
    maximum = Math.max(maximum, source[index]!);
  }
  const range = Math.max(0.0001, maximum - minimum);
  const output = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    if (state.cells[index]!.terrain === "water") continue;
    output[index] = Math.max(0, Math.min(1, (source[index]! - minimum) / range));
  }
  return output;
}

function smoothCellLayer(state: WorldState, source: Float32Array, passes = 2): Float32Array {
  let current = source;
  for (let pass = 0; pass < passes; pass += 1) {
    const output = new Float32Array(current.length);
    for (let index = 0; index < current.length; index += 1) {
      if (state.cells[index]!.terrain === "water") continue;
      let total = current[index]! * 4;
      let weight = 4;
      for (const neighbor of surroundingIndices(index, state.config.width, state.config.height)) {
        if (state.cells[neighbor]!.terrain === "water") continue;
        const diagonal = Math.abs(neighbor - index) !== 1
          && Math.abs(neighbor - index) !== state.config.width;
        const neighborWeight = diagonal ? 0.7 : 1;
        total += current[neighbor]! * neighborWeight;
        weight += neighborWeight;
      }
      output[index] = total / weight;
    }
    current = output;
  }
  return normalizeCellLayer(state, current);
}

/**
 * Continuous, realm-specific theater intelligence. These scalar maps are
 * intentionally independent of the hidden campaign-region IDs: their level
 * sets form nested contours around economic and geographic peaks instead of
 * repeating the equal-area partition's shapes.
 */
export function evaluateTheaterCellMaps(
  state: WorldState,
  viewer: NationId,
): TheaterCellMaps {
  const size = state.cells.length;
  const productivity = state.strategicMeta.productivity.slice();
  const terrainRaw = new Float32Array(size);
  const infrastructureRaw = new Float32Array(size);
  const accessRaw = new Float32Array(size);
  const affinityRaw = new Float32Array(size);
  const opportunityRaw = new Float32Array(size);
  const rail = new Uint8Array(size);
  for (const route of state.tradeRoutes) {
    if (route.kind !== "rail") continue;
    for (const index of route.pathIndices) rail[index] = 1;
  }

  const faction = state.factions[viewer];
  const favoredTerrains = new Set<LandTerrainId>(
    faction.absorbedElements.map((element) => ELEMENTS[element].favoredTerrain),
  );
  const [capitalX, capitalY] = cellCoordinates(faction.capitalIndex, state.config.width);
  const foreignOpportunity = Object.fromEntries(NATION_ORDER.map((owner) => {
    if (owner === viewer) return [owner, 0.28];
    const relation = getRelation(state, viewer, owner);
    const diplomatic = relation.status === "war" ? 0.94 : relation.status === "peace" ? 0.48 : 0.16;
    return [owner, diplomatic * Math.max(0.72, Math.min(1.28, realmMatchup(state, viewer, owner)))];
  })) as Record<NationId, number>;

  for (let index = 0; index < size; index += 1) {
    const cell = state.cells[index]!;
    if (cell.terrain === "water") continue;
    const [x, y] = cellCoordinates(index, state.config.width);
    const distance = Math.hypot(x - capitalX, y - capitalY);
    const proximity = Math.exp(-distance / 34);
    const ownershipAccess = cell.owner === viewer
      ? 0.92
      : cell.owner === null
        ? 0.62
        : getRelation(state, viewer, cell.owner).status === "war"
          ? 0.5
          : 0.24;
    const terrain = cell.terrain;
    let affinity = favoredTerrains.has(terrain) ? 1 : 0.34;
    for (const favored of favoredTerrains) {
      if (RELATED_TERRAINS[favored].includes(terrain)) affinity = Math.max(affinity, 0.67);
    }

    terrainRaw[index] = 1 - state.strategicMeta.relief[index]! * 0.78;
    infrastructureRaw[index] = Math.sqrt(state.strategicMeta.infrastructure[index]!);
    accessRaw[index] = proximity * 0.5 + ownershipAccess * 0.35 + rail[index]! * 0.15;
    affinityRaw[index] = affinity;
    const political = cell.owner === null ? 0.7 : foreignOpportunity[cell.owner];
    opportunityRaw[index] = political * 0.72
      + infrastructureRaw[index]! * 0.22
      + (cell.capitalOf ? 0.18 : 0);
  }

  const terrain = smoothCellLayer(state, terrainRaw, 2);
  const infrastructure = normalizeCellLayer(state, infrastructureRaw);
  const access = smoothCellLayer(state, accessRaw, 3);
  const affinity = smoothCellLayer(state, affinityRaw, 2);
  const opportunity = smoothCellLayer(state, opportunityRaw, 3);
  const compositeRaw = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    if (state.cells[index]!.terrain === "water") continue;
    compositeRaw[index] = productivity[index]! * 0.24
      + terrain[index]! * 0.08
      + infrastructure[index]! * 0.23
      + access[index]! * 0.16
      + affinity[index]! * 0.14
      + opportunity[index]! * 0.15;
  }
  const composite = smoothCellLayer(state, compositeRaw, 2);
  return { composite, productivity, terrain, infrastructure, access, affinity, opportunity };
}

/**
 * Produces one realm's interpretation of every persistent geographic region.
 * The score intentionally combines shared facts with realm-specific terrain
 * affinity, access, ownership, diplomacy, elemental matchups and live focus.
 */
export function evaluateTheaterMap(
  state: WorldState,
  viewer: NationId,
): TheaterIntelligence[] {
  const faction = state.factions[viewer];
  const favoredTerrains = new Set<LandTerrainId>(
    faction.absorbedElements.map((element) => ELEMENTS[element].favoredTerrain),
  );
  const railCells = new Set(
    state.tradeRoutes.filter((route) => route.kind === "rail").flatMap((route) => route.pathIndices),
  );
  const focusedRegions = new Map<number, number>();
  for (const theater of state.theaters) {
    if (theater.attacker !== viewer || theater.staleRefreshes !== 0) continue;
    focusedRegions.set(theater.regionId, Math.max(focusedRegions.get(theater.regionId) ?? 0, theater.strategicValue));
  }

  const evaluations = state.strategicRegions.map((region): TheaterIntelligence => {
    const size = Math.max(1, region.cells.length);
    let infrastructure = 0;
    let owned = 0;
    let wilderness = 0;
    let accessEdges = 0;
    let diplomaticOpportunity = 0;

    for (const index of region.cells) {
      const cell = state.cells[index]!;
      if (cell.owner === viewer) owned += 1;
      if (cell.owner === null) wilderness += 1;
      if (cell.structure) {
        const base = INFRASTRUCTURE_VALUE[cell.structure] * (cell.structure === "city" ? cell.structureLevel : 1);
        if (cell.owner === viewer) infrastructure += base * 1.05;
        else if (cell.owner === null) infrastructure += base;
        else {
          const relation = getRelation(state, viewer, cell.owner);
          const relationValue = relation.status === "war" ? 1.35 : relation.status === "truce" ? 1.22 : 1.08;
          infrastructure += base * relationValue * realmMatchup(state, viewer, cell.owner);
        }
      }
      if (railCells.has(index)) infrastructure += 4;
      for (const neighbor of neighborIndices(index, state.config.width, state.config.height)) {
        if (state.cells[neighbor]!.owner === viewer && state.regionByCell[neighbor] !== region.id) accessEdges += 1;
      }
      if (cell.owner && cell.owner !== viewer) {
        const relation = getRelation(state, viewer, cell.owner);
        diplomaticOpportunity += relation.status === "war"
          ? 0.22 * realmMatchup(state, viewer, cell.owner)
          : relation.status === "truce"
            ? 0.12
            : 0.07;
      }
    }

    const affinityCells = (["farmland", "plains", "forest", "hills", "mountains"] as const)
      .reduce((sum, terrain) => sum + (favoredTerrains.has(terrain) ? region.terrainProfile[terrain] : 0), 0);
    const affinity = affinityCells / size;
    const ownership = owned / size;
    const wildernessShare = wilderness / size;
    const distanceFromCapital = distanceBetween(state, faction.capitalIndex, region.centroidIndex);
    const proximity = 1 / (1 + distanceFromCapital / 24);
    const access = Math.min(1, ownership * 1.8 + accessEdges / Math.max(8, Math.sqrt(size) * 5) + proximity * 0.36);
    const productivity = region.baseProductivity;
    const focus = focusedRegions.get(region.id) ?? 0;
    const rawValue =
      productivity * 19 +
      Math.sqrt(size) * 1.15 +
      affinity * 24 +
      Math.sqrt(infrastructure) * 4.4 +
      access * 17 +
      ownership * 8 +
      wildernessShare * 4 +
      Math.min(12, diplomaticOpportunity / size * 55) +
      Math.min(10, Math.sqrt(focus) * 0.85);

    return {
      regionId: region.id,
      rawValue,
      normalizedValue: 0,
      score: 0,
      productivity,
      infrastructure,
      access,
      affinity,
      ownership,
    };
  });

  const sorted = evaluations.map((evaluation) => evaluation.rawValue).sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const high = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? low + 1;
  for (const evaluation of evaluations) {
    evaluation.normalizedValue = Math.max(0, Math.min(1, (evaluation.rawValue - low) / Math.max(0.001, high - low)));
    evaluation.score = Math.round(evaluation.normalizedValue * 100);
  }
  return evaluations;
}
