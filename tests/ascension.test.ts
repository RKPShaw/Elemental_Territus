import test from "node:test";
import assert from "node:assert/strict";
import {
  ascensionAppetite,
  baseDepthsOf,
  expressionFor,
  formationProgress,
  isFormable,
  nextFormable,
  totalRealmsAbsorbed,
} from "../app/game/ascension";
import { ELEMENTS, baseMaskOf } from "../app/game/elements";
import { ElementalWarEngine } from "../app/game/engine";
import { PLAYER_ORDER } from "../app/game/players";
import { ELEMENT_RULES } from "../app/game/rules";
import type { ElementId, WorldState } from "../app/game/types";

/**
 * Ascension is the element system's progression rule: conquest tallies alone
 * decide what a realm can express, expression only ever upgrades, and the
 * running world keeps every realm's expression and base mask exactly what
 * recomputing them from its history would produce.
 */

type Counts = Partial<Record<ElementId, number>>;

function depthsOf(counts: Counts) {
  return baseDepthsOf(counts);
}

test("absorbed depth decomposes every element into its founding multiset", () => {
  // A founding realm is one slot of itself.
  assert.deepEqual(depthsOf({ ember: 1 }), { ember: 1, tide: 0, stone: 0, gale: 0 });
  // A conquered compound feeds both its bases: steam is one ember, one tide.
  assert.deepEqual(depthsOf({ steam: 1 }), { ember: 1, tide: 1, stone: 0, gale: 0 });
  // A dominant tier 3 fills four slots, its repeated base twice.
  assert.deepEqual(depthsOf({ geyser: 1 }), { ember: 2, tide: 1, stone: 1, gale: 0 });
  // A balanced tier 3 touches everything once.
  assert.deepEqual(depthsOf({ mirage: 1 }), { ember: 1, tide: 1, stone: 1, gale: 1 });
  // Tallies scale linearly and mix additively.
  assert.deepEqual(depthsOf({ ember: 2, tide: 3, grove: 1 }), {
    ember: 2, tide: 4, stone: 1, gale: 0,
  });
});

test("tier 2 takes roughly three conquests with the right spread", () => {
  // An ember realm's own founding stock counts one; two tide conquests and a
  // second ember complete steam's requirement of depth two in each base.
  const twoShort: Counts = { ember: 1, tide: 1 };
  const complete: Counts = { ember: 2, tide: 2 };
  assert.equal(
    isFormable("steam", depthsOf(twoShort), totalRealmsAbsorbed(twoShort)),
    false,
  );
  assert.equal(
    isFormable("steam", depthsOf(complete), totalRealmsAbsorbed(complete)),
    true,
  );
  assert.equal(ELEMENT_RULES.tier2BaseDepth, 2);
  // Grove forms the same way from tide and stone — the Mossbound return as
  // something earned rather than given.
  const nature: Counts = { tide: 2, stone: 2 };
  assert.ok(isFormable("grove", depthsOf(nature), totalRealmsAbsorbed(nature)));
});

test("tier 3 needs both constituents formable and a long conquest record", () => {
  // Geyser is steam + magma: ember 2, tide 2, stone 2 covers both compounds,
  // but five realms absorbed is one short of the record it demands.
  const deep: Counts = { ember: 2, tide: 2, stone: 2 };
  assert.equal(totalRealmsAbsorbed(deep), 6);
  assert.ok(isFormable("geyser", depthsOf(deep), 6));
  assert.equal(isFormable("geyser", depthsOf(deep), 5), false);
  assert.equal(ELEMENT_RULES.tier3MinimumRealms, 6);
  // Progress is limited by the least satisfied requirement.
  const partial: Counts = { ember: 2, tide: 1 };
  assert.equal(formationProgress("steam", depthsOf(partial), 3), 0.5);
});

test("expression upgrades to the best-supported formable element and never demotes", () => {
  // Not yet formable: expression stands at the founding element.
  assert.equal(
    expressionFor({ expressedElement: "ember", elementCounts: { ember: 1, tide: 1 } }),
    "ember",
  );
  // The single formable compound is taken.
  assert.equal(
    expressionFor({ expressedElement: "ember", elementCounts: { ember: 2, tide: 2 } }),
    "steam",
  );
  // Absorbing ascended civilizations feeds every base they carried. Steam,
  // magma and grove are all formable here with equal support, and the
  // element-space order settles the tie — a conqueror of water and earth
  // histories expresses grove: Nature is earned, never given.
  assert.equal(
    expressionFor({
      expressedElement: "tide",
      elementCounts: { steam: 1, magma: 1, tide: 1, stone: 1 },
    }),
    "grove",
  );
  // Deeper support beats space order: this history leans magma's way.
  assert.equal(
    expressionFor({
      expressedElement: "ember",
      elementCounts: { magma: 2, steam: 1, tide: 1, stone: 1 },
    }),
    "magma",
  );
  // Expression never moves sideways: a magma realm with a complete steam
  // history stays magma until a higher tier forms.
  assert.equal(
    expressionFor({
      expressedElement: "magma",
      elementCounts: { ember: 2, tide: 2, stone: 1 },
    }),
    "magma",
  );
  // A history deep enough for tier 3 expresses it directly.
  assert.equal(
    expressionFor({
      expressedElement: "ember",
      elementCounts: { ember: 2, tide: 2, stone: 2 },
    }),
    "geyser",
  );
  // Tier 3 is the apex: nothing higher exists to upgrade into.
  assert.equal(
    expressionFor({ expressedElement: "geyser", elementCounts: { ember: 9, gale: 9 } }),
    "geyser",
  );
  assert.equal(
    nextFormable({ expressedElement: "geyser", elementCounts: { ember: 9 } }),
    null,
  );
});

test("ascension appetite rises exactly when a conquest advances the next tier", () => {
  const state = {
    factions: {
      // One tide conquest away from steam.
      seeker: { expressedElement: "ember", elementCounts: { ember: 2, tide: 1 } },
      completes: { expressedElement: "tide", elementCounts: { tide: 1 } },
      redundant: { expressedElement: "ember", elementCounts: { ember: 1 } },
      apex: { expressedElement: "geyser", elementCounts: { ember: 4, tide: 4 } },
    },
  } as unknown as WorldState;
  const completing = ascensionAppetite(state, "seeker", "completes");
  const useless = ascensionAppetite(state, "seeker", "redundant");
  assert.ok(completing > 0, "a target that completes the history is wanted");
  assert.equal(useless, 0, "a target adding nothing to the next tier is not");
  assert.equal(ascensionAppetite(state, "apex", "completes"), 0, "the apex wants nothing");
});

test("a running world keeps expression, masks and held powers exactly consistent", () => {
  const engine = new ElementalWarEngine(0x240823);
  const tiers = new Map<string, number>();
  for (const gate of [400, 800, 1_200]) {
    engine.advance(gate - engine.tick);
    engine.observe((state) => {
      for (const id of PLAYER_ORDER) {
        const faction = state.factions[id];
        if (!faction.alive) continue;
        assert.equal(
          faction.expressedElement,
          expressionFor(faction),
          `${id} must express exactly what its history makes formable`,
        );
        assert.equal(
          faction.baseMask,
          baseMaskOf(faction.absorbedElements),
          `${id} base mask must cover exactly what it holds`,
        );
        assert.ok(
          faction.absorbedElements.includes(faction.expressedElement),
          `${id} must hold the element it expresses`,
        );
        const tier = ELEMENTS[faction.expressedElement].tier;
        assert.ok(
          tier >= (tiers.get(id) ?? 1),
          `${id} expression tier must never demote`,
        );
        tiers.set(id, tier);
      }
      return null;
    });
  }
});

test("conquest histories produce ascensions and report them as dynasty facts", () => {
  // This horizon kept following the pace out. Funded mobilization moved the
  // first ascension a couple of hundred ticks (~1420 on this seed); the slow
  // opening economy moved it past what the test could afford and staking war
  // chests bought it back. The pacing retune moves it again and much further,
  // and no stake buys it back this time: what conquest is short of now is
  // people, not gold. Population grows at a sixth of the old rate, so a war
  // of attrition takes about six times as long to end a realm, and the four
  // conquests a tier 2 needs assemble tens of thousands of ticks out.
  //
  // So the history is handed over rather than waited for. Ascension reads a
  // realm's conquest tallies and nothing else (see expressionFor), so a realm
  // given the tallies four conquests would have left it ascends through the
  // real system on a real running world and reports exactly what a besieger's
  // would. What this test is about — that an ascension happens and that it is
  // reported as a well-formed dynasty fact — is unchanged; only the waiting
  // is gone.
  const engine = new ElementalWarEngine(0x240823);
  engine.step(200);
  engine.observe((world) => {
    const faction = world.factions["ember-1"]!;
    // Depth two in both of steam's founding bases: its own ember stock, a
    // second ember, and two tides.
    faction.elementCounts.ember = 2;
    faction.elementCounts.tide = 2;
    for (const element of ["ember", "tide"] as const) {
      if (!faction.absorbedElements.includes(element)) faction.absorbedElements.push(element);
    }
  });
  // Two ticks: one for the ascension system to crown it, one for the story
  // correlator to pick the report up.
  const state = engine.step(2);
  const ascensions = state.reports.filter(
    (event) => event.kind === "dynasty.element-ascended",
  );
  assert.ok(
    ascensions.length > 0,
    "the calibration world should crown at least one ascension by tick 1500",
  );
  for (const event of ascensions) {
    assert.equal(event.domain, "dynasty");
    assert.ok(event.initiator?.realmId, "ascensions name their realm");
    const to = event.facts.to as ElementId;
    const tier = ELEMENTS[to].tier;
    assert.ok(tier >= 2, "realms ascend to compound or advanced elements");
    assert.equal(event.facts.tier, tier);
    assert.equal(event.importance, tier === 3 ? "historic" : "major");
    const realm = state.factions[event.initiator!.realmId!];
    assert.ok(
      realm.absorbedElements.includes(to) || !realm.alive,
      "an ascended realm holds what it became",
    );
  }
  // The chronicle carries the arrival too — ascension is an observer beat.
  assert.ok(
    state.stories.some((story) => story.kind === "dynasty"),
    "ascensions must flow into story arcs",
  );
});
