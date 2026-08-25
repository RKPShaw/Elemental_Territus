import type { ElementDefinition, ElementId, WorldState } from "./types";

export const ELEMENT_ORDER: readonly ElementId[] = [
  "ember",
  "tide",
  "grove",
  "stone",
  "gale",
] as const;

export const ELEMENTS: Record<ElementId, ElementDefinition> = {
  ember: {
    id: "ember",
    name: "Ember",
    realmName: "The Cinderkin",
    title: "Bright, bold & impatient",
    glyph: "✦",
    color: "#ef6a5b",
    softColor: "#ffc2ad",
    deepColor: "#8e2f35",
    strongAgainst: ["grove", "gale"],
    weakAgainst: ["tide", "stone"],
    favoredTerrain: "hills",
    temperament: "Mobilizes early and spends heavily when a border looks thin.",
  },
  tide: {
    id: "tide",
    name: "Tide",
    realmName: "The Ripple Court",
    title: "Patient, fluid & watchful",
    glyph: "≈",
    color: "#45a9b8",
    softColor: "#ade1dc",
    deepColor: "#176375",
    strongAgainst: ["ember", "stone"],
    weakAgainst: ["grove", "gale"],
    favoredTerrain: "farmland",
    temperament: "Invests in harbors, trade and carefully timed naval landings.",
  },
  grove: {
    id: "grove",
    name: "Grove",
    realmName: "The Mossbound",
    title: "Steady, social & stubborn",
    glyph: "❧",
    color: "#71a366",
    softColor: "#c9dda1",
    deepColor: "#426342",
    strongAgainst: ["tide", "stone"],
    weakAgainst: ["ember", "gale"],
    favoredTerrain: "forest",
    temperament: "Values peaceful trade and builds a layered defensive frontier.",
  },
  stone: {
    id: "stone",
    name: "Stone",
    realmName: "The Pebblehold",
    title: "Tough, thrifty & immovable",
    glyph: "◆",
    color: "#c49a62",
    softColor: "#ead2a0",
    deepColor: "#74543e",
    strongAgainst: ["ember", "gale"],
    weakAgainst: ["tide", "grove"],
    favoredTerrain: "mountains",
    temperament: "Turns mountain approaches into forts before counterattacking.",
  },
  gale: {
    id: "gale",
    name: "Gale",
    realmName: "The Cloudlings",
    title: "Clever, quick & capricious",
    glyph: "◌",
    color: "#9684c5",
    softColor: "#d6cbef",
    deepColor: "#594d84",
    strongAgainst: ["tide", "grove"],
    weakAgainst: ["ember", "stone"],
    favoredTerrain: "plains",
    temperament: "Keeps a reserve and changes wars when the balance shifts.",
  },
};

export function matchup(attacker: ElementId, defender: ElementId): number {
  if (ELEMENTS[attacker].strongAgainst.includes(defender)) return 1.12;
  if (ELEMENTS[attacker].weakAgainst.includes(defender)) return 0.88;
  return 1;
}

export function matchupLabel(attacker: ElementId, defender: ElementId): string {
  const value = matchup(attacker, defender);
  if (value > 1) return "elemental edge";
  if (value < 1) return "elemental risk";
  return "even elements";
}

export function realmMatchup(
  state: WorldState,
  attacker: ElementId,
  defender: ElementId,
): number {
  const attackElements = state.factions[attacker].absorbedElements;
  const defenseElements = state.factions[defender].absorbedElements;
  return Math.max(...attackElements.map((attackElement) =>
    Math.min(...defenseElements.map((defenseElement) => matchup(attackElement, defenseElement))),
  ));
}

export function realmMatchupLabel(
  state: WorldState,
  attacker: ElementId,
  defender: ElementId,
): string {
  const value = realmMatchup(state, attacker, defender);
  if (value > 1) {
    return state.factions[attacker].absorbedElements.length > 1
      ? "absorbed elemental edge"
      : "elemental edge";
  }
  if (value < 1) return "elemental risk";
  return "even elements";
}
