import { ELEMENTS, ELEMENT_SPACE, FOUNDING_ELEMENTS, compositionOf } from "./elements";
import type {
  ElementId,
  FactionState,
  FoundingElementId,
  PlayerId,
  TransmutationState,
  WorldState,
} from "./types";

/**
 * Ascension: how a realm's conquests become a higher element.
 *
 * The crucible of conquest. Annexation is the only way elements enter a
 * realm — a fallen realm's held elements and tallies transfer whole to its
 * conqueror — and the moment one realm holds both constituents of a higher
 * element, they fuse. The fusion is delivered through a transmutation
 * window rather than an instant flip: the realm spends the window visibly
 * in flux and emerges expressing the fused element. Eligibility climbs the
 * ladder one rung at a time — a tier 2 needs both of its founding bases
 * held, a tier 3 needs both of its compound constituents held as elements
 * in their own right — so tier 3 is earned by conquering the transmuted,
 * never assembled quietly out of raw tallies. Expression still only ever
 * upgrades. All of it is pure arithmetic over held-element sets and integer
 * tallies, so recomputing is deterministic and order-independent.
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

/** The idle window every realm wakes with; revival hands out a fresh one. */
export function createTransmutationState(): TransmutationState {
  return { target: null, from: null, startedAt: -1, completesAt: -1, completed: 0 };
}

/** Whether the realm is inside a transmutation window — visibly in flux. */
export function transmuting(faction: Pick<FactionState, "transmutation">): boolean {
  return faction.transmutation.target !== null;
}

/** The distinct elements a realm holds: its absorbed set plus its expression. */
function heldElementsOf(
  faction: Pick<FactionState, "expressedElement" | "absorbedElements">,
): Set<ElementId> {
  const held = new Set<ElementId>(faction.absorbedElements);
  held.add(faction.expressedElement);
  return held;
}

/** How many of an element's constituents a held set covers, 0..2. */
function constituentsHeld(element: ElementId, held: ReadonlySet<ElementId>): number {
  let count = 0;
  for (const base of ELEMENTS[element].bases) {
    if (held.has(base)) count += 1;
  }
  return count;
}

/**
 * How strongly a realm's conquest record leans toward an element: exact
 * dyadic composition times integer base depths. Used only to break ties
 * between simultaneously eligible fusions, so the crown goes to the history
 * that earned it hardest.
 */
function supportFor(
  element: ElementId,
  depths: Record<FoundingElementId, number>,
): number {
  const composition = compositionOf(element);
  return FOUNDING_ELEMENTS.reduce((sum, base) => sum + composition[base] * depths[base], 0);
}

/**
 * The fusion a realm's held elements make eligible, or null.
 *
 * Eligibility looks exactly one rung up — each rung pays a window of its
 * own, so a conqueror of two transmuted realms still climbs tier by tier.
 * Among several eligible elements the deepest-supported history wins, with
 * ELEMENT_SPACE order as the final tie-break.
 */
export function fusionTargetFor(
  faction: Pick<FactionState, "expressedElement" | "absorbedElements" | "elementCounts">,
): ElementId | null {
  const nextTier = ELEMENTS[faction.expressedElement].tier + 1;
  if (nextTier > 3) return null;
  const held = heldElementsOf(faction);
  const depths = baseDepthsOf(faction.elementCounts);
  let best: ElementId | null = null;
  let bestSupport = Number.NEGATIVE_INFINITY;
  for (const element of ELEMENT_SPACE) {
    if (ELEMENTS[element].tier !== nextTier) continue;
    if (constituentsHeld(element, held) < 2) continue;
    const support = supportFor(element, depths);
    if (support > bestSupport) {
      best = element;
      bestSupport = support;
    }
  }
  return best;
}

/**
 * The realm's most advanced next-rung prospect: the element one tier above
 * its expression whose constituents it holds most of, progress as the held
 * share. Null at tier 3 — there is nowhere higher.
 */
export function nextFormable(
  faction: Pick<FactionState, "expressedElement" | "absorbedElements" | "elementCounts">,
): { element: ElementId; progress: number } | null {
  const nextTier = ELEMENTS[faction.expressedElement].tier + 1;
  if (nextTier > 3) return null;
  const held = heldElementsOf(faction);
  const depths = baseDepthsOf(faction.elementCounts);
  let best: { element: ElementId; progress: number } | null = null;
  let bestSupport = Number.NEGATIVE_INFINITY;
  for (const element of ELEMENT_SPACE) {
    if (ELEMENTS[element].tier !== nextTier) continue;
    const progress = constituentsHeld(element, held) / 2;
    const support = supportFor(element, depths);
    if (!best || progress > best.progress || (progress === best.progress && support > bestSupport)) {
      best = { element, progress };
      bestSupport = support;
    }
  }
  return best;
}

/**
 * How much absorbing the target would advance the actor toward its next
 * tier, 0..1. This is the strategy system's answer to "how does the AI
 * pursue tiers": the war scorers scale it by the realm's ascension weight,
 * so a mastery-minded court hunts the elements it is missing. A target
 * whose held elements complete a fusion outright is worth the full pull; a
 * target supplying one of two missing constituents is worth half.
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
  const held = heldElementsOf(self);
  const merged = new Set(held);
  for (const element of rival.absorbedElements) merged.add(element);
  merged.add(rival.expressedElement);
  let current = 0;
  let afterConquest = 0;
  for (const element of ELEMENT_SPACE) {
    if (ELEMENTS[element].tier !== nextTier) continue;
    current = Math.max(current, constituentsHeld(element, held) / 2);
    afterConquest = Math.max(afterConquest, constituentsHeld(element, merged) / 2);
  }
  if (afterConquest >= 1 && current < 1) return 1;
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
