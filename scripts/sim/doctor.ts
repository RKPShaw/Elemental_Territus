import { PLAYER_ORDER } from "../../app/game/players";
import { fusionTargetFor } from "../../app/game/ascension";
import { ELEMENTS, baseMaskOf } from "../../app/game/elements";
import { ElementalWarEngine } from "../../app/game/engine";
import {
  hasSwiftSight,
  mirageDistortionFor,
  mistVeilFor,
  regionIntelligence,
} from "../../app/game/information";
import { ACTION_REPORT_KINDS } from "../../app/game/reporting";
import { TERRAIN_RULES, THEATER_MAP_RULES } from "../../app/game/rules";
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

  // Two proofs, one per failure mode. Bookkeeping: no living idle realm may
  // sit on an eligible fusion (the system claims to open windows the tick
  // conquest makes them eligible), every open window must be well-formed and
  // aimed exactly one rung up, and base masks must recompute exactly.
  // Activity: a transmutation begun or completed inside the horizon; a run
  // where no conquest assembled the constituents is inconclusive, not sick.
  const ascensions = count("dynasty.element-ascended");
  const transmutations = count("dynasty.transmutation-begun");
  let pendingIdle = 0;
  let malformedWindows = 0;
  let maskDrift = 0;
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    const window = faction.transmutation;
    if (window.target === null) {
      if (fusionTargetFor(faction) !== null) pendingIdle += 1;
    } else if (
      window.startedAt < 0
      || window.completesAt <= window.startedAt
      || ELEMENTS[window.target].tier !== ELEMENTS[faction.expressedElement].tier + 1
    ) {
      malformedWindows += 1;
    }
    if (baseMaskOf(faction.absorbedElements) !== faction.baseMask) maskDrift += 1;
  }
  const fusionBooksExact = pendingIdle === 0 && malformedWindows === 0 && maskDrift === 0;
  add(
    "element-ascension",
    "conquest-held constituents fuse through transmutation windows",
    fusionBooksExact && (transmutations > 0 || ascensions > 0),
    fusionBooksExact
      ? `${transmutations} windows opened, ${ascensions} fusions completed, books exact across the living roster`
      : `${pendingIdle} idle realms sit on an eligible fusion, ${malformedWindows} malformed windows, ${maskDrift} base masks drifted`,
    fusionBooksExact,
  );

  // Dwell terraforming. Invariants that can genuinely fail: every cell's
  // terrain must still have a rules entry, and every living realm's
  // saturation must sit inside [0, 1]. Activity: land transformed inside the
  // horizon — dwell thresholds start at 3,000 ticks, beyond this horizon on
  // an unstaked world, so silence is inconclusive rather than sick.
  const landTransforms = count("society.land-transformed");
  let unknownTerrain = 0;
  for (const cell of state.cells) {
    if (!TERRAIN_RULES[cell.terrain]) unknownTerrain += 1;
  }
  let saturationDrift = 0;
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    if (!(faction.saturation >= 0 && faction.saturation <= 1)) saturationDrift += 1;
  }
  const terraformBooksExact = unknownTerrain === 0 && saturationDrift === 0;
  add(
    "dwell-terraforming",
    "long tenure transforms the ground it holds",
    terraformBooksExact && landTransforms > 0,
    terraformBooksExact
      ? `${landTransforms} transform reports, terrain table and saturation exact`
      : `${unknownTerrain} cells hold unknown terrain, ${saturationDrift} saturations out of band`,
    terraformBooksExact,
  );

  // The naming system: founding names must be unique, and by the horizon at
  // least one realm should have earned a better title — conquest, ascension
  // styling and union all funnel through the same rename report.
  const renames = count("dynasty.realm-renamed");
  const namingIds = new Set(PLAYER_ORDER.map((id) => state.factions[id].identity.name));
  add(
    "realm-naming",
    "unique founding names that climb the title ladder",
    namingIds.size === PLAYER_ORDER.length && renames > 0,
    `${namingIds.size}/${PLAYER_ORDER.length} unique names, ${renames} renames recorded`,
  );

  // The bespoke tier 3 mechanics. One invariant line can genuinely fail:
  // every living realm's power meter must sit inside its band. The
  // per-mechanic lines are evidence lines — each mechanic's drama is
  // conditional on a realm expressing its element and meeting its trigger
  // inside the horizon, so silence there is inconclusive, never sick.
  let meterViolations = 0;
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    const power = faction.power;
    if (
      !(power.charge >= 0 && power.charge <= 1)
      || power.releasedAt > state.tick
      || power.tally > faction.capturedTiles
    ) meterViolations += 1;
  }
  add(
    "element-powers",
    "power meters stay inside their bands",
    meterViolations === 0,
    meterViolations === 0
      ? "every living realm's meter is in [0, 1] with sane bookkeeping"
      : `${meterViolations} realms hold a meter outside its band`,
  );
  const expressedCount = (element: string) => state.reports.filter(
    (event) => event.kind === "dynasty.element-ascended" && event.facts.to === element,
  ).length;
  const powerLines = [
    ["geyser", "dynasty.geyser-erupted", "banked pressure erupts into a war"],
    ["tempest", "dynasty.tempest-crested", "conquest momentum crests"],
    ["bloom", "dynasty.bloom-overextended", "overgrowth outruns its people"],
    ["plasma", "dynasty.plasma-containment-failed", "a drained treasury fails containment"],
    ["obsidian", "dynasty.obsidian-shattered", "sustained siege shatters the edge"],
  ] as const;
  for (const [element, kind, looksFor] of powerLines) {
    const fired = count(kind);
    const expressed = expressedCount(element);
    add(
      `element-powers/${element}`,
      looksFor,
      fired > 0,
      `${expressed} realms expressed ${element}, ${fired} ${element} power events`,
      fired === 0,
    );
  }

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

  // The information identities live on the belief layer, so their proof is a
  // belief asymmetry. Swift sight always has evidence — a dozen airborne
  // realms are seated in every world — and the assertion reads only current
  // beliefs (fresher than one interval), so lost contact from an earlier age
  // cannot pollute the comparison. The mist and mirage lines are evidence
  // lines like the bespoke powers': their drama waits on a realm expressing
  // the element, so silence there is inconclusive, never sick.
  let swiftAgeTotal = 0;
  let swiftAgeCount = 0;
  let ordinaryAgeTotal = 0;
  let ordinaryAgeCount = 0;
  for (const id of PLAYER_ORDER) {
    const faction = state.factions[id];
    if (!faction.alive) continue;
    const swift = hasSwiftSight(faction.expressedElement);
    for (const seenAt of state.theaterMap.byPlayer[id]!.observedAt) {
      if (seenAt < 0) continue;
      const age = state.tick - seenAt;
      if (age >= THEATER_MAP_RULES.observationInterval) continue;
      if (swift) {
        swiftAgeTotal += age;
        swiftAgeCount += 1;
      } else {
        ordinaryAgeTotal += age;
        ordinaryAgeCount += 1;
      }
    }
  }
  const swiftMean = swiftAgeTotal / Math.max(1, swiftAgeCount);
  const ordinaryMean = ordinaryAgeTotal / Math.max(1, ordinaryAgeCount);
  add(
    "theater-map-observation/swift-sight",
    "airborne and glass realms hold fresher beliefs",
    swiftAgeCount > 0 && ordinaryAgeCount > 0 && swiftMean < ordinaryMean,
    `swift realms' current beliefs average ${swiftMean.toFixed(1)} ticks stale over ${swiftAgeCount}, the rest ${ordinaryMean.toFixed(1)} over ${ordinaryAgeCount}`,
    swiftAgeCount === 0 || ordinaryAgeCount === 0,
  );

  const expressing = (element: string) => PLAYER_ORDER.filter(
    (id) => state.factions[id].alive && state.factions[id].expressedElement === element,
  ).length;
  const living = PLAYER_ORDER.filter((id) => state.factions[id].alive);
  const mistRealms = expressing("mist");
  let veiledMeasurements = 0;
  if (mistRealms > 0) {
    for (let regionId = 0; regionId < state.strategicRegions.length; regionId += 1) {
      for (const observer of living) {
        if (mistVeilFor(state, observer, regionId) > 0) veiledMeasurements += 1;
      }
    }
  }
  add(
    "theater-map-observation/mist",
    "a veil keeps rivals' measurements of mist ground stale",
    veiledMeasurements > 0,
    `${mistRealms} realms express mist, ${veiledMeasurements} rival measurements veiled`,
    mistRealms === 0,
  );

  const mirageRealms = expressing("mirage");
  let distortedReadings = 0;
  let collapsedReadings = 0;
  if (mirageRealms > 0) {
    const { pluralityOwner } = regionIntelligence(state);
    for (let regionId = 0; regionId < state.strategicRegions.length; regionId += 1) {
      const illusionist = pluralityOwner[regionId];
      if (!illusionist || state.factions[illusionist].expressedElement !== "mirage") continue;
      for (const viewer of living) {
        if (viewer === illusionist) continue;
        if (mirageDistortionFor(state, viewer, regionId, "prize") !== 1) distortedReadings += 1;
        else collapsedReadings += 1;
      }
    }
  }
  add(
    "theater-map-observation/mirage",
    "rivals believe distorted prize and openness of mirage ground",
    distortedReadings > 0,
    `${mirageRealms} realms express mirage, ${distortedReadings} rival readings distorted, ${collapsedReadings} collapsed by corroboration`,
    mirageRealms === 0,
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
