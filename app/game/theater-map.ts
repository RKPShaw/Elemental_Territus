import { PLAYER_ORDER } from "./players";
import { getRelation } from "./diplomacy";
import { THEATER_MAP_RULES } from "./rules";
import type { PlayerId, TheaterMapState, RegionObservation, WorldState } from "./types";

/**
 * What each player believes the ground is worth, remembered and imperfect.
 *
 * The game had three separate opinions of land -- the drawn intelligence map,
 * the front planner's private scoring, and spawn's own affinity field -- and
 * only the one nothing read was any good. This is the one opinion, and it holds
 * no policy: it publishes layers, and each system brings its own lens over
 * them. That matters because the readers disagree about what "good" means.
 * A settler wants the best ground; the build planner wants to *level* a country,
 * putting works on poor ground and forts on the ground worth defending. A map
 * that returned a single verdict could not serve both.
 *
 * Two tiers, split by what can honestly be hidden:
 *
 *   Common knowledge -- land yield, terrain, element fit. Geography does not
 *   hide, so these are read straight from the world (strategicMeta) and are not
 *   stored per player at all.
 *
 *   Observed -- infrastructure, access, how weakly ground is held, and what is
 *   there to win. These refresh only where a player has contact: its territory,
 *   the ground next to it, the length of its trade routes, its live fronts.
 *   Everywhere else the last observation stands and ages.
 *
 * Memory is kept per region rather than per cell, and not to save space. The
 * simulation worker snapshots the world every tick and snapshots deep-copy, so
 * a per-player per-cell field would mean copying tens of megabytes a tick and
 * hashing hundreds of millions of values in the golden digest. Regions cost a
 * few thousand floats, and cell-level detail is derived on demand from the
 * common-knowledge fields shaded by the region's remembered observation --
 * which is also the honest resolution for a belief formed at a distance.
 */

export const OBSERVED_LAYERS = ["infrastructure", "access", "undefended", "prize"] as const;
export type ObservedLayer = (typeof OBSERVED_LAYERS)[number];

export const OBSERVED_LAYER_LABELS: Record<ObservedLayer, string> = {
  infrastructure: "Infrastructure",
  access: "Access",
  undefended: "Weakly held",
  prize: "Worth taking",
};

/** Never observed. Distinct from "observed and found to be zero". */
export const NEVER_OBSERVED = -1;

function layerOffset(regionId: number, layer: ObservedLayer): number {
  return regionId * OBSERVED_LAYERS.length + OBSERVED_LAYERS.indexOf(layer);
}

export function createRegionObservation(regionCount: number): RegionObservation {
  const width = regionCount * OBSERVED_LAYERS.length;
  return {
    value: new Float32Array(width),
    trend: new Float32Array(width),
    observedAt: new Int32Array(regionCount).fill(NEVER_OBSERVED),
  };
}

export function createTheaterMap(regionCount: number): TheaterMapState {
  const byPlayer = {} as Record<PlayerId, RegionObservation>;
  for (const player of PLAYER_ORDER) byPlayer[player] = createRegionObservation(regionCount);
  return { byPlayer, regionCount };
}

/**
 * Regions are re-partitioned as the world develops, so the store is resized to
 * match. Growth keeps what was already believed and marks the new regions
 * unseen; shrinking truncates. Either way nobody silently reads past the end.
 */
export function resizeTheaterMap(map: TheaterMapState, regionCount: number): void {
  if (map.regionCount === regionCount) return;
  for (const player of PLAYER_ORDER) {
    const previous = map.byPlayer[player]!;
    const next = createRegionObservation(regionCount);
    const carried = Math.min(map.regionCount, regionCount);
    next.value.set(previous.value.subarray(0, carried * OBSERVED_LAYERS.length));
    next.trend.set(previous.trend.subarray(0, carried * OBSERVED_LAYERS.length));
    next.observedAt.set(previous.observedAt.subarray(0, carried));
    map.byPlayer[player] = next;
  }
  map.regionCount = regionCount;
}

/**
 * One step of the filter theaters already use: predict from value and trend,
 * then correct toward what was seen. Between observations the prediction is
 * what a player goes on, so a belief drifts rather than freezing.
 */
function observe(store: RegionObservation, index: number, measurement: number): void {
  const predicted = store.value[index]! + store.trend[index]!;
  const residual = measurement - predicted;
  store.value[index] = predicted + THEATER_MAP_RULES.valueAlpha * residual;
  store.trend[index] = store.trend[index]! + THEATER_MAP_RULES.trendBeta * residual;
}

const SIGHT_GROUPS = new WeakMap<object, { tick: number; groups: Map<PlayerId, PlayerId[]> }>();

/**
 * Who a player sees through as well as with: itself, its allies, and the
 * partners it actually runs a route with.
 *
 * Deliberately narrow. Merely not being at war is not intelligence sharing --
 * that would put nearly the whole roster in every group and quietly undo the
 * fog. An alliance or a live trade route is a relationship someone chose and
 * can lose, which is what makes shared sight a reward rather than a default.
 */
export function sightGroup(state: WorldState, viewer: PlayerId): readonly PlayerId[] {
  const cached = SIGHT_GROUPS.get(state);
  if (cached && cached.tick === state.tick) {
    const hit = cached.groups.get(viewer);
    if (hit) return hit;
  }
  const store = cached && cached.tick === state.tick
    ? cached
    : { tick: state.tick, groups: new Map<PlayerId, PlayerId[]>() };

  const group: PlayerId[] = [viewer];
  const included = new Set<PlayerId>([viewer]);
  for (const other of PLAYER_ORDER) {
    if (other === viewer || !state.factions[other]!.alive) continue;
    if (getRelation(state, viewer, other).status !== "truce") continue;
    group.push(other);
    included.add(other);
  }
  for (const route of state.tradeRoutes) {
    const [first, second] = route.parties;
    const partner = first === viewer ? second : second === viewer ? first : null;
    if (partner === null || included.has(partner)) continue;
    if (!state.factions[partner]!.alive) continue;
    group.push(partner);
    included.add(partner);
  }

  store.groups.set(viewer, group);
  SIGHT_GROUPS.set(state, store);
  return group;
}

export interface RegionBelief {
  value: number;
  /** Tick the reading was taken, or NEVER_OBSERVED. */
  observedAt: number;
  /** Ticks since it was taken; Infinity when never seen. */
  age: number;
}

/**
 * What a player currently believes about one region and layer.
 *
 * Allies and trade partners pool what they have seen, so the freshest reading
 * in the sight group wins. That makes a trade route an intelligence line as
 * well as an economic one, and it is why observations are stored per observer
 * rather than merged in place -- a merged store could not tell whose reading it
 * was holding, and could never un-share when an alliance ends.
 */
export function believedValue(
  state: WorldState,
  viewer: PlayerId,
  regionId: number,
  layer: ObservedLayer,
): RegionBelief {
  const map = state.theaterMap;
  if (regionId < 0 || regionId >= map.regionCount) {
    return { value: 0, observedAt: NEVER_OBSERVED, age: Number.POSITIVE_INFINITY };
  }
  const index = layerOffset(regionId, layer);
  let best = NEVER_OBSERVED;
  let value = 0;
  for (const source of sightGroup(state, viewer)) {
    const store = map.byPlayer[source];
    if (!store) continue;
    const seenAt = store.observedAt[regionId]!;
    if (seenAt <= best) continue;
    best = seenAt;
    value = store.value[index]!;
  }
  return {
    value,
    observedAt: best,
    age: best === NEVER_OBSERVED ? Number.POSITIVE_INFINITY : state.tick - best,
  };
}

/** True reading of a region, as it would be seen by someone standing in it. */
function measureRegion(state: WorldState, regionId: number, layer: ObservedLayer): number {
  const region = state.strategicRegions[regionId];
  if (!region || region.cells.length === 0) return 0;
  const cells = region.cells;
  const meta = state.strategicMeta;
  let total = 0;

  switch (layer) {
    case "infrastructure": {
      for (const index of cells) total += meta.infrastructure[index]!;
      return total / cells.length;
    }
    case "access": {
      let reachable = 0;
      for (const index of cells) {
        const cell = state.cells[index]!;
        if (cell.coastal || cell.structure === "harbor") reachable += 1;
      }
      return reachable / cells.length;
    }
    case "prize": {
      for (const index of cells) {
        const cell = state.cells[index]!;
        total += meta.productivity[index]!
          + (cell.structure === null ? 0 : 0.4 + cell.structureLevel * 0.2)
          + (cell.capitalOf ? 1.2 : 0);
      }
      return total / cells.length;
    }
    case "undefended": {
      let held = 0;
      let forts = 0;
      for (const index of cells) {
        const cell = state.cells[index]!;
        if (cell.owner !== null) held += 1;
        if (cell.structure === "fort") forts += 1;
      }
      // Empty ground is open; held ground is only as open as its garrison is thin.
      const occupancy = held / cells.length;
      const garrison = Math.min(1, forts / Math.max(1, cells.length * 0.04));
      return 1 - occupancy * garrison;
    }
  }
}

/**
 * Regions each player can currently see into.
 *
 * Contact is ground held, ground next to it, the length of a trade route, and a
 * live front. Built for every player in one pass over the map, because doing it
 * per observer is the players-by-cells sweep this codebase has spent a lot of
 * effort deleting.
 */
function contactByPlayer(state: WorldState): Map<PlayerId, Set<number>> {
  const contact = new Map<PlayerId, Set<number>>();
  const { width, height } = state.config;
  const cells = state.cells;
  const regionByCell = state.regionByCell;

  const touch = (player: PlayerId, regionId: number): void => {
    if (regionId < 0) return;
    const seen = contact.get(player);
    if (seen) seen.add(regionId);
    else contact.set(player, new Set([regionId]));
  };

  for (let index = 0; index < cells.length; index += 1) {
    const owner = cells[index]!.owner;
    if (owner === null) continue;
    touch(owner, regionByCell[index]!);
    const x = index % width;
    const y = (index - x) / width;
    for (let side = 0; side < 4; side += 1) {
      const nx = side === 1 ? x + 1 : side === 3 ? x - 1 : x;
      const ny = side === 0 ? y - 1 : side === 2 ? y + 1 : y;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      touch(owner, regionByCell[ny * width + nx]!);
    }
  }

  for (const route of state.tradeRoutes) {
    for (const index of route.pathIndices) {
      const regionId = regionByCell[index]!;
      for (const party of route.parties) touch(party, regionId);
    }
  }

  for (const theater of state.theaters) {
    touch(theater.attacker, theater.regionId);
  }

  return contact;
}

/**
 * Refresh a slice of the roster's beliefs.
 *
 * Only a fraction of players re-observe on any tick, on a rotation. That is not
 * a shortcut around the cost -- it is what the filter wants. A belief updated
 * every tick from perfect information is not a belief, it is the world with
 * extra steps; observing periodically is what lets a player act on something
 * out of date. The rotation also means the cost per tick is flat in roster
 * size, which the per-player-per-tick alternative is emphatically not.
 */
export function refreshTheaterMap(state: WorldState): void {
  const map = state.theaterMap;
  resizeTheaterMap(map, state.strategicRegions.length);
  if (map.regionCount === 0) return;

  // Each player's slot in the interval is derived from its roster position, so
  // every player observes exactly once per interval however long the interval
  // or however large the roster, and the load spreads evenly across its ticks.
  const interval = THEATER_MAP_RULES.observationInterval;
  const slot = state.tick % interval;
  const due: PlayerId[] = [];
  for (let index = 0; index < PLAYER_ORDER.length; index += 1) {
    if (Math.floor((index * interval) / PLAYER_ORDER.length) !== slot) continue;
    const player = PLAYER_ORDER[index]!;
    if (state.factions[player]!.alive) due.push(player);
  }
  if (due.length === 0) return;

  const contact = contactByPlayer(state);
  for (const player of due) {
    const store = map.byPlayer[player]!;
    const visible = contact.get(player);
    if (!visible) continue;
    for (const regionId of visible) {
      if (regionId >= map.regionCount) continue;
      for (const layer of OBSERVED_LAYERS) {
        observe(store, layerOffset(regionId, layer), measureRegion(state, regionId, layer));
      }
      store.observedAt[regionId] = state.tick;
    }
  }
}
