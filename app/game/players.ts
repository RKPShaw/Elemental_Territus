import { ELEMENTS, ELEMENT_ORDER } from "./elements";
import type { ElementDefinition, ElementId, PlayerId } from "./types";

/**
 * The roster of competing players.
 *
 * A player is not the same thing as an element. Twelve players share each
 * founding element, so they share its matchups, favoured terrain and
 * temperament while competing as separate powers with their own territory,
 * treasury and diplomacy. Element is what a player *is*; player is who it
 * *is*.
 *
 * The roster is fixed at module load, exactly as ELEMENT_ORDER was, so
 * iteration order is stable and the simulation stays deterministic.
 */
/**
 * Players per element, twelve by default: four founding families of twelve,
 * the closest even-family roster to the fifty realms the game grew up with.
 *
 * Overridable through ELEMENTAL_PLAYERS_PER_ELEMENT so performance work can
 * sweep the roster size and see how each system scales. The roster is still
 * fixed once the module loads, so a run stays deterministic.
 */
export const PLAYERS_PER_ELEMENT = (() => {
  const raw = typeof process === "undefined"
    ? undefined
    : process.env?.ELEMENTAL_PLAYERS_PER_ELEMENT;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
})();

/** Roman numerals read better than digits on a map label; beyond them, digits. */
const ORDINALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] as const;

function ordinalLabel(ordinal: number): string {
  return ORDINALS[ordinal] ?? String(ordinal + 1);
}

function buildRoster(): PlayerId[] {
  const roster: PlayerId[] = [];
  // Grouped by element rather than interleaved, so a listing reads as four
  // families. Draft order is decided separately and deliberately.
  for (const element of ELEMENT_ORDER) {
    for (let ordinal = 0; ordinal < PLAYERS_PER_ELEMENT; ordinal += 1) {
      roster.push(`${element}-${ordinal + 1}`);
    }
  }
  return roster;
}

export const PLAYER_ORDER: readonly PlayerId[] = buildRoster();

export const PLAYER_COUNT = PLAYER_ORDER.length;

interface PlayerDefinition {
  id: PlayerId;
  element: ElementId;
  /** Position within its element's family, from zero. */
  ordinal: number;
  /** Short label for tables and legends, such as "Ember IV". */
  name: string;
  /** Full title, such as "The Cinderkin IV". */
  realmName: string;
  /**
   * The founding element's documented color (see ELEMENT_COLORS.md), shared
   * by every realm of the family. Per-sibling shades were dropped
   * deliberately: all realms of an element read as one similar color, and
   * borders, glyphs and labels carry the identity. On the live map a realm is
   * painted by the element it currently expresses, so this is the color it
   * starts with; conquest and ascension repaint it.
   */
  color: string;
}

function buildDefinitions(): Record<PlayerId, PlayerDefinition> {
  const definitions: Record<PlayerId, PlayerDefinition> = {};
  for (const element of ELEMENT_ORDER) {
    for (let ordinal = 0; ordinal < PLAYERS_PER_ELEMENT; ordinal += 1) {
      const id = `${element}-${ordinal + 1}`;
      definitions[id] = {
        id,
        element,
        ordinal,
        name: `${ELEMENTS[element].name} ${ordinalLabel(ordinal)}`,
        realmName: `${ELEMENTS[element].realmName} ${ordinalLabel(ordinal)}`,
        color: ELEMENTS[element].color,
      };
    }
  }
  return definitions;
}

export const PLAYERS: Record<PlayerId, PlayerDefinition> = buildDefinitions();

export function playerElement(id: PlayerId): ElementId {
  return PLAYERS[id]!.element;
}

/** The elemental character behind a player: matchups, terrain, temperament. */
export function playerElementDefinition(id: PlayerId): ElementDefinition {
  return ELEMENTS[playerElement(id)];
}

export function playersOfElement(element: ElementId): PlayerId[] {
  return PLAYER_ORDER.filter((id) => playerElement(id) === element);
}

/**
 * Draft order for choosing start locations: a snake, reversing every round.
 *
 * Picking strictly in roster order would hand the whole first element the
 * twelve best sites. Rotating the element each pick spreads the families, and
 * reversing each round means the player that picked last gets the first pick of
 * the next round, so no seat is systematically disadvantaged.
 */
export function draftOrder(): PlayerId[] {
  const order: PlayerId[] = [];
  for (let round = 0; round < PLAYERS_PER_ELEMENT; round += 1) {
    const elements = round % 2 === 0 ? ELEMENT_ORDER : [...ELEMENT_ORDER].reverse();
    for (const element of elements) {
      order.push(`${element}-${round + 1}`);
    }
  }
  return order;
}
