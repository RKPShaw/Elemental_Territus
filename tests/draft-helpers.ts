import type { Cell, SimulationConfig } from "../app/game/types";

export type { Cell };

export interface DraftWorld {
  cells: Cell[];
  config: SimulationConfig;
}

/** A bare all-plains table for draft tests: no water, no owners, no noise. */
export function flatWorld(width: number, height: number): DraftWorld {
  const cells: Cell[] = [];
  for (let index = 0; index < width * height; index += 1) {
    cells.push({
      owner: null,
      terrain: "plains",
      structure: null,
      structureLevel: 0,
      capitalOf: null,
      coastal: false,
      stream: false,
      pressure: 0,
      pressureBy: null,
      pressureTracked: false,
      capturedAt: -99,
      structureHeritage: null,
    });
  }
  return { cells, config: { width, height } as SimulationConfig };
}
