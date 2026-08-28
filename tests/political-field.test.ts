import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import {
  RASTER_PLAYER_INDEX,
  RASTER_PLAYER_ORDER,
} from "../app/game/map-raster-protocol";
import { politicalFieldArrays } from "../app/game/political-field";
import type { PoliticalFieldArrays } from "../app/game/political-field";
import type { WorldState } from "../app/game/types";

/**
 * The interpolated political field the map renders between two authoritative
 * snapshots. These tests pin its contracts: the endpoints agree exactly with
 * the plain per-snapshot encoding, so a snapshot handoff never pops; pressures
 * glide monotonically between their readings; and a cell that changed hands
 * carries the old claim fading out as the new one fades in, which is what
 * moves the drawn frontier continuously instead of stepping it.
 */

const FIXTURE_SEED = 0x240823;

function snapshotPair(ticksApart: number): { before: WorldState; after: WorldState } {
  const engine = new ElementalWarEngine(FIXTURE_SEED);
  engine.advance(240);
  const before = engine.snapshot();
  engine.advance(ticksApart);
  const after = engine.snapshot();
  return { before, after };
}

function assertSameField(actual: PoliticalFieldArrays, expected: PoliticalFieldArrays): void {
  assert.deepEqual(Array.from(actual.owners), Array.from(expected.owners));
  assert.deepEqual(Array.from(actual.pressureOwners), Array.from(expected.pressureOwners));
  assert.deepEqual(Array.from(actual.pressures), Array.from(expected.pressures));
}

test("blend 1 reproduces the plain encoding of the current snapshot", () => {
  const { before, after } = snapshotPair(4);
  assertSameField(
    politicalFieldArrays(before, after, 1),
    politicalFieldArrays(null, after, 1),
  );
});

test("the plain encoding matches the snapshot cell by cell", () => {
  const { after } = snapshotPair(4);
  const field = politicalFieldArrays(null, after, 1);
  for (let index = 0; index < after.cells.length; index += 1) {
    const cell = after.cells[index]!;
    if (cell.owner) {
      assert.equal(field.owners[index], RASTER_PLAYER_INDEX.get(cell.owner));
    } else {
      assert.equal(field.owners[index], -1);
    }
    if (cell.pressureBy && cell.pressureBy !== cell.owner && cell.pressure > 0) {
      assert.equal(field.pressureOwners[index], RASTER_PLAYER_INDEX.get(cell.pressureBy));
      assert.ok(Math.abs(field.pressures[index]! - Math.min(1, cell.pressure)) < 1e-6);
    } else {
      assert.equal(field.pressureOwners[index], -1);
      assert.equal(field.pressures[index], 0);
    }
  }
});

test("interpolated pressures stay bounded and glide between the two readings", () => {
  const { before, after } = snapshotPair(6);
  const start = politicalFieldArrays(before, after, 0);
  const middle = politicalFieldArrays(before, after, 0.5);
  const end = politicalFieldArrays(before, after, 1);
  for (const field of [start, middle, end]) {
    for (let index = 0; index < field.pressures.length; index += 1) {
      const pressure = field.pressures[index]!;
      assert.ok(Number.isFinite(pressure));
      assert.ok(pressure >= 0 && pressure <= 1);
      const claimed = field.pressureOwners[index]! >= 0;
      if (!claimed) assert.equal(pressure, 0);
      if (claimed) assert.notEqual(field.pressureOwners[index], field.owners[index]);
    }
  }
  // Where the same realm presses the same cell in both snapshots, the
  // midpoint reading sits between the two endpoint readings.
  let gliding = 0;
  for (let index = 0; index < after.cells.length; index += 1) {
    const cellBefore = before.cells[index]!;
    const cellAfter = after.cells[index]!;
    if (cellBefore.owner !== cellAfter.owner) continue;
    if (!cellAfter.pressureBy || cellAfter.pressureBy !== cellBefore.pressureBy) continue;
    if (cellAfter.pressureBy === cellAfter.owner) continue;
    if (cellAfter.pressure <= 0) continue;
    const low = Math.min(start.pressures[index]!, end.pressures[index]!);
    const high = Math.max(start.pressures[index]!, end.pressures[index]!);
    assert.ok(middle.pressures[index]! >= low - 1e-6);
    assert.ok(middle.pressures[index]! <= high + 1e-6);
    gliding += 1;
  }
  assert.ok(gliding > 0, "expected at least one continuously pressed cell in the fixture");
});

test("a cell that changed hands crossfades the old claim into the new one", () => {
  const { before, after } = snapshotPair(8);
  let handovers = 0;
  const early = politicalFieldArrays(before, after, 0.25);
  for (let index = 0; index < after.cells.length; index += 1) {
    const wasOwner = before.cells[index]!.owner;
    const nowOwner = after.cells[index]!.owner;
    if (wasOwner === nowOwner || !wasOwner || !nowOwner) continue;
    handovers += 1;
    assert.equal(early.owners[index], RASTER_PLAYER_INDEX.get(nowOwner));
    assert.equal(early.pressureOwners[index], RASTER_PLAYER_INDEX.get(wasOwner));
    assert.ok(Math.abs(early.pressures[index]! - 0.75) < 1e-6);
  }
  // Settled wilderness reads as the new claim growing over neutral ground.
  let settlements = 0;
  for (let index = 0; index < after.cells.length; index += 1) {
    const wasOwner = before.cells[index]!.owner;
    const nowOwner = after.cells[index]!.owner;
    if (wasOwner !== null || !nowOwner) continue;
    settlements += 1;
    assert.equal(early.owners[index], -1);
    assert.equal(early.pressureOwners[index], RASTER_PLAYER_INDEX.get(nowOwner));
    assert.ok(Math.abs(early.pressures[index]! - 0.25) < 1e-6);
  }
  assert.ok(
    handovers + settlements > 0,
    "expected the fixture window to move at least one cell between owners",
  );
});

test("the raster owner index covers the whole roster", () => {
  assert.equal(RASTER_PLAYER_INDEX.size, RASTER_PLAYER_ORDER.length);
  for (const [id, index] of RASTER_PLAYER_INDEX) {
    assert.equal(RASTER_PLAYER_ORDER[index], id);
  }
});
