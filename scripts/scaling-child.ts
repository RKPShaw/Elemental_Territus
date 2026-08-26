/**
 * One roster size, measured. Driven by scripts/scaling.ts, which sets
 * ELEMENTAL_PLAYERS_PER_ELEMENT before this process loads the roster.
 */
import { ElementalWarEngine } from "../app/game/engine";
import { PLAYER_COUNT } from "../app/game/players";
import { DEFAULT_SYSTEMS } from "../app/game/systems";
import type { SimulationSystem } from "../app/game/types";

const ticks = Number.parseInt(process.argv[2] ?? "40", 10);
const seed = Number.parseInt(process.argv[3] ?? "2361891", 10);
const warmup = Number.parseInt(process.argv[4] ?? "3", 10);

const totals = new Map<string, number>();
const instrumented: SimulationSystem[] = DEFAULT_SYSTEMS.map((system) => ({
  id: system.id,
  update(context) {
    const started = performance.now();
    system.update(context);
    totals.set(system.id, (totals.get(system.id) ?? 0) + (performance.now() - started));
  },
}));

const worldStarted = performance.now();
const engine = new ElementalWarEngine(seed, instrumented);
const worldMs = performance.now() - worldStarted;

// Warm-up ticks keep JIT compilation out of the window, and a long warm-up
// measures a developed world rather than the near-empty opening.
engine.advance(warmup);
totals.clear();

const started = performance.now();
engine.advance(ticks);
const totalMs = (performance.now() - started) / ticks;

process.stdout.write(`${JSON.stringify({
  players: PLAYER_COUNT,
  totalMs,
  worldMs,
  systems: Object.fromEntries([...totals].map(([id, ms]) => [id, ms / ticks])),
})}\n`);
