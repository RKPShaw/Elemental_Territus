import { parentPort, workerData } from "node:worker_threads";
import { runBatchGame } from "../app/game/batch";

interface WorkerPayload {
  seeds: number[];
  maximumTicks: number;
  checkpointTicks: number[];
}

const payload = workerData as WorkerPayload;
const results = payload.seeds.map((seed) => runBatchGame(seed, {
  maximumTicks: payload.maximumTicks,
  checkpointTicks: payload.checkpointTicks,
}));

parentPort?.postMessage(results);
