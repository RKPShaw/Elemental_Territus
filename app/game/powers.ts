import { transmuting } from "./ascension";
import { POWER_RULES, TRANSMUTATION_RULES, clamp } from "./rules";
import type {
  ElementId,
  ElementPowerState,
  FactionState,
  PlayerId,
  WorldState,
} from "./types";

/**
 * Elemental powers: what an advanced element *does*, beyond what it is.
 *
 * Five tier 3 elements earn bespoke mechanics, chosen for observer-visible
 * drama on systems that already exist: geyser banks pressure and erupts into
 * its wars, tempest gathers momentum from conquest and unravels without it,
 * bloom settles half again as fast until overgrowth outruns its people,
 * plasma runs its works furiously hot against a treasury that must keep up,
 * and obsidian lets attackers break themselves on edges that shatter under
 * sustained siege. Every strength is paired with a weakness that triggers
 * mechanically from world state — a self-playing world cannot rely on bespoke
 * AI cleverness to break a mechanic, so the mechanics break themselves.
 *
 * Everything else in the tier 3 space expresses as a bounded stat profile at
 * the same five chokepoints (attack, defense, settlement, payout, growth),
 * inside the ±POWER_RULES.profileBand band. The mist–mirage–glass trio stays
 * deliberately neutral here: their identities are information mechanics on
 * the belief layer, reserved for the phase that builds them.
 *
 * The ElementPowersSystem advances the meters once per tick; the factor
 * functions below are read from the combat, settlement, economy and trade
 * loops and are all O(1) over per-faction state.
 */

/** The five elements whose identity is a mechanic rather than a profile. */
export const BESPOKE_POWER_ELEMENTS = [
  "geyser",
  "tempest",
  "bloom",
  "plasma",
  "obsidian",
] as const;

export type BespokePowerElement = (typeof BESPOKE_POWER_ELEMENTS)[number];

/** The dramatic moments a mechanic can produce, reported as dynasty facts. */
export type PowerEvent =
  | "geyser-erupted"
  | "tempest-crested"
  | "bloom-overextended"
  | "plasma-containment-failed"
  | "obsidian-shattered";

export function createPowerState(): ElementPowerState {
  return { charge: 0, releasedAt: -1, tally: 0 };
}

/**
 * A bounded multiplier per chokepoint for the profile-expressed identities.
 * Missing entries are neutral; every authored value must stay inside the
 * profile band, which the element tests assert over the whole space.
 */
export interface ElementStatProfile {
  /** Multiplier on campaign progress when this realm attacks. */
  attack: number;
  /** Multiplier on the invasion cost of this realm's ground. */
  defense: number;
  /** Multiplier on this realm's settlement pressure. */
  settle: number;
  /** Multiplier on everything this realm's structures pay it. */
  payout: number;
  /** Multiplier on this realm's population growth. */
  growth: number;
}

const NEUTRAL_PROFILE: ElementStatProfile = {
  attack: 1,
  defense: 1,
  settle: 1,
  payout: 1,
  growth: 1,
};

/**
 * The profile-expressed tier 3 identities, each a temperament made numeric at
 * existing chokepoints. The bespoke five never appear here — their identity
 * is their mechanic — and the information trio stays neutral on purpose.
 */
const STAT_PROFILES: Partial<Record<ElementId, Partial<ElementStatProfile>>> = {
  // Wins ruined ground and waits for it to grow back richer.
  ash: { settle: 1.1, defense: 1.08 },
  // Endures through people and memory beyond any border.
  spirit: { growth: 1.12, defense: 1.05 },
  // Links distant holdings into one synchronized field.
  aurora: { payout: 1.08, growth: 1.05 },
  // Redirects what moves and holds what stands with unseen force.
  lodestone: { defense: 1.12 },
  // Keeps what it values sealed against decay, including its habits.
  amber: { payout: 1.1, defense: 1.05 },
  // Feeds on ruin and dormancy and surfaces where least expected.
  fungus: { settle: 1.12, attack: 1.04 },
  // Stores power in resonant nodes and times its release.
  crystal: { payout: 1.12 },
};

const PROFILE_CACHE = new Map<ElementId, ElementStatProfile>();

export function statProfileOf(element: ElementId): ElementStatProfile {
  const cached = PROFILE_CACHE.get(element);
  if (cached) return cached;
  const profile: ElementStatProfile = { ...NEUTRAL_PROFILE, ...STAT_PROFILES[element] };
  PROFILE_CACHE.set(element, profile);
  return profile;
}

function withinWindow(power: ElementPowerState, tick: number, window: number): boolean {
  return power.releasedAt >= 0 && tick - power.releasedAt < window;
}

/** Whether a geyser realm is inside its post-eruption surge. */
export function geyserSurging(power: ElementPowerState, tick: number): boolean {
  return withinWindow(power, tick, POWER_RULES.geyserSurgeTicks);
}

/** Whether a geyser realm is still refilling — the designed weakness window. */
export function geyserVenting(power: ElementPowerState, tick: number): boolean {
  return withinWindow(power, tick, POWER_RULES.geyserVentTicks);
}

/** Whether a plasma realm is inside a containment outage. */
export function plasmaContainmentFailed(power: ElementPowerState, tick: number): boolean {
  return withinWindow(power, tick, POWER_RULES.plasmaFailureTicks);
}

/** Whether an obsidian realm's edge lies shattered. */
export function obsidianShattered(power: ElementPowerState, tick: number): boolean {
  return withinWindow(power, tick, POWER_RULES.obsidianShatterTicks);
}

/** Bloom stores its overextension flag in the meter; half is the threshold. */
export function bloomIsOverextended(power: ElementPowerState): boolean {
  return power.charge >= 0.5;
}

/**
 * Advances one realm's mechanic by a tick and returns the dramatic moment it
 * produced, if any. Mutates the faction's power state — and, for plasma, its
 * treasury — and nothing else; the calling system turns the returned event
 * into reports and chronicle lines. Deterministic: no randomness anywhere.
 */
export function advancePowerState(
  faction: FactionState,
  situation: { tick: number; campaigning: boolean; pressed: boolean },
): PowerEvent | null {
  const { tick, campaigning, pressed } = situation;
  const power = faction.power;
  const element = faction.expressedElement;
  let event: PowerEvent | null = null;

  // A realm in a transmutation window holds its breath: the mechanic neither
  // banks nor breaks while the fusion runs, but the capture bookkeeping below
  // stays current so the meter resumes from now, not from the missed weeks.
  if (TRANSMUTATION_RULES.pausePowers && transmuting(faction)) {
    power.tally = faction.capturedTiles;
    return null;
  }

  if (element === "geyser") {
    power.charge = Math.min(1, power.charge + 1 / POWER_RULES.geyserBankTicks);
    if (power.charge >= 1 && campaigning) {
      power.charge = 0;
      power.releasedAt = tick;
      event = "geyser-erupted";
    }
  } else if (element === "tempest") {
    const freshCaptures = Math.max(0, faction.capturedTiles - power.tally);
    const before = power.charge;
    power.charge = clamp(
      power.charge
        - POWER_RULES.tempestDecayPerTick
        + freshCaptures * POWER_RULES.tempestGainPerCapture,
      0,
      1,
    );
    if (
      before < POWER_RULES.tempestCrestThreshold
      && power.charge >= POWER_RULES.tempestCrestThreshold
    ) {
      power.releasedAt = tick;
      event = "tempest-crested";
    }
  } else if (element === "bloom") {
    const homeRatio = faction.troops / Math.max(1, faction.troopCap);
    if (bloomIsOverextended(power)) {
      if (homeRatio >= POWER_RULES.bloomOverextendedExitRatio) power.charge = 0;
    } else if (homeRatio < POWER_RULES.bloomOverextendedEnterRatio) {
      power.charge = 1;
      power.releasedAt = tick;
      event = "bloom-overextended";
    }
  } else if (element === "plasma") {
    if (!plasmaContainmentFailed(power, tick)) {
      const structures = faction.structures;
      const burn = POWER_RULES.plasmaUpkeepPerStructure * (
        structures.city + structures.factory + structures.harbor
        + structures.plant + structures.skyport
      );
      if (burn > 0) {
        if (faction.gold > burn) {
          faction.gold -= burn;
        } else {
          faction.gold = 0;
          power.releasedAt = tick;
          event = "plasma-containment-failed";
        }
      }
    }
  } else if (element === "obsidian") {
    if (!obsidianShattered(power, tick)) {
      if (pressed) {
        power.charge += 1 / POWER_RULES.obsidianFractureTicks;
        if (power.charge >= 1) {
          power.charge = 0;
          power.releasedAt = tick;
          event = "obsidian-shattered";
        }
      } else {
        power.charge = Math.max(0, power.charge - 1 / POWER_RULES.obsidianAnnealTicks);
      }
    }
  }

  // Every realm keeps its capture bookkeeping current, so a realm ascending
  // to tempest starts its storm from this moment, not from its whole record.
  power.tally = faction.capturedTiles;
  return event;
}

/** The transition-sickness multiplier a chokepoint pays while a realm fuses. */
function fluxFactor(faction: FactionState, chokepoint: keyof ElementStatProfile): number {
  if (!transmuting(faction)) return 1;
  switch (chokepoint) {
    case "attack": return TRANSMUTATION_RULES.attackFactor;
    case "defense": return TRANSMUTATION_RULES.defenseFactor;
    case "settle": return TRANSMUTATION_RULES.settleFactor;
    case "growth": return TRANSMUTATION_RULES.growthFactor;
    default: return 1;
  }
}

/** Multiplier on a realm's campaign progress when it attacks. */
export function powerAttackFactor(state: WorldState, attacker: PlayerId): number {
  const faction = state.factions[attacker];
  const flux = fluxFactor(faction, "attack");
  const element = faction.expressedElement;
  if (element === "geyser") {
    return (geyserSurging(faction.power, state.tick) ? POWER_RULES.geyserSurgeAttack : 1) * flux;
  }
  if (element === "tempest") {
    return (1 + POWER_RULES.tempestMomentumAttack * faction.power.charge) * flux;
  }
  return statProfileOf(element).attack * flux;
}

/** Multiplier on the invasion cost of a realm's ground. */
export function powerDefenseFactor(state: WorldState, defender: PlayerId): number {
  const faction = state.factions[defender];
  const flux = fluxFactor(faction, "defense");
  const element = faction.expressedElement;
  if (element === "geyser") {
    return (geyserVenting(faction.power, state.tick)
      ? POWER_RULES.geyserVentDefense
      : 1 + POWER_RULES.geyserBankDefense * faction.power.charge) * flux;
  }
  if (element === "bloom") {
    return (bloomIsOverextended(faction.power) ? POWER_RULES.bloomOverextendedDefense : 1) * flux;
  }
  if (element === "obsidian") {
    return (obsidianShattered(faction.power, state.tick)
      ? POWER_RULES.obsidianShatterDefense
      : 1) * flux;
  }
  return statProfileOf(element).defense * flux;
}

/** Multiplier on a realm's settlement pressure. */
export function powerSettleFactor(state: WorldState, attacker: PlayerId): number {
  const faction = state.factions[attacker];
  const flux = fluxFactor(faction, "settle");
  if (faction.expressedElement === "bloom") {
    return (bloomIsOverextended(faction.power) ? 1 : POWER_RULES.bloomSettleBonus) * flux;
  }
  return statProfileOf(faction.expressedElement).settle * flux;
}

/** Multiplier on everything a realm's structures pay it. */
export function powerPayoutFactor(state: WorldState, owner: PlayerId): number {
  const faction = state.factions[owner];
  if (faction.expressedElement === "plasma") {
    return plasmaContainmentFailed(faction.power, state.tick)
      ? POWER_RULES.plasmaFailurePenalty
      : POWER_RULES.plasmaPayoutBoost;
  }
  return statProfileOf(faction.expressedElement).payout;
}

/** Multiplier on a realm's population growth. */
export function powerGrowthFactor(state: WorldState, owner: PlayerId): number {
  const faction = state.factions[owner];
  return statProfileOf(faction.expressedElement).growth * fluxFactor(faction, "growth");
}

/** Multiplier on attacker casualties when pushing into a realm's ground. */
export function powerAttackerCasualtyFactor(state: WorldState, defender: PlayerId): number {
  const faction = state.factions[defender];
  if (faction.expressedElement === "obsidian") {
    return obsidianShattered(faction.power, state.tick)
      ? 1
      : POWER_RULES.obsidianReflectCasualties;
  }
  return 1;
}
