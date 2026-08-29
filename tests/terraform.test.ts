import test from "node:test";
import assert from "node:assert/strict";
import {
  TERRAFORMED_TERRAINS,
  TERRAFORM_TABLE,
  signatureTerrainsOf,
  terraformTargetAt,
  terrainAffinityFactor,
  terrainLeanOf,
} from "../app/game/terraform";
import { ELEMENT_SPACE } from "../app/game/elements";
import { ElementalWarEngine } from "../app/game/engine";
import { collectRealmAccounting } from "../app/game/systems/shared";
import { LAND_TERRAINS, TERRAFORM_RULES, TERRAIN_RULES } from "../app/game/rules";
import { worldDigest } from "./world-digest";
import type { LandTerrainId } from "../app/game/types";

/**
 * The living land: dwell transforms terrain through the owner's element and
 * the current terrain alone, so sequences (scorch, then mire) need no new
 * state; terrain affinity leans combat, income and sustain inside the
 * matchup band. These tests pin the table's integrity over the whole element
 * space, the band, and the mechanic running inside a real engine.
 */

test("the transform table is sound over the whole element space", () => {
  const reachable = new Set<LandTerrainId>();
  for (const element of ELEMENT_SPACE) {
    const rules = TERRAFORM_TABLE.get(element)!;
    for (const [from, transform] of rules) {
      assert.notEqual(from, "water", `${element} must not transform water`);
      assert.notEqual(transform.to, from, `${element} on ${from} must change something`);
      assert.ok(TERRAIN_RULES[from] && TERRAIN_RULES[transform.to], "both ends priced");
      // A threshold must clear the jitter with room, or a fresh capture
      // could transform on its first sweep.
      assert.ok(
        transform.dwellTicks > 2 * TERRAFORM_RULES.jitterTicks,
        `${element} ${from}->${transform.to} dwell ${transform.dwellTicks} sits inside the jitter`,
      );
      reachable.add(transform.to);
    }
    for (const terrain of signatureTerrainsOf(element)) {
      assert.ok(rules.size > 0 && terrain !== "water");
    }
  }
  for (const terrain of TERRAFORMED_TERRAINS) {
    assert.ok(reachable.has(terrain), `${terrain} must be reachable by someone's dwell`);
  }
});

test("sequences read straight off the current terrain", () => {
  // Ember burns the plains; what it leaves is another element's raw material.
  assert.equal(terraformTargetAt("ember", "plains")?.to, "scorched");
  // Fungus takes the burned ground and mires it — the spore-mire exists only
  // where something else ruined the land first.
  assert.equal(terraformTargetAt("fungus", "scorched")?.to, "sporemire");
  assert.equal(terraformTargetAt("fungus", "plains"), null, "fungus needs ruin to work with");
  // Obsidian hardens the same ruin the other direction.
  assert.equal(terraformTargetAt("obsidian", "scorched")?.to, "basalt");
  // Ash reverses it: ruined ground grows back richer.
  assert.equal(terraformTargetAt("ash", "scorched")?.to, "forest");
  // Water heals fire; wind strips it.
  assert.equal(terraformTargetAt("tide", "scorched")?.to, "marsh");
  assert.equal(terraformTargetAt("gale", "scorched")?.to, "duneland");
  // Ember can melt a glacier back to bare mountains — transforms can undo.
  assert.equal(terraformTargetAt("ember", "glacier")?.to, "mountains");
  // A balanced deceiver leaves no mark at all, which is also a mark.
  for (const terrain of LAND_TERRAINS) {
    assert.equal(terraformTargetAt("mirage", terrain), null);
  }
});

test("terrain affinity stays inside the band and points where the design says", () => {
  for (const element of ELEMENT_SPACE) {
    assert.equal(terrainAffinityFactor(element, "water"), 1, "water leans on nobody");
    for (const terrain of LAND_TERRAINS) {
      const factor = terrainAffinityFactor(element, terrain);
      assert.ok(
        factor >= TERRAFORM_RULES.affinityFloor && factor <= TERRAFORM_RULES.affinityCeiling,
        `${element} on ${terrain} = ${factor} escapes the band`,
      );
      const lean = terrainLeanOf(element, terrain);
      if (lean > 0) assert.ok(factor > 1);
      if (lean < 0) assert.ok(factor < 1);
    }
  }
  // The named pairings: obsidian thrives on the burned and hardened ground,
  // fungus thrives in its mires and withers on open scorch.
  assert.ok(terrainAffinityFactor("obsidian", "basalt") > 1.1);
  assert.ok(terrainAffinityFactor("obsidian", "scorched") > 1);
  assert.ok(terrainAffinityFactor("fungus", "sporemire") > 1.1);
  assert.ok(terrainAffinityFactor("fungus", "scorched") < 1);
  assert.ok(terrainAffinityFactor("ice", "glacier") > 1.1);
  assert.ok(terrainAffinityFactor("ember", "glacier") < 1);
});

test("dwell transforms fire in a running world and the books follow", () => {
  // Dwell thresholds sit thousands of ticks out on the slow world, so tenure
  // is handed over rather than waited for: pushing capturedAt deep into the
  // past is exactly what millennia of quiet ownership leave behind.
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(50);
  const before = engine.observe((state) => {
    for (const cell of state.cells) {
      if (cell.owner === "ember-1") cell.capturedAt = -10_000;
    }
    return {
      sustainable: state.factions["ember-1"]!.sustainableLand,
      plains: state.cells.filter((cell) => cell.owner === "ember-1" && cell.terrain === "plains").length,
    };
  });
  assert.ok(before.plains > 0, "the calibration realm should hold some plains");
  engine.advance(48);
  engine.observe((state) => {
    const faction = state.factions["ember-1"]!;
    const scorched = state.cells.filter(
      (cell) => cell.owner === "ember-1" && cell.terrain === "scorched",
    ).length;
    assert.ok(scorched > 0, "long-held ground must transform on the sweep");
    assert.equal(
      state.cells.filter((cell) => cell.owner === "ember-1" && cell.terrain === "plains").length,
      0,
      "every long-held plain burns",
    );
    assert.ok(faction.saturation > 0, "saturation follows the signature ground");
    assert.ok(faction.saturation <= 1);
    // Scorch sustains fewer people than the plains it replaced even with
    // ember's own lean on it, and the live accounting reads the transformed
    // ground exactly — settlement elsewhere may grow the total, so the
    // proof is arithmetic plus books, not the aggregate.
    assert.ok(
      TERRAIN_RULES.scorched.sustain * terrainAffinityFactor("ember", "scorched")
        < TERRAIN_RULES.plains.sustain * terrainAffinityFactor("ember", "plains"),
    );
    assert.ok(
      Math.abs(collectRealmAccounting(state)["ember-1"]!.sustainableLand - faction.sustainableLand) < 1e-9,
      "the same tick's accounting reads the transformed ground",
    );
    const reports = state.reports.filter((event) => event.kind === "society.land-transformed");
    assert.ok(reports.length > 0, "the sweep reports aggregate transforms");
    const latest = reports[reports.length - 1]!;
    assert.equal(latest.initiator?.realmId, "ember-1");
    assert.ok(Number(latest.facts.cells) >= scorched, "the report carries the count");
    assert.ok(
      state.chronicle.some((entry) => entry.text.includes("begin to change")),
      "a realm's first mark is an observer beat",
    );
    return null;
  });
  // The land remembers: hand the same ground to Fungus and the scorch mires.
  engine.observe((state) => {
    const faction = state.factions["ember-1"]!;
    faction.expressedElement = "fungus";
    if (!faction.absorbedElements.includes("fungus")) faction.absorbedElements.push("fungus");
    return null;
  });
  engine.advance(48);
  engine.observe((state) => {
    const mired = state.cells.filter(
      (cell) => cell.owner === "ember-1" && cell.terrain === "sporemire",
    ).length;
    assert.ok(mired > 0, "fungus dwelling on scorched earth grows its mire");
    return null;
  });
});

test("two engines transform identically", () => {
  const first = new ElementalWarEngine(0x240823);
  const second = new ElementalWarEngine(0x240823);
  for (const engine of [first, second]) {
    engine.advance(50);
    engine.observe((state) => {
      for (const cell of state.cells) {
        if (cell.owner) cell.capturedAt = -10_000;
      }
      return null;
    });
    engine.advance(100);
  }
  assert.equal(
    worldDigest(first.snapshot()),
    worldDigest(second.snapshot()),
    "a mass transform must land identically on sibling engines",
  );
});
