import { relationKey } from "./diplomacy";
import { baseMaskOf } from "./elements";
import { neighborIndices } from "./grid";
import { PLAYERS, PLAYER_ORDER, playerElement } from "./players";
import { SeededRandom, smoothCellNoise } from "./random";
import { createEconomyLedger } from "./economics";
import { createStrategicRegions } from "./regions";
import { createTheaterMap } from "./theater-map";
import { realmSubject } from "./reporting";
import { TERRAIN_RULES, calculateTroopCap, normalizedCellArea } from "./rules";
import { claimInitialTerritory, draftSpawnSites } from "./spawn";
import { initialStrategy } from "./strategy";
import type {
  Cell,
  ElementId,
  PlayerId,
  FactionState,
  RelationState,
  SimulationConfig,
  StructureCounts,
  TerrainId,
  WorldState,
} from "./types";

/**
 * How many times wider and taller the map is than the 168x104 world the game
 * shipped with. Overridable through ELEMENTAL_MAP_SCALE so a sweep can find the
 * largest map that still fits the tick budget; fixed once the module loads, so
 * a run stays deterministic. Cell yields are already normalised against a
 * reference world (see normalizedCellArea), so scaling the map keeps a tile
 * worth what it was rather than making a bigger world a richer one.
 */
const MAP_SCALE = (() => {
  const raw = typeof process === "undefined" ? undefined : process.env?.ELEMENTAL_MAP_SCALE;
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

export const DEFAULT_CONFIG: SimulationConfig = {
  width: Math.round(168 * MAP_SCALE),
  height: Math.round(104 * MAP_SCALE),
  aggression: 1,
  decisionInterval: 10,
  diplomacyInterval: 16,
  constructionInterval: 2,
  strategyInterval: 40,
  minimumPeaceTicks: 180,
  victoryShare: 0.8,
  maximumTroops: 1_500_000,
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
  // Continents sit inside the frame rather than running off it. They used to
  // span past both edges and be cut off by the border guard, so the world read
  // as a crop of something larger with no sea beyond the coast -- and a coast
  // that is a straight line down the edge of the screen is the one shape no
  // coastline ever has.
  const west = ellipse(nx, ny, 0.30, 0.50, 0.235, 0.385) < 1 + coastWobble;
  const east = ellipse(nx, ny, 0.70, 0.50, 0.235, 0.385) < 1 + coastWobble;
  const tideNorth = ellipse(nx, ny, 0.50, 0.205, 0.095, 0.125) < 1 + coastWobble * 0.7;
  const tideSouth = ellipse(nx, ny, 0.50, 0.775, 0.085, 0.105) < 1 + coastWobble * 0.7;
  const land = west || east || tideNorth || tideSouth;

  // Open water all the way round, wide enough to read as ocean rather than as
  // a hairline. Scaled to the map so it survives a change of size.
  const margin = Math.max(3, Math.round(Math.min(config.width, config.height) * 0.045));
  if (
    x < margin || y < margin
    || x >= config.width - margin || y >= config.height - margin
  ) return false;
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

function emptyStructures(): StructureCounts {
  return { city: 0, fort: 0, factory: 0, harbor: 0, plant: 0, skyport: 0 };
}

function makeFaction(id: PlayerId, seed: number): FactionState {
  const element = playerElement(id);
  return {
    id,
    element,
    expressedElement: element,
    baseMask: baseMaskOf([element]),
    alive: true,
    territory: 0,
    previousTerritory: 0,
    momentum: 0,
    troops: 0,
    troopCap: 1,
    troopGrowth: 0,
    gold: 20_000,
    goldRate: 0,
    economy: createEconomyLedger(),
    sustainableLand: 0,
    casualties: 0,
    capturedTiles: 0,
    claimedTiles: 0,
    warWeariness: 0,
    traitorUntil: 0,
    warships: 0,
    structures: emptyStructures(),
    capitalIndex: -1,
    strategy: initialStrategy(seed, id, element),
    absorbedElements: [element],
    elementCounts: { [element]: 1 } as Record<ElementId, number>,
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

export function createWorld(seed: number, config = DEFAULT_CONFIG): WorldState {
  const random = new SeededRandom(seed);
  const cells: Cell[] = [];
  for (let y = 0; y < config.height; y += 1) {
    for (let x = 0; x < config.width; x += 1) {
      const land = landAt(seed, x, y, config);
      cells.push({
        // Ownership is decided by the spawn draft once the whole map exists.
        owner: null,
        terrain: land ? terrainAt(seed, x, y, config) : "water",
        structure: null,
        structureLevel: 0,
        capitalOf: null,
        coastal: false,
        pressure: 0,
        pressureBy: null,
        pressureTracked: false,
        capturedAt: -99,
        structureHeritage: null,
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
    PLAYER_ORDER.map((id) => [id, makeFaction(id, seed)]),
  ) as Record<PlayerId, FactionState>;

  // Every player drafts a start from the finished map, then opens holding the
  // land around it. Terrain is generated first and independently, so the sites
  // are chosen from the world rather than the world bent around the sites.
  const sites = draftSpawnSites({ cells, config });
  claimInitialTerritory({ cells, config }, sites);
  for (const site of sites) {
    const faction = factions[site.player]!;
    faction.capitalIndex = site.index;
    cells[site.index]!.capitalOf = site.player;
    cells[site.index]!.owner = site.player;
    // The capital is a founded city, not a bare marker: it anchors the rail
    // network from the first tick, and losing it costs the realm everything --
    // see the capital-capture annexation in the campaign system.
    cells[site.index]!.structure = "city";
    cells[site.index]!.structureLevel = 1;
    // The founders' ways are in the stonework from the first day.
    cells[site.index]!.structureHeritage = faction.expressedElement;
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
    // Dozens of realms each open with a sliver of the land the old five did,
    // so starting population is capped by what the realm can actually sustain.
    faction.troops = Math.min(12_000, faction.troopCap);
  }

  const relations: Record<string, RelationState> = {};
  for (let first = 0; first < PLAYER_ORDER.length; first += 1) {
    for (let second = first + 1; second < PLAYER_ORDER.length; second += 1) {
      const a = PLAYER_ORDER[first]!;
      const b = PLAYER_ORDER[second]!;
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
    theaterMap: createTheaterMap(strategicMap.regions.length),
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
        text: `${worldName} wakes mostly unclaimed. ${PLAYER_ORDER.length} players across four founding families raise banners with 20K treasuries and no developed infrastructure.`,
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
        participants: PLAYER_ORDER.map(realmSubject),
        links: {},
        facts: {
          seed,
          landTiles,
          foundingRealms: PLAYER_ORDER.length,
        },
        summary: `${worldName} wakes mostly unclaimed as ${PLAYER_ORDER.length} realms of four founding families raise their first banners.`,
      },
    ],
    stories: [],
    storyCursor: 0,
    champion: null,
    dominantSince: null,
    config,
  };
}
