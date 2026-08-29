import { realmTitle } from "../naming";
import { PLAYER_ORDER } from "../players";
import { ELEMENTS, baseMaskOf } from "../elements";
import { baseDepthsOf, fusionTargetFor, totalRealmsAbsorbed } from "../ascension";
import { TRANSMUTATION_RULES } from "../rules";
import { realmSubject } from "../reporting";
import type { SimulationContext, SimulationSystem } from "../types";

/**
 * Drives every realm's fusion through the crucible of conquest.
 *
 * Runs immediately after realm accounting, where conquest transfers a fallen
 * realm's held elements to its conqueror, so the annexation that makes a
 * fusion eligible opens its transmutation window the same tick. A due window
 * completes first and eligibility is re-checked immediately after, so chained
 * conquests climb rung by rung with each rung paying a window of its own —
 * never two flips in one tick. Expression only ever upgrades; the fused
 * element joins the realm's held powers — its terrain affinity widens and
 * future conquerors will absorb what it became — while the realm's name,
 * family and colors stay exactly what an observer has been tracking.
 */
export class ElementAscensionSystem implements SimulationSystem {
  readonly id = "element-ascension";

  update(context: SimulationContext): void {
    const { state } = context;
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      const window = faction.transmutation;
      if (!faction.alive) {
        // A realm annexed mid-window dies with its window; only the lifetime
        // completion count survives for the record.
        if (window.target !== null) {
          window.target = null;
          window.from = null;
          window.startedAt = -1;
          window.completesAt = -1;
        }
        continue;
      }
      if (window.target !== null && state.tick >= window.completesAt) {
        const previous = faction.expressedElement;
        const next = window.target;
        const definition = ELEMENTS[next];
        const windowTicks = window.completesAt - window.startedAt;
        faction.expressedElement = next;
        if (!faction.absorbedElements.includes(next)) {
          faction.absorbedElements.push(next);
        }
        window.target = null;
        window.from = null;
        window.startedAt = -1;
        window.completesAt = -1;
        window.completed += 1;
        const constituents = definition.bases.map((base) => ELEMENTS[base].name);
        context.report({
          domain: "dynasty",
          kind: "dynasty.element-ascended",
          importance: definition.tier === 3 ? "historic" : "major",
          storyKey: `ascension:${id}`,
          initiator: realmSubject(state, id),
          targets: [],
          participants: [],
          links: {},
          facts: {
            from: previous,
            to: next,
            tier: definition.tier,
            windowTicks,
            realmsAbsorbed: totalRealmsAbsorbed(faction.elementCounts),
            baseDepths: baseDepthsOf(faction.elementCounts),
          },
          summary: definition.tier === 3
            ? `${realmTitle(state, id)} achieves ${definition.name}: mastered ${constituents.join(" and ")} united in one civilization.`
            : `${realmTitle(state, id)} ascends: absorbed legacies of ${constituents.join(" and ")} fuse into ${definition.name}.`,
        });
        context.emit(
          `${realmTitle(state, id)} ascends to ${definition.name} — ${definition.title.toLowerCase()}.`,
          "rise",
          id,
        );
      }
      if (window.target === null) {
        const target = fusionTargetFor(faction);
        if (target !== null) {
          const definition = ELEMENTS[target];
          const windowTicks = definition.tier === 3
            ? TRANSMUTATION_RULES.tier3WindowTicks
            : TRANSMUTATION_RULES.tier2WindowTicks;
          window.target = target;
          window.from = faction.expressedElement;
          window.startedAt = state.tick;
          window.completesAt = state.tick + windowTicks;
          const constituents = definition.bases.map((base) => ELEMENTS[base].name);
          context.report({
            domain: "dynasty",
            kind: "dynasty.transmutation-begun",
            importance: definition.tier === 3 ? "historic" : "major",
            storyKey: `ascension:${id}`,
            initiator: realmSubject(state, id),
            targets: [],
            participants: [],
            links: {},
            facts: {
              from: faction.expressedElement,
              to: target,
              tier: definition.tier,
              windowTicks,
              completesAt: window.completesAt,
              realmsAbsorbed: totalRealmsAbsorbed(faction.elementCounts),
            },
            summary: `${realmTitle(state, id)} enters the crucible: conquest holds ${constituents.join(" and ")} in one realm, and their fusion into ${definition.name} begins.`,
          });
          context.emit(
            `${realmTitle(state, id)} enters the crucible — ${constituents.join(" and ")} begin fusing into ${definition.name}.`,
            "rise",
            id,
          );
        }
      }
      faction.baseMask = baseMaskOf(faction.absorbedElements);
    }
  }
}
