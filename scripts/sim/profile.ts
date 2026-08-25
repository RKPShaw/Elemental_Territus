import { ElementalWarEngine } from "../../app/game/engine";
import { DEFAULT_SYSTEMS } from "../../app/game/systems";
import type { SimulationSystem } from "../../app/game/types";

export interface SystemProfile {
  id: string;
  totalMs: number;
  worstMs: number;
  worstTick: number;
  /** Calls costing more than the spike threshold; these are what stutter. */
  spikes: number;
}

export interface ProfileResult {
  ticks: number;
  wallMs: number;
  tickMs: number[];
  systems: SystemProfile[];
}

/**
 * Runs a world with each system wrapped in a timer.
 *
 * The wrappers keep the same ids in the same order and simply delegate, so the
 * simulation is byte-identical to an unprofiled run; only the wall clock is
 * observed. This is the measurement that located a 2.3s stall in the rail
 * network, so it is worth having as a command rather than a throwaway script.
 */
export function profileRun(seed: number, ticks: number, spikeMs: number): ProfileResult {
  const profiles = new Map<string, SystemProfile>();
  let currentTick = 0;

  const instrumented: SimulationSystem[] = DEFAULT_SYSTEMS.map((system) => {
    profiles.set(system.id, { id: system.id, totalMs: 0, worstMs: 0, worstTick: 0, spikes: 0 });
    return {
      id: system.id,
      update(context) {
        const started = performance.now();
        system.update(context);
        const elapsed = performance.now() - started;
        const profile = profiles.get(system.id)!;
        profile.totalMs += elapsed;
        if (elapsed > spikeMs) profile.spikes += 1;
        if (elapsed > profile.worstMs) {
          profile.worstMs = elapsed;
          profile.worstTick = currentTick;
        }
      },
    };
  });

  const engine = new ElementalWarEngine(seed, instrumented);
  const tickMs: number[] = [];
  const wallStarted = performance.now();
  for (let index = 0; index < ticks; index += 1) {
    currentTick = index + 1;
    const started = performance.now();
    engine.advance(1);
    tickMs.push(performance.now() - started);
  }

  return {
    ticks,
    wallMs: performance.now() - wallStarted,
    tickMs,
    systems: [...profiles.values()].sort((first, second) => second.totalMs - first.totalMs),
  };
}

export function quantile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
}
