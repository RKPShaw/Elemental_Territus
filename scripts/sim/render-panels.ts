import { warsFor } from "../../app/game/diplomacy";
import { committedTroopsFor } from "../../app/game/campaigns";
import { ELEMENTS } from "../../app/game/elements";
import { PLAYERS, PLAYER_ORDER } from "../../app/game/players";
import { compactNumber } from "../../app/game/rules";
import type { PlayerId, WorldReportEvent, WorldState } from "../../app/game/types";

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
    ? `  ${paint(`♛ ${PLAYERS[state.champion]!.realmName} has united the world`, PLAYERS[state.champion]!.color, color)}`
    : "";
  return `${head}  ${clock}${champion}`;
}

/**
 * The leaderboard: the strongest realms by land, plus what became of the rest.
 *
 * Fifty rows is not a standings table, so only the leaders are listed and the
 * remainder is summarised. Elements are reported alongside, since ten players
 * share each one and the family totals are what a player reads the board for.
 */
export function renderStandings(state: WorldState, color: boolean, limit = 12): string {
  const living = PLAYER_ORDER
    .map((id) => state.factions[id]!)
    .filter((faction) => faction.alive)
    .sort((first, second) => second.territory - first.territory);

  const rows = living.slice(0, limit).map((faction) => {
    const definition = PLAYERS[faction.id]!;
    const share = (faction.territory / state.landTiles) * 100;
    const committed = committedTroopsFor(state, faction.id);
    const wars = warsFor(state, faction.id).length;
    const structures = `${faction.structures.city}c ${faction.structures.factory}f ${faction.structures.harbor}h ${faction.structures.fort}F`;
    return [
      padVisible(paint(definition.name, definition.color, color), 12),
      padVisible(`${share.toFixed(1)}%`, 6),
      padVisible(compactNumber(faction.troops), 7),
      padVisible(committed > 0 ? `+${compactNumber(committed)}` : "", 7),
      padVisible(compactNumber(faction.gold), 8),
      padVisible(structures, 16),
      padVisible(wars > 0 ? `${wars}w` : "peace", 6),
      dim(faction.intent.posture, color),
    ].join(" ");
  });

  const heading = dim(
    `${padVisible("realm", 12)} ${padVisible("land", 6)} ${padVisible("home", 7)} ${padVisible("away", 7)} ${padVisible("gold", 8)} ${padVisible("structures", 16)} ${padVisible("wars", 6)} doing`,
    color,
  );
  const fallen = PLAYER_ORDER.length - living.length;
  const footer = dim(
    `${living.length} realms standing, ${fallen} fallen` +
    (living.length > limit ? ` · ${living.length - limit} more not shown` : ""),
    color,
  );
  return [heading, ...rows, footer].join("\n");
}

/** Land held by each elemental family, which is what survives a fifty-way war. */
export function renderElementSummary(state: WorldState, color: boolean): string {
  const totals = new Map<string, { land: number; alive: number }>();
  for (const faction of Object.values(state.factions)) {
    const entry = totals.get(faction.element) ?? { land: 0, alive: 0 };
    entry.land += faction.territory;
    if (faction.alive) entry.alive += 1;
    totals.set(faction.element, entry);
  }
  return [...totals.entries()]
    .sort((first, second) => second[1].land - first[1].land)
    .map(([element, entry]) => {
      const definition = ELEMENTS[element as keyof typeof ELEMENTS];
      const share = ((entry.land / state.landTiles) * 100).toFixed(1);
      return `${paint(definition.name, definition.color, color)} ${share}% (${entry.alive})`;
    })
    .join("   ");
}

export function formatEvent(event: WorldReportEvent, color: boolean): string {
  const realm = event.initiator?.realmId as PlayerId | undefined;
  const tint = realm ? (PLAYERS[realm]?.color ?? "#f1c46d") : "#f1c46d";
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
