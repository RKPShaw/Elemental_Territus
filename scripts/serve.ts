/**
 * Watch a world play, in a browser, with nothing installed.
 *
 * The simulation runs here and the page draws what it is told, because a tick
 * costs far more than a browser can afford with fifty players. The server keeps
 * one world running at its own pace and streams each frame as it happens; the
 * page holds the latest and repaints. Nothing is replayed and nothing is
 * pre-baked -- refresh mid-game and you rejoin the world already in progress.
 *
 *   npm run serve                 -- then open the URL it prints
 *   npm run serve -- --port 8080 --speed 4 --seed 0x240823
 *
 * Uses only node: builtins, so it runs from a clean checkout with no install.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ElementalWarEngine } from "../app/game/engine";
import { committedTroopsFor } from "../app/game/campaigns";
import { ELEMENTS, ELEMENT_ORDER } from "../app/game/elements";
import { PLAYERS, PLAYER_ORDER } from "../app/game/players";
import { TERRAIN_RULES } from "../app/game/rules";
import type { WorldState } from "../app/game/types";
import { parseArgs, DEFAULT_SEED } from "./sim/args";

const args = parseArgs(process.argv.slice(2));
const port = args.integer("port", 4173);
const seed = args.number("seed", DEFAULT_SEED);
/** Ticks advanced per broadcast. Higher moves the world faster, not smoother. */
const speed = Math.max(1, args.integer("speed", 2));
/** Milliseconds between broadcasts. */
const frameMs = Math.max(16, args.integer("frame-ms", 200));

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
      : cell.owner ? OWNER_INDEX.get(cell.owner)! : UNOWNED;
  }
  return codes;
}

function runLength(values: Uint8Array): number[] {
  const runs: number[] = [];
  let current = values[0]!;
  let length = 0;
  for (const value of values) {
    if (value === current) { length += 1; continue; }
    runs.push(current, length);
    current = value;
    length = 1;
  }
  runs.push(current, length);
  return runs;
}

const engine = new ElementalWarEngine(seed);
const first = engine.snapshot();
const terrain = new Uint8Array(first.cells.length);
for (let index = 0; index < first.cells.length; index += 1) {
  terrain[index] = TERRAIN_ORDER.indexOf(first.cells[index]!.terrain);
}

const world = {
  seed,
  worldName: first.worldName,
  width: first.config.width,
  height: first.config.height,
  landTiles: first.landTiles,
  terrainRuns: runLength(terrain),
  terrainFills: TERRAIN_ORDER.map((id) => TERRAIN_RULES[id].fill),
  players: PLAYER_ORDER.map((id) => ({
    name: PLAYERS[id]!.name,
    realm: PLAYERS[id]!.realmName,
    color: PLAYERS[id]!.color,
    element: ELEMENT_ORDER.indexOf(PLAYERS[id]!.element),
  })),
  elements: ELEMENT_ORDER.map((id) => ({ name: ELEMENTS[id].name, color: ELEMENTS[id].color })),
};

let previous = ownerCodes(first);
let seenReports = 0;
/** The whole grid, for a client that has just arrived and knows nothing. */
let latestFull = runLength(previous);
let latestFrame = frameOf(first, previous, []);

function frameOf(state: WorldState, codes: Uint8Array, changes: number[]) {
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
  const events = state.reports.slice(seenReports)
    .filter((event) => event.importance !== "routine")
    .slice(-6)
    .map((event) => [
      ["routine", "notable", "major", "historic"].indexOf(event.importance),
      event.summary,
    ] as [number, string]);
  seenReports = state.reports.length;
  return { tick: state.tick, age: state.age, changes, standings, events };
}

const clients = new Set<import("node:http").ServerResponse>();

setInterval(() => {
  engine.advance(speed);
  const state = engine.snapshot();
  const codes = ownerCodes(state);
  const changes: number[] = [];
  for (let index = 0; index < codes.length; index += 1) {
    if (codes[index] !== previous[index]) changes.push(index, codes[index]!);
  }
  previous = codes;
  latestFull = runLength(codes);
  latestFrame = frameOf(state, codes, changes);
  const line = `data: ${JSON.stringify(latestFrame)}\n\n`;
  for (const client of clients) client.write(line);
}, frameMs);

const page = readFileSync("scripts/live-viewer.html", "utf8");

createServer((request, response) => {
  const url = request.url ?? "/";
  if (url === "/" || url.startsWith("/?")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  if (url === "/world") {
    // Everything a newcomer needs: the fixed world, plus the grid as it stands
    // right now rather than as it started, so a late arrival is not replaying.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...world, ownerRuns: latestFull, frame: latestFrame }));
    return;
  }
  if (url === "/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }
  response.writeHead(404).end("not found");
}).listen(port, () => {
  process.stdout.write(
    `\n  ${world.worldName} is playing at http://localhost:${port}\n` +
    `  ${PLAYER_ORDER.length} players, ${speed} tick(s) every ${frameMs}ms\n\n`,
  );
});
