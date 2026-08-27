import { availableParallelism } from "node:os";
import { writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { DEFAULT_BATCH_CHECKPOINTS } from "../app/game/batch";
import type { BatchGameResult } from "../app/game/batch";
import { ELEMENT_ORDER, ELEMENTS } from "../app/game/elements";
import { PLAYER_ORDER, playerElement } from "../app/game/players";

interface Arguments {
  games: number;
  maximumTicks: number;
  workers: number;
  output: string | null;
}

function parseArguments(): Arguments {
  const valueAfter = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  return {
    games: Math.max(1, Number(valueAfter("--games") ?? 100)),
    maximumTicks: Math.max(1, Number(valueAfter("--max-ticks") ?? 7_200)),
    workers: Math.max(1, Number(valueAfter("--workers") ?? Math.min(8, availableParallelism()))),
    output: valueAfter("--output") ?? null,
  };
}

function seedFor(index: number): number {
  let value = (0x240823 + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * share)))]!;
}

function rounded(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function runWorker(
  seeds: number[],
  maximumTicks: number,
  checkpointTicks: number[],
): Promise<BatchGameResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./batch-sim-worker.ts", import.meta.url), {
      workerData: { seeds, maximumTicks, checkpointTicks },
      // Workers do not inherit execArgv, so each one re-applies the loader that
      // lets the TypeScript sources run without an install.
      execArgv: [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        new URL("./ts-loader.mjs", import.meta.url).href,
      ],
    });
    worker.once("message", (results: BatchGameResult[]) => resolve(results));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Batch worker exited with code ${code}.`));
    });
  });
}

const args = parseArguments();
const seeds = Array.from({ length: args.games }, (_, index) => seedFor(index));
const checkpointTicks = DEFAULT_BATCH_CHECKPOINTS.filter((tick) => tick <= args.maximumTicks);
if (checkpointTicks.at(-1) !== args.maximumTicks) checkpointTicks.push(args.maximumTicks);
const workerCount = Math.min(args.workers, seeds.length);
const groups = Array.from({ length: workerCount }, () => [] as number[]);
seeds.forEach((seed, index) => groups[index % workerCount]!.push(seed));

const wallStarted = performance.now();
const results = (await Promise.all(
  groups.map((group) => runWorker(group, args.maximumTicks, checkpointTicks)),
)).flat().sort((first, second) => first.seed - second.seed);
const wallRuntimeMs = performance.now() - wallStarted;

const completionTicks = results.flatMap((result) => result.completionTick ?? []);
const checkpointSummary = checkpointTicks.map((tick) => {
  const samples = results.flatMap((result) => {
    const exact = result.checkpoints.find((checkpoint) => checkpoint.requestedTick === tick);
    return exact ? [exact.snapshot] : [];
  });
  const players = samples.flatMap((sample) => PLAYER_ORDER.map((id) => sample.players[id]));
  const structureSpend = mean(samples.map((sample) => sample.structureSpend));
  const tradeIncome = mean(samples.map((sample) => sample.trainIncome + sample.shipIncome));
  const ratioOfLifetime = (
    numerator: (player: (typeof players)[number]) => number,
  ) => {
    const lived = players.reduce((sum, player) => sum + player.cumulative.ticksAlive, 0);
    return lived > 0
      ? players.reduce((sum, player) => sum + numerator(player), 0) / lived
      : 0;
  };
  const cityCaptures = mean(samples.map((sample) => sample.citiesCaptured));
  const cityBuilds = mean(samples.map((sample) => sample.citiesBuilt));
  const domesticStops = mean(samples.map((sample) => PLAYER_ORDER.reduce(
    (sum, id) => sum + sample.players[id].cumulative.domesticStopsServed,
    0,
  )));
  const foreignStops = mean(samples.map((sample) => PLAYER_ORDER.reduce(
    (sum, id) => sum + sample.players[id].cumulative.foreignStopsServed,
    0,
  )));
  return {
    minute: tick / 60,
    gamesSampled: samples.length,
    gamesResolvedByThen: results.filter(
      (result) => result.completionTick !== null && result.completionTick <= tick,
    ).length,
    settledPct: rounded(mean(samples.map((sample) => sample.settledShare)) * 100),
    aliveRealms: rounded(mean(samples.map((sample) => sample.aliveRealms)), 2),
    tier2RealmsAlive: rounded(mean(samples.map((sample) => sample.tierCounts["2"])), 2),
    tier3RealmsAlive: rounded(mean(samples.map((sample) => sample.tierCounts["3"])), 2),
    ascensionsPerWorld: rounded(mean(samples.map((sample) => PLAYER_ORDER.reduce(
      (sum, id) => sum + sample.players[id].cumulative.ascensions,
      0,
    ))), 2),
    leaderLandSharePct: rounded(mean(samples.map((sample) => sample.leaderLandShare)) * 100),
    landConcentrationHhi: rounded(mean(samples.map((sample) => sample.landConcentrationHhi)), 3),
    treasuryGini: rounded(mean(samples.map((sample) => sample.treasuryGini)), 3),
    homePopulationPerRealm: rounded(mean(players.map((player) => player.homePopulation))),
    committedPopulationPerRealm: rounded(mean(players.map((player) => player.committedPopulation))),
    populationCapPerRealm: rounded(mean(players.map((player) => player.populationCap))),
    homeRatioPct: rounded(mean(players.map((player) => player.homeRatio)) * 100),
    growthEfficiencyPct: rounded(mean(players.map((player) => player.growthEfficiency)) * 100),
    lifetimeBelow20Pct: rounded(ratioOfLifetime((player) => player.cumulative.ticksPopulationBelow20) * 100),
    lifetimeNearPeakPct: rounded(ratioOfLifetime((player) => player.cumulative.ticksPopulationNearPeak) * 100),
    lifetimeOver82Pct: rounded(ratioOfLifetime((player) => player.cumulative.ticksPopulationOver82) * 100),
    lifetimeCommittedCapPct: rounded(
      ratioOfLifetime((player) => player.cumulative.committedRatioTotal) * 100,
    ),
    citiesOwnedPerRealm: rounded(mean(samples.map((sample) => sample.structuresOwned.city)) / PLAYER_ORDER.length),
    citySitesOwnedPerRealm: rounded(mean(samples.map((sample) => sample.citySitesOwned)) / PLAYER_ORDER.length),
    cityLevelsBuiltPerRealm: rounded(mean(samples.map((sample) => sample.citiesBuilt)) / PLAYER_ORDER.length),
    citySitesBuiltPerRealm: rounded(mean(samples.map((sample) => sample.citySitesBuilt)) / PLAYER_ORDER.length),
    cityLevelsCapturedPerRealm: rounded(mean(samples.map((sample) => sample.citiesCaptured)) / PLAYER_ORDER.length),
    citySitesCapturedPerRealm: rounded(mean(samples.map((sample) => sample.citySitesCaptured)) / PLAYER_ORDER.length),
    cityLevelsLostPerRealm: rounded(mean(samples.map((sample) => sample.citiesLost)) / PLAYER_ORDER.length),
    capturedShareOfDevelopedCitiesPct: cityBuilds + cityCaptures > 0
      ? rounded(cityCaptures / (cityBuilds + cityCaptures) * 100)
      : 0,
    stackedCityLevelsPerRealm: rounded(mean(samples.map((sample) => sample.stackedCityLevelsOwned)) / PLAYER_ORDER.length),
    factoriesPerRealm: rounded(mean(samples.map((sample) => sample.structuresOwned.factory)) / PLAYER_ORDER.length),
    harborsPerRealm: rounded(mean(samples.map((sample) => sample.structuresOwned.harbor)) / PLAYER_ORDER.length),
    fortsPerRealm: rounded(mean(samples.map((sample) => sample.structuresOwned.fort)) / PLAYER_ORDER.length),
    structureSpendPerWorld: rounded(structureSpend),
    nominalPassiveIncomePerWorld: rounded(mean(samples.map((sample) => sample.nominalPassiveIncome))),
    trainIncomePerWorld: rounded(mean(samples.map((sample) => sample.trainIncome))),
    shipIncomePerWorld: rounded(mean(samples.map((sample) => sample.shipIncome))),
    resonantShipVoyagesPerWorld: rounded(mean(samples.map((sample) => PLAYER_ORDER.reduce(
      (sum, id) => sum + sample.players[id].cumulative.resonantVoyagesHosted,
      0,
    )))),
    // The per-family income split: whether the trade-form rewards actually
    // land on the families that hold the forms.
    tradeIncomePerRealmByFamily: Object.fromEntries(ELEMENT_ORDER.map((element) => [
      ELEMENTS[element].name,
      rounded(mean(samples.map((sample) => {
        const members = PLAYER_ORDER.filter((id) => playerElement(id) === element);
        return members.reduce((sum, id) => {
          const trade = sample.players[id].cumulative;
          return sum
            + trade.trainIncomeEarned + trade.trainIncomeHosted
            + trade.shipIncomeEarned + trade.shipIncomeHosted;
        }, 0) / Math.max(1, members.length);
      }))),
    ])),
    tradeToStructureSpendRatio: structureSpend > 0 ? rounded(tradeIncome / structureSpend, 2) : 0,
    domesticTrainStopsPerWorld: rounded(domesticStops),
    foreignTrainStopsPerWorld: rounded(foreignStops),
    foreignStopSharePct: domesticStops + foreignStops > 0
      ? rounded(foreignStops / (domesticStops + foreignStops) * 100)
      : 0,
    treasuryCappedLifetimePct: rounded(
      ratioOfLifetime((player) => player.cumulative.ticksTreasuryCapped) * 100,
    ),
    casualtiesPerRealm: rounded(mean(players.map((player) => player.casualties))),
    attackingTroopsCommittedPerRealm: rounded(mean(
      players.map((player) => player.cumulative.attackingTroopsCommitted),
    )),
    defendingTroopsCommittedPerRealm: rounded(mean(
      players.map((player) => player.cumulative.defendingTroopsCommitted),
    )),
    lifetimeAtWarPct: rounded(ratioOfLifetime((player) => player.cumulative.ticksAtWar) * 100),
    lifetimeAlliedPct: rounded(ratioOfLifetime((player) => player.cumulative.ticksAllied) * 100),
    warsDeclaredPerWorld: rounded(mean(samples.map((sample) =>
      PLAYER_ORDER.reduce((sum, id) => sum + sample.players[id].cumulative.warsDeclared, 0)
    ))),
    alliancesFormedPerWorld: rounded(mean(samples.map((sample) =>
      PLAYER_ORDER.reduce((sum, id) => sum + sample.players[id].cumulative.alliancesFormed, 0)
    ))),
    betrayalsPerWorld: rounded(mean(samples.map((sample) =>
      PLAYER_ORDER.reduce((sum, id) => sum + sample.players[id].cumulative.alliancesBetrayed, 0)
    ))),
    activeWars: rounded(mean(samples.map((sample) => sample.activeWars)), 2),
    activeAlliances: rounded(mean(samples.map((sample) => sample.activeAlliances)), 2),
    activeCampaigns: rounded(mean(samples.map((sample) => sample.activeCampaigns)), 2),
    activeTrains: rounded(mean(samples.map((sample) => sample.activeTrains)), 1),
    activeShips: rounded(mean(samples.map((sample) => sample.activeShips)), 1),
  };
});

// Champions are players; the tally groups them back into their families.
const winnerCounts = Object.fromEntries(ELEMENT_ORDER.map((element) => [
  ELEMENTS[element].name,
  results.filter((result) =>
    result.champion !== null && playerElement(result.champion) === element,
  ).length,
]));
// What the winners had become: how many champions closed their age still
// founding-expressed versus ascended to a compound or advanced element.
const championTiers = { 1: 0, 2: 0, 3: 0 };
for (const result of results) {
  if (result.champion === null) continue;
  const final = result.checkpoints.at(-1)!.snapshot;
  championTiers[final.players[result.champion].expressedTier] += 1;
}
const summary = {
  games: results.length,
  exactRules: true,
  maximumMinutes: args.maximumTicks / 60,
  workers: workerCount,
  wallRuntimeSeconds: rounded(wallRuntimeMs / 1_000, 2),
  meanGameRuntimeSeconds: rounded(mean(results.map((result) => result.runtimeMs)) / 1_000, 2),
  resolvedGames: completionTicks.length,
  unresolvedGames: results.length - completionTicks.length,
  completionMinutes: completionTicks.length > 0 ? {
    minimum: rounded(Math.min(...completionTicks) / 60, 1),
    p10: rounded(percentile(completionTicks, 0.1) / 60, 1),
    median: rounded(percentile(completionTicks, 0.5) / 60, 1),
    p90: rounded(percentile(completionTicks, 0.9) / 60, 1),
    maximum: rounded(Math.max(...completionTicks) / 60, 1),
    mean: rounded(mean(completionTicks) / 60, 1),
  } : null,
  winnerCounts,
  championTiers,
  checkpoints: checkpointSummary,
};

if (args.output) {
  await writeFile(args.output, `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
