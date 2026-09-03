import { ELEMENTS } from "./elements";
import { PLAYERS, PLAYER_ORDER } from "./players";
import { SeededRandom } from "./random";
import type {
  ElementId,
  NameChangeReason,
  PlayerId,
  RealmIdentity,
  WorldState,
} from "./types";

/**
 * The deep naming system.
 *
 * Realms wake with plain, generic founding names — a village is not "The
 * Cinderkin", it is "Corvale" — and earn grander ones as their history is
 * written. The machinery is deliberately structural so future dynastic
 * features can reuse it wholesale:
 *
 *  - a title ladder (rank 0–3) climbed by conquest and held land, whose top
 *    rung is empire;
 *  - elemental styling: once a realm expresses a compound or advanced
 *    element, the element's name is woven into the title ("Steam Kingdom of
 *    Corvale") — its icon and territory colors already repaint through
 *    expressedElement;
 *  - name union: absorbing a realm that had itself become a kingdom or
 *    greater folds the fallen name into the conqueror's
 *    ("Corvale-Ashmere");
 *  - combineNames and the "marriage"/"decree" NameChangeReasons, reserved so
 *    a marriage between courts or a court's own proclamation can rename a
 *    realm through exactly the same recorded, reported path.
 *
 * Every change is recorded on the realm's RealmIdentity and reported as a
 * dynasty.realm-renamed event, so the story system narrates the realm's
 * whole naming arc.
 */

/** Generic place-name stock: nothing elemental about a founding village. */
const NAME_ROOTS = [
  "Cor", "Ald", "Bren", "Har", "Mar", "Wes", "Thorn", "Fen", "Gray", "Ash",
  "Bel", "Dun", "Ever", "Fair", "Glen", "Hazel", "Iron", "Kes", "Lor", "Mere",
  "North", "Oak", "Pen", "Quill", "Row", "Sil", "Tarn", "Ul", "Vance", "Wick",
  "Yar", "Zel", "Bram", "Cald", "Dray", "Elm", "Fal", "Gor", "Hol", "Ist",
] as const;

const NAME_ENDINGS = [
  "vale", "mark", "wick", "holm", "ford", "moor", "stead", "gate", "wold",
  "fell", "mere", "shire", "haven", "cross", "bourne", "field", "ridge",
  "hollow", "march", "bay",
] as const;

/**
 * Drafts one unique founding name per player from the world seed. Collisions
 * re-roll; a truly exhausted pool (impossible at 40×20 combinations for 48
 * players, but the loop is bounded anyway) falls back to a numbered form.
 */
export function draftFoundingNames(seed: number): Record<PlayerId, string> {
  const random = new SeededRandom((seed ^ 0x71c9de5b) >>> 0 || 0x71c9de5b);
  const taken = new Set<string>();
  const names: Record<PlayerId, string> = {};
  for (const id of PLAYER_ORDER) {
    let name = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      name = `${random.pick(NAME_ROOTS)}${random.pick(NAME_ENDINGS)}`;
      if (!taken.has(name)) break;
      name = "";
    }
    if (name === "") name = `${random.pick(NAME_ROOTS)}${random.pick(NAME_ENDINGS)} ${taken.size}`;
    taken.add(name);
    names[id] = name;
  }
  return names;
}

export function foundingIdentity(name: string, element: ElementId): RealmIdentity {
  return {
    name,
    title: name,
    rank: 0,
    foundingName: name,
    styledElement: element,
    absorbedAt: null,
    changes: [{ tick: 0, from: "", to: name, reason: "founding" }],
  };
}

/** The title ladder's rungs, in rank order. */
export const RANK_LABELS = ["Freehold", "March", "Kingdom", "Empire"] as const;

/**
 * Where a realm's history puts it on the title ladder. Conquest is the fast
 * road — absorbing whole realms — and held land the slow one, so a realm that
 * grows great by settlement alone is still crowned eventually.
 */
export function rankFor(realmsConquered: number, landShare: number): number {
  if (realmsConquered >= 4 || landShare >= 0.16) return 3;
  if (realmsConquered >= 2 || landShare >= 0.08) return 2;
  if (realmsConquered >= 1 || landShare >= 0.03) return 1;
  return 0;
}

/**
 * Builds the styled full title from a core name, a ladder rank and the
 * expressed element. Founding elements stay unstyled — every realm expresses
 * one, so it says nothing — while a compound or advanced element earned
 * through conquest is worn in the title.
 */
export function styledTitle(name: string, rank: number, element: ElementId): string {
  const definition = ELEMENTS[element];
  const styled = definition.tier > 1 ? definition.name : null;
  if (rank <= 0) return styled ? `${name} of the ${styled}` : name;
  if (rank === 1) return styled ? `${styled} March of ${name}` : `March of ${name}`;
  if (rank === 2) return styled ? `${styled} Kingdom of ${name}` : `Kingdom of ${name}`;
  return styled ? `${styled} Empire of ${name}` : `Empire of ${name}`;
}

/**
 * Folds two realm names into one, for unions of any kind — today a conquest
 * absorbing a great power, tomorrow a marriage of courts. A name already
 * carrying a union keeps its first part and takes the new partner's, so names
 * never grow without bound.
 */
export function combineNames(first: string, second: string): string {
  const firstCore = first.split("-")[0]!;
  const secondCore = second.split("-")[0]!;
  if (firstCore === secondCore) return firstCore;
  return `${firstCore}-${secondCore}`;
}

/** The short label for map chips, legends and tables. */
export function realmLabel(state: WorldState, id: PlayerId): string {
  return state.factions[id]?.identity?.name ?? PLAYERS[id].name;
}

/** The full styled title for stories, reports and panels. */
export function realmTitle(state: WorldState, id: PlayerId): string {
  return state.factions[id]?.identity?.title ?? PLAYERS[id].realmName;
}

/** Renames a realm keeps on record; older entries fall off the front. */
const NAME_CHANGE_LOG_LIMIT = 48;

export interface RenameOutcome {
  from: string;
  to: string;
  reason: NameChangeReason;
}

/**
 * Applies a rename to a realm's identity and records it. Callers report the
 * dynasty.realm-renamed event themselves (they hold the reporting context);
 * this keeps the identity bookkeeping in one place.
 */
export function applyRename(
  identity: RealmIdentity,
  tick: number,
  next: { name?: string; rank?: number; element?: ElementId },
  reason: NameChangeReason,
): RenameOutcome | null {
  const name = next.name ?? identity.name;
  const rank = next.rank ?? identity.rank;
  const element = next.element ?? identity.styledElement;
  const title = styledTitle(name, rank, element);
  if (title === identity.title && name === identity.name) return null;
  const outcome: RenameOutcome = { from: identity.title, to: title, reason };
  identity.name = name;
  identity.rank = rank;
  identity.styledElement = element;
  identity.title = title;
  identity.changes.push({ tick, from: outcome.from, to: title, reason });
  // The rename log is the last uncapped collection in world state, and it is
  // cloned into every published snapshot. A realm that renames forever (union,
  // fission, ascension cycles) must not grow the worker's heap forever with it.
  if (identity.changes.length > NAME_CHANGE_LOG_LIMIT) {
    identity.changes.splice(0, identity.changes.length - NAME_CHANGE_LOG_LIMIT);
  }
  return outcome;
}
