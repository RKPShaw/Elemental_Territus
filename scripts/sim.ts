/**
 * Elemental Frontiers from the command line.
 *
 * Runs the real engine with the real ordered systems -- no UI, no bundler, and
 * no installed dependencies -- so a world can be played, inspected and checked
 * from a terminal. See `sim.ts help` for the commands.
 */
import { committedTroopsFor } from "../app/game/campaigns";
import { NATIONS, NATION_ORDER } from "../app/game/nations";
import { ElementalWarEngine } from "../app/game/engine";
import { latestStories } from "../app/game/reporting";
import { compactNumber } from "../app/game/rules";
import type { WorldReportEvent, WorldState } from "../app/game/types";
import { DEFAULT_SEED, parseArgs, terminalWidth, wantsColor } from "./sim/args";
import { runDoctor } from "./sim/doctor";
import { profileRun, quantile } from "./sim/profile";
import { mapLegend, renderMap } from "./sim/render-map";
import type { MapMode } from "./sim/render-map";
import {
  bold,
  dim,
  formatEvent,
  paint,
  renderEvents,
  renderHeader,
  renderStandings,
} from "./sim/render-panels";

const args = parseArgs(process.argv.slice(2));
const color = wantsColor(args);
const seed = args.number("seed", DEFAULT_SEED);
const write = (text: string) => process.stdout.write(`${text}\n`);

function newEngine(): ElementalWarEngine {
  const engine = new ElementalWarEngine(seed);
  const aggression = args.number("aggression", 1);
  if (aggression !== 1) engine.setAggression(aggression);
  return engine;
}

/** Advances a fresh world to `--tick` and returns the snapshot. */
function worldAt(defaultTick: number): WorldState {
  const engine = newEngine();
  engine.advance(Math.max(0, args.integer("tick", defaultTick)));
  return engine.snapshot();
}

function mapOptions(): { mode: MapMode; color: boolean; maxWidth: number } {
  const mode = (args.flag("mode") ?? "owner") as MapMode;
  if (!["owner", "terrain", "regions", "value"].includes(mode)) {
    throw new Error(`Unknown map mode "${mode}". Use owner, terrain, regions or value.`);
  }
  return { mode, color, maxWidth: terminalWidth(args) };
}

function commandMap(): void {
  const state = worldAt(600);
  const options = mapOptions();
  write(renderHeader(state, color));
  write(renderMap(state, options));
  write(mapLegend(state, options));
}

function commandWatch(): void {
  const engine = newEngine();
  const options = mapOptions();
  const speed = Math.max(1, args.integer("speed", 4));
  const until = args.integer("until", 3_600);
  const frameMs = Math.max(0, Math.round(1_000 / Math.max(1, args.integer("fps", 8))));
  const eventLines = Math.max(0, args.integer("events", 6));
  const live = Boolean(process.stdout.isTTY) && color;
  let seenReports = 0;

  const frame = () => {
    const state = engine.snapshot();
    const fresh = state.reports.slice(seenReports);
    seenReports = state.reports.length;
    const body = [
      renderHeader(state, color),
      renderMap(state, options),
      "",
      renderStandings(state, color),
      "",
      fresh.length > 0
        ? renderEvents(fresh, color, eventLines)
        : dim("  (quiet)", color),
    ].join("\n");
    // A single write per frame; clearing and painting separately makes the
    // terminal flicker.
    process.stdout.write(live ? `\u001b[H\u001b[2J${body}\n` : `${body}\n\n`);
  };

  const step = () => {
    const champion = engine.observe((state) => state.champion);
    if (engine.tick >= until || champion !== null) {
      // The frame for this tick has already been drawn, so only the verdict is
      // left to print; drawing again would report an empty event feed.
      write(dim(
        champion ? `${NATIONS[champion]!.realmName} united the world at tick ${engine.tick}` : `stopped at tick ${engine.tick}`,
        color,
      ));
      return;
    }
    engine.advance(speed);
    frame();
    setTimeout(step, frameMs);
  };

  if (live) process.stdout.write("\u001b[?25l");
  const restore = () => {
    if (live) process.stdout.write("\u001b[?25h\n");
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(0);
  });
  frame();
  step();
}

function commandEvents(): void {
  const state = worldAt(600);
  const domain = args.flag("domain");
  const kind = args.flag("kind");
  const realm = args.flag("realm");
  const importance = args.flag("importance");
  const since = args.integer("since", 0);
  const limit = args.integer("limit", 40);

  const matches = state.reports.filter((event: WorldReportEvent) => {
    if (event.tick < since) return false;
    if (domain && event.domain !== domain) return false;
    if (kind && !event.kind.includes(kind)) return false;
    if (importance && event.importance !== importance) return false;
    if (realm) {
      const involved = [event.initiator, ...event.targets, ...event.participants]
        .some((subject) => subject?.realmId === realm);
      if (!involved) return false;
    }
    return true;
  });

  if (args.boolean("json", false)) {
    write(JSON.stringify(matches.slice(-limit), null, 2));
    return;
  }
  write(renderHeader(state, color));
  write(dim(`${matches.length} matching facts of ${state.reports.length}; showing the last ${Math.min(limit, matches.length)}`, color));
  for (const event of matches.slice(-limit)) write(formatEvent(event, color));
}

function heading(text: string): string {
  return bold(`— ${text} —`, color);
}

function inspectDiplomacy(state: WorldState): void {
  const all = Object.values(state.relations);
  const notable = all.filter((relation) =>
    relation.status !== "peace" || relation.truceOfferBy !== null || !relation.tradeActive);
  write(heading("relations"));
  write(dim(
    `  ${all.length} pairs; ${all.filter((r) => r.status === "war").length} at war, ` +
    `${all.filter((r) => r.status === "truce").length} allied, ` +
    `${all.filter((r) => !r.tradeActive).length} with trade closed`,
    color,
  ));
  // Listing every pair would be 1,225 lines, so only the ones doing something.
  if (notable.length === 0) write(dim("  every pair is at ordinary peace", color));
  for (const relation of notable.slice(0, 40)) {
    const [first, second] = relation.parties;
    const detail = relation.status === "truce"
      ? `expires tick ${relation.truceUntil}`
      : relation.truceOfferBy
        ? `${NATIONS[relation.truceOfferBy]!.name} has offered a truce`
        : "";
    write(
      `  ${paint(NATIONS[first]!.name.padEnd(6), NATIONS[first]!.color, color)} ` +
      `${paint(NATIONS[second]!.name.padEnd(6), NATIONS[second]!.color, color)} ` +
      `${relation.status.padEnd(6)} trade ${relation.tradeActive ? "open  " : "closed"} ${dim(detail, color)}`,
    );
  }
}

function inspectTrade(state: WorldState): void {
  const rail = state.tradeRoutes.filter((route) => route.kind === "rail");
  const sea = state.tradeRoutes.filter((route) => route.kind === "sea");
  const trains = state.tradeVehicles.filter((vehicle) => vehicle.kind === "train");
  const ships = state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship");
  write(heading("trade network"));
  write(`  ${rail.length} rail routes (${rail.filter((route) => route.foreign).length} foreign, ${rail.filter((route) => route.allied).length} allied), ${sea.length} sea routes`);
  write(`  ${new Set(rail.flatMap((route) => route.pathIndices)).size} track cells`);
  write(`  ${trains.length} trains and ${ships.length} ships in motion`);
  write(heading("longest rail routes"));
  for (const route of [...rail].sort((a, b) => b.value - a.value).slice(0, 10)) {
    write(
      `  ${paint(NATIONS[route.owner]!.name.padEnd(6), NATIONS[route.owner]!.color, color)} ` +
      `${String(route.startIndex).padStart(6)} → ${String(route.endIndex).padStart(6)} ` +
      `${route.pathIndices.length.toString().padStart(4)} cells  value ${route.value.toFixed(1)}` +
      `${route.foreign ? dim("  foreign", color) : ""}`,
    );
  }
}

function inspectCampaigns(state: WorldState): void {
  write(heading("campaigns"));
  if (state.campaigns.length === 0) write(dim("  none active", color));
  for (const campaign of state.campaigns) {
    const target = campaign.target === "wilderness" ? "wilderness" : NATIONS[campaign.target]!.name;
    const theaters = state.theaters.filter((theater) => theater.campaignId === campaign.id);
    write(
      `  ${paint(NATIONS[campaign.attacker]!.name.padEnd(6), NATIONS[campaign.attacker]!.color, color)} → ${target.padEnd(11)} ` +
      `${campaign.mode.padEnd(6)} committed ${compactNumber(campaign.remaining).padStart(7)} ` +
      `opposed ${compactNumber(campaign.defenderRemaining).padStart(7)} ${theaters.length} theaters`,
    );
  }
}

function inspectTheaters(state: WorldState): void {
  write(heading("theaters"));
  if (state.theaters.length === 0) write(dim("  none live", color));
  for (const theater of state.theaters) {
    write(
      `  ${theater.id.padEnd(26)} value ${String(theater.strategicValue).padStart(4)} ` +
      `allocation ${compactNumber(theater.allocation).padStart(7)} ` +
      `${theater.objectiveCells.length} objectives ${theater.staleRefreshes > 0 ? dim(`stale x${theater.staleRefreshes}`, color) : ""}`,
    );
  }
}

function inspectRegions(state: WorldState): void {
  const sizes = state.strategicRegions.map((region) => region.cells.length).sort((a, b) => a - b);
  write(heading("strategic geography"));
  write(`  ${state.strategicRegions.length} regions, last repartition at tick ${state.strategicMeta.updatedAt}`);
  write(`  area  min ${sizes[0] ?? 0}  median ${sizes[Math.floor(sizes.length / 2)] ?? 0}  max ${sizes.at(-1) ?? 0}`);
  const unassigned = state.regionByCell.filter((region, index) =>
    region < 0 && state.cells[index]!.terrain !== "water").length;
  write(`  ${unassigned} land cells unassigned`);
}

function inspectEconomy(state: WorldState): void {
  write(heading("economy"));
  for (const id of NATION_ORDER) {
    const faction = state.factions[id];
    write(
      `  ${paint(NATIONS[id]!.name.padEnd(6), NATIONS[id]!.color, color)} ` +
      `gold ${compactNumber(faction.gold).padStart(8)} ` +
      `income ${compactNumber(faction.goldRate).padStart(7)}/tick ` +
      `population ${compactNumber(faction.troops).padStart(7)}/${compactNumber(faction.troopCap)} ` +
      `away ${compactNumber(committedTroopsFor(state, id)).padStart(7)} ` +
      `losses ${compactNumber(faction.casualties).padStart(8)}`,
    );
  }
}

function inspectStructures(state: WorldState): void {
  write(heading("structures"));
  for (const id of NATION_ORDER) {
    const faction = state.factions[id];
    write(
      `  ${paint(NATIONS[id]!.name.padEnd(6), NATIONS[id]!.color, color)} ` +
      `cities ${String(faction.structures.city).padStart(3)} ` +
      `factories ${String(faction.structures.factory).padStart(3)} ` +
      `harbors ${String(faction.structures.harbor).padStart(3)} ` +
      `forts ${String(faction.structures.fort).padStart(3)} ` +
      `warships ${String(faction.warships).padStart(3)} ` +
      `elements ${faction.absorbedElements.join(", ")}`,
    );
  }
}

function inspectStories(state: WorldState): void {
  write(heading("story arcs"));
  for (const story of latestStories(state.stories).slice(0, 12)) {
    write(`  ${story.importance.padEnd(8)} ${story.kind.padEnd(12)} ${story.status.padEnd(10)} ${story.headline}`);
    write(dim(`    ${story.summary}`, color));
  }
}

const INSPECTORS: Record<string, (state: WorldState) => void> = {
  diplomacy: inspectDiplomacy,
  trade: inspectTrade,
  campaigns: inspectCampaigns,
  theaters: inspectTheaters,
  regions: inspectRegions,
  economy: inspectEconomy,
  structures: inspectStructures,
  stories: inspectStories,
};

function commandInspect(): void {
  const subject = args.positional[0];
  const state = worldAt(600);
  write(renderHeader(state, color));
  if (subject === undefined || subject === "all") {
    for (const inspector of Object.values(INSPECTORS)) inspector(state);
    return;
  }
  const inspector = INSPECTORS[subject];
  if (!inspector) {
    throw new Error(`Unknown subject "${subject}". Use one of: ${Object.keys(INSPECTORS).join(", ")}, all.`);
  }
  inspector(state);
}

function commandSystems(): void {
  const ticks = args.integer("ticks", 900);
  const spikeMs = args.number("spike-ms", 25);
  const result = profileRun(seed, ticks, spikeMs);
  const total = result.systems.reduce((sum, system) => sum + system.totalMs, 0);

  write(bold(`${ticks} ticks in ${(result.wallMs / 1_000).toFixed(1)}s`, color));
  write(
    `  tick cost  median ${quantile(result.tickMs, 0.5).toFixed(1)}ms` +
    `  p90 ${quantile(result.tickMs, 0.9).toFixed(1)}ms` +
    `  p99 ${quantile(result.tickMs, 0.99).toFixed(1)}ms` +
    `  max ${Math.max(...result.tickMs).toFixed(0)}ms`,
  );
  write(`  ${result.tickMs.filter((ms) => ms > 250).length} ticks over 250ms, which is one missed snapshot each`);
  write("");
  write(dim(`${"system".padEnd(42)} ${"share".padStart(6)} ${"ms/tick".padStart(8)} ${"worst".padStart(8)} ${"at tick".padStart(8)} ${"spikes".padStart(7)}`, color));
  for (const system of result.systems) {
    if (system.totalMs / total < 0.001) continue;
    write(
      `${system.id.padEnd(42)} ` +
      `${((system.totalMs / total) * 100).toFixed(1).padStart(5)}% ` +
      `${(system.totalMs / ticks).toFixed(2).padStart(8)} ` +
      `${system.worstMs.toFixed(0).padStart(7)}ms ` +
      `${String(system.worstTick).padStart(8)} ` +
      `${String(system.spikes).padStart(7)}`,
    );
  }
  write(dim(`spikes are calls over ${spikeMs}ms`, color));
}

const STATUS_STYLE = {
  ok: { mark: "ok  ", hex: "#71a366" },
  silent: { mark: "SILENT", hex: "#ef6a5b" },
  inconclusive: { mark: "?   ", hex: "#c49a62" },
} as const;

function commandDoctor(): void {
  const ticks = args.integer("ticks", 1_200);
  const seeds = args.has("seed") ? [seed] : [DEFAULT_SEED, 0x5eed01];
  let silent = 0;

  for (const currentSeed of seeds) {
    const result = runDoctor(currentSeed, ticks);
    write(bold(`seed 0x${currentSeed.toString(16)} · ${ticks} ticks`, color));
    for (const check of result.checks) {
      const style = STATUS_STYLE[check.status];
      if (check.status === "silent") silent += 1;
      write(
        `  ${paint(style.mark.padEnd(6), style.hex, color)} ` +
        `${check.system.padEnd(42)} ${check.detail}`,
      );
      if (check.status === "silent") {
        write(dim(`         expected: ${check.looksFor}`, color));
      }
    }
    write("");
  }

  if (silent > 0) {
    write(paint(`${silent} system${silent > 1 ? "s are" : " is"} silent`, "#ef6a5b", color));
    process.exitCode = 1;
    return;
  }
  write(paint("every system is doing its job", "#71a366", color));
}

function commandHelp(): void {
  write(bold("sim — Elemental Frontiers from the command line", color));
  write("");
  write("  npm run sim -- <command> [flags]");
  write("");
  write(bold("commands", color));
  write("  watch                 play a world in the terminal");
  write("  map                   render the world at one tick");
  write("  events                the factual ledger, filtered");
  write("  inspect <subject>     one subsystem in detail");
  write(`                        ${Object.keys(INSPECTORS).join(", ")}, all`);
  write("  systems               per-system timing profile");
  write("  doctor                check every system is doing its job");
  write("");
  write(bold("common flags", color));
  write("  --seed 0x240823       world seed");
  write("  --tick 600            tick to advance to (map, events, inspect)");
  write("  --mode owner          map colouring: owner, terrain, regions, value");
  write("  --width 120           map width in columns");
  write("  --no-color            plain text, no escapes");
  write("");
  write(bold("examples", color));
  write(dim("  npm run sim -- watch --speed 8 --until 1200", color));
  write(dim("  npm run sim -- map --tick 900 --mode regions", color));
  write(dim("  npm run sim -- events --domain trade --limit 20", color));
  write(dim("  npm run sim -- inspect trade --tick 900", color));
  write(dim("  npm run sim -- doctor", color));
}

const COMMANDS: Record<string, () => void> = {
  watch: commandWatch,
  map: commandMap,
  events: commandEvents,
  inspect: commandInspect,
  systems: commandSystems,
  doctor: commandDoctor,
  help: commandHelp,
};

const run = COMMANDS[args.command];
if (!run) {
  process.stderr.write(`Unknown command "${args.command}".\n\n`);
  commandHelp();
  process.exitCode = 1;
} else {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
