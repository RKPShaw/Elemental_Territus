import { ELEMENTS, ELEMENT_SPACE, ELEMENT_INDEX, FOUNDING_ELEMENTS, compositionOf } from "./elements";
import { LAND_TERRAINS, TERRAFORM_RULES, clamp } from "./rules";
import type { ElementId, FoundingElementId, LandTerrainId, TerrainId } from "./types";

/**
 * The living land: what long tenure does to the ground, and what the ground
 * does back.
 *
 * Two tables, both resolved at module load into O(1) lookups:
 *
 * TRANSFORMS — land an element has held past a dwell threshold changes
 * terrain. The current terrain is the whole memory the mechanic needs:
 * because a transform reads (terrain, owner's element, tenure) and nothing
 * else, sequences fall out for free — Ember scorches the plains, Fungus
 * takes the scorch and mires it, and the mire remembers both without a
 * single new cell field. Most elements derive their transforms from the
 * founding bases that dominate their composition; the authored entries
 * replace the derivation for elements whose mark wants its own voice.
 * An element with no entry for a terrain leaves it alone — some elements
 * leave no mark, which is also a mark.
 *
 * LEANS — how well each element fights, earns and sustains on each terrain,
 * a signed −1..+1 lean composed from founding-base leans through exact
 * composition, with authored accents for the stars (obsidian thrives on
 * basalt, fungus withers on scorch). The lean becomes a multiplier inside
 * the affinity band at three chokepoints: invasion cost of the defender's
 * ground, land income, and troop sustain.
 */

export interface TerraformTransform {
  to: LandTerrainId;
  dwellTicks: number;
}

type TransformRule = TerraformTransform & { from: LandTerrainId };

const rule = (from: LandTerrainId, to: LandTerrainId, dwellTicks: number): TransformRule =>
  ({ from, to, dwellTicks });

/** What each founding base does to land it dominates. */
const BASE_TRANSFORMS: Record<FoundingElementId, readonly TransformRule[]> = {
  ember: [
    rule("forest", "scorched", 3_000),
    rule("plains", "scorched", 3_600),
    rule("farmland", "scorched", 4_800),
    rule("glacier", "mountains", 4_800),
  ],
  tide: [
    rule("plains", "marsh", 3_600),
    rule("scorched", "marsh", 4_200),
    rule("farmland", "marsh", 4_800),
  ],
  stone: [
    rule("hills", "terrace", 4_200),
    rule("plains", "terrace", 6_000),
  ],
  gale: [
    rule("scorched", "duneland", 3_600),
    rule("plains", "duneland", 4_200),
    rule("farmland", "duneland", 6_000),
  ],
};

/**
 * Authored transform sets. An entry here replaces the base derivation for
 * that element entirely, so a compound's mark can differ from the sum of its
 * halves: steam drowns what raw ember would burn, ash reforests the ruin its
 * magma half made, tempest fells forests flat and plants nothing.
 */
const ELEMENT_TRANSFORMS: Partial<Record<ElementId, readonly TransformRule[]>> = {
  steam: [
    rule("scorched", "marsh", 3_600),
    rule("plains", "marsh", 4_200),
    rule("farmland", "marsh", 5_400),
  ],
  magma: [
    rule("forest", "scorched", 3_000),
    rule("plains", "scorched", 3_600),
    rule("glacier", "mountains", 3_600),
    rule("scorched", "basalt", 6_000),
    rule("hills", "basalt", 7_200),
  ],
  lightning: [
    rule("forest", "scorched", 4_200),
    rule("plains", "scorched", 4_800),
  ],
  ice: [
    rule("mountains", "glacier", 4_800),
    rule("marsh", "glacier", 6_000),
    rule("hills", "glacier", 7_200),
  ],
  grove: [
    rule("plains", "verdant", 4_200),
    rule("farmland", "verdant", 5_400),
    rule("marsh", "verdant", 6_000),
    rule("scorched", "forest", 7_200),
  ],
  sand: [
    rule("plains", "duneland", 3_600),
    rule("farmland", "duneland", 4_800),
    rule("verdant", "duneland", 7_200),
  ],
  geyser: [
    rule("scorched", "marsh", 4_200),
    rule("plains", "marsh", 4_800),
    rule("farmland", "marsh", 6_000),
  ],
  tempest: [
    rule("forest", "plains", 7_200),
  ],
  bloom: [
    rule("plains", "verdant", 3_000),
    rule("farmland", "verdant", 3_600),
    rule("marsh", "verdant", 3_600),
    rule("scorched", "verdant", 6_000),
  ],
  fungus: [
    rule("scorched", "sporemire", 3_600),
    rule("marsh", "sporemire", 3_600),
    rule("forest", "sporemire", 4_800),
    rule("verdant", "sporemire", 6_000),
  ],
  obsidian: [
    rule("scorched", "basalt", 4_800),
    rule("plains", "scorched", 4_800),
    rule("hills", "basalt", 6_000),
  ],
  ash: [
    rule("scorched", "forest", 6_000),
    rule("hills", "terrace", 6_000),
  ],
  aurora: [
    rule("mountains", "glacier", 7_200),
  ],
};

/** Signed −1..+1: how each founding base leans on each terrain. */
const BASE_TERRAIN_LEAN: Record<FoundingElementId, Partial<Record<LandTerrainId, number>>> = {
  ember: { scorched: 1, basalt: 0.6, hills: 0.2, glacier: -0.8, marsh: -0.6 },
  tide: { marsh: 1, farmland: 0.4, verdant: 0.2, scorched: -0.8, duneland: -0.6 },
  stone: { terrace: 1, mountains: 0.5, basalt: 0.5, hills: 0.3, marsh: -0.5, duneland: -0.3 },
  gale: { duneland: 1, plains: 0.4, glacier: 0.3, sporemire: -0.5, forest: -0.3 },
};

/**
 * Authored accents added on top of the composed base leans — the pairings
 * the design names outright: obsidian loves the burned and hardened ground,
 * fungus thrives in its mires and withers on open scorch, ice belongs to
 * its glaciers.
 */
const ELEMENT_LEAN_OVERRIDES: Partial<Record<ElementId, Partial<Record<LandTerrainId, number>>>> = {
  steam: { marsh: 0.6, scorched: 0.2 },
  magma: { basalt: 0.8, scorched: 0.6, glacier: -0.6 },
  ice: { glacier: 1.2, scorched: -0.5 },
  grove: { verdant: 1.2, forest: 0.6 },
  bloom: { verdant: 1.4, marsh: 0.4 },
  mist: { marsh: 0.6, forest: 0.3 },
  ash: { scorched: 0.6, forest: 0.6 },
  obsidian: { basalt: 1.2, scorched: 0.8, glacier: 0.3 },
  amber: { forest: 0.6 },
  fungus: { sporemire: 1.4, scorched: -1, forest: 0.4, marsh: 0.3 },
  crystal: { glacier: 0.6, duneland: 0.4 },
};

/** The terrains only terraforming can place; worldgen never emits these. */
export const TERRAFORMED_TERRAINS: readonly LandTerrainId[] = [
  "scorched",
  "marsh",
  "duneland",
  "terrace",
  "glacier",
  "basalt",
  "sporemire",
  "verdant",
] as const;

const TERRAIN_ORDER: readonly TerrainId[] = ["water", ...LAND_TERRAINS];
const TERRAIN_INDEX = new Map<TerrainId, number>(
  TERRAIN_ORDER.map((terrain, index) => [terrain, index]),
);

function transformRulesFor(element: ElementId): readonly TransformRule[] {
  const authored = ELEMENT_TRANSFORMS[element];
  if (authored) return authored;
  const composition = compositionOf(element);
  const derived: TransformRule[] = [];
  const taken = new Set<LandTerrainId>();
  for (const base of FOUNDING_ELEMENTS) {
    if (composition[base] < TERRAFORM_RULES.baseCompositionThreshold) continue;
    for (const entry of BASE_TRANSFORMS[base]) {
      // First base in founding order claims a contested source terrain.
      if (taken.has(entry.from)) continue;
      taken.add(entry.from);
      derived.push(entry);
    }
  }
  return derived;
}

/** element → (from-terrain → transform), resolved once at module load. */
export const TERRAFORM_TABLE: ReadonlyMap<ElementId, ReadonlyMap<LandTerrainId, TerraformTransform>> =
  new Map(ELEMENT_SPACE.map((element) => [
    element,
    new Map(transformRulesFor(element).map((entry) => [
      entry.from,
      { to: entry.to, dwellTicks: entry.dwellTicks },
    ])),
  ]));

/**
 * element → the terrains its dwell produces, counting only terraformed
 * ground: the ground that is unmistakably "its own". Transforms that restore
 * a worldgen terrain (ember melting a glacier back to mountains, ash growing
 * forest out of scorch, tempest felling forest to plains) leave no signature
 * — natural country a realm merely holds must never read as saturation.
 */
const TERRAFORMED_SET = new Set<TerrainId>(TERRAFORMED_TERRAINS);
const SIGNATURE_TERRAINS: ReadonlyMap<ElementId, ReadonlySet<TerrainId>> = new Map(
  ELEMENT_SPACE.map((element) => [
    element,
    new Set([...TERRAFORM_TABLE.get(element)!.values()]
      .map((entry) => entry.to)
      .filter((terrain) => TERRAFORMED_SET.has(terrain))),
  ]),
);

const EMPTY_SIGNATURE: ReadonlySet<TerrainId> = new Set();

/** The transform an element's dwell works on this terrain, or null. */
export function terraformTargetAt(
  element: ElementId,
  terrain: TerrainId,
): TerraformTransform | null {
  if (terrain === "water") return null;
  return TERRAFORM_TABLE.get(element)?.get(terrain) ?? null;
}

/** The terrains an element's own dwell produces. */
export function signatureTerrainsOf(element: ElementId): ReadonlySet<TerrainId> {
  return SIGNATURE_TERRAINS.get(element) ?? EMPTY_SIGNATURE;
}

const LEAN_TABLE: Float64Array = (() => {
  const table = new Float64Array(ELEMENT_SPACE.length * TERRAIN_ORDER.length);
  for (const element of ELEMENT_SPACE) {
    const composition = compositionOf(element);
    const overrides = ELEMENT_LEAN_OVERRIDES[element];
    for (const terrain of LAND_TERRAINS) {
      let lean = 0;
      for (const base of FOUNDING_ELEMENTS) {
        lean += composition[base] * (BASE_TERRAIN_LEAN[base][terrain] ?? 0);
      }
      lean += overrides?.[terrain] ?? 0;
      table[ELEMENT_INDEX[element] * TERRAIN_ORDER.length + TERRAIN_INDEX.get(terrain)!] = lean;
    }
  }
  return table;
})();

const AFFINITY_TABLE: Float64Array = (() => {
  const table = new Float64Array(LEAN_TABLE.length);
  for (let index = 0; index < table.length; index += 1) {
    table[index] = clamp(
      1 + TERRAFORM_RULES.affinityBand * LEAN_TABLE[index]!,
      TERRAFORM_RULES.affinityFloor,
      TERRAFORM_RULES.affinityCeiling,
    );
  }
  return table;
})();

/** Signed lean of an element on a terrain; 0 for water and unlisted pairs. */
export function terrainLeanOf(element: ElementId, terrain: TerrainId): number {
  return LEAN_TABLE[ELEMENT_INDEX[element] * TERRAIN_ORDER.length + TERRAIN_INDEX.get(terrain)!]!;
}

/**
 * The band-clamped multiplier a realm's expressed element earns on a
 * terrain. Multiplies the invasion cost of its ground, its land income and
 * its troop sustain — favorable ground is worth holding three times over.
 */
export function terrainAffinityFactor(element: ElementId, terrain: TerrainId): number {
  return AFFINITY_TABLE[ELEMENT_INDEX[element] * TERRAIN_ORDER.length + TERRAIN_INDEX.get(terrain)!]!;
}
