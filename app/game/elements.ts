import { ELEMENT_RULES, TRADE_RULES, clamp } from "./rules";
import type {
  ElementDefinition,
  ElementId,
  ElementTier,
  FoundingElementId,
  PlayerId,
  TradeForm,
  TradeVehicleKind,
  WorldState,
} from "./types";

/**
 * The elemental space.
 *
 * Four founding families seat the roster. Around them sits the full
 * three-tier space: compound (tier 2) elements made of two founding bases,
 * and advanced (tier 3) elements made of two compounds. Grove is no longer a
 * starting family — the Mossbound return as the first compound a conqueror of
 * tide and stone realms can express. The composed matchup table below is the
 * live combat rule, read through each realm's expressed element with graded
 * relief for the founding bases its absorbed history covers.
 */

/** The founding families, in roster order. This is the seatable roster. */
export const ELEMENT_ORDER: readonly ElementId[] = [
  "ember",
  "tide",
  "stone",
  "gale",
] as const;

/** The four irreducible bases all composition reduces to. Grove is not one: it is tide and stone grown together. */
export const FOUNDING_ELEMENTS: readonly FoundingElementId[] = [
  "ember",
  "tide",
  "stone",
  "gale",
] as const;

/** Canonical order of the whole space: legacy roster order first, then tier 2, then tier 3. */
export const ELEMENT_SPACE: readonly ElementId[] = [
  "ember",
  "tide",
  "grove",
  "stone",
  "gale",
  "steam",
  "magma",
  "lightning",
  "ice",
  "sand",
  "geyser",
  "tempest",
  "bloom",
  "mist",
  "mirage",
  "plasma",
  "ash",
  "obsidian",
  "glass",
  "spirit",
  "aurora",
  "lodestone",
  "amber",
  "fungus",
  "crystal",
] as const;

export const ELEMENTS: Record<ElementId, ElementDefinition> = {
  ember: {
    id: "ember",
    name: "Ember",
    realmName: "The Cinderkin",
    title: "Bright, bold & impatient",
    glyph: "✦",
    color: "#ef6a5b",
    softColor: "#ffc2ad",
    deepColor: "#8e2f35",
    tier: 1,
    bases: [],
    dominantBase: null,
    tradeForms: ["energy"],
    priorityProfile: {
      economy: 0.2, conquest: 0.28, ascension: 0.12, diplomacy: 0.08, defense: 0.12, trade: 0.2,
    },
    favoredTerrain: "hills",
    temperament: "Mobilizes early and spends heavily when a border looks thin.",
  },
  tide: {
    id: "tide",
    name: "Tide",
    realmName: "The Ripple Court",
    title: "Patient, fluid & watchful",
    glyph: "≈",
    color: "#45a9b8",
    softColor: "#ade1dc",
    deepColor: "#176375",
    tier: 1,
    bases: [],
    dominantBase: null,
    tradeForms: ["waterway"],
    priorityProfile: {
      economy: 0.18, conquest: 0.14, ascension: 0.1, diplomacy: 0.18, defense: 0.12, trade: 0.28,
    },
    favoredTerrain: "farmland",
    temperament: "Invests in harbors, trade and carefully timed naval landings.",
  },
  grove: {
    id: "grove",
    name: "Grove",
    realmName: "The Mossbound",
    title: "Steady, social & stubborn",
    glyph: "❧",
    color: "#71a366",
    softColor: "#c9dda1",
    deepColor: "#426342",
    tier: 2,
    bases: ["tide", "stone"],
    dominantBase: null,
    tradeForms: ["waterway", "land"],
    priorityProfile: {
      economy: 0.2, conquest: 0.08, ascension: 0.1, diplomacy: 0.16, defense: 0.24, trade: 0.22,
    },
    favoredTerrain: "forest",
    temperament: "Values peaceful trade and builds a layered defensive frontier.",
  },
  stone: {
    id: "stone",
    name: "Stone",
    realmName: "The Pebblehold",
    title: "Tough, thrifty & immovable",
    glyph: "◆",
    color: "#c49a62",
    softColor: "#ead2a0",
    deepColor: "#74543e",
    tier: 1,
    bases: [],
    dominantBase: null,
    tradeForms: ["land"],
    priorityProfile: {
      economy: 0.24, conquest: 0.14, ascension: 0.1, diplomacy: 0.1, defense: 0.28, trade: 0.14,
    },
    favoredTerrain: "mountains",
    temperament: "Turns mountain approaches into forts before counterattacking.",
  },
  gale: {
    id: "gale",
    name: "Gale",
    realmName: "The Cloudlings",
    title: "Clever, quick & capricious",
    glyph: "◌",
    color: "#9684c5",
    softColor: "#d6cbef",
    deepColor: "#594d84",
    tier: 1,
    bases: [],
    dominantBase: null,
    tradeForms: ["airborne"],
    priorityProfile: {
      economy: 0.14, conquest: 0.18, ascension: 0.14, diplomacy: 0.24, defense: 0.14, trade: 0.16,
    },
    favoredTerrain: "plains",
    temperament: "Keeps a reserve and changes wars when the balance shifts.",
  },
  steam: {
    id: "steam",
    name: "Steam",
    realmName: "The Pressureborn",
    title: "Driven, disciplined & explosive",
    glyph: "∿",
    color: "#9fb4bd",
    softColor: "#d9e4e8",
    deepColor: "#5b7078",
    tier: 2,
    bases: ["ember", "tide"],
    dominantBase: null,
    tradeForms: ["energy", "waterway"],
    favoredTerrain: "hills",
    temperament: "Banks output behind pipes and reservoirs, then spends it in one push.",
  },
  magma: {
    id: "magma",
    name: "Magma",
    realmName: "The Moltenline",
    title: "Slow, relentless & transforming",
    glyph: "▲",
    color: "#d1603d",
    softColor: "#f2b08a",
    deepColor: "#7a2e1d",
    tier: 2,
    bases: ["ember", "stone"],
    dominantBase: null,
    tradeForms: ["energy", "land"],
    favoredTerrain: "mountains",
    temperament: "Advances slowly and rebuilds conquered ground into something new.",
  },
  lightning: {
    id: "lightning",
    name: "Lightning",
    realmName: "The Arcbound",
    title: "Instant, brilliant & brief",
    glyph: "↯",
    color: "#e8c94a",
    softColor: "#f7e9a8",
    deepColor: "#8a6d1f",
    tier: 2,
    bases: ["ember", "gale"],
    dominantBase: null,
    tradeForms: ["energy", "airborne"],
    favoredTerrain: "plains",
    temperament: "Strikes first along connected routes and fades if the war drags.",
  },
  ice: {
    id: "ice",
    name: "Ice",
    realmName: "The Frostheld",
    title: "Still, preserving & unyielding",
    glyph: "❄",
    color: "#8fd0dd",
    softColor: "#d8f1f4",
    deepColor: "#3f7f93",
    tier: 2,
    bases: ["tide", "gale"],
    dominantBase: null,
    tradeForms: ["waterway", "airborne"],
    favoredTerrain: "mountains",
    temperament: "Preserves stores and holds a stable line through lean seasons.",
  },
  sand: {
    id: "sand",
    name: "Sand",
    realmName: "The Duneborne",
    title: "Restless, patient & abrasive",
    glyph: "∴",
    color: "#d3b26a",
    softColor: "#efdfb2",
    deepColor: "#8a6f3c",
    tier: 2,
    bases: ["stone", "gale"],
    dominantBase: null,
    tradeForms: ["land", "airborne"],
    favoredTerrain: "plains",
    temperament: "Disperses, infiltrates and erodes rather than confronting head-on.",
  },
  geyser: {
    id: "geyser",
    name: "Geyser",
    realmName: "The Deepsprings",
    title: "Quiet, coiled & eruptive",
    glyph: "⇞",
    color: "#6fb3ae",
    softColor: "#c3e5e0",
    deepColor: "#2f6a68",
    tier: 3,
    bases: ["steam", "magma"],
    dominantBase: "ember",
    tradeForms: ["energy", "waterway"],
    favoredTerrain: "hills",
    temperament: "Sits quiet over building pressure and erupts when it matters.",
  },
  tempest: {
    id: "tempest",
    name: "Tempest",
    realmName: "The Stormwrights",
    title: "Roaming, gathering & wild",
    glyph: "☈",
    color: "#5f8fb4",
    softColor: "#b7d4e8",
    deepColor: "#2b4f70",
    tier: 3,
    bases: ["steam", "lightning"],
    dominantBase: "ember",
    tradeForms: ["waterway", "airborne"],
    favoredTerrain: "plains",
    temperament: "Gathers strength while moving and unravels when pinned down.",
  },
  bloom: {
    id: "bloom",
    name: "Bloom",
    realmName: "The Overgrowth",
    title: "Fertile, eager & consuming",
    glyph: "❀",
    color: "#86c05a",
    softColor: "#d6ecb2",
    deepColor: "#477330",
    tier: 3,
    bases: ["steam", "grove"],
    dominantBase: "tide",
    tradeForms: ["waterway", "land"],
    favoredTerrain: "farmland",
    temperament: "Turns frontier into heartland faster than the land can object.",
  },
  mist: {
    id: "mist",
    name: "Mist",
    realmName: "The Veilfolk",
    title: "Soft, veiling & elusive",
    glyph: "≋",
    color: "#a9b8b4",
    softColor: "#dde7e3",
    deepColor: "#62736f",
    tier: 3,
    bases: ["steam", "ice"],
    dominantBase: "tide",
    tradeForms: ["waterway", "airborne"],
    favoredTerrain: "forest",
    temperament: "Keeps its roads, camps and intentions politely unclear.",
  },
  mirage: {
    id: "mirage",
    name: "Mirage",
    realmName: "The Falselights",
    title: "Dazzling, false & fragile",
    glyph: "◒",
    color: "#c9a8d4",
    softColor: "#ecdcf1",
    deepColor: "#7b5a88",
    tier: 3,
    bases: ["steam", "sand"],
    dominantBase: null,
    tradeForms: ["land", "airborne"],
    favoredTerrain: "plains",
    temperament: "Sells the world a picture of strength it may not hold.",
  },
  plasma: {
    id: "plasma",
    name: "Plasma",
    realmName: "The Sunforges",
    title: "Blinding, costly & absolute",
    glyph: "✹",
    color: "#d76bc4",
    softColor: "#f3c3e8",
    deepColor: "#7e2f72",
    tier: 3,
    bases: ["magma", "lightning"],
    dominantBase: "ember",
    tradeForms: ["energy", "airborne"],
    favoredTerrain: "mountains",
    temperament: "Runs a few furious centers and dares its treasury to keep up.",
  },
  ash: {
    id: "ash",
    name: "Ash",
    realmName: "The Ashsown",
    title: "Grim, patient & renewing",
    glyph: "⁘",
    color: "#8d8578",
    softColor: "#cfc9bd",
    deepColor: "#4c463c",
    tier: 3,
    bases: ["magma", "grove"],
    dominantBase: "stone",
    tradeForms: ["energy", "land"],
    favoredTerrain: "forest",
    temperament: "Wins ruined ground and waits for it to grow back richer.",
  },
  obsidian: {
    id: "obsidian",
    name: "Obsidian",
    realmName: "The Knifecoast",
    title: "Sharp, brittle & punishing",
    glyph: "◈",
    color: "#5a5668",
    softColor: "#a9a5b8",
    deepColor: "#232030",
    tier: 3,
    bases: ["magma", "ice"],
    dominantBase: null,
    tradeForms: ["energy", "land"],
    favoredTerrain: "mountains",
    temperament: "Lets attackers break themselves on edges it spent years honing.",
  },
  glass: {
    id: "glass",
    name: "Glass",
    realmName: "The Clearworks",
    title: "Clear, precise & delicate",
    glyph: "◇",
    color: "#a9d6d0",
    softColor: "#e2f4f0",
    deepColor: "#57847e",
    tier: 3,
    bases: ["magma", "sand"],
    dominantBase: "stone",
    tradeForms: ["energy", "land"],
    favoredTerrain: "hills",
    temperament: "Sees far, aims first, and avoids long fights that shatter.",
  },
  spirit: {
    id: "spirit",
    name: "Spirit",
    realmName: "The Remembered",
    title: "Abiding, binding & unbodied",
    glyph: "✧",
    color: "#9cc9a8",
    softColor: "#d9eedd",
    deepColor: "#4f7a5c",
    tier: 3,
    bases: ["lightning", "grove"],
    dominantBase: null,
    tradeForms: ["waterway", "airborne"],
    favoredTerrain: "forest",
    temperament: "Endures through people and memory beyond any border.",
  },
  aurora: {
    id: "aurora",
    name: "Aurora",
    realmName: "The Skyweave",
    title: "Distant, aligned & luminous",
    glyph: "⌒",
    color: "#74c9a4",
    softColor: "#c7ecd9",
    deepColor: "#3a7a6c",
    tier: 3,
    bases: ["lightning", "ice"],
    dominantBase: "gale",
    tradeForms: ["energy", "airborne"],
    favoredTerrain: "mountains",
    temperament: "Links distant holdings into one synchronized field.",
  },
  lodestone: {
    id: "lodestone",
    name: "Lodestone",
    realmName: "The Drawnsteel",
    title: "Unseen, ordering & inexorable",
    glyph: "⊕",
    color: "#7d8fa6",
    softColor: "#c4cfdd",
    deepColor: "#3e4c61",
    tier: 3,
    bases: ["lightning", "sand"],
    dominantBase: "gale",
    tradeForms: ["energy", "land"],
    favoredTerrain: "hills",
    temperament: "Redirects what moves and holds what stands with unseen force.",
  },
  amber: {
    id: "amber",
    name: "Amber",
    realmName: "The Longkept",
    title: "Sealed, timeless & hoarding",
    glyph: "◉",
    color: "#d99b3d",
    softColor: "#f2d59c",
    deepColor: "#8a5c1d",
    tier: 3,
    bases: ["grove", "ice"],
    dominantBase: "tide",
    tradeForms: ["waterway", "land"],
    favoredTerrain: "forest",
    temperament: "Keeps what it values sealed against decay, including its habits.",
  },
  fungus: {
    id: "fungus",
    name: "Fungus",
    realmName: "The Sporebound",
    title: "Hidden, spreading & tireless",
    glyph: "⋒",
    color: "#b08e6e",
    softColor: "#e0cbb4",
    deepColor: "#5f4a35",
    tier: 3,
    bases: ["grove", "sand"],
    dominantBase: "stone",
    tradeForms: ["land", "airborne"],
    favoredTerrain: "forest",
    temperament: "Feeds on ruin and dormancy and surfaces where least expected.",
  },
  crystal: {
    id: "crystal",
    name: "Crystal",
    realmName: "The Latticework",
    title: "Resonant, ordered & stored",
    glyph: "❖",
    color: "#9fb0e0",
    softColor: "#dbe2f5",
    deepColor: "#4f5f94",
    tier: 3,
    bases: ["ice", "sand"],
    dominantBase: "gale",
    tradeForms: ["land", "airborne"],
    favoredTerrain: "mountains",
    temperament: "Stores power in resonant nodes and times its release.",
  },
};

export const ELEMENT_INDEX = Object.fromEntries(
  ELEMENT_SPACE.map((element, index) => [element, index]),
) as Record<ElementId, number>;

/**
 * Who counters whom around the founding cycle: tide quenches ember, ember
 * bakes stone, stone grounds gale, gale scatters tide. Ember–gale and
 * tide–stone sit outside the cycle and are neutral unless neutralPairEdge
 * says otherwise.
 */
const FOUNDING_COUNTERS: Record<FoundingElementId, FoundingElementId> = {
  tide: "ember",
  ember: "stone",
  stone: "gale",
  gale: "tide",
};

/** The legacy winners across the neutral pairs, consulted only when the knob is raised. */
const NEUTRAL_PAIR_WINNERS: Partial<Record<FoundingElementId, FoundingElementId>> = {
  ember: "gale",
  tide: "stone",
};

function counterStrength(attacker: FoundingElementId, defender: FoundingElementId): number {
  if (attacker === defender) return 0;
  if (FOUNDING_COUNTERS[attacker] === defender) return 1;
  if (FOUNDING_COUNTERS[defender] === attacker) return -1;
  if (NEUTRAL_PAIR_WINNERS[attacker] === defender) return ELEMENT_RULES.neutralPairEdge;
  if (NEUTRAL_PAIR_WINNERS[defender] === attacker) return -ELEMENT_RULES.neutralPairEdge;
  return 0;
}

const COMPOSITIONS = new Map<ElementId, Record<FoundingElementId, number>>();

/**
 * An element's weight over the four founding bases, derived from what it is
 * made of and never authored: a founding base is all itself, a compound is
 * half of each base, an advanced element is the average of its two compounds.
 * Every weight is an exact binary fraction, so the sums below are float-exact.
 */
export function compositionOf(element: ElementId): Record<FoundingElementId, number> {
  const cached = COMPOSITIONS.get(element);
  if (cached) return cached;
  const definition = ELEMENTS[element];
  const composition: Record<FoundingElementId, number> = { ember: 0, tide: 0, stone: 0, gale: 0 };
  if (definition.bases.length === 0) {
    composition[element as FoundingElementId] = 1;
  } else {
    for (const base of definition.bases) {
      const inner = compositionOf(base);
      for (const founding of FOUNDING_ELEMENTS) {
        composition[founding] += inner[founding] / definition.bases.length;
      }
    }
  }
  COMPOSITIONS.set(element, composition);
  return composition;
}

/**
 * The repeated base of a tier 3, read off its composition: above a quarter
 * means a base appears twice in the four slots. Balanced advanced elements
 * have no such base — which is exactly why nothing counters them.
 */
export function deriveDominantBase(element: ElementId): ElementId | null {
  if (ELEMENTS[element].tier !== 3) return null;
  const composition = compositionOf(element);
  for (const founding of FOUNDING_ELEMENTS) {
    if (composition[founding] > 0.25 + 1e-9) return founding;
  }
  return null;
}

/**
 * The composed matchup multiplier between any two elements in the space.
 *
 * The edge is the composition-weighted sum of founding counters, in [-1, 1];
 * the multiplier expresses matchupEdge of it, amplified by the higher tier in
 * the pair and clamped to the band. Tier 1 against its counter lands on
 * exactly the classic 1.12 and 0.88; a balanced tier 3 composes to zero edge
 * against everything. realmMatchup below reads this table through each
 * realm's expressed element — this is the live combat rule.
 */
export function buildMatchupTable(): Float64Array {
  const size = ELEMENT_SPACE.length;
  const table = new Float64Array(size * size);
  for (let attackerIndex = 0; attackerIndex < size; attackerIndex += 1) {
    const attacker = ELEMENT_SPACE[attackerIndex]!;
    const attackComposition = compositionOf(attacker);
    for (let defenderIndex = 0; defenderIndex < size; defenderIndex += 1) {
      const defender = ELEMENT_SPACE[defenderIndex]!;
      const defenseComposition = compositionOf(defender);
      let edge = 0;
      for (const attackBase of FOUNDING_ELEMENTS) {
        for (const defenseBase of FOUNDING_ELEMENTS) {
          edge += attackComposition[attackBase]
            * defenseComposition[defenseBase]
            * counterStrength(attackBase, defenseBase);
        }
      }
      const higherTier = Math.max(
        ELEMENTS[attacker].tier,
        ELEMENTS[defender].tier,
      ) as ElementTier;
      table[attackerIndex * size + defenderIndex] = clamp(
        1 + ELEMENT_RULES.matchupEdge * edge * ELEMENT_RULES.tierAmplitude[higherTier],
        ELEMENT_RULES.matchupFloor,
        ELEMENT_RULES.matchupCeiling,
      );
    }
  }
  return table;
}

export const MATCHUP_TABLE: Float64Array = buildMatchupTable();

/** O(1) lookup into the composed table; the live combat rule. */
export function elementMultiplier(attacker: ElementId, defender: ElementId): number {
  return MATCHUP_TABLE[ELEMENT_INDEX[attacker] * ELEMENT_SPACE.length + ELEMENT_INDEX[defender]]!;
}

/** The bit each founding base occupies in a faction's baseMask. */
export const FOUNDING_BASE_BIT: Record<FoundingElementId, number> = {
  ember: 1,
  tide: 2,
  stone: 4,
  gale: 8,
};

/** The 4-bit mask of founding bases a set of held elements covers. */
export function baseMaskOf(elements: readonly ElementId[]): number {
  let mask = 0;
  for (const element of elements) {
    const composition = compositionOf(element);
    for (const founding of FOUNDING_ELEMENTS) {
      if (composition[founding] > 0) mask |= FOUNDING_BASE_BIT[founding];
    }
  }
  return mask;
}

/**
 * How much of each element's composition every possible baseMask covers,
 * precomputed so history relief stays O(1) in the per-tile combat loop.
 * Indexed element-major: element index * 16 + mask.
 */
const BASE_COVERAGE: Float64Array = (() => {
  const coverage = new Float64Array(ELEMENT_SPACE.length * 16);
  for (const element of ELEMENT_SPACE) {
    const composition = compositionOf(element);
    for (let mask = 0; mask < 16; mask += 1) {
      let covered = 0;
      for (const founding of FOUNDING_ELEMENTS) {
        if (mask & FOUNDING_BASE_BIT[founding]) covered += composition[founding];
      }
      coverage[ELEMENT_INDEX[element] * 16 + mask] = covered;
    }
  }
  return coverage;
})();

/**
 * Matchup between two players: the composed multiplier of their expressed
 * elements, graded by history.
 *
 * Whichever side sits on the wrong end of the edge softens it with what it
 * has absorbed — the share of the advantaged element's founding composition
 * its baseMask covers grades the edge down, by at most absorbedBaseRelief.
 * Matchups are therefore a continuum rather than three values, and history
 * never buys immunity: the old maximin saturated to flat 1.0 once a defender
 * held three well-chosen elements, and that failure mode is gone.
 */
export function realmMatchup(
  state: WorldState,
  attacker: PlayerId,
  defender: PlayerId,
): number {
  const attackFaction = state.factions[attacker];
  const defenseFaction = state.factions[defender];
  const edge = elementMultiplier(attackFaction.expressedElement, defenseFaction.expressedElement) - 1;
  if (edge === 0) return 1;
  const advantaged = edge > 0 ? attackFaction.expressedElement : defenseFaction.expressedElement;
  const reliefMask = edge > 0 ? defenseFaction.baseMask : attackFaction.baseMask;
  const coverage = BASE_COVERAGE[ELEMENT_INDEX[advantaged] * 16 + (reliefMask & 15)]!;
  return 1 + edge * (1 - ELEMENT_RULES.absorbedBaseRelief * coverage);
}

export function realmMatchupLabel(
  state: WorldState,
  attacker: PlayerId,
  defender: PlayerId,
): string {
  const value = realmMatchup(state, attacker, defender);
  if (value > 1) return "elemental edge";
  if (value < 1) return "elemental risk";
  return "even elements";
}

/**
 * Trade forms on their carriers.
 *
 * Every element trades through one or two of the four forms, and every form
 * owns a distinct carrier: land is the road-and-rail network and whatever
 * rolls over it — wagons, cars, trains, any convoy the land carries;
 * waterway is the harbors and their ships; energy is the power plants and
 * the straight conduits they string to nearby stations; airborne is the
 * skyports flying freight point to point over anything. The helpers below
 * are the whole of how the simulation reads trade forms: income rides
 * tradeFormIncomeMultiplier, foreign hosting rides tradeHostShare, and
 * construction leans through buildAffinityOf.
 */

/** The form each carrier's vehicle trades by. */
export const VEHICLE_FORM: Record<TradeVehicleKind, TradeForm> = {
  train: "land",
  ship: "waterway",
  pulse: "energy",
  flyer: "airborne",
};

/** Whether an element's civilization trades by the given form. */
export function tradesBy(element: ElementId, form: TradeForm): boolean {
  return ELEMENTS[element].tradeForms.includes(form);
}

/** How many trade forms two elements share — the resonance between them. */
export function sharedTradeForms(first: ElementId, second: ElementId): number {
  let shared = 0;
  for (const form of ELEMENTS[first].tradeForms) {
    if (ELEMENTS[second].tradeForms.includes(form)) shared += 1;
  }
  return shared;
}

/**
 * The income multiplier a realm's trade earns on a carrier: the flat bonus
 * when the expressed element trades by that form, and exactly 1 otherwise.
 * Rewards only — nothing a realm does not hold ever pays less than today.
 */
export function tradeFormIncomeMultiplier(element: ElementId, form: TradeForm): number {
  return tradesBy(element, form) ? 1 + ELEMENT_RULES.tradeFormIncomeBonus : 1;
}

/**
 * The host's share of a foreign delivery, on every carrier that pays a host
 * on arrival: the stranger's rate, raised by trade-form resonance between
 * the parties, with allied standing still paying best. The best applicable
 * rate wins, so resonance never costs a host what diplomacy already earned.
 */
export function tradeHostShare(shared: number, allied: boolean): number {
  const resonant = shared >= 2
    ? ELEMENT_RULES.resonantHostShareTwo
    : shared >= 1
      ? ELEMENT_RULES.resonantHostShareOne
      : TRADE_RULES.foreignHostShare;
  return Math.max(allied ? TRADE_RULES.alliedHostShare : 0, resonant);
}

export interface BuildAffinity {
  /** Multiplier on the city shortfall when choosing what to build next. */
  city: number;
  /** Multiplier on the factory-and-harbor shortfall in the same choice. */
  trade: number;
  /** Weight on the plant shortfall; zero for realms without the energy form. */
  plant: number;
  /** Weight on the skyport shortfall; zero without the airborne form. */
  skyport: number;
  /** Harbor share of the trade buildings a realm wants. */
  harborShare: number;
  /** Running cap on harbors as a fraction of trade buildings standing. */
  harborCap: number;
  /** Factories a realm must run before it reaches for a harbor. */
  harborPrerequisite: number;
}

const BUILD_AFFINITIES = new Map<ElementId, BuildAffinity>();

/**
 * How an element's trade forms lean its construction program, composed with
 * the strategy quotas by the construction planner. A waterway realm reaches
 * for harbors hardest and wants half again the harbor share; an energy realm
 * reaches for the power plants only it may raise, an airborne realm for its
 * skyports; a land realm lets the road-laying trade buildings jump the queue
 * ahead of its cities without wanting fewer of either. A zero plant or
 * skyport weight is the gate itself: a realm without the form never reaches
 * for the carrier.
 */
export function buildAffinityOf(element: ElementId): BuildAffinity {
  const cached = BUILD_AFFINITIES.get(element);
  if (cached) return cached;
  const waterway = tradesBy(element, "waterway");
  const affinity: BuildAffinity = {
    city: tradesBy(element, "land") ? ELEMENT_RULES.buildAffinity.city : 1,
    trade: waterway ? ELEMENT_RULES.buildAffinity.harbor : 1,
    plant: tradesBy(element, "energy") ? ELEMENT_RULES.buildAffinity.plant : 0,
    skyport: tradesBy(element, "airborne") ? ELEMENT_RULES.buildAffinity.skyport : 0,
    harborShare: waterway
      ? ELEMENT_RULES.waterwayHarborTradeShare
      : ELEMENT_RULES.harborTradeShare,
    harborCap: waterway
      ? ELEMENT_RULES.waterwayHarborTradeCap
      : ELEMENT_RULES.harborTradeCap,
    harborPrerequisite: waterway
      ? ELEMENT_RULES.waterwayHarborFactoryPrerequisite
      : ELEMENT_RULES.harborFactoryPrerequisite,
  };
  BUILD_AFFINITIES.set(element, affinity);
  return affinity;
}
