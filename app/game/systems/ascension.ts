import { PLAYERS, PLAYER_ORDER } from "../players";
import { ELEMENTS, baseMaskOf } from "../elements";
import { baseDepthsOf, expressionFor, totalRealmsAbsorbed } from "../ascension";
import { realmSubject } from "../reporting";
import type { SimulationContext, SimulationSystem } from "../types";

/**
 * Keeps every realm's expressed element and base mask true to its history.
 *
 * Runs immediately after realm accounting, where conquest transfers a fallen
 * realm's element tallies to its conqueror, so an absorption that completes a
 * higher element is expressed the same tick. Expression only ever upgrades;
 * the ascended element joins the realm's held powers — its terrain affinity
 * widens and future conquerors will absorb what it became — while the realm's
 * name, family and colors stay exactly what an observer has been tracking.
 */
export class ElementAscensionSystem implements SimulationSystem {
  readonly id = "element-ascension";

  update(context: SimulationContext): void {
    const { state } = context;
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const next = expressionFor(faction);
      if (next !== faction.expressedElement) {
        const previous = faction.expressedElement;
        const definition = ELEMENTS[next];
        faction.expressedElement = next;
        if (!faction.absorbedElements.includes(next)) {
          faction.absorbedElements.push(next);
        }
        const constituents = definition.bases
          .map((base) => ELEMENTS[base].name);
        context.report({
          domain: "dynasty",
          kind: "dynasty.element-ascended",
          importance: definition.tier === 3 ? "historic" : "major",
          storyKey: `ascension:${id}`,
          initiator: realmSubject(id),
          targets: [],
          participants: [],
          links: {},
          facts: {
            from: previous,
            to: next,
            tier: definition.tier,
            realmsAbsorbed: totalRealmsAbsorbed(faction.elementCounts),
            baseDepths: baseDepthsOf(faction.elementCounts),
          },
          summary: definition.tier === 3
            ? `${PLAYERS[id].realmName} achieves ${definition.name}: mastered ${constituents.join(" and ")} united in one civilization.`
            : `${PLAYERS[id].realmName} ascends: absorbed legacies of ${constituents.join(" and ")} fuse into ${definition.name}.`,
        });
        context.emit(
          `${PLAYERS[id].realmName} ascends to ${definition.name} — ${definition.title.toLowerCase()}.`,
          "rise",
          id,
        );
      }
      faction.baseMask = baseMaskOf(faction.absorbedElements);
    }
  }
}
