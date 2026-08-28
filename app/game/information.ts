import { PLAYER_ORDER } from "./players";
import { getRelation } from "./diplomacy";
import { tradesBy } from "./elements";
import { INFORMATION_RULES } from "./rules";
import type { ObservedLayer } from "./theater-map";
import type { ElementId, PlayerId, WorldState } from "./types";

/**
 * The information identities: what a realm knows, and what its rivals wrongly
 * believe.
 *
 * Three advanced elements express here instead of at the combat, settlement
 * or payout chokepoints, translated onto the belief layer the simulation
 * already runs on — no fog of war is built, and nothing here ever touches the
 * world itself:
 *
 *   Glass sees first. A glass realm observes twice per interval, so it acts
 *   on ground closer to the truth than anyone else's. Realms whose expressed
 *   element trades by air share the identity — the skyward view was air's
 *   character before skyports were its carrier, and it stacks on the carrier
 *   rather than replacing it.
 *
 *   Mist is seen late. Rivals' measurements of the regions the Veilfolk hold
 *   in plurality are blended back toward what the rival already believed, so
 *   beliefs about mist country converge slowly and act stale. Standing in
 *   the region — a real foothold of its cells, or a pressing front — pierces
 *   the veil, and an ally or trade partner who stands there shares the true
 *   reading through the sight group, which is how pooled sight pierces it
 *   too.
 *
 *   Mirage is seen wrong. Rivals reading their beliefs about the Falselights'
 *   plurality regions get the prize and the openness at a fraction of what
 *   the store honestly holds: the ground looks poorer and better defended
 *   than it is. The illusion sits in the reading, never the store, and it
 *   collapses for any viewer whose sight group has two members with contact
 *   on the region — one line of contact can be fooled, a second corroborates.
 *
 * Everything below is derived per tick from world state and cached against
 * it, the same discipline as the sight groups: deterministic, O(cells) once
 * a tick at most, and free for worlds where no information identity is on
 * the map.
 */

/** The elements whose identity is an information mechanic on the belief layer. */
export const INFORMATION_ELEMENTS = ["mist", "mirage", "glass"] as const;

/** The observed layers a mirage distorts: what a region holds and how openly. */
const DISTORTED_LAYERS: readonly ObservedLayer[] = ["prize", "undefended"];

/**
 * Whether a realm of this element observes on the swift cadence: glass by
 * identity, and any element that trades by air by its native view from above.
 */
export function hasSwiftSight(element: ElementId): boolean {
  return element === "glass" || tradesBy(element, "airborne");
}

/** Observations a realm of this element takes per observation interval. */
export function observationCadenceOf(element: ElementId): number {
  return hasSwiftSight(element) ? INFORMATION_RULES.swiftObservationCadence : 1;
}

const SIGHT_GROUPS = new WeakMap<object, { tick: number; groups: Map<PlayerId, PlayerId[]> }>();

/**
 * Who a player sees through as well as with: itself, its allies, and the
 * partners it actually runs a route with.
 *
 * Deliberately narrow. Merely not being at war is not intelligence sharing --
 * that would put nearly the whole roster in every group and quietly undo the
 * fog. An alliance or a live trade route is a relationship someone chose and
 * can lose, which is what makes shared sight a reward rather than a default.
 */
export function sightGroup(state: WorldState, viewer: PlayerId): readonly PlayerId[] {
  const cached = SIGHT_GROUPS.get(state);
  if (cached && cached.tick === state.tick) {
    const hit = cached.groups.get(viewer);
    if (hit) return hit;
  }
  const store = cached && cached.tick === state.tick
    ? cached
    : { tick: state.tick, groups: new Map<PlayerId, PlayerId[]>() };

  const group: PlayerId[] = [viewer];
  const included = new Set<PlayerId>([viewer]);
  for (const other of PLAYER_ORDER) {
    if (other === viewer || !state.factions[other]!.alive) continue;
    if (getRelation(state, viewer, other).status !== "truce") continue;
    group.push(other);
    included.add(other);
  }
  for (const route of state.tradeRoutes) {
    const [first, second] = route.parties;
    const partner = first === viewer ? second : second === viewer ? first : null;
    if (partner === null || included.has(partner)) continue;
    if (!state.factions[partner]!.alive) continue;
    group.push(partner);
    included.add(partner);
  }

  store.groups.set(viewer, group);
  SIGHT_GROUPS.set(state, store);
  return group;
}

/**
 * Regions each player can currently see into, and stand in.
 *
 * Contact is ground held, ground next to it, the length of a trade route, and
 * a live front — the reach of a realm's eyes. Presence is the narrower set a
 * realm truly stands in: regions where it holds a real foothold — at least
 * the foothold share of the region's cells — or presses a front. Presence is
 * what pierces a mist veil; a scout across the border, a merchant passing
 * through, or a border village amid a country of someone else's mist still
 * measures the region only as the mist permits.
 *
 * Plurality is who holds more of a region than any other single realm —
 * strictly, so a contested tie names nobody. It is the honest answer to
 * "whose country is this" for regions that cross borders, and it is what the
 * mist and mirage identities cover: a realm's information power extends over
 * the ground it visibly holds, not over every cell it owns anywhere.
 *
 * Built for every player in one pass over the map, because doing it per
 * observer is the players-by-cells sweep this codebase has spent a lot of
 * effort deleting.
 */
export interface RegionIntelligence {
  contact: Map<PlayerId, Set<number>>;
  presence: Map<PlayerId, Set<number>>;
  /** Region id -> the realm holding strictly more of it than any rival, or null. */
  pluralityOwner: (PlayerId | null)[];
}

interface InformationCache {
  tick: number;
  /** Whether any living realm currently expresses each veiling identity. */
  mistWalks: boolean;
  mirageWalks: boolean;
  intelligence: RegionIntelligence | null;
}

const INFORMATION = new WeakMap<object, InformationCache>();

const PLAYER_INDEX = new Map(PLAYER_ORDER.map((id, index) => [id, index]));

function informationCache(state: WorldState): InformationCache {
  const cached = INFORMATION.get(state);
  if (cached && cached.tick === state.tick) return cached;
  let mistWalks = false;
  let mirageWalks = false;
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id]!;
    if (!faction.alive) continue;
    if (faction.expressedElement === "mist") mistWalks = true;
    else if (faction.expressedElement === "mirage") mirageWalks = true;
  }
  const fresh: InformationCache = { tick: state.tick, mistWalks, mirageWalks, intelligence: null };
  INFORMATION.set(state, fresh);
  return fresh;
}

function buildIntelligence(state: WorldState): RegionIntelligence {
  const { width, height } = state.config;
  const cells = state.cells;
  const regionByCell = state.regionByCell;
  const regionCount = state.strategicRegions.length;
  const contact = new Map<PlayerId, Set<number>>();
  const presence = new Map<PlayerId, Set<number>>();
  const held = new Int32Array(regionCount * PLAYER_ORDER.length);

  const touch = (map: Map<PlayerId, Set<number>>, player: PlayerId, regionId: number): void => {
    if (regionId < 0) return;
    const seen = map.get(player);
    if (seen) seen.add(regionId);
    else map.set(player, new Set([regionId]));
  };

  for (let index = 0; index < cells.length; index += 1) {
    const owner = cells[index]!.owner;
    if (owner === null) continue;
    const regionId = regionByCell[index]!;
    touch(contact, owner, regionId);
    if (regionId >= 0 && regionId < regionCount) {
      held[regionId * PLAYER_ORDER.length + PLAYER_INDEX.get(owner)!] += 1;
    }
    const x = index % width;
    const y = (index - x) / width;
    for (let side = 0; side < 4; side += 1) {
      const nx = side === 1 ? x + 1 : side === 3 ? x - 1 : x;
      const ny = side === 0 ? y - 1 : side === 2 ? y + 1 : y;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      touch(contact, owner, regionByCell[ny * width + nx]!);
    }
  }

  for (const route of state.tradeRoutes) {
    for (const index of route.pathIndices) {
      const regionId = regionByCell[index]!;
      for (const party of route.parties) touch(contact, party, regionId);
    }
  }

  for (const theater of state.theaters) {
    touch(contact, theater.attacker, theater.regionId);
    touch(presence, theater.attacker, theater.regionId);
  }

  const pluralityOwner: (PlayerId | null)[] = new Array(regionCount).fill(null);
  for (let regionId = 0; regionId < regionCount; regionId += 1) {
    const footholdCells = Math.max(
      1,
      Math.ceil(
        state.strategicRegions[regionId]!.cells.length * INFORMATION_RULES.mistPierceFoothold,
      ),
    );
    let best = 0;
    let owner: PlayerId | null = null;
    for (let player = 0; player < PLAYER_ORDER.length; player += 1) {
      const count = held[regionId * PLAYER_ORDER.length + player]!;
      if (count >= footholdCells) touch(presence, PLAYER_ORDER[player]!, regionId);
      if (count > best) {
        best = count;
        owner = PLAYER_ORDER[player]!;
      } else if (count === best) {
        owner = null;
      }
    }
    pluralityOwner[regionId] = owner;
  }

  return { contact, presence, pluralityOwner };
}

/** The tick's region intelligence, built at most once per tick per world. */
export function regionIntelligence(state: WorldState): RegionIntelligence {
  const cache = informationCache(state);
  if (!cache.intelligence) cache.intelligence = buildIntelligence(state);
  return cache.intelligence;
}

/**
 * How thickly the mist veils one observer's measurement of one region: the
 * blend weight toward what the observer already believed, or zero when no
 * veil applies. Veiled ground still gets looked at and still gets stamped —
 * the reading just arrives mostly made of what the looker expected to see.
 * The mist realm reads its own country clear, and so does anyone standing in
 * it; everyone else's clear view arrives through the sight group, when an
 * ally or partner stands there for them.
 */
export function mistVeilFor(
  state: WorldState,
  observer: PlayerId,
  regionId: number,
): number {
  if (!informationCache(state).mistWalks) return 0;
  const intelligence = regionIntelligence(state);
  const veiler = intelligence.pluralityOwner[regionId];
  if (!veiler || veiler === observer) return 0;
  if (state.factions[veiler]!.expressedElement !== "mist") return 0;
  if (intelligence.presence.get(observer)?.has(regionId)) return 0;
  return INFORMATION_RULES.mistVeilBlend;
}

/**
 * The multiplier a mirage puts on what one viewer believes about one region
 * and layer: the distortion share on the prize and undefended layers of the
 * Falselights' plurality regions, and exactly 1 everywhere else. Collapses —
 * returns 1 — for any viewer whose sight group holds enough members with
 * contact on the region to corroborate what is actually there, the viewer
 * itself included; the mirage realm always reads its own country true.
 */
export function mirageDistortionFor(
  state: WorldState,
  viewer: PlayerId,
  regionId: number,
  layer: ObservedLayer,
): number {
  if (!DISTORTED_LAYERS.includes(layer)) return 1;
  if (!informationCache(state).mirageWalks) return 1;
  const intelligence = regionIntelligence(state);
  const illusionist = intelligence.pluralityOwner[regionId];
  if (!illusionist || illusionist === viewer) return 1;
  if (state.factions[illusionist]!.expressedElement !== "mirage") return 1;
  let corroborating = 0;
  for (const member of sightGroup(state, viewer)) {
    if (!intelligence.contact.get(member)?.has(regionId)) continue;
    corroborating += 1;
    if (corroborating >= INFORMATION_RULES.mirageCollapseContacts) return 1;
  }
  return INFORMATION_RULES.mirageDistortion;
}
