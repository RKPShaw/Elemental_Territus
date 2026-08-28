import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import {
  RASTER_PLAYER_INDEX,
  RASTER_PLAYER_ORDER,
} from "../app/game/map-raster-protocol";
import { PoliticalFieldSmoother, politicalFieldArrays } from "../app/game/political-field";
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
  assert.deepEqual(Array.from(actual.fading), Array.from(expected.fading));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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

test("a cell that changed hands crossfades from wherever the push already reached", () => {
  const { before, after } = snapshotPair(8);
  let handovers = 0;
  const early = politicalFieldArrays(before, after, 0.25);
  for (let index = 0; index < after.cells.length; index += 1) {
    const cellBefore = before.cells[index]!;
    const wasOwner = cellBefore.owner;
    const nowOwner = after.cells[index]!.owner;
    if (wasOwner === nowOwner || !wasOwner || !nowOwner) continue;
    handovers += 1;
    // The old claim fades from where the captor's push had already carried
    // the cell -- a capture continues the sweep instead of replaying it.
    const priorPush = cellBefore.pressureBy === nowOwner ? clamp01(cellBefore.pressure) : 0;
    const expected = (1 - priorPush) * 0.75;
    assert.equal(early.owners[index], RASTER_PLAYER_INDEX.get(nowOwner));
    if (expected > 0) {
      assert.equal(early.pressureOwners[index], RASTER_PLAYER_INDEX.get(wasOwner));
      assert.equal(early.fading[index], 1);
      assert.ok(Math.abs(early.pressures[index]! - expected) < 1e-6);
    }
  }
  // Settled wilderness reads as the new claim growing over neutral ground,
  // again continuing from the settlers' prior pressure.
  let settlements = 0;
  for (let index = 0; index < after.cells.length; index += 1) {
    const cellBefore = before.cells[index]!;
    const wasOwner = cellBefore.owner;
    const nowOwner = after.cells[index]!.owner;
    if (wasOwner !== null || !nowOwner) continue;
    settlements += 1;
    const priorPush = cellBefore.pressureBy === nowOwner ? clamp01(cellBefore.pressure) : 0;
    const expected = priorPush + (1 - priorPush) * 0.25;
    assert.equal(early.owners[index], -1);
    assert.equal(early.pressureOwners[index], RASTER_PLAYER_INDEX.get(nowOwner));
    assert.equal(early.fading[index], 0);
    assert.ok(Math.abs(early.pressures[index]! - expected) < 1e-6);
  }
  assert.ok(
    handovers + settlements > 0,
    "expected the fixture window to move at least one cell between owners",
  );
});

function syntheticField(
  owner: number,
  pressureOwner: number,
  pressure: number,
  fading = 0,
): PoliticalFieldArrays {
  return {
    owners: Int8Array.of(owner),
    pressureOwners: Int8Array.of(pressureOwner),
    pressures: Float32Array.of(pressure),
    fading: Uint8Array.of(fading),
  };
}

test("the smoother lets a push advance freely but never snap back", () => {
  const smoother = new PoliticalFieldSmoother();
  const rising = syntheticField(0, 1, 0.6);
  smoother.smooth(rising, 0);
  assert.ok(Math.abs(rising.pressures[0]! - 0.6) < 1e-6);

  // The raw reading tumbles to 0.2 a tenth of a second later; the drawn line
  // may recede only at the recession rate (0.3/s), so it barely moves.
  const tumbling = syntheticField(0, 1, 0.2);
  const push = smoother.smooth(tumbling, 100);
  assert.ok(Math.abs(tumbling.pressures[0]! - 0.57) < 1e-6);
  assert.equal(push.pushOwners[0], 1);
  assert.ok(Math.abs(push.pushStrengths[0]! - 0.57) < 1e-6);

  // A higher reading is followed immediately: advances are never held back.
  const surging = syntheticField(0, 1, 0.8);
  smoother.smooth(surging, 200);
  assert.ok(Math.abs(surging.pressures[0]! - 0.8) < 1e-6);
});

test("the smoother carries a capture through without replaying the sweep", () => {
  const smoother = new PoliticalFieldSmoother();
  smoother.smooth(syntheticField(0, 1, 0.9), 0);

  // The cell changes hands: the wire now shows the new owner with the old
  // claim fading. The attacker's displayed share continues from 0.9 rather
  // than restarting, so captured ground never flashes back to the loser.
  const captured = syntheticField(1, 0, (1 - 0.9) * (1 - 0.25), 1);
  const push = smoother.smooth(captured, 100);
  assert.equal(captured.owners[0], 1);
  assert.ok(1 - captured.pressures[0]! >= 0.9 - 1e-6);
  assert.equal(push.pushOwners[0], 1);

  // Once the fade completes the cell is quietly whole, with no push left.
  const settled = syntheticField(1, -1, 0);
  const done = smoother.smooth(settled, 200);
  assert.equal(settled.pressureOwners[0], -1);
  assert.equal(done.pushOwners[0], -1);
});

test("a vanished push relaxes at the recession rate instead of snapping", () => {
  const smoother = new PoliticalFieldSmoother();
  smoother.smooth(syntheticField(0, 1, 0.6), 0);
  const vanished = syntheticField(0, -1, 0);
  const push = smoother.smooth(vanished, 100);
  // 0.6 minus one tenth of a second at 0.3/s.
  assert.equal(vanished.pressureOwners[0], 1);
  assert.ok(Math.abs(vanished.pressures[0]! - 0.57) < 1e-6);
  assert.equal(push.pushOwners[0], 1);
  // Long after, the relaxation has run out and the cell reads settled again.
  for (let step = 2; step < 30; step += 1) smoother.smooth(syntheticField(0, -1, 0), step * 100);
  const relaxed = syntheticField(0, -1, 0);
  smoother.smooth(relaxed, 3000);
  assert.equal(relaxed.pressureOwners[0], -1);
  assert.equal(relaxed.pressures[0], 0);
});

test("the raster owner index covers the whole roster", () => {
  assert.equal(RASTER_PLAYER_INDEX.size, RASTER_PLAYER_ORDER.length);
  for (const [id, index] of RASTER_PLAYER_INDEX) {
    assert.equal(RASTER_PLAYER_ORDER[index], id);
  }
});
