import {
  TERRAIN_RULES,
  calculateTroopCap,
  clamp,
  normalizedCellArea,
} from "../rules";
import { committedTroopsFor } from "../campaigns";
import { PLAYER_ORDER } from "../players";
import type { PlayerId, StructureCounts, WorldState } from "../types";

export interface RealmAccountingDraft {
  territory: number;
  sustainableLand: number;
  structures: StructureCounts;
}

export function emptyStructureCounts(): StructureCounts {
  return { city: 0, fort: 0, factory: 0, harbor: 0, plant: 0, skyport: 0 };
}

export function recalculateRealm(state: WorldState, id: PlayerId): void {
  const draft = collectRealmAccounting(state)[id];
  applyRealmAccounting(state, id, draft);
}

/** Collects every realm in one cell pass while preserving per-realm sum order. */
export function collectRealmAccounting(
  state: WorldState,
): Record<PlayerId, RealmAccountingDraft> {
  const cellArea = normalizedCellArea(state.config);
  const drafts: Record<PlayerId, RealmAccountingDraft> = {};
  for (const id of PLAYER_ORDER) {
    drafts[id] = { territory: 0, sustainableLand: 0, structures: emptyStructureCounts() };
  }
  for (const cell of state.cells) {
    if (!cell.owner) continue;
    const draft = drafts[cell.owner]!;
    draft.territory += 1;
    draft.sustainableLand += TERRAIN_RULES[cell.terrain].sustain * cellArea;
    if (cell.structure) {
      draft.structures[cell.structure] += cell.structure === "city"
        ? Math.max(1, cell.structureLevel)
        : 1;
    }
  }
  return drafts;
}

export function applyRealmAccounting(
  state: WorldState,
  id: PlayerId,
  draft: RealmAccountingDraft,
): void {
  const faction = state.factions[id];
  const { territory, sustainableLand, structures } = draft;
  faction.momentum = territory - faction.previousTerritory;
  faction.previousTerritory = territory;
  faction.territory = territory;
  faction.sustainableLand = sustainableLand;
  faction.structures = structures;
  faction.troopCap = calculateTroopCap(
    sustainableLand,
    structures.city,
    state.config.maximumTroops,
  );
  faction.alive = territory > 0;
  const committed = committedTroopsFor(state, id);
  faction.troops = clamp(faction.troops, 0, Math.max(0, faction.troopCap - committed));
}
