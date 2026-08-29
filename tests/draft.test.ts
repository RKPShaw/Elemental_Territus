import test from "node:test";
import assert from "node:assert/strict";
import { draftSites } from "../app/game/draft";
import { ElementalWarEngine } from "../app/game/engine";
import { PLAYER_ORDER } from "../app/game/players";
import { SPAWN_RULES, normalizedCellLength } from "../app/game/rules";
import type { Cell, DraftWorld } from "./draft-helpers";
import { flatWorld } from "./draft-helpers";

/**
 * The settlement draft: sequential full-knowledge picks — the Catan seating
 * that opens the world and re-seats the constituents of a broken empire.
 * These tests pin determinism, the hard separation, the soft cost of
 * company, candidate confinement, and the worldgen wrapper.
 */

function distanceBetween(world: DraftWorld, first: number, second: number): number {
  const width = world.config.width;
  const ax = first % width;
  const ay = (first - ax) / width;
  const bx = second % width;
  const by = (second - bx) / width;
  return Math.hypot(ax - bx, ay - by) * normalizedCellLength(world.config);
}

test("the draft is deterministic and honors the hard separation", () => {
  const world = flatWorld(24, 12);
  const value = new Float64Array(world.cells.length).fill(0.5);
  const options = {
    value,
    affinityOf: () => new Float64Array(world.cells.length),
    valueWeight: 1,
    affinityWeight: 0.85,
    crowdingWeight: 0,
    crowdingFalloff: 4,
    separation: 3,
    separationRelaxation: 0.78,
  };
  const picks = [
    { key: "a", element: "ember" as const },
    { key: "b", element: "tide" as const },
    { key: "c", element: "stone" as const },
  ];
  const first = draftSites(world, picks, options);
  const second = draftSites(world, picks, options);
  assert.deepEqual(first, second, "the same table seats the same way twice");
  assert.equal(first.length, 3);
  for (let i = 0; i < first.length; i += 1) {
    for (let j = i + 1; j < first.length; j += 1) {
      assert.ok(
        distanceBetween(world, first[i]!.index, first[j]!.index) >= 3,
        "roomy ground must honor the hard separation",
      );
    }
  }
});

test("the cost of company pushes later picks away from earlier seats", () => {
  const world = flatWorld(30, 10);
  const value = new Float64Array(world.cells.length).fill(0.5);
  const shared = {
    value,
    affinityOf: () => new Float64Array(world.cells.length),
    valueWeight: 1,
    affinityWeight: 0.85,
    crowdingFalloff: 6,
    separation: 2,
    separationRelaxation: 0.78,
  };
  const picks = [
    { key: "a", element: "ember" as const },
    { key: "b", element: "tide" as const },
  ];
  const cosy = draftSites(world, picks, { ...shared, crowdingWeight: 0 });
  const wary = draftSites(world, picks, { ...shared, crowdingWeight: 1.5 });
  const cosyGap = distanceBetween(world, cosy[0]!.index, cosy[1]!.index);
  const waryGap = distanceBetween(world, wary[0]!.index, wary[1]!.index);
  assert.ok(
    waryGap > cosyGap,
    `crowding must widen the second seat's distance (${waryGap} vs ${cosyGap})`,
  );
  assert.ok(wary[1]!.crowding > 0, "the paid crowding cost is reported");
});

test("candidates confine the draft, and an empty table seats nobody", () => {
  const world = flatWorld(20, 10);
  const value = new Float64Array(world.cells.length).fill(0.5);
  const allowed = new Set([41, 42, 43, 44, 45, 46]);
  const options = {
    value,
    affinityOf: () => new Float64Array(world.cells.length),
    valueWeight: 1,
    affinityWeight: 0.85,
    crowdingWeight: 0.3,
    crowdingFalloff: 4,
    separation: 1,
    separationRelaxation: 0.78,
  };
  const picks = [
    { key: "a", element: "ember" as const },
    { key: "b", element: "tide" as const },
  ];
  const drafted = draftSites(world, picks, {
    ...options,
    candidate: (index: number) => allowed.has(index),
  });
  for (const site of drafted) assert.ok(allowed.has(site.index), "seats stay inside the mask");
  const nowhere = draftSites(world, picks, { ...options, candidate: () => false });
  assert.equal(nowhere.length, 0, "an empty candidate set seats nobody rather than spinning");
});

test("worldgen seats forty-eight distinct, separated capitals through the draft", () => {
  const engine = new ElementalWarEngine(0x240823);
  engine.observe((state) => {
    const capitals = PLAYER_ORDER.map((id) => state.factions[id].capitalIndex);
    assert.equal(new Set(capitals).size, PLAYER_ORDER.length, "every realm has its own capital");
    for (const capital of capitals) {
      assert.ok(capital >= 0);
      assert.notEqual(state.cells[capital]!.terrain, "water");
      assert.equal(state.cells[capital]!.structure, "city");
    }
    // The hard radius can legitimately relax on crowded coasts, but the
    // typical seat keeps its distance — the map opens as scattered villages.
    let below = 0;
    for (let i = 0; i < capitals.length; i += 1) {
      let closest = Number.POSITIVE_INFINITY;
      for (let j = 0; j < capitals.length; j += 1) {
        if (i === j) continue;
        closest = Math.min(closest, distanceBetween(state, capitals[i]!, capitals[j]!));
      }
      if (closest < SPAWN_RULES.minimumSeparation * 0.7) below += 1;
    }
    assert.ok(below <= 4, `${below} capitals sit closer than 70% of the minimum separation`);
    return null;
  });
});
