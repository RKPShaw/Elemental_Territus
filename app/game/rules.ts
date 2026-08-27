import type {
  ElementTier,
  LandTerrainId,
  StructureCounts,
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
  plant: {
    id: "plant",
    name: "Power plant",
    glyph: "⌁",
    cost: 25_000,
    description: "Energy realms only. Strings straight conduits to nearby stations and sends paying pulses down them.",
  },
  skyport: {
    id: "skyport",
    name: "Skyport",
    glyph: "✈",
    cost: 25_000,
    description: "Airborne realms only. Flies freight in a straight line to any other skyport in the world.",
  },
};

export const WARSHIP_COST = 165_000;

export const FORT_RADIUS = 4;
export const STRUCTURE_MIN_SPACING = 2.2;

export const STRUCTURE_COST_LADDER = [25_000, 50_000, 100_000] as const;

/** Cities have one ladder; every trade building advances one shared ladder. */
export function nextStructureCost(
  structure: StructureType,
  counts: StructureCounts,
): number {
  if (structure === "fort") return STRUCTURE_RULES.fort.cost;
  const count = structure === "city"
    ? counts.city
    : counts.factory + counts.harbor + counts.plant + counts.skyport;
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
   * Four passes cleared both for the fifty-capital draft. The four-family
   * roster's forty-eight capitals seed the heat differently and one seed
   * opened under budget again — and further passes plateaued where it stood,
   * so the correction is per-pass gain rather than more passes. The map still
   * visibly redraws itself as the world grows, which the geography test
   * continues to assert.
   */
  initialRelaxationPasses: 4,
  initialRelaxationGain: 0.85,
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

/**
 * The elemental balance surface.
 *
 * matchupEdge anchors elemental combat: a founding counter advances a front
 * 1.12× faster with the edge and 0.88× slower against it (1 ± matchupEdge —
 * the sums are float-exact, which the element tests pin), and the composed
 * 25×25 table grades every other pair from it. Combat reads that table live
 * through each realm's expressed element; ascension arithmetic and the
 * trade-form rewards below are live too. Only the infrastructure-memory
 * constants still wait on their phase. An elemental edge should matter
 * without ever deciding a battle by itself, so every multiplier here lives
 * inside the floor/ceiling band.
 */
export const ELEMENT_RULES = {
  /** Full counter advantage between two founding elements, as a share of 1. */
  matchupEdge: 0.12,
  /**
   * How much of the composed edge each tier expresses. Higher tiers swing
   * harder in both directions — a higher ceiling, never a higher floor.
   */
  tierAmplitude: { 1: 1, 2: 1.15, 3: 1.25 } satisfies Record<ElementTier, number>,
  /** Hard band around any composed multiplier. */
  matchupFloor: 0.85,
  matchupCeiling: 1.15,
  /**
   * How much of an edge a realm's absorbed history can grade away when it
   * covers the founding bases of what it faces. At most a third: history
   * softens a matchup, it never erases one.
   */
  absorbedBaseRelief: 0.33,
  /**
   * Optional counter strength across the cycle's neutral pairs (ember–gale,
   * tide–stone), as a share of a full counter. Zero is document-faithful;
   * raise it if sweeps show mid-game combat going elementally flat.
   */
  neutralPairEdge: 0,
  /** Absorbed base depth required in each constituent to form a tier 2. */
  tier2BaseDepth: 2,
  /** Total realms absorbed before any tier 3 becomes formable. */
  tier3MinimumRealms: 6,
  /**
   * War desire added for a target whose absorption fully advances the next
   * tier, before the realm's own ascension weight scales it. Comparable to
   * the containment and finishing bonuses combined — a strong pull exactly
   * when a conquest completes a history, faint when it merely helps.
   */
  ascensionWarDesire: 0.45,
  /** The matching bonus when choosing which existing war to press. */
  ascensionTargetPreference: 0.6,
  /**
   * The trade-form reward, one rate on every carrier and rewards only. Each
   * form owns a distinct vehicle network — land the road-and-rail convoys,
   * waterway the ships, energy the conduit pulses, airborne the skyport
   * flyers — and a realm whose expressed element trades by a form earns the
   * bonus on that carrier's income. Land realms also host foreign convoy
   * stops at the same bonus: their stations are the carrier's other half.
   */
  tradeFormIncomeBonus: 0.15,
  /**
   * Foreign host shares when the trading realms' expressed elements share
   * trade forms, applied on every carrier that pays a host on arrival.
   * Resonance pays a host more than a stranger's 0.18 but allied standing
   * still pays best — the diplomatic bond outbids the elemental one, and a
   * share never grades down: the best applicable rate wins.
   */
  resonantHostShareOne: 0.24,
  resonantHostShareTwo: 0.3,
  /**
   * Construction affinity: how strongly a realm reaches for the carrier of a
   * trade form it holds, multiplying the build-priority shortfalls its
   * strategy quotas produce. The city factor sits below 1 because a land
   * realm's carrier is the road-and-rail network around its stations: it
   * lets the factories that lay track jump the queue, it does not shrink
   * the city program. Plants and skyports exist only for realms holding
   * their form, so their weights double as the gate — a zero weight is a
   * structure never reached for.
   */
  buildAffinity: { city: 0.8, harbor: 1.4, plant: 1.2, skyport: 1.3 },
  /**
   * Harbor share of a realm's desired trade buildings, and the running cap
   * on harbors as a fraction of trade buildings actually standing. Waterway
   * realms reach for half again as many harbors; everyone else keeps the
   * classic minority share.
   */
  harborTradeShare: 0.22,
  harborTradeCap: 0.25,
  waterwayHarborTradeShare: 0.34,
  waterwayHarborTradeCap: 0.4,
  /**
   * Factories a realm must run before it reaches for a harbor. Waterway
   * realms open their ports a factory earlier — the coast is their
   * identity, and waiting for a full land program kept it theoretical.
   */
  harborFactoryPrerequisite: 3,
  waterwayHarborFactoryPrerequisite: 2,
  /**
   * How many plants an energy realm wants, as a share of its desired trade
   * program, and the hard cap on them; skyports scale with the city count
   * instead, with a floor of two because one skyport flies nowhere.
   */
  plantTradeShare: 0.3,
  plantCap: 12,
  skyportCityDivisor: 6,
  skyportFloor: 2,
  skyportCap: 6,
  /** Captured-structure efficiency when only absorbed history covers its form. */
  legacyEfficiency: 0.9,
  /** Captured-structure efficiency when nothing in the realm's history does. */
  incompatibleEfficiency: 0.78,
  /** Extra value a form-matching conqueror pulls from freshly taken works. */
  resonantCaptureBonus: 0.2,
  /** How long after capture the resonant window stays open. */
  resonantWindowTicks: 600,
} as const;

/**
 * The strategic-priority surface.
 *
 * Every realm carries normalized weights over the strategic domains, seeded
 * by its element and bent by situation. AI systems consume them only as
 * multipliers inside the factor band, so a priority can never gate a
 * behavior — a pacifist still defends itself, a warmonger still trades. The
 * band is centred on 1: a realm weighting a domain at exactly the uniform
 * share behaves as if the system did not exist.
 */
export const STRATEGY_RULES = {
  /** Bounds on any weight-derived multiplier. */
  factorFloor: 0.6,
  factorCeiling: 1.6,
  /** How far construction quotas may drift, as a share of the factor's drift. */
  quotaDamping: 0.5,
  /** Per-domain personality noise, so siblings of one family still differ. */
  noiseAmplitude: 0.05,
  /** Weight added to defense while campaigns press into the realm. */
  threatDefenseSurge: 0.14,
  /** Weight added to conquest while the realm has wars of its own. */
  warConquestSurge: 0.08,
  /** Weight added to diplomacy per point of war weariness. */
  wearinessDiplomacySurge: 0.2,
  /** Weight added to diplomacy while any rival holds this much of the land. */
  hegemonDiplomacySurge: 0.12,
  hegemonShareThreshold: 0.3,
  /** Weight added to economy while the treasury outruns the works. */
  richEconomySurge: 0.1,
  richTreasuryFloor: 2_000_000,
  /** Weight added to trade while the realm is entirely at peace. */
  peacefulTradeSurge: 0.08,
} as const;

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
  trainSpawnIntervalTicks: 24,
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
  pulsesPerPlant: 2,
  flyersPerSkyport: 2,
  /**
   * Ticks a site waits between launches.
   *
   * Without it a harbour with room for four would empty its berths on four
   * consecutive ticks and then sit idle, and every harbour would do it in
   * lockstep. Sites are also given a starting offset from their own position on
   * the map, so trade leaves port in a steady trickle rather than in waves.
   */
  launchIntervalTicks: 7,
  trainLimit: 75,
  shipLimit: 1_000,
  pulseLimit: 150,
  flyerLimit: 150,
  trainVelocity: 0.12,
  shipVelocity: 0.38,
  /** Energy moves fast; a pulse spends little time on the wire. */
  pulseVelocity: 0.85,
  flyerVelocity: 0.5,
  trainStopDwellTicks: 2,
  domesticTrainStopPayout: 50_000,
  foreignTrainStopPayout: 100_000,
  shipPayoutPerTravelTick: 4_000,
  /**
   * The energy carrier. A power plant strings straight conduits to the
   * nearest few stations within reach, and each delivered pulse pays a flat
   * value — energy trade is frequency, not distance.
   */
  conduitRadius: 5.5,
  conduitLinksPerPlant: 3,
  energyDeliveryPayout: 45_000,
  /**
   * The airborne carrier. Skyports fly straight to any other skyport, so
   * the payout is bought with distance like a voyage. Air's premium is
   * reach, not rate: it pays slightly under sea freight per travel tick —
   * every flight the whole world over is a straight line — because the
   * first sweep priced it above and gale realms took nearly half of all
   * wins on flight income alone. A hop shorter than the minimum is not
   * worth wings.
   */
  airPayoutPerTravelTick: 3_600,
  minimumFlightDistance: 4,
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
