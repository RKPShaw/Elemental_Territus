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
 * Re-recorded when legibility rebuilt the story surfacing. The consolidated
 * story arcs are part of the world's memory — the digest hashes their
 * headlines and summaries — and the correlator now tells the arcs the element
 * system created: ascension arcs read the climb ("rises to Steam") instead of
 * a bare "ascends", the bespoke mechanics' arcs count their eruptions,
 * crests and shatterings instead of borrowing the marriage headline, and a
 * court's strategy turns consolidate as a leadership arc (a new story kind)
 * rather than an unlabelled "world" story. No report event, chronicle line or
 * simulation rule changed — narration is downstream of the facts by
 * architecture — so every world digest moves with the retold stories while
 * every cell digest holds at every checkpoint: the proof that this phase
 * changed the telling, never the tale.
 *
 * Before that, re-recorded when the information identities landed on the belief layer.
 * Swift sight is the mover: glass and every realm whose expressed element
 * trades by air now observe twice per observation interval, so the twelve
 * gale realms' belief stores differ from the first interval — wrapped second
 * slots fire inside the opening eighty ticks — and settlers steer by what
 * they believe, so the cell digests move with the world digests from the
 * tick-60 checkpoint on. The mist veil (rivals' measurements of the
 * Veilfolk's plurality regions blend toward what the rival already believed,
 * pierced by a real foothold or a front) and the mirage distortion (rivals
 * read the prize and openness of the Falselights' plurality regions at 0.6
 * of what their stores hold, collapsing for any viewer whose sight group has
 * two members with contact on the region) are also live, but no realm
 * expresses either inside 600 ticks, so their contribution to these digests
 * is provably nothing: the mechanics wait, dormant, for a tier 3 ascension —
 * new behavior at the observation boundary, and only the boundary.
 *
 * Before that, re-recorded when the advanced elements gained their powers. Every faction now
 * carries a power meter (FactionState.power — new state, so every world
 * digest moves by construction) behind five bespoke tier 3 mechanics: geyser
 * banks pressure and erupts into its wars, tempest gathers conquest momentum
 * that decays when pinned down, bloom settles half again as fast until
 * overextension checks it, plasma multiplies its payouts against a gold burn
 * that can fail containment, and obsidian reflects attacker casualties until
 * sustained siege shatters the edge; the rest of the tier 3 space leans
 * through bounded stat profiles at the same chokepoints. At every recorded
 * checkpoint the cell digests did not move at all, which is the proof the
 * phase wants: no realm reaches tier 3 inside 600 ticks, so the new
 * mechanics are provably dormant until an advanced element actually walks
 * the world — new state, unchanged play.
 *
 * Before that, re-recorded when infrastructure gained memory. Every structure now carries
 * its builder's expressed element (structureHeritage — a new cell field, so
 * every digest moves by construction) and pays its current owner by how well
 * that owner's history covers the heritage's trade forms: native works pay
 * in full, legacy history pays 0.9, an incompatible network 0.78, and a
 * native captor pulls a resonant premium from freshly taken works while the
 * conquest is fresh. Theaters weigh heritage-matching enemy structures
 * higher, so wars now march for the networks their victors can run — city
 * income, every carrier's payouts and campaign priorities all genuinely
 * differ, and the map diverges with them.
 *
 * Before that, re-recorded when every trade form gained a carrier of its own. Land keeps
 * the road-and-rail network — its vehicles are convoys now, and the land
 * form's reward rides them; the waterway keeps its ships; energy realms
 * raise power plants that string straight conduits and pulse flat-value
 * deliveries down them; airborne realms raise skyports and fly freight
 * point to point over anything. Two new structures enter the shared trade
 * ladder and the exclusive carriers gate on the expressed form, so
 * construction programs, treasuries and the map itself all diverge from the
 * first planning window — every digest moves, and gale finally trades.
 * Tuned after the first hundred-game sweep of the carriers: air freight now
 * pays slightly under sea freight per travel tick (gale had taken nearly
 * half of all wins on flight income alone), and waterway realms open their
 * first harbor a factory earlier, because tide's coastal identity kept
 * arriving after its wars did.
 *
 * Before that, re-recorded when trade forms first went live riding the then-existing
 * carriers: trains earned the energy reward, stations the land reward, ships
 * the waterway reward, sea hosting paid a resonant share between realms
 * whose expressed elements trade the same ways, and construction leaned
 * toward the carriers a realm holds.
 *
 * Before that, re-recorded for the four-family roster and the live element system. The
 * founding roster reworked to twelve players in each of four families — grove
 * retired to an acquirable compound — so every draft, and with it every
 * world, differs from the first tick by construction. On top of that the
 * composed matchup table went live through each realm's expressed element
 * with absorbed-history relief (flipping the ember–stone counter and
 * neutralizing ember–gale and tide–stone), the ascension system began
 * awarding tier 2 and 3 expression from conquest tallies, war targeting
 * learned to hunt formability, and the opening partition's relaxation gain
 * rose so the smallest region opens inside its area budget under the new
 * capital draft. Cell digests and world digests both move everywhere, and
 * that is the point: this is the phase where the element space stops being
 * dormant.
 *
 * Before that, re-recorded when realms gained strategic priorities: element-seeded,
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
      { tick: 60, world: "edf4b568b2e4828ce110b8f8e3849321", cells: "0cc88d49fe150097" },
      { tick: 200, world: "814104efc5f114120ba59b27cd7dc49d", cells: "2a604bb4cdfc71c6" },
      { tick: 600, world: "c3383f8adfa1bde96ee83454d02083e5", cells: "eb00cfb195bc449d", deep: true },
    ],
  },
  {
    seed: 0x5eed01,
    checkpoints: [
      { tick: 60, world: "6d6473bc9fda13996f9c822bb89572f8", cells: "3430cfdf82dfeb8d" },
      { tick: 200, world: "50b823a3b12de983de294d530d11065d", cells: "e99f4f00ed1cd703" },
      { tick: 600, world: "f6135b2a90384b3e2de0ed14391727a9", cells: "7e4e8aeacaa49108", deep: true },
    ],
  },
  {
    seed: 0xbadbeef,
    checkpoints: [
      { tick: 60, world: "a656588e3453cd543a5179e35ed55315", cells: "e71029ca38e2ca6b" },
      { tick: 200, world: "4e678da9defa6a601a96ed78bde3769f", cells: "73dc66619972b0c8" },
      { tick: 600, world: "7fca664e7e1232806076dd2dd4e60f88", cells: "989acf54f7f0a2a6", deep: true },
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
