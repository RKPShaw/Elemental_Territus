import { realmTitle } from "../naming";
import { PLAYERS, PLAYER_ORDER } from "../players";
import { ELEMENTS } from "../elements";
import { getRelation } from "../diplomacy";
import { realmSubject } from "../reporting";
import { applyRealmAccounting, collectRealmAccounting } from "./shared";
import type { ElementId, SimulationContext, SimulationSystem } from "../types";

export class RealmAccountingSystem implements SimulationSystem {
  readonly id = "realm-accounting";

  update(context: SimulationContext): void {
    const { state } = context;
    const drafts = collectRealmAccounting(state);
    for (const id of PLAYER_ORDER) {
      const wasAlive = state.factions[id].alive;
      applyRealmAccounting(state, id, drafts[id]);
      if (wasAlive && !state.factions[id].alive) {
        const conquerorId = state.factions[id].lastConqueror;
        const conqueror = conquerorId ? state.factions[conquerorId] : null;
        if (conqueror?.alive) {
          const fallen = state.factions[id];
          conqueror.absorbedElements = [...new Set([
            ...conqueror.absorbedElements,
            ...fallen.absorbedElements,
          ])];
          // The set says what powers a realm now holds; the tally says how many
          // of each it took to get them, which the set cannot: absorbing ten
          // Ember neighbours and absorbing one both read as "ember" alone.
          for (const [element, count] of Object.entries(fallen.elementCounts)) {
            const key = element as ElementId;
            conqueror.elementCounts[key] = (conqueror.elementCounts[key] ?? 0) + count;
          }
        }
        const relation = conquerorId ? getRelation(state, conquerorId, id) : null;
        context.report({
          domain: "territory",
          kind: "territory.realm-conquered",
          importance: "historic",
          storyKey: relation?.storyKey ?? `conquest:${conquerorId ?? "none"}:${id}:${state.tick}`,
          initiator: conquerorId ? realmSubject(state, conquerorId) : null,
          targets: [realmSubject(state, id)],
          participants: [
            ...(conquerorId ? [realmSubject(state, conquerorId)] : []),
            realmSubject(state, id),
          ],
          links: relation ? { relation: relation.key } : {},
          facts: {
            absorbedElements: [...state.factions[id].absorbedElements],
            conquerorElements: conqueror ? [...conqueror.absorbedElements] : [],
            conquerorElementCounts: conqueror ? { ...conqueror.elementCounts } : {},
            finalTerritory: state.factions[id].territory,
          },
          summary: conquerorId && conqueror?.alive
            ? `${realmTitle(state, conquerorId)} conquered ${realmTitle(state, id)} and absorbed its elemental powers.`
            : `${realmTitle(state, id)} lost its final territory without a surviving conqueror.`,
        });
        context.emit(
          conquerorId && conqueror?.alive
            ? `${realmTitle(state, conquerorId)} conquers ${realmTitle(state, id)} and absorbs ${state.factions[id].absorbedElements.map((element) => ELEMENTS[element].name).join(" and ")}.`
            : `${realmTitle(state, id)} has lost its last piece of sustainable land.`,
          "fall",
          conquerorId ?? id,
        );
      }
    }
  }
}
