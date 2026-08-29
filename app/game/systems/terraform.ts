import { PLAYER_ORDER } from "../players";
import { cellNoise } from "../random";
import { markCellsChanged } from "../structure-index";
import { TERRAIN_RULES, TERRAFORM_RULES } from "../rules";
import { signatureTerrainsOf, terraformTargetAt } from "../terraform";
import { realmTitle } from "../naming";
import { realmSubject } from "../reporting";
import type { PlayerId, SimulationContext, SimulationSystem, TerrainId } from "../types";

/**
 * Dwell terraforming: the first system that changes terrain after worldgen.
 *
 * Every sweep walks the map once and asks one question per owned land cell:
 * has the owner's expressed element dwelt here past its threshold? Tenure is
 * `tick - capturedAt` — the clock every capture already stamps — so founding
 * heartlands (capturedAt -99) transform first and freshly taken ground
 * starts over, which is exactly the story: the land answers to whoever has
 * actually lived on it. A pure cell-noise jitter spreads each threshold so
 * province-wide annexations transform as a creeping stain, not a wall; the
 * hash consumes no RNG stream, so replays and sibling engines stay honest.
 *
 * The same pass refreshes each realm's saturation — the share of its land
 * already turned to its own signature terrain. Saturation is the fuel gauge
 * of imperial stagnation: an element that has fully remade its country has
 * spent itself on it, and later systems read that as strain.
 *
 * Reporting is aggregated per realm per sweep, never per cell — seventeen
 * thousand cells make per-cell reports a ledger flood.
 */
export class TerraformSystem implements SimulationSystem {
  readonly id = "dwell-terraforming";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.tick % TERRAFORM_RULES.sweepCadenceTicks !== 0) return;
    const transformed = new Map<PlayerId, Map<TerrainId, number>>();
    const signature = new Map<PlayerId, number>();
    const held = new Map<PlayerId, number>();
    let anyChanged = false;
    for (let index = 0; index < state.cells.length; index += 1) {
      const cell = state.cells[index]!;
      const owner = cell.owner;
      if (!owner || cell.terrain === "water") continue;
      held.set(owner, (held.get(owner) ?? 0) + 1);
      const element = state.factions[owner].expressedElement;
      const transform = terraformTargetAt(element, cell.terrain);
      if (transform) {
        const tenure = state.tick - cell.capturedAt;
        const jitter = (cellNoise(state.seed ^ 0x7e44a397, index, 0) - 0.5)
          * 2 * TERRAFORM_RULES.jitterTicks;
        if (tenure >= transform.dwellTicks + jitter) {
          cell.terrain = transform.to;
          anyChanged = true;
          let counts = transformed.get(owner);
          if (!counts) {
            counts = new Map();
            transformed.set(owner, counts);
          }
          counts.set(transform.to, (counts.get(transform.to) ?? 0) + 1);
        }
      }
      if (signatureTerrainsOf(element).has(cell.terrain)) {
        signature.set(owner, (signature.get(owner) ?? 0) + 1);
      }
    }
    if (anyChanged) markCellsChanged(state);
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) {
        faction.saturation = 0;
        continue;
      }
      const owned = held.get(id) ?? 0;
      const previousSaturation = faction.saturation;
      faction.saturation = owned > 0 ? (signature.get(id) ?? 0) / owned : 0;
      const counts = transformed.get(id);
      if (!counts) continue;
      const turned = [...counts.entries()];
      const total = turned.reduce((sum, [, count]) => sum + count, 0);
      const described = turned
        .map(([terrain, count]) => `${count} to ${TERRAIN_RULES[terrain].name.toLowerCase()}`)
        .join(", ");
      context.report({
        domain: "society",
        kind: "society.land-transformed",
        importance: "notable",
        storyKey: `terraform:${id}`,
        initiator: realmSubject(state, id),
        targets: [],
        participants: [],
        links: {},
        facts: {
          cells: total,
          byTerrain: Object.fromEntries(turned),
          saturation: faction.saturation,
          element: faction.expressedElement,
        },
        summary: `${realmTitle(state, id)} has dwelt on its land until the land answered: ${described}.`,
      });
      // The first mark a realm leaves is an observer beat; the rest is the
      // land quietly keeping up with its owner.
      if (previousSaturation === 0) {
        context.emit(
          `The lands of ${realmTitle(state, id)} begin to change — ${described}.`,
          "world",
          id,
        );
      }
    }
  }
}
