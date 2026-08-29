import test from "node:test";
import assert from "node:assert/strict";
import {
  ascensionAppetite,
  baseDepthsOf,
  createTransmutationState,
  fusionTargetFor,
  nextFormable,
  totalRealmsAbsorbed,
} from "../app/game/ascension";
import { ELEMENTS, baseMaskOf } from "../app/game/elements";
import { ElementalWarEngine } from "../app/game/engine";
import { PLAYER_ORDER } from "../app/game/players";
import { advancePowerState, powerAttackFactor, powerGrowthFactor } from "../app/game/powers";
import { POWER_RULES, TRANSMUTATION_RULES } from "../app/game/rules";
import type { ElementId, FactionState, WorldState } from "../app/game/types";

/**
 * Ascension is the crucible of conquest: annexation is the only way elements
 * enter a realm, the moment one realm holds both constituents of a higher
 * element a transmutation window opens, and the realm emerges from the window
 * expressing the fusion. Expression only ever upgrades, eligibility climbs
 * one rung at a time, and the running world keeps every realm's window,
 * expression and base mask exactly consistent.
 */

type Counts = Partial<Record<ElementId, number>>;

function realmOf(
  expressedElement: ElementId,
  absorbedElements: ElementId[],
  elementCounts: Counts = {},
) {
  return {
    expressedElement,
    absorbedElements,
    elementCounts: elementCounts as Record<ElementId, number>,
  };
}

test("absorbed depth decomposes every element into its founding multiset", () => {
  // A founding realm is one slot of itself.
  assert.deepEqual(baseDepthsOf({ ember: 1 }), { ember: 1, tide: 0, stone: 0, gale: 0 });
  // A conquered compound feeds both its bases: steam is one ember, one tide.
  assert.deepEqual(baseDepthsOf({ steam: 1 }), { ember: 1, tide: 1, stone: 0, gale: 0 });
  // A dominant tier 3 fills four slots, its repeated base twice.
  assert.deepEqual(baseDepthsOf({ geyser: 1 }), { ember: 2, tide: 1, stone: 1, gale: 0 });
  // A balanced tier 3 touches everything once.
  assert.deepEqual(baseDepthsOf({ mirage: 1 }), { ember: 1, tide: 1, stone: 1, gale: 1 });
  // Tallies scale linearly and mix additively.
  assert.deepEqual(baseDepthsOf({ ember: 2, tide: 3, grove: 1 }), {
    ember: 2, tide: 4, stone: 1, gale: 0,
  });
  assert.equal(totalRealmsAbsorbed({ ember: 2, tide: 3, grove: 1 }), 6);
});

test("conquest-held constituents decide fusion eligibility", () => {
  // Holding only your own base fuses nothing.
  assert.equal(fusionTargetFor(realmOf("ember", ["ember"], { ember: 1 })), null);
  // One cross-family element held: the compound of the pair becomes eligible.
  assert.equal(
    fusionTargetFor(realmOf("ember", ["ember", "tide"], { ember: 1, tide: 1 })),
    "steam",
  );
  // Equal support ties break by element-space order: grove sits before steam
  // in the canon, so a conqueror of water and earth histories expresses
  // grove — Nature is earned, never given.
  assert.equal(
    fusionTargetFor(realmOf("tide", ["tide", "ember", "stone"], { tide: 2, ember: 1, stone: 1 })),
    "grove",
  );
  // Deeper support beats space order: this history leans magma's way.
  assert.equal(
    fusionTargetFor(realmOf(
      "ember",
      ["ember", "tide", "stone"],
      { magma: 2, steam: 1, tide: 1, stone: 1 },
    )),
    "magma",
  );
  // Tier 3 needs both compound constituents held as elements in their own
  // right — raw founding coverage is not enough.
  assert.equal(
    fusionTargetFor(realmOf("steam", ["ember", "tide", "steam"], { ember: 2, tide: 2 })),
    null,
  );
  assert.equal(
    fusionTargetFor(realmOf("steam", ["ember", "tide", "steam", "magma"], { ember: 2, tide: 2, magma: 1 })),
    "geyser",
  );
  // Tier 3 is the apex: nothing higher exists to fuse into.
  assert.equal(
    fusionTargetFor(realmOf("geyser", ["ember", "tide", "steam", "magma", "geyser"], { ember: 9 })),
    null,
  );
});

test("fusion climbs the ladder one rung at a time", () => {
  // A tier 1 realm that swallowed two transmuted compounds still fuses to a
  // tier 2 first — each rung pays a window of its own.
  const gorged = realmOf(
    "ember",
    ["ember", "tide", "steam", "magma", "stone"],
    { ember: 1, steam: 2, magma: 2 },
  );
  const target = fusionTargetFor(gorged);
  assert.ok(target !== null && ELEMENTS[target].tier === 2, "the first fusion is tier 2");
  // The prospect panel reads held constituents as progress.
  const prospect = nextFormable(realmOf("ember", ["ember", "tide"], { ember: 1, tide: 1 }));
  assert.ok(prospect && prospect.element === "steam" && prospect.progress === 1);
  const cold = nextFormable(realmOf("ember", ["ember"], { ember: 1 }));
  assert.ok(cold && cold.progress === 0.5, "your own base is half of any pair it joins");
  assert.equal(
    nextFormable(realmOf("geyser", ["geyser"], { ember: 9 })),
    null,
  );
});

test("ascension appetite rises exactly when a conquest advances the next tier", () => {
  const state = {
    factions: {
      // Holding ember only: tide would complete steam.
      seeker: realmOf("ember", ["ember"], { ember: 2 }),
      completes: realmOf("tide", ["tide"], { tide: 1 }),
      redundant: realmOf("ember", ["ember"], { ember: 1 }),
      apex: realmOf("geyser", ["geyser"], { ember: 4, tide: 4 }),
    },
  } as unknown as WorldState;
  assert.equal(
    ascensionAppetite(state, "seeker", "completes"),
    1,
    "a target that completes a fusion outright is worth the full pull",
  );
  assert.equal(
    ascensionAppetite(state, "seeker", "redundant"),
    0,
    "a target adding nothing to the next tier is not wanted",
  );
  assert.equal(ascensionAppetite(state, "apex", "completes"), 0, "the apex wants nothing");
});

test("a transmutation window pauses the bespoke mechanic without losing the books", () => {
  const faction = {
    expressedElement: "geyser",
    power: { charge: 0.4, releasedAt: -1, tally: 0 },
    capturedTiles: 7,
    transmutation: { target: "geyser", from: "steam", startedAt: 10, completesAt: 700, completed: 1 },
    structures: { city: 0, fort: 0, factory: 0, harbor: 0, plant: 0, skyport: 0 },
    gold: 0,
    troops: 0,
    troopCap: 1,
  } as unknown as FactionState;
  assert.equal(advancePowerState(faction, { tick: 50, campaigning: true, pressed: false }), null);
  assert.equal(faction.power.charge, 0.4, "the meter holds its breath during the fusion");
  assert.equal(faction.power.tally, 7, "capture bookkeeping stays current through the pause");
  faction.transmutation = createTransmutationState();
  advancePowerState(faction, { tick: 51, campaigning: false, pressed: false });
  assert.ok(
    Math.abs(faction.power.charge - (0.4 + 1 / POWER_RULES.geyserBankTicks)) < 1e-12,
    "an idle window lets the meter bank again",
  );
});

test("the crucible: a cross-family annexation opens a window, dulls the realm, then crowns it", () => {
  // Conquest histories assemble tens of thousands of ticks out on the slow
  // world, so the history is handed over rather than waited for: granting the
  // held element is exactly what annexing its realm leaves behind, and the
  // window, debuffs, completion and reports all run through the real systems.
  const engine = new ElementalWarEngine(0x240823);
  engine.step(200);
  engine.observe((world) => {
    const faction = world.factions["ember-1"]!;
    faction.elementCounts.tide = 1;
    if (!faction.absorbedElements.includes("tide")) faction.absorbedElements.push("tide");
  });
  let state = engine.step(1);
  const opened = state.factions["ember-1"]!;
  assert.equal(opened.transmutation.target, "steam", "the window opens the tick eligibility lands");
  assert.equal(opened.expressedElement, "ember", "expression waits for the window");
  assert.equal(
    opened.transmutation.completesAt - opened.transmutation.startedAt,
    TRANSMUTATION_RULES.tier2WindowTicks,
    "a tier 2 fusion pays the tier 2 window",
  );
  const begun = state.reports.filter((event) => event.kind === "dynasty.transmutation-begun");
  assert.ok(begun.length > 0, "entering the crucible is reported");
  assert.equal(begun[begun.length - 1]!.facts.to, "steam");
  assert.equal(begun[begun.length - 1]!.importance, "major");
  // The transition sickness is visible at the chokepoints while the window runs.
  assert.equal(powerAttackFactor(state, "ember-1"), TRANSMUTATION_RULES.attackFactor);
  assert.equal(powerGrowthFactor(state, "ember-1"), TRANSMUTATION_RULES.growthFactor);
  // Fast-forward the window rather than waiting out 720 slow-world ticks.
  engine.observe((world) => {
    world.factions["ember-1"]!.transmutation.completesAt = world.tick + 1;
  });
  state = engine.step(2);
  const crowned = state.factions["ember-1"]!;
  assert.equal(crowned.expressedElement, "steam", "the realm emerges expressing the fusion");
  assert.ok(crowned.absorbedElements.includes("steam"), "an ascended realm holds what it became");
  assert.equal(crowned.transmutation.target, null, "the window closes behind it");
  assert.equal(crowned.transmutation.completed, 1);
  assert.equal(crowned.baseMask, baseMaskOf(crowned.absorbedElements));
  const ascensions = state.reports.filter((event) => event.kind === "dynasty.element-ascended");
  assert.ok(ascensions.length > 0, "the crowning is reported");
  for (const event of ascensions) {
    assert.equal(event.domain, "dynasty");
    assert.ok(event.initiator?.realmId, "ascensions name their realm");
    const to = event.facts.to as ElementId;
    const tier = ELEMENTS[to].tier;
    assert.ok(tier >= 2, "realms ascend to compound or advanced elements");
    assert.equal(event.facts.tier, tier);
    assert.equal(event.importance, tier === 3 ? "historic" : "major");
  }
  assert.equal(powerAttackFactor(state, "ember-1"), 1, "the sickness lifts with the crown");
  assert.ok(
    state.stories.some((story) => story.kind === "dynasty"),
    "ascensions must flow into story arcs",
  );
  // Chained conquest: handing the steam realm its complementary compound
  // opens the tier 3 window immediately — the next rung, paid in full.
  engine.observe((world) => {
    const faction = world.factions["ember-1"]!;
    faction.elementCounts.magma = 1;
    if (!faction.absorbedElements.includes("magma")) faction.absorbedElements.push("magma");
  });
  state = engine.step(1);
  const chained = state.factions["ember-1"]!;
  assert.equal(chained.transmutation.target, "geyser", "compound on compound reaches tier 3");
  assert.equal(
    chained.transmutation.completesAt - chained.transmutation.startedAt,
    TRANSMUTATION_RULES.tier3WindowTicks,
    "a tier 3 fusion pays the longer window",
  );
  const historicBegun = state.reports.filter(
    (event) => event.kind === "dynasty.transmutation-begun" && event.facts.to === "geyser",
  );
  assert.equal(historicBegun[0]!.importance, "historic");
});

test("a running world keeps windows, expression, masks and held powers exactly consistent", () => {
  const engine = new ElementalWarEngine(0x240823);
  const tiers = new Map<string, number>();
  for (const gate of [400, 800, 1_200]) {
    engine.advance(gate - engine.tick);
    engine.observe((state) => {
      for (const id of PLAYER_ORDER) {
        const faction = state.factions[id];
        if (!faction.alive) continue;
        const window = faction.transmutation;
        if (window.target === null) {
          assert.equal(
            fusionTargetFor(faction),
            null,
            `${id} must not sit idle on an eligible fusion`,
          );
          assert.ok(window.startedAt === -1 && window.completesAt === -1);
        } else {
          assert.ok(
            window.startedAt >= 0 && window.completesAt > window.startedAt,
            `${id} window must be well-formed`,
          );
          assert.equal(
            ELEMENTS[window.target].tier,
            ELEMENTS[faction.expressedElement].tier + 1,
            `${id} window must aim exactly one rung up`,
          );
        }
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
