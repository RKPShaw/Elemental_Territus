import type { EconomyLedger, PlayerId, StructureType, WorldState } from "./types";

/**
 * What each kind of building is actually worth to the player who built it.
 *
 * The question this exists to answer is a playtesting one: when someone wins,
 * what did they spend their gold on, and did it pay? Structure counts alone
 * cannot answer it -- a realm with twenty harbours and a realm with twenty
 * factories look identical in a standings table -- and treasury alone cannot
 * either, because it says what a player has and not where it came from.
 *
 * So every gold that moves is attributed to the building responsible for it.
 * Trains earn for the factory that dispatched them; ships for the harbour.
 * A foreign vehicle stopping on your ground earns for the station it stopped
 * at, which is the honest reading -- that income is the host's infrastructure
 * being paid for, not the visitor's. Land income is tracked apart as the
 * baseline: a building that returns less than the ground it stands on has not
 * earned its place.
 *
 * Cumulative for the life of the game, never reset, so the ratio of earned to
 * spent is a verdict on the whole run rather than on whichever tick it is read.
 */

export function createEconomyLedger(): EconomyLedger {
  return {
    land: 0,
    city: { spent: 0, earned: 0, runs: 0 },
    fort: { spent: 0, earned: 0, runs: 0 },
    factory: { spent: 0, earned: 0, runs: 0 },
    harbor: { spent: 0, earned: 0, runs: 0 },
  };
}

export function cloneEconomyLedger(ledger: EconomyLedger): EconomyLedger {
  return {
    land: ledger.land,
    city: { ...ledger.city },
    fort: { ...ledger.fort },
    factory: { ...ledger.factory },
    harbor: { ...ledger.harbor },
  };
}

export function recordSpend(
  state: WorldState,
  owner: PlayerId,
  structure: StructureType,
  amount: number,
): void {
  state.factions[owner]!.economy[structure].spent += amount;
}

export function recordEarned(
  state: WorldState,
  owner: PlayerId,
  structure: StructureType,
  amount: number,
  runs = 0,
): void {
  const entry = state.factions[owner]!.economy[structure];
  entry.earned += amount;
  entry.runs += runs;
}

export function recordLandIncome(state: WorldState, owner: PlayerId, amount: number): void {
  state.factions[owner]!.economy.land += amount;
}

export interface Viability {
  structure: StructureType;
  spent: number;
  earned: number;
  runs: number;
  /** Earned per gold spent. Below 1 means the building has not paid for itself. */
  returnOnSpend: number;
  /** Earned per building standing, so a big empire does not flatter a bad one. */
  earnedPerBuilding: number;
}

/** One player's verdict on each kind of building. */
export function viabilityFor(state: WorldState, owner: PlayerId): Viability[] {
  const faction = state.factions[owner]!;
  const structures: StructureType[] = ["city", "factory", "harbor", "fort"];
  return structures.map((structure) => {
    const entry = faction.economy[structure];
    const standing = faction.structures[structure];
    return {
      structure,
      spent: entry.spent,
      earned: entry.earned,
      runs: entry.runs,
      returnOnSpend: entry.spent > 0 ? entry.earned / entry.spent : 0,
      earnedPerBuilding: standing > 0 ? entry.earned / standing : 0,
    };
  });
}
