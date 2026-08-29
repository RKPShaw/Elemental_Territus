import { relationKey } from "./diplomacy";
import { baseMaskOf } from "./elements";
import { neighborIndices } from "./grid";
import { draftFoundingNames, foundingIdentity } from "./naming";
import { PLAYERS, PLAYER_ORDER, playerElement } from "./players";
import { SeededRandom, cellNoise, smoothCellNoise } from "./random";
import { createEconomyLedger } from "./economics";
import { createStrategicRegions } from "./regions";
import { createTheaterMap } from "./theater-map";
import { TERRAIN_RULES, calculateTroopCap, normalizedCellArea } from "./rules";
import { claimInitialTerritory, draftSpawnSites } from "./spawn";
import { createPowerState } from "./powers";
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
  /**
   * Lowered from 180 when war became funded and frontier-reluctant: a long
   * flat truce made every realm's pent-up desire fire on the first legal
   * diplomacy pass, so the whole world attacked on one tick. The opening
   * calm now comes from the incentives themselves — armies still settling
   * the frontier, mobilization chests still filling — which release realm by
   * realm instead of all at once.
   */
  minimumPeaceTicks: 64,
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

/**
 * Sea level in the elevation field. Everything below it is ocean; land terrain
 * is banded by height above it.
 */
const SEA_LEVEL = 0.5;

interface ContinentSeed {
  x: number;
  y: number;
  /** Radius in normalised (0..1, width-relative) units. */
  radius: number;
  /** How tall the landmass core rises above sea level. */
  lift: number;
}

/**
 * Where the continents sit. Positions and sizes are drawn from the world seed
 * rather than authored, so every world has its own arrangement of landmasses
 * instead of the same two ellipses -- but they are placed to keep apart, so
 * the ocean between them reads as real channels rather than accidents.
 */
function draftContinents(seed: number): ContinentSeed[] {
  const random = new SeededRandom((seed ^ 0x1f83d9ab) >>> 0 || 0x1f83d9ab);
  const count = random.int(4, 6);
  const seeds: ContinentSeed[] = [];
  for (let attempt = 0; attempt < 400 && seeds.length < count; attempt += 1) {
    const major = seeds.length < 2;
    const candidate: ContinentSeed = {
      x: 0.16 + random.next() * 0.68,
      y: 0.2 + random.next() * 0.6,
      radius: major ? 0.23 + random.next() * 0.08 : 0.14 + random.next() * 0.07,
      lift: 0.42 + random.next() * 0.24,
    };
    // Keep the cores apart by roughly the sum of their radii, so continents
    // stay distinct landmasses instead of merging into one supercontinent.
    const crowded = seeds.some((other) => {
      // The map is wider than it is tall; distances compare in the same
      // width-relative units the radii use.
      const distance = Math.hypot(candidate.x - other.x, (candidate.y - other.y) * 0.62);
      return distance < (candidate.radius + other.radius) * 0.82;
    });
    if (!crowded) seeds.push(candidate);
  }
  return seeds;
}

/**
 * The raw height of the world at a cell: continental masses with noise-warped
 * outlines, plus rolling detail that raises interior ranges and roughens the
 * coasts. Ocean sits below SEA_LEVEL, and rivers descend this same field, so
 * water always flows downhill to a coast that really is lower ground.
 */
function elevationAt(
  seed: number,
  x: number,
  y: number,
  config: SimulationConfig,
  continents: readonly ContinentSeed[],
): number {
  const nx = x / (config.width - 1);
  const ny = y / (config.height - 1);
  // Domain warp: coastlines follow bent space rather than clean radii, which
  // is what gives them peninsulas and bays instead of circular shores.
  const warpX = (smoothCellNoise(seed ^ 0x6a09e667, x, y, config.width / 10) - 0.5) * 0.16;
  const warpY = (smoothCellNoise(seed ^ 0xbb67ae85, x, y, config.width / 10) - 0.5) * 0.16;
  const wx = nx + warpX;
  const wy = ny + warpY;

  let mass = 0;
  for (const continent of continents) {
    const distance = Math.hypot(wx - continent.x, (wy - continent.y) * 0.62);
    const falloff = 1 - distance / continent.radius;
    if (falloff <= 0) continue;
    // Smooth dome per continent; overlapping shelves add rather than max, so
    // near-neighbours can fuse into one landmass with an isthmus.
    mass += continent.lift * falloff * falloff * (3 - 2 * falloff);
  }

  const detail =
    (smoothCellNoise(seed ^ 0x3c6ef372, x, y, config.width / 11) - 0.5) * 0.6 +
    (smoothCellNoise(seed ^ 0xa54ff53a, x, y, config.width / 27) - 0.5) * 0.28 +
    (smoothCellNoise(seed ^ 0x428a2f98, x, y, config.width / 60) - 0.5) * 0.12;

  // Open water all the way round, wide enough to read as ocean rather than as
  // a hairline. Scaled to the map so it survives a change of size.
  const margin = Math.max(3, Math.round(Math.min(config.width, config.height) * 0.045));
  const edge = Math.min(x, y, config.width - 1 - x, config.height - 1 - y);
  const edgePress = edge < margin * 2 ? (1 - edge / (margin * 2)) : 0;
  if (edge < margin) return 0;

  return Math.max(0, SEA_LEVEL - 0.13 + mass + detail * 0.3 - edgePress * 0.5);
}

function moistureAt(seed: number, x: number, y: number, config: SimulationConfig): number {
  return (
    smoothCellNoise(seed ^ 0x510e527f, x, y, config.width / 13) * 0.74 +
    smoothCellNoise(seed ^ 0x9b05688c, x, y, config.width / 46) * 0.26
  );
}

const RIVER_STEPS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

/**
 * Carves rivers into the elevation field, returning the set of cells that
 * become running water.
 *
 * Each river starts high in the interior and walks steepest-descent to the
 * sea, so it winds down valleys the way water actually does. Where the walk
 * bottoms out in a basin it spills over the lowest rim -- the carved course
 * doubles as the lake's outlet -- so every river reaches a coast rather than
 * dying in a puddle mid-continent.
 */
function carveRivers(
  seed: number,
  elevation: Float32Array,
  config: SimulationConfig,
): Set<number> {
  const { width, height } = config;
  const random = new SeededRandom((seed ^ 0x5be0cd19) >>> 0 || 0x5be0cd19);
  const rivers = new Set<number>();
  const targetCount = Math.max(5, Math.round(Math.min(width, height) / 11));
  const sources: number[] = [];
  const minSourceGap = Math.min(width, height) / 5;

  // Sources sit on genuinely high ground, spread apart so each range drains
  // its own watershed instead of one massif hosting every river.
  for (let attempt = 0; attempt < 900 && sources.length < targetCount; attempt += 1) {
    const x = random.int(0, width - 1);
    const y = random.int(0, height - 1);
    const index = y * width + x;
    if (elevation[index]! < SEA_LEVEL + 0.13) continue;
    const spaced = sources.every((other) => {
      const ox = other % width;
      const oy = (other - ox) / width;
      return Math.hypot(x - ox, y - oy) >= minSourceGap;
    });
    if (spaced) sources.push(index);
  }

  for (const source of sources) {
    const course: number[] = [];
    const visited = new Set<number>([source]);
    let current = source;
    const maxLength = width + height;
    while (course.length < maxLength) {
      course.push(current);
      if (elevation[current]! < SEA_LEVEL || rivers.has(current)) break;
      const cx = current % width;
      const cy = (current - cx) / width;
      let next = -1;
      let lowest = Number.POSITIVE_INFINITY;
      for (const [dx, dy] of RIVER_STEPS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (visited.has(neighbor)) continue;
        // A whisper of noise in the comparison keeps the course from running
        // dead straight down a smooth slope.
        const wobble = (cellNoise(seed ^ 0x2b7e1516, neighbor, course.length) - 0.5) * 0.004;
        const height_ = elevation[neighbor]! + wobble;
        if (height_ < lowest) {
          lowest = height_;
          next = neighbor;
        }
      }
      if (next < 0) break;
      // A diagonal step also carves the lower of the two cells it corners
      // past, so the channel is watertight: no pinhole crossings for armies,
      // and no banks left touching only corner-to-corner.
      const nx = next % width;
      const ny = (next - nx) / width;
      if (nx !== cx && ny !== cy) {
        const sideA = cy * width + nx;
        const sideB = ny * width + cx;
        course.push(elevation[sideA]! <= elevation[sideB]! ? sideA : sideB);
      }
      visited.add(next);
      current = next;
    }
    // A course that never made it off the highlands would read as a scratch,
    // not a river; only keep ones that reached water (sea or another river).
    const mouth = course[course.length - 1]!;
    if (elevation[mouth]! < SEA_LEVEL || rivers.has(mouth)) {
      for (const index of course) rivers.add(index);
    }
  }
  return rivers;
}

/**
 * Carves the minor rivers: streams that descend the same elevation field as
 * the great rivers but stay land. A stream is a drawn line and a border
 * (crossing it costs more; see STREAM_RULES), never a waterway — armies march
 * over it and settlers claim its banks, so the map gains natural frontiers
 * without gaining more water.
 *
 * Streams start lower and pack closer than rivers, and a course ends the
 * moment it reaches the sea, a river, or another stream — a drainage network
 * of lines feeding the real waterways.
 */
function carveStreams(
  seed: number,
  elevation: Float32Array,
  rivers: Set<number>,
  config: SimulationConfig,
): number[][] {
  const { width, height } = config;
  const random = new SeededRandom((seed ^ 0x7ea6ce13) >>> 0 || 0x7ea6ce13);
  const streamCells = new Set<number>();
  const courses: number[][] = [];
  const targetCount = Math.max(8, Math.round(Math.min(width, height) / 6));
  const sources: number[] = [];
  const minSourceGap = Math.min(width, height) / 9;

  for (let attempt = 0; attempt < 1_400 && sources.length < targetCount; attempt += 1) {
    const x = random.int(0, width - 1);
    const y = random.int(0, height - 1);
    const index = y * width + x;
    if (elevation[index]! < SEA_LEVEL + 0.07 || rivers.has(index)) continue;
    const spaced = sources.every((other) => {
      const ox = other % width;
      const oy = (other - ox) / width;
      return Math.hypot(x - ox, y - oy) >= minSourceGap;
    });
    if (spaced) sources.push(index);
  }

  for (const source of sources) {
    const course: number[] = [];
    const visited = new Set<number>([source]);
    let current = source;
    let reachedWater = false;
    const maxLength = Math.round((width + height) / 2);
    while (course.length < maxLength) {
      course.push(current);
      if (
        elevation[current]! < SEA_LEVEL ||
        rivers.has(current) ||
        (streamCells.has(current) && current !== source)
      ) {
        reachedWater = true;
        break;
      }
      const cx = current % width;
      const cy = (current - cx) / width;
      let next = -1;
      let lowest = Number.POSITIVE_INFINITY;
      for (const [dx, dy] of RIVER_STEPS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (visited.has(neighbor)) continue;
        const wobble = (cellNoise(seed ^ 0x452821e6, neighbor, course.length) - 0.5) * 0.006;
        const height_ = elevation[neighbor]! + wobble;
        if (height_ < lowest) {
          lowest = height_;
          next = neighbor;
        }
      }
      if (next < 0) break;
      visited.add(next);
      current = next;
    }
    // A creek that never joins the drainage would read as a scratch; a course
    // shorter than a few cells would read as a speck.
    if (!reachedWater || course.length < 6) continue;
    for (const index of course) streamCells.add(index);
    courses.push(course);
  }
  return courses;
}

interface GeneratedTerrain {
  terrain: TerrainId[];
  rivers: Set<number>;
  /** Minor-river courses, for Cell.stream flags and thin-line rendering. */
  streams: number[][];
}

/**
 * Land and terrain for the whole map in one pass: continents from the
 * elevation field, rivers carved down it, and biomes banded by height above
 * the sea with fertile floodplains along the riverbanks.
 */
function generateTerrain(seed: number, config: SimulationConfig): GeneratedTerrain {
  const { width, height } = config;
  const continents = draftContinents(seed);
  const elevation = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      elevation[y * width + x] = elevationAt(seed, x, y, config, continents);
    }
  }

  const rivers = carveRivers(seed, elevation, config);
  // Streams stay out of the floodplain banding deliberately: turning their
  // banks to farmland reshaped the terrain-cost field enough to push the
  // strategic partition past its area budget. Streams are borders, not
  // breadbaskets — the great rivers keep the rich valleys.
  const streams = carveStreams(seed, elevation, rivers, config);

  // Band terrain by where a cell sits in this world's own height distribution
  // rather than by absolute height: continents of different bulk then still
  // get mountain crowns, hill shoulders and lowland skirts in believable
  // proportion, whatever the seed drew.
  const landHeights: number[] = [];
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index]! >= SEA_LEVEL && !rivers.has(index)) landHeights.push(elevation[index]!);
  }
  landHeights.sort((a, b) => a - b);
  const quantile = (share: number) =>
    landHeights.length === 0
      ? Number.POSITIVE_INFINITY
      : landHeights[Math.min(landHeights.length - 1, Math.floor(share * landHeights.length))]!;
  const mountainLine = quantile(0.88);
  const hillLine = quantile(0.74);
  const valleyLine = quantile(0.55);

  const terrain: TerrainId[] = new Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (elevation[index]! < SEA_LEVEL || rivers.has(index)) {
        terrain[index] = "water";
        continue;
      }
      const height_ = elevation[index]!;
      const moisture = moistureAt(seed, x, y, config);
      if (height_ >= mountainLine) terrain[index] = "mountains";
      else if (height_ >= hillLine) terrain[index] = "hills";
      else if (height_ < valleyLine && nearRiver(rivers, index, width, height)) {
        // Floodplains: the low country along a river is the richest land in
        // the world, which makes the rivers worth fighting over as well as
        // hard to fight across.
        terrain[index] = "farmland";
      } else if (moisture > 0.64) terrain[index] = "forest";
      else if (height_ < valleyLine && moisture > 0.42) terrain[index] = "farmland";
      else terrain[index] = "plains";
    }
  }
  sinkIslets(terrain, width, height);
  return { terrain, rivers, streams };
}

/**
 * Sinks land fragments too small to matter back into the sea. Noise and river
 * carving both shed one-to-few-cell islets, and land that small can neither
 * seat a strategic region nor host play -- it reads as speckle, not geography.
 */
function sinkIslets(terrain: TerrainId[], width: number, height: number): void {
  const seen = new Uint8Array(terrain.length);
  let landTotal = 0;
  for (const id of terrain) if (id !== "water") landTotal += 1;
  const minimumSize = Math.max(24, Math.round(landTotal * 0.012));
  for (let start = 0; start < terrain.length; start += 1) {
    if (seen[start] || terrain[start] === "water") continue;
    const component = [start];
    seen[start] = 1;
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      const index = component[cursor]!;
      const x = index % width;
      const y = (index - x) / width;
      for (const [dx, dy] of RIVER_STEPS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (!seen[neighbor] && terrain[neighbor] !== "water") {
          seen[neighbor] = 1;
          component.push(neighbor);
        }
      }
    }
    if (component.length < minimumSize) {
      for (const index of component) terrain[index] = "water";
    }
  }
}

function nearRiver(rivers: Set<number>, index: number, width: number, height: number): boolean {
  const x = index % width;
  const y = (index - x) / width;
  for (const [dx, dy] of RIVER_STEPS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    if (rivers.has(ny * width + nx)) return true;
  }
  return false;
}

function emptyStructures(): StructureCounts {
  return { city: 0, fort: 0, factory: 0, harbor: 0, plant: 0, skyport: 0 };
}

function makeFaction(id: PlayerId, seed: number, foundingName: string): FactionState {
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
    power: createPowerState(),
    absorbedElements: [element],
    elementCounts: { [element]: 1 } as Record<ElementId, number>,
    lastConqueror: null,
    identity: foundingIdentity(foundingName, element),
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
  const { terrain, streams } = generateTerrain(seed, config);
  // Stream cells that survived terrain banding as land wear the flag; courses
  // are kept whole for rendering even where a mouth touches water.
  const streamCells = new Set<number>();
  for (const course of streams) {
    for (const index of course) {
      if (terrain[index] !== "water") streamCells.add(index);
    }
  }
  const cells: Cell[] = [];
  for (let y = 0; y < config.height; y += 1) {
    for (let x = 0; x < config.width; x += 1) {
      const index = y * config.width + x;
      cells.push({
        // Ownership is decided by the spawn draft once the whole map exists.
        owner: null,
        terrain: terrain[index]!,
        structure: null,
        structureLevel: 0,
        capitalOf: null,
        coastal: false,
        stream: streamCells.has(index),
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

  // Founding names are plain and generic — villages, not elements. The
  // naming system upgrades them as conquest, ascension and union earn it.
  const foundingNames = draftFoundingNames(seed);
  const factions = Object.fromEntries(
    PLAYER_ORDER.map((id) => [id, makeFaction(id, seed, foundingNames[id]!)]),
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
    streams,
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
        // The world is still being assembled here, so the founding subjects
        // are built from the identities directly rather than through state.
        participants: PLAYER_ORDER.map((id) => ({
          type: "realm" as const,
          id,
          label: factions[id].identity.title,
          realmId: id,
        })),
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
