import { PLAYER_ORDER } from "../players";
import { getRelation } from "../diplomacy";

import {
  cellsWithin,
  distanceBetween,
  structureCells,
  surroundingIndices,
} from "../grid";
import { cellRevision } from "../structure-index";
import {
  sharedTradeForms,
  structurePayoutMultiplier,
  tradeFormIncomeMultiplier,
  tradeHostShare,
} from "../elements";
import { recordEarned } from "../economics";
import { realmSubject } from "../reporting";
import {
  ECONOMY_RULES,
  TRADE_RULES,
  cityStationMultiplier,
  clamp,
  normalizedCellLength,
} from "../rules";
import type {
  PlayerId,
  LandTerrainId,
  SimulationContext,
  SimulationSystem,
  StructureType,
  TradeRoute,
  TradeDispatchState,
  TradeVehicle,
  WorldState,
} from "../types";
import { isValidWaterPath, waterPathBetweenLandCells } from "../water-navigation";

interface RailNode {
  index: number;
  owner: PlayerId;
  kind: "city" | "factory";
}

interface RailJourney {
  pathIndices: number[];
  stopIndices: number[];
}

function dispatchKey(kind: TradeVehicle["kind"], sourceIndex: number): string {
  return `${kind}:${sourceIndex}`;
}

function dispatchFor(
  state: WorldState,
  kind: TradeVehicle["kind"],
  sourceIndex: number,
): TradeDispatchState {
  const key = dispatchKey(kind, sourceIndex);
  state.tradeDispatches[key] ??= {
    kind,
    sourceIndex,
    activeVehicleIds: [],
    // Sites open on a stagger drawn from where they sit, so a coastline that
    // comes of age together does not sail together. Derived from the index
    // rather than drawn at random, so it costs no entropy and stays stable.
    readyAt: state.tick + siteOffset(sourceIndex),
    completedRuns: 0,
    lastVehicleId: null,
  };
  return state.tradeDispatches[key]!;
}

/**
 * A site's standing place in the launch cycle, taken from where it sits on the
 * map. Derived rather than drawn, so it costs no entropy and never moves.
 */
function siteOffset(sourceIndex: number): number {
  return sourceIndex % TRADE_RULES.launchIntervalTicks;
}

/** How many vehicles this site may have out at once. */
function dispatchCapacity(
  state: WorldState,
  kind: TradeVehicle["kind"],
  sourceIndex: number,
): number {
  if (kind === "train") return TRADE_RULES.trainsPerFactory;
  if (kind === "pulse") return TRADE_RULES.pulsesPerPlant;
  if (kind === "flyer") return TRADE_RULES.flyersPerSkyport;
  const level = state.cells[sourceIndex]?.structureLevel ?? 1;
  return TRADE_RULES.shipsPerHarbor
    + Math.max(0, level - 1) * TRADE_RULES.shipsPerHarborLevel;
}

function reserveDispatch(state: WorldState, vehicle: TradeVehicle): void {
  const dispatch = dispatchFor(state, vehicle.kind, vehicle.sourceIndex);
  dispatch.activeVehicleIds.push(vehicle.id);
  // The berth is free again immediately -- capacity decides that -- but the
  // site still waits before sending the next one out.
  dispatch.readyAt = state.tick + TRADE_RULES.launchIntervalTicks;
}

function releaseDispatch(state: WorldState, vehicle: TradeVehicle): number {
  const dispatch = dispatchFor(state, vehicle.kind, vehicle.sourceIndex);
  const at = dispatch.activeVehicleIds.indexOf(vehicle.id);
  if (at >= 0) {
    dispatch.activeVehicleIds.splice(at, 1);
    // Turning a vehicle around occupies the site, so it delays the next launch
    // -- but only if that is longer than the wait already standing.
    // The turnaround carries the site's own offset. Without it, journeys of
    // similar length plus a turnaround of fixed size kept re-synchronising
    // sites that had once launched together, and trade left port in waves. A
    // few ticks of standing offset per site holds them apart for good, and
    // spreads the cost of route-finding across ticks instead of spiking it.
    dispatch.readyAt = Math.max(
      dispatch.readyAt,
      state.tick + TRADE_RULES.vehicleTurnaroundTicks + siteOffset(vehicle.sourceIndex),
    );
    dispatch.completedRuns += 1;
    dispatch.lastVehicleId = vehicle.id;
  }
  return dispatch.readyAt;
}

function dispatchReady(
  state: WorldState,
  kind: TradeVehicle["kind"],
  sourceIndex: number,
): boolean {
  const dispatch = dispatchFor(state, kind, sourceIndex);
  if (dispatch.activeVehicleIds.length >= dispatchCapacity(state, kind, sourceIndex)) return false;
  return state.tick >= dispatch.readyAt;
}

function tradeStoryKey(first: PlayerId, second: PlayerId, tick: number): string {
  const parties = [first, second].sort();
  return `trade:${parties[0]}:${parties[1]}:${Math.floor(tick / 240)}`;
}

function canTrade(state: WorldState, first: PlayerId, second: PlayerId): boolean {
  if (first === second) return true;
  const relation = getRelation(state, first, second);
  return relation.status !== "war" && relation.tradeActive;
}

function stationOwner(state: WorldState, index: number): PlayerId | null {
  const cell = state.cells[index]!;
  return cell.structure === "city" || cell.structure === "factory" ? cell.owner : null;
}

function routeDistance(state: WorldState, path: number[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    total += distanceBetween(state, path[index - 1]!, path[index]!);
  }
  return total;
}

function railNodes(state: WorldState): RailNode[] {
  const nodes: RailNode[] = [];
  for (const owner of PLAYER_ORDER) {
    if (!state.factions[owner].alive) continue;
    for (const index of structureCells(state, owner, "city")) nodes.push({ index, owner, kind: "city" });
    for (const index of structureCells(state, owner, "factory")) nodes.push({ index, owner, kind: "factory" });
  }
  return nodes;
}

function railNetworkSignature(state: WorldState): string {
  const stations: string[] = [];
  for (let index = 0; index < state.cells.length; index += 1) {
    const cell = state.cells[index]!;
    // Plants are in the signature because conduits redraw when they move;
    // skyports are not, because flights need no routes at all.
    if (cell.structure !== "city" && cell.structure !== "factory" && cell.structure !== "plant") continue;
    stations.push(`${index}:${cell.owner ?? "none"}:${cell.structure}:${cell.structureLevel}`);
  }
  const diplomacy = Object.values(state.relations)
    .map((relation) => `${relation.key}:${relation.status}:${relation.tradeActive ? 1 : 0}`)
    .sort();
  return `${stations.join("|")}#${diplomacy.join("|")}`;
}

function routeKey(first: number, second: number): string {
  return `rail:${Math.min(first, second)}:${Math.max(first, second)}`;
}

function factoryCoverage(state: WorldState, nodes: readonly RailNode[]): Uint8Array {
  const coverage = new Uint8Array(state.cells.length);
  const radius = TRADE_RULES.trainRadius / normalizedCellLength(state.config);
  for (const factory of nodes.filter((node) => node.kind === "factory")) {
    for (const index of cellsWithin(state, factory.index, radius)) {
      if (state.cells[index]!.terrain !== "water") coverage[index] = 1;
    }
  }
  return coverage;
}

function railTraversalCost(terrain: LandTerrainId): number {
  if (terrain === "farmland") return 0.78;
  if (terrain === "plains") return 0.92;
  if (terrain === "forest") return 1.22;
  if (terrain === "hills") return 1.62;
  return 2.35;
}

/**
 * Binary heap over cell indices, held in parallel typed arrays.
 *
 * A network rebuild performs millions of pushes, so one object per entry was a
 * meaningful share of the system's cost. The heap is reused across searches;
 * `poppedCost` carries the cost of the last `pop` so callers avoid a tuple.
 */
class RailHeap {
  private cells = new Int32Array(1024);
  private costs = new Float64Array(1024);
  private size = 0;
  poppedCost = 0;

  clear(): void {
    this.size = 0;
  }

  push(cell: number, cost: number): void {
    if (this.size === this.cells.length) this.grow();
    let index = this.size;
    this.size += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.costs[parent]! <= cost) break;
      this.cells[index] = this.cells[parent]!;
      this.costs[index] = this.costs[parent]!;
      index = parent;
    }
    this.cells[index] = cell;
    this.costs[index] = cost;
  }

  /** Returns the cheapest cell, or -1 when empty. */
  pop(): number {
    if (this.size === 0) return -1;
    const root = this.cells[0]!;
    this.poppedCost = this.costs[0]!;
    this.size -= 1;
    if (this.size === 0) return root;
    const cell = this.cells[this.size]!;
    const cost = this.costs[this.size]!;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      const child = right < this.size && this.costs[right]! < this.costs[left]! ? right : left;
      if (this.costs[child]! >= cost) break;
      this.cells[index] = this.cells[child]!;
      this.costs[index] = this.costs[child]!;
      index = child;
    }
    this.cells[index] = cell;
    this.costs[index] = cost;
    return root;
  }

  private grow(): void {
    const cells = new Int32Array(this.cells.length * 2);
    const costs = new Float64Array(this.costs.length * 2);
    cells.set(this.cells);
    costs.set(this.costs);
    this.cells = cells;
    this.costs = costs;
  }
}

interface RailLink {
  /** The seeded node the link grows from. */
  seedIndex: number;
  /** The newly reached node the link connects. */
  targetIndex: number;
  cost: number;
  /** Cells from the reached target back to its seed. */
  path: number[];
}

// Search scratch is reused between calls. A generation stamp marks visited
// cells so a search costs only the cells it actually touches, rather than
// refilling three full-grid arrays before it starts.
const railHeap = new RailHeap();
let railDistance = new Float64Array(0);
let railPrevious = new Int32Array(0);
let railOrigin = new Int32Array(0);
let railStamp = new Int32Array(0);
let railGeneration = 0;

function beginRailSearch(size: number): void {
  if (railDistance.length !== size) {
    railDistance = new Float64Array(size);
    railPrevious = new Int32Array(size);
    railOrigin = new Int32Array(size);
    railStamp = new Int32Array(size);
    railGeneration = 0;
  }
  if (railGeneration >= 0x7fffffff) {
    railStamp.fill(0);
    railGeneration = 0;
  }
  railGeneration += 1;
  railHeap.clear();
}

/**
 * Finds the cheapest buildable rail link from any seed to any accepted target.
 *
 * One multi-source Dijkstra expands from every seed at once, so a single sweep
 * yields the globally cheapest link for this seed set. Because cells settle in
 * ascending build cost, the first accepted target is that cheapest link and the
 * search can stop there.
 */
function findCheapestRailLink(
  state: WorldState,
  seeds: readonly RailNode[],
  accept: (targetIndex: number, seedIndex: number) => boolean,
  coverage: Uint8Array,
  existingTrack: ReadonlySet<number>,
  nodeCells: ReadonlySet<number>,
): RailLink | null {
  if (seeds.length === 0) return null;
  const { width, height } = state.config;
  beginRailSearch(state.cells.length);
  const seedCells = new Set<number>();
  for (const seed of seeds) {
    if (seedCells.has(seed.index)) continue;
    seedCells.add(seed.index);
    railDistance[seed.index] = 0;
    railPrevious[seed.index] = -1;
    railOrigin[seed.index] = seed.index;
    railStamp[seed.index] = railGeneration;
    railHeap.push(seed.index, 0);
  }

  while (true) {
    const current = railHeap.pop();
    if (current < 0) return null;
    const cost = railHeap.poppedCost;
    // Costs are lowered by re-pushing, so stale entries are skipped here.
    if (cost !== railDistance[current]) continue;
    const seedIndex = railOrigin[current]!;
    if (!seedCells.has(current) && nodeCells.has(current) && accept(current, seedIndex)) {
      const path: number[] = [];
      for (let cursor = current; cursor >= 0; cursor = railPrevious[cursor]!) path.push(cursor);
      return { seedIndex, targetIndex: current, cost, path };
    }
    const ax = current % width;
    const ay = (current - ax) / width;
    for (const neighbor of surroundingIndices(current, width, height)) {
      const cell = state.cells[neighbor]!;
      if (cell.terrain === "water") continue;
      // Track may be laid inside factory coverage, along existing track, or
      // through a station. Stations were previously passable only when they
      // ended the link, so a line ran around every city it did not terminate
      // at -- which is why cities sat beside the rails instead of on them.
      const isStation = nodeCells.has(neighbor);
      if (!isStation && !coverage[neighbor] && !existingTrack.has(neighbor)) continue;
      const bx = neighbor % width;
      const by = (neighbor - bx) / width;
      const stepLength = ax !== bx && ay !== by ? Math.SQRT2 : 1;
      // Running through a station is nearly free, so a line threads the towns
      // between its ends rather than skirting them. Track already laid is
      // cheaper still, which keeps the network converging on shared trunks.
      const stepCost = existingTrack.has(neighbor)
        ? TRADE_RULES.railExistingTrackCost * stepLength
        : isStation
          ? TRADE_RULES.railStationCost * stepLength
          : railTraversalCost(cell.terrain as LandTerrainId) * stepLength;
      const proposed = cost + stepCost;
      if (railStamp[neighbor] === railGeneration && proposed >= railDistance[neighbor]!) continue;
      railStamp[neighbor] = railGeneration;
      railDistance[neighbor] = proposed;
      railPrevious[neighbor] = current;
      railOrigin[neighbor] = seedIndex;
      railHeap.push(neighbor, proposed);
    }
  }
}

function routeFromPath(state: WorldState, start: RailNode, end: RailNode, path: number[]): TradeRoute {
  const foreign = start.owner !== end.owner;
  const allied = foreign && getRelation(state, start.owner, end.owner).status === "truce";
  return {
    id: routeKey(start.index, end.index),
    owner: start.owner,
    parties: [start.owner, end.owner],
    kind: "rail",
    startIndex: start.index,
    endIndex: end.index,
    pathIndices: path,
    value: routeDistance(state, path),
    foreign,
    allied,
    destinationOwner: end.owner,
  };
}

function buildRailNetwork(state: WorldState): TradeRoute[] {
  const nodes = railNodes(state);
  const nodeByIndex = new Map(nodes.map((node) => [node.index, node]));
  const routes = state.tradeRoutes
    .filter((route) => route.kind === "rail")
    .filter((route) => nodeByIndex.has(route.startIndex) && nodeByIndex.has(route.endIndex))
    .map((route) => {
      const start = nodeByIndex.get(route.startIndex)!;
      const end = nodeByIndex.get(route.endIndex)!;
      return { ...routeFromPath(state, start, end, route.pathIndices), id: route.id };
    });
  const routeIds = new Set(routes.map((route) => route.id));
  const connected = new Set(routes.flatMap((route) => [route.startIndex, route.endIndex]));
  const coverage = factoryCoverage(state, nodes);
  const trackCells = new Set(routes.flatMap((route) => route.pathIndices));
  const nodeCells = new Set(nodes.map((node) => node.index));
  let added = 0;

  // Each pass lays the single cheapest link available, then repeats: laying
  // track lowers the cost of neighbouring routes, so the remaining candidates
  // genuinely change. One multi-source sweep per owner answers "what is the
  // cheapest link this owner can build" for every one of its stations at once,
  // so a pass costs a handful of sweeps rather than one per candidate pair.
  while (added < TRADE_RULES.railMaximumNewLinksPerRebuild) {
    const unconnected = nodes.filter((node) => !connected.has(node.index));
    if (unconnected.length === 0) break;
    let best: { start: RailNode; end: RailNode; path: number[]; cost: number } | null = null;

    // Tradeability is a property of the pair, but the sweep hands `accept` both
    // ends, so one sweep answers for every owner at once. That matters: with
    // fifty players, one sweep per owner meant fifty full-grid searches per link.
    if (connected.size === 0) {
      // The first link of a network grows out of a factory and may not exceed
      // the train radius.
      const seeds = unconnected.filter((node) => node.kind === "factory");
      const link = findCheapestRailLink(
        state,
        seeds,
        (targetIndex, seedIndex) => {
          const target = nodeByIndex.get(targetIndex);
          const seed = nodeByIndex.get(seedIndex);
          if (!target || !seed || targetIndex === seedIndex) return false;
          if (!canTrade(state, seed.owner, target.owner)) return false;
          return distanceBetween(state, seedIndex, targetIndex) <= TRADE_RULES.trainRadius;
        },
        coverage,
        trackCells,
        nodeCells,
      );
      if (link) {
        // The factory opens the link, so it stays the route's start; the
        // reconstructed path runs target-to-seed and is reversed to match.
        best = {
          start: nodeByIndex.get(link.seedIndex)!,
          end: nodeByIndex.get(link.targetIndex)!,
          path: [...link.path].reverse(),
          cost: link.cost,
        };
      }
    } else {
      const seeds = nodes.filter((node) => connected.has(node.index));
      const link = findCheapestRailLink(
        state,
        seeds,
        (targetIndex, seedIndex) => {
          const target = nodeByIndex.get(targetIndex);
          const seed = nodeByIndex.get(seedIndex);
          if (!target || !seed || connected.has(targetIndex)) return false;
          if (!canTrade(state, target.owner, seed.owner)) return false;
          return !routeIds.has(routeKey(targetIndex, seedIndex));
        },
        coverage,
        trackCells,
        nodeCells,
      );
      if (link) {
        // The joining station is the route's start, as when each unconnected
        // node searched for its own destination.
        best = {
          start: nodeByIndex.get(link.targetIndex)!,
          end: nodeByIndex.get(link.seedIndex)!,
          path: link.path,
          cost: link.cost,
        };
      }
    }

    if (!best) break;
    const route = routeFromPath(state, best.start, best.end, best.path);
    if (routeIds.has(route.id)) break;
    routes.push(route);
    routeIds.add(route.id);
    connected.add(best.start.index);
    connected.add(best.end.index);
    for (const index of best.path) trackCells.add(index);
    added += 1;
  }

  return routes;
}

const ROUTE_OWNERS = new WeakMap<TradeRoute, { revision: number; owners: PlayerId[] }>();

/**
 * Distinct owners along a route, in first-appearance order.
 *
 * Cached against the cell revision, because a route's ground changes only when
 * territory does. Recomputing it walked the whole path, and it is asked for
 * every route on every path search: a spawning factory retries destinations
 * until one connects, so at a hundred players this ran hundreds of thousands of
 * times a tick and was most of the trade system's cost.
 */
function routePathOwners(state: WorldState, route: TradeRoute): readonly PlayerId[] {
  const revision = cellRevision(state);
  const cached = ROUTE_OWNERS.get(route);
  if (cached && cached.revision === revision) return cached.owners;
  const owners: PlayerId[] = [];
  for (const index of route.pathIndices) {
    const owner = state.cells[index]!.owner;
    if (owner !== null && !owners.includes(owner)) owners.push(owner);
  }
  ROUTE_OWNERS.set(route, { revision, owners });
  return owners;
}

function routeAllowedForTrain(state: WorldState, route: TradeRoute, trainOwner: PlayerId): boolean {
  for (const owner of routePathOwners(state, route)) {
    if (!canTrade(state, trainOwner, owner)) return false;
  }
  return true;
}

/**
 * The track cells this owner is allowed to run trains over: the union of every
 * rail route whose ground the owner can trade across. Built once per owner and
 * shared by every destination its factories retry.
 */
function allowedTrackFor(
  state: WorldState,
  routes: readonly TradeRoute[],
  trainOwner: PlayerId,
): Set<number> {
  const track = new Set<number>();
  for (const route of routes) {
    if (route.kind !== "rail" || !routeAllowedForTrain(state, route, trainOwner)) continue;
    for (const index of route.pathIndices) track.add(index);
  }
  return track;
}

/**
 * The shortest physical run over laid track from source to destination.
 *
 * Journeys used to be stitched from whole route legs, so a train inherited
 * every station its legs had been planned around and called at all of them.
 * Searching the track cells themselves finds the genuinely shortest line, and
 * the train serves only the stations that line actually runs through -- a city
 * off the track is passed by.
 */
function shortestRailJourney(
  state: WorldState,
  trackCells: ReadonlySet<number>,
  source: number,
  destination: number,
): RailJourney | null {
  if (!trackCells.has(source) || !trackCells.has(destination)) return null;
  const { width, height } = state.config;
  beginRailSearch(state.cells.length);
  railDistance[source] = 0;
  railPrevious[source] = -1;
  railStamp[source] = railGeneration;
  railHeap.push(source, 0);
  let found = false;
  while (true) {
    const current = railHeap.pop();
    if (current < 0) break;
    const cost = railHeap.poppedCost;
    if (cost !== railDistance[current]) continue;
    if (current === destination) {
      found = true;
      break;
    }
    const ax = current % width;
    const ay = (current - ax) / width;
    for (const neighbor of surroundingIndices(current, width, height)) {
      if (!trackCells.has(neighbor)) continue;
      const bx = neighbor % width;
      const by = (neighbor - bx) / width;
      const proposed = cost + (ax !== bx && ay !== by ? Math.SQRT2 : 1);
      if (railStamp[neighbor] === railGeneration && proposed >= railDistance[neighbor]!) continue;
      railStamp[neighbor] = railGeneration;
      railDistance[neighbor] = proposed;
      railPrevious[neighbor] = current;
      railHeap.push(neighbor, proposed);
    }
  }
  if (!found) return null;
  const pathIndices: number[] = [];
  for (let cursor = destination; cursor >= 0; cursor = railPrevious[cursor]!) pathIndices.push(cursor);
  pathIndices.reverse();
  const stopIndices = pathIndices.filter(
    (index) => index === source || stationOwner(state, index) !== null,
  );
  return { pathIndices, stopIndices };
}

function addIncome(state: WorldState, owner: PlayerId, amount: number): void {
  const faction = state.factions[owner];
  faction.gold = clamp(faction.gold + amount, 0, ECONOMY_RULES.maximumTreasury);
  faction.goldRate += amount;
}

function payTrainStop(
  context: SimulationContext,
  vehicle: TradeVehicle,
  stopIndex: number,
): void {
  const { state } = context;
  const hostOwner = stationOwner(state, stopIndex);
  if (!hostOwner || !canTrade(state, vehicle.owner, hostOwner)) return;
  const foreign = hostOwner !== vehicle.owner;
  const allied = foreign && getRelation(state, vehicle.owner, hostOwner).status === "truce";
  const stop = state.cells[stopIndex]!;
  const stationMultiplier = stop.structure === "city"
    ? cityStationMultiplier(stop.structureLevel)
    : 1;
  // Convoys and the stations they call at are both halves of the land
  // carrier, so each side of a stop earns the land reward on its own leg: a
  // land realm's convoy pays its owner more, a land realm's station hosts
  // for more.
  const convoyMultiplier = tradeFormIncomeMultiplier(
    state.factions[vehicle.owner].expressedElement,
    "land",
  );
  // Each leg also pays at the heritage efficiency of the structure that
  // earned it: the dispatching factory for the convoy's owner, the station
  // for its host. A factory captured away mid-journey prices no leg — its
  // efficiency belongs to its new owner, not to this convoy's.
  const sourceCell = state.cells[vehicle.sourceIndex]!;
  const sourceEfficiency = sourceCell.owner === vehicle.owner
    ? structurePayoutMultiplier(state, sourceCell)
    : 1;
  const ownerIncome = (
    foreign
      ? TRADE_RULES.foreignTrainStopPayout
      : TRADE_RULES.domesticTrainStopPayout
  ) * stationMultiplier * convoyMultiplier * sourceEfficiency;
  addIncome(state, vehicle.owner, ownerIncome);
  // The train came from a factory, so the factory is what earned this.
  recordEarned(state, vehicle.owner, "factory", ownerIncome, 1);
  let hostIncome = 0;
  let stationMultiplierBonus = 1;
  let hostEfficiency = 1;
  if (foreign) {
    stationMultiplierBonus = tradeFormIncomeMultiplier(
      state.factions[hostOwner].expressedElement,
      "land",
    );
    hostEfficiency = structurePayoutMultiplier(state, stop);
    hostIncome = TRADE_RULES.foreignTrainStopPayout
      * stationMultiplier
      * stationMultiplierBonus
      * hostEfficiency;
    addIncome(state, hostOwner, hostIncome);
    // The host earned it by having somewhere worth stopping, so it belongs to
    // the station that took the stop rather than to the visitor's factory.
    recordEarned(state, hostOwner, stop.structure ?? "city", hostIncome, 1);
  }
  vehicle.earnedIncome += ownerIncome;
  vehicle.hostIncome += hostIncome;
  vehicle.completedStops += 1;
  context.report({
    domain: "trade",
    kind: "trade.train-stop-served",
    importance: foreign ? "notable" : "routine",
    storyKey: vehicle.storyKey,
    initiator: realmSubject(state, vehicle.owner),
    targets: [realmSubject(state, hostOwner)],
    participants: [realmSubject(state, vehicle.owner), realmSubject(state, hostOwner)],
    links: { vehicle: vehicle.id },
    facts: {
      stopIndex,
      ownerIncome,
      hostIncome,
      foreign,
      allied,
      convoyBonus: convoyMultiplier > 1,
      stationBonus: stationMultiplierBonus > 1,
      sourceEfficiency,
      hostEfficiency,
      stationLevel: stop.structure === "city" ? stop.structureLevel : 1,
      stationMultiplier,
      stopNumber: vehicle.completedStops,
    },
    summary: `${vehicle.id} served a ${foreign ? "foreign" : "domestic"} station and generated ${Math.round(ownerIncome + hostIncome)} gold.`,
  });
}

function journeyAllowed(state: WorldState, vehicle: TradeVehicle): boolean {
  // Only land convoys cross ground owned by third parties; every other
  // carrier answers to its destination alone.
  if (vehicle.kind !== "train") return canTrade(state, vehicle.owner, vehicle.destinationOwner);
  const owners = new Set(
    vehicle.pathIndices
      .map((index) => state.cells[index]!.owner)
      .filter((owner): owner is PlayerId => owner !== null),
  );
  return [...owners].every((owner) => canTrade(state, vehicle.owner, owner));
}

function distanceToStop(state: WorldState, vehicle: TradeVehicle, stopIndex: number): number {
  const pathPosition = vehicle.pathIndices.indexOf(stopIndex);
  if (pathPosition < 0) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 1; index <= pathPosition; index += 1) {
    distance += distanceBetween(state, vehicle.pathIndices[index - 1]!, vehicle.pathIndices[index]!);
  }
  return distance;
}

function updateVehicles(context: SimulationContext): void {
  const { state } = context;
  for (const vehicle of state.tradeVehicles) {
    if (!journeyAllowed(state, vehicle)) {
      vehicle.progress = 1;
      const nextDepartureAt = releaseDispatch(state, vehicle);
      context.report({
        domain: "trade",
        kind: "trade.journey-cancelled",
        importance: "notable",
        storyKey: vehicle.storyKey,
        initiator: realmSubject(state, vehicle.owner),
        targets: [realmSubject(state, vehicle.destinationOwner)],
        participants: [realmSubject(state, vehicle.owner), realmSubject(state, vehicle.destinationOwner)],
        links: { vehicle: vehicle.id },
        facts: {
          vehicleKind: vehicle.kind,
          distanceTravelled: vehicle.distanceTravelled,
          totalDistance: vehicle.totalDistance,
          earnedIncome: vehicle.earnedIncome,
          hostIncome: vehicle.hostIncome,
          sourceIndex: vehicle.sourceIndex,
          nextDepartureAt,
        },
        summary: `${vehicle.id} was recalled when trade permission closed before it reached its destination.`,
      });
      continue;
    }
    if (vehicle.kind === "train" && vehicle.dwellRemaining > 0) {
      vehicle.dwellRemaining -= 1;
      if (
        vehicle.dwellRemaining === 0 &&
        vehicle.distanceTravelled >= vehicle.totalDistance &&
        vehicle.nextStop >= vehicle.stopIndices.length
      ) {
        const nextDepartureAt = releaseDispatch(state, vehicle);
        vehicle.progress = 1;
        context.report({
          domain: "trade",
          kind: "trade.journey-completed",
          importance: vehicle.foreign ? "notable" : "routine",
          storyKey: vehicle.storyKey,
          initiator: realmSubject(state, vehicle.owner),
          targets: [realmSubject(state, vehicle.destinationOwner)],
          participants: [realmSubject(state, vehicle.owner), realmSubject(state, vehicle.destinationOwner)],
          links: { vehicle: vehicle.id },
          facts: {
            vehicleKind: "train",
            income: vehicle.earnedIncome,
            hostIncome: vehicle.hostIncome,
            distance: vehicle.totalDistance,
            stops: vehicle.completedStops,
            dwellTicksPerStop: TRADE_RULES.trainStopDwellTicks,
            journeyTicks: state.tick - vehicle.launchedAt,
            foreign: vehicle.foreign,
            allied: vehicle.allied,
            sourceIndex: vehicle.sourceIndex,
            nextDepartureAt,
          },
          summary: `${vehicle.id} completed its route after ${vehicle.completedStops} stops and generated ${Math.round(vehicle.earnedIncome + vehicle.hostIncome)} gold.`,
        });
      }
      continue;
    }
    vehicle.distanceTravelled = Math.min(
      vehicle.totalDistance,
      vehicle.distanceTravelled + vehicle.velocity,
    );
    vehicle.progress = vehicle.totalDistance > 0
      ? vehicle.distanceTravelled / vehicle.totalDistance
      : 1;
    if (vehicle.kind === "train") {
      const stopIndex = vehicle.stopIndices[vehicle.nextStop];
      const stopDistance = stopIndex === undefined
        ? Number.POSITIVE_INFINITY
        : distanceToStop(state, vehicle, stopIndex);
      if (stopIndex !== undefined && stopDistance <= vehicle.distanceTravelled) {
        payTrainStop(context, vehicle, stopIndex);
        vehicle.nextStop += 1;
        vehicle.dwellRemaining = TRADE_RULES.trainStopDwellTicks;
      }
      if (vehicle.progress >= 1) {
        // Keep the train visible at its destination until station dwell ends.
        vehicle.progress = 0.9999;
      }
    } else if (vehicle.progress >= 1) {
      addIncome(state, vehicle.owner, vehicle.payout);
      // Every point-to-point carrier credits the building that sent it:
      // ships sail from harbours, pulses run from plants, flyers lift from
      // skyports.
      const sender: StructureType = vehicle.kind === "pulse"
        ? "plant"
        : vehicle.kind === "flyer"
          ? "skyport"
          : "harbor";
      recordEarned(state, vehicle.owner, sender, vehicle.payout, 1);
      vehicle.earnedIncome += vehicle.payout;
      // Resonance is read at arrival: two civilizations that trade the same
      // ways make hosting worth more, and an ascension mid-voyage counts.
      const sharedForms = vehicle.foreign
        ? sharedTradeForms(
          state.factions[vehicle.owner].expressedElement,
          state.factions[vehicle.destinationOwner].expressedElement,
        )
        : 0;
      const hostShare = vehicle.foreign ? tradeHostShare(sharedForms, vehicle.allied) : 0;
      if (vehicle.foreign) {
        // The receiving structure hosts at its heritage efficiency — unless
        // it changed hands mid-voyage, in which case the delivery is still
        // owed to the destination realm at par.
        const endCell = state.cells[vehicle.endIndex]!;
        const hostEfficiency = endCell.owner === vehicle.destinationOwner
          ? structurePayoutMultiplier(state, endCell)
          : 1;
        const hostIncome = vehicle.payout * hostShare * hostEfficiency;
        vehicle.hostIncome += hostIncome;
        addIncome(state, vehicle.destinationOwner, hostIncome);
        // The receiving end earned it through whatever the delivery reached:
        // a harbour berth, a powered station, a skyport apron.
        recordEarned(
          state,
          vehicle.destinationOwner,
          state.cells[vehicle.endIndex]?.structure ?? sender,
          hostIncome,
          0,
        );
      }
      const nextDepartureAt = releaseDispatch(state, vehicle);
      const journeyName = vehicle.kind === "ship"
        ? "sea voyage"
        : vehicle.kind === "pulse"
          ? "conduit delivery"
          : "air freight run";
      context.report({
        domain: "trade",
        kind: "trade.journey-completed",
        // Pulses are the high-frequency carrier, so each one matters less.
        importance: vehicle.kind === "pulse"
          ? (vehicle.foreign ? "notable" : "routine")
          : (vehicle.foreign ? "major" : "notable"),
        storyKey: vehicle.storyKey,
        initiator: realmSubject(state, vehicle.owner),
        targets: [realmSubject(state, vehicle.destinationOwner)],
        participants: [realmSubject(state, vehicle.owner), realmSubject(state, vehicle.destinationOwner)],
        links: { vehicle: vehicle.id },
        facts: {
          vehicleKind: vehicle.kind,
          income: vehicle.earnedIncome,
          hostIncome: vehicle.hostIncome,
          distance: vehicle.totalDistance,
          journeyTicks: state.tick - vehicle.launchedAt,
          payoutPerTravelTick: vehicle.kind === "ship"
            ? TRADE_RULES.shipPayoutPerTravelTick
            : vehicle.kind === "flyer"
              ? TRADE_RULES.airPayoutPerTravelTick
              : null,
          foreign: vehicle.foreign,
          allied: vehicle.allied,
          sharedForms,
          hostShare,
          sourceIndex: vehicle.sourceIndex,
          nextDepartureAt,
        },
        summary: `${vehicle.id} completed its ${journeyName} and generated ${Math.round(vehicle.earnedIncome + vehicle.hostIncome)} gold.`,
      });
    }
  }
  state.tradeVehicles = state.tradeVehicles.filter((vehicle) => vehicle.progress < 1);
}

function spawnTrains(context: SimulationContext): void {
  const { state, random } = context;
  const trains = state.tradeVehicles.filter((vehicle) => vehicle.kind === "train");
  if (trains.length >= TRADE_RULES.trainLimit) return;
  const stations = new Set(
    state.tradeRoutes
      .filter((route) => route.kind === "rail")
      .flatMap((route) => [route.startIndex, route.endIndex]),
  );
  const factories = PLAYER_ORDER.flatMap((owner) => structureCells(state, owner, "factory"))
    .filter((factory) => stations.has(factory) && dispatchReady(state, "train", factory));
  // One track set per owner, shared by that owner's factories and by every
  // destination they retry.
  const trackByOwner = new Map<PlayerId, Set<number>>();
  const trackFor = (owner: PlayerId): Set<number> => {
    const cached = trackByOwner.get(owner);
    if (cached) return cached;
    const built = allowedTrackFor(state, state.tradeRoutes, owner);
    trackByOwner.set(owner, built);
    return built;
  };
  let activeTrains = trains.length;

  for (const source of factories) {
    if (activeTrains >= TRADE_RULES.trainLimit) break;
    const owner = state.cells[source]!.owner;
    if (!owner) continue;
    const pool = [...stations].filter((index) => index !== source && stationOwner(state, index) !== null);
    let journey: RailJourney | null = null;
    let destination = -1;
    while (pool.length > 0 && !journey) {
      const choice = random.int(0, pool.length - 1);
      destination = pool.splice(choice, 1)[0]!;
      journey = shortestRailJourney(state, trackFor(owner), source, destination);
    }
    if (!journey || destination < 0) continue;
    const destinationOwner = stationOwner(state, destination)!;
    const foreign = destinationOwner !== owner;
    const allied = foreign && getRelation(state, owner, destinationOwner).status === "truce";
    const totalDistance = routeDistance(state, journey.pathIndices);
    const vehicleId = `train:${state.tick}:${source}`;
    const vehicle: TradeVehicle = {
      id: vehicleId,
      owner,
      kind: "train",
      startIndex: source,
      endIndex: destination,
      pathIndices: journey.pathIndices,
      stopIndices: journey.stopIndices,
      progress: 0,
      velocity: TRADE_RULES.trainVelocity,
      distanceTravelled: 0,
      totalDistance,
      nextStop: 1,
      sourceIndex: source,
      payout: TRADE_RULES.domesticTrainStopPayout,
      foreign,
      allied,
      destinationOwner,
      storyKey: tradeStoryKey(owner, destinationOwner, state.tick),
      earnedIncome: 0,
      hostIncome: 0,
      completedStops: 0,
      launchedAt: state.tick,
      dwellRemaining: 0,
    };
    state.tradeVehicles.push(vehicle);
    activeTrains += 1;
    reserveDispatch(state, vehicle);
    context.report({
      domain: "trade",
      kind: "trade.journey-started",
      importance: foreign ? "notable" : "routine",
      storyKey: vehicle.storyKey,
      initiator: realmSubject(state, owner),
      targets: [realmSubject(state, destinationOwner)],
      participants: [realmSubject(state, owner), realmSubject(state, destinationOwner)],
      links: { vehicle: vehicle.id },
      facts: {
        vehicleKind: "train",
        sourceIndex: source,
        destinationIndex: destination,
        distance: totalDistance,
        plannedStops: journey.stopIndices.length - 1,
        dwellTicksPerStop: TRADE_RULES.trainStopDwellTicks,
        foreign,
        allied,
      },
      summary: `${vehicle.id} departed for a ${journey.stopIndices.length}-station rail journey.`,
    });
  }
}

function spawnShips(context: SimulationContext): void {
  const { state, random } = context;
  let shipCount = state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship").length;
  if (shipCount >= TRADE_RULES.shipLimit) return;
  const harbors = PLAYER_ORDER.flatMap((owner) => structureCells(state, owner, "harbor"));
  for (const source of harbors) {
    if (shipCount >= TRADE_RULES.shipLimit) break;
    if (!dispatchReady(state, "ship", source)) continue;
    const owner = state.cells[source]!.owner;
    if (!owner) continue;
    const pool = harbors.filter((destination) => {
      const destinationOwner = state.cells[destination]!.owner;
      return destination !== source && destinationOwner !== null && canTrade(state, owner, destinationOwner);
    });
    if (pool.length === 0) continue;
    const destination = random.pick(pool);
    const path = waterPathBetweenLandCells(state, source, destination);
    if (!path || !isValidWaterPath(state, path)) continue;
    const destinationOwner = state.cells[destination]!.owner!;
    const foreign = destinationOwner !== owner;
    const allied = foreign && getRelation(state, owner, destinationOwner).status === "truce";
    const totalDistance = routeDistance(state, path);
    const plannedTravelTicks = totalDistance / TRADE_RULES.shipVelocity;
    // Ships are the waterway carrier: a realm whose expressed element trades
    // by water sails the same voyage for more, priced at launch so the
    // expected payout below is the payout the voyage delivers. The harbor's
    // heritage efficiency prices the voyage too — a captured port pays what
    // its captor's history can wring from it.
    const waterwayMultiplier = tradeFormIncomeMultiplier(
      state.factions[owner].expressedElement,
      "waterway",
    );
    const payout = plannedTravelTicks
      * TRADE_RULES.shipPayoutPerTravelTick
      * waterwayMultiplier
      * structurePayoutMultiplier(state, state.cells[source]!);
    const vehicleId = `ship:${state.tick}:${source}:${destination}`;
    const vehicle: TradeVehicle = {
      id: vehicleId,
      owner,
      kind: "ship",
      startIndex: source,
      endIndex: destination,
      pathIndices: path,
      stopIndices: [source, destination],
      progress: 0,
      velocity: TRADE_RULES.shipVelocity,
      distanceTravelled: 0,
      totalDistance,
      nextStop: 0,
      sourceIndex: source,
      payout,
      foreign,
      allied,
      destinationOwner,
      storyKey: tradeStoryKey(owner, destinationOwner, state.tick),
      earnedIncome: 0,
      hostIncome: 0,
      completedStops: 0,
      launchedAt: state.tick,
      dwellRemaining: 0,
    };
    state.tradeVehicles.push(vehicle);
    reserveDispatch(state, vehicle);
    context.report({
      domain: "trade",
      kind: "trade.journey-started",
      importance: foreign ? "notable" : "routine",
      storyKey: vehicle.storyKey,
      initiator: realmSubject(state, owner),
      targets: [realmSubject(state, destinationOwner)],
      participants: [realmSubject(state, owner), realmSubject(state, destinationOwner)],
      links: { vehicle: vehicle.id },
      facts: {
        vehicleKind: "ship",
        sourceIndex: source,
        destinationIndex: destination,
        distance: totalDistance,
        expectedPayout: payout,
        plannedTravelTicks,
        payoutPerTravelTick: TRADE_RULES.shipPayoutPerTravelTick,
        waterwayBonus: waterwayMultiplier > 1,
        foreign,
        allied,
      },
      summary: `${vehicle.id} departed on a ${totalDistance.toFixed(1)}-unit water-only voyage.`,
    });
    shipCount += 1;
  }
}

function conduitKey(first: number, second: number): string {
  return `conduit:${Math.min(first, second)}:${Math.max(first, second)}`;
}

/**
 * The energy carrier's network: every plant strings straight conduits to the
 * nearest few stations in reach whose owner it can trade with. Conduits are
 * lines, not laid track — they are recomputed whole from the plants,
 * stations and diplomacy standing today, and a redraw costs plants times
 * stations, which stays trivial beside one rail sweep.
 */
function buildConduitNetwork(state: WorldState): TradeRoute[] {
  const routes: TradeRoute[] = [];
  const stations: number[] = [];
  for (const owner of PLAYER_ORDER) {
    if (!state.factions[owner].alive) continue;
    stations.push(
      ...structureCells(state, owner, "city"),
      ...structureCells(state, owner, "factory"),
    );
  }
  for (const owner of PLAYER_ORDER) {
    if (!state.factions[owner].alive) continue;
    for (const plantIndex of structureCells(state, owner, "plant")) {
      const candidates: Array<{ index: number; distance: number }> = [];
      for (const stationIndex of stations) {
        const stationHolder = state.cells[stationIndex]!.owner;
        if (stationHolder === null || !canTrade(state, owner, stationHolder)) continue;
        const distance = distanceBetween(state, plantIndex, stationIndex);
        if (distance <= TRADE_RULES.conduitRadius) candidates.push({ index: stationIndex, distance });
      }
      candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
      for (const candidate of candidates.slice(0, TRADE_RULES.conduitLinksPerPlant)) {
        const destinationOwner = state.cells[candidate.index]!.owner!;
        const foreign = destinationOwner !== owner;
        routes.push({
          id: conduitKey(plantIndex, candidate.index),
          owner,
          parties: [owner, destinationOwner],
          kind: "conduit",
          startIndex: plantIndex,
          endIndex: candidate.index,
          pathIndices: [plantIndex, candidate.index],
          value: candidate.distance,
          foreign,
          allied: foreign && getRelation(state, owner, destinationOwner).status === "truce",
          destinationOwner,
        });
      }
    }
  }
  return routes;
}

/**
 * Pulses run the conduits: each plant sends one down a random link, and the
 * delivery pays a flat value at the far station — energy trade is
 * frequency, not distance. A realm whose expressed element trades by energy
 * built the only plants there are, so the reward multiplier prices every
 * pulse it sends; a captured plant keeps pulsing for its captor, who simply
 * earns no bonus on what it was never theirs to master.
 */
function spawnPulses(context: SimulationContext): void {
  const { state, random } = context;
  let pulseCount = state.tradeVehicles.filter((vehicle) => vehicle.kind === "pulse").length;
  if (pulseCount >= TRADE_RULES.pulseLimit) return;
  const linksBySource = new Map<number, TradeRoute[]>();
  for (const route of state.tradeRoutes) {
    if (route.kind !== "conduit") continue;
    const links = linksBySource.get(route.startIndex);
    if (links) links.push(route);
    else linksBySource.set(route.startIndex, [route]);
  }
  for (const [source, links] of linksBySource) {
    if (pulseCount >= TRADE_RULES.pulseLimit) break;
    if (!dispatchReady(state, "pulse", source)) continue;
    const owner = state.cells[source]!.owner;
    if (!owner) continue;
    const pool = links.filter((link) => {
      const destinationOwner = state.cells[link.endIndex]!.owner;
      return destinationOwner !== null && canTrade(state, owner, destinationOwner);
    });
    if (pool.length === 0) continue;
    const link = random.pick(pool);
    const destinationOwner = state.cells[link.endIndex]!.owner!;
    const foreign = destinationOwner !== owner;
    const allied = foreign && getRelation(state, owner, destinationOwner).status === "truce";
    const totalDistance = distanceBetween(state, source, link.endIndex);
    const energyMultiplier = tradeFormIncomeMultiplier(
      state.factions[owner].expressedElement,
      "energy",
    );
    const payout = TRADE_RULES.energyDeliveryPayout
      * energyMultiplier
      * structurePayoutMultiplier(state, state.cells[source]!);
    const vehicle: TradeVehicle = {
      id: `pulse:${state.tick}:${source}:${link.endIndex}`,
      owner,
      kind: "pulse",
      startIndex: source,
      endIndex: link.endIndex,
      pathIndices: [source, link.endIndex],
      stopIndices: [source, link.endIndex],
      progress: 0,
      velocity: TRADE_RULES.pulseVelocity,
      distanceTravelled: 0,
      totalDistance,
      nextStop: 0,
      sourceIndex: source,
      payout,
      foreign,
      allied,
      destinationOwner,
      storyKey: tradeStoryKey(owner, destinationOwner, state.tick),
      earnedIncome: 0,
      hostIncome: 0,
      completedStops: 0,
      launchedAt: state.tick,
      dwellRemaining: 0,
    };
    state.tradeVehicles.push(vehicle);
    pulseCount += 1;
    reserveDispatch(state, vehicle);
    context.report({
      domain: "trade",
      kind: "trade.journey-started",
      importance: foreign ? "notable" : "routine",
      storyKey: vehicle.storyKey,
      initiator: realmSubject(state, owner),
      targets: [realmSubject(state, destinationOwner)],
      participants: [realmSubject(state, owner), realmSubject(state, destinationOwner)],
      links: { vehicle: vehicle.id },
      facts: {
        vehicleKind: "pulse",
        sourceIndex: source,
        destinationIndex: link.endIndex,
        distance: totalDistance,
        expectedPayout: payout,
        energyBonus: energyMultiplier > 1,
        foreign,
        allied,
      },
      summary: `${vehicle.id} left its plant down a ${totalDistance.toFixed(1)}-unit conduit.`,
    });
  }
}

/**
 * Flyers cross anything in a straight line between skyports. There is no
 * network to lay and no ground to answer to — only the pair of aprons and
 * whether their owners trade — so air freight is priced like a voyage, by
 * the distance it buys, at the airborne premium.
 */
function spawnFlyers(context: SimulationContext): void {
  const { state, random } = context;
  let flyerCount = state.tradeVehicles.filter((vehicle) => vehicle.kind === "flyer").length;
  if (flyerCount >= TRADE_RULES.flyerLimit) return;
  const skyports = PLAYER_ORDER.flatMap((owner) => structureCells(state, owner, "skyport"));
  for (const source of skyports) {
    if (flyerCount >= TRADE_RULES.flyerLimit) break;
    if (!dispatchReady(state, "flyer", source)) continue;
    const owner = state.cells[source]!.owner;
    if (!owner) continue;
    const pool = skyports.filter((destination) => {
      if (destination === source) return false;
      const destinationOwner = state.cells[destination]!.owner;
      if (destinationOwner === null || !canTrade(state, owner, destinationOwner)) return false;
      return distanceBetween(state, source, destination) >= TRADE_RULES.minimumFlightDistance;
    });
    if (pool.length === 0) continue;
    const destination = random.pick(pool);
    const destinationOwner = state.cells[destination]!.owner!;
    const foreign = destinationOwner !== owner;
    const allied = foreign && getRelation(state, owner, destinationOwner).status === "truce";
    const totalDistance = distanceBetween(state, source, destination);
    const plannedTravelTicks = totalDistance / TRADE_RULES.flyerVelocity;
    const airborneMultiplier = tradeFormIncomeMultiplier(
      state.factions[owner].expressedElement,
      "airborne",
    );
    const payout = plannedTravelTicks
      * TRADE_RULES.airPayoutPerTravelTick
      * airborneMultiplier
      * structurePayoutMultiplier(state, state.cells[source]!);
    const vehicle: TradeVehicle = {
      id: `flyer:${state.tick}:${source}:${destination}`,
      owner,
      kind: "flyer",
      startIndex: source,
      endIndex: destination,
      pathIndices: [source, destination],
      stopIndices: [source, destination],
      progress: 0,
      velocity: TRADE_RULES.flyerVelocity,
      distanceTravelled: 0,
      totalDistance,
      nextStop: 0,
      sourceIndex: source,
      payout,
      foreign,
      allied,
      destinationOwner,
      storyKey: tradeStoryKey(owner, destinationOwner, state.tick),
      earnedIncome: 0,
      hostIncome: 0,
      completedStops: 0,
      launchedAt: state.tick,
      dwellRemaining: 0,
    };
    state.tradeVehicles.push(vehicle);
    flyerCount += 1;
    reserveDispatch(state, vehicle);
    context.report({
      domain: "trade",
      kind: "trade.journey-started",
      importance: foreign ? "notable" : "routine",
      storyKey: vehicle.storyKey,
      initiator: realmSubject(state, owner),
      targets: [realmSubject(state, destinationOwner)],
      participants: [realmSubject(state, owner), realmSubject(state, destinationOwner)],
      links: { vehicle: vehicle.id },
      facts: {
        vehicleKind: "flyer",
        sourceIndex: source,
        destinationIndex: destination,
        distance: totalDistance,
        expectedPayout: payout,
        plannedTravelTicks,
        payoutPerTravelTick: TRADE_RULES.airPayoutPerTravelTick,
        airborneBonus: airborneMultiplier > 1,
        foreign,
        allied,
      },
      summary: `${vehicle.id} lifted off on a ${totalDistance.toFixed(1)}-unit straight flight.`,
    });
  }
}

export class TradeNetworkSystem implements SimulationSystem {
  readonly id = "trade-network";

  update(context: SimulationContext): void {
    const { state } = context;
    updateVehicles(context);
    const signature = railNetworkSignature(state);
    const topologyChanged = signature !== state.railNetworkSignature;
    if (
      state.tick === 1 ||
      topologyChanged ||
      state.railNetworkNeedsExpansion ||
      state.tick % TRADE_RULES.networkRebuildTicks === 0
    ) {
      const previous = new Set(state.tradeRoutes.map((route) => route.id));
      const rail = buildRailNetwork(state);
      const conduits = buildConduitNetwork(state);
      const next = [...rail, ...conduits];
      const nextIds = new Set(next.map((route) => route.id));
      const added = next.filter((route) => !previous.has(route.id)).map((route) => route.id);
      const removed = [...previous].filter((id) => !nextIds.has(id));
      state.tradeRoutes = next;
      state.railNetworkSignature = signature;
      // Only rail grows link by link; conduits redraw whole, so expansion
      // pressure is a rail question alone.
      state.railNetworkNeedsExpansion = added.filter((id) => id.startsWith("rail:")).length
        >= TRADE_RULES.railMaximumNewLinksPerRebuild;
      if (added.length > 0 || removed.length > 0) {
        const realmIds = [...new Set(next.flatMap((route) => [...route.parties]))];
        context.report({
          domain: "trade",
          kind: "trade.rail-network-changed",
          importance: next.some((route) => route.foreign) ? "notable" : "routine",
          storyKey: `rail-network:${Math.floor(state.tick / 240)}`,
          initiator: null,
          targets: [],
          participants: realmIds.map((party) => realmSubject(state, party)),
          links: {},
          facts: {
            edges: rail.length,
            conduitEdges: conduits.length,
            foreignEdges: next.filter((route) => route.foreign).length,
            alliedEdges: next.filter((route) => route.allied).length,
            added,
            removed,
          },
          summary: `The trade network changed by ${added.length} added and ${removed.length} removed connections, reaching ${rail.length} tracks and ${conduits.length} conduits.`,
        });
      }
    }
    if (state.tick % TRADE_RULES.trainSpawnIntervalTicks === 0) spawnTrains(context);
    // Ships, pulses and flyers are paced by their sites, not by a world
    // clock. The global cadence that used to gate ships made every port in
    // the world sail on the same tick and sit idle between, which no
    // per-site timer could undo while it stood: a harbour ready on tick
    // nine simply was not asked until twelve.
    spawnShips(context);
    spawnPulses(context);
    spawnFlyers(context);
  }
}
