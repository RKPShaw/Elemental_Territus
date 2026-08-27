import assert from "node:assert/strict";
import test from "node:test";
import { ElementalWarEngine } from "../app/game/engine";
import { runBatchGame } from "../app/game/batch";
import { PLAYER_ORDER } from "../app/game/players";
import {
  ELEMENT_RULES,
  ENEMY_TERRAIN_COST,
  STRUCTURE_MIN_SPACING,
  STRATEGIC_REGION_RULES,
  TRADE_RULES,
  TROOP_CAP_RULES,
  WILDERNESS_TERRAIN_COST,
  cityStationMultiplier,
  nextStructureCost,
  populationGrowthEfficiency,
} from "../app/game/rules";
import { canPlaceStructureSite, cellCoordinates, distanceBetween, neighborIndices } from "../app/game/grid";
import { CommandExecutionSystem } from "../app/game/systems/commands";
import { StorySystem } from "../app/game/systems/story";
import { BATCH_SYSTEMS } from "../app/game/systems";
import { createWorld } from "../app/game/world";
import { ACTION_REPORT_KINDS } from "../app/game/reporting";
import {
  THEATER_LAYERS,
  evaluateTheaterCellMaps,
  evaluateTheaterMap,
} from "../app/game/theater-intelligence";
import { buildStrategicMetaMap } from "../app/game/regions";
import { isValidWaterPath } from "../app/game/water-navigation";
import type { SimulationContext, SimulationSystem } from "../app/game/types";

test("realms begin with 20K and a capital city on their founding site", () => {
  const state = new ElementalWarEngine(0x240823).snapshot();
  for (const faction of Object.values(state.factions)) {
    assert.equal(faction.gold, 20_000);
    assert.deepEqual(faction.structures, { city: 1, fort: 0, factory: 0, harbor: 0 });
    const capital = state.cells[faction.capitalIndex]!;
    assert.equal(capital.capitalOf, faction.id);
    assert.equal(capital.structure, "city");
    assert.equal(capital.structureLevel, 1);
  }
  assert.ok(state.cells.every((cell) =>
    cell.capitalOf !== null || (cell.structure === null && cell.structureLevel === 0)
  ));
});

test("headless batch mode preserves exact gameplay state without narrative retention", () => {
  const ordinary = new ElementalWarEngine(42).step(180);
  const headlessEngine = new ElementalWarEngine(42, BATCH_SYSTEMS, {
    retainChronicle: false,
    retainReports: false,
  });
  headlessEngine.advance(180);
  const headless = headlessEngine.snapshot();
  for (const key of [
    "cells",
    "factions",
    "relations",
    "campaigns",
    "theaters",
    "tradeRoutes",
    "tradeVehicles",
    "tradeDispatches",
    "activePressureCells",
    "champion",
    "dominantSince",
  ] as const) {
    assert.deepEqual(headless[key], ordinary[key], `${key} diverged in batch mode`);
  }
  assert.deepEqual(headless.reports, []);
  assert.deepEqual(headless.stories, []);
  assert.deepEqual(headless.chronicle, []);
});

test("batch snapshots distinguish city construction, sites, captures, and losses", () => {
  const seed = 0x240823;
  const ordinary = new ElementalWarEngine(seed).step(320);
  const result = runBatchGame(seed, { checkpointTicks: [320], maximumTicks: 320 });
  const snapshot = result.checkpoints[0]!.snapshot;
  const built = ordinary.reports.filter(
    (event) => event.kind === "infrastructure.structure-built" && event.facts.structure === "city",
  );
  const captured = ordinary.reports.filter(
    (event) => event.kind === "territory.structure-captured" && event.facts.structure === "city",
  );
  assert.equal(snapshot.citiesBuilt, built.length);
  assert.equal(snapshot.citySitesBuilt, built.filter((event) => event.facts.stacked !== true).length);
  assert.equal(
    snapshot.citiesCaptured,
    captured.reduce((total, event) => total + Number(event.facts.structureLevel ?? 1), 0),
  );
  assert.equal(snapshot.citySitesCaptured, captured.length);
  assert.equal(snapshot.citiesLost, snapshot.citiesCaptured);
});

test("structure ladders, spacing, and stacked-city capacity share one rule boundary", () => {
  const empty = { city: 0, fort: 0, factory: 0, harbor: 0 };
  assert.equal(nextStructureCost("city", empty), 25_000);
  assert.equal(nextStructureCost("city", { ...empty, city: 1 }), 50_000);
  assert.equal(nextStructureCost("city", { ...empty, city: 2 }), 100_000);
  assert.equal(nextStructureCost("city", { ...empty, city: 3 }), 250_000);
  assert.equal(nextStructureCost("harbor", { ...empty, factory: 2 }), 100_000);
  assert.equal(nextStructureCost("factory", { ...empty, factory: 2, harbor: 1 }), 250_000);
  assert.equal(TROOP_CAP_RULES.troopsPerCity, 10_000);

  const state = createWorld(7);
  const actor = state.factions["ember-1"]!;
  const cityIndex = actor.capitalIndex;
  actor.gold = 1_000_000;
  state.commands.push(
    { type: "build-structure", actor: "ember-1", structure: "city", tileIndex: cityIndex },
    { type: "build-structure", actor: "ember-1", structure: "city", tileIndex: cityIndex },
  );
  const context: SimulationContext = {
    state,
    random: { next: () => 0.5, int: (min) => min, pick: (items) => items[0]!, chance: () => false },
    emit: () => undefined,
    report: () => 1,
  };
  new CommandExecutionSystem().update(context);
  // The capital opens as a level-one city, so both commands stack onto it and
  // pay the second and third rungs of the city ladder.
  assert.equal(state.cells[cityIndex]!.structure, "city");
  assert.equal(state.cells[cityIndex]!.structureLevel, 3);
  assert.equal(actor.structures.city, 3);
  assert.equal(actor.gold, 850_000);
  assert.equal(cityStationMultiplier(2), 1.5);

  const tooClose = neighborIndices(cityIndex, state.config.width, state.config.height)
    .find((index) => state.cells[index]!.owner === "ember-1" && state.cells[index]!.terrain !== "water");
  assert.notEqual(tooClose, undefined);
  assert.ok(distanceBetween(state, cityIndex, tooClose!) < STRUCTURE_MIN_SPACING);
  assert.equal(canPlaceStructureSite(state, tooClose!), false);
});

test("capturing a capital hands the captor the defender's whole realm", () => {
  let observed = 0;
  const engine = new ElementalWarEngine(0x240823, undefined, {
    onReport: (event, state) => {
      if (event.kind !== "territory.capital-captured") return;
      observed += 1;
      const defender = event.targets[0]?.realmId;
      assert.ok(defender, "the capital-captured report names the fallen realm");
      // The annexation is immediate: by the time the report is emitted, no
      // tile anywhere still flies the defender's banner.
      assert.equal(state.factions[defender!]!.territory, 0);
      assert.ok(state.cells.every((cell) => cell.owner !== defender));
      assert.ok(Number(event.facts.annexedTiles) >= 0);
    },
  });
  engine.advance(700);
  assert.ok(observed > 0, "the calibration world should see a capital fall");
});

test("target campaigns discover theaters and conserve their commitment", () => {
  const engine = new ElementalWarEngine(0x240823);
  let state = engine.step();
  const theaterIdentity = new Map<string, string>();

  assert.equal(
    state.campaigns.filter((campaign) => campaign.target === "wilderness").length,
    PLAYER_ORDER.length,
  );
  assert.ok(state.theaters.some((theater) => theater.target === "wilderness"));

  for (let tick = state.tick; tick < 320; tick += 1) {
    state = engine.step();
    assert.ok(state.regionByCell.every((regionId, index) =>
      state.cells[index]!.terrain === "water" ? regionId === -1 : regionId >= 0
    ));
    for (const theater of state.theaters.filter((candidate) => candidate.staleRefreshes === 0)) {
      const key = `${theater.campaignId}:${theater.regionId}`;
      assert.equal(theaterIdentity.get(key) ?? theater.id, theater.id, "a geographic theater keeps its identity");
      theaterIdentity.set(key, theater.id);
      assert.ok(theater.valueHistory.length <= 12);
    }
    for (const campaign of state.campaigns) {
      const assignedTheaters = state.theaters.filter(
        (theater) => theater.campaignId === campaign.id && theater.staleRefreshes === 0 && theater.allocation > 0,
      );
      assert.ok(assignedTheaters.length <= 3, "campaigns may assign troops to at most three theaters");
      const allocated = state.theaters
        .filter((theater) => theater.campaignId === campaign.id && theater.staleRefreshes === 0)
        .reduce((total, theater) => total + theater.allocation, 0);
      // A campaign's power is simply what it still has. Defenders who blunted
      // the invasion already took their toll on remaining when they traded, so
      // subtracting them again here would be charging the same soldiers twice.
      const usable = Math.max(0, campaign.remaining);
      assert.ok(allocated <= usable * 1.001 + 1, "theaters cannot create campaign power");
    }
  }

  const claimedMountains = state.cells.filter(
    (cell) => cell.owner !== null && cell.terrain === "mountains",
  ).length;
  assert.ok(claimedMountains > 1, "accessible mountains must continue receiving settlement pressure");
});

test("the hardest wilderness remains cheaper than the easiest invasion", () => {
  assert.ok(
    Math.max(...Object.values(WILDERNESS_TERRAIN_COST)) <
      Math.min(...Object.values(ENEMY_TERRAIN_COST)),
  );
});

test("population growth has a clear 65 percent sweet spot", () => {
  const peak = populationGrowthEfficiency(0.65);
  assert.equal(peak, 1);
  assert.ok(populationGrowthEfficiency(0.19) < peak * 0.4);
  assert.ok(populationGrowthEfficiency(0.83) < peak * 0.55);
  assert.ok(populationGrowthEfficiency(0.99) < peak * 0.02);
});

test("the default world becomes mostly settled within the three-minute pace budget", () => {
  const engine = new ElementalWarEngine(0x240823);
  // Realms that open with a standing capital city settle much faster, so the
  // lowlands-first preference is only visible in the opening ticks before the
  // whole map is claimed: farmland is already saturated while half the
  // mountains still stand empty.
  let state = engine.step(15);
  const claimedShare = (terrain: string): number => {
    const cells = state.cells.filter((cell) => cell.terrain === terrain);
    return cells.filter((cell) => cell.owner !== null).length / Math.max(1, cells.length);
  };
  assert.ok(
    claimedShare("farmland") > claimedShare("mountains") * 1.5,
    "young realms should prioritize productive lowlands over mountains",
  );
  state = engine.step(165);
  const unclaimedLand = state.cells.filter(
    (cell) => cell.terrain !== "water" && cell.owner === null,
  ).length;
  assert.ok(unclaimedLand / state.landTiles <= 0.02);
});

test("the factual report is complete enough to drive consolidated stories", () => {
  const state = new ElementalWarEngine(0x240823).step(320);
  assert.equal(state.storyCursor, state.reports.length);
  assert.ok(state.reports.every((event) => event.schemaVersion === 1 && event.storyKey.length > 0));
  assert.ok(state.reports.some((event) => event.kind === "military.campaign-launched"));
  assert.ok(state.reports.some((event) => event.kind === "military.theater-formed"));
  assert.ok(state.reports.some((event) => event.kind === "infrastructure.structure-built"));
  assert.ok(state.reports.some((event) => event.kind === "trade.journey-completed"));
  assert.ok(state.stories.length < state.reports.length / 3, "stories should consolidate many facts");
  assert.ok(state.stories.some((story) => story.eventIds.length > 5));

  const actionKinds = new Set(Object.values(ACTION_REPORT_KINDS).flat());
  const actionReports = state.reports.filter((event) => actionKinds.has(event.kind as never));
  assert.ok(actionReports.length > 0);
  for (const event of actionReports) {
    const action = String(event.links.action ?? "");
    assert.ok(action in ACTION_REPORT_KINDS, `${event.kind} is missing its source action`);
    assert.equal(event.facts.actionType, action);
    assert.ok(ACTION_REPORT_KINDS[action as keyof typeof ACTION_REPORT_KINDS].includes(event.kind as never));
    assert.ok(event.initiator, `${event.kind} is missing its initiator`);
  }
});

test("each realm evaluates every strategic theater through its own priorities", () => {
  const state = new ElementalWarEngine(0x240823).step(90);
  const byRealm = PLAYER_ORDER.map((realm) => evaluateTheaterMap(state, realm));
  for (const evaluations of byRealm) {
    assert.equal(evaluations.length, state.strategicRegions.length);
    assert.ok(evaluations.every((evaluation) => evaluation.score >= 0 && evaluation.score <= 100));
  }
  assert.ok(state.strategicRegions.some((region) => {
    const scores = new Set(byRealm.map((evaluations) => evaluations[region.id]!.score));
    return scores.size >= 3;
  }), "realm geography and elemental affinity should create different theater values");
  assert.equal(TRADE_RULES.trainRadius, 5);
});

test("visible theater intelligence is continuous, layered, and realm-specific", () => {
  const state = new ElementalWarEngine(0x240823).step(90);
  const ember = evaluateTheaterCellMaps(state, "ember-1");
  const tide = evaluateTheaterCellMaps(state, "tide-1");
  for (const layer of THEATER_LAYERS) {
    assert.equal(ember[layer].length, state.cells.length);
    assert.ok(ember[layer].every((value) => value >= 0 && value <= 1));
  }
  const landValues = state.cells.flatMap((cell, index) =>
    cell.terrain === "water" ? [] : [Math.round(ember.composite[index]! * 1_000)],
  );
  assert.ok(
    new Set(landValues).size > state.strategicRegions.length * 4,
    "the visible map should expose a continuous value field, not one flat value per hidden region",
  );
  assert.ok(
    ember.composite.filter((value, index) => Math.abs(value - tide.composite[index]!) > 0.08).length > 500,
    "different realms should see materially different strategic contours",
  );
});

test("strategic geography stays connected, balanced, and migrates toward live value", () => {
  const engine = new ElementalWarEngine(0x240823);
  const initial = engine.snapshot();
  const initialAssignments = [...initial.regionByCell];
  const regionCount = initial.strategicRegions.length;
  const averageArea = initial.landTiles / regionCount;

  const assertGeography = (state: ReturnType<ElementalWarEngine["snapshot"]>) => {
    assert.equal(state.strategicRegions.length, regionCount, "stable IDs require a stable region count");
    for (const region of state.strategicRegions) {
      assert.equal(region.id, state.strategicRegions.indexOf(region));
      assert.ok(region.cells.length >= averageArea * 0.78, "region fell too far below the common area budget");
      assert.ok(region.cells.length <= averageArea * 1.22, "region exceeded the common area budget");
      const cells = new Set(region.cells);
      const visited = new Set<number>();
      const queue = region.cells.length > 0 ? [region.cells[0]!] : [];
      if (queue.length > 0) visited.add(queue[0]!);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        for (const neighbor of neighborIndices(queue[cursor]!, state.config.width, state.config.height)) {
          if (!cells.has(neighbor) || visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      assert.equal(visited.size, region.cells.length, `region ${region.id} must remain one geographic area`);
    }
  };

  assertGeography(initial);
  const state = engine.step(96);
  assertGeography(state);
  assert.ok(state.strategicRegions.every((region) => region.updatedAt === 96));
  // Capitals now open as founded cities, so the opening infrastructure map
  // already resembles the developed one and boundaries drift less than they
  // did from a bare-marker start; the mechanism still visibly migrates.
  assert.ok(
    state.regionByCell.filter((regionId, index) => regionId >= 0 && regionId !== initialAssignments[index]).length > 300,
    "filtered strategic boundaries should visibly migrate as terrain develops",
  );

  const meta = buildStrategicMetaMap(state);
  const capitalDensity = Object.values(state.factions)
    .map((faction) => meta.infrastructure[faction.capitalIndex] ?? 0);
  const ordinaryLandDensity = state.cells.flatMap((cell, index) =>
    cell.terrain !== "water" && !cell.structure && !cell.capitalOf
      ? [meta.infrastructure[index]!]
      : []
  ).sort((first, second) => first - second);
  const medianLandDensity = ordinaryLandDensity[Math.floor(ordinaryLandDensity.length / 2)] ?? 0;
  assert.ok(capitalDensity.every((value) => value > medianLandDensity * 2));
  assert.ok(meta.value.some((value, index) => value !== meta.productivity[index]));
  assert.equal(STRATEGIC_REGION_RULES.repartitionTicks, 12);
});

test("merchant ships retain contiguous water-only routes", () => {
  const engine = new ElementalWarEngine(0x240823);
  let observedShips = 0;
  for (let tick = 0; tick < 520; tick += 1) {
    const state = engine.step();
    for (const ship of state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship")) {
      observedShips += 1;
      assert.ok(isValidWaterPath(state, ship.pathIndices), `${ship.id} left its water route`);
    }
    for (const campaign of state.campaigns.filter((candidate) => candidate.mode === "naval")) {
      assert.ok(isValidWaterPath(state, campaign.pathIndices), `${campaign.id} crossed land during its voyage`);
    }
  }
  assert.ok(observedShips > 0, "the calibration world should launch merchant ships");
});

test("rail routes stay contiguous, land-only and anchored to their stations", () => {
  // Rail paths come out of a shared multi-source search, so a single wrong
  // reconstruction would hand trains a route that skips cells or crosses water.
  let observedRoutes = 0;
  for (const seed of [0x240823, 0x5eed01]) {
    const engine = new ElementalWarEngine(seed);
    let previous = 0;
    for (const tick of [200, 600, 1000]) {
      engine.advance(tick - previous);
      previous = tick;
      const state = engine.snapshot();
      const width = state.config.width;
      for (const route of state.tradeRoutes.filter((candidate) => candidate.kind === "rail")) {
        observedRoutes += 1;
        const path = route.pathIndices;
        assert.ok(path.length >= 2, `${route.id} has no travellable path`);
        assert.equal(path[0], route.startIndex, `${route.id} does not begin at its start station`);
        assert.equal(path.at(-1), route.endIndex, `${route.id} does not end at its end station`);
        assert.equal(new Set(path).size, path.length, `${route.id} revisits a cell`);
        for (let step = 1; step < path.length; step += 1) {
          const [ax, ay] = cellCoordinates(path[step - 1]!, width);
          const [bx, by] = cellCoordinates(path[step]!, width);
          assert.ok(
            Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1,
            `${route.id} jumps between ${path[step - 1]} and ${path[step]}`,
          );
        }
        for (const index of path) {
          assert.notEqual(state.cells[index]!.terrain, "water", `${route.id} lays track on water`);
        }
      }
    }
  }
  assert.ok(observedRoutes > 0, "the calibration worlds should build rail routes");
});

/**
 * A site may now run several vehicles at once -- a harbour is a place many
 * ships sail from -- so the invariant is no longer "one at a time" but "never
 * more than the berths, and never during the cooldown between launches".
 */
test("each trade building respects its berths and its launch cooldown", () => {
  const engine = new ElementalWarEngine(0x240823);
  let state = engine.snapshot();
  let previousRailIds = new Set<string>();
  for (let tick = 0; tick < 520; tick += 1) {
    state = engine.step();
    const railIds = new Set(state.tradeRoutes.map((route) => route.id));
    assert.ok([...previousRailIds].every((id) => railIds.has(id)), "physical rail must persist");
    previousRailIds = railIds;
    const activeBySource = new Map<string, number>();
    for (const vehicle of state.tradeVehicles) {
      const key = `${vehicle.kind}:${vehicle.sourceIndex}`;
      activeBySource.set(key, (activeBySource.get(key) ?? 0) + 1);
      assert.ok(
        state.tradeDispatches[key]?.activeVehicleIds.includes(vehicle.id),
        `${key} is running ${vehicle.id} without a berth recorded for it`,
      );
    }
    for (const [key, dispatch] of Object.entries(state.tradeDispatches)) {
      const berths = dispatch.kind === "train"
        ? TRADE_RULES.trainsPerFactory
        : TRADE_RULES.shipsPerHarbor
          + Math.max(0, (state.cells[dispatch.sourceIndex]?.structureLevel ?? 1) - 1)
            * TRADE_RULES.shipsPerHarborLevel;
      assert.ok(
        dispatch.activeVehicleIds.length <= berths,
        `${key} ran ${dispatch.activeVehicleIds.length} vehicles from ${berths} berths`,
      );
      assert.equal(
        dispatch.activeVehicleIds.length,
        activeBySource.get(key) ?? 0,
        `${key} recorded berths that no live vehicle occupies`,
      );
      // The longest a site may be held is a turnaround plus its own standing
      // offset in the launch cycle, which is what keeps ports from
      // re-synchronising. Anything beyond that is a stuck dispatch.
      const longestWait = TRADE_RULES.vehicleTurnaroundTicks + TRADE_RULES.launchIntervalTicks;
      if (state.tick < dispatch.readyAt) {
        assert.ok(
          dispatch.readyAt - state.tick <= longestWait,
          `${key} waits ${dispatch.readyAt - state.tick} ticks, longer than the ${longestWait} any rule allows`,
        );
      }
    }
  }

  const completed = state.reports.filter((event) => event.kind === "trade.journey-completed");
  assert.ok(completed.length > 0);
  assert.ok(state.tradeRoutes.some((route) => route.pathIndices.length > 2), "rail should follow a path, not a vector");
  const railStations = new Set(state.tradeRoutes.flatMap((route) => [route.startIndex, route.endIndex]));
  assert.ok(state.tradeRoutes.length < railStations.size, "the durable rail graph should remain sparse");
  for (const event of completed) {
    // At least the turnaround: a site that launched moments before a return
    // may already be holding a later window than the turnaround alone implies.
    assert.ok(
      Number(event.facts.nextDepartureAt) - event.tick >= TRADE_RULES.vehicleTurnaroundTicks,
    );
    if (event.facts.vehicleKind === "train") {
      const movingTicks = Number(event.facts.distance) / TRADE_RULES.trainVelocity;
      const dwellTicks = Number(event.facts.stops) * TRADE_RULES.trainStopDwellTicks;
      assert.ok(Number(event.facts.journeyTicks) + 1 >= movingTicks + dwellTicks);
    }
  }
});

test("train stops pay the fixed values, scaled by stacks and trade-form rewards", () => {
  // Adaptive theaters alter the deterministic diplomatic frontier enough that
  // this seed's first international railway matures later than its first line.
  const state = new ElementalWarEngine(0x240823).step(900);
  const stops = state.reports.filter((event) => event.kind === "trade.train-stop-served");
  const domestic = stops.find((event) => event.facts.foreign === false);
  const foreign = stops.find((event) => event.facts.foreign === true);
  assert.ok(domestic, "the calibration world should serve a domestic station");
  assert.ok(foreign, "the calibration world should serve a foreign station");
  // Trains are the energy carrier and stations the land carrier, so each
  // side's income is its base value times the station stack times its own
  // form's reward -- and only a realm holding the form ever earns it.
  const formBonus = 1 + ELEMENT_RULES.tradeFormIncomeBonus;
  for (const event of stops) {
    const multiplier = Number(event.facts.stationMultiplier);
    const ownerBonus = event.facts.energyBonus === true ? formBonus : 1;
    const hostBonus = event.facts.landBonus === true ? formBonus : 1;
    if (event.facts.foreign) {
      assert.equal(event.facts.ownerIncome, TRADE_RULES.foreignTrainStopPayout * multiplier * ownerBonus);
      assert.equal(event.facts.hostIncome, TRADE_RULES.foreignTrainStopPayout * multiplier * hostBonus);
    } else {
      assert.equal(event.facts.ownerIncome, TRADE_RULES.domesticTrainStopPayout * multiplier * ownerBonus);
      assert.equal(event.facts.hostIncome, 0);
    }
  }
  // The calibration world genuinely exercises both sides of the reward: an
  // energy realm's train earned it, and a stop at a non-energy realm's did
  // not.
  assert.ok(
    stops.some((event) => event.facts.energyBonus === true),
    "an energy realm's train should have served a stop by now",
  );
  assert.ok(
    stops.some((event) => event.facts.energyBonus === false),
    "a non-energy realm's train should have served a stop by now",
  );
  assert.equal(
    TRADE_RULES.foreignTrainStopPayout * 2,
    TRADE_RULES.domesticTrainStopPayout * 4,
  );
  assert.equal(TRADE_RULES.shipPayoutPerTravelTick, 4_000);
});

test("future feature namespaces feed the same story system", () => {
  const futureFeature: SimulationSystem = {
    id: "future-dynasty-feature",
    update(context) {
      if (context.state.reports.some((event) => event.kind === "dynasty.marriage")) return;
      context.report({
        domain: "dynasty",
        kind: "dynasty.marriage",
        importance: "major",
        storyKey: "dynasty:ember:stone:1",
        initiator: { type: "character", id: "ember-heir", label: "the Ember heir", realmId: "ember-1" },
        targets: [{ type: "character", id: "stone-heir", label: "the Stone heir", realmId: "stone-1" }],
        participants: [],
        links: { firstCharacter: "ember-heir", secondCharacter: "stone-heir" },
        facts: { politicalValue: 0.82 },
        summary: "The heirs of Ember and Stone entered a political marriage.",
      });
    },
  };
  const state = new ElementalWarEngine(7, [futureFeature, new StorySystem()]).step();
  assert.ok(state.stories.some((story) => story.kind === "dynasty"));
});
