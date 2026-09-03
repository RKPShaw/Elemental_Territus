import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import { ELEMENTS } from "../app/game/elements";
import {
  RASTER_PLAYER_INDEX,
  RASTER_PLAYER_ORDER,
  RASTER_SCALE,
  RASTER_TERRAIN_INDEX,
} from "../app/game/map-raster-protocol";
import type { PoliticalRasterRequest, TheaterRasterRequest } from "../app/game/map-raster-protocol";
import { renderPolitical, renderTheaters } from "../app/game/map-raster.worker";
import { TERRAIN_RULES } from "../app/game/rules";
import type { WorldState } from "../app/game/types";

/**
 * The map raster, one flat block of RASTER_SCALE by RASTER_SCALE pixels per
 * area. These tests pin its contracts: the raster is exactly the world grid
 * times the scale, an area's block is a pure function of that area's
 * attributes (terrain, owner, selection), two interior areas with the same
 * attributes wear the same flat block, and a realm's border is a thin rim --
 * the one-raster-pixel edge of a frontier area on the sides facing foreign
 * ground, painted a darker shade of the realm's own color. No blur, no
 * probability field, no sub-cell detail beyond the rims.
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

/** Byte offset of one raster pixel inside an area's block. */
function blockOffset(state: WorldState, index: number, sx: number, sy: number): number {
  const width = state.config.width;
  const x = index % width;
  const y = (index - x) / width;
  const rasterWidth = width * RASTER_SCALE;
  return ((y * RASTER_SCALE + sy) * rasterWidth + x * RASTER_SCALE + sx) * 4;
}

/** The center pixel of an area's block, untouched by any rim. */
function centerOffset(state: WorldState, index: number): number {
  const mid = (RASTER_SCALE - 1) >> 1;
  return blockOffset(state, index, mid, mid);
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

/** Cardinal and diagonal neighbours inside the grid. */
function surrounding(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = (index - x) / width;
  const result: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      result.push(ny * width + nx);
    }
  }
  return result;
}

function isPerimeter(state: WorldState, index: number): boolean {
  const owner = state.cells[index]!.owner;
  return neighbours(index, state.config.width, state.config.height)
    .some((neighbour) => state.cells[neighbour]!.owner !== owner);
}

/** True when no neighbour, diagonal included, has a different owner: no rims. */
function isDeepInterior(state: WorldState, index: number): boolean {
  const owner = state.cells[index]!.owner;
  return surrounding(index, state.config.width, state.config.height)
    .every((neighbour) => state.cells[neighbour]!.owner === owner);
}

test("the political raster is one flat block per area at the raster scale", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  assert.equal(result.rasterWidth, state.config.width * RASTER_SCALE);
  assert.equal(result.rasterHeight, state.config.height * RASTER_SCALE);
  assert.equal(result.fill.length, state.cells.length * RASTER_SCALE * RASTER_SCALE * 4);
  for (let pixel = 3; pixel < result.fill.length; pixel += 4) {
    assert.equal(result.fill[pixel], 255);
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
    for (let sy = 0; sy < RASTER_SCALE; sy += 1) {
      for (let sx = 0; sx < RASTER_SCALE; sx += 1) {
        const offset = blockOffset(state, index, sx, sy);
        assert.equal(result.fill[offset], (value >> 16) & 255);
        assert.equal(result.fill[offset + 1], (value >> 8) & 255);
        assert.equal(result.fill[offset + 2], value & 255);
      }
    }
  }
  assert.ok(waters > 0, "expected the fixture world to have ocean");
});

test("two interior areas with the same attributes wear the same flat block", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  // Group deep-interior owned areas by (owner, terrain); each group must be
  // one color, and each block must be flat -- no rim inside the interior.
  const seen = new Map<string, [number, number, number]>();
  let interiors = 0;
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (!cell.owner || cell.terrain === "water" || !isDeepInterior(state, index)) continue;
    interiors += 1;
    const key = `${cell.owner}|${cell.terrain}`;
    const center = centerOffset(state, index);
    const pixel: [number, number, number] = [
      result.fill[center]!,
      result.fill[center + 1]!,
      result.fill[center + 2]!,
    ];
    const expected = seen.get(key);
    if (!expected) seen.set(key, pixel);
    else assert.deepEqual(pixel, expected, `interior pixels differ for ${key}`);
    for (let sy = 0; sy < RASTER_SCALE; sy += 1) {
      for (let sx = 0; sx < RASTER_SCALE; sx += 1) {
        const offset = blockOffset(state, index, sx, sy);
        assert.deepEqual(
          [result.fill[offset], result.fill[offset + 1], result.fill[offset + 2]],
          pixel,
          `interior block not flat for ${key}`,
        );
      }
    }
  }
  assert.ok(interiors > 0, "expected the fixture realms to have interior areas");
});

test("a realm's border is a thin rim on the sides facing foreign ground", () => {
  const state = fixtureWorld();
  const result = renderPolitical(politicalRequest(state));
  let compared = 0;
  const interiorByKey = new Map<string, number>();
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (!cell.owner || cell.terrain === "water" || !isDeepInterior(state, index)) continue;
    interiorByKey.set(`${cell.owner}|${cell.terrain}`, index);
  }
  const width = state.config.width;
  const last = RASTER_SCALE - 1;
  const mid = last >> 1;
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    if (!cell.owner || cell.terrain === "water" || !isPerimeter(state, index)) continue;
    const interior = interiorByKey.get(`${cell.owner}|${cell.terrain}`);
    if (interior === undefined) continue;
    // The rim pixel at the middle of each foreign-facing side is the interior
    // pixel darkened by one factor; the block's center never darkens.
    const x = index % width;
    const sides: Array<[number, number, number]> = [];
    if (x > 0 && state.cells[index - 1]!.owner !== cell.owner) sides.push([index - 1, 0, mid]);
    if (x < width - 1 && state.cells[index + 1]!.owner !== cell.owner) sides.push([index + 1, last, mid]);
    if (index - width >= 0 && state.cells[index - width]!.owner !== cell.owner) sides.push([index - width, mid, 0]);
    if (index + width < state.cells.length && state.cells[index + width]!.owner !== cell.owner) sides.push([index + width, mid, last]);
    if (sides.length === 0) continue;
    compared += 1;
    const center = centerOffset(state, index);
    const interiorCenter = centerOffset(state, interior);
    for (const [, sx, sy] of sides) {
      const rim = blockOffset(state, index, sx, sy);
      for (let channel = 0; channel < 3; channel += 1) {
        const edge = result.fill[rim + channel]!;
        const core = result.fill[interiorCenter + channel]!;
        assert.ok(
          edge <= core,
          `rim channel ${channel} (${edge}) brighter than interior (${core})`,
        );
        assert.ok(
          Math.abs(edge - core * 0.58) <= 2,
          `rim channel ${channel} (${edge}) is not interior (${core}) darkened by 0.58`,
        );
        assert.equal(
          result.fill[center + channel],
          core,
          `perimeter block center darkened; the border should be only a rim`,
        );
      }
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
    const expected = seen.get(cell.terrain);
    for (let sy = 0; sy < RASTER_SCALE; sy += 1) {
      for (let sx = 0; sx < RASTER_SCALE; sx += 1) {
        const offset = blockOffset(state, index, sx, sy);
        const pixel: [number, number, number] = [
          result.fill[offset]!,
          result.fill[offset + 1]!,
          result.fill[offset + 2]!,
        ];
        if (!expected && sx === 0 && sy === 0) seen.set(cell.terrain, pixel);
        else if (expected) assert.deepEqual(pixel, expected, `wilderness pixels differ on ${cell.terrain}`);
        else assert.deepEqual(pixel, seen.get(cell.terrain), `wilderness block not flat on ${cell.terrain}`);
      }
    }
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
    let same = true;
    for (let sy = 0; sy < RASTER_SCALE && same; sy += 1) {
      for (let sx = 0; sx < RASTER_SCALE && same; sx += 1) {
        const offset = blockOffset(state, index, sx, sy);
        same = first.fill[offset] === second.fill[offset]
          && first.fill[offset + 1] === second.fill[offset + 1]
          && first.fill[offset + 2] === second.fill[offset + 2];
      }
    }
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

test("the theater raster is one flat block per area too", () => {
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
  assert.equal(result.rasterWidth, state.config.width * RASTER_SCALE);
  assert.equal(result.rasterHeight, state.config.height * RASTER_SCALE);
  assert.equal(result.fill.length, state.cells.length * RASTER_SCALE * RASTER_SCALE * 4);
  const water = Number.parseInt(TERRAIN_RULES.water.fill.slice(1), 16);
  for (let pixel = 3; pixel < result.fill.length; pixel += 4) {
    assert.equal(result.fill[pixel], 255);
  }
  for (let index = 0; index < state.cells.length; index += 1) {
    if (state.cells[index]!.terrain !== "water") continue;
    for (let sy = 0; sy < RASTER_SCALE; sy += 1) {
      for (let sx = 0; sx < RASTER_SCALE; sx += 1) {
        const offset = blockOffset(state, index, sx, sy);
        assert.equal(result.fill[offset], (water >> 16) & 255);
        assert.equal(result.fill[offset + 1], (water >> 8) & 255);
        assert.equal(result.fill[offset + 2], water & 255);
      }
    }
  }
});
