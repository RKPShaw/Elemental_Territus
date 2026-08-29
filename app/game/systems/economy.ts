import { PLAYER_ORDER } from "../players";
import { warsFor } from "../diplomacy";

import {
  ECONOMY_RULES,
  POPULATION_RULES,
  TERRAIN_RULES,
  clamp,
  normalizedCellArea,
  populationGrowthEfficiency,
} from "../rules";
import type { PlayerId, SimulationContext, SimulationSystem } from "../types";
import { structurePayoutMultiplier } from "../elements";
import { powerGrowthFactor } from "../powers";
import { recordLandIncome } from "../economics";

export class EconomySystem implements SimulationSystem {
  readonly id = "troop-and-gold-economy";

  update({ state }: SimulationContext): void {
    const cellArea = normalizedCellArea(state.config);
    // Keyed by player, not by element: ten players share each element, so a
    // fixed five-key tally would silently drop every owner's income.
    const landIncome = new Map<PlayerId, number>();
    // City income is tallied per site rather than from the city count, so a
    // captured city pays at its heritage efficiency instead of at par.
    const cityIncome = new Map<PlayerId, number>();
    for (const cell of state.cells) {
      if (!cell.owner) continue;
      landIncome.set(
        cell.owner,
        (landIncome.get(cell.owner) ?? 0) + TERRAIN_RULES[cell.terrain].goldYield * cellArea,
      );
      if (cell.structure === "city") {
        cityIncome.set(
          cell.owner,
          (cityIncome.get(cell.owner) ?? 0) +
            ECONOMY_RULES.cityIncome
            * Math.max(1, cell.structureLevel)
            * structurePayoutMultiplier(state, cell),
        );
      }
    }
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      recordLandIncome(state, id, (landIncome.get(id) ?? 0) * ECONOMY_RULES.landIncomeScale);
      faction.goldRate =
        (landIncome.get(id) ?? 0) * ECONOMY_RULES.landIncomeScale +
        (cityIncome.get(id) ?? 0);
      faction.gold = clamp(
        faction.gold + faction.goldRate,
        0,
        ECONOMY_RULES.maximumTreasury,
      );

      // Capacity is what the ground at home supports, and a host on campaign
      // is not at home: it neither reproduces nor takes up room. So the cap
      // bounds the population alone, and a realm that marches people out has
      // made room to grow into rather than merely spent itself. While that
      // host is away the realm's living strength — home plus committed — may
      // stand above the cap, which is the reward for using its people.
      const homeRatio = faction.troops / Math.max(1, faction.troopCap);
      const growthEfficiency = populationGrowthEfficiency(homeRatio);
      faction.troopGrowth =
        faction.troopCap
        * POPULATION_RULES.peakGrowthPerTick
        * growthEfficiency
        * powerGrowthFactor(state, id);
      faction.troops = clamp(faction.troops + faction.troopGrowth, 0, faction.troopCap);

      const activeWars = warsFor(state, id).length;
      faction.warWeariness = clamp(
        faction.warWeariness + (activeWars > 0 ? 0.0018 * activeWars : -0.004),
        0,
        1,
      );
    }
  }
}
