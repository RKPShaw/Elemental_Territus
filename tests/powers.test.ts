import test from "node:test";
import assert from "node:assert/strict";
import {
  BESPOKE_POWER_ELEMENTS,
  advancePowerState,
  bloomIsOverextended,
  createPowerState,
  powerAttackFactor,
  powerAttackerCasualtyFactor,
  powerDefenseFactor,
  powerGrowthFactor,
  powerPayoutFactor,
  powerSettleFactor,
  statProfileOf,
} from "../app/game/powers";
import { ELEMENT_SPACE, ELEMENTS, structurePayoutMultiplier } from "../app/game/elements";
import { POWER_RULES } from "../app/game/rules";
import type {
  Cell,
  ElementId,
  ElementPowerState,
  FactionState,
  WorldState,
} from "../app/game/types";

/**
 * The bespoke tier 3 mechanics and the bounded stat profiles behind every
 * other advanced identity. These tests pin two contracts: each mechanic's
 * strength is paired with a weakness that triggers mechanically from world
 * state, and every profile multiplier stays inside the profile band.
 */

function makeFaction(
  element: ElementId,
  overrides: Partial<FactionState> = {},
): FactionState {
  return {
    expressedElement: element,
    power: createPowerState(),
    troops: 50_000,
    troopCap: 100_000,
    gold: 1_000_000,
    capturedTiles: 0,
    structures: { city: 0, fort: 0, factory: 0, harbor: 0, plant: 0, skyport: 0 },
    ...overrides,
  } as FactionState;
}

function powersWorld(
  factions: Record<string, FactionState>,
  tick = 1_000,
): WorldState {
  return { tick, factions } as unknown as WorldState;
}

const quiet = { tick: 1_000, campaigning: false, pressed: false };
const atWar = { ...quiet, campaigning: true };
const besieged = { ...quiet, pressed: true };

test("every stat profile stays inside the band; the bespoke five have none", () => {
  for (const element of ELEMENT_SPACE) {
    const profile = statProfileOf(element);
    for (const value of Object.values(profile)) {
      assert.ok(
        value >= 1 - POWER_RULES.profileBand && value <= 1 + POWER_RULES.profileBand,
        `${element} profile value ${value} must sit inside the band`,
      );
    }
    // Only advanced identities carry a profile; the founding families and
    // compounds already have their trade forms and priority blends.
    if (ELEMENTS[element].tier < 3) {
      assert.deepEqual(profile, statProfileOf("ember"), `${element} must stay neutral`);
    }
  }
  // The bespoke five express through their mechanic, never through a profile.
  for (const element of BESPOKE_POWER_ELEMENTS) {
    assert.deepEqual(
      statProfileOf(element),
      { attack: 1, defense: 1, settle: 1, payout: 1, growth: 1 },
      `${element} must have no stat profile`,
    );
  }
  // The information trio stays deliberately neutral until its own phase.
  for (const element of ["mist", "mirage", "glass"] as const) {
    assert.deepEqual(
      statProfileOf(element),
      { attack: 1, defense: 1, settle: 1, payout: 1, growth: 1 },
      `${element} identity is an information mechanic, not a profile`,
    );
  }
});

test("geyser banks pressure, stiffens with the bank, and erupts into a war", () => {
  const faction = makeFaction("geyser");
  // The bank fills deterministically and does nothing without a war to feed.
  for (let tick = 0; tick < POWER_RULES.geyserBankTicks * 2; tick += 1) {
    assert.equal(advancePowerState(faction, { ...quiet, tick }), null);
  }
  assert.equal(faction.power.charge, 1);

  // A full bank stiffens the realm's ground by the full bank defense.
  const state = powersWorld({ "geyser-realm": faction });
  assert.equal(
    powerDefenseFactor(state, "geyser-realm"),
    1 + POWER_RULES.geyserBankDefense,
  );

  // A war while the bank is full releases it: the eruption event fires once.
  assert.equal(advancePowerState(faction, { ...atWar, tick: 1_000 }), "geyser-erupted");
  assert.equal(faction.power.charge, 0);
  assert.equal(faction.power.releasedAt, 1_000);

  // The surge drives its campaigns, and the emptied system is the weakness:
  // while venting, its ground costs less to take than anyone else's.
  const surging = powersWorld({ "geyser-realm": faction }, 1_000 + 1);
  assert.equal(powerAttackFactor(surging, "geyser-realm"), POWER_RULES.geyserSurgeAttack);
  assert.equal(powerDefenseFactor(surging, "geyser-realm"), POWER_RULES.geyserVentDefense);

  // The surge ends before the vent does; the vent ends when the window closes.
  const vented = powersWorld({ "geyser-realm": faction }, 1_000 + POWER_RULES.geyserSurgeTicks);
  assert.equal(powerAttackFactor(vented, "geyser-realm"), 1);
  assert.equal(powerDefenseFactor(vented, "geyser-realm"), POWER_RULES.geyserVentDefense);
  const refilled = powersWorld({ "geyser-realm": faction }, 1_000 + POWER_RULES.geyserVentTicks);
  assert.equal(
    powerDefenseFactor(refilled, "geyser-realm"),
    1 + POWER_RULES.geyserBankDefense * faction.power.charge,
  );
});

test("tempest gathers momentum from captures and unravels without them", () => {
  const faction = makeFaction("tempest");
  // Quiet ticks move nothing: no captures, no storm.
  advancePowerState(faction, { ...quiet, tick: 1 });
  assert.equal(faction.power.charge, 0);

  // Each fresh enemy tile feeds the storm; the crest reports exactly once.
  let event: string | null = null;
  let tick = 2;
  while (faction.power.charge < POWER_RULES.tempestCrestThreshold) {
    faction.capturedTiles += 1;
    const fired = advancePowerState(faction, { ...quiet, tick: tick += 1 });
    if (fired) {
      assert.equal(fired, "tempest-crested");
      assert.equal(event, null, "the crest must fire only once per climb");
      event = fired;
    }
  }
  assert.equal(event, "tempest-crested");

  const state = powersWorld({ storm: faction });
  assert.equal(
    powerAttackFactor(state, "storm"),
    1 + POWER_RULES.tempestMomentumAttack * faction.power.charge,
  );

  // Pinned down, the storm decays a step per tick all the way to nothing.
  const before = faction.power.charge;
  advancePowerState(faction, { ...quiet, tick: tick += 1 });
  assert.ok(Math.abs(faction.power.charge - (before - POWER_RULES.tempestDecayPerTick)) < 1e-12);
  for (let step = 0; step < 400; step += 1) {
    advancePowerState(faction, { ...quiet, tick: tick += 1 });
  }
  assert.equal(faction.power.charge, 0);
  assert.equal(powerAttackFactor(powersWorld({ storm: faction }), "storm"), 1);

  // A realm ascending to tempest starts its storm from that moment: the
  // capture bookkeeping is kept current for every realm before expression.
  const veteran = makeFaction("stone", { capturedTiles: 500 });
  advancePowerState(veteran, { ...quiet, tick: 1 });
  veteran.expressedElement = "tempest";
  advancePowerState(veteran, { ...quiet, tick: 2 });
  assert.equal(veteran.power.charge, 0, "old conquests must not pre-charge the storm");
});

test("bloom settles half again as fast until overgrowth outruns its people", () => {
  const faction = makeFaction("bloom");
  const state = powersWorld({ bloom: faction });
  assert.equal(powerSettleFactor(state, "bloom"), POWER_RULES.bloomSettleBonus);
  assert.equal(powerDefenseFactor(state, "bloom"), 1);

  // Falling under the enter ratio trips the automatic check exactly once.
  faction.troops = faction.troopCap * (POWER_RULES.bloomOverextendedEnterRatio - 0.01);
  assert.equal(advancePowerState(faction, { ...quiet, tick: 500 }), "bloom-overextended");
  assert.ok(bloomIsOverextended(faction.power));
  assert.equal(powerSettleFactor(state, "bloom"), 1);
  assert.equal(powerDefenseFactor(state, "bloom"), POWER_RULES.bloomOverextendedDefense);

  // Hovering between enter and exit must not flap the flag.
  faction.troops = faction.troopCap * (POWER_RULES.bloomOverextendedEnterRatio + 0.01);
  assert.equal(advancePowerState(faction, { ...quiet, tick: 501 }), null);
  assert.ok(bloomIsOverextended(faction.power));

  // Clear recovery re-arms the bloom.
  faction.troops = faction.troopCap * (POWER_RULES.bloomOverextendedExitRatio + 0.01);
  assert.equal(advancePowerState(faction, { ...quiet, tick: 502 }), null);
  assert.ok(!bloomIsOverextended(faction.power));
  assert.equal(powerSettleFactor(state, "bloom"), POWER_RULES.bloomSettleBonus);
});

test("plasma burns gold per structure and fails containment at a dry treasury", () => {
  const faction = makeFaction("plasma", {
    gold: 10_000,
    structures: { city: 4, fort: 2, factory: 3, harbor: 2, plant: 2, skyport: 1 },
  });
  // Forts do not pay, so forts do not burn: twelve paying structures.
  const burn = POWER_RULES.plasmaUpkeepPerStructure * 12;
  assert.equal(advancePowerState(faction, { ...quiet, tick: 100 }), null);
  assert.equal(faction.gold, 10_000 - burn);

  // The boost holds while the treasury does.
  const state = powersWorld({ sun: faction });
  assert.equal(powerPayoutFactor(state, "sun"), POWER_RULES.plasmaPayoutBoost);

  // The tick the treasury cannot cover the burn, containment fails.
  faction.gold = burn - 1;
  assert.equal(advancePowerState(faction, { ...quiet, tick: 101 }), "plasma-containment-failed");
  assert.equal(faction.gold, 0);

  // The outage pays below par and charges no burn until the window closes.
  const outage = powersWorld({ sun: faction }, 101 + 1);
  assert.equal(powerPayoutFactor(outage, "sun"), POWER_RULES.plasmaFailurePenalty);
  faction.gold = 5_000;
  assert.equal(advancePowerState(faction, { ...quiet, tick: 102 }), null);
  assert.equal(faction.gold, 5_000, "a failed containment must not keep burning");
  const recovered = powersWorld({ sun: faction }, 101 + POWER_RULES.plasmaFailureTicks);
  assert.equal(powerPayoutFactor(recovered, "sun"), POWER_RULES.plasmaPayoutBoost);
});

test("obsidian reflects attackers until sustained siege shatters the edge", () => {
  const faction = makeFaction("obsidian");
  const state = powersWorld({ knife: faction });
  assert.equal(
    powerAttackerCasualtyFactor(state, "knife"),
    POWER_RULES.obsidianReflectCasualties,
  );

  // Sustained defense accumulates fracture; a pause anneals it back down.
  let tick = 0;
  for (let step = 0; step < 100; step += 1) {
    assert.equal(advancePowerState(faction, { ...besieged, tick: tick += 1 }), null);
  }
  const pressed = faction.power.charge;
  assert.ok(pressed > 0);
  advancePowerState(faction, { ...quiet, tick: tick += 1 });
  assert.ok(faction.power.charge < pressed, "quiet ticks must anneal fracture");

  // Siege to the limit: the edge shatters, reflection fails, ground softens.
  let event: string | null = null;
  while (!event) {
    event = advancePowerState(faction, { ...besieged, tick: tick += 1 });
  }
  assert.equal(event, "obsidian-shattered");
  const shattered = powersWorld({ knife: faction }, tick + 1);
  assert.equal(powerAttackerCasualtyFactor(shattered, "knife"), 1);
  assert.equal(powerDefenseFactor(shattered, "knife"), POWER_RULES.obsidianShatterDefense);

  // The knives are ground anew once the shatter window closes.
  const reground = powersWorld({ knife: faction }, tick + POWER_RULES.obsidianShatterTicks);
  assert.equal(
    powerAttackerCasualtyFactor(reground, "knife"),
    POWER_RULES.obsidianReflectCasualties,
  );
  assert.equal(powerDefenseFactor(reground, "knife"), 1);
});

test("profile identities read through every factor and nobody else pays", () => {
  const state = powersWorld({
    ash: makeFaction("ash"),
    spirit: makeFaction("spirit"),
    crystal: makeFaction("crystal"),
    ember: makeFaction("ember"),
  });
  assert.equal(powerSettleFactor(state, "ash"), statProfileOf("ash").settle);
  assert.equal(powerDefenseFactor(state, "ash"), statProfileOf("ash").defense);
  assert.equal(powerGrowthFactor(state, "spirit"), statProfileOf("spirit").growth);
  assert.equal(powerPayoutFactor(state, "crystal"), statProfileOf("crystal").payout);
  // A founding realm reads exactly par everywhere.
  assert.equal(powerAttackFactor(state, "ember"), 1);
  assert.equal(powerDefenseFactor(state, "ember"), 1);
  assert.equal(powerSettleFactor(state, "ember"), 1);
  assert.equal(powerPayoutFactor(state, "ember"), 1);
  assert.equal(powerGrowthFactor(state, "ember"), 1);
  assert.equal(powerAttackerCasualtyFactor(state, "ember"), 1);
});

test("the plasma boost composes with heritage on the payout chokepoint", () => {
  const cell = (owner: string): Cell => ({
    owner,
    terrain: "plains",
    structure: "plant",
    structureLevel: 1,
    capitalOf: null,
    coastal: false,
    pressure: 0,
    pressureBy: null,
    pressureTracked: false,
    capturedAt: -99,
    structureHeritage: "plasma",
  });
  const state = powersWorld({
    sun: makeFaction("plasma", { absorbedElements: ["plasma"] } as Partial<FactionState>),
    stone: makeFaction("stone", { absorbedElements: ["stone"] } as Partial<FactionState>),
  });
  // A plasma realm runs its own works at the full boost over native heritage.
  assert.equal(
    structurePayoutMultiplier(state, cell("sun")),
    POWER_RULES.plasmaPayoutBoost,
  );
  // A stone captor of plasma works pays the incompatible efficiency, no boost.
  assert.ok(structurePayoutMultiplier(state, cell("stone")) < 1);
});

test("power state opens quiet and identical for every realm", () => {
  const power: ElementPowerState = createPowerState();
  assert.deepEqual(power, { charge: 0, releasedAt: -1, tally: 0 });
});
