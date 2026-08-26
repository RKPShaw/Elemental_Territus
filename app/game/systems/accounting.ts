import { NATIONS, NATION_ORDER } from "../nations";
import { ELEMENTS } from "../elements";
import { getRelation } from "../diplomacy";
import { realmSubject } from "../reporting";
import { applyRealmAccounting, collectRealmAccounting } from "./shared";
import type { SimulationContext, SimulationSystem } from "../types";

export class RealmAccountingSystem implements SimulationSystem {
  readonly id = "realm-accounting";

  update(context: SimulationContext): void {
    const { state } = context;
    const drafts = collectRealmAccounting(state);
    for (const id of NATION_ORDER) {
      const wasAlive = state.factions[id].alive;
      applyRealmAccounting(state, id, drafts[id]);
      if (wasAlive && !state.factions[id].alive) {
        const conquerorId = state.factions[id].lastConqueror;
        const conqueror = conquerorId ? state.factions[conquerorId] : null;
        if (conqueror?.alive) {
          conqueror.absorbedElements = [...new Set([
            ...conqueror.absorbedElements,
            ...state.factions[id].absorbedElements,
          ])];
        }
        const relation = conquerorId ? getRelation(state, conquerorId, id) : null;
        context.report({
          domain: "territory",
          kind: "territory.realm-conquered",
          importance: "historic",
          storyKey: relation?.storyKey ?? `conquest:${conquerorId ?? "none"}:${id}:${state.tick}`,
          initiator: conquerorId ? realmSubject(conquerorId) : null,
          targets: [realmSubject(id)],
          participants: [
            ...(conquerorId ? [realmSubject(conquerorId)] : []),
            realmSubject(id),
          ],
          links: relation ? { relation: relation.key } : {},
          facts: {
            absorbedElements: [...state.factions[id].absorbedElements],
            conquerorElements: conqueror ? [...conqueror.absorbedElements] : [],
            finalTerritory: state.factions[id].territory,
          },
          summary: conquerorId && conqueror?.alive
            ? `${NATIONS[conquerorId].realmName} conquered ${NATIONS[id].realmName} and absorbed its elemental powers.`
            : `${NATIONS[id].realmName} lost its final territory without a surviving conqueror.`,
        });
        context.emit(
          conquerorId && conqueror?.alive
            ? `${NATIONS[conquerorId].realmName} conquers ${NATIONS[id].realmName} and absorbs ${state.factions[id].absorbedElements.map((element) => ELEMENTS[element].name).join(" and ")}.`
            : `${NATIONS[id].realmName} has lost its last piece of sustainable land.`,
          "fall",
          conquerorId ?? id,
        );
      }
    }
  }
}
