/**
 * Every elemental identity a realm can hold or one day express.
 *
 * Four founding families seat the roster; everything else — grove included —
 * is a compound (tier 2) or advanced (tier 3) element of the wider space,
 * expressible only through the ascension system once a realm's conquests
 * assemble the right history. Widening this union is deliberate: every
 * Record<ElementId, …> site is then compiler-checked for the full space.
 */
export type ElementId =
  | "ember"
  | "tide"
  | "grove"
  | "stone"
  | "gale"
  | "steam"
  | "magma"
  | "lightning"
  | "ice"
  | "sand"
  | "geyser"
  | "tempest"
  | "bloom"
  | "mist"
  | "mirage"
  | "plasma"
  | "ash"
  | "obsidian"
  | "glass"
  | "spirit"
  | "aurora"
  | "lodestone"
  | "amber"
  | "fungus"
  | "crystal";

/** The four irreducible bases every element's character is composed from. */
export type FoundingElementId = "ember" | "tide" | "stone" | "gale";

export type ElementTier = 1 | 2 | 3;

/**
 * The four fundamental ways value moves through the world, one per founding
 * base: ember trades energy, tide the waterways, stone the land, gale the air.
 */
export type TradeForm = "energy" | "waterway" | "land" | "airborne";

/**
 * A competing power. Twelve players share each founding element, so a player
 * carries an element without being one. Ids look like "ember-4"; the roster
 * and the element behind each id live in players.ts.
 */
export type PlayerId = string;

export type TerrainId =
  | "water"
  | "farmland"
  | "plains"
  | "forest"
  | "hills"
  | "mountains";

export type LandTerrainId = Exclude<TerrainId, "water">;

export type StructureType = "city" | "fort" | "factory" | "harbor" | "plant" | "skyport";

export type RelationStatus = "peace" | "truce" | "war";

export type CampaignMode = "settlement" | "land" | "naval";

/** Campaigns are chosen by target, never by a coordinate or a direction. */
export type CampaignTarget = PlayerId | "wilderness";

export type RealmPosture =
  | "peaceful"
  | "expanding"
  | "mobilizing"
  | "invading"
  | "defending"
  | "recovering"
  | "trading";

/**
 * What a realm can choose to be about. Ascension is this game's technology:
 * the pursuit of higher elemental tiers through conquest of complementary
 * powers.
 */
export type StrategicDomain =
  | "economy"
  | "conquest"
  | "ascension"
  | "diplomacy"
  | "defense"
  | "trade";

/**
 * A realm's standing priorities: what it is trying to be about, before any
 * single decision. Element identity seeds the weights and situation bends
 * them; the AI systems read them as bounded multipliers, so a priority
 * influences behavior without ever gating it.
 */
export interface StrategicPriorities {
  /** Normalized weights over the domains; always sums to one. */
  weights: Record<StrategicDomain, number>;
  /** The leading domain, for display and stories. */
  focus: StrategicDomain;
  /** Tick the current focus was adopted. */
  adoptedAt: number;
  /** Why, in the realm's own words — like AiIntent.reason. */
  reason: string;
}

export interface ElementDefinition {
  id: ElementId;
  name: string;
  realmName: string;
  title: string;
  glyph: string;
  color: string;
  softColor: string;
  deepColor: string;
  /** Where this element belongs in the three-tier space. */
  tier: ElementTier;
  /**
   * What this element is made of: nothing for a founding base, two founding
   * bases for tier 2, two tier-2 elements for tier 3. Composition — and from
   * it dominance and counters — is derived from these, never hand-authored.
   */
  bases: readonly ElementId[];
  /** The repeated base of a dominant tier 3; null for balanced and lower tiers. */
  dominantBase: ElementId | null;
  /** Native trade forms: one for tier 1, two thereafter. */
  tradeForms: readonly TradeForm[];
  /**
   * Baseline strategic weights this element leans its civilization toward.
   * Authored for the founding families; compounds inherit a blend of their
   * bases (see strategy.ts), so omitting it here means "what I am made of".
   */
  priorityProfile?: Readonly<Record<StrategicDomain, number>>;
  favoredTerrain: LandTerrainId;
  temperament: string;
}

export interface TerrainRule {
  id: TerrainId;
  name: string;
  shortName: string;
  fill: string;
  defenseCost: number;
  sustain: number;
  goldYield: number;
}

export interface StructureRule {
  id: StructureType;
  name: string;
  glyph: string;
  cost: number;
  description: string;
}

export interface Cell {
  owner: PlayerId | null;
  terrain: TerrainId;
  structure: StructureType | null;
  /** Cities may vertically develop one site; other structures always remain level one. */
  structureLevel: number;
  capitalOf: PlayerId | null;
  coastal: boolean;
  pressure: number;
  pressureBy: PlayerId | null;
  pressureTracked: boolean;
  capturedAt: number;
  /**
   * The expressed element of the realm that raised this cell's structure,
   * stamped at build and never cleared: infrastructure remembers its builders
   * through every capture. How well the current owner's history covers the
   * heritage's trade forms decides what the works pay it (see
   * structurePayoutMultiplier in elements.ts). Null wherever nothing stands.
   */
  structureHeritage: ElementId | null;
}

/**
 * The running state of a realm's elemental mechanic.
 *
 * Five advanced elements carry a bespoke mechanic (see powers.ts); every realm
 * holds one of these small meters so expression can change without the state
 * shape changing. What the fields mean depends on the expressed element:
 * charge is the mechanic's meter — pressure banked for geyser, momentum held
 * for tempest, fracture accumulated for obsidian, the overextension flag for
 * bloom; releasedAt is the tick of the last release — eruption, crest,
 * shatter, containment failure, overextension onset — or -1 for never; tally
 * is the bookkeeping the meter is computed from (enemy tiles already credited
 * to momentum), kept current for every realm so a late ascension starts its
 * mechanic from now rather than from the whole war record.
 */
export interface ElementPowerState {
  charge: number;
  releasedAt: number;
  tally: number;
}

export interface AiIntent {
  target: PlayerId | null;
  posture: RealmPosture;
  confidence: number;
  plannedCommitment: number;
  reason: string;
}

export interface StructureCounts {
  city: number;
  fort: number;
  factory: number;
  harbor: number;
  plant: number;
  skyport: number;
}

export interface FactionState {
  id: PlayerId;
  /** The founding family this player shares with its eleven siblings. */
  element: ElementId;
  /**
   * The element this realm currently expresses: its founding element until
   * conquest assembles the history for a higher tier, then the compound or
   * advanced element the ascension system awarded. Expression only ever
   * upgrades — a realm never forgets what it has become — and it is what
   * combat matchups and strategic character read.
   */
  expressedElement: ElementId;
  /**
   * Which founding bases this realm's absorbed history covers, as a 4-bit
   * mask in FOUNDING_ELEMENTS order. Facing an elemental edge, covering the
   * rival's bases grades the edge down — history softens a matchup without
   * ever erasing one.
   */
  baseMask: number;
  alive: boolean;
  territory: number;
  previousTerritory: number;
  momentum: number;
  troops: number;
  troopCap: number;
  troopGrowth: number;
  gold: number;
  goldRate: number;
  /** Lifetime economics per structure kind; see economics.ts. */
  economy: EconomyLedger;
  sustainableLand: number;
  casualties: number;
  capturedTiles: number;
  claimedTiles: number;
  warWeariness: number;
  traitorUntil: number;
  warships: number;
  structures: StructureCounts;
  capitalIndex: number;
  /** Standing priorities; seeded by element, bent by situation. */
  strategy: StrategicPriorities;
  /** The meter behind the expressed element's mechanic; see powers.ts. */
  power: ElementPowerState;
  /** Distinct elemental powers held; drives terrain affinity and matchups. */
  absorbedElements: ElementId[];
  /**
   * How many realms of each element this one has taken, itself included.
   *
   * The distinct set answers "what can this realm do"; the tally answers "how
   * much of it does it hold", which is what a realm built from ten conquered
   * Ember neighbours has that one holding a single Ember province does not.
   */
  elementCounts: Record<ElementId, number>;
  lastConqueror: PlayerId | null;
  intent: AiIntent;
}

export interface RelationState {
  key: string;
  parties: readonly [PlayerId, PlayerId];
  status: RelationStatus;
  since: number;
  cooldownUntil: number;
  truceUntil: number;
  truceOfferBy: PlayerId | null;
  truceOfferAt: number;
  lastAggressor: PlayerId | null;
  tradeActive: boolean;
  tradeDisabledBy: PlayerId[];
  storyKey: string | null;
}

export interface Campaign {
  id: string;
  attacker: PlayerId;
  target: CampaignTarget;
  mode: CampaignMode;
  initialCommitted: number;
  remaining: number;
  initialDefenderCommitted: number;
  defenderRemaining: number;
  launchedAt: number;
  captures: number;
  casualties: number;
  originIndex: number | null;
  targetIndex: number | null;
  /** Naval campaigns retain their complete water-only voyage for simulation and rendering. */
  pathIndices: number[];
  eta: number;
  initialEta: number;
  storyKey: string;
}

export interface TheaterTerrainProfile {
  farmland: number;
  plains: number;
  forest: number;
  hills: number;
  mountains: number;
}

/**
 * A stable-identity, adaptive economic/terrain area beneath political ownership.
 * Regions may cross national borders and migrate gradually as world value moves.
 */
export interface StrategicRegion {
  id: number;
  cells: number[];
  centroidIndex: number;
  dominantTerrain: LandTerrainId;
  terrainProfile: TheaterTerrainProfile;
  baseProductivity: number;
  /** Stable alpha-beta-filtered focus used by the equal-area partition. */
  anchorX: number;
  anchorY: number;
  velocityX: number;
  velocityY: number;
  updatedAt: number;
}

/**
 * Continuous strategic fields shared by the simulation and the theater-map
 * renderer. Keeping these fields in the snapshot prevents the display thread
 * from rebuilding geography every time React receives a new world state.
 */
/**
 * One player's remembered reading of the world, per strategic region.
 *
 * value and trend are the two states of the filter in theater-map.ts, laid out
 * as region-major runs of OBSERVED_LAYERS. observedAt is when each region was
 * last seen, or -1 for never -- which is how a player tells ground it believes
 * is empty from ground it has simply never looked at.
 */
export interface RegionObservation {
  value: Float32Array;
  trend: Float32Array;
  observedAt: Int32Array;
}

export interface TheaterMapState {
  byPlayer: Record<PlayerId, RegionObservation>;
  regionCount: number;
}

/**
 * What each kind of building has cost a player and earned it, for the life of
 * the game. Cumulative and never reset, so a reading late in a game answers
 * "was this worth building" over the whole run rather than over a moment.
 */
export interface StructureEconomics {
  /** Gold sunk into building and upgrading. */
  spent: number;
  /** Gold earned that this kind of building is responsible for. */
  earned: number;
  /** Journeys, voyages or stops the building generated. */
  runs: number;
}

export type EconomyLedger = Record<StructureType, StructureEconomics> & {
  /** Income from held ground, the baseline every other source competes with. */
  land: number;
};

export interface StrategicMetaState {
  value: Float32Array;
  productivity: Float32Array;
  relief: Float32Array;
  infrastructure: Float32Array;
  updatedAt: number;
}

/**
 * A continuously derived geographic slice of a target-specific campaign.
 * Commitments belong to the campaign; allocations are recalculated across
 * these theaters as borders, terrain, forts and supply change.
 */
export interface Theater {
  id: string;
  campaignId: string;
  regionId: number;
  attacker: PlayerId;
  target: CampaignTarget;
  boundaryCells: number[];
  objectiveCells: number[];
  centroidIndex: number;
  terrainProfile: TheaterTerrainProfile;
  effectiveLength: number;
  resistance: number;
  supplyQuality: number;
  strategicValue: number;
  valueTrend: number;
  valueHistory: number[];
  allocation: number;
  formedAt: number;
  updatedAt: number;
  lastAdvanceAt: number;
  staleRefreshes: number;
  captures: number;
  victoryReported: boolean;
}

export interface TradeRoute {
  id: string;
  owner: PlayerId;
  parties: readonly [PlayerId, PlayerId];
  kind: "rail" | "sea" | "conduit";
  startIndex: number;
  endIndex: number;
  pathIndices: number[];
  value: number;
  foreign: boolean;
  allied: boolean;
  destinationOwner: PlayerId;
}

/**
 * Every carrier's traveller is one shape. A train is any land convoy over the
 * road-and-rail network -- wagons, cars, trains, whatever the land carries; a
 * ship sails the sea lanes; a pulse runs a power conduit; a flyer crosses
 * anything in a straight line between skyports.
 */
export type TradeVehicleKind = "train" | "ship" | "pulse" | "flyer";

export interface TradeVehicle {
  id: string;
  owner: PlayerId;
  kind: TradeVehicleKind;
  startIndex: number;
  endIndex: number;
  pathIndices: number[];
  /** Revenue-bearing stations encountered along the physical track path. */
  stopIndices: number[];
  progress: number;
  velocity: number;
  distanceTravelled: number;
  totalDistance: number;
  nextStop: number;
  sourceIndex: number;
  payout: number;
  foreign: boolean;
  allied: boolean;
  destinationOwner: PlayerId;
  storyKey: string;
  earnedIncome: number;
  hostIncome: number;
  completedStops: number;
  launchedAt: number;
  dwellRemaining: number;
}

/** Per-site dispatch: berths, cooldowns and the launch stagger. */
export interface TradeDispatchState {
  kind: TradeVehicleKind;
  sourceIndex: number;
  /** Vehicles currently out from this site; a site may run several at once. */
  activeVehicleIds: string[];
  readyAt: number;
  completedRuns: number;
  lastVehicleId: string | null;
}

export interface ChronicleEvent {
  id: number;
  tick: number;
  tone: "battle" | "treaty" | "economy" | "rise" | "fall" | "world";
  text: string;
  actor: PlayerId | null;
}

export type ReportDomain =
  | "world"
  | "diplomacy"
  | "military"
  | "territory"
  | "infrastructure"
  | "economy"
  | "trade"
  | "leadership"
  | "intrigue"
  | "dynasty"
  | "politics"
  | "society";

export type ReportImportance = "routine" | "notable" | "major" | "historic";

export type CoreReportEventKind =
  | "world.created"
  | "world.victory"
  | "diplomacy.alliance-offered"
  | "diplomacy.alliance-offer-expired"
  | "diplomacy.alliance-formed"
  | "diplomacy.alliance-expired"
  | "diplomacy.alliance-betrayed"
  | "diplomacy.war-declared"
  | "diplomacy.peace-made"
  | "diplomacy.trade-policy-changed"
  | "military.campaign-launched"
  | "military.campaign-reinforced"
  | "military.defense-committed"
  | "military.campaign-concluded"
  | "military.naval-expedition-lost"
  | "military.beachhead-established"
  | "military.warship-built"
  | "military.theater-formed"
  | "military.theater-realigned"
  | "military.theater-victory"
  | "territory.capital-captured"
  | "territory.structure-captured"
  | "territory.resonant-capture"
  | "territory.realm-conquered"
  | "territory.settlement-milestone"
  | "infrastructure.structure-built"
  | "trade.rail-network-changed"
  | "trade.journey-started"
  | "trade.journey-cancelled"
  | "trade.train-stop-served"
  | "trade.journey-completed";

/** Reserved namespaces let future feature packages extend the report safely. */
export type ReportEventKind =
  | CoreReportEventKind
  | `intrigue.${string}`
  | `dynasty.${string}`
  | `politics.${string}`
  | `society.${string}`
  | `leadership.${string}`;

export type ReportSubjectType =
  | "realm"
  | "wilderness"
  | "campaign"
  | "theater"
  | "structure"
  | "route"
  | "vehicle"
  | "character"
  | "province";

export interface ReportSubject {
  type: ReportSubjectType;
  id: string;
  label: string;
  realmId?: PlayerId;
}

export type ReportFact =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  /** Small labelled tallies, such as a conqueror's per-element counts. */
  | Record<string, number>;

export interface WorldReportEvent {
  schemaVersion: 1;
  id: number;
  tick: number;
  age: number;
  domain: ReportDomain;
  kind: ReportEventKind;
  importance: ReportImportance;
  storyKey: string;
  initiator: ReportSubject | null;
  targets: ReportSubject[];
  participants: ReportSubject[];
  links: Record<string, string>;
  facts: Record<string, ReportFact>;
  summary: string;
}

export type WorldReportDraft = Omit<
  WorldReportEvent,
  "schemaVersion" | "id" | "tick" | "age"
> & {
  importance?: ReportImportance;
  targets?: ReportSubject[];
  participants?: ReportSubject[];
  links?: Record<string, string>;
  facts?: Record<string, ReportFact>;
};

export type StoryKind =
  | "world"
  | "expansion"
  | "alliance"
  | "war"
  | "development"
  | "trade"
  | "conquest"
  | "intrigue"
  | "dynasty"
  | "revolt";

export interface StoryArc {
  id: string;
  storyKey: string;
  kind: StoryKind;
  status: "developing" | "concluded";
  importance: ReportImportance;
  startedAt: number;
  updatedAt: number;
  concludedAt: number | null;
  headline: string;
  summary: string;
  participants: ReportSubject[];
  eventIds: number[];
  metrics: Record<string, number>;
}

export interface DeclareWarCommand {
  type: "declare-war";
  actor: PlayerId;
  target: PlayerId;
}

export interface MakePeaceCommand {
  type: "make-peace";
  actor: PlayerId;
  target: PlayerId;
}

export interface OfferTruceCommand {
  type: "offer-truce";
  actor: PlayerId;
  target: PlayerId;
}

export interface AcceptTruceCommand {
  type: "accept-truce";
  actor: PlayerId;
  target: PlayerId;
}

export interface SetTradeCommand {
  type: "set-trade";
  actor: PlayerId;
  target: PlayerId;
  enabled: boolean;
}

export interface LaunchCampaignCommand {
  type: "launch-campaign";
  actor: PlayerId;
  target: CampaignTarget;
  troops: number;
  mode: CampaignMode;
}

export interface CommitDefenseCommand {
  type: "commit-defense";
  actor: PlayerId;
  target: PlayerId;
  troops: number;
}

export interface BuildStructureCommand {
  type: "build-structure";
  actor: PlayerId;
  structure: StructureType;
  tileIndex: number;
}

export interface BuildWarshipCommand {
  type: "build-warship";
  actor: PlayerId;
}

export type WorldCommand =
  | DeclareWarCommand
  | MakePeaceCommand
  | OfferTruceCommand
  | AcceptTruceCommand
  | SetTradeCommand
  | LaunchCampaignCommand
  | CommitDefenseCommand
  | BuildStructureCommand
  | BuildWarshipCommand;

export interface SimulationConfig {
  width: number;
  height: number;
  aggression: number;
  decisionInterval: number;
  diplomacyInterval: number;
  constructionInterval: number;
  /** Ticks between strategic-priority recomputes. */
  strategyInterval: number;
  minimumPeaceTicks: number;
  victoryShare: number;
  maximumTroops: number;
}

export interface WorldState {
  seed: number;
  worldName: string;
  tick: number;
  age: number;
  landTiles: number;
  cells: Cell[];
  factions: Record<PlayerId, FactionState>;
  relations: Record<string, RelationState>;
  campaigns: Campaign[];
  strategicRegions: StrategicRegion[];
  strategicMeta: StrategicMetaState;
  /** Per-player beliefs about the ground; see theater-map.ts. */
  theaterMap: TheaterMapState;
  /** Cell index -> persistent strategic region id; water is -1. */
  regionByCell: number[];
  theaters: Theater[];
  tradeRoutes: TradeRoute[];
  /** Cheap topology fingerprint used to avoid rebuilding unchanged rail graphs. */
  railNetworkSignature: string;
  railNetworkNeedsExpansion: boolean;
  tradeVehicles: TradeVehicle[];
  tradeDispatches: Record<string, TradeDispatchState>;
  /** Sparse index for pressure decay; avoids scanning the entire map every tick. */
  activePressureCells: number[];
  commands: WorldCommand[];
  chronicle: ChronicleEvent[];
  reports: WorldReportEvent[];
  stories: StoryArc[];
  storyCursor: number;
  champion: PlayerId | null;
  dominantSince: number | null;
  config: SimulationConfig;
}

export interface SimulationContext {
  state: WorldState;
  random: RandomSource;
  emit: (
    text: string,
    tone: ChronicleEvent["tone"],
    actor?: PlayerId | null,
  ) => void;
  report: (draft: WorldReportDraft) => number;
}

export interface RandomSource {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

export interface SimulationSystem {
  readonly id: string;
  update(context: SimulationContext): void;
}
