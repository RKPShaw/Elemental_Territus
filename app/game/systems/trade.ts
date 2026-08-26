import { PLAYER_ORDER } from "../players";
import { getRelation } from "../diplomacy";

import {
  cellsWithin,
  distanceBetween,
  structureCells,
  surroundingIndices,
} from "../grid";
import { cellRevision } from "../structure-index";
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
    activeVehicleId: null,
    readyAt: 0,
    completedRuns: 0,
    lastVehicleId: null,
  };
  return state.tradeDispatches[key]!;
}

function reserveDispatch(state: WorldState, vehicle: TradeVehicle): void {
  const dispatch = dispatchFor(state, vehicle.kind, vehicle.sourceIndex);
  dispatch.activeVehicleId = vehicle.id;
}

function releaseDispatch(state: WorldState, vehicle: TradeVehicle): number {
  const dispatch = dispatchFor(state, vehicle.kind, vehicle.sourceIndex);
  if (dispatch.activeVehicleId === vehicle.id) {
    dispatch.activeVehicleId = null;
    dispatch.readyAt = state.tick + TRADE_RULES.vehicleTurnaroundTicks;
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
  return dispatch.activeVehicleId === null && state.tick >= dispatch.readyAt;
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
    if (cell.structure !== "city" && cell.structure !== "factory") continue;
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
      // Track may only be laid inside factory coverage or along existing
      // track; a station that would terminate the link is exempt.
      const terminates = nodeCells.has(neighbor) && accept(neighbor, seedIndex);
      if (!terminates && !coverage[neighbor] && !existingTrack.has(neighbor)) continue;
      const bx = neighbor % width;
      const by = (neighbor - bx) / width;
      const stepLength = ax !== bx && ay !== by ? Math.SQRT2 : 1;
      const stepCost = existingTrack.has(neighbor)
        ? TRADE_RULES.railExistingTrackCost * stepLength
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

type RailAdjacency = Map<number, Array<{ index: number; route: TradeRoute }>>;

/**
 * The rail graph this owner is allowed to run on. Identical in content and
 * insertion order to building it inline, but built once per owner rather than
 * once per attempted destination.
 */
function railAdjacencyFor(
  state: WorldState,
  routes: readonly TradeRoute[],
  trainOwner: PlayerId,
): RailAdjacency {
  const adjacency: RailAdjacency = new Map();
  const link = (from: number, to: number, route: TradeRoute) => {
    const existing = adjacency.get(from);
    if (existing) existing.push({ index: to, route });
    else adjacency.set(from, [{ index: to, route }]);
  };
  for (const route of routes) {
    if (route.kind !== "rail" || !routeAllowedForTrain(state, route, trainOwner)) continue;
    link(route.startIndex, route.endIndex, route);
    link(route.endIndex, route.startIndex, route);
  }
  return adjacency;
}

function shortestRailPath(
  state: WorldState,
  adjacency: RailAdjacency,
  source: number,
  destination: number,
): RailJourney | null {
  if (!adjacency.has(source) || !adjacency.has(destination)) return null;
  const distances = new Map<number, number>([[source, 0]]);
  const previous = new Map<number, { index: number; route: TradeRoute }>();
  const unvisited = new Set(adjacency.keys());
  while (unvisited.size > 0) {
    let current: number | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const candidate of unvisited) {
      const distance = distances.get(candidate) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        current = candidate;
        currentDistance = distance;
      }
    }
    if (current === null || !Number.isFinite(currentDistance)) break;
    unvisited.delete(current);
    if (current === destination) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!unvisited.has(neighbor.index)) continue;
      const proposed = currentDistance + neighbor.route.value;
      if (proposed < (distances.get(neighbor.index) ?? Number.POSITIVE_INFINITY)) {
        distances.set(neighbor.index, proposed);
        previous.set(neighbor.index, { index: current, route: neighbor.route });
      }
    }
  }
  if (!distances.has(destination)) return null;
  const legs: Array<{ from: number; to: number; route: TradeRoute }> = [];
  for (let cursor = destination; cursor !== source;) {
    const prior = previous.get(cursor);
    if (!prior) return null;
    legs.push({ from: prior.index, to: cursor, route: prior.route });
    cursor = prior.index;
  }
  legs.reverse();
  const pathIndices: number[] = [];
  const stopIndices = [source];
  for (const leg of legs) {
    const oriented = leg.route.startIndex === leg.from
      ? leg.route.pathIndices
      : [...leg.route.pathIndices].reverse();
    pathIndices.push(...(pathIndices.length > 0 ? oriented.slice(1) : oriented));
    stopIndices.push(leg.to);
  }
  const stationStops = pathIndices.filter((index) => stationOwner(state, index) !== null);
  return {
    pathIndices,
    stopIndices: [...new Set([...stopIndices, ...stationStops])]
      .sort((first, second) => pathIndices.indexOf(first) - pathIndices.indexOf(second)),
  };
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
  const ownerIncome = (
    foreign
      ? TRADE_RULES.foreignTrainStopPayout
      : TRADE_RULES.domesticTrainStopPayout
  ) * stationMultiplier;
  addIncome(state, vehicle.owner, ownerIncome);
  let hostIncome = 0;
  if (foreign) {
    hostIncome = TRADE_RULES.foreignTrainStopPayout * stationMultiplier;
    addIncome(state, hostOwner, hostIncome);
  }
  vehicle.earnedIncome += ownerIncome;
  vehicle.hostIncome += hostIncome;
  vehicle.completedStops += 1;
  context.report({
    domain: "trade",
    kind: "trade.train-stop-served",
    importance: foreign ? "notable" : "routine",
    storyKey: vehicle.storyKey,
    initiator: realmSubject(vehicle.owner),
    targets: [realmSubject(hostOwner)],
    participants: [realmSubject(vehicle.owner), realmSubject(hostOwner)],
    links: { vehicle: vehicle.id },
    facts: {
      stopIndex,
      ownerIncome,
      hostIncome,
      foreign,
      allied,
      stationLevel: stop.structure === "city" ? stop.structureLevel : 1,
      stationMultiplier,
      stopNumber: vehicle.completedStops,
    },
    summary: `${vehicle.id} served a ${foreign ? "foreign" : "domestic"} station and generated ${Math.round(ownerIncome + hostIncome)} gold.`,
  });
}

function journeyAllowed(state: WorldState, vehicle: TradeVehicle): boolean {
  if (vehicle.kind === "ship") return canTrade(state, vehicle.owner, vehicle.destinationOwner);
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
        initiator: realmSubject(vehicle.owner),
        targets: [realmSubject(vehicle.destinationOwner)],
        participants: [realmSubject(vehicle.owner), realmSubject(vehicle.destinationOwner)],
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
          initiator: realmSubject(vehicle.owner),
          targets: [realmSubject(vehicle.destinationOwner)],
          participants: [realmSubject(vehicle.owner), realmSubject(vehicle.destinationOwner)],
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
      vehicle.earnedIncome += vehicle.payout;
      if (vehicle.foreign) {
        const hostIncome = vehicle.payout * (
          vehicle.allied ? TRADE_RULES.alliedHostShare : TRADE_RULES.foreignHostShare
        );
        vehicle.hostIncome += hostIncome;
        addIncome(state, vehicle.destinationOwner, hostIncome);
      }
      const nextDepartureAt = releaseDispatch(state, vehicle);
      context.report({
        domain: "trade",
        kind: "trade.journey-completed",
        importance: vehicle.foreign ? "major" : "notable",
        storyKey: vehicle.storyKey,
        initiator: realmSubject(vehicle.owner),
        targets: [realmSubject(vehicle.destinationOwner)],
        participants: [realmSubject(vehicle.owner), realmSubject(vehicle.destinationOwner)],
        links: { vehicle: vehicle.id },
        facts: {
          vehicleKind: "ship",
          income: vehicle.earnedIncome,
          hostIncome: vehicle.hostIncome,
          distance: vehicle.totalDistance,
          journeyTicks: state.tick - vehicle.launchedAt,
          payoutPerTravelTick: TRADE_RULES.shipPayoutPerTravelTick,
          foreign: vehicle.foreign,
          allied: vehicle.allied,
          sourceIndex: vehicle.sourceIndex,
          nextDepartureAt,
        },
        summary: `${vehicle.id} completed its sea voyage and generated ${Math.round(vehicle.earnedIncome + vehicle.hostIncome)} gold.`,
      });
    }
  }
  state.tradeVehicles = state.tradeVehicles.filter((vehicle) => vehicle.progress < 1);
}

function spawnTrains(context: SimulationContext): void {
  const { state, random } = context;
  const trains = state.tradeVehicles.filter((vehicle) => vehicle.kind === "train");
  if (trains.length >= TRADE_RULES.trainLimit) return;
  const stations = new Set(state.tradeRoutes.flatMap((route) => [route.startIndex, route.endIndex]));
  const factories = PLAYER_ORDER.flatMap((owner) => structureCells(state, owner, "factory"))
    .filter((factory) => stations.has(factory) && dispatchReady(state, "train", factory));
  // One graph per owner, shared by that owner's factories and by every
  // destination they retry.
  const adjacencyByOwner = new Map<PlayerId, RailAdjacency>();
  const adjacencyFor = (owner: PlayerId): RailAdjacency => {
    const cached = adjacencyByOwner.get(owner);
    if (cached) return cached;
    const built = railAdjacencyFor(state, state.tradeRoutes, owner);
    adjacencyByOwner.set(owner, built);
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
      journey = shortestRailPath(state, adjacencyFor(owner), source, destination);
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
      initiator: realmSubject(owner),
      targets: [realmSubject(destinationOwner)],
      participants: [realmSubject(owner), realmSubject(destinationOwner)],
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
    const payout = plannedTravelTicks * TRADE_RULES.shipPayoutPerTravelTick;
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
      initiator: realmSubject(owner),
      targets: [realmSubject(destinationOwner)],
      participants: [realmSubject(owner), realmSubject(destinationOwner)],
      links: { vehicle: vehicle.id },
      facts: {
        vehicleKind: "ship",
        sourceIndex: source,
        destinationIndex: destination,
        distance: totalDistance,
        expectedPayout: payout,
        plannedTravelTicks,
        payoutPerTravelTick: TRADE_RULES.shipPayoutPerTravelTick,
        foreign,
        allied,
      },
      summary: `${vehicle.id} departed on a ${totalDistance.toFixed(1)}-unit water-only voyage.`,
    });
    shipCount += 1;
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
      const next = buildRailNetwork(state);
      const nextIds = new Set(next.map((route) => route.id));
      const added = next.filter((route) => !previous.has(route.id)).map((route) => route.id);
      const removed = [...previous].filter((id) => !nextIds.has(id));
      state.tradeRoutes = next;
      state.railNetworkSignature = signature;
      state.railNetworkNeedsExpansion = added.length >= TRADE_RULES.railMaximumNewLinksPerRebuild;
      if (added.length > 0 || removed.length > 0) {
        const realmIds = [...new Set(next.flatMap((route) => [...route.parties]))];
        context.report({
          domain: "trade",
          kind: "trade.rail-network-changed",
          importance: next.some((route) => route.foreign) ? "notable" : "routine",
          storyKey: `rail-network:${Math.floor(state.tick / 240)}`,
          initiator: null,
          targets: [],
          participants: realmIds.map(realmSubject),
          links: {},
          facts: {
            edges: next.length,
            foreignEdges: next.filter((route) => route.foreign).length,
            alliedEdges: next.filter((route) => route.allied).length,
            added,
            removed,
          },
          summary: `The rail network changed by ${added.length} added and ${removed.length} removed connections, reaching ${next.length} total tracks.`,
        });
      }
    }
    if (state.tick % TRADE_RULES.trainSpawnIntervalTicks === 0) spawnTrains(context);
    if (state.tick % TRADE_RULES.shipSpawnIntervalTicks === 0) spawnShips(context);
  }
}
