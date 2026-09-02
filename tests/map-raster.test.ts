import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import { ELEMENTS } from "../app/game/elements";
import {
  RASTER_PLAYER_INDEX,
  RASTER_PLAYER_ORDER,
  RASTER_TERRAIN_INDEX,
} from "../app/game/map-raster-protocol";
import type { PoliticalRasterRequest, TheaterRasterRequest } from "../app/game/map-raster-protocol";
import { renderPolitical, renderTheaters } from "../app/game/map-raster.worker";
import { TERRAIN_RULES } from "../app/game/rules";
import type { WorldState } from "../app/game/types";

/**
 * The map raster, one pixel per area. These tests pin its contracts: the
 * raster is exactly the world grid, an area's pixel is a pure function of
 * that area's attributes (terrain, owner, selection), two interior areas
 * with the same attributes wear the same pixel, and a realm's border is the
 * perimeter of its territory painted a darker shade of the realm's own
 * color -- no blur, no probability field, no sub-cell sampling.
 */

const FIXTURE_SEED = 0x240823;

let FIXTURE: WorldState | null = null;

/** One shared snapshot: the renderer never mutates its request or the world. */
function fixtureWorld(): WorldState {
  if (FIXTURE) return FIXTURE;
  const engine = new ElementalWarEngine(FIXTURE_SEED);
  // Stake the realms so territories are broad enough to have interiors.
  engine.observe((state) => {
    for (const faction of Object.values(state.factions)) faction.gold = 200_000;
  });
  engine.advance(400);
  FIXTURE = engine.snapshot();
  return FIXTURE;
}

function politicalRequest(state: WorldState, selected = 0): PoliticalRasterRequest {
  const terrains = new Uint8Array(state.cells.length);
  const owners = new Int8Array(state.cells.length).fill(-1);
  for (let index = 0; index < state.cells.length; index += 1) {
    terrains[index] = RASTER_TERRAIN_INDEX.get(state.cells[index]!.terrain)!;
    const owner = state.cells[index]!.owner;
    if (owner) owners[index] = RASTER_PLAYER_INDEX.get(owner)!;
  }
  const playerColors = new Uint8Array(RASTER_PLAYER_ORDER.length * 3);
  for (let index = 0; index < RASTER_PLAYER_ORDER.length; index += 1) {
    const element = ELEMENTS[state.factions[RASTER_PLAYER_ORDER[index]!]!.expressedElement];
    const value = Number.parseInt(element.color.slice(1), 16);
    playerColors[index * 3] = (value >> 16) & 255;
    playerColors[index * 3 + 1] = (value >> 8) & 255;
    playerColors[index * 3 + 2] = value & 255;
  }
  return {
    type: "render",
    requestId: 1,
    gridWidth: state.config.width,
    gridHeight: state.config.height,
    terrains,
    mode: "political",
    selected,
    owners,
    playerColors,
  };
}

/** Cardinal neighbours inside the grid. */
function neighbours(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = (index - x) / width;
  const result: number[] = [];
  if (x > 0) result.push(index - 1);
  if (x < width - 1) result.push(index + 1);
  if (y > 0) result.push(index - width);
  if (y < height - 1) result.push(index + width);
  return result;
}

function isPerimeter(state: WorldState, index: number): boolean {
  const owner = state.cells[index]!.owner;
  return neighbours(index, state.config.width, state.config.height)
    .some((neighbour) => state.cells[neighbour]!.owner !== owner);
}

test("the political raster is exactly one pixel per area", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  assert.equal(result.rasterWidth, state.config.width);
  assert.equal(result.rasterHeight, state.config.height);
  assert.equal(result.fill.length, state.cells.length * 4);
  for (let index = 0; index < state.cells.length; index += 1) {
    assert.equal(result.fill[index * 4 + 3], 255);
  }
});

test("water areas wear the flat water color regardless of politics", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  const value = Number.parseInt(TERRAIN_RULES.water.fill.slice(1), 16);
  let waters = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index]!.terrain !== "water") continue;
    waters += 1;
    assert.equal(result.fill[index * 4], (value >> 16) & 255);
    assert.equal(result.fill[index * 4 + 1], (value >> 8) & 255);
    assert.equal(result.fill[index * 4 + 2], value & 255);
  }
  assert.ok(waters > 0, "expected the fixture world to have ocean");
});

test("two interior areas with the same attributes wear the same pixel", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  // Group interior owned pixels by (owner, terrain); each group must be one color.
  const seen = new Map<string, [number, number, number]>();
  let interiors = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (!cell.owner || cell.terrain === "water" || isPerimeter(state, index)) continue;
    interiors += 1;
    const key = `${cell.owner}|${cell.terrain}`;
    const pixel: [number, number, number] = [
      result.fill[index * 4]!,
      result.fill[index * 4 + 1]!,
      result.fill[index * 4 + 2]!,
    ];
    const expected = seen.get(key);
    if (!expected) seen.set(key, pixel);
    else assert.deepEqual(pixel, expected, `interior pixels differ for ${key}`);
  }
  assert.ok(interiors > 0, "expected the fixture realms to have interior areas");
});

test("a realm's border is its perimeter, darker than its interior", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  let compared = 0;
  const interiorByKey = new Map<string, number>();
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (!cell.owner || cell.terrain === "water" || isPerimeter(state, index)) continue;
    interiorByKey.set(`${cell.owner}|${cell.terrain}`, index);
  }
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (!cell.owner || cell.terrain === "water" || !isPerimeter(state, index)) continue;
    const interior = interiorByKey.get(`${cell.owner}|${cell.terrain}`);
    if (interior === undefined) continue;
    compared += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const edge = result.fill[index * 4 + channel]!;
      const core = result.fill[interior * 4 + channel]!;
      // The perimeter pixel is the interior pixel darkened by one factor.
      assert.ok(
        edge <= core,
        `perimeter channel ${channel} (${edge}) brighter than interior (${core})`,
      );
      assert.ok(
        Math.abs(edge - core * 0.58) <= 2,
        `perimeter channel ${channel} (${edge}) is not interior (${core}) darkened by 0.58`,
      );
    }
  }
  assert.ok(compared > 0, "expected perimeter areas matching an interior to compare");
});

test("unowned land never darkens as perimeter", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  const seen = new Map<string, [number, number, number]>();
  let neutrals = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (cell.owner || cell.terrain === "water") continue;
    neutrals += 1;
    const pixel: [number, number, number] = [
      result.fill[index * 4]!,
      result.fill[index * 4 + 1]!,
      result.fill[index * 4 + 2]!,
    ];
    const expected = seen.get(cell.terrain);
    if (!expected) seen.set(cell.terrain, pixel);
    else assert.deepEqual(pixel, expected, `wilderness pixels differ on ${cell.terrain}`);
  }
  assert.ok(neutrals > 0, "expected unsettled wilderness in the fixture");
});

test("selection brightens the selected realm and nothing else", () => {
  const state = fixtureWorld();
  const first = renderPolitical(politicalRequest(state, 0));
  const second = renderPolitical(politicalRequest(state, 1));
  let selectedChanged = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    const owner = state.cells[index]!.owner;
    const field = owner ? RASTER_PLAYER_INDEX.get(owner)! : -1;
    const same = first.fill[index * 4] === second.fill[index * 4]
      && first.fill[index * 4 + 1] === second.fill[index * 4 + 1]
      && first.fill[index * 4 + 2] === second.fill[index * 4 + 2];
    if (field === 0 || field === 1) {
      if (!same) selectedChanged += 1;
    } else {
      assert.ok(same, "an unselected area repainted when the selection moved");
    }
  }
  assert.ok(selectedChanged > 0, "expected the selection change to repaint the two realms");
});

test("the political render is deterministic", () => {
  const state = fixtureWorld();
  const first = renderPolitical(politicalRequest(state));
  const second = renderPolitical(politicalRequest(state));
  assert.deepEqual(Array.from(first.fill), Array.from(second.fill));
});

test("the theater raster is one pixel per area too", () => {
  const state = fixtureWorld();
  const terrains = new Uint8Array(state.cells.length);
  const values = new Float32Array(state.cells.length);
  for (let index = 0; index < state.cells.length; index += 1) {
    terrains[index] = RASTER_TERRAIN_INDEX.get(state.cells[index]!.terrain)!;
    values[index] = (index % 97) / 96;
  }
  const request: TheaterRasterRequest = {
    type: "render",
    requestId: 2,
    gridWidth: state.config.width,
    gridHeight: state.config.height,
    terrains,
    mode: "theaters",
    values,
  };
  const result = renderTheaters(request);
  assert.equal(result.rasterWidth, state.config.width);
  assert.equal(result.rasterHeight, state.config.height);
  assert.equal(result.fill.length, state.cells.length * 4);
  const water = Number.parseInt(TERRAIN_RULES.water.fill.slice(1), 16);
  for (let index = 0; index < state.cells.length; index += 1) {
    assert.equal(result.fill[index * 4 + 3], 255);
    if (state.cells[index]!.terrain === "water") {
      assert.equal(result.fill[index * 4], (water >> 16) & 255);
      assert.equal(result.fill[index * 4 + 1], (water >> 8) & 255);
      assert.equal(result.fill[index * 4 + 2], water & 255);
    }
  }
});
