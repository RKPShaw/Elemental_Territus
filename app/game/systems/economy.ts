import { warsFor } from "../diplomacy";
import { committedTroopsFor } from "../campaigns";
import { ELEMENT_ORDER } from "../elements";
import {
  ECONOMY_RULES,
  POPULATION_RULES,
  TERRAIN_RULES,
  clamp,
  normalizedCellArea,
  populationGrowthEfficiency,
} from "../rules";
import type { SimulationContext, SimulationSystem } from "../types";

export class EconomySystem implements SimulationSystem {
  readonly id = "troop-and-gold-economy";

  update({ state }: SimulationContext): void {
    const cellArea = normalizedCellArea(state.config);
    const landIncome = {
      ember: 0,
      tide: 0,
      grove: 0,
      stone: 0,
      gale: 0,
    };
    for (const cell of state.cells) {
      if (cell.owner) landIncome[cell.owner] += TERRAIN_RULES[cell.terrain].goldYield * cellArea;
    }
    for (const id of ELEMENT_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      faction.goldRate =
        landIncome[id] * ECONOMY_RULES.landIncomeScale +
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
