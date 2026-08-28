import { realmTitle } from "../naming";
import { PLAYERS, PLAYER_ORDER } from "../players";
import { DOMAIN_LABELS, recomputePriorities } from "../strategy";
import { realmSubject } from "../reporting";
import type { SimulationContext, SimulationSystem } from "../types";

/**
 * Keeps every realm's strategic priorities current.
 *
 * Runs after the economy and trade have settled the tick's facts and before
 * any AI system decides anything, so diplomacy, strategy and construction all
 * read the same, fresh priorities. It only rewrites AI-owned state — the
 * strategy block, exactly as the strategy AI owns intent — and reports a
 * changed focus as leadership history, which is how the observer learns that
 * the Cinderkin have turned from trade to conquest.
 */
export class StrategicPlanningSystem implements SimulationSystem {
  readonly id = "strategic-planning";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.tick % state.config.strategyInterval !== 0) return;

    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const next = recomputePriorities(state, id);
      const previousFocus = faction.strategy.focus;
      const changed = next.focus !== previousFocus;
      faction.strategy = {
        weights: next.weights,
        focus: next.focus,
        adoptedAt: changed ? state.tick : faction.strategy.adoptedAt,
        reason: next.reason,
      };
      if (!changed) continue;
      context.report({
        domain: "leadership",
        kind: "leadership.strategy-adopted",
        importance: "routine",
        storyKey: `strategy:${id}:${Math.floor(state.tick / 240)}`,
        initiator: realmSubject(state, id),
        targets: [],
        participants: [],
        links: {},
        facts: {
          from: previousFocus,
          to: next.focus,
          focusWeight: Math.round(next.weights[next.focus] * 1000) / 1000,
        },
        summary: `${realmTitle(state, id)} turns its focus from ${DOMAIN_LABELS[previousFocus]} to ${DOMAIN_LABELS[next.focus]}: ${next.reason}`,
      });
    }
  }
}
