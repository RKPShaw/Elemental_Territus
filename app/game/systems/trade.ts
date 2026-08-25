import { getRelation } from "../diplomacy";
import { ELEMENT_ORDER } from "../elements";
import {
  cellsWithin,
  distanceBetween,
  structureCells,
  surroundingIndices,
} from "../grid";
import { realmSubject } from "../reporting";
import {
  ECONOMY_RULES,
  TRADE_RULES,
  cityStationMultiplier,
  clamp,
  normalizedCellLength,
} from "../rules";
import type {
  ElementId,
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
  owner: ElementId;
  kind: "city" | "factory";
}

interface RailEdge {
  start: RailNode;
  end: RailNode;
  distance: number;
  pathIndices: number[];
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

function tradeStoryKey(first: ElementId, second: ElementId, tick: number): string {
  const parties = [first, second].sort();
  return `trade:${parties[0]}:${parties[1]}:${Math.floor(tick / 240)}`;
}

function canTrade(state: WorldState, first: ElementId, second: ElementId): boolean {
  if (first === second) return true;
  const relation = getRelation(state, first, second);
  return relation.status !== "war" && relation.tradeActive;
}

function stationOwner(state: WorldState, index: number): ElementId | null {
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
  for (const owner of ELEMENT_ORDER) {
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

interface HeapEntry {
  index: number;
  cost: number;
}

class MinimumHeap {
  private readonly entries: HeapEntry[] = [];

  push(entry: HeapEntry): void {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.entries[parent]!.cost <= entry.cost) break;
      this.entries[index] = this.entries[parent]!;
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): HeapEntry | null {
    if (this.entries.length === 0) return null;
    const root = this.entries[0]!;
    const tail = this.entries.pop()!;
    if (this.entries.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      const child = right < this.entries.length && this.entries[right]!.cost < this.entries[left]!.cost
        ? right
        : left;
      if (this.entries[child]!.cost >= tail.cost) break;
      this.entries[index] = this.entries[child]!;
      index = child;
    }
    this.entries[index] = tail;
    return root;
  }
}

function findRailPath(
  state: WorldState,
  source: number,
  destination: number,
  coverage: Uint8Array,
  existingTrack: ReadonlySet<number>,
): number[] | null {
  const distance = new Float64Array(state.cells.length);
  distance.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(state.cells.length);
  previous.fill(-1);
  const heap = new MinimumHeap();
  distance[source] = 0;
  heap.push({ index: source, cost: 0 });

  while (true) {
    const current = heap.pop();
    if (!current) return null;
    if (current.cost !== distance[current.index]) continue;
    if (current.index === destination) break;
    for (const neighbor of surroundingIndices(current.index, state.config.width, state.config.height)) {
      const cell = state.cells[neighbor]!;
      if (cell.terrain === "water") continue;
      if (
        neighbor !== destination &&
        !coverage[neighbor] &&
        !existingTrack.has(neighbor)
      ) continue;
      const [ax, ay] = [current.index % state.config.width, Math.floor(current.index / state.config.width)];
      const [bx, by] = [neighbor % state.config.width, Math.floor(neighbor / state.config.width)];
      const stepLength = ax !== bx && ay !== by ? Math.SQRT2 : 1;
      const stepCost = existingTrack.has(neighbor)
        ? TRADE_RULES.railExistingTrackCost * stepLength
        : railTraversalCost(cell.terrain as LandTerrainId) * stepLength;
      const proposed = current.cost + stepCost;
      if (proposed >= distance[neighbor]!) continue;
      distance[neighbor] = proposed;
      previous[neighbor] = current.index;
      heap.push({ index: neighbor, cost: proposed });
    }
  }

  const reversed: number[] = [];
  for (let cursor = destination; cursor >= 0; cursor = previous[cursor]!) {
    reversed.push(cursor);
    if (cursor === source) break;
  }
  if (reversed.at(-1) !== source) return null;
  return reversed.reverse();
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
  let added = 0;

  while (added < TRADE_RULES.railMaximumNewLinksPerRebuild) {
    const sources = nodes.filter((node) => !connected.has(node.index));
    if (sources.length === 0) break;
    let best: RailEdge | null = null;

    if (connected.size === 0) {
      for (const factory of sources.filter((node) => node.kind === "factory")) {
        const destinations = nodes
          .filter((node) => node.index !== factory.index && canTrade(state, factory.owner, node.owner))
          .filter((node) => distanceBetween(state, factory.index, node.index) <= TRADE_RULES.trainRadius)
          .sort((first, second) =>
            distanceBetween(state, factory.index, first.index) - distanceBetween(state, factory.index, second.index)
          );
        for (const destination of destinations.slice(0, 5)) {
          const path = findRailPath(state, factory.index, destination.index, coverage, trackCells);
          if (!path) continue;
          const candidate = { start: factory, end: destination, distance: routeDistance(state, path), pathIndices: path };
          if (!best || candidate.distance < best.distance) best = candidate;
        }
      }
    } else {
      const networkNodes = nodes.filter((node) => connected.has(node.index));
      for (const source of sources) {
        const destinations = networkNodes
          .filter((node) => canTrade(state, source.owner, node.owner))
          .sort((first, second) =>
            distanceBetween(state, source.index, first.index) - distanceBetween(state, source.index, second.index)
          )
          .slice(0, 6);
        for (const destination of destinations) {
          const key = routeKey(source.index, destination.index);
          if (routeIds.has(key)) continue;
          const path = findRailPath(state, source.index, destination.index, coverage, trackCells);
          if (!path) continue;
          const candidate = { start: source, end: destination, distance: routeDistance(state, path), pathIndices: path };
          if (!best || candidate.distance < best.distance) best = candidate;
        }
      }
    }

    if (!best) break;
    const route = routeFromPath(state, best.start, best.end, best.pathIndices);
    if (routeIds.has(route.id)) break;
    routes.push(route);
    routeIds.add(route.id);
    connected.add(best.start.index);
    connected.add(best.end.index);
    for (const index of best.pathIndices) trackCells.add(index);
    added += 1;
  }

  return routes;
}

function routeAllowedForTrain(state: WorldState, route: TradeRoute, trainOwner: ElementId): boolean {
  const owners = new Set(
    route.pathIndices
      .map((index) => state.cells[index]!.owner)
      .filter((owner): owner is ElementId => owner !== null),
  );
  return [...owners].every((owner) => canTrade(state, trainOwner, owner));
}

function shortestRailPath(
  state: WorldState,
  routes: TradeRoute[],
  source: number,
  destination: number,
  trainOwner: ElementId,
): RailJourney | null {
  const adjacency = new Map<number, Array<{ index: number; route: TradeRoute }>>();
  for (const route of routes) {
    if (route.kind !== "rail" || !routeAllowedForTrain(state, route, trainOwner)) continue;
    adjacency.set(route.startIndex, [...(adjacency.get(route.startIndex) ?? []), { index: route.endIndex, route }]);
    adjacency.set(route.endIndex, [...(adjacency.get(route.endIndex) ?? []), { index: route.startIndex, route }]);
  }
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

function addIncome(state: WorldState, owner: ElementId, amount: number): void {
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
      .filter((owner): owner is ElementId => owner !== null),
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
  const factories = ELEMENT_ORDER.flatMap((owner) => structureCells(state, owner, "factory"))
    .filter((factory) => stations.has(factory) && dispatchReady(state, "train", factory));
  for (const source of factories) {
    if (state.tradeVehicles.filter((vehicle) => vehicle.kind === "train").length >= TRADE_RULES.trainLimit) break;
    const owner = state.cells[source]!.owner;
    if (!owner) continue;
    const pool = [...stations].filter((index) => index !== source && stationOwner(state, index) !== null);
    let journey: RailJourney | null = null;
    let destination = -1;
    while (pool.length > 0 && !journey) {
      const choice = random.int(0, pool.length - 1);
      destination = pool.splice(choice, 1)[0]!;
      journey = shortestRailPath(state, state.tradeRoutes, source, destination, owner);
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
  const harbors = ELEMENT_ORDER.flatMap((owner) => structureCells(state, owner, "harbor"));
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
