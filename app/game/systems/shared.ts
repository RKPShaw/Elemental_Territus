import {
  FORT_RADIUS,
  TERRAIN_RULES,
  calculateTroopCap,
  clamp,
  normalizedCellArea,
  normalizedCellLength,
} from "../rules";
import { committedTroopsFor } from "../campaigns";
import { cellsWithin } from "../grid";
import type { ElementId, StructureCounts, WorldState } from "../types";

export interface RealmAccountingDraft {
  territory: number;
  sustainableLand: number;
  structures: StructureCounts;
}

export function emptyStructureCounts(): StructureCounts {
  return { city: 0, fort: 0, factory: 0, harbor: 0 };
}

export function defenseMultiplier(
  state: WorldState,
  tileIndex: number,
  defender: ElementId,
): number {
  const tile = state.cells[tileIndex]!;
  let protection = 1;
  const lengthScale = normalizedCellLength(state.config);
  for (const nearby of cellsWithin(state, tileIndex, FORT_RADIUS / lengthScale)) {
    const cell = state.cells[nearby]!;
    if (cell.owner !== defender) continue;
    if (cell.structure === "fort") {
      protection = 2;
      break;
    }
  }
  const cityResistance = tile.structure === "city" ? 1.1 : 1;
  return TERRAIN_RULES[tile.terrain].defenseCost * protection * cityResistance;
}

export function recalculateRealm(state: WorldState, id: ElementId): void {
  const draft = collectRealmAccounting(state)[id];
  applyRealmAccounting(state, id, draft);
}

/** Collects every realm in one cell pass while preserving per-realm sum order. */
export function collectRealmAccounting(
  state: WorldState,
): Record<ElementId, RealmAccountingDraft> {
  const cellArea = normalizedCellArea(state.config);
  const drafts = {
    ember: { territory: 0, sustainableLand: 0, structures: emptyStructureCounts() },
    tide: { territory: 0, sustainableLand: 0, structures: emptyStructureCounts() },
    grove: { territory: 0, sustainableLand: 0, structures: emptyStructureCounts() },
    stone: { territory: 0, sustainableLand: 0, structures: emptyStructureCounts() },
    gale: { territory: 0, sustainableLand: 0, structures: emptyStructureCounts() },
  } satisfies Record<ElementId, RealmAccountingDraft>;
  for (const cell of state.cells) {
    if (!cell.owner) continue;
    const draft = drafts[cell.owner];
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
  id: ElementId,
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
