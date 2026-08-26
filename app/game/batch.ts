import { BatchMetricsCollector } from "./batch-metrics";
import type { WorldBalanceSnapshot } from "./batch-metrics";
import { ElementalWarEngine } from "./engine";
import { BATCH_SYSTEMS } from "./systems";
import type { PlayerId } from "./types";

export const DEFAULT_BATCH_CHECKPOINTS = [
  60,
  180,
  300,
  600,
  900,
  1_200,
  1_800,
  2_700,
  3_600,
  5_400,
  7_200,
] as const;

export interface BatchRunOptions {
  checkpointTicks?: readonly number[];
  maximumTicks?: number;
}

export interface BatchCheckpoint {
  requestedTick: number;
  actualTick: number;
  terminal: boolean;
  snapshot: WorldBalanceSnapshot;
}

export interface BatchGameResult {
  seed: number;
  champion: PlayerId | null;
  completionTick: number | null;
  horizonTick: number;
  resolved: boolean;
  runtimeMs: number;
  checkpoints: BatchCheckpoint[];
}

/**
 * Runs the exact simulation pipeline without UI snapshots, chronicles, the
 * factual ledger, or story correlation. The metrics collector observes the
 * same event drafts before they would have entered the ledger.
 */
export function runBatchGame(seed: number, options: BatchRunOptions = {}): BatchGameResult {
  const maximumTicks = Math.max(1, options.maximumTicks ?? 7_200);
  const checkpointTicks = [...new Set(options.checkpointTicks ?? DEFAULT_BATCH_CHECKPOINTS)]
    .filter((tick) => tick > 0 && tick <= maximumTicks)
    .sort((first, second) => first - second);
  if (checkpointTicks.at(-1) !== maximumTicks) checkpointTicks.push(maximumTicks);

  const collector = new BatchMetricsCollector();
  const engine = new ElementalWarEngine(seed, BATCH_SYSTEMS, {
    retainChronicle: false,
    retainReports: false,
    onReport: collector.record,
    onTick: collector.tick,
  });
  const checkpoints: BatchCheckpoint[] = [];
  const startedAt = performance.now();

  for (const requestedTick of checkpointTicks) {
    engine.advance(Math.max(0, requestedTick - engine.tick));
    const snapshot = engine.observe((state) => collector.snapshot(state));
    const terminal = snapshot.champion !== null;
    checkpoints.push({
      requestedTick,
      actualTick: snapshot.tick,
      terminal,
      snapshot,
    });
    if (terminal) break;
  }

  const final = checkpoints.at(-1)!;
  return {
    seed,
    champion: final.snapshot.champion,
    completionTick: final.snapshot.champion ? final.actualTick : null,
    horizonTick: maximumTicks,
    resolved: final.snapshot.champion !== null,
    runtimeMs: performance.now() - startedAt,
    checkpoints,
  };
}
