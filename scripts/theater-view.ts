/**
 * Bakes a world's theater lens into one page you can look at.
 *
 * The lens is the part of the theater system hardest to check by reading
 * numbers: it is a value per cell, per player, shaded by what that player
 * believes about the region around it, and a table of it says nothing. Drawn
 * over the map beside the fronts it produces, it either looks like the map a
 * commander would draw or it does not.
 *
 *   npm run theater:view -- --tick 1200 --out theater.html
 */
import { writeFileSync, readFileSync } from "node:fs";
import { ElementalWarEngine } from "../app/game/engine";
import { openLens } from "../app/game/lenses";
import { PLAYERS, PLAYER_ORDER } from "../app/game/players";
import { TERRAIN_RULES, CAMPAIGN_RULES } from "../app/game/rules";
import { believedValue, OBSERVED_LAYERS } from "../app/game/theater-map";
import type { PlayerId, WorldState } from "../app/game/types";
import { parseArgs, DEFAULT_SEED } from "./sim/args";

const args = parseArgs(process.argv.slice(2));
const seed = args.number("seed", DEFAULT_SEED);
const tick = args.integer("tick", 1200);
const out = args.flag("out") ?? "theater.html";

const TERRAIN_ORDER = ["water", "farmland", "plains", "forest", "hills", "mountains"] as const;
const OWNER_INDEX = new Map(PLAYER_ORDER.map((id, index) => [id, index]));
const UNOWNED = 250;
const WATER = 255;

function runLength(values: ArrayLike<number>): number[] {
  const runs: number[] = [];
  let current = values[0]!;
  let length = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === current) { length += 1; continue; }
    runs.push(current, length);
    current = values[i]!;
    length = 1;
  }
  runs.push(current, length);
  return runs;
}

const engine = new ElementalWarEngine(seed);
engine.advance(tick);
const state: WorldState = engine.snapshot();
const size = state.cells.length;

const terrain = new Uint8Array(size);
const owners = new Uint8Array(size);
for (let i = 0; i < size; i += 1) {
  const cell = state.cells[i]!;
  terrain[i] = TERRAIN_ORDER.indexOf(cell.terrain);
  owners[i] = cell.terrain === "water" ? WATER : cell.owner ? OWNER_INDEX.get(cell.owner)! : UNOWNED;
}
// Region ids are offset by one so water's -1 survives an unsigned run-length.
const regions = new Int16Array(size);
for (let i = 0; i < size; i += 1) regions[i] = state.regionByCell[i]! + 1;

/** A lens field, quantised to a byte per cell so a page can carry several. */
function lensField(viewer: PlayerId): { data: string; low: number; high: number } {
  const lens = openLens(state, viewer, "settle");
  const raw = new Float64Array(size);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < size; i += 1) {
    if (state.cells[i]!.terrain === "water") { raw[i] = Number.NaN; continue; }
    const value = lens.at(i);
    raw[i] = value;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = Math.max(1e-9, high - low);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = Number.isNaN(raw[i]!) ? 0 : 1 + Math.round(((raw[i]! - low) / span) * 254);
  }
  return { data: Buffer.from(bytes).toString("base64"), low, high };
}

// Only players actually pressing a war are worth drawing: the lens matters
// where it is being acted on.
const attackers = [...new Set(
  state.campaigns.filter((c) => c.target !== "wilderness").map((c) => c.attacker),
)].slice(0, 8);

const theaters = state.theaters
  .filter((t) => t.target !== "wilderness")
  .map((t) => ({
    id: t.id,
    campaignId: t.campaignId,
    attacker: OWNER_INDEX.get(t.attacker)!,
    target: OWNER_INDEX.get(t.target as PlayerId)!,
    regionId: t.regionId,
    allocation: Math.round(t.allocation),
    strategicValue: Number(t.strategicValue.toFixed(2)),
    resistance: Number(t.resistance.toFixed(2)),
    supplyQuality: Number(t.supplyQuality.toFixed(2)),
    boundaryCells: t.boundaryCells,
    objectiveCells: t.objectiveCells,
    centroidIndex: t.centroidIndex,
  }));

const payload = {
  seed,
  tick,
  worldName: state.worldName,
  width: state.config.width,
  height: state.config.height,
  maximumActiveTheaters: CAMPAIGN_RULES.maximumActiveTheaters,
  terrainRuns: runLength(terrain),
  ownerRuns: runLength(owners),
  regionRuns: runLength(regions),
  terrainFills: TERRAIN_ORDER.map((id) => TERRAIN_RULES[id].fill),
  regionCount: state.strategicRegions.length,
  players: PLAYER_ORDER.map((id) => ({
    realm: PLAYERS[id]!.realmName,
    color: PLAYERS[id]!.color,
    territory: state.factions[id]!.territory,
  })),
  viewers: attackers.map((id) => ({
    index: OWNER_INDEX.get(id)!,
    ...lensField(id),
    beliefs: state.strategicRegions.map((_, regionId) => Object.fromEntries(
      OBSERVED_LAYERS.map((layer) => {
        const belief = believedValue(state, id, regionId, layer);
        return [layer, Number(belief.value.toFixed(3))];
      }),
    )),
    seenAt: state.strategicRegions.map((_, regionId) =>
      believedValue(state, id, regionId, "prize").observedAt),
  })),
  campaigns: state.campaigns
    .filter((c) => c.target !== "wilderness")
    .map((c) => ({
      id: c.id,
      attacker: OWNER_INDEX.get(c.attacker)!,
      target: OWNER_INDEX.get(c.target as PlayerId)!,
    })),
  theaters,
};

const template = readFileSync("scripts/theater-view.template.html", "utf8");
const json = JSON.stringify(payload).replaceAll("<", "\\u003c");
writeFileSync(out, template.replace("__THEATER_JSON__", () => json));
process.stderr.write(
  `${state.worldName} at tick ${tick}: ${theaters.length} theaters across `
  + `${payload.campaigns.length} wars, ${attackers.length} lenses -> ${out}\n`,
);
