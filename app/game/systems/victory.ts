import { ELEMENT_ORDER, ELEMENTS } from "../elements";
import { realmSubject } from "../reporting";
import type { SimulationContext, SimulationSystem } from "../types";

export class VictorySystem implements SimulationSystem {
  readonly id = "victory-watch";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.champion) return;
    const alive = ELEMENT_ORDER.filter((id) => state.factions[id].alive).sort(
      (a, b) => state.factions[b].territory - state.factions[a].territory,
    );
    const leader = alive[0];
    if (!leader) return;
    const share = state.factions[leader].territory / state.landTiles;
    if (alive.length === 1 && share >= state.config.victoryShare) {
      state.champion = leader;
    } else if (share >= state.config.victoryShare) {
      if (state.dominantSince === null) state.dominantSince = state.tick;
      if (state.tick - state.dominantSince >= 12) state.champion = leader;
    } else {
      state.dominantSince = null;
    }

    if (state.champion) {
      context.report({
        domain: "world",
        kind: "world.victory",
        importance: "historic",
        storyKey: `world:${state.seed}`,
        initiator: realmSubject(state.champion),
        targets: [],
        participants: ELEMENT_ORDER.map(realmSubject),
        links: {},
        facts: {
          territory: state.factions[state.champion].territory,
          worldShare: state.factions[state.champion].territory / state.landTiles,
          absorbedElements: [...state.factions[state.champion].absorbedElements],
          survivingRealms: alive.length,
        },
        summary: `${ELEMENTS[state.champion].realmName} united the sustainable world and won the age.`,
      });
      context.emit(
        `${ELEMENTS[state.champion].realmName} controls the sustainable world and closes the age with one final banner.`,
        "world",
        state.champion,
      );
    }
  }
}
