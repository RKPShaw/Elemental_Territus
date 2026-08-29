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
 * Re-recorded for the crucible of conquest — ascension reworked from tally
 * thresholds to conquest-held fusion, and the gameplay change is the point.
 * Three moves, two of them by construction: the transmutation window is new
 * faction state (FactionState.transmutation), so every world digest moves;
 * the stream flag joined the cell digest (it was the one cell field the
 * digest never learned, an omission this phase repairs), so every cell
 * digest moves. The third is the real mechanic: a realm now becomes
 * eligible for a higher element the moment annexation puts both
 * constituents inside it — one cross-family conquest, not a depth-two
 * tally — and eligibility opens a visible transmutation window (dulled
 * attack, settlement, growth and war desire; bespoke meters held) instead
 * of flipping expression on the spot. Ascension appetite reads the same
 * held-constituent arithmetic, so war targeting genuinely re-aims from the
 * first diplomacy pass and the worlds diverge long before the first window
 * opens.
 *
 * Before that, re-recorded for the long-frontier tuning pass: realms open at a tenth of
 * their old area (SPAWN_RULES.initialRegionRadius) and the settlement pace
 * came down twentyfold again (CLAIM_RULES.pressurePerTick 0.62 -> 0.03), so
 * the frontier era runs thousands of ticks instead of ~180 and every digest
 * moves by construction. Tuning only -- no new mechanics entered the build
 * (the long-game mechanics under design live in LONG_GAME_DESIGN.md).
 *
 * Before that, re-recorded for the slow-world pacing retune, and the gameplay change was
 * the whole point. Population grows at a sixth of the old rate, which slows
 * the frontier as much as the head count because settling ground is paid for
 * in people. Every income rate is a twentieth of what it was: land and city
 * yields divided outright, and each trade carrier divided by three levers at
 * once -- a tripled dispatch clock, halved vehicle speeds (ships a fifth,
 * since a harbour is the one site that gains no reach limit), and smaller
 * rewards. Every trade reach is a sixth of what it was, alongside the
 * structure spacing that gives a reach its meaning, and the airborne carrier
 * gained the reach limit it never had. Two systems had to follow the
 * geometry to keep working at it: rail may now open a network wherever a
 * factory has a station in radius, instead of only in a world with no track
 * at all, and every placement preference that answers to a trade network is
 * measured in that carrier's reach rather than in bare world units.
 *
 * Before that, re-recorded for the rivers-and-slow-money rework, and the gameplay changes
 * were the point, all of them. Watercourses now hold a heading (a turn
 * penalty in the carve walk stops steepest-descent from coiling around flat
 * basins), and stream courses are trimmed to land, so the map itself moves —
 * every digest by construction. Streams became ship-only borders: the
 * frontier index refuses enemy conquest steps that enter or leave a stream
 * cell, stream banks count as coast, and ships (merchant and transport
 * alike) sail the stream network, with transports slowed fourfold so a
 * crossing is a real commitment. And the opening economy slowed the way the
 * settlement pace once did: realms open with a 2K purse instead of 20K, the
 * shared ladder became 18K / 40K / 90K / 180K priced against the 20K war
 * chest, and the founding capital no longer counts as a purchase — so the
 * first savings milestone is a real decision between a factory, a city's
 * +10K troop cap, and funding a war, and every court reaches it at its own
 * pace. The construction planner keeps that decision honest: the hard-coded
 * first factory is gone, and the opening purchase competes on capacity
 * pressure — a realm packed against its troop cap buys the city, a sprawling
 * one buys the income.
 *
 * Before that, re-recorded for the frontier-and-wars rework, and the gameplay changes were
 * the point, all five of them. Streams — minor rivers carved as land lines
 * that raise the cost of taking their banks — are a new cell field and a new
 * world field, so every digest moves by construction, and they reshape where
 * borders come to rest. Contested wilderness now resolves instead of
 * deadlocking (rival settlers cancel each other at a discount, and an
 * invasion slows the frontier program rather than freezing it), so the
 * no-man's-land strips between neighbours close. Diplomacy dropped the
 * one-war-per-pair engagement lock entirely: there is no cap on wars held,
 * only a court-actions-per-term budget on what one realm may do in a single
 * diplomacy sitting, so coalitions pile onto a weakened realm freely. War
 * became funded — a declaration spends a mobilization chest that scales with
 * the army being raised, desire scales with the ability to pay, and open
 * wilderness frontier suppresses desire while free land remains — so the
 * opening wars release realm by realm as economies and frontiers allow
 * instead of all firing on the first legal tick (minimumPeaceTicks came down
 * from 180 to 64 because the incentives now carry the opening calm).
 * Campaigns may be launched by either party to a war, so an overmatched
 * defender blunts an invasion and counterattacks to take its ground back,
 * across up to two fronts at once. Realms also carry living names (identity
 * is new faction state) that climb a title ladder as conquest earns it, so
 * report and story text moves with the facts.
 *
 * Before that, re-recorded for the pacing retune, and the gameplay change was the point:
 * wilderness settlement pressure came down more than tenfold so the world
 * settles across roughly its first hundred and fifty ticks instead of its
 * first fifty, and every income rate (land, cities, all four trade carriers,
 * with plasma's upkeep scaled to match) was cut about fivefold so economies
 * take four to eight times as long to get busy while combat's own arithmetic
 * is untouched. The same change capped each story arc's retained evidence ids
 * (eventCount now carries the true total -- new state, so every world digest
 * moves by construction) and retired the longest-untouched arcs past a
 * retention mark, bounding what a long game keeps in memory. Cell digests
 * move everywhere too, exactly as a settlement-pace change must make them.
 *
 * Before that, re-recorded when legibility rebuilt the story surfacing. The consolidated
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
      { tick: 60, world: "5d9bb87f26e1074b7902fc96b64be814", cells: "1e71590ddb73544f" },
      { tick: 200, world: "9a5226c68c299010f22fc027e6a8c9e0", cells: "9f85f55f65ac4177" },
      { tick: 600, world: "ed7a1dc22ff440a1fa07cb40076bb4df", cells: "2f74974d65382dc9", deep: true },
    ],
  },
  {
    seed: 0x5eed01,
    checkpoints: [
      { tick: 60, world: "5f03f52415a4151750a2454e34446542", cells: "3090bf8cad8f8076" },
      { tick: 200, world: "7e46da79410fb01b2a90e6e59bd4506c", cells: "3bbb05529c75808f" },
      { tick: 600, world: "d24d0e5059b21fe15a3211b5d0ca7efa", cells: "b3196ad8b3d04f2a", deep: true },
    ],
  },
  {
    seed: 0xbadbeef,
    checkpoints: [
      { tick: 60, world: "a00f202da2887d2e1644319f6d992c99", cells: "85545d735bcd4879" },
      { tick: 200, world: "48b48ed0bdc5c027d0896d6deb757bf5", cells: "9d96f136758ecbec" },
      { tick: 600, world: "f68163a2b2d606ffdcc9344914869705", cells: "475d01c7d5b75616", deep: true },
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
