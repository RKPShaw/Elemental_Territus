import test from "node:test";
import assert from "node:assert/strict";
import {
  ELEMENTS,
  ELEMENT_INDEX,
  ELEMENT_ORDER,
  ELEMENT_SPACE,
  FOUNDING_BASE_BIT,
  FOUNDING_ELEMENTS,
  MATCHUP_TABLE,
  baseMaskOf,
  buildAffinityOf,
  compositionOf,
  deriveDominantBase,
  elementMultiplier,
  realmMatchup,
  seaHostShare,
  sharedTradeForms,
  tradeFormIncomeMultiplier,
  tradesBy,
} from "../app/game/elements";
import { ELEMENT_RULES, TRADE_RULES } from "../app/game/rules";
import type { ElementId, TradeForm, WorldState } from "../app/game/types";

/**
 * The composed matchup table is the live combat rule, read per realm through
 * its expressed element with graded relief for the founding bases its
 * absorbed history covers. These tests pin both the table's contract and the
 * relief arithmetic.
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
  // Four founding families seat the roster; grove is acquirable, not seatable.
  assert.deepEqual([...ELEMENT_ORDER], ["ember", "tide", "stone", "gale"]);
  assert.ok(!ELEMENT_ORDER.includes("grove"));
  assert.equal(ELEMENTS.grove.tier, 2);
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

/** A world reduced to what realmMatchup reads: expression and history. */
function matchupWorld(
  factions: Record<string, { expressedElement: ElementId; held: ElementId[] }>,
): WorldState {
  return {
    factions: Object.fromEntries(
      Object.entries(factions).map(([id, { expressedElement, held }]) => [
        id,
        { expressedElement, baseMask: baseMaskOf(held) },
      ]),
    ),
  } as unknown as WorldState;
}

test("realm matchups read expressed elements and pay the composed edge", () => {
  const state = matchupWorld({
    "ember-1": { expressedElement: "ember", held: ["ember"] },
    "stone-1": { expressedElement: "stone", held: ["stone"] },
    "gale-1": { expressedElement: "gale", held: ["gale"] },
    "steam-realm": { expressedElement: "steam", held: ["ember", "tide", "steam"] },
  });
  // The document's cycle is live: ember now counters stone — the flip from
  // the legacy rule, where stone beat ember — at exactly the founding edge.
  assert.equal(realmMatchup(state, "ember-1", "stone-1"), 1.12);
  assert.equal(realmMatchup(state, "stone-1", "ember-1"), 0.88);
  // Ember–gale sits outside the cycle now: neutral, where it was an edge.
  assert.equal(realmMatchup(state, "ember-1", "gale-1"), 1);
  // Expression decides the matchup: a steam realm meets stone at the graded
  // compound edge, not at its founding family's full counter.
  assert.equal(
    realmMatchup(state, "steam-realm", "stone-1"),
    elementMultiplier("steam", "stone"),
  );
});

test("absorbed history grades an edge down by at most a third, never away", () => {
  const relief = ELEMENT_RULES.absorbedBaseRelief;
  const state = matchupWorld({
    attacker: { expressedElement: "ember", held: ["ember"] },
    bare: { expressedElement: "stone", held: ["stone"] },
    covered: { expressedElement: "stone", held: ["stone", "ember"] },
    saturated: { expressedElement: "stone", held: ["ember", "tide", "stone", "gale"] },
  });
  const fullEdge = realmMatchup(state, "attacker", "bare");
  assert.equal(fullEdge, 1 + ELEMENT_RULES.matchupEdge);
  // Holding the attacker's whole base grades the edge by exactly the relief
  // share; holding everything grades it no further — the old total-immunity
  // saturation is gone.
  const graded = realmMatchup(state, "attacker", "covered");
  assert.ok(Math.abs(graded - (1 + ELEMENT_RULES.matchupEdge * (1 - relief))) < 1e-12);
  assert.equal(realmMatchup(state, "attacker", "saturated"), graded);
  assert.ok(graded > 1, "history softens an edge, it never erases one");
  // Relief is symmetric: the covered realm attacking uphill suffers the same
  // graded risk its defense enjoys, so the pair stays antisymmetric.
  const uphill = realmMatchup(state, "covered", "attacker");
  assert.ok(Math.abs(uphill - (1 - ELEMENT_RULES.matchupEdge * (1 - relief))) < 1e-12);
  // Coverage weights the advantaged side's composition: against a steam
  // edge, a defender whose history knows ember but not tide relieves only
  // the ember half of it.
  const halfState = matchupWorld({
    steamAttacker: { expressedElement: "steam", held: ["ember", "tide", "steam"] },
    halfCovered: { expressedElement: "stone", held: ["stone", "ember"] },
  });
  const steamEdge = elementMultiplier("steam", "stone") - 1;
  assert.ok(steamEdge > 0, "steam carries an edge into stone");
  const halfGraded = realmMatchup(halfState, "steamAttacker", "halfCovered");
  assert.ok(Math.abs(halfGraded - (1 + steamEdge * (1 - relief * 0.5))) < 1e-12);
});

test("base masks cover exactly the founding composition of what is held", () => {
  assert.equal(baseMaskOf(["ember"]), FOUNDING_BASE_BIT.ember);
  assert.equal(baseMaskOf(["grove"]), FOUNDING_BASE_BIT.tide | FOUNDING_BASE_BIT.stone);
  assert.equal(
    baseMaskOf(["steam", "sand"]),
    FOUNDING_BASE_BIT.ember | FOUNDING_BASE_BIT.tide | FOUNDING_BASE_BIT.stone | FOUNDING_BASE_BIT.gale,
  );
  assert.equal(baseMaskOf([]), 0);
});

test("trade-form income rides only the carriers a realm actually holds", () => {
  const bonus = 1 + ELEMENT_RULES.tradeFormIncomeBonus;
  // Each founding family earns its own carrier's reward and nobody else's.
  assert.equal(tradeFormIncomeMultiplier("ember", "energy"), bonus);
  assert.equal(tradeFormIncomeMultiplier("tide", "waterway"), bonus);
  assert.equal(tradeFormIncomeMultiplier("stone", "land"), bonus);
  assert.equal(tradeFormIncomeMultiplier("ember", "waterway"), 1);
  assert.equal(tradeFormIncomeMultiplier("stone", "energy"), 1);
  // Airborne has no carrier, so gale's form pays nothing anywhere yet.
  assert.ok(tradesBy("gale", "airborne"));
  for (const form of ["energy", "waterway", "land"] as const) {
    assert.equal(tradeFormIncomeMultiplier("gale", form), 1);
  }
  // Compounds trade both parents' ways: steam ships and trains both earn.
  assert.equal(tradeFormIncomeMultiplier("steam", "energy"), bonus);
  assert.equal(tradeFormIncomeMultiplier("steam", "waterway"), bonus);
  // Rewards only: no multiplier anywhere in the space sits below 1.
  for (const element of ELEMENT_SPACE) {
    for (const form of ["energy", "waterway", "land", "airborne"] as const) {
      assert.ok(tradeFormIncomeMultiplier(element, form) >= 1);
    }
  }
});

test("resonance counts shared forms symmetrically", () => {
  assert.equal(sharedTradeForms("ember", "stone"), 0);
  assert.equal(sharedTradeForms("tide", "steam"), 1);
  assert.equal(sharedTradeForms("steam", "geyser"), 2);
  for (const first of ELEMENT_SPACE) {
    for (const second of ELEMENT_SPACE) {
      assert.equal(
        sharedTradeForms(first, second),
        sharedTradeForms(second, first),
        `${first}/${second} resonance must be symmetric`,
      );
    }
  }
});

test("sea host shares: resonance beats a stranger, alliance still pays best", () => {
  assert.equal(seaHostShare(0, false), TRADE_RULES.foreignHostShare);
  assert.equal(seaHostShare(1, false), ELEMENT_RULES.resonantHostShareOne);
  assert.equal(seaHostShare(2, false), ELEMENT_RULES.resonantHostShareTwo);
  // Allied standing outbids every resonance level.
  for (const shared of [0, 1, 2]) {
    assert.equal(seaHostShare(shared, true), TRADE_RULES.alliedHostShare);
  }
  // The rate ladder is strictly ordered, so each step genuinely rewards.
  assert.ok(TRADE_RULES.foreignHostShare < ELEMENT_RULES.resonantHostShareOne);
  assert.ok(ELEMENT_RULES.resonantHostShareOne < ELEMENT_RULES.resonantHostShareTwo);
  assert.ok(ELEMENT_RULES.resonantHostShareTwo < TRADE_RULES.alliedHostShare);
});

test("construction affinity leans a realm toward the carriers it holds", () => {
  // A waterway realm reaches for harbors hardest and wants the raised share.
  assert.deepEqual(buildAffinityOf("tide"), {
    city: 1,
    trade: ELEMENT_RULES.buildAffinity.harbor,
    harborShare: ELEMENT_RULES.waterwayHarborTradeShare,
    harborCap: ELEMENT_RULES.waterwayHarborTradeCap,
  });
  // An energy realm reaches for factories at the gentler factory lean.
  assert.deepEqual(buildAffinityOf("ember"), {
    city: 1,
    trade: ELEMENT_RULES.buildAffinity.factory,
    harborShare: ELEMENT_RULES.harborTradeShare,
    harborCap: ELEMENT_RULES.harborTradeCap,
  });
  // A land realm lets rail-laying trade buildings jump its city queue.
  assert.deepEqual(buildAffinityOf("stone"), {
    city: ELEMENT_RULES.buildAffinity.city,
    trade: 1,
    harborShare: ELEMENT_RULES.harborTradeShare,
    harborCap: ELEMENT_RULES.harborTradeCap,
  });
  // Airborne has no carrier: gale's program is exactly the neutral one.
  assert.deepEqual(buildAffinityOf("gale"), {
    city: 1, trade: 1,
    harborShare: ELEMENT_RULES.harborTradeShare,
    harborCap: ELEMENT_RULES.harborTradeCap,
  });
  // A compound holding both trade carriers takes the stronger lean, and the
  // raised harbor share follows the waterway form wherever it appears.
  assert.equal(buildAffinityOf("steam").trade, ELEMENT_RULES.buildAffinity.harbor);
  assert.equal(buildAffinityOf("steam").harborShare, ELEMENT_RULES.waterwayHarborTradeShare);
  assert.equal(buildAffinityOf("magma").trade, ELEMENT_RULES.buildAffinity.factory);
  assert.equal(buildAffinityOf("magma").city, ELEMENT_RULES.buildAffinity.city);
  assert.equal(buildAffinityOf("grove").trade, ELEMENT_RULES.buildAffinity.harbor);
  assert.equal(buildAffinityOf("grove").city, ELEMENT_RULES.buildAffinity.city);
});
