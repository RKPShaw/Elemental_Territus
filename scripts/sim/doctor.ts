import { PLAYER_ORDER } from "../../app/game/players";
import { expressionFor } from "../../app/game/ascension";
import { baseMaskOf } from "../../app/game/elements";
import { ElementalWarEngine } from "../../app/game/engine";
import { ACTION_REPORT_KINDS } from "../../app/game/reporting";
import type { ReportEventKind, WorldState } from "../../app/game/types";

/**
 * `silent` is the only failing state. `inconclusive` covers systems whose
 * evidence legitimately may not appear inside the horizon -- a champion, for
 * instance -- and which should not turn a healthy run red.
 */
export type CheckStatus = "ok" | "silent" | "inconclusive";

export interface SystemCheck {
  system: string;
  looksFor: string;
  detail: string;
  status: CheckStatus;
}

export interface DoctorResult {
  seed: number;
  ticks: number;
  checks: SystemCheck[];
}

/** Evidence gathered while a world runs, so each system can be judged after. */
interface Evidence {
  kindCounts: Map<string, number>;
  relationTransitions: number;
  truceExpiries: number;
  earningIncome: number;
  populationGrew: boolean;
  regionsChanged: boolean;
  geographyUpdatedAt: number;
  commandsDrained: boolean;
  dominantObserved: boolean;
  champion: string | null;
  finalState: WorldState;
}

const COMMAND_REPORT_KINDS = new Set<string>(
  Object.values(ACTION_REPORT_KINDS).flat() as readonly ReportEventKind[],
);

function countKinds(state: WorldState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of state.reports) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  return counts;
}

/** Cheap fingerprint of the region partition, to notice it moving. */
function regionFingerprint(state: WorldState): number {
  let hash = 0;
  for (let index = 0; index < state.regionByCell.length; index += 97) {
    hash = (hash * 31 + (state.regionByCell[index] ?? -1)) | 0;
  }
  return hash;
}

function gather(seed: number, ticks: number, sampleEvery: number): Evidence {
  const engine = new ElementalWarEngine(seed);
  let previousStatuses = new Map<string, string>();
  let previousFingerprint = 0;
  let firstFingerprint: number | null = null;
  let relationTransitions = 0;
  let truceExpiries = 0;
  let regionsChanged = false;
  let dominantObserved = false;
  let commandsDrained = true;

  const initial = engine.snapshot();
  const startingTroops = PLAYER_ORDER.reduce((sum, id) => sum + initial.factions[id].troops, 0);
  for (const relation of Object.values(initial.relations)) {
    previousStatuses.set(relation.key, relation.status);
  }

  for (let elapsed = 0; elapsed < ticks; elapsed += sampleEvery) {
    engine.advance(Math.min(sampleEvery, ticks - elapsed));
    const sampled = engine.observe((state) => {
      const statuses = new Map<string, string>();
      let transitions = 0;
      let expiries = 0;
      for (const relation of Object.values(state.relations)) {
        statuses.set(relation.key, relation.status);
        const before = previousStatuses.get(relation.key);
        if (before !== undefined && before !== relation.status) {
          transitions += 1;
          if (before === "truce") expiries += 1;
        }
      }
      return {
        statuses,
        transitions,
        expiries,
        fingerprint: regionFingerprint(state),
        dominant: state.dominantSince !== null,
        pendingCommands: state.commands.length,
      };
    });
    previousStatuses = sampled.statuses;
    relationTransitions += sampled.transitions;
    truceExpiries += sampled.expiries;
    if (firstFingerprint === null) firstFingerprint = sampled.fingerprint;
    else if (sampled.fingerprint !== previousFingerprint) regionsChanged = true;
    previousFingerprint = sampled.fingerprint;
    if (sampled.dominant) dominantObserved = true;
    // Commands are queued and executed within the same tick, so a sample taken
    // between ticks should never find a backlog.
    if (sampled.pendingCommands > 0) commandsDrained = false;
  }

  const finalState = engine.snapshot();
  return {
    kindCounts: countKinds(finalState),
    relationTransitions,
    truceExpiries,
    earningIncome: PLAYER_ORDER.filter(
      (id) => finalState.factions[id].alive && finalState.factions[id].goldRate > 0,
    ).length,
    populationGrew: PLAYER_ORDER.reduce((sum, id) => sum + finalState.factions[id].troops, 0) > startingTroops,
    regionsChanged,
    geographyUpdatedAt: finalState.strategicMeta.updatedAt,
    commandsDrained,
    dominantObserved,
    champion: finalState.champion,
    finalState,
  };
}

/** Territory bookkeeping must agree with the map it claims to summarise. */
function accountingAgreesWithMap(state: WorldState): { ok: boolean; detail: string } {
  const owned = new Map<string, number>();
  for (const cell of state.cells) {
    if (!cell.owner) continue;
    owned.set(cell.owner, (owned.get(cell.owner) ?? 0) + 1);
  }
  const mismatches = PLAYER_ORDER.filter(
    (id) => (owned.get(id) ?? 0) !== state.factions[id].territory,
  );
  return mismatches.length === 0
    ? { ok: true, detail: `territory matches owned cells for all ${PLAYER_ORDER.length} realms` }
    : { ok: false, detail: `territory disagrees with the map for ${mismatches.join(", ")}` };
}

export function runDoctor(seed: number, ticks: number): DoctorResult {
  const evidence = gather(seed, ticks, 30);
  const count = (kind: string) => evidence.kindCounts.get(kind) ?? 0;
  const checks: SystemCheck[] = [];

  const add = (
    system: string,
    looksFor: string,
    ok: boolean,
    detail: string,
    inconclusive = false,
  ) => {
    checks.push({ system, looksFor, detail, status: ok ? "ok" : inconclusive ? "inconclusive" : "silent" });
  };

  const state = evidence.finalState;

  add(
    "world-clock",
    "tick and age advance",
    state.tick >= ticks && state.age >= 1,
    `reached tick ${state.tick}, age ${state.age}`,
  );

  add(
    "diplomacy-clock",
    "relations change status over time",
    evidence.relationTransitions > 0,
    `${evidence.relationTransitions} status transitions, ${evidence.truceExpiries} alliances ended`,
  );

  const accounting = accountingAgreesWithMap(state);
  add("realm-accounting", "territory tracks owned cells", accounting.ok, accounting.detail);

  add(
    "troop-and-gold-economy",
    "realms earn income and populations grow",
    evidence.earningIncome > 0 && evidence.populationGrew,
    // Income rather than treasury: players that invest heavily in
    // infrastructure legitimately hold less gold than they started with.
    `${evidence.earningIncome} realms earning income, population ${evidence.populationGrew ? "grew" : "did not grow"}`,
  );

  const railRoutes = state.tradeRoutes.filter((route) => route.kind === "rail").length;
  const journeys = count("trade.journey-completed");
  const stops = count("trade.train-stop-served");
  add(
    "trade-network",
    "rail routes carry vehicles that complete journeys",
    railRoutes > 0 && journeys > 0 && stops > 0,
    `${railRoutes} rail routes, ${journeys} journeys completed, ${stops} station stops`,
  );

  // The exclusive carriers get their own proofs: with a dozen energy realms
  // and a dozen airborne realms seated in every world, silence from either
  // network means the carrier is broken, not merely unlucky.
  const journeysByKind = (kind: string) => state.reports.filter(
    (event) => event.kind === "trade.journey-completed" && event.facts.vehicleKind === kind,
  ).length;
  const conduits = state.tradeRoutes.filter((route) => route.kind === "conduit").length;
  const plants = PLAYER_ORDER.reduce((sum, id) => sum + state.factions[id].structures.plant, 0);
  const pulses = journeysByKind("pulse");
  add(
    "energy-conduits",
    "plants string conduits and deliver pulses",
    conduits > 0 && pulses > 0,
    `${plants} plants, ${conduits} conduits, ${pulses} pulses delivered`,
    plants === 0,
  );
  const skyports = PLAYER_ORDER.reduce((sum, id) => sum + state.factions[id].structures.skyport, 0);
  const flights = journeysByKind("flyer");
  add(
    "air-transport",
    "skyports fly freight between each other",
    flights > 0,
    `${skyports} skyports, ${flights} flights completed`,
    skyports < 2,
  );

  // Focus changes are the system's characteristic activity: baselines differ
  // by family from tick zero, but only situation ever moves a focus.
  const strategyShifts = count("leadership.strategy-adopted");
  add(
    "strategic-planning",
    "realms change strategic focus as situations change",
    strategyShifts > 0,
    `${strategyShifts} focus changes reported`,
  );

  // Two proofs, one per failure mode. Bookkeeping: recomputing every living
  // realm's expression and base mask from its tallies must change nothing,
  // because the system claims to keep them current every tick. Activity: an
  // ascension reported inside the horizon; a run where no realm assembled a
  // deep enough history is inconclusive rather than sick.
  const ascensions = count("dynasty.element-ascended");
  let expressionLag = 0;
  let maskDrift = 0;
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    if (expressionFor(faction) !== faction.expressedElement) expressionLag += 1;
    if (baseMaskOf(faction.absorbedElements) !== faction.baseMask) maskDrift += 1;
  }
  const ascensionBooksExact = expressionLag === 0 && maskDrift === 0;
  add(
    "element-ascension",
    "absorbed histories express higher elements",
    ascensionBooksExact && ascensions > 0,
    ascensionBooksExact
      ? `${ascensions} ascensions reported, expression and base masks exact across the living roster`
      : `${expressionLag} realms lag their formable expression, ${maskDrift} base masks drifted`,
    ascensionBooksExact,
  );

  const wars = count("diplomacy.war-declared");
  const alliances = count("diplomacy.alliance-formed");
  add(
    "diplomacy-ai",
    "realms declare war and form alliances",
    wars > 0 || alliances > 0,
    `${wars} wars declared, ${alliances} alliances formed`,
  );

  const campaigns = count("military.campaign-launched");
  add(
    "military-strategy-ai",
    "campaigns are launched",
    campaigns > 0,
    `${campaigns} campaigns launched, ${count("military.campaign-reinforced")} reinforced`,
  );

  const built = count("infrastructure.structure-built");
  add(
    "construction-ai",
    "structures get built",
    built > 0,
    `${built} structures built`,
  );

  const commandBacked = [...evidence.kindCounts]
    .filter(([kind]) => COMMAND_REPORT_KINDS.has(kind))
    .reduce((sum, [, value]) => sum + value, 0);
  add(
    "command-execution",
    "queued commands execute and report",
    commandBacked > 0 && evidence.commandsDrained,
    `${commandBacked} command-backed reports, queue ${evidence.commandsDrained ? "always drained" : "left a backlog"}`,
  );

  add(
    "adaptive-equal-area-strategic-geography",
    "the partition repartitions and moves",
    evidence.geographyUpdatedAt > 0 && evidence.regionsChanged,
    `${state.strategicRegions.length} regions, last repartition at tick ${evidence.geographyUpdatedAt}, boundaries ${evidence.regionsChanged ? "moved" : "never moved"}`,
  );

  // Beliefs are only ever written by the observation system, so a roster that
  // has looked at ground and has ageing readings is the whole proof it ran.
  // Both halves matter: everything fresh would mean the fog is not working,
  // and nothing observed would mean nobody is looking.
  let observedRegions = 0;
  let stalest = 0;
  for (const store of Object.values(state.theaterMap.byPlayer)) {
    for (const seenAt of store.observedAt) {
      if (seenAt < 0) continue;
      observedRegions += 1;
      stalest = Math.max(stalest, state.tick - seenAt);
    }
  }
  add(
    "theater-map-observation",
    "players form and age beliefs about ground",
    observedRegions > 0 && stalest > 0,
    `${observedRegions} region beliefs held across the roster, oldest ${stalest} ticks stale`,
  );

  const theaters = count("military.theater-formed");
  add(
    "persistent-geographic-theaters",
    "theaters form around campaigns",
    theaters > 0,
    `${theaters} theaters formed, ${state.theaters.length} currently live`,
  );

  const concluded = count("military.campaign-concluded") + count("military.theater-victory");
  add(
    "target-campaign-theater-advance",
    "campaigns advance to a conclusion",
    concluded > 0,
    `${concluded} campaigns or theaters resolved, ${count("territory.structure-captured")} structures captured`,
  );

  add(
    "victory-watch",
    "dominance is tracked and a champion is named",
    evidence.champion !== null || evidence.dominantObserved,
    evidence.champion
      ? `champion ${evidence.champion}`
      : evidence.dominantObserved
        ? "dominance observed, no champion inside the horizon"
        : "no realm approached dominance inside the horizon",
    true,
  );

  add(
    "historical-story-correlator",
    "facts correlate into story arcs",
    state.stories.length > 0,
    `${state.stories.length} story arcs from ${state.reports.length} facts`,
  );

  return { seed, ticks, checks };
}
