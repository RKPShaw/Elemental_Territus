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
    cost: 18_000,
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
    cost: 18_000,
    description: "Shares the 18K / 40K / 90K / 180K trade-building ladder and dispatches one train at a time.",
  },
  harbor: {
    id: "harbor",
    name: "Harbor",
    glyph: "⚓",
    cost: 18_000,
    description: "Shares the trade-building ladder and earns 35 gold for every second of its completed water voyage.",
  },
  plant: {
    id: "plant",
    name: "Power plant",
    glyph: "⌁",
    cost: 18_000,
    description: "Energy realms only. Strings straight conduits to nearby stations and sends paying pulses down them.",
  },
  skyport: {
    id: "skyport",
    name: "Skyport",
    glyph: "✈",
    cost: 18_000,
    description: "Airborne realms only. Flies freight in a straight line to any other skyport within its flight radius.",
  },
};

export const WARSHIP_COST = 165_000;

export const FORT_RADIUS = 4;
/**
 * World units between any two structures.
 *
 * Divided by six alongside every trade radius. The two numbers are one
 * setting, not two: a trade radius is only meaningful against the closest a
 * neighbouring station may stand, and shrinking reach without shrinking
 * spacing would have left every carrier reaching for stations that could
 * never be built inside it — no rail seed link, no conduit, no plant site.
 * Scaled together, the trade geography is simply six times tighter: networks
 * still form, they just form locally, out of short hops between close
 * neighbours instead of long lines across a province.
 *
 * Packing structures this close does not make realms build more of them.
 * Construction is gold-bound, not space-bound, once income is cut twentyfold
 * below — the ladder rung a court is saving for arrives long before it runs
 * out of ground to put the building on.
 */
export const STRUCTURE_MIN_SPACING = 0.37;

/**
 * The opening economy is deliberately slow, and this ladder is where the
 * pace lives. Realms open with a token treasury (see makeFaction), so the
 * first rung is saved for out of tax. That saving now takes an age rather
 * than a season: ECONOMY_RULES cut land and capital income twentyfold, so an
 * opening realm banks a couple of gold a tick and reaches its first rung
 * some two thousand ticks in — which also reverses the order the milestone
 * used to arrive in. The first factory used to land as the frontier closed;
 * now the frontier closes first and the realm is still saving. The rung is
 * priced against the 20K mobilization floor on purpose: one savings pot,
 * three critical ways to spend it. A court that banks for its first factory cannot also
 * fund a war chest, and the rival that bought a city instead holds +10K
 * troop cap when the border turns hostile. The founding capital does not
 * count as a purchase (see nextStructureCost), so the first built city and
 * the first factory cost the same and the choice is a real either/or.
 */
export const STRUCTURE_COST_LADDER = [18_000, 40_000, 90_000] as const;

/** Cities have one ladder; every trade building advances one shared ladder. */
export function nextStructureCost(
  structure: StructureType,
  counts: StructureCounts,
): number {
  if (structure === "fort") return STRUCTURE_RULES.fort.cost;
  // The founding capital is an inheritance, not a purchase: it never climbs
  // the ladder, so the first *built* city costs the same first rung as the
  // first factory and the economy-or-cities decision starts symmetric.
  const count = structure === "city"
    ? Math.max(0, counts.city - 1)
    : counts.factory + counts.harbor + counts.plant + counts.skyport;
  return STRUCTURE_COST_LADDER[count] ?? 180_000;
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
  /**
   * Major diplomatic acts a court may take in one diplomacy term: war
   * declarations, truce offers and acceptances. There is deliberately no cap
   * on how many wars a realm may *hold* — a coalition may bury one target,
   * and a sprawling empire may burn on every border — the limit is only on
   * how much a court can *do* in a single sitting, so no realm performs an
   * unbounded burst of actions in one term.
   */
  courtActionsPerTerm: 2,
  /**
   * Gold a declaration of war spends per soldier on raising and provisioning
   * the host, with a floor for the smallest realms. War is funded, not free:
   * the treasury pays the full chest at the declaration, and war desire
   * scales with the realm's ability to pay (see warDesire). The cost rides
   * the army rather than a flat number so it stays meaningful at every era —
   * and because treasuries grow at genuinely different rates (terrain
   * yields, trade income, construction programs all compete for the same
   * gold) realms reach funding at different times, which is what staggers
   * the opening wars without any forced scheduling. Spending the chest also
   * delays the same realm's next declaration until it has saved up again.
   */
  mobilizationGoldPerTroop: 1.6,
  mobilizationFloor: 20_000,
  /**
   * How strongly open wilderness frontier suppresses war desire. Settlement
   * is always cheaper than invasion (see WILDERNESS_TERRAIN_COST), so a
   * realm with free land left to take prefers taking it; the pull fades as
   * its frontier closes, and frontiers close at geography-dependent times.
   */
  openFrontierWarReluctance: 0.7,
  /**
   * Extra war desire against a target already fighting someone else while its
   * host runs thin. Opportunism is the intended character: a weakened realm
   * should fear every border it has, not just the one already burning.
   */
  pileOnWarDesire: 0.34,
} as const;

/** The war chest a declaration must fund: raising this realm's host. */
export function mobilizationCostFor(troops: number): number {
  return Math.max(
    DIPLOMACY_RULES.mobilizationFloor,
    troops * DIPLOMACY_RULES.mobilizationGoldPerTroop,
  );
}

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
  /**
   * Slowed fourfold from 0.75: a loaded transport crawls, so a crossing --
   * ocean or river alike -- is a real commitment that leaves the expedition
   * exposed to interception for the whole voyage rather than a quick hop.
   */
  navalTransportVelocity: 0.1875,
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
   * The continents-and-rivers map retuned this pair: awkward coastlines and
   * river valleys need eight full-gain passes before every region opens
   * inside the area budget. That starts the partition close to settled, so
   * the visible migration the geography test asserts now comes from the
   * runtime anchor filter instead — filterAlpha and filterBeta were raised in
   * the same change to keep boundaries chasing live value at the pace the
   * old map got for free from its rougher opening.
   */
  initialRelaxationPasses: 8,
  initialRelaxationGain: 1,
  filterAlpha: 0.35,
  filterBeta: 0.06,
  velocityDamping: 0.72,
  maximumAnchorStep: 0.62,
  // Raised from 60 when the continents-and-rivers map landed: land now splits
  // across more separate landmasses, and the partition needs a stronger area
  // pull to keep every region inside the common budget across all of them.
  areaBalanceStrength: 150,
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
 * Streams are the minor rivers: lines of running water too small to be a
 * terrain of their own. A stream cell stays ordinary land for settlers —
 * they ford it and claim its banks — but to an army at war it counts as
 * ocean: the frontier index refuses any conquest step that enters or leaves
 * a stream cell, so a border resting on a river can only be forced by a
 * naval campaign's transport ships (streams are navigable water to ships;
 * see water-navigation). The enemy multiplier below now prices the one way
 * enemy stream ground still falls short of annexation: a naval landing on
 * the watercourse itself.
 */
export const STREAM_RULES = {
  /** Conquest-cost multiplier for a naval landing on enemy stream ground. */
  enemyCrossingCost: 1.5,
  /** Settlement-cost multiplier for wilderness on a stream bank. */
  wildernessCrossingCost: 1.2,
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
 * through each realm's expressed element; ascension arithmetic, the
 * trade-form rewards and the infrastructure-memory constants below are all
 * live. An elemental edge should matter without ever deciding a battle by
 * itself, so every multiplier here lives inside the floor/ceiling band.
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
  /**
   * Extra weight a theater gives an enemy structure whose heritage the
   * attacker trades by: works it could run natively are worth marching for.
   */
  heritagePrizeWeight: 1.3,
} as const;

/**
 * The bespoke-mechanic balance surface.
 *
 * Five advanced elements carry a mechanic of their own (powers.ts); everything
 * else in the tier 3 space expresses as a bounded stat profile at the same
 * chokepoints. Two disciplines hold everywhere: every mechanic's strength is
 * paired with a weakness that triggers mechanically from world state — no
 * bespoke AI cleverness is ever required to break one — and every profile
 * multiplier stays inside the ±profileBand band, so an identity colors a
 * civilization without deciding its games.
 */
export const POWER_RULES = {
  /**
   * Geyser banks pressure while it holds still. A full bank stiffens its
   * ground; launching a war with a full bank erupts — a surge window where
   * its campaigns press harder — and then the empty system must refill,
   * during which its ground is soft. The weakness is the refill, exactly as
   * designed: catch a geyser realm just after it spent itself.
   */
  geyserBankTicks: 240,
  geyserBankDefense: 0.12,
  geyserSurgeAttack: 1.25,
  geyserSurgeTicks: 90,
  geyserVentDefense: 0.88,
  geyserVentTicks: 240,
  /**
   * Tempest gathers momentum from conquest and unravels when pinned down:
   * each enemy tile taken feeds the storm, every quiet tick bleeds it. The
   * meter is the whole mechanic — the attack factor rides it continuously,
   * and a crest is reported when the storm first gathers to strength.
   */
  tempestGainPerCapture: 0.04,
  tempestDecayPerTick: 0.005,
  tempestMomentumAttack: 0.15,
  tempestCrestThreshold: 0.75,
  /**
   * Bloom turns frontier into heartland half again as fast — until the
   * overgrowth outruns its people. The overextension check is automatic:
   * below the enter ratio of home population the bonus pauses and the
   * realm's ground softens, and only clear recovery re-arms it. Enter and
   * exit differ so the check cannot flap on the boundary.
   */
  bloomSettleBonus: 1.5,
  bloomOverextendedEnterRatio: 0.2,
  bloomOverextendedExitRatio: 0.24,
  bloomOverextendedDefense: 0.92,
  /**
   * Plasma runs its works furiously hot — everything its structures pay is
   * multiplied — against a standing gold upkeep per structure. The failure
   * state is mechanical: the tick the treasury cannot cover the burn,
   * containment fails and the works limp below par for the outage window.
   */
  plasmaPayoutBoost: 1.6,
  plasmaUpkeepPerStructure: 120,
  plasmaFailureTicks: 300,
  plasmaFailurePenalty: 0.7,
  /**
   * Obsidian lets attackers break themselves on its edges: extra attacker
   * casualties on every push into its ground. Sustained siege accumulates
   * fracture; at the limit the edge shatters — reflection off, ground soft —
   * for the shatter window, then the honing starts over. Quiet ticks anneal
   * fracture back down.
   */
  obsidianReflectCasualties: 1.35,
  obsidianFractureTicks: 600,
  obsidianAnnealTicks: 300,
  obsidianShatterTicks: 180,
  obsidianShatterDefense: 0.85,
  /** Hard band around any stat-profile multiplier: identity, never destiny. */
  profileBand: 0.15,
} as const;

/**
 * The information-identity surface.
 *
 * Three advanced elements — and the airborne trade form — express through the
 * belief layer instead of through combat or economy: what a realm knows, and
 * what its rivals wrongly believe, is the whole of the power. None of these
 * constants ever touches the world itself; they bend observations on the way
 * into a belief store and readings on the way out, so a fooled realm makes a
 * worse decision rather than suffering a worse fact.
 */
export const INFORMATION_RULES = {
  /**
   * Observations per interval for swift-sight realms: glass, whose identity
   * is seeing first, and any realm whose expressed element trades by air —
   * the skyward view was air's identity before it was air's carrier, and it
   * stacks on the skyports rather than being replaced by them.
   */
  swiftObservationCadence: 2,
  /**
   * How much of a rival's measurement of mist ground is pulled back toward
   * what that rival already believed. The veil never blocks a look — it
   * thickens it, so beliefs about the Veilfolk's country converge slower and
   * act staler. Standing in the region pierces it entirely.
   */
  mistVeilBlend: 0.7,
  /**
   * The share of a region's cells an observer must hold for its measurement
   * to pierce the mist — a real foothold, against a sliver at the hem. A
   * region reading is an aggregate of the whole country, and owning a border
   * village does not reveal a country; pressing a front there always does.
   */
  mistPierceFoothold: 0.04,
  /**
   * What rivals believe mist and worth of mirage ground to be: the believed
   * prize and openness both read at this share of the truth, so the ground
   * looks poorer and better held than it is. Read-side only — the stores
   * keep honest measurements, the illusion sits in the reading.
   */
  mirageDistortion: 0.6,
  /**
   * Sight-group members with contact on the region it takes to collapse the
   * mirage. One line of contact can be fooled; a second, pooled through an
   * alliance or a live trade route, corroborates — "an informed opponent can
   * collapse the illusion" as arithmetic.
   */
  mirageCollapseContacts: 2,
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

/**
 * Income rates were cut roughly fivefold across the board (land, cities and
 * every trade carrier together) when playtests showed realms running their
 * whole build program inside the first hundred ticks: the world should take
 * several ages to get busy, not one. Costs stayed put, so the same ladder is
 * climbed at a quarter to an eighth of the old pace.
 *
 * The pacing re-tune cut everything a further twentyfold. Ground and capitals
 * take it here as a flat divide, because neither has a lever but its rate;
 * the carriers take the same twentyfold from three levers at once — longer
 * waits between dispatches, slower vehicles, smaller rewards — so trade
 * reads as sparse and unhurried rather than merely cheap. See TRADE_RULES.
 */
export const ECONOMY_RULES = {
  landIncomeScale: 0.024,
  cityIncome: 5,
  maximumTreasury: 100_000_000,
} as const;

/**
 * The trade surface, re-tuned for a slower world.
 *
 * Two changes run through everything below. Every reach is divided by six,
 * alongside STRUCTURE_MIN_SPACING, so each carrier serves its own
 * neighbourhood instead of a province — air included, which had no reach
 * limit at all and now has one. And every carrier's income rate is divided by
 * twenty, drawn from three levers rather than from the reward alone: longer
 * waits between dispatches, slower vehicles, smaller payouts.
 *
 * Splitting the cut three ways matters because the levers are not
 * interchangeable. A carrier paid by the second (ships, flyers) earns the
 * same gold per tick however fast it moves — halving its speed doubles the
 * voyage and doubles the fare with it — so for those two the twentyfold has
 * to come out of the rate, and slowing them buys the look of the thing
 * rather than the economics. A carrier paid by the delivery (trains, pulses)
 * feels every lever directly: a slower vehicle and a longer turnaround each
 * cut its deliveries per tick, so its payout carries only what the clock
 * does not. Each carrier's own note below records which levers did its work.
 */
export const TRADE_RULES = {
  /**
   * How far a factory's coverage reaches, and the longest link a new network
   * may open with. Divided by six with the rest of the trade geography.
   */
  trainRadius: 0.83,
  railSnapDistance: 0.21,
  railExistingTrackCost: 0.08,
  /**
   * What it costs a line to run through a station rather than around it.
   * Well below open ground, so rails thread the towns between their ends --
   * which is what makes a network look like it was planned around its cities.
   */
  railStationCost: 0.2,
  railMaximumNewLinksPerRebuild: 10,
  networkRebuildTicks: 120,
  /**
   * The dispatch clock, tripled across the board. This is the first of the
   * three levers: a site that used to turn a vehicle around in thirty ticks
   * now takes ninety, and the world's rail sweep runs every seventy-two ticks
   * instead of every twenty-four. Tripling all four together keeps their
   * relationship intact — the stagger still spreads sites across the cycle,
   * the turnaround still outlasts the launch interval — so trade thins out
   * evenly rather than clumping somewhere new.
   */
  trainSpawnIntervalTicks: 72,
  shipSpawnIntervalTicks: 36,
  vehicleTurnaroundTicks: 90,
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
   *
   * Tripled with the rest of the dispatch clock.
   */
  launchIntervalTicks: 21,
  trainLimit: 75,
  shipLimit: 1_000,
  pulseLimit: 150,
  flyerLimit: 150,
  /**
   * Carrier speeds, the second lever. Everything is halved; ships take a
   * fifth instead.
   *
   * Boats are the one carrier that gains no reach limit — a harbour still
   * sails to any harbour in the world its owner can trade with, because a
   * sea lane is not a thing anyone builds and there is nothing to shrink.
   * Extra slowness is what stands in for the radius the others got: a voyage
   * that used to cross the map in a season is now most of an age, so a port's
   * reach costs it time even though nothing forbids the distance.
   */
  trainVelocity: 0.06,
  shipVelocity: 0.076,
  /** Energy still moves fastest; a pulse spends little time on the wire. */
  pulseVelocity: 0.425,
  flyerVelocity: 0.25,
  trainStopDwellTicks: 2,
  /**
   * The convoy reward, and the lever that carries the land carrier's whole
   * twentyfold on its own.
   *
   * That was not the plan and it is worth recording why. A train is paid by
   * the delivery, so halving its speed and tripling its turnaround should
   * each cut its stops per tick — but the tighter network cancels both. A
   * journey across a six-times-smaller graph is over in a fraction of the
   * ticks it used to take, which very nearly pays back the slower vehicle
   * and the longer wait: measured against the old world, convoys serve
   * stops at about the rate they always did. So the reward takes the full
   * divide. Foreign stops stay worth exactly double domestic ones.
   */
  domesticTrainStopPayout: 500,
  foreignTrainStopPayout: 1_000,
  /**
   * Sea freight per travel tick. A voyage is priced by its duration, so this
   * rate *is* the harbour's income per tick at sea and the whole twentyfold
   * had to come out of it — slowing the boats moved no gold at all, it only
   * made each voyage a longer, larger delivery. Cut a little past twenty to
   * pay for that: a slower ship spends proportionally less of its cycle
   * turning around in port, so its berth sits idle less often.
   */
  shipPayoutPerTravelTick: 35,
  /**
   * The energy carrier. A power plant strings straight conduits to the
   * nearest few stations within reach, and each delivered pulse pays a flat
   * value — energy trade is frequency, not distance.
   */
  conduitRadius: 0.92,
  conduitLinksPerPlant: 3,
  /**
   * Flat per delivery, so a plant's income is purely how often it can send.
   * Here the clock does bite — a plant's cycle is turnaround-bound and the
   * turnaround tripled — so the three levers land about a threefold cut
   * between them and the reward carries the remaining seven.
   */
  energyDeliveryPayout: 1_300,
  /**
   * The airborne carrier, and the one structure that had no reach at all:
   * a skyport used to fly to any other skyport anywhere in the world, which
   * is why air's identity was reach and why its rate had to be held under
   * sea freight to stop gale realms winning on flight income alone.
   *
   * flightRadius is that missing limit, created here at the same six-times-
   * tighter scale as every other reach — set at three times the train radius,
   * so air still travels furthest of the networked carriers and the identity
   * survives its own bounding. The minimum moves with it: a hop shorter than
   * minimumFlightDistance is still not worth wings, and that floor is divided
   * by six too, or every legal flight would be shorter than the shortest one
   * allowed.
   *
   * Bounding the flight inverts the old rate comparison, which is expected
   * rather than a regression. Air is still paid by the second flown, but a
   * bounded flight is over in a handful of ticks and the ninety-tick
   * turnaround now dominates a skyport's cycle, so it earns for a small
   * fraction of its life and needs a high rate to be worth building at all.
   * Compare the structures, not the rates: two berths flying the band's
   * middle distance spend about a sixteenth of their cycle in the air, which
   * puts a skyport's income per tick below a harbour's — where it sat
   * before, and the comparison the old note was really making.
   *
   * The other cost of the bound is that air is now a carrier a realm has to
   * grow into. A skyport used to reach every apron in the world, so one was
   * enough to earn; now a realm needs two of its own inside the band before
   * either flies, and the placement scoring aims the second at the middle of
   * it. Airborne realms therefore open silent and turn on together once the
   * second apron is bought, which is late in a twentyfold-slower economy.
   */
  airPayoutPerTravelTick: 460,
  flightRadius: 2.5,
  minimumFlightDistance: 0.67,
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
 *
 * The peak rate is divided by six from 0.018 for the slower opening. Only the
 * rate moves: the curve's shape, its thresholds and its 65% optimum are all
 * unchanged, so a realm is rewarded for exactly the same demographic balance
 * it always was — it simply takes six times as long to get anywhere.
 *
 * Where that lands is worth knowing, because it is not evenly spread.
 * Settlement barely notices: claiming ground costs people
 * (CLAIM_RULES.populationCostPerCell) but is paced by pressurePerTick, and a
 * hundred-game sweep at this rate still has the world 99.5% settled by tick
 * 180 — the old schedule, within a rounding error. War notices enormously. A host
 * spent on a campaign is replaced six times slower, so offensives that used
 * to be renewed in a season now need an age, and conquest runs at something
 * like a sixth of its old pace: on the calibration seed, with war chests
 * staked so gold is not the constraint, the old world was down to five
 * realms by tick three thousand where this one is still at forty.
 *
 * That is the intended shape of a slower game — the map fills at close to
 * the pace it did, and then the empires take an age to form on top of it —
 * but the war and diplomacy clocks were not rescaled with it, so wars now
 * reach their exhaustion and stalemate horizons having achieved perhaps a
 * third of what they used to. DIPLOMACY_RULES is where that would be
 * corrected if the shorter, less decisive war is not what is wanted.
 */
export const POPULATION_RULES = {
  lowGrowthThreshold: 0.2,
  peakGrowthRatio: 0.65,
  highGrowthThreshold: 0.82,
  peakGrowthPerTick: 0.003,
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
  /**
   * Settlement pace. At 8 a frontier tile fell nearly every tick and the
   * whole world was claimed by tick 50; the intended arc is a world still
   * being settled while the first wars open, fully claimed around tick 150.
   */
  pressurePerTick: 0.62,
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
