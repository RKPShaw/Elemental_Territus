import type { WorldState } from "./types";

export const BASE_SIMULATION_TICKS_PER_SECOND = 4;
export const VISUAL_SNAPSHOT_INTERVAL_MS = 250;

export type SimulationWorkerCommand =
  | { type: "initialize"; seed: number; running: boolean; speed: number; aggression: number }
  | { type: "set-running"; running: boolean }
  | { type: "set-speed"; speed: number }
  | { type: "set-aggression"; aggression: number }
  | { type: "new-world"; seed: number; aggression: number };

export type SimulationWorkerEvent = {
  type: "snapshot";
  world: WorldState;
  reportDelta: WorldState["reports"];
  replaceHistory: boolean;
};
