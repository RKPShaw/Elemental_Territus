import type { SimulationContext, SimulationSystem } from "../types";

export class WorldClockSystem implements SimulationSystem {
  readonly id = "world-clock";

  update({ state }: SimulationContext): void {
    state.tick += 1;
    state.age = Math.floor(state.tick / 60) + 1;
    const active: number[] = [];
    for (const index of state.activePressureCells) {
      const cell = state.cells[index]!;
      if (!cell.pressureBy) {
        cell.pressureTracked = false;
        continue;
      }
      cell.pressure *= 0.992;
      if (cell.pressure < 0.003) {
        cell.pressure = 0;
        cell.pressureBy = null;
        cell.pressureTracked = false;
      } else {
        active.push(index);
      }
    }
    state.activePressureCells = active;
  }
}
