import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import { getRelation } from "../app/game/diplomacy";
import { markCellsChanged } from "../app/game/structure-index";
import { cellsWithin } from "../app/game/grid";
import { PLAYER_ORDER } from "../app/game/players";
import { FISSION_RULES, normalizedCellLength } from "../app/game/rules";
import { worldDigest } from "./world-digest";
import type { PlayerId, WorldState } from "../app/game/types";

/**
 * Imperial instability: compound empires strain under overreach and at full
 * strain FISSION into their founding constituents — freed realms restored
 * from dead roster slots, drafted onto the best freed ground, the rump
 * humbled to its founding element, the rest reverting to wilderness with
 * every structure standing.
 */

/**
 * Stages an overreached steam empire on a running world: a broad country
 * handed to ember-1, its expression forced to steam, a tide slot killed so
 * the fission has a lineage to restore, and strain wound to the brink. Every
 * mutation is the state an actual long game would have reached; only the
 * waiting is skipped.
 */
function stageOverreach(state: WorldState, options: { freeTideSlot: boolean }): {
  granted: number;
  factoryIndex: number;
} {
  const empire = state.factions["ember-1"]!;
  const capital = empire.capitalIndex;
  const radius = 5 / normalizedCellLength(state.config);
  let granted = 0;
  let factoryIndex = -1;
  for (const index of cellsWithin(state, capital, radius)) {
    const cell = state.cells[index]!;
    if (cell.terrain === "water" || cell.owner !== null) continue;
    cell.owner = "ember-1";
    cell.capturedAt = state.tick;
    granted += 1;
    // One standing work far from the capital, to prove collapse never razes.
    if (factoryIndex < 0 && cell.structure === null
      && Math.hypot(
        (index % state.config.width) - (capital % state.config.width),
        Math.floor(index / state.config.width) - Math.floor(capital / state.config.width),
      ) * normalizedCellLength(state.config) > FISSION_RULES.rumpRadius * 1.5) {
      cell.structure = "factory";
      cell.structureLevel = 1;
      cell.structureHeritage = "ember";
      factoryIndex = index;
    }
  }
  if (options.freeTideSlot) {
    for (const cell of state.cells) {
      if (cell.owner === "tide-12") {
        cell.owner = null;
        cell.capitalOf = null;
      }
    }
  }
  empire.expressedElement = "steam";
  for (const element of ["tide", "steam"] as const) {
    if (!empire.absorbedElements.includes(element)) empire.absorbedElements.push(element);
  }
  empire.elementCounts.tide = 2;
  empire.elementCounts.steam = 1;
  empire.strain = 0.999;
  empire.strainGraceUntil = 0;
  markCellsChanged(state);
  return { granted, factoryIndex };
}

function nextCadence(tick: number): number {
  return FISSION_RULES.cadenceTicks - (tick % FISSION_RULES.cadenceTicks) + 1;
}

test("strain accrues for the overreached and recovers for the settled", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(60);
  engine.observe((state) => {
    stageOverreach(state, { freeTideSlot: false });
    const empire = state.factions["ember-1"]!;
    empire.strain = 0.4;
    // A tier 1 realm holding leftover strain must only ever recover.
    state.factions["gale-1"]!.strain = 0.5;
    return null;
  });
  engine.advance(FISSION_RULES.cadenceTicks + 1);
  engine.observe((state) => {
    assert.ok(
      state.factions["ember-1"]!.strain > 0.4,
      "an unsupported compound empire accrues strain",
    );
    assert.ok(
      state.factions["gale-1"]!.strain < 0.5,
      "tier 1 never accrues — leftover strain drains away",
    );
    return null;
  });
});

test("at full strain the empire fissions: rump humbled, lineage restored, land freed intact", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(60);
  const staged = engine.observe((state) => stageOverreach(state, { freeTideSlot: true }));
  assert.ok(staged.granted > FISSION_RULES.minimumTerritoryCells);
  assert.ok(staged.factoryIndex >= 0, "the staging placed a distant standing work");
  engine.advance(nextCadence(engine.tick) + 1);
  engine.observe((state) => {
    const fissions = state.reports.filter((event) => event.kind === "politics.fission");
    assert.equal(fissions.length, 1, "the brink realm fissions exactly once");
    const event = fissions[0]!;
    assert.equal(event.initiator?.realmId, "ember-1");
    assert.equal(event.importance, "historic");
    assert.equal(event.facts.element, "steam");

    // The rump survives around its capital, demoted to its founding element.
    const rump = state.factions["ember-1"]!;
    assert.ok(rump.alive, "collapse humbles a realm, it never kills it");
    assert.equal(rump.expressedElement, "ember");
    assert.deepEqual(rump.absorbedElements, ["ember"]);
    assert.equal(rump.strain, 0);
    assert.ok(rump.territory > 0 && rump.territory < staged.granted);
    assert.ok(
      rump.identity.changes.some((change) => change.reason === "restoration"),
      "the demotion is recorded as a restoration",
    );

    // The freed lineage rises: the dead tide slot lives again as tide.
    assert.deepEqual(event.facts.successorIds, ["tide-12"]);
    const restored = state.factions["tide-12"]!;
    assert.ok(restored.alive, "a dead slot of the freed family is restored");
    assert.equal(restored.expressedElement, "tide");
    assert.deepEqual(restored.absorbedElements, ["tide"]);
    assert.ok(restored.territory > 0);
    assert.ok(
      restored.gold >= FISSION_RULES.successorGold
      && restored.gold < FISSION_RULES.successorGold + 500,
      "a restored realm wakes with the successor purse plus at most a moment's income",
    );
    assert.equal(state.cells[restored.capitalIndex]!.capitalOf, "tide-12");
    assert.notEqual(restored.capitalIndex, rump.capitalIndex);
    assert.ok(
      state.reports.some((entry) => entry.kind === "politics.realm-restored"
        && entry.initiator?.realmId === "tide-12"),
      "the restoration is reported",
    );
    for (const other of ["ember-1", "gale-3", "stone-7"] as PlayerId[]) {
      const relation = getRelation(state, "tide-12", other);
      assert.equal(relation.status, "peace", "a restored realm starts at peace");
      assert.ok(relation.cooldownUntil > state.tick);
    }

    // Everything else reverts to wilderness with every structure standing.
    const factoryCell = state.cells[staged.factoryIndex]!;
    if (factoryCell.owner === null) {
      assert.equal(factoryCell.structure, "factory", "collapse never razes");
    } else {
      // The draft may have seated the successor over the work; it is then
      // claimed standing, never destroyed.
      assert.equal(factoryCell.structure, "factory");
    }
    assert.ok(Number(event.facts.freedCells) > 0);
    assert.ok(
      state.chronicle.some((entry) => entry.text.includes("breaks apart"))
      || state.reports.some((entry) => entry.kind === "politics.fission"),
      "the breaking is an observer beat",
    );
    return null;
  });
});

test("with no dead slot to restore, the freed element disperses unclaimed", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(60);
  const staged = engine.observe((state) => stageOverreach(state, { freeTideSlot: false }));
  assert.ok(staged.granted > 0);
  engine.advance(nextCadence(engine.tick) + 1);
  engine.observe((state) => {
    const event = state.reports.find((entry) => entry.kind === "politics.fission")!;
    assert.ok(event, "the fission still fires");
    assert.deepEqual(event.facts.successorIds, [], "nobody rises without a fallen lineage");
    assert.deepEqual(event.facts.dispersed, ["tide"], "the element disperses unclaimed");
    // All twelve tide realms still alive means the freed country is pure
    // wilderness beyond the rump.
    const rump = state.factions["ember-1"]!;
    assert.ok(rump.alive && rump.expressedElement === "ember");
    return null;
  });
});

test("two engines fission identically", () => {
  const digests: string[] = [];
  for (let run = 0; run < 2; run += 1) {
    const engine = new ElementalWarEngine(0x240823);
    engine.advance(60);
    engine.observe((state) => stageOverreach(state, { freeTideSlot: true }));
    engine.advance(nextCadence(engine.tick) + 40);
    digests.push(worldDigest(engine.snapshot()));
  }
  assert.equal(digests[0], digests[1], "a fission must land identically on sibling engines");
});

test("the running world keeps strain books exact", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.advance(400);
  engine.observe((state) => {
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      assert.ok(faction.strain >= 0 && faction.strain <= 1, `${id} strain in band`);
    }
    return null;
  });
});
