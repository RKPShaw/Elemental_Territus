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
 * Ascension is the element system's progression rule: conquest decides what
 * a realm can express, expression only ever upgrades, and the running world
 * keeps every realm's expression and base mask exactly what recomputing them
 * from its history would produce. The two tiers form differently: a compound
 * grows from founding depth, an advanced element only from actually uniting
 * its two compound constituents — a magma realm that claims an ice realm
 * becomes obsidian, and no founding arithmetic substitutes for the union.
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
    isFormable("steam", depthsOf(twoShort), totalRealmsAbsorbed(twoShort), ["ember"]),
    false,
  );
  assert.equal(
    isFormable("steam", depthsOf(complete), totalRealmsAbsorbed(complete), ["ember"]),
    true,
  );
  assert.equal(ELEMENT_RULES.tier2BaseDepth, 2);
  // Grove forms the same way from tide and stone — the Mossbound return as
  // something earned rather than given.
  const nature: Counts = { tide: 2, stone: 2 };
  assert.ok(isFormable("grove", depthsOf(nature), totalRealmsAbsorbed(nature), ["tide"]));
});

test("tier 3 unites two actual compounds; founding depth never substitutes", () => {
  // A history deep in ember, tide and stone covers geyser's founding
  // arithmetic completely — and still cannot form it, because the realm has
  // never actually held magma. The union of the two tier 2 elements is the
  // whole rule.
  const deep: Counts = { ember: 2, tide: 2, stone: 2 };
  assert.equal(totalRealmsAbsorbed(deep), 6);
  assert.equal(isFormable("geyser", depthsOf(deep), 6, ["ember", "steam"]), false);
  assert.ok(isFormable("geyser", depthsOf(deep), 6, ["ember", "steam", "magma"]));
  // The conquest record still gates the pace: both compounds held, one realm
  // short of the record it demands.
  assert.equal(isFormable("geyser", depthsOf(deep), 5, ["ember", "steam", "magma"]), false);
  assert.equal(ELEMENT_RULES.tier3MinimumRealms, 6);
  // The balanced trio forms the same way as everything else now: a magma
  // realm that claims an ice realm can become obsidian.
  assert.ok(isFormable("obsidian", depthsOf(deep), 6, ["ember", "magma", "ice"]));
  // Tier 2 progress is limited by the least satisfied founding requirement.
  const partial: Counts = { ember: 2, tide: 1 };
  assert.equal(formationProgress("steam", depthsOf(partial), 3, ["ember"]), 0.5);
  // Tier 3 progress counts held constituents: each compound is half the way.
  assert.equal(formationProgress("geyser", depthsOf(deep), 6, ["ember", "steam"]), 0.5);
  assert.equal(
    formationProgress("geyser", depthsOf(deep), 6, ["ember", "steam", "magma"]),
    1,
  );
});

test("expression upgrades to the best-supported formable element and never demotes", () => {
  // Not yet formable: expression stands at the founding element.
  assert.equal(
    expressionFor({
      expressedElement: "ember",
      elementCounts: { ember: 1, tide: 1 },
      absorbedElements: ["ember"],
    }),
    "ember",
  );
  // The single formable compound is taken.
  assert.equal(
    expressionFor({
      expressedElement: "ember",
      elementCounts: { ember: 2, tide: 2 },
      absorbedElements: ["ember"],
    }),
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
      absorbedElements: ["tide", "steam", "magma"],
    }),
    "grove",
  );
  // Deeper support beats space order: this history leans magma's way.
  assert.equal(
    expressionFor({
      expressedElement: "ember",
      elementCounts: { magma: 2, steam: 1, tide: 1, stone: 1 },
      absorbedElements: ["ember"],
    }),
    "magma",
  );
  // Expression never moves sideways: a magma realm with a complete steam
  // history stays magma until a higher tier forms.
  assert.equal(
    expressionFor({
      expressedElement: "magma",
      elementCounts: { ember: 2, tide: 2, stone: 1 },
      absorbedElements: ["ember", "magma"],
    }),
    "magma",
  );
  // Founding depth alone never reaches tier 3: geyser's whole arithmetic is
  // covered here, but no second compound is held, so the best compound wins.
  assert.equal(
    expressionFor({
      expressedElement: "ember",
      elementCounts: { ember: 2, tide: 2, stone: 2 },
      absorbedElements: ["ember"],
    }),
    "grove",
  );
  // Uniting two actual compounds is the tier 3 rule: a steam realm that
  // absorbed a magma civilization expresses geyser.
  assert.equal(
    expressionFor({
      expressedElement: "steam",
      elementCounts: { ember: 2, tide: 2, stone: 2 },
      absorbedElements: ["ember", "steam", "magma"],
    }),
    "geyser",
  );
  // And the balanced trio is reachable the same way: a magma realm that
  // claims an ice realm becomes obsidian, not whatever its depths lean to.
  assert.equal(
    expressionFor({
      expressedElement: "magma",
      elementCounts: { ember: 2, stone: 2, tide: 1, gale: 1 },
      absorbedElements: ["ember", "magma", "ice"],
    }),
    "obsidian",
  );
  // Tier 3 is the apex: nothing higher exists to upgrade into.
  assert.equal(
    expressionFor({
      expressedElement: "geyser",
      elementCounts: { ember: 9, gale: 9 },
      absorbedElements: ["ember", "steam", "magma", "geyser"],
    }),
    "geyser",
  );
  assert.equal(
    nextFormable({
      expressedElement: "geyser",
      elementCounts: { ember: 9 },
      absorbedElements: ["ember", "steam", "magma", "geyser"],
    }),
    null,
  );
});

test("ascension appetite rises exactly when a conquest advances the next tier", () => {
  const state = {
    factions: {
      // One tide conquest away from steam.
      seeker: {
        expressedElement: "ember",
        elementCounts: { ember: 2, tide: 1 },
        absorbedElements: ["ember"],
      },
      completes: {
        expressedElement: "tide",
        elementCounts: { tide: 1 },
        absorbedElements: ["tide"],
      },
      redundant: {
        expressedElement: "ember",
        elementCounts: { ember: 1 },
        absorbedElements: ["ember"],
      },
      apex: {
        expressedElement: "geyser",
        elementCounts: { ember: 4, tide: 4 },
        absorbedElements: ["ember", "steam", "magma", "geyser"],
      },
      // A tier 2 realm's next rung is a union of compounds, so its appetite
      // points at other ascended civilizations, not at founding depth.
      stormSeeker: {
        expressedElement: "steam",
        elementCounts: { ember: 2, tide: 2 },
        absorbedElements: ["ember", "steam"],
      },
      holdsMagma: {
        expressedElement: "magma",
        elementCounts: { ember: 2, stone: 2 },
        absorbedElements: ["ember", "magma"],
      },
      plainStone: {
        expressedElement: "stone",
        elementCounts: { stone: 3 },
        absorbedElements: ["stone"],
      },
    },
  } as unknown as WorldState;
  const completing = ascensionAppetite(state, "seeker", "completes");
  const useless = ascensionAppetite(state, "seeker", "redundant");
  assert.ok(completing > 0, "a target that completes the history is wanted");
  assert.equal(useless, 0, "a target adding nothing to the next tier is not");
  assert.equal(ascensionAppetite(state, "apex", "completes"), 0, "the apex wants nothing");
  assert.ok(
    ascensionAppetite(state, "stormSeeker", "holdsMagma") > 0,
    "a compound realm hungers for the compound it is missing",
  );
  assert.equal(
    ascensionAppetite(state, "stormSeeker", "plainStone"),
    0,
    "founding depth no longer advances an advanced element",
  );
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
  const state = new ElementalWarEngine(0x240823).step(1_200);
  const ascensions = state.reports.filter(
    (event) => event.kind === "dynasty.element-ascended",
  );
  assert.ok(
    ascensions.length > 0,
    "the calibration world should crown at least one ascension by tick 1200",
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
