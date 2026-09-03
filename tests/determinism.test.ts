import assert from "node:assert/strict";
import test from "node:test";
import { ElementalWarEngine } from "../app/game/engine";
import { DEFAULT_CONFIG } from "../app/game/world";
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
 * Re-recorded for the higher-resolution world: the default grid is now 252 by
 * 156 (1.5 times the 168 by 104 world the balance was tuned on), drawn one
 * pixel per area. Every digest moves by construction -- a finer grid is a
 * different world from tick zero -- and the gameplay change is the point. It
 * is, however, the only thing that moved: every rule denominated in cells was
 * rescaled through gridFineness and gridDensity so the tuned world plays
 * exactly as it did, and the previous table is kept below under its width.
 * `ELEMENTAL_MAP_SCALE=1 npm run test:determinism` replays it, and it still
 * reproduces every digest, at every checkpoint, that it did before this
 * pass -- which is the proof that the rescaling changed nothing there.
 *
 * Re-recorded when the population-management pass (PR #19) merged with the
 * elemental overhaul (conquest-fusion, the living land, the settlement draft
 * and imperial fission). Both lines had re-recorded every digest for reasons
 * their own paragraphs below still explain, and the merged world is a third
 * thing neither line played: free war meets the crowd-aware draft's spread
 * capitals, band-managed populations settle terrain the dwell sweep will
 * remake, and the faster frontier reaches the fusion trigger sooner. Every
 * digest moves by construction — both sides added faction state — and the
 * calibration horizons were re-probed on the merged world rather than
 * inherited from either side.
 *
 * Before that, re-recorded for the settlement draft and imperial fission, and the gameplay
 * changes are the point. The spawn draft became the shared Catan draft: every
 * pick still takes the best site with full knowledge, but the score now pays
 * a decaying crowding cost toward everyone already seated and reads terrain
 * through the composed element leans instead of a single favoured terrain —
 * all forty-eight capitals move, so every world differs from tick zero by
 * construction. Imperial strain is new faction state (strain and its grace
 * clock move every world digest), accrued by compound-expressed realms from
 * overextension, saturation and war weariness; at full strain a realm
 * fissions into its founding constituents through the same draft, restoring
 * dead roster slots on the freed ground. No fission fires inside these
 * horizons — tier 1 never strains, and no realm reaches tier 2 by tick 600 —
 * so the checkpoint movement here is the draft and the new state, with the
 * fission machinery proven by its own staged tests.
 *
 * Before that, re-recorded for the living land — dwell terraforming and terrain affinity —
 * and the gameplay changes are the point. Terrain stops being immutable:
 * eight terraformed terrains join the space (worldgen never places them; an
 * element's long tenure does, read off the existing capturedAt clock, so the
 * heartland transforms first and sequences ride the current terrain — Ember
 * scorches plains, Fungus mires the scorch). Terrain affinity multiplies
 * three chokepoints inside the matchup band — invasion cost of the
 * defender's ground, land income, troop sustain — and the settle lens
 * learns the ground each element leans toward, so settlement re-aims from
 * the first planning window: cell digests move from tick 60 on ownership
 * alone, long before the first transform can fire (dwell thresholds start
 * at 3,000 ticks). Realm saturation is new faction state, so every world
 * digest moves by construction as well.
 *
 * Before that, re-recorded for the crucible of conquest — ascension reworked from tally
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
 * Alongside those, re-recorded for the population-management pass, and the gameplay change was
 * the whole point. Four things moved together. A host on campaign no longer
 * occupies capacity at home, so a realm's living strength may stand above its
 * cap while its army is away (POPULATION_RULES). The growth curve was reshaped
 * into a band: it pays across 40-70% of capacity, peaks at 65% as it always
 * did, and collapses far harder than it used to outside it — a realm at 90% of
 * cap now grows at a fifth of peak where it used to manage a quarter. And the
 * courts play to that: a settlement commitment is sized to what the frontier
 * can absorb rather than to a tenth of the realm, and a crowded realm ships
 * its surplus to the front instead of sitting on it. Frontiers therefore
 * advance markedly faster from the first decision onward, and every digest
 * moves by construction.
 *
 * And war stopped costing gold. The mobilization chest a declaration used to
 * spend — 1.6 gold a soldier, floor 20,000 — is gone outright, and so is the
 * 15,000 a sea crossing used to pay; a naval campaign still needs a harbor to
 * sail from and water that joins the shores, which is reach rather than
 * price. Free war is what finally ends the dead calm the slow economy left
 * behind: on the calibration seed the first war lands at tick 224 where a
 * 2,400-tick run used to record none at all, and a ten-game sweep to tick
 * 6,000 closes with 9.6 realms of the 48 still standing where nothing used to
 * die. The opening is still staggered, by the open frontier rather than by
 * the ledger.
 *
 * The crossing fee left every cell digest untouched and moved only the world
 * digests: no realm in the golden windows owns a harbor, so nothing sails and
 * nothing about the world changed. What moved is the report stream — the
 * always-zero goldCost fact came off campaign launches with the fee it
 * described.
 *
 * Then construction, which had gone quiet for the same reason war had. Ground
 * and capitals pay two and a half times what they did, because the ladder was
 * priced to have a realm's first building land as its frontier closed and
 * population management halved the frontier era without the ladder following:
 * the median first building sat at tick 2,354 against a world settled by
 * ~1,200, and it lands at tick 1,138 now. Three gold thresholds stranded by
 * the older twentyfold cut came back with it (the fort's price, the
 * rich-treasury surge, the planner's defensive dump), the city program is
 * measured against cities a realm actually raised rather than against the
 * founding capital it was given, and forts are wanted on the approaches a
 * rival would march for instead of only where one already is.
 *
 * These moved the world digests and, again, not one cell digest: at tick 600
 * no realm has yet bought anything, so the maps are identical and only the
 * treasuries differ.
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

type GoldenWorlds = ReadonlyArray<{ seed: number; checkpoints: Checkpoint[] }>;

/** The 252 by 156 world the game ships with. */
const GOLDEN_252: GoldenWorlds = [
  {
    seed: 0x240823,
    checkpoints: [
      { tick: 60, world: "8150f99f8772154a947cde019cc26f38", cells: "64162252d69254f7" },
      { tick: 200, world: "66081721e1f372ec53222fedcffd59c9", cells: "32119e3dd6657684" },
      { tick: 600, world: "64070bce0d18d8f68e8813abf0a5e60c", cells: "1daf6cf25c6057f5", deep: true },
    ],
  },
  {
    seed: 0x5eed01,
    checkpoints: [
      { tick: 60, world: "f971ef2fdd2b0bca008c6df6fba5e7f3", cells: "a9af56ef362cd870" },
      { tick: 200, world: "e1c2730e6136d5c7626214f5b685764a", cells: "f5f58afee2d5a772" },
      { tick: 600, world: "1ac89ba99e35a7817ddedbbd2acd2b47", cells: "104e8c0803534b12", deep: true },
    ],
  },
  {
    seed: 0xbadbeef,
    checkpoints: [
      { tick: 60, world: "e280836cf3c954a6341c1eb06939eca6", cells: "b72aaae65ecee85c" },
      { tick: 200, world: "01a29cbbe673e1117a35bed46ea6c0bb", cells: "178f3303302b3788" },
      { tick: 600, world: "8ee81c4dadee658cd06743ec74023e8b", cells: "dea6e0418232fdb4", deep: true },
    ],
  },
];

/** The 168 by 104 world the balance was tuned on, replayed with ELEMENTAL_MAP_SCALE=1. */
const GOLDEN_168: GoldenWorlds = [
  {
    seed: 0x240823,
    checkpoints: [
      { tick: 60, world: "9d6815349a3970c2b644c32cd745c705", cells: "1984ddfd81022e83" },
      { tick: 200, world: "33baa57b2821c6914936baa2237c1e46", cells: "6877fdad40c8c536" },
      { tick: 600, world: "b410d5388899534517f87aa207293aa1", cells: "f1cc592b1d0becfb", deep: true },
    ],
  },
  {
    seed: 0x5eed01,
    checkpoints: [
      { tick: 60, world: "0fdeecc2f8a82e354a28f0cd5d25d3d0", cells: "c25317cec18a000a" },
      { tick: 200, world: "bd13880e62d37f884bd5d2c9f6d8628a", cells: "56d7c2fd5a1fb4f1" },
      { tick: 600, world: "6277100184ef876b2b29318616d032e4", cells: "ffcfcd65bdb9ef33", deep: true },
    ],
  },
  {
    seed: 0xbadbeef,
    checkpoints: [
      { tick: 60, world: "fa1311154852f8a388a0e9bfee9a9c68", cells: "c1c72c3cce40ee2e" },
      { tick: 200, world: "5b2d2dbc9fb46ccfa35fa1826b43f767", cells: "ca837ae5c6e8534b" },
      { tick: 600, world: "b975faf1fdf05708904d9c6d95ce16c3", cells: "d0dec691ad526c3f", deep: true },
    ],
  },
];

const GOLDEN_BY_WIDTH: Record<number, GoldenWorlds> = { 252: GOLDEN_252, 168: GOLDEN_168 };
const GOLDEN: GoldenWorlds = GOLDEN_BY_WIDTH[DEFAULT_CONFIG.width] ?? [];
if (GOLDEN.length === 0) {
  throw new Error(
    `no golden digests recorded for a ${DEFAULT_CONFIG.width}x${DEFAULT_CONFIG.height} world; `
    + "run the determinism suite at a recorded ELEMENTAL_MAP_SCALE (1 or the default 1.5)",
  );
}

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
