import { ELEMENTS, ELEMENT_SPACE, FOUNDING_ELEMENTS, compositionOf } from "./elements";
import { ELEMENT_RULES } from "./rules";
import type {
  ElementId,
  ElementTier,
  FactionState,
  FoundingElementId,
  PlayerId,
  WorldState,
} from "./types";

/**
 * Ascension: how a realm's conquests become a higher element.
 *
 * The element system's progression rule, filled in from the mechanics the
 * engine already had. The two tiers form differently, by design:
 *
 * - **Tier 2 is grown from founding depth.** Every conquered realm's
 *   elementCounts transfer to its conqueror, depth in each founding base
 *   accumulates from everything absorbed — a conquered Steam realm feeds
 *   both ember and tide — and a compound becomes expressible when both its
 *   founding bases are covered deeply enough.
 * - **Tier 3 is the union of two actual tier 2 elements.** It is never
 *   assembled from founding arithmetic: a realm must genuinely hold both
 *   compound constituents in its absorbed history — its own expression is
 *   one; conquering a realm that holds the other is the way to the second.
 *   A magma realm that claims an ice realm becomes obsidian, not whatever
 *   its founding depths lean toward. This is also what makes the balanced
 *   trio reachable at all: candidacy is gated by the compounds actually
 *   united, not by a support race the dominant elements always win.
 *
 * Expression only ever upgrades. All of it is pure arithmetic over integer
 * tallies, exact binary compositions and the held-element set, so
 * recomputing is deterministic and order-independent.
 */

/**
 * How many slots a founding base fills in an element's founding-base
 * multiset: one slot of one for tier 1, two of two for tier 2, four of four
 * for tier 3 (a dominant tier 3 fills two with its repeated base). Exact
 * small integers, derived from composition rather than authored.
 */
function baseMultiplicity(element: ElementId, base: FoundingElementId): number {
  return compositionOf(element)[base] * 2 ** (ELEMENTS[element].tier - 1);
}

/** Absorbed depth in each founding base, from a realm's conquest tallies. */
export function baseDepthsOf(
  counts: Partial<Record<ElementId, number>>,
): Record<FoundingElementId, number> {
  const depths: Record<FoundingElementId, number> = { ember: 0, tide: 0, stone: 0, gale: 0 };
  for (const [element, count] of Object.entries(counts) as Array<[ElementId, number]>) {
    if (!count) continue;
    for (const base of FOUNDING_ELEMENTS) {
      depths[base] += count * baseMultiplicity(element, base);
    }
  }
  return depths;
}

export function totalRealmsAbsorbed(counts: Partial<Record<ElementId, number>>): number {
  let total = 0;
  for (const count of Object.values(counts)) total += count ?? 0;
  return total;
}

/**
 * Whether a history can express an element: a tier 2 needs both founding
 * constituents held at depth, a tier 3 needs both actual compound
 * constituents present in the realm's absorbed history and a long enough
 * conquest record altogether. Depth never substitutes for a compound — the
 * union of the two tier 2 elements is the whole rule.
 */
export function isFormable(
  element: ElementId,
  depths: Record<FoundingElementId, number>,
  total: number,
  held: readonly ElementId[],
): boolean {
  const definition = ELEMENTS[element];
  if (definition.tier === 1) return depths[element as FoundingElementId] >= 1;
  if (definition.tier === 2) {
    return definition.bases.every(
      (base) => depths[base as FoundingElementId] >= ELEMENT_RULES.tier2BaseDepth,
    );
  }
  return total >= ELEMENT_RULES.tier3MinimumRealms
    && definition.bases.every((base) => held.includes(base));
}

/**
 * How close a history is to forming an element, 0..1, limited by its least
 * satisfied requirement. One is formable now. For a tier 3 the requirement
 * is the two compounds themselves: each constituent actually held is half
 * the way there, and no amount of founding depth advances the other half —
 * only conquest of a realm that holds it does.
 */
export function formationProgress(
  element: ElementId,
  depths: Record<FoundingElementId, number>,
  total: number,
  held: readonly ElementId[],
): number {
  const definition = ELEMENTS[element];
  if (definition.tier === 1) return Math.min(1, depths[element as FoundingElementId]);
  if (definition.tier === 2) {
    return definition.bases.reduce(
      (least, base) => Math.min(
        least,
        depths[base as FoundingElementId] / ELEMENT_RULES.tier2BaseDepth,
      ),
      1,
    );
  }
  const heldConstituents = definition.bases.filter((base) => held.includes(base)).length;
  return Math.min(
    heldConstituents / definition.bases.length,
    total / ELEMENT_RULES.tier3MinimumRealms,
    1,
  );
}

/**
 * The element a realm's history now expresses.
 *
 * Picks the highest formable tier above the current expression; within a
 * tier, the element whose composition its absorbed depth supports most, with
 * ELEMENT_SPACE order as the final tie-break. Never returns a lower or equal
 * tier — expression upgrades or stands, so there is no flapping and no
 * demotion: history determines what a realm has learned not to forget.
 */
export function expressionFor(
  faction: Pick<FactionState, "expressedElement" | "elementCounts" | "absorbedElements">,
): ElementId {
  const currentTier = ELEMENTS[faction.expressedElement].tier;
  if (currentTier === 3) return faction.expressedElement;
  const depths = baseDepthsOf(faction.elementCounts);
  const total = totalRealmsAbsorbed(faction.elementCounts);
  let best = faction.expressedElement;
  let bestTier: ElementTier = currentTier;
  let bestSupport = Number.NEGATIVE_INFINITY;
  for (const element of ELEMENT_SPACE) {
    const tier = ELEMENTS[element].tier;
    if (tier <= currentTier) continue;
    if (!isFormable(element, depths, total, faction.absorbedElements)) continue;
    const composition = compositionOf(element);
    // Exact arithmetic: dyadic compositions times integer depths.
    const support = FOUNDING_ELEMENTS.reduce(
      (sum, base) => sum + composition[base] * depths[base],
      0,
    );
    if (tier > bestTier || (tier === bestTier && support > bestSupport)) {
      best = element;
      bestTier = tier;
      bestSupport = support;
    }
  }
  return best;
}

/**
 * The realm's most advanced next-rung prospect: the element one tier above
 * its expression that its history is closest to forming. Null at tier 3 —
 * there is nowhere higher.
 */
export function nextFormable(
  faction: Pick<FactionState, "expressedElement" | "elementCounts" | "absorbedElements">,
): { element: ElementId; progress: number } | null {
  const nextTier = ELEMENTS[faction.expressedElement].tier + 1;
  if (nextTier > 3) return null;
  const depths = baseDepthsOf(faction.elementCounts);
  const total = totalRealmsAbsorbed(faction.elementCounts);
  let best: { element: ElementId; progress: number } | null = null;
  for (const element of ELEMENT_SPACE) {
    if (ELEMENTS[element].tier !== nextTier) continue;
    const progress = formationProgress(element, depths, total, faction.absorbedElements);
    if (!best || progress > best.progress) best = { element, progress };
  }
  return best;
}

/**
 * How much absorbing the target would advance the actor toward its next
 * tier, 0..1. This is the strategy system's answer to "how does the AI
 * pursue tiers": the war scorers scale it by the realm's ascension weight,
 * so a mastery-minded court hunts the histories it is missing — and above
 * tier 1 those histories are held compounds, so an ascension-minded tier 2
 * realm hunts other ascended civilizations specifically.
 */
export function ascensionAppetite(
  state: WorldState,
  actor: PlayerId,
  target: PlayerId,
): number {
  const self = state.factions[actor];
  const rival = state.factions[target];
  const nextTier = ELEMENTS[self.expressedElement].tier + 1;
  if (nextTier > 3) return 0;
  const depths = baseDepthsOf(self.elementCounts);
  const total = totalRealmsAbsorbed(self.elementCounts);
  const merged = baseDepthsOf(rival.elementCounts);
  for (const base of FOUNDING_ELEMENTS) merged[base] += depths[base];
  const mergedTotal = total + totalRealmsAbsorbed(rival.elementCounts);
  const mergedHeld = [...new Set([...self.absorbedElements, ...rival.absorbedElements])];
  let current = 0;
  let afterConquest = 0;
  for (const element of ELEMENT_SPACE) {
    if (ELEMENTS[element].tier !== nextTier) continue;
    current = Math.max(
      current,
      formationProgress(element, depths, total, self.absorbedElements),
    );
    afterConquest = Math.max(
      afterConquest,
      formationProgress(element, merged, mergedTotal, mergedHeld),
    );
  }
  return Math.max(0, afterConquest - current);
}

/** The display suffix an ascended realm carries; null while founding-expressed. */
export function ascensionTitle(
  faction: Pick<FactionState, "element" | "expressedElement">,
): string | null {
  return faction.expressedElement === faction.element
    ? null
    : `${ELEMENTS[faction.expressedElement].name}-ascended`;
}
