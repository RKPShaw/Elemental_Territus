import { updateStrategicRegions } from "../regions";
import type { SimulationContext, SimulationSystem } from "../types";

/** Maintains a shared, slowly migrating equal-area strategic partition. */
export class StrategicGeographySystem implements SimulationSystem {
  readonly id = "adaptive-equal-area-strategic-geography";

  update({ state }: SimulationContext): void {
    updateStrategicRegions(state);
  }
}
