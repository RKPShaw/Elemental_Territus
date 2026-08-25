import { ELEMENTS, ELEMENT_ORDER } from "../../app/game/elements";
import { TERRAIN_RULES } from "../../app/game/rules";
import type { ElementId, WorldState } from "../../app/game/types";

export type MapMode = "owner" | "terrain" | "regions" | "value";

export interface MapOptions {
  mode: MapMode;
  color: boolean;
  /** Maximum output columns; the grid is sampled down to fit. */
  maxWidth: number;
}

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

const COLOR_CACHE = new Map<string, Rgb>();

function rgb(hex: string): Rgb {
  const cached = COLOR_CACHE.get(hex);
  if (cached) return cached;
  const value = Number.parseInt(hex.slice(1), 16);
  const color = { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 };
  COLOR_CACHE.set(hex, color);
  return color;
}

function mix(base: Rgb, overlay: Rgb, amount: number): Rgb {
  return {
    red: Math.round(base.red + (overlay.red - base.red) * amount),
    green: Math.round(base.green + (overlay.green - base.green) * amount),
    blue: Math.round(base.blue + (overlay.blue - base.blue) * amount),
  };
}

/** Letters stand in for realm colour when the terminal has none. */
const REALM_LETTER: Record<ElementId, string> = {
  ember: "E",
  tide: "T",
  grove: "G",
  stone: "S",
  gale: "A",
};

const TERRAIN_CHAR = {
  water: "~",
  farmland: ",",
  plains: "-",
  forest: "§",
  hills: "n",
  mountains: "^",
} as const;

/**
 * The colour a single grid cell contributes, in the same palette the browser
 * map uses: terrain tinted toward its owner's colour.
 */
function cellColor(state: WorldState, index: number, mode: MapMode): Rgb {
  const cell = state.cells[index]!;
  const terrain = rgb(TERRAIN_RULES[cell.terrain].fill);
  if (cell.terrain === "water") return terrain;

  if (mode === "terrain") return terrain;

  if (mode === "regions") {
    const region = state.regionByCell[index] ?? -1;
    if (region < 0) return terrain;
    // Regions have no palette of their own, so spread the hue circle over them;
    // adjacent ids land far apart, which is what makes borders legible.
    const hue = (region * 0.618033988749895) % 1;
    return mix(terrain, hsl(hue, 0.55, 0.55), 0.8);
  }

  if (mode === "value") {
    const value = state.strategicMeta.value[index] ?? 0;
    return mix(rgb("#2b3a3f"), rgb("#f2d479"), Math.max(0, Math.min(1, value)));
  }

  if (!cell.owner) return mix(terrain, rgb("#d8cfb1"), 0.16);
  const owned = mix(terrain, rgb(ELEMENTS[cell.owner].color), 0.72);
  // Structures read as brighter pips at map scale.
  return cell.structure ? mix(owned, rgb("#fff6d8"), cell.capitalOf ? 0.55 : 0.3) : owned;
}

function hsl(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue * 6;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] = sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
    : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma]
    : sector < 5 ? [second, 0, chroma]
    : [chroma, 0, second];
  const match = lightness - chroma / 2;
  return {
    red: Math.round((r! + match) * 255),
    green: Math.round((g! + match) * 255),
    blue: Math.round((b! + match) * 255),
  };
}

function plainChar(state: WorldState, index: number, mode: MapMode): string {
  const cell = state.cells[index]!;
  if (cell.terrain === "water") return "~";
  if (mode === "terrain") return TERRAIN_CHAR[cell.terrain];
  if (mode === "regions") {
    const region = state.regionByCell[index] ?? -1;
    return region < 0 ? "." : "0123456789abcdefghijklmnopqrstuvwxyz"[region % 36]!;
  }
  if (mode === "value") {
    const value = state.strategicMeta.value[index] ?? 0;
    return " .:-=+*#%@"[Math.min(9, Math.max(0, Math.round(value * 9)))]!;
  }
  if (!cell.owner) return ".";
  const letter = REALM_LETTER[cell.owner];
  return cell.structure ? letter : letter.toLowerCase();
}

/**
 * Renders the world as text.
 *
 * Terminal cells are about twice as tall as they are wide, so each character is
 * a half block: the foreground paints the upper grid row and the background the
 * lower one. That keeps the map's aspect ratio honest while getting two rows of
 * detail per line.
 */
export function renderMap(state: WorldState, options: MapOptions): string {
  const { width, height } = state.config;
  const step = Math.max(1, Math.ceil(width / options.maxWidth));
  const columns = Math.ceil(width / step);
  const lines: string[] = [];

  for (let row = 0; row * step * 2 < height; row += 1) {
    const upperY = row * step * 2;
    const lowerY = upperY + step;
    let line = "";
    let activeForeground = "";
    let activeBackground = "";
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(width - 1, column * step);
      const upper = upperY < height ? upperY * width + x : -1;
      const lower = lowerY < height ? lowerY * width + x : -1;

      if (!options.color) {
        line += upper >= 0 ? plainChar(state, upper, options.mode) : " ";
        continue;
      }
      const foreground = upper >= 0 ? cellColor(state, upper, options.mode) : { red: 0, green: 0, blue: 0 };
      const background = lower >= 0 ? cellColor(state, lower, options.mode) : { red: 0, green: 0, blue: 0 };
      // Escapes are only re-emitted when a colour actually changes, which keeps
      // a full redraw small enough for a live terminal.
      const foregroundCode = `${foreground.red};${foreground.green};${foreground.blue}`;
      const backgroundCode = `${background.red};${background.green};${background.blue}`;
      if (foregroundCode !== activeForeground) {
        line += `\u001b[38;2;${foregroundCode}m`;
        activeForeground = foregroundCode;
      }
      if (backgroundCode !== activeBackground) {
        line += `\u001b[48;2;${backgroundCode}m`;
        activeBackground = backgroundCode;
      }
      line += "▀";
    }
    lines.push(options.color ? `${line}\u001b[0m` : line);
  }
  return lines.join("\n");
}

/** One-line key describing what the colours mean in the current mode. */
export function mapLegend(state: WorldState, options: MapOptions): string {
  if (options.mode === "owner") {
    return ELEMENT_ORDER.map((id) => {
      const share = ((state.factions[id].territory / state.landTiles) * 100).toFixed(1);
      const label = `${REALM_LETTER[id]} ${ELEMENTS[id].name} ${share}%`;
      if (!options.color) return state.factions[id].alive ? label : `${label} (fallen)`;
      const { red, green, blue } = rgb(ELEMENTS[id].color);
      return `\u001b[38;2;${red};${green};${blue}m■\u001b[0m ${label}`;
    }).join("  ");
  }
  if (options.mode === "terrain") {
    return (Object.keys(TERRAIN_CHAR) as Array<keyof typeof TERRAIN_CHAR>)
      .map((terrain) => `${TERRAIN_CHAR[terrain]} ${TERRAIN_RULES[terrain].shortName}`)
      .join("  ");
  }
  if (options.mode === "regions") {
    return `${state.strategicRegions.length} strategic regions, recoloured by id`;
  }
  return "strategic value: dark is low, bright is high";
}
