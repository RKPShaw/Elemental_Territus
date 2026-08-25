import { warsFor } from "../../app/game/diplomacy";
import { committedTroopsFor } from "../../app/game/campaigns";
import { ELEMENTS, ELEMENT_ORDER } from "../../app/game/elements";
import { compactNumber } from "../../app/game/rules";
import type { ElementId, WorldReportEvent, WorldState } from "../../app/game/types";

const IMPORTANCE_MARK = {
  routine: " ",
  notable: "·",
  major: "!",
  historic: "★",
} as const;

export function paint(text: string, hex: string, color: boolean): string {
  if (!color) return text;
  const value = Number.parseInt(hex.slice(1), 16);
  return `\u001b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m${text}\u001b[0m`;
}

export function dim(text: string, color: boolean): string {
  return color ? `\u001b[2m${text}\u001b[0m` : text;
}

export function bold(text: string, color: boolean): string {
  return color ? `\u001b[1m${text}\u001b[0m` : text;
}

/** Printable length, ignoring the escapes so columns still line up. */
function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function seasonFor(tick: number): string {
  return ["Dewrise", "Sunhigh", "Leafturn", "Starlong"][Math.floor(tick / 15) % 4]!;
}

export function renderHeader(state: WorldState, color: boolean): string {
  const seed = state.seed.toString(36).toUpperCase().padStart(6, "0").slice(-6);
  const head = `${bold(state.worldName, color)}  ${seasonFor(state.tick)} · Age ${state.age}`;
  const clock = dim(`tick ${state.tick} · seed ${seed}`, color);
  const champion = state.champion
    ? `  ${paint(`♛ ${ELEMENTS[state.champion].realmName} has united the world`, ELEMENTS[state.champion].color, color)}`
    : "";
  return `${head}  ${clock}${champion}`;
}

/** One line per realm: land, population, treasury, diplomacy and what it is doing. */
export function renderStandings(state: WorldState, color: boolean): string {
  const rows = ELEMENT_ORDER.map((id) => {
    const faction = state.factions[id];
    const element = ELEMENTS[id];
    const share = (faction.territory / state.landTiles) * 100;
    const committed = committedTroopsFor(state, id);
    const wars = warsFor(state, id).length;
    if (!faction.alive) {
      return [padVisible(paint(element.name, element.color, color), 8), dim("fallen", color)].join(" ");
    }
    const structures = `${faction.structures.city}c ${faction.structures.factory}f ${faction.structures.harbor}h ${faction.structures.fort}F`;
    return [
      padVisible(paint(element.name, element.color, color), 8),
      padVisible(`${share.toFixed(1)}%`, 6),
      padVisible(compactNumber(faction.troops), 7),
      padVisible(committed > 0 ? `+${compactNumber(committed)}` : "", 7),
      padVisible(compactNumber(faction.gold), 8),
      padVisible(structures, 16),
      padVisible(wars > 0 ? `${wars} war${wars > 1 ? "s" : ""}` : "peace", 7),
      dim(faction.intent.posture, color),
    ].join(" ");
  });
  const heading = dim(
    `${padVisible("realm", 8)} ${padVisible("land", 6)} ${padVisible("home", 7)} ${padVisible("away", 7)} ${padVisible("gold", 8)} ${padVisible("structures", 16)} ${padVisible("state", 7)} doing`,
    color,
  );
  return [heading, ...rows].join("\n");
}

export function formatEvent(event: WorldReportEvent, color: boolean): string {
  const realm = event.initiator?.realmId as ElementId | undefined;
  const tint = realm ? ELEMENTS[realm].color : "#f1c46d";
  return [
    dim(String(event.tick).padStart(5), color),
    IMPORTANCE_MARK[event.importance],
    paint(padVisible(event.kind, 34), tint, color),
    event.summary,
  ].join(" ");
}

export function renderEvents(
  events: readonly WorldReportEvent[],
  color: boolean,
  limit: number,
): string {
  if (events.length === 0) return dim("  (no events yet)", color);
  return events.slice(-limit).map((event) => formatEvent(event, color)).join("\n");
}
