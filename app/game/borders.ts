import type { PlayerId, WorldState } from "./types";

/**
 * How much frontier every pair of players shares, indexed once per tick.
 *
 * "Do these two touch, and along how many edges" is the cheapest question the
 * diplomacy and strategy planners ask and the most expensive one to answer:
 * done directly it is a full sweep of forty thousand cells with a
 * neighbour lookup each. Diplomacy asks it for every relation in the table, so
 * at a hundred players that is a few thousand sweeps a tick -- tens of millions
 * of cell visits for a table one pass fills in for everybody.
 *
 * One ascending pass counts every adjacency in the world. Ownership only moves
 * when a campaign takes a tile, and the systems that read borders queue
 * commands rather than taking ground themselves, so a snapshot taken at the
 * start of a tick reads the same as recomputing per query -- and, as with the
 * frontier index, it means every player is scored against the same map instead
 * of the roster order deciding who sees the freshest one.
 */
export interface BorderIndex {
  tick: number;
  /** Key is `${first}|${second}`; the value is edges counted from first's side. */
  edges: Map<string, number>;
}

const CACHE = new WeakMap<object, BorderIndex>();

function build(state: WorldState): BorderIndex {
  const { width, height } = state.config;
  const cells = state.cells;
  const edges = new Map<string, number>();

  for (let index = 0; index < cells.length; index += 1) {
    const owner = cells[index]!.owner;
    if (owner === null) continue;
    const x = index % width;
    const y = (index - x) / width;

    // Cardinal neighbours, inline: neighborIndices allocates an array per cell,
    // and this is the innermost loop of the whole index.
    for (let side = 0; side < 4; side += 1) {
      const nx = side === 1 ? x + 1 : side === 3 ? x - 1 : x;
      const ny = side === 0 ? y - 1 : side === 2 ? y + 1 : y;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighbourOwner = cells[ny * width + nx]!.owner;
      if (neighbourOwner === null || neighbourOwner === owner) continue;
      const key = `${owner}|${neighbourOwner}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return { tick: state.tick, edges };
}

function indexFor(state: WorldState): BorderIndex {
  const cached = CACHE.get(state.cells);
  if (cached && cached.tick === state.tick) return cached;
  const built = build(state);
  CACHE.set(state.cells, built);
  return built;
}

/** Cardinal edges from cells owned by `first` to cells owned by `second`. */
export function sharedBorderEdges(
  state: WorldState,
  first: PlayerId,
  second: PlayerId,
): number {
  return indexFor(state).edges.get(`${first}|${second}`) ?? 0;
}
