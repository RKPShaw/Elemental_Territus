import test from "node:test";
import assert from "node:assert/strict";
import {
  ELEMENTS,
  ELEMENT_INDEX,
  ELEMENT_ORDER,
  ELEMENT_SPACE,
  FOUNDING_ELEMENTS,
  MATCHUP_TABLE,
  compositionOf,
  deriveDominantBase,
  elementMultiplier,
  matchup,
} from "../app/game/elements";
import { ELEMENT_RULES } from "../app/game/rules";
import type { ElementId, TradeForm } from "../app/game/types";

/**
 * The composed matchup table is dormant: combat still runs the founding
 * counter cycle. These tests pin the table's contract now, so the later
 * combat switch changes a consumer rather than discovering the rules.
 */

const BALANCED_TIER_THREE: readonly ElementId[] = ["mirage", "obsidian", "spirit"];

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} !== ~${expected}`);
}

test("the element space is complete, closed and self-consistent", () => {
  assert.equal(ELEMENT_SPACE.length, 25);
  assert.equal(new Set(ELEMENT_SPACE).size, 25);
  assert.deepEqual([...Object.keys(ELEMENTS)].sort(), [...ELEMENT_SPACE].sort());
  for (const element of ELEMENT_SPACE) {
    assert.equal(ELEMENTS[element].id, element);
    assert.equal(ELEMENT_SPACE[ELEMENT_INDEX[element]], element);
  }
  // The founding roster is untouched by the wider space.
  assert.deepEqual([...ELEMENT_ORDER], ["ember", "tide", "grove", "stone", "gale"]);
  const glyphs = ELEMENT_SPACE.map((element) => ELEMENTS[element].glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, "element glyphs must be distinct");
});

test("tiers, bases and trade forms follow the three-tier structure", () => {
  const byTier = { 1: 0, 2: 0, 3: 0 };
  for (const element of ELEMENT_SPACE) {
    const definition = ELEMENTS[element];
    byTier[definition.tier] += 1;
    if (definition.tier === 1) {
      assert.equal(definition.bases.length, 0);
      assert.equal(definition.tradeForms.length, 1);
    } else {
      assert.equal(definition.bases.length, 2);
      assert.equal(definition.tradeForms.length, 2);
      const expectedBaseTier = definition.tier - 1;
      for (const base of definition.bases) {
        assert.equal(
          ELEMENTS[base].tier,
          expectedBaseTier,
          `${element} must be made of tier ${expectedBaseTier} parts`,
        );
      }
    }
  }
  assert.deepEqual(byTier, { 1: 4, 2: 6, 3: 15 });
});

test("composition is an exact founding-base weighting that sums to one", () => {
  for (const element of ELEMENT_SPACE) {
    const composition = compositionOf(element);
    const total = FOUNDING_ELEMENTS.reduce((sum, base) => sum + composition[base], 0);
    assert.equal(total, 1, `${element} composition must sum to exactly one`);
  }
  for (const founding of FOUNDING_ELEMENTS) {
    assert.equal(compositionOf(founding)[founding], 1);
  }
  assert.deepEqual(compositionOf("grove"), { ember: 0, tide: 0.5, stone: 0.5, gale: 0 });
  assert.deepEqual(compositionOf("geyser"), { ember: 0.5, tide: 0.25, stone: 0.25, gale: 0 });
});

test("tier 3 dominance is derived from composition, never contradicted by data", () => {
  for (const element of ELEMENT_SPACE) {
    assert.equal(
      ELEMENTS[element].dominantBase,
      deriveDominantBase(element),
      `${element} dominantBase must match its composition`,
    );
  }
  for (const element of BALANCED_TIER_THREE) {
    assert.equal(ELEMENTS[element].dominantBase, null);
  }
});

test("trade forms are drawn from the bases an element is composed of", () => {
  const nativeForm: Record<string, TradeForm> = {
    ember: "energy",
    tide: "waterway",
    stone: "land",
    gale: "airborne",
  };
  for (const element of ELEMENT_SPACE) {
    const composition = compositionOf(element);
    const available = new Set(
      FOUNDING_ELEMENTS.filter((base) => composition[base] > 0).map((base) => nativeForm[base]),
    );
    for (const form of ELEMENTS[element].tradeForms) {
      assert.ok(available.has(form), `${element} trades ${form} without holding its base`);
    }
    assert.equal(
      new Set(ELEMENTS[element].tradeForms).size,
      ELEMENTS[element].tradeForms.length,
    );
  }
});

test("every composed multiplier stays inside the band", () => {
  for (const value of MATCHUP_TABLE) {
    assert.ok(value >= ELEMENT_RULES.matchupFloor && value <= ELEMENT_RULES.matchupCeiling);
  }
});

test("the founding sub-table reproduces the counter cycle at exactly the full edge", () => {
  const advantage = 1 + ELEMENT_RULES.matchupEdge;
  const penalty = 1 - ELEMENT_RULES.matchupEdge;
  // Full counters: tide > ember > stone > gale > tide.
  const counters: Array<[ElementId, ElementId]> = [
    ["tide", "ember"],
    ["ember", "stone"],
    ["stone", "gale"],
    ["gale", "tide"],
  ];
  for (const [winner, loser] of counters) {
    assert.equal(elementMultiplier(winner, loser), advantage);
    assert.equal(elementMultiplier(loser, winner), penalty);
  }
  // The pairs outside the cycle are neutral while neutralPairEdge stays zero.
  assert.equal(ELEMENT_RULES.neutralPairEdge, 0);
  for (const [first, second] of [["ember", "gale"], ["tide", "stone"]] as const) {
    assert.equal(elementMultiplier(first, second), 1);
    assert.equal(elementMultiplier(second, first), 1);
  }
  for (const founding of FOUNDING_ELEMENTS) {
    assert.equal(elementMultiplier(founding, founding), 1);
  }
});

test("balanced tier 3 elements compose to no edge against anything", () => {
  for (const balanced of BALANCED_TIER_THREE) {
    for (const other of ELEMENT_SPACE) {
      assert.equal(elementMultiplier(balanced, other), 1, `${balanced} vs ${other}`);
      assert.equal(elementMultiplier(other, balanced), 1, `${other} vs ${balanced}`);
    }
  }
});

test("the table is antisymmetric: an edge one way is a risk the other", () => {
  for (const attacker of ELEMENT_SPACE) {
    for (const defender of ELEMENT_SPACE) {
      const forward = elementMultiplier(attacker, defender);
      const backward = elementMultiplier(defender, attacker);
      assert.equal(
        Math.sign(forward - 1) + Math.sign(backward - 1),
        0,
        `${attacker} vs ${defender}: ${forward} / ${backward}`,
      );
    }
  }
});

test("tier amplitude grades mixed matchups without exceeding the founding edge", () => {
  // A compound meets the counter of one of its halves at half strength,
  // amplified by its tier: steam (ember+tide) into stone.
  near(elementMultiplier("steam", "stone"), 1 + 0.12 * 0.5 * 1.15, "steam vs stone");
  near(elementMultiplier("stone", "steam"), 1 - 0.12 * 0.5 * 1.15, "stone vs steam");
  // A dominant tier 3 caught by its dominant base's counter suffers more than
  // a compound would — the higher ceiling cuts both ways.
  near(elementMultiplier("geyser", "tide"), 1 - 0.12 * 0.5 * 1.25, "geyser vs tide");
  near(elementMultiplier("tide", "geyser"), 1 + 0.12 * 0.5 * 1.25, "tide vs geyser");
  // Nothing in the space swings harder than a founding counter.
  for (const value of MATCHUP_TABLE) {
    assert.ok(Math.abs(value - 1) <= ELEMENT_RULES.matchupEdge + 1e-12);
  }
});

test("the live combat rule is untouched by the dormant table", () => {
  // The founding cycle still pays exactly the legacy numbers...
  assert.equal(matchup("tide", "ember"), 1.12);
  assert.equal(matchup("ember", "tide"), 0.88);
  // ...including the legacy edges the composed cycle will later neutralize
  // (ember over gale) and reverse (stone over ember).
  assert.equal(matchup("ember", "gale"), 1.12);
  assert.equal(matchup("stone", "ember"), 1.12);
  assert.equal(matchup("ember", "stone"), 0.88);
  // The wider space cannot reach combat: no realm holds it, and even asked
  // directly the legacy rule reads it as even.
  assert.equal(matchup("steam", "ember"), 1);
  assert.equal(matchup("ember", "steam"), 1);
});
