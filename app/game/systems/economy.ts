import { PLAYER_ORDER } from "../players";
import { warsFor } from "../diplomacy";
import { committedTroopsFor } from "../campaigns";

import {
  ECONOMY_RULES,
  POPULATION_RULES,
  TERRAIN_RULES,
  clamp,
  normalizedCellArea,
  populationGrowthEfficiency,
} from "../rules";
import type { PlayerId, SimulationContext, SimulationSystem } from "../types";
import { recordLandIncome } from "../economics";

export class EconomySystem implements SimulationSystem {
  readonly id = "troop-and-gold-economy";

  update({ state }: SimulationContext): void {
    const cellArea = normalizedCellArea(state.config);
    // Keyed by player, not by element: ten players share each element, so a
    // fixed five-key tally would silently drop every owner's income.
    const landIncome = new Map<PlayerId, number>();
    for (const cell of state.cells) {
      if (!cell.owner) continue;
      landIncome.set(
        cell.owner,
        (landIncome.get(cell.owner) ?? 0) + TERRAIN_RULES[cell.terrain].goldYield * cellArea,
      );
    }
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      recordLandIncome(state, id, (landIncome.get(id) ?? 0) * ECONOMY_RULES.landIncomeScale);
      faction.goldRate =
        (landIncome.get(id) ?? 0) * ECONOMY_RULES.landIncomeScale +
        faction.structures.city * ECONOMY_RULES.cityIncome;
      faction.gold = clamp(
        faction.gold + faction.goldRate,
        0,
        ECONOMY_RULES.maximumTreasury,
      );

      const committedTroops = committedTroopsFor(state, id);
      const homeRatio = faction.troops / Math.max(1, faction.troopCap);
      const growthEfficiency = populationGrowthEfficiency(homeRatio);
      faction.troopGrowth =
        faction.troopCap * POPULATION_RULES.peakGrowthPerTick * growthEfficiency;
      faction.troops = clamp(
        faction.troops + faction.troopGrowth,
        0,
        Math.max(0, faction.troopCap - committedTroops),
      );

      const activeWars = warsFor(state, id).length;
      faction.warWeariness = clamp(
        faction.warWeariness + (activeWars > 0 ? 0.0018 * activeWars : -0.004),
        0,
        1,
      );
    }
  }
}
