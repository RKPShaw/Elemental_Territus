import { committedTroopsFor } from "../app/game/campaigns";
import { getRelation } from "../app/game/diplomacy";
import { ELEMENT_ORDER, ELEMENTS } from "../app/game/elements";
import { ElementalWarEngine } from "../app/game/engine";
import { populationGrowthEfficiency } from "../app/game/rules";
import type { ElementId, WorldState } from "../app/game/types";

const SEEDS = [0x240823, 7, 42, 12_345, 8_675_309, 20_260_824];
const CHECKPOINTS = [300, 900, 1_800] as const;

interface NationSample {
  checkpoint: number;
  seed: number;
  nation: ElementId;
  alive: number;
  homePopulation: number;
  committedPopulation: number;
  populationCap: number;
  homeRatio: number;
  growthEfficiency: number;
  landShare: number;
  cities: number;
  citySites: number;
  stackedCityLevels: number;
  factories: number;
  harbors: number;
  forts: number;
  gold: number;
  income: number;
  allies: number;
  wars: number;
  casualties: number;
  captures: number;
  activeTrains: number;
  activeShips: number;
  structureSpend: number;
  trainIncome: number;
  shipIncome: number;
  domesticStops: number;
  foreignStops: number;
  completedTrains: number;
  completedShips: number;
}

interface WorldSample {
  checkpoint: number;
  seed: number;
  actualTick: number;
  settledShare: number;
  aliveRealms: number;
  champion: ElementId | null;
  reports: number;
  stories: number;
  completedJourneys: number;
  activeTrains: number;
  activeShips: number;
  totalCities: number;
  totalTradeBuildings: number;
  stackedCityLevels: number;
  structureSpend: number;
  trainIncome: number;
  shipIncome: number;
  domesticStops: number;
  foreignStops: number;
}

function economyLedger(state: WorldState, nation: ElementId) {
  let structureSpend = 0;
  let trainIncome = 0;
  let shipIncome = 0;
  let domesticStops = 0;
  let foreignStops = 0;
  let completedTrains = 0;
  let completedShips = 0;
  for (const event of state.reports) {
    const initiated = event.initiator?.realmId === nation;
    const hosted = event.targets.some((target) => target.realmId === nation) && !initiated;
    if (event.kind === "infrastructure.structure-built" && initiated) {
      structureSpend += Number(event.facts.cost ?? 0);
    }
    if (event.kind === "trade.train-stop-served") {
      if (initiated) trainIncome += Number(event.facts.ownerIncome ?? 0);
      if (hosted) trainIncome += Number(event.facts.hostIncome ?? 0);
      if (initiated) {
        if (event.facts.foreign) foreignStops += 1;
        else domesticStops += 1;
      }
    }
    if (event.kind === "trade.journey-completed") {
      if (event.facts.vehicleKind === "train" && initiated) completedTrains += 1;
      if (event.facts.vehicleKind === "ship") {
        if (initiated) {
          completedShips += 1;
          shipIncome += Number(event.facts.income ?? 0);
        }
        if (hosted) shipIncome += Number(event.facts.hostIncome ?? 0);
      }
    }
  }
  return {
    structureSpend,
    trainIncome,
    shipIncome,
    domesticStops,
    foreignStops,
    completedTrains,
    completedShips,
  };
}

function diplomacyCounts(state: WorldState, nation: ElementId): [number, number] {
  let allies = 0;
  let wars = 0;
  for (const other of ELEMENT_ORDER) {
    if (other === nation || !state.factions[other].alive) continue;
    const status = getRelation(state, nation, other).status;
    if (status === "truce") allies += 1;
    if (status === "war") wars += 1;
  }
  return [allies, wars];
}

function captureNation(
  state: WorldState,
  seed: number,
  checkpoint: number,
  nation: ElementId,
): NationSample {
  const faction = state.factions[nation];
  const committedPopulation = committedTroopsFor(state, nation);
  const [allies, wars] = diplomacyCounts(state, nation);
  const homeRatio = faction.troops / Math.max(1, faction.troopCap);
  const citySites = state.cells.filter(
    (cell) => cell.owner === nation && cell.structure === "city",
  ).length;
  const economy = economyLedger(state, nation);
  return {
    checkpoint,
    seed,
    nation,
    alive: faction.alive ? 1 : 0,
    homePopulation: faction.troops,
    committedPopulation,
    populationCap: faction.troopCap,
    homeRatio,
    growthEfficiency: populationGrowthEfficiency(homeRatio),
    landShare: faction.territory / state.landTiles,
    cities: faction.structures.city,
    citySites,
    stackedCityLevels: Math.max(0, faction.structures.city - citySites),
    factories: faction.structures.factory,
    harbors: faction.structures.harbor,
    forts: faction.structures.fort,
    gold: faction.gold,
    income: faction.goldRate,
    allies,
    wars,
    casualties: faction.casualties,
    captures: faction.capturedTiles + faction.claimedTiles,
    activeTrains: state.tradeVehicles.filter(
      (vehicle) => vehicle.kind === "train" && vehicle.owner === nation,
    ).length,
    activeShips: state.tradeVehicles.filter(
      (vehicle) => vehicle.kind === "ship" && vehicle.owner === nation,
    ).length,
    ...economy,
  };
}

function mean(samples: NationSample[], key: keyof NationSample): number {
  return samples.reduce((total, sample) => total + Number(sample[key]), 0) / samples.length;
}

function rounded(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

const nations: NationSample[] = [];
const worlds: WorldSample[] = [];

for (const seed of SEEDS) {
  const engine = new ElementalWarEngine(seed);
  let state = engine.snapshot();
  let previousCheckpoint = 0;
  for (const checkpoint of CHECKPOINTS) {
    state = engine.step(checkpoint - previousCheckpoint);
    previousCheckpoint = checkpoint;
    for (const nation of ELEMENT_ORDER) {
      nations.push(captureNation(state, seed, checkpoint, nation));
    }
    const unclaimed = state.cells.filter(
      (cell) => cell.terrain !== "water" && cell.owner === null,
    ).length;
    worlds.push({
      checkpoint,
      seed,
      actualTick: state.tick,
      settledShare: 1 - unclaimed / state.landTiles,
      aliveRealms: ELEMENT_ORDER.filter((nation) => state.factions[nation].alive).length,
      champion: state.champion,
      reports: state.reports.length,
      stories: state.stories.length,
      completedJourneys: state.reports.filter(
        (event) => event.kind === "trade.journey-completed",
      ).length,
      activeTrains: state.tradeVehicles.filter((vehicle) => vehicle.kind === "train").length,
      activeShips: state.tradeVehicles.filter((vehicle) => vehicle.kind === "ship").length,
      totalCities: ELEMENT_ORDER.reduce((total, nation) => total + state.factions[nation].structures.city, 0),
      totalTradeBuildings: ELEMENT_ORDER.reduce(
        (total, nation) => total + state.factions[nation].structures.factory + state.factions[nation].structures.harbor,
        0,
      ),
      stackedCityLevels: nations
        .filter((sample) => sample.seed === seed && sample.checkpoint === checkpoint)
        .reduce((total, sample) => total + sample.stackedCityLevels, 0),
      structureSpend: nations
        .filter((sample) => sample.seed === seed && sample.checkpoint === checkpoint)
        .reduce((total, sample) => total + sample.structureSpend, 0),
      trainIncome: nations
        .filter((sample) => sample.seed === seed && sample.checkpoint === checkpoint)
        .reduce((total, sample) => total + sample.trainIncome, 0),
      shipIncome: nations
        .filter((sample) => sample.seed === seed && sample.checkpoint === checkpoint)
        .reduce((total, sample) => total + sample.shipIncome, 0),
      domesticStops: state.reports.filter(
        (event) => event.kind === "trade.train-stop-served" && event.facts.foreign === false,
      ).length,
      foreignStops: state.reports.filter(
        (event) => event.kind === "trade.train-stop-served" && event.facts.foreign === true,
      ).length,
    });
  }
}

const nationAverages = CHECKPOINTS.flatMap((checkpoint) =>
  ELEMENT_ORDER.map((nation) => {
    const samples = nations.filter(
      (sample) => sample.checkpoint === checkpoint && sample.nation === nation,
    );
    return {
      minute: checkpoint / 60,
      nation: ELEMENTS[nation].name,
      survivalPct: rounded(mean(samples, "alive") * 100),
      homePopulation: rounded(mean(samples, "homePopulation")),
      committedPopulation: rounded(mean(samples, "committedPopulation")),
      populationCap: rounded(mean(samples, "populationCap")),
      homeRatioPct: rounded(mean(samples, "homeRatio") * 100, 1),
      growthEfficiencyPct: rounded(mean(samples, "growthEfficiency") * 100, 1),
      landSharePct: rounded(mean(samples, "landShare") * 100, 1),
      cities: rounded(mean(samples, "cities"), 1),
      citySites: rounded(mean(samples, "citySites"), 1),
      stackedCityLevels: rounded(mean(samples, "stackedCityLevels"), 1),
      factories: rounded(mean(samples, "factories"), 1),
      harbors: rounded(mean(samples, "harbors"), 1),
      forts: rounded(mean(samples, "forts"), 1),
      gold: rounded(mean(samples, "gold")),
      incomePerTick: rounded(mean(samples, "income")),
      allies: rounded(mean(samples, "allies"), 2),
      wars: rounded(mean(samples, "wars"), 2),
      casualties: rounded(mean(samples, "casualties")),
      captures: rounded(mean(samples, "captures")),
      activeTrains: rounded(mean(samples, "activeTrains"), 1),
      activeShips: rounded(mean(samples, "activeShips"), 1),
      structureSpend: rounded(mean(samples, "structureSpend")),
      trainIncome: rounded(mean(samples, "trainIncome")),
      shipIncome: rounded(mean(samples, "shipIncome")),
      domesticStops: rounded(mean(samples, "domesticStops"), 1),
      foreignStops: rounded(mean(samples, "foreignStops"), 1),
      completedTrains: rounded(mean(samples, "completedTrains"), 1),
      completedShips: rounded(mean(samples, "completedShips"), 1),
    };
  }),
);

const worldAverages = CHECKPOINTS.map((checkpoint) => {
  const samples = worlds.filter((sample) => sample.checkpoint === checkpoint);
  const average = (key: keyof WorldSample) =>
    samples.reduce((total, sample) => total + Number(sample[key]), 0) / samples.length;
  return {
    minute: checkpoint / 60,
    settledPct: rounded(average("settledShare") * 100, 1),
    aliveRealms: rounded(average("aliveRealms"), 2),
    gamesWithChampion: samples.filter((sample) => sample.champion !== null).length,
    reports: rounded(average("reports")),
    stories: rounded(average("stories")),
    completedJourneys: rounded(average("completedJourneys")),
    activeTrains: rounded(average("activeTrains"), 1),
    activeShips: rounded(average("activeShips"), 1),
    citiesPerRealm: rounded(average("totalCities") / ELEMENT_ORDER.length, 1),
    tradeBuildingsPerRealm: rounded(average("totalTradeBuildings") / ELEMENT_ORDER.length, 1),
    stackedCityLevelsPerWorld: rounded(average("stackedCityLevels"), 1),
    structureSpendPerWorld: rounded(average("structureSpend")),
    trainIncomePerWorld: rounded(average("trainIncome")),
    shipIncomePerWorld: rounded(average("shipIncome")),
    domesticStops: rounded(average("domesticStops"), 1),
    foreignStops: rounded(average("foreignStops"), 1),
  };
});

const championCounts = Object.fromEntries(
  ELEMENT_ORDER.map((nation) => [
    ELEMENTS[nation].name,
    worlds.filter(
      (sample) => sample.checkpoint === CHECKPOINTS.at(-1) && sample.champion === nation,
    ).length,
  ]),
);

process.stdout.write(`${JSON.stringify({
  games: SEEDS.length,
  seeds: SEEDS,
  temperament: "Strategic (1.0)",
  checkpoints: CHECKPOINTS,
  nationAverages,
  worldAverages,
  championCountsAt30Minutes: championCounts,
}, null, 2)}\n`);
