import { ELEMENT_ORDER } from "./elements";
import { RASTER_TERRAIN_ORDER } from "./map-raster-protocol";
import { PLAYER_ORDER } from "./players";
import type { Cell, ElementId, PlayerId, StructureType, TerrainId, WorldState } from "./types";

export const BASE_SIMULATION_TICKS_PER_SECOND = 4;
export const VISUAL_SNAPSHOT_INTERVAL_MS = 250;

/**
 * The cell grid on the wire, one typed array per field.
 *
 * A snapshot used to cross from the simulation worker as forty thousand cell
 * objects, and structured cloning them -- serialized on the worker, parsed on
 * the display thread, four times a second -- was the single largest cost of
 * the higher-resolution world, blocking the display thread for the length of
 * a couple of frames each time. Packed as columns the same grid is a handful
 * of transferable buffers: no serialization at all, and unpacking back into
 * cell objects is a plain allocation loop.
 */
export interface PackedCells {
  count: number;
  /** PLAYER_ORDER index, -1 for none. */
  owner: Int8Array;
  /** RASTER_TERRAIN_ORDER index. */
  terrain: Uint8Array;
  /** STRUCTURE_ORDER index, -1 for none. */
  structure: Int8Array;
  structureLevel: Uint8Array;
  /** PLAYER_ORDER index, -1 for none. */
  capitalOf: Int8Array;
  /** Bit 0 coastal, bit 1 stream, bit 2 pressureTracked. */
  flags: Uint8Array;
  pressure: Float64Array;
  /** PLAYER_ORDER index, -1 for none. */
  pressureBy: Int8Array;
  capturedAt: Int32Array;
  /** ELEMENT_ORDER index, -1 for none. */
  structureHeritage: Int8Array;
}

export const STRUCTURE_ORDER: readonly StructureType[] = [
  "city",
  "fort",
  "factory",
  "harbor",
  "plant",
  "skyport",
];

const PLAYER_CODE: ReadonlyMap<PlayerId, number> = new Map(PLAYER_ORDER.map((id, index) => [id, index]));
const TERRAIN_CODE: ReadonlyMap<TerrainId, number> = new Map(RASTER_TERRAIN_ORDER.map((id, index) => [id, index]));
const STRUCTURE_CODE: ReadonlyMap<StructureType, number> = new Map(STRUCTURE_ORDER.map((id, index) => [id, index]));
const ELEMENT_CODE: ReadonlyMap<ElementId, number> = new Map(ELEMENT_ORDER.map((id, index) => [id, index]));

export function packCells(cells: readonly Cell[]): PackedCells {
  const count = cells.length;
  const packed: PackedCells = {
    count,
    owner: new Int8Array(count),
    terrain: new Uint8Array(count),
    structure: new Int8Array(count),
    structureLevel: new Uint8Array(count),
    capitalOf: new Int8Array(count),
    flags: new Uint8Array(count),
    pressure: new Float64Array(count),
    pressureBy: new Int8Array(count),
    capturedAt: new Int32Array(count),
    structureHeritage: new Int8Array(count),
  };
  for (let index = 0; index < count; index += 1) {
    const cell = cells[index]!;
    packed.owner[index] = cell.owner === null ? -1 : PLAYER_CODE.get(cell.owner)!;
    packed.terrain[index] = TERRAIN_CODE.get(cell.terrain)!;
    packed.structure[index] = cell.structure === null ? -1 : STRUCTURE_CODE.get(cell.structure)!;
    packed.structureLevel[index] = cell.structureLevel;
    packed.capitalOf[index] = cell.capitalOf === null ? -1 : PLAYER_CODE.get(cell.capitalOf)!;
    packed.flags[index] = (cell.coastal ? 1 : 0) | (cell.stream ? 2 : 0) | (cell.pressureTracked ? 4 : 0);
    packed.pressure[index] = cell.pressure;
    packed.pressureBy[index] = cell.pressureBy === null ? -1 : PLAYER_CODE.get(cell.pressureBy)!;
    packed.capturedAt[index] = cell.capturedAt;
    packed.structureHeritage[index] = cell.structureHeritage === null
      ? -1
      : ELEMENT_CODE.get(cell.structureHeritage)!;
  }
  return packed;
}

export function unpackCells(packed: PackedCells): Cell[] {
  const cells: Cell[] = new Array(packed.count);
  for (let index = 0; index < packed.count; index += 1) {
    const owner = packed.owner[index]!;
    const structure = packed.structure[index]!;
    const capitalOf = packed.capitalOf[index]!;
    const pressureBy = packed.pressureBy[index]!;
    const heritage = packed.structureHeritage[index]!;
    const flags = packed.flags[index]!;
    cells[index] = {
      owner: owner < 0 ? null : PLAYER_ORDER[owner]!,
      terrain: RASTER_TERRAIN_ORDER[packed.terrain[index]!]!,
      structure: structure < 0 ? null : STRUCTURE_ORDER[structure]!,
      structureLevel: packed.structureLevel[index]!,
      capitalOf: capitalOf < 0 ? null : PLAYER_ORDER[capitalOf]!,
      coastal: (flags & 1) !== 0,
      stream: (flags & 2) !== 0,
      pressure: packed.pressure[index]!,
      pressureBy: pressureBy < 0 ? null : PLAYER_ORDER[pressureBy]!,
      pressureTracked: (flags & 4) !== 0,
      capturedAt: packed.capturedAt[index]!,
      structureHeritage: heritage < 0 ? null : ELEMENT_ORDER[heritage]!,
    };
  }
  return cells;
}

/** The buffers to hand postMessage as transferables, so the grid moves without a copy. */
export function packedCellBuffers(packed: PackedCells): ArrayBuffer[] {
  return [
    packed.owner.buffer,
    packed.terrain.buffer,
    packed.structure.buffer,
    packed.structureLevel.buffer,
    packed.capitalOf.buffer,
    packed.flags.buffer,
    packed.pressure.buffer,
    packed.pressureBy.buffer,
    packed.capturedAt.buffer,
    packed.structureHeritage.buffer,
  ] as ArrayBuffer[];
}

export type SimulationWorkerCommand =
  | { type: "initialize"; seed: number; running: boolean; speed: number; aggression: number }
  | { type: "set-running"; running: boolean }
  | { type: "set-speed"; speed: number }
  | { type: "set-aggression"; aggression: number }
  | { type: "new-world"; seed: number; aggression: number };

export type SimulationWorkerEvent = {
  type: "snapshot";
  /** The world without its cells (an empty array); the grid rides alongside, packed. */
  world: WorldState;
  packedCells: PackedCells;
  reportDelta: WorldState["reports"];
  replaceHistory: boolean;
};
