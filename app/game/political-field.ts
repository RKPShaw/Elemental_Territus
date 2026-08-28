import { RASTER_PLAYER_INDEX } from "./map-raster-protocol";
import type { WorldState } from "./types";

export interface PoliticalFieldArrays {
  owners: Int8Array;
  pressureOwners: Int8Array;
  pressures: Float32Array;
}

/**
 * The political field at a moment between two authoritative snapshots.
 *
 * The simulation only speaks a few times a second, and at high speed each
 * snapshot moves the fronts several ticks at once, which is what made the map
 * feel framey: territory arrived in steps. The border pipeline already treats
 * ownership as weighted claims, so a moment between snapshots is expressible
 * in the same wire format -- pressures glide between their two readings, a
 * cell that changed hands carries the old claim fading out as the new one
 * fades in, and settled wilderness grows its claim over the neutral ground.
 * The blurred field then moves the drawn frontier continuously.
 *
 * At `blend >= 1`, or without a previous snapshot, the result is exactly the
 * plain encoding of the current state, so the final interpolated frame of one
 * snapshot is identical to the first frame of the next.
 */
export function politicalFieldArrays(
  previous: WorldState | null,
  current: WorldState,
  blend: number,
): PoliticalFieldArrays {
  const count = current.cells.length;
  const owners = new Int8Array(count).fill(-1);
  const pressureOwners = new Int8Array(count).fill(-1);
  const pressures = new Float32Array(count);
  const interpolating = previous !== null && blend < 1 && previous.cells.length === count;
  for (let index = 0; index < count; index += 1) {
    const cell = current.cells[index]!;
    const before = interpolating ? previous!.cells[index]! : cell;
    if (before.owner !== cell.owner) {
      if (before.owner) {
        // A change of hands: the old claim fades out as the new one fades in.
        if (cell.owner) owners[index] = RASTER_PLAYER_INDEX.get(cell.owner)!;
        pressureOwners[index] = RASTER_PLAYER_INDEX.get(before.owner)!;
        pressures[index] = 1 - blend;
      } else if (cell.owner) {
        // Settled wilderness: the new claim grows over the neutral ground.
        pressureOwners[index] = RASTER_PLAYER_INDEX.get(cell.owner)!;
        pressures[index] = blend;
      }
      continue;
    }
    if (cell.owner) owners[index] = RASTER_PLAYER_INDEX.get(cell.owner)!;
    const pressureNow = cell.pressureBy && cell.pressureBy !== cell.owner
      ? Math.max(0, Math.min(1, cell.pressure))
      : 0;
    if (!interpolating) {
      if (pressureNow > 0) {
        pressureOwners[index] = RASTER_PLAYER_INDEX.get(cell.pressureBy!)!;
        pressures[index] = pressureNow;
      }
      continue;
    }
    const pressureBefore = before.pressureBy && before.pressureBy !== before.owner
      ? Math.max(0, Math.min(1, before.pressure))
      : 0;
    if (pressureNow > 0) {
      const from = before.pressureBy === cell.pressureBy ? pressureBefore : 0;
      pressureOwners[index] = RASTER_PLAYER_INDEX.get(cell.pressureBy!)!;
      pressures[index] = from + (pressureNow - from) * blend;
    } else if (pressureBefore > 0) {
      pressureOwners[index] = RASTER_PLAYER_INDEX.get(before.pressureBy!)!;
      pressures[index] = pressureBefore * (1 - blend);
    }
  }
  return { owners, pressureOwners, pressures };
}
