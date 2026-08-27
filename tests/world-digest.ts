import { createHash } from "node:crypto";
import type { WorldState } from "../app/game/types";

/**
 * Canonical, representation-independent digest of a world.
 *
 * The digest exists to prove that a refactor changed how the world is *stored*
 * without changing what the simulation *produces*. It therefore hashes semantic
 * values in a fixed order rather than the object graph as it happens to be laid
 * out, so an array-of-structs cell grid and a struct-of-arrays cell grid holding
 * the same world hash identically.
 *
 * Two rules keep it honest:
 *   1. Field order here is fixed. Adding a field changes every baseline, which
 *      is intended — a new gameplay field is a new part of the world.
 *   2. Adapting this file for a new representation is allowed only when the
 *      baselines in determinism.test.ts stay put. If they move, the refactor
 *      changed behaviour and the refactor is wrong.
 */

/** Fixed cell field order. Cells are emitted by ascending index. */
const CELL_FIELDS = [
  "owner",
  "terrain",
  "structure",
  "structureLevel",
  "capitalOf",
  "coastal",
  "pressure",
  "pressureBy",
  "pressureTracked",
  "capturedAt",
] as const;

function writeScalar(parts: string[], value: unknown): void {
  if (value === null || value === undefined) {
    parts.push("~");
    return;
  }
  if (typeof value === "boolean") {
    parts.push(value ? "T" : "F");
    return;
  }
  if (typeof value === "number") {
    // Number#toString round-trips exactly, so bit-level determinism survives.
    parts.push(Number.isFinite(value) ? value.toString() : `!${String(value)}`);
    return;
  }
  parts.push(String(value));
}

function writeValue(parts: string[], value: unknown): void {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = value as unknown as ArrayLike<number>;
    parts.push(`[${view.length}`);
    for (let index = 0; index < view.length; index += 1) writeScalar(parts, view[index]);
    parts.push("]");
    return;
  }
  if (Array.isArray(value)) {
    parts.push(`[${value.length}`);
    for (const entry of value) writeValue(parts, entry);
    parts.push("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    parts.push(`{${keys.length}`);
    for (const key of keys) {
      parts.push(key);
      writeValue(parts, record[key]);
    }
    parts.push("}");
    return;
  }
  writeScalar(parts, value);
}

/**
 * Emits the cell grid field by field, ascending by index, reading through
 * whichever representation the state currently uses.
 */
function writeCells(parts: string[], state: WorldState): void {
  const cells = state.cells as unknown;
  const length = Array.isArray(cells)
    ? cells.length
    : (cells as { length: number }).length;
  parts.push(`cells[${length}`);
  const store = cells as Record<string, ArrayLike<unknown> | undefined>;
  const isStructOfArrays = !Array.isArray(cells);
  for (let index = 0; index < length; index += 1) {
    const cell = isStructOfArrays
      ? null
      : ((cells as unknown[])[index] as Record<string, unknown>);
    for (const field of CELL_FIELDS) {
      const raw = isStructOfArrays ? store[field]?.[index] : cell?.[field];
      writeScalar(parts, normalizeCellValue(field, raw));
    }
  }
  parts.push("]");
}

/**
 * Normalizes encoded cell values back to their semantic form so that an
 * Int8 owner code and an ElementId string produce the same digest.
 */
function normalizeCellValue(field: (typeof CELL_FIELDS)[number], raw: unknown): unknown {
  if (raw === undefined) return null;
  if (typeof raw !== "number") return raw;
  switch (field) {
    case "owner":
    case "capitalOf":
    case "pressureBy":
      return raw < 0 ? null : (ELEMENT_CODES[raw] ?? raw);
    case "terrain":
      return TERRAIN_CODES[raw] ?? raw;
    case "structure":
      return raw < 0 ? null : (STRUCTURE_CODES[raw] ?? raw);
    case "coastal":
    case "pressureTracked":
      return raw === 1;
    default:
      return raw;
  }
}

// Kept local rather than imported so the digest stays pinned to an explicit
// ordering even if the engine's canonical ordering is later moved or renamed.
//
// ELEMENT_CODES predates the fifty-player roster: cell owners are player ids
// now, so a numeric owner code would need a roster table, not this one. It is
// unreachable for the current representation (owners are strings) and stays
// only so an old struct-of-arrays capture still digests. Do not extend it for
// the wider element space; new numeric codes (e.g. structure heritage) must
// map against ELEMENT_SPACE order instead.
const ELEMENT_CODES = ["ember", "tide", "grove", "stone", "gale"] as const;
const TERRAIN_CODES = ["water", "farmland", "plains", "forest", "hills", "mountains"] as const;
const STRUCTURE_CODES = ["city", "fort", "factory", "harbor"] as const;

/** Everything outside the cell grid, hashed with sorted keys. */
const WORLD_FIELDS = [
  "seed",
  "worldName",
  "tick",
  "age",
  "landTiles",
  "factions",
  "relations",
  "campaigns",
  "strategicRegions",
  "strategicMeta",
  "theaterMap",
  "regionByCell",
  "theaters",
  "tradeRoutes",
  "railNetworkSignature",
  "railNetworkNeedsExpansion",
  "tradeVehicles",
  "tradeDispatches",
  "activePressureCells",
  "commands",
  "chronicle",
  "reports",
  "stories",
  "storyCursor",
  "champion",
  "dominantSince",
  "config",
] as const;

export function worldDigest(state: WorldState): string {
  const parts: string[] = [];
  writeCells(parts, state);
  const record = state as unknown as Record<string, unknown>;
  for (const field of WORLD_FIELDS) {
    parts.push(field);
    writeValue(parts, record[field]);
  }
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 32);
}

/** Short digest of just the cell grid, to localize a failure to the map. */
export function cellDigest(state: WorldState): string {
  const parts: string[] = [];
  writeCells(parts, state);
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 16);
}
