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
let championAnnounced = false;

function publish(replaceHistory = false): void {
  if (!engine) return;
  const world = engine.snapshot();
  championAnnounced = Boolean(world.champion);
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

  // Victory is pushed out immediately rather than waiting out the snapshot
  // interval -- but only once. This condition used to be simply "a champion
  // exists", which stayed true on every 4ms pass after a realm won the age,
  // so the worker cloned and posted the entire world 250 times a second until
  // the tab ran out of memory. That is the crash that ended a game the moment
  // it was won.
  const championNow = engine ? engine.observe((state) => Boolean(state.champion)) : false;
  if (engine && (now - previousPublish >= VISUAL_SNAPSHOT_INTERVAL_MS || (championNow && !championAnnounced))) {
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
