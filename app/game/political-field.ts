import { RASTER_PLAYER_INDEX } from "./map-raster-protocol";
import type { WorldState } from "./types";

export interface PoliticalFieldArrays {
  owners: Int8Array;
  pressureOwners: Int8Array;
  pressures: Float32Array;
  /**
   * 1 where `pressures` holds an old claim fading out after a change of
   * hands, so the smoother knows the advancing side is the recorded owner
   * rather than the pressure owner.
   */
  fading: Uint8Array;
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
 * A change of hands starts its fade from wherever the previous snapshot's
 * push had already carried the cell. The capture itself sets pressure back to
 * zero, and fading from scratch replayed the whole sweep of a cell the
 * display had just shown almost fully taken -- that replay was the visible
 * bounce-back on every captured tile.
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
  const fading = new Uint8Array(count);
  const interpolating = previous !== null && blend < 1 && previous.cells.length === count;
  for (let index = 0; index < count; index += 1) {
    const cell = current.cells[index]!;
    const before = interpolating ? previous!.cells[index]! : cell;
    if (before.owner !== cell.owner) {
      const priorPush = before.pressureBy && before.pressureBy === cell.owner
        ? Math.max(0, Math.min(1, before.pressure))
        : 0;
      if (before.owner) {
        // A change of hands: the old claim fades out as the new one fades in,
        // continuing from the push already shown rather than restarting it.
        if (cell.owner) owners[index] = RASTER_PLAYER_INDEX.get(cell.owner)!;
        const fade = (1 - priorPush) * (1 - blend);
        if (fade > 0) {
          pressureOwners[index] = RASTER_PLAYER_INDEX.get(before.owner)!;
          pressures[index] = fade;
          fading[index] = 1;
        }
      } else if (cell.owner) {
        // Settled wilderness: the new claim grows over the neutral ground,
        // from wherever the settlers' pressure had already reached.
        const grown = priorPush + (1 - priorPush) * blend;
        if (grown > 0) {
          pressureOwners[index] = RASTER_PLAYER_INDEX.get(cell.owner)!;
          pressures[index] = grown;
        }
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
  return { owners, pressureOwners, pressures, fading };
}

/** How fast the drawn frontier may fall back, in claim share per second. */
const RECESSION_PER_SECOND = 0.3;

/** The push-direction field the smoother derives alongside the smoothed claims. */
export interface PoliticalPushField {
  /** The advancing claimant per cell in raster player order, -1 where none. */
  pushOwners: Int16Array;
  /** The advancing claimant's displayed share of the cell, in [0, 1]. */
  pushStrengths: Float32Array;
}

/**
 * Wall-clock smoothing of the political field across dispatched frames.
 *
 * The raw pressure readings tremble: theater weights redistribute across the
 * front every tick, decay gnaws at tiles the push is not currently leaning
 * on, and a contested tile loses ground whenever the defender answers.
 * Rendered directly, the frontier jitters back and forth even while a
 * conquest is clearly advancing. The smoother remembers, per cell, who was
 * advancing and how far the display already showed them, and lets the drawn
 * line move forward as fast as the data does while receding only at a slow,
 * steady rate. A push therefore reads as one clean forward sweep, ground
 * shown as taken never flickers back, and a push that genuinely fails
 * relaxes gently instead of snapping.
 *
 * The advancing claimant it tracks is also exactly what the border tint
 * needs, so the smoother hands the renderer a push-direction field for free.
 */
export class PoliticalFieldSmoother {
  private attackers = new Int16Array(0);
  private shares = new Float32Array(0);
  private lastAt = 0;

  /** Forget all display state, for a fresh world. */
  reset(): void {
    this.attackers = new Int16Array(0);
  }

  /**
   * Smooths `field` in place against the remembered display state and returns
   * the push-direction field. `now` is wall-clock milliseconds.
   */
  smooth(field: PoliticalFieldArrays, now: number): PoliticalPushField {
    const count = field.owners.length;
    if (this.attackers.length !== count) {
      this.attackers = new Int16Array(count).fill(-1);
      this.shares = new Float32Array(count);
      this.lastAt = now;
    }
    const recede = RECESSION_PER_SECOND * Math.max(0, Math.min(0.25, (now - this.lastAt) / 1000));
    this.lastAt = now;
    const pushOwners = new Int16Array(count).fill(-1);
    const pushStrengths = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const owner = field.owners[index]!;
      const challenger = field.pressureOwners[index]!;
      const remembered = this.attackers[index]!;
      if (challenger < 0) {
        if (remembered < 0) continue;
        if (remembered === owner) {
          // The advance completed; the cell is quietly whole.
          this.attackers[index] = -1;
          continue;
        }
        // The push vanished from the data; let the drawn line relax at the
        // recession rate instead of snapping back in one frame.
        const share = this.shares[index]! - recede;
        if (share <= 0.02) {
          this.attackers[index] = -1;
          continue;
        }
        this.shares[index] = share;
        field.pressureOwners[index] = remembered;
        field.pressures[index] = share;
        pushOwners[index] = remembered;
        pushStrengths[index] = share;
        continue;
      }
      // After a change of hands the advancing side is the recorded owner and
      // the pressure array holds the loser fading out; otherwise the pressure
      // owner is the one advancing.
      const handover = field.fading[index] === 1 && owner >= 0;
      const attacker = handover ? owner : challenger;
      const target = handover ? 1 - field.pressures[index]! : field.pressures[index]!;
      const share = Math.max(0, Math.min(1,
        remembered === attacker ? Math.max(target, this.shares[index]! - recede) : target,
      ));
      this.attackers[index] = attacker;
      this.shares[index] = share;
      if (handover) {
        const fade = 1 - share;
        field.pressures[index] = fade;
        if (fade <= 0) field.pressureOwners[index] = -1;
      } else {
        field.pressures[index] = share;
      }
      pushOwners[index] = attacker;
      pushStrengths[index] = share;
    }
    return { pushOwners, pushStrengths };
  }
}
