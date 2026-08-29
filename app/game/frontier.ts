import type { CampaignTarget, PlayerId, WorldState } from "./types";

/**
 * Which cells each player can push into, indexed once per tick.
 *
 * Campaigns ask "where does my territory meet this target" constantly: every
 * settlement campaign asks it to advance, and every campaign asks it again when
 * theaters refresh. Answered directly that is a full sweep of the map with a
 * neighbour lookup per cell, and with one campaign per player it runs twice per
 * player per tick -- roughly three and a half million cell visits a tick at a
 * hundred players, for an answer that is the same for everyone.
 *
 * One ascending pass builds every player's frontier against every target at
 * once, in the same cell order the per-campaign sweep produced.
 *
 * The index is taken at the start of a tick and reused for the whole of it, so
 * every campaign reads the same frontier. That is also fairer than recomputing
 * per campaign: doing so let a campaign see the ground taken by campaigns
 * earlier in the roster, handing the first player listed a standing advantage
 * over the last -- invisible with five players, systematic with a hundred.
 * Settlement and capture both re-check the cell before taking it, so acting on
 * a frontier that moved mid-tick is safe.
 */
export interface FrontierIndex {
  tick: number;
  /** Key is `${attacker}|${target}`; values ascend by cell index. */
  byPair: Map<string, number[]>;
}

const CACHE = new WeakMap<object, FrontierIndex>();
const NO_TARGETS: readonly number[] = [];

export function frontierPairKey(attacker: PlayerId, target: CampaignTarget): string {
  return `${attacker}|${target}`;
}

function build(state: WorldState): FrontierIndex {
  const { width, height } = state.config;
  const byPair = new Map<string, number[]>();
  const cells = state.cells;
  // At most four distinct attackers can border a cell, so the scratch is fixed.
  const adjacent: (PlayerId | null)[] = [null, null, null, null];

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    if (cell.terrain === "water") continue;
    const owner = cell.owner;
    const x = index % width;
    const y = (index - x) / width;
    let found = 0;

    // Cardinal neighbours, inline: neighborIndices allocates, and this is the
    // innermost loop of the whole index.
    for (let side = 0; side < 4; side += 1) {
      const nx = side === 1 ? x + 1 : side === 3 ? x - 1 : x;
      const ny = side === 0 ? y - 1 : side === 2 ? y + 1 : y;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbour = cells[ny * width + nx]!;
      const neighbourOwner = neighbour.owner;
      if (neighbourOwner === null || neighbourOwner === owner) continue;
      // A stream is a border that takes a ship to force. An army may not
      // march into another realm's ground when the step enters or leaves the
      // watercourse -- the front comes to rest on the river, and crossing it
      // means a naval campaign, exactly as the open sea does. Settlers still
      // ford streams: wilderness (owner === null) stays reachable, or whole
      // valleys would go unclaimed forever.
      if (owner !== null && (cell.stream || neighbour.stream)) continue;
      let seen = false;
      for (let a = 0; a < found; a += 1) {
        if (adjacent[a] === neighbourOwner) { seen = true; break; }
      }
      if (seen) continue;
      adjacent[found] = neighbourOwner;
      found += 1;
    }
    if (found === 0) continue;

    const target: CampaignTarget = owner === null ? "wilderness" : owner;
    for (let a = 0; a < found; a += 1) {
      const key = frontierPairKey(adjacent[a]!, target);
      const list = byPair.get(key);
      if (list) list.push(index);
      else byPair.set(key, [index]);
    }
  }
  return { tick: state.tick, byPair };
}

function indexFor(state: WorldState): FrontierIndex {
  const cached = CACHE.get(state.cells);
  if (cached && cached.tick === state.tick) return cached;
  const built = build(state);
  CACHE.set(state.cells, built);
  return built;
}

/** Cells owned by `target` that border `attacker`, ascending by cell index. */
export function frontierTargets(
  state: WorldState,
  attacker: PlayerId,
  target: CampaignTarget,
): readonly number[] {
  return indexFor(state).byPair.get(frontierPairKey(attacker, target)) ?? NO_TARGETS;
}
