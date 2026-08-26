import { ELEMENTS, ELEMENT_ORDER } from "./elements";
import type { ElementDefinition, ElementId, PlayerId } from "./types";

/**
 * The roster of competing players.
 *
 * A player is not the same thing as an element. Ten players share each element,
 * so they share its matchups, favoured terrain and temperament while competing
 * as separate powers with their own territory, treasury and diplomacy. Element
 * is what a player *is*; player is who it *is*.
 *
 * The roster is fixed at module load, exactly as ELEMENT_ORDER was, so
 * iteration order is stable and the simulation stays deterministic.
 */
/**
 * Players per element, ten by default.
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();

/** Roman numerals read better than digits on a map label; beyond them, digits. */
const ORDINALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"] as const;

function ordinalLabel(ordinal: number): string {
  return ORDINALS[ordinal] ?? String(ordinal + 1);
}

function buildRoster(): PlayerId[] {
  const roster: PlayerId[] = [];
  // Grouped by element rather than interleaved, so a listing reads as five
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

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(red: number, green: number, blue: number): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/**
 * Ten distinguishable tints per element, walking from the element's soft colour
 * to its deep one. A player therefore reads as its family at a glance while
 * still being separable from its siblings.
 */
function shadeFor(element: ElementId, ordinal: number): string {
  const [softRed, softGreen, softBlue] = hexToRgb(ELEMENTS[element].softColor);
  const [deepRed, deepGreen, deepBlue] = hexToRgb(ELEMENTS[element].deepColor);
  const amount = PLAYERS_PER_ELEMENT === 1 ? 0.5 : ordinal / (PLAYERS_PER_ELEMENT - 1);
  return rgbToHex(
    softRed + (deepRed - softRed) * amount,
    softGreen + (deepGreen - softGreen) * amount,
    softBlue + (deepBlue - softBlue) * amount,
  );
}

interface PlayerDefinition {
  id: PlayerId;
  element: ElementId;
  /** Position within its element's family, from zero. */
  ordinal: number;
  /** Short label for tables and legends, such as "Ember IV". */
  name: string;
  /** Full title, such as "The Cinderkin IV". */
  realmName: string;
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
        color: shadeFor(element, ordinal),
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
 * Picking strictly in roster order would hand the whole first element the ten
 * best sites. Rotating the element each pick spreads the families, and
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
