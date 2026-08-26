import { refreshTheaterMap } from "../theater-map";
import type { SimulationContext, SimulationSystem } from "../types";

/**
 * Refreshes what players believe about the ground.
 *
 * Ordered after strategic geography so it observes the current partition rather
 * than last tick's, and before the planners so they read beliefs formed this
 * tick. It only ever writes to the belief store: nothing here changes the
 * world, so a stale or wrong belief costs a player a bad decision rather than
 * corrupting the map it was wrong about.
 */
export class TheaterMapSystem implements SimulationSystem {
  readonly id = "theater-map-observation";

  update(context: SimulationContext): void {
    refreshTheaterMap(context.state);
  }
}
