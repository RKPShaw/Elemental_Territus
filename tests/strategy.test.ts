import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import { ELEMENT_SPACE } from "../app/game/elements";
import { PLAYER_ORDER, playerElement } from "../app/game/players";
import { STRATEGY_RULES } from "../app/game/rules";
import {
  STRATEGIC_DOMAINS,
  initialStrategy,
  priorityProfileOf,
  recomputePriorities,
  strategyFactor,
} from "../app/game/strategy";
import type { StrategicDomain, StrategicPriorities } from "../app/game/types";

function weightSum(weights: Record<StrategicDomain, number>): number {
  return STRATEGIC_DOMAINS.reduce((sum, domain) => sum + weights[domain], 0);
}

test("every element has a normalized priority profile, authored or inherited", () => {
  for (const element of ELEMENT_SPACE) {
    const profile = priorityProfileOf(element);
    assert.ok(Math.abs(weightSum(profile) - 1) < 1e-9, `${element} profile must sum to one`);
    for (const domain of STRATEGIC_DOMAINS) {
      assert.ok(profile[domain] > 0, `${element} must care at least a little about ${domain}`);
    }
  }
  // A compound leans the way its parents lean: steam sits between ember's
  // conquest hunger and tide's love of trade.
  const steam = priorityProfileOf("steam");
  const ember = priorityProfileOf("ember");
  const tide = priorityProfileOf("tide");
  for (const domain of STRATEGIC_DOMAINS) {
    const blended = (ember[domain] + tide[domain]) / 2;
    assert.ok(Math.abs(steam[domain] - blended) < 1e-9, `steam ${domain} must blend its bases`);
  }
});

test("opening postures are deterministic, family-shaped and sibling-varied", () => {
  const first = initialStrategy(0x240823, "ember-1", "ember");
  const again = initialStrategy(0x240823, "ember-1", "ember");
  assert.deepEqual(first, again, "the same seed and realm must open identically");

  const sibling = initialStrategy(0x240823, "ember-2", "ember");
  assert.notDeepEqual(first.weights, sibling.weights, "siblings must differ in personality");
  assert.ok(Math.abs(weightSum(first.weights) - 1) < 1e-9);

  // Personality wobbles the weights, never the family's character.
  const emberOpenings = ["ember-1", "ember-2", "ember-3"].map(
    (id) => initialStrategy(0x240823, id, "ember").focus,
  );
  for (const focus of emberOpenings) assert.equal(focus, "conquest");
  assert.equal(initialStrategy(0x240823, "stone-1", "stone").focus, "defense");
});

test("the strategy factor is a bounded multiplier centred on the uniform share", () => {
  const uniform = {} as Record<StrategicDomain, number>;
  for (const domain of STRATEGIC_DOMAINS) uniform[domain] = 1 / STRATEGIC_DOMAINS.length;
  const neutral: StrategicPriorities = {
    weights: uniform, focus: "economy", adoptedAt: 0, reason: "test",
  };
  for (const domain of STRATEGIC_DOMAINS) {
    assert.equal(strategyFactor(neutral, domain), 1);
  }
  for (const element of ELEMENT_SPACE) {
    const strategy: StrategicPriorities = {
      weights: priorityProfileOf(element), focus: "economy", adoptedAt: 0, reason: "test",
    };
    for (const domain of STRATEGIC_DOMAINS) {
      const factor = strategyFactor(strategy, domain);
      assert.ok(factor >= STRATEGY_RULES.factorFloor && factor <= STRATEGY_RULES.factorCeiling);
    }
  }
});

test("a running world keeps priorities normalized and turns focus as fortunes change", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(220);
  engine.observe((state) => {
    for (const id of PLAYER_ORDER) {
      const strategy = state.factions[id].strategy;
      assert.ok(STRATEGIC_DOMAINS.includes(strategy.focus), `${id} focus must be a domain`);
      assert.ok(Math.abs(weightSum(strategy.weights) - 1) < 1e-9, `${id} weights must stay normalized`);
    }
    // Families read differently at a glance: the roster never collapses onto
    // one focus, because element profiles pull different ways.
    const focuses = new Set(PLAYER_ORDER.map((id) => state.factions[id].strategy.focus));
    assert.ok(focuses.size >= 2, "the roster must hold more than one strategic focus");

    const shifts = state.reports.filter((event) => event.kind === "leadership.strategy-adopted");
    assert.ok(shifts.length > 0, "situations must move at least one realm's focus");
    for (const shift of shifts) {
      assert.equal(shift.domain, "leadership");
      assert.ok(typeof shift.facts.from === "string" && typeof shift.facts.to === "string");
      assert.notEqual(shift.facts.from, shift.facts.to);
    }

    // Recomputation is pure: asking twice about the same moment agrees.
    const once = recomputePriorities(state, PLAYER_ORDER[0]!);
    const twice = recomputePriorities(state, PLAYER_ORDER[0]!);
    assert.deepEqual(once, twice);
    return null;
  });
});

test("personality is roster-stable: element and id decide it, never roster position", () => {
  // hashSeed(id) rather than roster index feeds the noise, so a future roster
  // rework cannot silently reshuffle every realm's character.
  const before = initialStrategy(7, "tide-3", playerElement("tide-3"));
  const again = initialStrategy(7, "tide-3", "tide");
  assert.deepEqual(before, again);
});
