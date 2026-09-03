import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import { packCells, packedCellBuffers, unpackCells } from "../app/game/simulation-protocol";

/**
 * The cell grid crosses from the simulation worker packed as typed arrays and
 * is rebuilt into cell objects on the display side. The round trip must be
 * lossless field for field, and the packed form must expose exactly the
 * buffers that get transferred.
 */

test("packing and unpacking the grid is lossless", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.observe((state) => {
    for (const faction of Object.values(state.factions)) faction.gold = 200_000;
  });
  engine.advance(320);
  const cells = engine.snapshot().cells;
  const packed = packCells(cells);
  assert.equal(packed.count, cells.length);
  const unpacked = unpackCells(packed);
  assert.equal(unpacked.length, cells.length);
  let owned = 0;
  let structures = 0;
  let pressed = 0;
  for (let index = 0; index < cells.length; index += 1) {
    assert.deepEqual(unpacked[index], cells[index], `cell ${index} changed in transit`);
    if (cells[index]!.owner) owned += 1;
    if (cells[index]!.structure) structures += 1;
    if (cells[index]!.pressureBy) pressed += 1;
  }
  // The fixture must exercise the coded fields, not just an empty world.
  assert.ok(owned > 0 && structures > 0 && pressed > 0, "fixture lacks owned, built or pressed cells");
});

test("a snapshot without cells leaves the grid to the packed form", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(5);
  const withCells = engine.snapshot();
  const withoutCells = engine.snapshot({ cells: false });
  assert.ok(withCells.cells.length > 0);
  assert.equal(withoutCells.cells.length, 0);
  assert.equal(withoutCells.tick, withCells.tick);
  assert.equal(withoutCells.landTiles, withCells.landTiles);
});

test("the transfer list is every packed column's buffer", () => {
  const engine = new ElementalWarEngine(0x240823);
  const packed = packCells(engine.snapshot().cells);
  const buffers = packedCellBuffers(packed);
  const columns = Object.values(packed).filter((value) => ArrayBuffer.isView(value));
  assert.equal(buffers.length, columns.length);
  for (const column of columns) {
    assert.ok(buffers.includes((column as ArrayBufferView).buffer as ArrayBuffer));
  }
});
