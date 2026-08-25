import { relationKey } from "./diplomacy";
import { ELEMENT_ORDER } from "./elements";
import { cellCoordinates, neighborIndices } from "./grid";
import { SeededRandom, smoothCellNoise } from "./random";
import { createStrategicRegions } from "./regions";
import { realmSubject } from "./reporting";
import { CLAIM_RULES, TERRAIN_RULES, calculateTroopCap, normalizedCellArea } from "./rules";
import type {
  Cell,
  ElementId,
  FactionState,
  RelationState,
  SimulationConfig,
  StructureCounts,
  TerrainId,
  WorldState,
} from "./types";

export const DEFAULT_CONFIG: SimulationConfig = {
  width: 168,
  height: 104,
  aggression: 1,
  decisionInterval: 10,
  diplomacyInterval: 16,
  constructionInterval: 2,
  minimumPeaceTicks: 180,
  victoryShare: 0.8,
  maximumTroops: 1_500_000,
};

const WORLD_STARTS: Record<ElementId, readonly [number, number]> = {
  ember: [0.26, 0.29],
  tide: [0.51, 0.18],
  grove: [0.27, 0.73],
  stone: [0.72, 0.3],
  gale: [0.73, 0.72],
};

const WORLD_FIRST = [
  "Button",
  "Pebble",
  "Mallow",
  "Dapple",
  "Puddle",
  "Tumble",
  "Pocket",
  "Thimble",
] as const;

const WORLD_LAST = [
  "reach",
  "hollow",
  "mere",
  "wold",
  "wilds",
  "vale",
  "garden",
  "march",
] as const;

function ellipse(
  nx: number,
  ny: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): number {
  return Math.pow((nx - cx) / rx, 2) + Math.pow((ny - cy) / ry, 2);
}

function landAt(seed: number, x: number, y: number, config: SimulationConfig): boolean {
  const nx = x / (config.width - 1);
  const ny = y / (config.height - 1);
  const broadNoise =
    smoothCellNoise(seed ^ 0x6a09e667, x, y, config.width / 14) - 0.5;
  const fineNoise =
    smoothCellNoise(seed ^ 0xbb67ae85, x, y, config.width / 48) - 0.5;
  const coastWobble = broadNoise * 0.3 + fineNoise * 0.055;
  const west = ellipse(nx, ny, 0.265, 0.52, 0.285, 0.45) < 1 + coastWobble;
  const east = ellipse(nx, ny, 0.735, 0.51, 0.285, 0.45) < 1 + coastWobble;
  const tideNorth = ellipse(nx, ny, 0.51, 0.18, 0.105, 0.145) < 1 + coastWobble * 0.7;
  const tideSouth = ellipse(nx, ny, 0.505, 0.76, 0.095, 0.12) < 1 + coastWobble * 0.7;
  let land = west || east || tideNorth || tideSouth;

  for (const [sx, sy] of Object.values(WORLD_STARTS)) {
    const dx = x - sx * config.width;
    const dy = y - sy * config.height;
    if (Math.hypot(dx, dy) < 4.2 / Math.sqrt(normalizedCellArea(config))) land = true;
  }

  if (x < 2 || y < 2 || x >= config.width - 2 || y >= config.height - 2) return false;
  return land;
}

function terrainAt(
  seed: number,
  x: number,
  y: number,
  config: SimulationConfig,
): TerrainId {
  const elevation =
    smoothCellNoise(seed ^ 0x3c6ef372, x, y, config.width / 11) * 0.72 +
    smoothCellNoise(seed ^ 0xa54ff53a, x, y, config.width / 43) * 0.28;
  const moisture =
    smoothCellNoise(seed ^ 0x510e527f, x, y, config.width / 13) * 0.74 +
    smoothCellNoise(seed ^ 0x9b05688c, x, y, config.width / 46) * 0.26;
  if (elevation > 0.78) return "mountains";
  if (elevation > 0.63) return "hills";
  if (moisture > 0.64) return "forest";
  if (elevation < 0.42 && moisture > 0.39) return "farmland";
  return "plains";
}

function initialOwnerAt(x: number, y: number, config: SimulationConfig): ElementId | null {
  let best: ElementId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ELEMENT_ORDER) {
    const [sx, sy] = WORLD_STARTS[candidate];
    const dx = x - sx * config.width;
    const dy = y - sy * config.height;
    const distance = Math.hypot(dx, dy) * Math.sqrt(normalizedCellArea(config));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= CLAIM_RULES.initialRegionRadius ? best : null;
}

function emptyStructures(): StructureCounts {
  return { city: 0, fort: 0, factory: 0, harbor: 0 };
}

function makeFaction(id: ElementId): FactionState {
  return {
    id,
    alive: true,
    territory: 0,
    previousTerritory: 0,
    momentum: 0,
    troops: 0,
    troopCap: 1,
    troopGrowth: 0,
    gold: 20_000,
    goldRate: 0,
    sustainableLand: 0,
    casualties: 0,
    capturedTiles: 0,
    claimedTiles: 0,
    warWeariness: 0,
    traitorUntil: 0,
    warships: 0,
    structures: emptyStructures(),
    capitalIndex: -1,
    absorbedElements: [id],
    lastConqueror: null,
    intent: {
      target: null,
      posture: "peaceful",
      confidence: 0.58,
      plannedCommitment: 0,
      reason: "The world is at peace. Grow the host, map the coast and find reliable trade partners.",
    },
  };
}

function closestOwnedCell(
  state: Pick<WorldState, "cells" | "config">,
  owner: ElementId,
  x: number,
  y: number,
): number {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index]!.owner !== owner) continue;
    const [cx, cy] = cellCoordinates(index, state.config.width);
    const distance = Math.hypot(cx - x, cy - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function createWorld(seed: number, config = DEFAULT_CONFIG): WorldState {
  const random = new SeededRandom(seed);
  const cells: Cell[] = [];
  for (let y = 0; y < config.height; y += 1) {
    for (let x = 0; x < config.width; x += 1) {
      const land = landAt(seed, x, y, config);
      cells.push({
        owner: land ? initialOwnerAt(x, y, config) : null,
        terrain: land ? terrainAt(seed, x, y, config) : "water",
        structure: null,
        structureLevel: 0,
        capitalOf: null,
        coastal: false,
        pressure: 0,
        pressureBy: null,
        pressureTracked: false,
        capturedAt: -99,
      });
    }
  }

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    if (cell.terrain === "water") continue;
    cell.coastal = neighborIndices(index, config.width, config.height).some(
      (neighbor) => cells[neighbor]!.terrain === "water",
    );
  }

  const factions = Object.fromEntries(
    ELEMENT_ORDER.map((id) => [id, makeFaction(id)]),
  ) as Record<ElementId, FactionState>;

  const skeletonState = { cells, config } as Pick<WorldState, "cells" | "config">;
  for (const id of ELEMENT_ORDER) {
    const [sx, sy] = WORLD_STARTS[id];
    const capitalIndex = closestOwnedCell(
      skeletonState,
      id,
      sx * config.width,
      sy * config.height,
    );
    const faction = factions[id];
    faction.capitalIndex = capitalIndex;
    if (capitalIndex >= 0) {
      cells[capitalIndex]!.capitalOf = id;
    }
  }

  const cellArea = normalizedCellArea(config);
  for (const cell of cells) {
    if (!cell.owner) continue;
    const faction = factions[cell.owner];
    faction.territory += 1;
    faction.sustainableLand += TERRAIN_RULES[cell.terrain].sustain * cellArea;
    if (cell.structure) {
      faction.structures[cell.structure] += cell.structure === "city"
        ? Math.max(1, cell.structureLevel)
        : 1;
    }
  }

  for (const faction of Object.values(factions)) {
    faction.previousTerritory = faction.territory;
    faction.troopCap = calculateTroopCap(
      faction.sustainableLand,
      faction.structures.city,
      config.maximumTroops,
    );
    faction.troops = faction.id === "tide" ? 16_000 : 12_000;
  }

  const relations: Record<string, RelationState> = {};
  for (let first = 0; first < ELEMENT_ORDER.length; first += 1) {
    for (let second = first + 1; second < ELEMENT_ORDER.length; second += 1) {
      const a = ELEMENT_ORDER[first]!;
      const b = ELEMENT_ORDER[second]!;
      const key = relationKey(a, b);
      relations[key] = {
        key,
        parties: [a, b],
        status: "peace",
        since: 0,
        cooldownUntil: config.minimumPeaceTicks,
        truceUntil: 0,
        truceOfferBy: null,
        truceOfferAt: 0,
        lastAggressor: null,
        tradeActive: true,
        tradeDisabledBy: [],
        storyKey: null,
      };
    }
  }

  const worldName = `${random.pick(WORLD_FIRST)}${random.pick(WORLD_LAST)}`;
  const landTiles = cells.reduce((total, cell) => total + (cell.terrain !== "water" ? 1 : 0), 0);
  const strategicMap = createStrategicRegions({ seed, cells, config });
  return {
    seed,
    worldName,
    tick: 0,
    age: 1,
    landTiles,
    cells,
    factions,
    relations,
    campaigns: [],
    strategicRegions: strategicMap.regions,
    strategicMeta: { ...strategicMap.meta, updatedAt: 0 },
    regionByCell: strategicMap.regionByCell,
    theaters: [],
    tradeRoutes: [],
    railNetworkSignature: "",
    railNetworkNeedsExpansion: true,
    tradeVehicles: [],
    tradeDispatches: {},
    activePressureCells: [],
    commands: [],
    chronicle: [
      {
        id: 1,
        tick: 0,
        tone: "world",
        text: `${worldName} wakes mostly unclaimed. Five elemental peoples raise banners with 20K treasuries and no developed infrastructure.`,
        actor: null,
      },
    ],
    reports: [
      {
        schemaVersion: 1,
        id: 1,
        tick: 0,
        age: 1,
        domain: "world",
        kind: "world.created",
        importance: "historic",
        storyKey: `world:${seed}`,
        initiator: null,
        targets: [],
        participants: ELEMENT_ORDER.map(realmSubject),
        links: {},
        facts: {
          seed,
          landTiles,
          foundingRealms: ELEMENT_ORDER.length,
        },
        summary: `${worldName} wakes mostly unclaimed as five elemental realms raise their first banners.`,
      },
    ],
    stories: [],
    storyCursor: 0,
    champion: null,
    dominantSince: null,
    config,
  };
}
