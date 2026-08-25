/// <reference lib="webworker" />

import { ElementalWarEngine } from "./engine";
import {
  BASE_SIMULATION_TICKS_PER_SECOND,
  VISUAL_SNAPSHOT_INTERVAL_MS,
} from "./simulation-protocol";
import type { SimulationWorkerCommand, SimulationWorkerEvent } from "./simulation-protocol";

let engine: ElementalWarEngine | null = null;
let running = true;
let speed = 1;
let aggression = 1;
let accumulator = 0;
let previousTime = performance.now();
let previousPublish = 0;
let loopStarted = false;
let publishedReportCount = 0;

function publish(replaceHistory = false): void {
  if (!engine) return;
  const world = engine.snapshot();
  const reportDelta = replaceHistory
    ? world.reports
    : world.reports.slice(publishedReportCount);
  publishedReportCount = world.reports.length;
  world.reports = [];
  const event: SimulationWorkerEvent = { type: "snapshot", world, reportDelta, replaceHistory };
  self.postMessage(event);
  previousPublish = performance.now();
}

function scheduleLoop(): void {
  self.setTimeout(runLoop, running ? 4 : 32);
}

function runLoop(): void {
  const now = performance.now();
  const elapsed = Math.min(250, Math.max(0, now - previousTime));
  previousTime = now;

  if (engine && running && !engine.observe((state) => state.champion)) {
    const requested = elapsed * BASE_SIMULATION_TICKS_PER_SECOND * speed / 1_000;
    accumulator = Math.min(8, accumulator + requested);
    if (accumulator >= 1) {
      // One authoritative update per task keeps long theater/pathfinding work
      // away from the display thread and yields between expensive ticks.
      engine.advance(1);
      accumulator -= 1;
    }
  } else {
    accumulator = 0;
  }

  if (engine && (now - previousPublish >= VISUAL_SNAPSHOT_INTERVAL_MS || engine.observe((state) => Boolean(state.champion)))) {
    publish();
  }
  scheduleLoop();
}

function ensureLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  previousTime = performance.now();
  scheduleLoop();
}

self.addEventListener("message", (event: MessageEvent<SimulationWorkerCommand>) => {
  const command = event.data;
  if (command.type === "initialize") {
    running = command.running;
    speed = command.speed;
    aggression = command.aggression;
    engine = new ElementalWarEngine(command.seed);
    engine.setAggression(aggression);
    accumulator = 0;
    publishedReportCount = 0;
    publish(true);
    ensureLoop();
    return;
  }
  if (command.type === "set-running") {
    running = command.running;
    accumulator = 0;
    previousTime = performance.now();
    publish();
    return;
  }
  if (command.type === "set-speed") {
    speed = command.speed;
    accumulator = 0;
    previousTime = performance.now();
    return;
  }
  if (command.type === "set-aggression") {
    aggression = command.aggression;
    engine?.setAggression(aggression);
    publish();
    return;
  }
  aggression = command.aggression;
  engine = new ElementalWarEngine(command.seed);
  engine.setAggression(aggression);
  running = true;
  accumulator = 0;
  previousTime = performance.now();
  publishedReportCount = 0;
  publish(true);
});
