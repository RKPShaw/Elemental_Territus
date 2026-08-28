import { PLAYER_ORDER } from "./players";
import {
  mirageDistortionFor,
  mistVeilFor,
  observationCadenceOf,
  regionIntelligence,
  sightGroup,
} from "./information";
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
 *
 * The information identities live on this layer (information.ts). Swift-sight
 * realms -- glass, and anyone whose expressed element trades by air -- observe
 * twice per interval instead of once; a mist realm's plurality regions veil
 * distant rivals' measurements toward what those rivals already believed; a
 * mirage realm's plurality regions distort what rivals read out of their own
 * beliefs. Observation and reading are the only doors into a belief, so the
 * three identities are complete here without any other system knowing they
 * exist.
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
 *
 * A mirage bends the reading on its way out: what a rival believes about the
 * prize and openness of the Falselights' plurality regions is a fraction of
 * what its store honestly holds, unless enough of its sight group has contact
 * on the region to corroborate the truth. The stores stay honest and shared
 * sight stays honest -- the illusion exists only in the looking.
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
    value: value * mirageDistortionFor(state, viewer, regionId, layer),
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
  // Swift-sight realms -- glass, and anyone whose expressed element trades by
  // air -- take further observations at even offsets from their slot, so they
  // ride the same rotation at a higher cadence.
  const interval = THEATER_MAP_RULES.observationInterval;
  const slot = state.tick % interval;
  const due: PlayerId[] = [];
  for (let index = 0; index < PLAYER_ORDER.length; index += 1) {
    const player = PLAYER_ORDER[index]!;
    const faction = state.factions[player]!;
    if (!faction.alive) continue;
    const base = Math.floor((index * interval) / PLAYER_ORDER.length);
    const cadence = observationCadenceOf(faction.expressedElement);
    for (let round = 0; round < cadence; round += 1) {
      if ((base + Math.floor((round * interval) / cadence)) % interval !== slot) continue;
      due.push(player);
      break;
    }
  }
  if (due.length === 0) return;

  const { contact } = regionIntelligence(state);
  for (const player of due) {
    const store = map.byPlayer[player]!;
    const visible = contact.get(player);
    if (!visible) continue;
    for (const regionId of visible) {
      if (regionId >= map.regionCount) continue;
      // A mist veil thickens the look without blocking it: the measurement
      // arrives blended toward what this observer already believed, so the
      // reading is stamped fresh while staying mostly stale. Standing in the
      // region measures clear.
      const veil = mistVeilFor(state, player, regionId);
      for (const layer of OBSERVED_LAYERS) {
        const index = layerOffset(regionId, layer);
        let measurement = measureRegion(state, regionId, layer);
        if (veil > 0) {
          const believed = store.value[index]! + store.trend[index]!;
          measurement = believed * veil + measurement * (1 - veil);
        }
        observe(store, index, measurement);
      }
      store.observedAt[regionId] = state.tick;
    }
  }
}
