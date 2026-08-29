import test from "node:test";
import assert from "node:assert/strict";
import { ElementalWarEngine } from "../app/game/engine";
import { ELEMENT_SPACE, tradesBy } from "../app/game/elements";
import {
  hasSwiftSight,
  mirageDistortionFor,
  mistVeilFor,
  observationCadenceOf,
  regionIntelligence,
  sightGroup,
} from "../app/game/information";
import { PLAYER_ORDER } from "../app/game/players";
import { relationKey } from "../app/game/diplomacy";
import { INFORMATION_RULES, THEATER_MAP_RULES } from "../app/game/rules";
import {
  NEVER_OBSERVED,
  OBSERVED_LAYERS,
  believedValue,
  refreshTheaterMap,
} from "../app/game/theater-map";
import type { ObservedLayer } from "../app/game/theater-map";
import type { PlayerId, WorldState } from "../app/game/types";

/**
 * The information identities on the belief layer: glass and the airborne
 * realms see twice as often, mist veils what distant rivals measure of its
 * country, and mirage bends what rivals read out of their own beliefs. These
 * tests pin the contracts the phase promised — the veil thickens a look
 * without blocking it, the illusion lives only in the reading and collapses
 * under corroboration, and none of it exists for realms without the identity.
 *
 * The mist and mirage fixtures take a real drafted world and grant an
 * expression by hand, because no realm assembles a tier 3 history inside a
 * test horizon — the same trick the doctor's evidence lines wait on realms
 * to perform naturally.
 */

const FIXTURE_SEED = 0x240823;
// Advanced to where the long-frontier world has grown realms into contact:
// with village-sized starts and the slowed settlement pace, no rival has
// contact-without-presence on a plurality region before roughly tick 600,
// and the fixture wants a margin over the first appearance.
const FIXTURE_TICK = 900;

/** One advanced world, snapshotted per test into independent mutable copies. */
const fixtureEngine = new ElementalWarEngine(FIXTURE_SEED);
fixtureEngine.advance(FIXTURE_TICK);

function livingRealms(state: WorldState): PlayerId[] {
  return PLAYER_ORDER.filter((id) => state.factions[id].alive);
}

/** Members of the viewer's sight group with contact on the region. */
function corroboration(state: WorldState, viewer: PlayerId, regionId: number): number {
  const { contact } = regionIntelligence(state);
  return sightGroup(state, viewer).filter((member) => contact.get(member)?.has(regionId)).length;
}

test("swift sight belongs to glass and every airborne trader, and nobody else", () => {
  for (const element of ELEMENT_SPACE) {
    const expected = element === "glass" || tradesBy(element, "airborne");
    assert.equal(hasSwiftSight(element), expected, `${element} swift sight`);
    assert.equal(
      observationCadenceOf(element),
      expected ? INFORMATION_RULES.swiftObservationCadence : 1,
      `${element} cadence`,
    );
  }
  // The identity constants stay meaningful: a cadence of one would erase the
  // identity, a blend or distortion outside (0, 1) would break the filter.
  assert.ok(INFORMATION_RULES.swiftObservationCadence >= 2);
  assert.ok(INFORMATION_RULES.mistVeilBlend > 0 && INFORMATION_RULES.mistVeilBlend < 1);
  assert.ok(INFORMATION_RULES.mirageDistortion > 0 && INFORMATION_RULES.mirageDistortion < 1);
  assert.ok(INFORMATION_RULES.mirageCollapseContacts >= 2);
});

test("swift-sight realms observe twice per interval in a running world", () => {
  const interval = THEATER_MAP_RULES.observationInterval;
  assert.ok(FIXTURE_TICK >= 2 * interval, "the fixture world must have completed full rotations");
  fixtureEngine.observe((state) => {
    const freshestAge = (id: PlayerId): number => {
      let best = NEVER_OBSERVED;
      for (const seenAt of state.theaterMap.byPlayer[id]!.observedAt) {
        best = Math.max(best, seenAt);
      }
      return best === NEVER_OBSERVED ? Number.POSITIVE_INFINITY : state.tick - best;
    };
    const swiftBound = Math.floor(interval / INFORMATION_RULES.swiftObservationCadence);
    let ordinaryBeyondBound = 0;
    for (const id of livingRealms(state)) {
      const age = freshestAge(id);
      assert.ok(age < interval, `${id} must have observed within the interval, saw ${age}`);
      if (hasSwiftSight(state.factions[id].expressedElement)) {
        assert.ok(
          age < swiftBound,
          `${id} has swift sight and must have observed within ${swiftBound} ticks, saw ${age}`,
        );
      } else if (age >= swiftBound) {
        ordinaryBeyondBound += 1;
      }
    }
    // The halving is an asymmetry, not a global speed-up: with slots spread
    // evenly, some ordinary realm is always deeper into its interval than any
    // swift realm is allowed to be.
    assert.ok(ordinaryBeyondBound > 0, "some ordinary realm should be staler than swift sight permits");
  });
});

test("region intelligence holds honest contact, foothold presence and strict plurality", () => {
  const state = fixtureEngine.snapshot();
  const { contact, presence, pluralityOwner } = regionIntelligence(state);

  const held = new Map<string, number>();
  for (let index = 0; index < state.cells.length; index += 1) {
    const owner = state.cells[index]!.owner;
    if (!owner) continue;
    const regionId = state.regionByCell[index]!;
    if (regionId < 0) continue;
    held.set(`${regionId}|${owner}`, (held.get(`${regionId}|${owner}`) ?? 0) + 1);
  }

  for (const [player, regions] of presence) {
    for (const regionId of regions) {
      assert.ok(contact.get(player)?.has(regionId), "presence must imply contact");
      const foothold = Math.max(1, Math.ceil(
        state.strategicRegions[regionId]!.cells.length * INFORMATION_RULES.mistPierceFoothold,
      ));
      const standing = (held.get(`${regionId}|${player}`) ?? 0) >= foothold
        || state.theaters.some(
          (theater) => theater.attacker === player && theater.regionId === regionId,
        );
      assert.ok(standing, `${player} presence in region ${regionId} needs a foothold or a front`);
    }
  }

  let pluralities = 0;
  for (let regionId = 0; regionId < state.strategicRegions.length; regionId += 1) {
    const owner = pluralityOwner[regionId];
    if (!owner) continue;
    pluralities += 1;
    const own = held.get(`${regionId}|${owner}`) ?? 0;
    for (const rival of PLAYER_ORDER) {
      if (rival === owner) continue;
      assert.ok(
        (held.get(`${regionId}|${rival}`) ?? 0) < own,
        `plurality in region ${regionId} must be strict`,
      );
    }
  }
  assert.ok(pluralities > 0, "a settled world should have plurality regions");
});

test("without an information realm, no veil applies and no reading is distorted", () => {
  const state = fixtureEngine.snapshot();
  for (let regionId = 0; regionId < state.strategicRegions.length; regionId += 1) {
    for (const viewer of livingRealms(state)) {
      assert.equal(mistVeilFor(state, viewer, regionId), 0);
      for (const layer of OBSERVED_LAYERS) {
        assert.equal(mirageDistortionFor(state, viewer, regionId, layer), 1);
      }
    }
  }
});

/**
 * A region held in plurality by a realm the test can turn to mist or mirage,
 * with a rival whose contact stops short of presence — the observer the veil
 * is for. Deterministic for the fixture seed; the assertion that it exists is
 * itself part of the test.
 */
function informationFixture(state: WorldState): {
  regionId: number;
  owner: PlayerId;
  distantRival: PlayerId;
} {
  const { contact, presence, pluralityOwner } = regionIntelligence(state);
  for (let regionId = 0; regionId < state.strategicRegions.length; regionId += 1) {
    const owner = pluralityOwner[regionId];
    if (!owner || !state.factions[owner].alive) continue;
    for (const rival of livingRealms(state)) {
      if (rival === owner) continue;
      if (!contact.get(rival)?.has(regionId)) continue;
      if (presence.get(rival)?.has(regionId)) continue;
      return { regionId, owner, distantRival: rival };
    }
  }
  assert.fail("the fixture world should hold a plurality region with a distant observer");
}

test("mist veils a distant rival's measurement toward its prior belief without blocking the look", () => {
  const veiled = fixtureEngine.snapshot();
  const plain = fixtureEngine.snapshot();
  const { regionId, owner, distantRival } = informationFixture(plain);
  veiled.factions[owner].expressedElement = "mist";

  assert.equal(
    mistVeilFor(veiled, distantRival, regionId),
    INFORMATION_RULES.mistVeilBlend,
    "the distant rival measures through the veil",
  );
  assert.equal(mistVeilFor(veiled, owner, regionId), 0, "the mist realm reads its own country clear");
  assert.equal(mistVeilFor(plain, distantRival, regionId), 0, "no mist realm, no veil");

  // Drive both worlds to the rival's own observation slot and let it look.
  const interval = THEATER_MAP_RULES.observationInterval;
  const base = Math.floor(
    (PLAYER_ORDER.indexOf(distantRival) * interval) / PLAYER_ORDER.length,
  );
  const observationTick = plain.tick - (plain.tick % interval) + interval + base;
  const before = {
    value: plain.theaterMap.byPlayer[distantRival]!.value.slice(),
    trend: plain.theaterMap.byPlayer[distantRival]!.trend.slice(),
  };
  for (const world of [veiled, plain]) {
    world.tick = observationTick;
    refreshTheaterMap(world);
  }

  const veiledStore = veiled.theaterMap.byPlayer[distantRival]!;
  const plainStore = plain.theaterMap.byPlayer[distantRival]!;
  assert.equal(veiledStore.observedAt[regionId], observationTick, "the veil never blocks a look");
  assert.equal(plainStore.observedAt[regionId], observationTick);

  let moved = false;
  for (const layer of OBSERVED_LAYERS) {
    const index = regionId * OBSERVED_LAYERS.length + OBSERVED_LAYERS.indexOf(layer);
    const predicted = before.value[index]! + before.trend[index]!;
    const plainShift = plainStore.value[index]! - predicted;
    const veiledShift = veiledStore.value[index]! - predicted;
    // The veil admits exactly its unblended share of what the look would have
    // corrected: the belief converges, just slower.
    assert.ok(
      Math.abs(veiledShift - (1 - INFORMATION_RULES.mistVeilBlend) * plainShift)
        < 1e-6 * Math.max(1, Math.abs(plainShift)),
      `${layer} must blend toward the prior belief`,
    );
    if (Math.abs(plainShift) > 1e-9) moved = true;
  }
  assert.ok(moved, "the clear look should actually move some belief, or the veil proves nothing");

  // The mist realm's own readings stay clear: wherever it observed in both
  // worlds it recorded the same values — the veil exists only for rivals
  // measuring from outside. (Expressing mist also grants the owner swift
  // sight, so the veiled world may hold one extra observation slot for it;
  // matching stamps are compared, mismatched ones prove nothing either way.)
  const ownVeiled = veiled.theaterMap.byPlayer[owner]!;
  const ownPlain = plain.theaterMap.byPlayer[owner]!;
  if (ownVeiled.observedAt[regionId] === ownPlain.observedAt[regionId]) {
    for (const layer of OBSERVED_LAYERS) {
      const index = regionId * OBSERVED_LAYERS.length + OBSERVED_LAYERS.indexOf(layer);
      assert.equal(ownVeiled.value[index], ownPlain.value[index]);
    }
  }
});

test("mirage distorts believed prize and openness, collapses under corroboration, and spares the rest", () => {
  const plain = fixtureEngine.snapshot();
  const bent = fixtureEngine.snapshot();
  const { regionId, owner } = informationFixture(plain);
  bent.factions[owner].expressedElement = "mirage";

  // A viewer the illusion holds: too little corroboration in its sight group.
  // The alliance below has to be the thing that collapses it, so the fixture
  // also demands a viewer that allying with the owner actually informs. A
  // viewer holding a remembered belief but no contact of its own reads a
  // distorted prize and is still short of the threshold after gaining one
  // corroborating ally, and picking it would leave the second half of this
  // test asserting nothing about the mirage.
  const alliedWithOwner = (viewer: PlayerId): WorldState => {
    const world = fixtureEngine.snapshot();
    world.relations[relationKey(viewer, owner)]!.status = "truce";
    return world;
  };
  const fooled = livingRealms(plain).find(
    (viewer) => viewer !== owner
      && corroboration(plain, viewer, regionId) > 0
      && corroboration(plain, viewer, regionId) < INFORMATION_RULES.mirageCollapseContacts
      && believedValue(plain, viewer, regionId, "prize").value > 0
      && corroboration(alliedWithOwner(viewer), viewer, regionId)
        >= INFORMATION_RULES.mirageCollapseContacts,
  );
  assert.ok(fooled, "the fixture world should hold a viewer the mirage can fool");

  for (const layer of ["prize", "undefended"] as ObservedLayer[]) {
    const truth = believedValue(plain, fooled!, regionId, layer).value;
    const illusion = believedValue(bent, fooled!, regionId, layer).value;
    assert.ok(
      Math.abs(illusion - truth * INFORMATION_RULES.mirageDistortion) < 1e-9,
      `${layer} must read at the distortion share`,
    );
  }
  for (const layer of ["infrastructure", "access"] as ObservedLayer[]) {
    assert.equal(
      believedValue(bent, fooled!, regionId, layer).value,
      believedValue(plain, fooled!, regionId, layer).value,
      `${layer} is never distorted`,
    );
  }
  assert.equal(
    believedValue(bent, owner, regionId, "prize").value,
    believedValue(plain, owner, regionId, "prize").value,
    "the mirage realm reads its own country true",
  );
  // The stores stay honest: the illusion exists only in the reading.
  assert.deepEqual(
    bent.theaterMap.byPlayer[fooled!]!.value,
    plain.theaterMap.byPlayer[fooled!]!.value,
  );

  // Corroboration collapses it: allied to the illusionist, the fooled viewer's
  // sight group gains a second member with contact and reads the truth. The
  // control world carries the same alliance without the mirage, because the
  // alliance also changes what pooling supplies — only the distortion may
  // differ between the pair.
  const corroborated = fixtureEngine.snapshot();
  corroborated.factions[owner].expressedElement = "mirage";
  corroborated.relations[relationKey(fooled!, owner)]!.status = "truce";
  const alliedPlain = fixtureEngine.snapshot();
  alliedPlain.relations[relationKey(fooled!, owner)]!.status = "truce";
  assert.ok(
    corroboration(corroborated, fooled!, regionId) >= INFORMATION_RULES.mirageCollapseContacts,
    "the alliance must bring corroborating contact",
  );
  assert.equal(
    mirageDistortionFor(corroborated, fooled!, regionId, "prize"),
    1,
    "corroborated sight is not distorted",
  );
  assert.equal(
    believedValue(corroborated, fooled!, regionId, "prize").value,
    believedValue(alliedPlain, fooled!, regionId, "prize").value,
    "an informed sight group collapses the illusion",
  );
});
