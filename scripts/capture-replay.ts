/**
 * Captures a playthrough as a compact replay for the web viewer.
 *
 * The simulation costs far more per tick than a browser can afford with fifty
 * players, so the world is played here and the viewer replays it. Ownership is
 * delta-encoded between frames -- only a few hundred cells change per frame out
 * of seventeen thousand -- which is what keeps the payload small enough to
 * inline into a single page.
 *
 *   npm run capture:replay -- --ticks 600 --every 4 --out replay.json
 *
 * Or sampled by the clock rather than by the tick, for a time-lapse of however
 * far a world gets in a sitting:
 *
 *   npm run capture:replay -- --wall 3600 --interval 15 --out timelapse.jsonl
 *
 * Wall mode writes one JSON line per frame as it goes, rather than one document
 * at the end. An hour is a long time to hold in memory and a longer time to
 * lose: a run cut short still leaves every frame it managed, and the page
 * builder is happy to read a partial file.
 */
import { committedTroopsFor } from "../app/game/campaigns";
import { ELEMENTS, ELEMENT_ORDER } from "../app/game/elements";
import { ElementalWarEngine } from "../app/game/engine";
import { PLAYERS, PLAYER_ORDER } from "../app/game/players";
import { TERRAIN_RULES } from "../app/game/rules";
import type { WorldState } from "../app/game/types";
import { parseArgs, DEFAULT_SEED } from "./sim/args";
import { appendFileSync, writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const seed = args.number("seed", DEFAULT_SEED);
const totalTicks = args.integer("ticks", 600);
const every = Math.max(1, args.integer("every", 4));
const out = args.flag("out") ?? "replay.json";
/** Wall-clock seconds to run for; 0 keeps the tick-counted behaviour. */
const wallSeconds = args.number("wall", 0);
/** Wall-clock seconds between frames in wall mode. */
const intervalSeconds = Math.max(0.1, args.number("interval", 15));

const OWNER_INDEX = new Map(PLAYER_ORDER.map((id, index) => [id, index]));
const UNOWNED = 250;
const WATER = 255;
const TERRAIN_ORDER = ["water", "farmland", "plains", "forest", "hills", "mountains"] as const;

function ownerCodes(state: WorldState): Uint8Array {
  const codes = new Uint8Array(state.cells.length);
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    codes[index] = cell.terrain === "water"
      ? WATER
      : cell.owner
        ? OWNER_INDEX.get(cell.owner)!
        : UNOWNED;
  }
  return codes;
}

/** Run-length encodes a byte grid as flat [value, length, value, length, ...]. */
function runLength(values: Uint8Array): number[] {
  const runs: number[] = [];
  let current = values[0]!;
  let length = 0;
  for (const value of values) {
    if (value === current) {
      length += 1;
      continue;
    }
    runs.push(current, length);
    current = value;
    length = 1;
  }
  runs.push(current, length);
  return runs;
}

interface Frame {
  tick: number;
  age: number;
  /** Flat [cellIndex, ownerCode, ...] pairs changed since the previous frame. */
  changes: number[];
  /** [playerIndex, territory, troops, gold, wars] for every living player. */
  standings: number[];
  events: Array<[number, string]>;
}

const engine = new ElementalWarEngine(seed);
const first = engine.snapshot();
const terrain = new Uint8Array(first.cells.length);
for (let index = 0; index < first.cells.length; index += 1) {
  terrain[index] = TERRAIN_ORDER.indexOf(first.cells[index]!.terrain);
}

let previous = ownerCodes(first);
const frames: Frame[] = [];
let seenReports = 0;
const startedAt = performance.now();

function capture(state: WorldState, codes: Uint8Array, isFirst: boolean): void {
  const changes: number[] = [];
  if (!isFirst) {
    for (let index = 0; index < codes.length; index += 1) {
      if (codes[index] !== previous[index]) changes.push(index, codes[index]!);
    }
  }
  const standings: number[] = [];
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id]!;
    if (!faction.alive) continue;
    standings.push(
      OWNER_INDEX.get(id)!,
      faction.territory,
      Math.round(faction.troops + committedTroopsFor(state, id)),
      Math.round(faction.gold),
      Object.values(state.relations).filter(
        (relation) => relation.parties.includes(id) && relation.status === "war",
      ).length,
    );
  }
  // Only the events worth reading; routine chatter would dwarf the payload.
  const events = state.reports
    .slice(seenReports)
    .filter((event) => event.importance !== "routine")
    .slice(-6)
    .map((event) => [
      ["routine", "notable", "major", "historic"].indexOf(event.importance),
      event.summary,
    ] as [number, string]);
  seenReports = state.reports.length;
  frames.push({ tick: state.tick, age: state.age, changes, standings, events });
}

function headerOf(): Record<string, unknown> {
  return {
    seed,
    worldName: first.worldName,
    width: first.config.width,
    height: first.config.height,
    landTiles: first.landTiles,
    tickEvery: every,
    terrainRuns: runLength(terrain),
    initialOwnerRuns: runLength(ownerCodes(first)),
    terrainFills: TERRAIN_ORDER.map((id) => TERRAIN_RULES[id].fill),
    players: PLAYER_ORDER.map((id) => ({
      name: PLAYERS[id]!.name,
      realm: PLAYERS[id]!.realmName,
      color: PLAYERS[id]!.color,
      element: ELEMENT_ORDER.indexOf(PLAYERS[id]!.element),
    })),
    elements: ELEMENT_ORDER.map((id) => ({ name: ELEMENTS[id].name, color: ELEMENTS[id].color })),
  };
}

/**
 * Time-lapse: play continuously and take a frame every so many seconds of real
 * time, for a fixed sitting. Frames are appended as they are taken, so the file
 * is readable at any point rather than only once the run ends.
 */
if (wallSeconds > 0) {
  writeFileSync(out, `${JSON.stringify({ kind: "timelapse", intervalSeconds, wallSeconds, ...headerOf() })}\n`);
  capture(first, previous, true);
  appendFileSync(out, `${JSON.stringify(frames[0])}\n`);
  frames.length = 0;

  const deadline = startedAt + wallSeconds * 1000;
  let nextFrameAt = startedAt + intervalSeconds * 1000;
  let taken = 1;
  // Advance in small batches so a frame lands near its moment rather than
  // whenever a long block of ticks happens to finish.
  while (performance.now() < deadline) {
    engine.advance(every);
    if (performance.now() < nextFrameAt) continue;
    const state = engine.snapshot();
    const codes = ownerCodes(state);
    capture(state, codes, false);
    previous = codes;
    appendFileSync(out, `${JSON.stringify(frames[0])}\n`);
    frames.length = 0;
    taken += 1;
    nextFrameAt += intervalSeconds * 1000;
    const elapsed = (performance.now() - startedAt) / 1000;
    process.stderr.write(
      `  frame ${taken} at tick ${state.tick} (${elapsed.toFixed(0)}s of ${wallSeconds}s)\n`,
    );
  }
  process.stderr.write(`captured ${taken} frames over ${wallSeconds}s -> ${out}\n`);
  process.exit(0);
}

capture(first, previous, true);
for (let tick = every; tick <= totalTicks; tick += every) {
  engine.advance(every);
  const state = engine.snapshot();
  const codes = ownerCodes(state);
  capture(state, codes, false);
  previous = codes;
  if (tick % 100 === 0) {
    process.stderr.write(`  tick ${tick}/${totalTicks} (${((performance.now() - startedAt) / 1000).toFixed(0)}s)\n`);
  }
}

const replay = {
  seed,
  worldName: first.worldName,
  width: first.config.width,
  height: first.config.height,
  landTiles: first.landTiles,
  tickEvery: every,
  terrainRuns: runLength(terrain),
  // Frames are deltas, so the opening ownership grid ships whole.
  initialOwnerRuns: runLength(ownerCodes(first)),
  terrainFills: TERRAIN_ORDER.map((id) => TERRAIN_RULES[id].fill),
  players: PLAYER_ORDER.map((id) => ({
    name: PLAYERS[id]!.name,
    realm: PLAYERS[id]!.realmName,
    color: PLAYERS[id]!.color,
    element: ELEMENT_ORDER.indexOf(PLAYERS[id]!.element),
  })),
  elements: ELEMENT_ORDER.map((id) => ({ name: ELEMENTS[id].name, color: ELEMENTS[id].color })),
  frames,
};

writeFileSync(out, JSON.stringify(replay));
const bytes = JSON.stringify(replay).length;
process.stderr.write(
  `captured ${frames.length} frames over ${totalTicks} ticks in ` +
  `${((performance.now() - startedAt) / 1000).toFixed(0)}s -> ${out} (${(bytes / 1e6).toFixed(2)}MB)\n`,
);
