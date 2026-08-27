import assert from "node:assert/strict";
import test from "node:test";
import { ElementalWarEngine } from "../app/game/engine";
import { cellDigest, worldDigest } from "./world-digest";

/**
 * Golden master for the simulation.
 *
 * The engine's contract is that a seed, a configuration and an ordered system
 * list fully determine the world. These digests pin that contract to concrete
 * values so a refactor of how the world is stored can be proven not to change
 * what the world does.
 *
 * If a change moves a digest, the change altered gameplay. Re-baselining is
 * correct only when the gameplay change was the point; it is never the way to
 * make a refactor pass.
 *
 * Re-recorded when realms gained strategic priorities: element-seeded,
 * situation-bent weights that scale war desire, alliance appetite, trade
 * policy, commitment sizing and construction quotas. Every world digest moves
 * twice over — the strategy block is new state, and realms genuinely decide
 * differently. The cell digests tell the second half: seed 0x5eed01 still
 * holds its old tick-60 map while the others have already diverged, which is
 * the proof that priorities steer decisions rather than rewriting the ground.
 *
 * Before that, re-recorded when capitals became founded cities whose capture annexes the
 * whole realm, cities began to be sited on laid track, and trains took the
 * shortest physical line over track with a quarter of the old fleet. Every
 * digest moves, and that is the point: worlds open with fifty cities standing,
 * build differently, and wars now end at the capital.
 *
 * Before that, re-recorded when sea lanes moved from breadth-first hop counting to a
 * weighted distance search: merchant ships and naval invasions now sail
 * measured, coast-rounding routes instead of L-shaped staircases, so voyage
 * lengths, payouts and landing times genuinely differ. At the 200-tick gate
 * only the world digests move while every cell digest holds, which is the
 * proof that the change redrew journeys rather than the map.
 *
 * Before that, re-recorded when wilderness settlement began reading the theater map. Cell
 * digests move here, unlike the stage before it: settlers now press hardest on
 * the ground they most want, and what they want depends on what they believe
 * about the region around it, so the world genuinely plays differently.
 *
 * Before that, re-recorded when the theater map became world state. That adds a field
 * to the world, so every world digest moves by construction -- but the cell
 * digests did not move at all, which is the proof that stage one only builds
 * beliefs and nothing yet acts on them.
 *
 * The previous baseline was re-recorded when the frontier and border indexes began
 * holding their answers for the length of a tick rather than recomputing per
 * query. That is a gameplay change and it was the point: it also stops the
 * roster order from deciding who is scored against the freshest map. It was
 * verified in isolation -- with both snapshots forced to recompute per query
 * the engine reproduced the previous baseline exactly, which is what proves
 * the rest of the optimisation pass changed nothing.
 *
 * Checkpoints are shallower than the world's age would suggest. Fifty players
 * make a tick roughly forty times more expensive than five did, so the routine
 * gate stops at 200 ticks and the 600-tick checkpoints are opt-in:
 *   DETERMINISM_DEEP=1 npm run test:determinism
 */

interface Checkpoint {
  tick: number;
  world: string;
  cells: string;
  deep?: boolean;
}

const GOLDEN: ReadonlyArray<{ seed: number; checkpoints: Checkpoint[] }> = [
  {
    seed: 0x240823,
    checkpoints: [
      { tick: 60, world: "8f7d632b31fa2469db9200a6eb77cbaa", cells: "ca9d41b9364486aa" },
      { tick: 200, world: "da41dadedab8e320582473fd78b57758", cells: "444025e9f6853b5a" },
      { tick: 600, world: "a850be7989f50a7a91ec6b6f93a86abb", cells: "b1ca890358960e6b", deep: true },
    ],
  },
  {
    seed: 0x5eed01,
    checkpoints: [
      { tick: 60, world: "67964efd15bd4229b57b9a0ade2f73eb", cells: "eccb98d23e6bfd8a" },
      { tick: 200, world: "c91e172322f9130544076cd89758beae", cells: "24eebd475535ff02" },
      { tick: 600, world: "7eae258864ea2ca06b6d69e0015b7471", cells: "e318f2defedc0861", deep: true },
    ],
  },
  {
    seed: 0xbadbeef,
    checkpoints: [
      { tick: 60, world: "ac43c8b2d0856aaece952b34d0c74b65", cells: "f9c7c9012e508f64" },
      { tick: 200, world: "35d403bc10a69550c141dc1562861076", cells: "7996941ecc836bee" },
      { tick: 600, world: "ef06c65c79d2cee2de88756a4ebed5bd", cells: "382cfd72ed781fcc", deep: true },
    ],
  },
];

const runDeep = process.env.DETERMINISM_DEEP === "1";

for (const { seed, checkpoints } of GOLDEN) {
  const selected = checkpoints.filter((checkpoint) => runDeep || !checkpoint.deep);
  const label = `0x${seed.toString(16)}`;

  test(`seed ${label} reproduces its golden world`, () => {
    const engine = new ElementalWarEngine(seed);
    let previous = 0;
    for (const checkpoint of selected) {
      engine.advance(checkpoint.tick - previous);
      previous = checkpoint.tick;
      const state = engine.snapshot();
      // The cell digest is asserted first so a map divergence is reported as a
      // map divergence rather than as an opaque whole-world mismatch.
      assert.equal(
        cellDigest(state),
        checkpoint.cells,
        `cell grid diverged at tick ${checkpoint.tick} for seed ${label}`,
      );
      assert.equal(
        worldDigest(state),
        checkpoint.world,
        `world state diverged at tick ${checkpoint.tick} for seed ${label}`,
      );
    }
  });
}

test("two engines on one seed stay identical", () => {
  // Catches nondeterminism the golden digests cannot: unordered Map/Set
  // iteration, ambient Math.random, wall-clock reads. Any of these would let a
  // single engine reproduce its own baseline while diverging from a peer.
  const first = new ElementalWarEngine(0x240823);
  const second = new ElementalWarEngine(0x240823);
  for (const step of [40, 60, 100]) {
    first.advance(step);
    second.advance(step);
    assert.equal(
      worldDigest(first.snapshot()),
      worldDigest(second.snapshot()),
      "two engines with the same seed produced different worlds",
    );
  }
});

test("distinct seeds produce distinct worlds", () => {
  // Guards against a digest that silently stops reading real state.
  const digests = GOLDEN.map(({ seed }) => {
    const engine = new ElementalWarEngine(seed);
    engine.advance(60);
    return worldDigest(engine.snapshot());
  });
  assert.equal(new Set(digests).size, digests.length, "seeds collided");
});
