import type {
  LandTerrainId,
  StructureRule,
  StructureType,
  TerrainId,
  TerrainRule,
} from "./types";

export const REFERENCE_WORLD_CELLS = 84 * 52;

export function normalizedCellArea(config: { width: number; height: number }): number {
  return REFERENCE_WORLD_CELLS / (config.width * config.height);
}

export function normalizedCellLength(config: { width: number; height: number }): number {
  return Math.sqrt(normalizedCellArea(config));
}

export const TERRAIN_RULES: Record<TerrainId, TerrainRule> = {
  water: {
    id: "water",
    name: "Open water",
    shortName: "Water",
    fill: "#77a9b5",
    defenseCost: 1,
    sustain: 0,
    goldYield: 0,
  },
  farmland: {
    id: "farmland",
    name: "Rich farmland",
    shortName: "Farms",
    fill: "#d8cf86",
    defenseCost: 0.78,
    sustain: 1.42,
    goldYield: 1.45,
  },
  plains: {
    id: "plains",
    name: "Open plains",
    shortName: "Plains",
    fill: "#b9cb86",
    defenseCost: 0.92,
    sustain: 1.13,
    goldYield: 1.08,
  },
  forest: {
    id: "forest",
    name: "Dense forest",
    shortName: "Forest",
    fill: "#799b6c",
    defenseCost: 1.2,
    sustain: 0.9,
    goldYield: 0.86,
  },
  hills: {
    id: "hills",
    name: "Broken hills",
    shortName: "Hills",
    fill: "#ad9a73",
    defenseCost: 1.38,
    sustain: 0.7,
    goldYield: 0.72,
  },
  mountains: {
    id: "mountains",
    name: "High mountains",
    shortName: "Mountains",
    fill: "#7e8581",
    defenseCost: 1.76,
    sustain: 0.38,
    goldYield: 0.52,
  },
};

export const LAND_TERRAINS: readonly LandTerrainId[] = [
  "farmland",
  "plains",
  "forest",
  "hills",
  "mountains",
] as const;

export const STRUCTURE_RULES: Record<StructureType, StructureRule> = {
  city: {
    id: "city",
    name: "City",
    glyph: "●",
    cost: 25_000,
    description: "Develops 10K troop capacity. Cities may stack; each added level gives a station +50% value.",
  },
  fort: {
    id: "fort",
    name: "Fort",
    glyph: "▣",
    cost: 135_000,
    description: "Doubles invasion cost in its protected area.",
  },
  factory: {
    id: "factory",
    name: "Factory",
    glyph: "▥",
    cost: 25_000,
    description: "Shares the 25K / 50K / 100K / 250K trade-building ladder and dispatches one train at a time.",
  },
  harbor: {
    id: "harbor",
    name: "Harbor",
    glyph: "⚓",
    cost: 25_000,
    description: "Shares the trade-building ladder and earns 4K for every second of its completed water voyage.",
  },
};

export const WARSHIP_COST = 165_000;

export const FORT_RADIUS = 4;
export const STRUCTURE_MIN_SPACING = 2.2;

export const STRUCTURE_COST_LADDER = [25_000, 50_000, 100_000] as const;

/** Cities have one ladder; factories and harbors advance a shared trade ladder. */
export function nextStructureCost(
  structure: StructureType,
  counts: { city: number; fort: number; factory: number; harbor: number },
): number {
  if (structure === "fort") return STRUCTURE_RULES.fort.cost;
  const count = structure === "city" ? counts.city : counts.factory + counts.harbor;
  return STRUCTURE_COST_LADDER[count] ?? 250_000;
}

export function cityStationMultiplier(level: number): number {
  return 1 + Math.max(0, level - 1) * 0.5;
}

/**
 * The simulation's balance surface lives here instead of being scattered across
 * systems. That keeps the deterministic rules easy to tune, test or replace
 * without coupling them to rendering or AI policy.
 */
export const DIPLOMACY_RULES = {
  minimumWarTicks: 176,
  peaceCooldownTicks: 120,
  ordinaryExhaustionForPeace: 1.55,
  decisiveExhaustionForPeace: 1.86,
  stalemateTicks: 300,
  stalematePeaceChance: 0.12,
  vulnerableRealmShare: 0.12,
  hegemonShare: 0.48,
  truceDurationTicks: 600,
  truceOfferDurationTicks: 80,
  traitorDurationTicks: 30,
  traitorAttackMultiplier: 1.35,
  maximumTrucesPerRealm: 2,
} as const;

export const CAMPAIGN_RULES = {
  maximumStrengthRatio: 2,
  /**
   * Troops that must press a tile for one tick to take it on open ground.
   *
   * The whole fight is this one number. A front's force is spread over the
   * tiles it presses, and each tile falls at the rate that force arrives,
   * divided by what the ground costs. Nothing about the defender's army enters
   * it -- taking ground is not killing everyone standing on it, and a realm
   * that lets an army walk in loses the ground at the speed the army walks.
   *
   * Defenders resist in two ways instead. The ground itself resists, through
   * conquestCostAt: hills, forts and cities all raise the price. And a realm
   * may throw troops directly at an invasion to blunt it, which cancels
   * attackers one for one and is the only way an army defends -- see
   * applyDefensiveStunt. That trade is expensive in people, so it is worth
   * making to save a city and not worth making to save a field.
   *
   * Expressed as a cost rather than as a ratio because a cost is scale-free.
   * Ten times the army takes ground ten times as fast, whether the world holds
   * five realms or a hundred, and a hundred-realm world becomes a five-realm
   * world if anybody wins.
   */
  troopsToTakeATile: 9_000,
  /** A contested beach costs more than open ground. */
  landingCostMultiplier: 1.22,
  navalLandingPressurePerTick: 0.064,
  navalTransportVelocity: 0.75,
  maximumDurationTicks: 480,
  defenderStuntRate: 0.012,
  topologyRefreshTicks: 12,
  wildernessTopologyRefreshTicks: 6,
  allocationRefreshTicks: 4,
  maximumActiveTheaters: 3,
  minimumTheaterShare: 0.05,
  maximumTheaterShare: 0.55,
  allocationSmoothing: 0.2,
  theaterValueAlpha: 0.22,
  theaterTrendBeta: 0.045,
  theaterHistoryLength: 12,
} as const;

export const STRATEGIC_REGION_RULES = {
  targetCellsPerRegion: 192,
  minimumRegionCount: 24,
  repartitionTicks: 12,
  terrainSmoothingPasses: 2,
  infrastructureSmoothingPasses: 6,
  productivityValueWeight: 0.48,
  infrastructureValueWeight: 0.52,
  seedHeatBias: 0.18,
  criticalValuePull: 4.6,
  /**
   * Passes of area relaxation before the first tick.
   *
   * Two forces pull against each other here. Too few and the opening partition
   * is less even than the one a running world settles into -- with the
   * continents pulled inside the frame there is less land to divide, and at
   * three a region opened a hair under the area budget that the same world
   * satisfied comfortably a hundred ticks later. Too many and the partition
   * starts where it would have ended, so boundaries no longer visibly migrate
   * as terrain develops, which is half of what makes the map feel alive.
   * Four clears both: the smallest region opens comfortably inside its budget
   * and the map still redraws itself as the world grows.
   */
  initialRelaxationPasses: 4,
  initialRelaxationGain: 0.7,
  filterAlpha: 0.11,
  filterBeta: 0.022,
  velocityDamping: 0.72,
  maximumAnchorStep: 0.62,
  areaBalanceStrength: 60,
  terrainTransitionCost: 0.16,
  reliefGradientCost: 3.1,
  infrastructureGradientCost: 3.8,
  productivityGradientCost: 1.5,
  reliefBasinAffinity: 0.34,
  infrastructureBasinAffinity: 0.42,
  heatTravelAdvantage: 0.5,
  boundaryInertia: 0.2,
  objectiveLookaheadCells: 14,
  maximumObjectives: 8,
} as const;

/**
 * Settlement is always cheaper than invasion. Even the hardest wilderness
 * mountain (2.8) costs less than the easiest occupied farmland (4.25).
 */
export const WILDERNESS_TERRAIN_COST: Record<LandTerrainId, number> = {
  farmland: 0.75,
  plains: 1,
  forest: 1.4,
  hills: 1.9,
  mountains: 2.8,
};

export const ENEMY_TERRAIN_COST: Record<LandTerrainId, number> = {
  farmland: 4.25,
  plains: 4.5,
  forest: 5.15,
  hills: 5.65,
  mountains: 6.3,
};

export const ECONOMY_RULES = {
  landIncomeScale: 2.4,
  cityIncome: 500,
  maximumTreasury: 100_000_000,
} as const;

export const TRADE_RULES = {
  trainRadius: 5,
  railSnapDistance: 1.25,
  railExistingTrackCost: 0.08,
  /**
   * What it costs a line to run through a station rather than around it.
   * Well below open ground, so rails thread the towns between their ends --
   * which is what makes a network look like it was planned around its cities.
   */
  railStationCost: 0.2,
  railMaximumNewLinksPerRebuild: 10,
  networkRebuildTicks: 120,
  trainSpawnIntervalTicks: 8,
  shipSpawnIntervalTicks: 12,
  vehicleTurnaroundTicks: 30,
  /**
   * Vehicles a single site may have out at once.
   *
   * A harbour used to be allowed exactly one boat, not by any rule but because
   * the dispatch record held a single slot -- so the world's seventeen harbours
   * could never float more than seventeen ships however high the fleet cap was
   * set. A port is a place many ships sail from, and a bigger one sails more.
   *
   * Factories stay at one train each: rail dispatch is the expensive half of
   * trade, and there is no evidence yet that it is being starved the way sea
   * trade was.
   */
  shipsPerHarbor: 3,
  shipsPerHarborLevel: 1,
  trainsPerFactory: 1,
  /**
   * Ticks a site waits between launches.
   *
   * Without it a harbour with room for four would empty its berths on four
   * consecutive ticks and then sit idle, and every harbour would do it in
   * lockstep. Sites are also given a starting offset from their own position on
   * the map, so trade leaves port in a steady trickle rather than in waves.
   */
  launchIntervalTicks: 7,
  trainLimit: 300,
  shipLimit: 1_000,
  trainVelocity: 0.12,
  shipVelocity: 0.38,
  trainStopDwellTicks: 2,
  domesticTrainStopPayout: 50_000,
  foreignTrainStopPayout: 100_000,
  shipPayoutPerTravelTick: 4_000,
  foreignHostShare: 0.18,
  alliedHostShare: 0.35,
} as const;

export const TROOP_CAP_RULES = {
  baseTroops: 25_000,
  minimumTroops: 35_000,
  troopsPerSustain: 560,
  troopsPerCity: 10_000,
} as const;

/**
 * Population is the strategic economy. Only people at home reproduce; anyone
 * committed to a campaign still consumes capacity but contributes no growth.
 * The curve deliberately rewards a healthy, uncrowded realm near 65% of cap.
 */
export const POPULATION_RULES = {
  lowGrowthThreshold: 0.2,
  peakGrowthRatio: 0.65,
  highGrowthThreshold: 0.82,
  peakGrowthPerTick: 0.018,
  minimumExpansionRatio: 0.2,
  matureExpansionReserveRatio: 0.5,
} as const;

/**
 * Where players begin.
 *
 * Starts are drafted one at a time rather than placed at fixed points, so these
 * decide what "a good site" means: how far apart rivals must open, how much
 * land each starts holding, and how the shared strategic value map trades off
 * against a site suiting the player's element.
 */
export const SPAWN_RULES = {
  /** World units required between any two starting capitals. */
  minimumSeparation: 5.2,
  /** Radius in world units of the land a player opens with. */
  initialRegionRadius: 1.9,
  /** Weight of the shared strategic value field when scoring a site. */
  valueWeight: 1,
  /** Weight of how well nearby terrain suits the player's element. */
  affinityWeight: 0.85,
  /** Radius in cells over which elemental terrain affinity is sampled. */
  affinityRadius: 3,
  /**
   * Separation shrinks by this factor whenever no site qualifies, so a crowded
   * or fragmented world still seats everyone instead of failing to place them.
   */
  separationRelaxation: 0.78,
} as const;

export const THEATER_MAP_RULES = {
  /**
   * Correction toward what was just seen, and how fast the trend follows it.
   * Shared shape with the theater value filter, so a belief behaves the same
   * whether it is about a region or a front.
   */
  valueAlpha: 0.45,
  trendBeta: 0.12,
  /**
   * Ticks between one player's own observations. Every player re-observes once
   * per interval, spread across the ticks in it, so cost per tick is flat in
   * roster size.
   *
   * The value is a starting point, not a finding. It wants measuring against
   * real games: long enough that acting on stale ground reads as being
   * out-manoeuvred, short enough that nobody looks merely stupid.
   */
  observationInterval: 80,
} as const;

/**
 * How much a settler's preference for ground can speed or slow taking it.
 * The floor keeps unattractive ground merely slow rather than never taken, so
 * a realm hemmed in by mountains still expands instead of stalling.
 */
export const SETTLE_PREFERENCE_FLOOR = 0.55;
export const SETTLE_PREFERENCE_RANGE = 0.9;

export const CLAIM_RULES = {
  initialRegionRadius: 2.8,
  pressurePerTick: 8,
  populationCostPerCell: 100,
  minimumHomePopulation: 8_000,
  minimumCampaignCommitment: 2_000,
  neglectFullEffectTicks: 400,
  completionUrgencyPower: 3,
} as const;

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A smooth, skewed fertility curve with an explicit 65% optimum. It avoids a
 * zero-population deadlock while making both depleted and crowded realms grow
 * substantially slower than a realm that preserves its demographic balance.
 */
export function populationGrowthEfficiency(populationRatio: number): number {
  const ratio = clamp(populationRatio, 0, 1);
  const { lowGrowthThreshold, peakGrowthRatio, highGrowthThreshold } = POPULATION_RULES;

  if (ratio <= lowGrowthThreshold) {
    return 0.06 + 0.32 * smoothstep(ratio / lowGrowthThreshold);
  }
  if (ratio <= peakGrowthRatio) {
    return 0.38 + 0.62 * smoothstep(
      (ratio - lowGrowthThreshold) / (peakGrowthRatio - lowGrowthThreshold),
    );
  }
  if (ratio <= highGrowthThreshold) {
    return 1 - 0.46 * smoothstep(
      (ratio - peakGrowthRatio) / (highGrowthThreshold - peakGrowthRatio),
    );
  }
  return 0.54 * (1 - smoothstep(
    (ratio - highGrowthThreshold) / (1 - highGrowthThreshold),
  ));
}

export function compactNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(magnitude >= 10_000_000 ? 0 : 2).replace(/\.00$/, "")}M`;
  }
  if (magnitude >= 1_000) {
    return `${(value / 1_000).toFixed(magnitude >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return Math.round(value).toLocaleString("en-US");
}

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function calculateTroopCap(
  sustainableLand: number,
  cityCount: number,
  maximumTroops: number,
): number {
  return clamp(
    TROOP_CAP_RULES.baseTroops +
      sustainableLand * TROOP_CAP_RULES.troopsPerSustain +
      cityCount * TROOP_CAP_RULES.troopsPerCity,
    TROOP_CAP_RULES.minimumTroops,
    maximumTroops,
  );
}
