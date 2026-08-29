/**
 * Elemental Frontiers from the command line.
 *
 * Runs the real engine with the real ordered systems -- no UI, no bundler, and
 * no installed dependencies -- so a world can be played, inspected and checked
 * from a terminal. See `sim.ts help` for the commands.
 */
import { ascensionTitle, baseDepthsOf, nextFormable, totalRealmsAbsorbed } from "../app/game/ascension";
import { committedTroopsFor } from "../app/game/campaigns";
import { ELEMENTS } from "../app/game/elements";
import {
  bloomIsOverextended,
  geyserSurging,
  geyserVenting,
  obsidianShattered,
  plasmaContainmentFailed,
} from "../app/game/powers";
import { PLAYERS, PLAYER_ORDER } from "../app/game/players";
import { ElementalWarEngine } from "../app/game/engine";
import { latestStories } from "../app/game/reporting";
import { compactNumber } from "../app/game/rules";
import type { StructureType, WorldReportEvent, WorldState } from "../app/game/types";
import { viabilityFor } from "../app/game/economics";
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
      const championTitle = champion
        ? engine.observe((state) => ascensionTitle(state.factions[champion]))
        : null;
      write(dim(
        champion
          ? `${PLAYERS[champion]!.realmName}${championTitle ? `, ${championTitle},` : ""} united the world at tick ${engine.tick}`
          : `stopped at tick ${engine.tick}`,
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
        ? `${PLAYERS[relation.truceOfferBy]!.name} has offered a truce`
        : "";
    write(
      `  ${paint(PLAYERS[first]!.name.padEnd(6), PLAYERS[first]!.color, color)} ` +
      `${paint(PLAYERS[second]!.name.padEnd(6), PLAYERS[second]!.color, color)} ` +
      `${relation.status.padEnd(6)} trade ${relation.tradeActive ? "open  " : "closed"} ${dim(detail, color)}`,
    );
  }
}

function inspectTrade(state: WorldState): void {
  const rail = state.tradeRoutes.filter((route) => route.kind === "rail");
  const sea = state.tradeRoutes.filter((route) => route.kind === "sea");
  const conduits = state.tradeRoutes.filter((route) => route.kind === "conduit");
  const trains = state.tradeVehicles.filter((vehicle) => vehicle.kind === "train");
  const ships = state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship");
  const pulses = state.tradeVehicles.filter((vehicle) => vehicle.kind === "pulse");
  const flyers = state.tradeVehicles.filter((vehicle) => vehicle.kind === "flyer");
  write(heading("trade network"));
  write(`  ${rail.length} rail routes (${rail.filter((route) => route.foreign).length} foreign, ${rail.filter((route) => route.allied).length} allied), ${conduits.length} conduits (${conduits.filter((route) => route.foreign).length} foreign), ${sea.length} sea routes`);
  write(`  ${new Set(rail.flatMap((route) => route.pathIndices)).size} track cells`);
  write(`  ${trains.length} convoys, ${ships.length} ships, ${pulses.length} pulses and ${flyers.length} flyers in motion`);
  write(heading("longest rail routes"));
  for (const route of [...rail].sort((a, b) => b.value - a.value).slice(0, 10)) {
    write(
      `  ${paint(PLAYERS[route.owner]!.name.padEnd(6), PLAYERS[route.owner]!.color, color)} ` +
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
    const target = campaign.target === "wilderness" ? "wilderness" : PLAYERS[campaign.target]!.name;
    const theaters = state.theaters.filter((theater) => theater.campaignId === campaign.id);
    write(
      `  ${paint(PLAYERS[campaign.attacker]!.name.padEnd(6), PLAYERS[campaign.attacker]!.color, color)} → ${target.padEnd(11)} ` +
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
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    write(
      `  ${paint(PLAYERS[id]!.name.padEnd(6), PLAYERS[id]!.color, color)} ` +
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
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    write(
      `  ${paint(PLAYERS[id]!.name.padEnd(6), PLAYERS[id]!.color, color)} ` +
      `cities ${String(faction.structures.city).padStart(3)} ` +
      `factories ${String(faction.structures.factory).padStart(3)} ` +
      `harbors ${String(faction.structures.harbor).padStart(3)} ` +
      `forts ${String(faction.structures.fort).padStart(3)} ` +
      `warships ${String(faction.warships).padStart(3)} ` +
      `elements ${faction.absorbedElements.join(", ")}`,
    );
  }
}

function powerMeter(state: WorldState, id: string): string {
  const faction = state.factions[id];
  const power = faction.power;
  switch (faction.expressedElement) {
    case "geyser":
      return geyserSurging(power, state.tick)
        ? "erupting"
        : geyserVenting(power, state.tick)
          ? "venting"
          : `bank ${(power.charge * 100).toFixed(0)}%`;
    case "tempest":
      return `momentum ${(power.charge * 100).toFixed(0)}%`;
    case "bloom":
      return bloomIsOverextended(power) ? "overextended" : "blooming";
    case "plasma":
      return plasmaContainmentFailed(power, state.tick) ? "containment failed" : "burning hot";
    case "obsidian":
      return obsidianShattered(power, state.tick)
        ? "shattered"
        : `fracture ${(power.charge * 100).toFixed(0)}%`;
    default:
      return "";
  }
}

function inspectElements(state: WorldState): void {
  write(heading("elements"));
  const fallen = PLAYER_ORDER.filter((id) => !state.factions[id].alive).length;
  if (fallen > 0) write(dim(`  ${fallen} realms have fallen and are not shown`, color));
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    const expressed = ELEMENTS[faction.expressedElement];
    const depths = baseDepthsOf(faction.elementCounts);
    const next = nextFormable(faction);
    const title = ascensionTitle(faction);
    write(
      `  ${paint(PLAYERS[id]!.name.padEnd(10), PLAYERS[id]!.color, color)} ` +
      `${expressed.glyph} ${expressed.name.padEnd(9)} tier ${expressed.tier}  ` +
      `depth E${String(depths.ember).padEnd(2)} T${String(depths.tide).padEnd(2)} ` +
      `S${String(depths.stone).padEnd(2)} A${String(depths.gale).padEnd(2)} ` +
      `absorbed ${String(totalRealmsAbsorbed(faction.elementCounts)).padStart(2)}  ` +
      (faction.transmutation.target
        ? `fusing → ${ELEMENTS[faction.transmutation.target].name} (${Math.max(0, faction.transmutation.completesAt - state.tick)} ticks)`
        : next
          ? next.progress > 0
            ? `next ${ELEMENTS[next.element].name} ${(next.progress * 100).toFixed(0)}%`
            : "next —"
          : "apex") +
      (title ? dim(`  ${title}`, color) : "") +
      (powerMeter(state, id) ? dim(`  ${powerMeter(state, id)}`, color) : ""),
    );
  }
}

function inspectStories(state: WorldState): void {
  // Important arcs sort first, so a mature world's page is all historic wars;
  // --kind reaches the quieter tellings (dynasty ascensions, leadership turns).
  const kind = args.flag("kind");
  const limit = args.integer("limit", 12);
  const stories = latestStories(state.stories)
    .filter((story) => !kind || story.kind === kind);
  write(heading(kind ? `story arcs · ${kind}` : "story arcs"));
  if (stories.length === 0) write(dim("  no arcs of that kind yet", color));
  for (const story of stories.slice(0, limit)) {
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
  elements: inspectElements,
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
  write(dim("  npm run sim -- inspect stories --kind dynasty --tick 1200", color));
  write(dim("  npm run sim -- doctor", color));
  write(dim("  npm run sim -- viability --tick 1200 --seeds 0x240823,0x5eed01", color));
}

/**
 * What each kind of building was worth, and whether the winner agreed.
 *
 * Built for playtesting a balance question that counts alone cannot answer: if
 * harbours return more per gold than factories but nobody builds them, is that
 * the planner misreading the game or the game misreading itself? The leader
 * column is the point -- a building that pays well across the roster but that
 * the leading realm ignores is a different problem from one nobody can afford.
 */
function commandViability(): void {
  const color = wantsColor(args);
  const ticks = args.integer("tick", 1200);
  const seeds = (args.flag("seeds") ?? String(DEFAULT_SEED)).split(",").map((s) => Number(s.trim()));
  const structures: StructureType[] = ["city", "factory", "harbor", "fort"];

  interface Totals { spent: number; earned: number; runs: number; standing: number }
  const make = (): Totals => ({ spent: 0, earned: 0, runs: 0, standing: 0 });
  const roster = new Map<StructureType, Totals>(structures.map((s) => [s, make()]));
  const leaders = new Map<StructureType, Totals>(structures.map((s) => [s, make()]));
  let landTotal = 0;
  let leaderLand = 0;
  const leaderNames: string[] = [];

  for (const seed of seeds) {
    const engine = new ElementalWarEngine(seed);
    engine.advance(ticks);
    const state = engine.snapshot();
    // The leader by territory stands in for the victor: most runs have not
    // resolved a champion by the horizon a playtest can afford to watch.
    let leader = PLAYER_ORDER[0]!;
    for (const id of PLAYER_ORDER) {
      if (state.factions[id]!.territory > state.factions[leader]!.territory) leader = id;
    }
    leaderNames.push(`${PLAYERS[leader]!.realmName} (${state.factions[leader]!.territory} tiles)`);

    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id]!;
      landTotal += faction.economy.land;
      if (id === leader) leaderLand += faction.economy.land;
      for (const entry of viabilityFor(state, id)) {
        for (const bucket of id === leader ? [roster, leaders] : [roster]) {
          const totals = bucket.get(entry.structure)!;
          totals.spent += entry.spent;
          totals.earned += entry.earned;
          totals.runs += entry.runs;
          totals.standing += faction.structures[entry.structure];
        }
      }
    }
  }

  write("");
  write(bold(`building economics over ${seeds.length} seed(s) to tick ${ticks}`, color));
  write(dim(`leader: ${leaderNames.join(", ")}`, color));
  write("");
  write(dim("                 ---------- whole roster ----------   ------- leading realm -------", color));
  write(bold("structure         spent    earned   return  per bld     spent    earned   return", color));
  write("-".repeat(80));

  const money = (value: number): string => `${(value / 1e6).toFixed(1)}M`;
  for (const structure of structures) {
    const all = roster.get(structure)!;
    const top = leaders.get(structure)!;
    const ret = (t: Totals): string => (t.spent > 0 ? `${(t.earned / t.spent).toFixed(1)}x` : "—");
    const per = all.standing > 0 ? money(all.earned / all.standing) : "—";
    write(
      `${structure.padEnd(12)}${money(all.spent).padStart(9)}${money(all.earned).padStart(10)}`
      + `${ret(all).padStart(9)}${per.padStart(9)}`
      + `${money(top.spent).padStart(10)}${money(top.earned).padStart(10)}${ret(top).padStart(9)}`,
    );
  }
  write("-".repeat(80));
  write(`${"land".padEnd(12)}${"—".padStart(9)}${money(landTotal).padStart(10)}${"—".padStart(9)}${"—".padStart(9)}`
    + `${"—".padStart(10)}${money(leaderLand).padStart(10)}`);
  write("");

  const best = structures
    .filter((s) => roster.get(s)!.spent > 0 && roster.get(s)!.earned > 0)
    .sort((a, b) => roster.get(b)!.earned / roster.get(b)!.spent - roster.get(a)!.earned / roster.get(a)!.spent);
  if (best.length > 0) {
    const top = best[0]!;
    const totals = roster.get(top)!;
    write(dim(
      `best return: ${top} at ${(totals.earned / totals.spent).toFixed(1)}x, `
      + `${totals.standing} standing across the roster`,
      color,
    ));
  }
  write("");
}

const COMMANDS: Record<string, () => void> = {
  watch: commandWatch,
  map: commandMap,
  events: commandEvents,
  inspect: commandInspect,
  systems: commandSystems,
  doctor: commandDoctor,
  viability: commandViability,
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
