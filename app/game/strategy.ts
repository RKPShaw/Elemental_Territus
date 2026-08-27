import { ELEMENTS } from "./elements";
import { PLAYER_ORDER } from "./players";
import { warsFor } from "./diplomacy";
import { STRATEGY_RULES, clamp } from "./rules";
import { cellNoise, hashSeed } from "./random";
import type {
  ElementId,
  PlayerId,
  StrategicDomain,
  StrategicPriorities,
  WorldState,
} from "./types";

/**
 * Strategic priorities: the connective tissue between what an element *is*
 * and what its realms *do*.
 *
 * Each realm carries normalized weights over the domains below. Its element
 * seeds them — the temperament line on every element definition, made
 * mechanical — a stable personality noise separates siblings, and the
 * situation bends them each recompute. Consumers read the weights only
 * through strategyFactor(), a multiplier clamped to a band centred on 1, so
 * priorities influence every decision and gate none of them.
 */

/** Fixed order: deterministic iteration and the tie-break for focus. */
export const STRATEGIC_DOMAINS: readonly StrategicDomain[] = [
  "economy",
  "conquest",
  "ascension",
  "diplomacy",
  "defense",
  "trade",
] as const;

export const DOMAIN_LABELS: Record<StrategicDomain, string> = {
  economy: "the economy",
  conquest: "conquest",
  ascension: "elemental mastery",
  diplomacy: "diplomacy",
  defense: "defense",
  trade: "trade",
};

const PROFILE_CACHE = new Map<ElementId, Record<StrategicDomain, number>>();

function normalized(weights: Record<StrategicDomain, number>): Record<StrategicDomain, number> {
  const floored = {} as Record<StrategicDomain, number>;
  let total = 0;
  for (const domain of STRATEGIC_DOMAINS) {
    floored[domain] = Math.max(0.01, weights[domain]);
    total += floored[domain];
  }
  for (const domain of STRATEGIC_DOMAINS) floored[domain] /= total;
  return floored;
}

/**
 * An element's baseline priorities. The founding families author theirs;
 * everything else is the normalized blend of what it is made of, so a
 * compound's civilization leans the way its parents lean.
 */
export function priorityProfileOf(element: ElementId): Record<StrategicDomain, number> {
  const cached = PROFILE_CACHE.get(element);
  if (cached) return cached;
  const definition = ELEMENTS[element];
  let profile: Record<StrategicDomain, number>;
  if (definition.priorityProfile) {
    profile = normalized({ ...definition.priorityProfile });
  } else {
    const blended = {} as Record<StrategicDomain, number>;
    for (const domain of STRATEGIC_DOMAINS) blended[domain] = 0;
    for (const base of definition.bases) {
      const inner = priorityProfileOf(base);
      for (const domain of STRATEGIC_DOMAINS) {
        blended[domain] += inner[domain] / definition.bases.length;
      }
    }
    profile = normalized(blended);
  }
  PROFILE_CACHE.set(element, profile);
  return profile;
}

/**
 * Stable per-realm personality: a fixed offset per domain, hashed from the
 * world seed and the player id rather than drawn from the engine stream, so
 * twelve siblings of one family want subtly different things for the whole
 * game.
 */
function personalityOffset(seed: number, id: PlayerId, domainIndex: number): number {
  const noise = cellNoise(seed ^ 0x517a7e97, hashSeed(id), domainIndex);
  return (noise - 0.5) * 2 * STRATEGY_RULES.noiseAmplitude;
}

function focusOf(weights: Record<StrategicDomain, number>): StrategicDomain {
  let focus: StrategicDomain = STRATEGIC_DOMAINS[0]!;
  for (const domain of STRATEGIC_DOMAINS) {
    if (weights[domain] > weights[focus]) focus = domain;
  }
  return focus;
}

/** A realm's opening posture: its element's way, coloured by personality. */
export function initialStrategy(seed: number, id: PlayerId, element: ElementId): StrategicPriorities {
  const profile = priorityProfileOf(element);
  const weights = {} as Record<StrategicDomain, number>;
  STRATEGIC_DOMAINS.forEach((domain, index) => {
    weights[domain] = profile[domain] + personalityOffset(seed, id, index);
  });
  const settled = normalized(weights);
  return {
    weights: settled,
    focus: focusOf(settled),
    adoptedAt: 0,
    reason: `The ${ELEMENTS[element].name} way.`,
  };
}

/**
 * Recompute a realm's priorities from its element, personality and moment.
 * Pure with respect to the world state — the planning system decides when to
 * call it and what to do with a changed focus.
 */
export function recomputePriorities(
  state: WorldState,
  id: PlayerId,
): { weights: Record<StrategicDomain, number>; focus: StrategicDomain; reason: string } {
  const faction = state.factions[id];
  // The expressed element, not the founding family: an ascended civilization's
  // standing priorities lean the way of what it has become.
  const profile = priorityProfileOf(faction.expressedElement);
  const weights = {} as Record<StrategicDomain, number>;
  STRATEGIC_DOMAINS.forEach((domain, index) => {
    weights[domain] = profile[domain] + personalityOffset(state.seed, id, index);
  });

  const wars = warsFor(state, id).length;
  const invaded = state.campaigns.some(
    (campaign) => campaign.target === id && campaign.remaining > 0,
  );
  let hegemonShare = 0;
  for (const rivalId of PLAYER_ORDER) {
    if (rivalId === id) continue;
    const rival = state.factions[rivalId];
    if (!rival.alive) continue;
    hegemonShare = Math.max(hegemonShare, rival.territory / state.landTiles);
  }
  const hegemonLooms = hegemonShare > STRATEGY_RULES.hegemonShareThreshold;
  const weary = faction.warWeariness > 0.2;
  const rich = faction.gold >= STRATEGY_RULES.richTreasuryFloor;

  if (invaded) weights.defense += STRATEGY_RULES.threatDefenseSurge;
  if (wars > 0) weights.conquest += STRATEGY_RULES.warConquestSurge;
  weights.diplomacy += faction.warWeariness * STRATEGY_RULES.wearinessDiplomacySurge;
  if (hegemonLooms) weights.diplomacy += STRATEGY_RULES.hegemonDiplomacySurge;
  if (rich) weights.economy += STRATEGY_RULES.richEconomySurge;
  if (wars === 0) weights.trade += STRATEGY_RULES.peacefulTradeSurge;

  const settled = normalized(weights);
  const focus = focusOf(settled);
  // The reason explains the focus that actually won, not merely the loudest
  // pressure — a realm turning to diplomacy mid-war is weary, not warlike.
  const reason = focus === "defense" && invaded
    ? "Invaders press the realm; the walls come first."
    : focus === "diplomacy" && hegemonLooms
      ? "A hegemon looms; friends matter more than fields."
      : focus === "diplomacy" && weary
        ? "The realm wearies of war and looks to the table."
        : focus === "economy" && rich
          ? "The treasury outruns the works."
          : focus === "conquest" && wars > 0
            ? "War concentrates the mind."
            : focus === "trade" && wars === 0
              ? "Peace favors the merchants."
              : `The ${ELEMENTS[faction.expressedElement].name} way.`;
  return { weights: settled, focus, reason };
}

/**
 * How strongly a realm's priorities push one domain, as a multiplier: 1 at
 * the uniform share, amplified or damped inside the band. This is the only
 * way simulation systems may read the weights.
 */
export function strategyFactor(strategy: StrategicPriorities, domain: StrategicDomain): number {
  return clamp(
    strategy.weights[domain] * STRATEGIC_DOMAINS.length,
    STRATEGY_RULES.factorFloor,
    STRATEGY_RULES.factorCeiling,
  );
}

/** The damped variant construction quotas use, so counts drift rather than lurch. */
export function strategyQuotaFactor(strategy: StrategicPriorities, domain: StrategicDomain): number {
  return 1 + (strategyFactor(strategy, domain) - 1) * STRATEGY_RULES.quotaDamping;
}
