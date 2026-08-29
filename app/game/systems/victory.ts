import { realmTitle } from "../naming";
import { PLAYERS, PLAYER_ORDER } from "../players";

import { realmSubject } from "../reporting";
import type { SimulationContext, SimulationSystem } from "../types";

export class VictorySystem implements SimulationSystem {
  readonly id = "victory-watch";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.champion) return;
    const alive = PLAYER_ORDER.filter((id) => state.factions[id].alive).sort(
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
        initiator: realmSubject(state, state.champion),
        targets: [],
        participants: PLAYER_ORDER.map((id) => realmSubject(state, id)),
        links: {},
        facts: {
          territory: state.factions[state.champion].territory,
          worldShare: state.factions[state.champion].territory / state.landTiles,
          absorbedElements: [...state.factions[state.champion].absorbedElements],
          survivingRealms: alive.length,
        },
        summary: `${realmTitle(state, state.champion)} united the sustainable world and won the age.`,
      });
      context.emit(
        `${realmTitle(state, state.champion)} controls the sustainable world and closes the age with one final banner.`,
        "world",
        state.champion,
      );
    }
  }
}
