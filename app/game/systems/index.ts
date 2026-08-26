import type { SimulationSystem } from "../types";
import { RealmAccountingSystem } from "./accounting";
import { CampaignSystem } from "./campaign";
import { WorldClockSystem } from "./clock";
import { CommandExecutionSystem } from "./commands";
import { ConstructionAiSystem } from "./construction-ai";
import { DiplomacyAiSystem } from "./diplomacy-ai";
import { DiplomacyClockSystem } from "./diplomacy-clock";
import { EconomySystem } from "./economy";
import { StrategyAiSystem } from "./strategy-ai";
import { StorySystem } from "./story";
import { StrategicGeographySystem } from "./strategic-geography";
import { TheaterMapSystem } from "./theater-map";
import { TheaterSystem } from "./theaters";
import { TradeNetworkSystem } from "./trade";
import { VictorySystem } from "./victory";

export const DEFAULT_SYSTEMS: readonly SimulationSystem[] = [
  new WorldClockSystem(),
  new DiplomacyClockSystem(),
  new RealmAccountingSystem(),
  new EconomySystem(),
  new TradeNetworkSystem(),
  new DiplomacyAiSystem(),
  new StrategyAiSystem(),
  new ConstructionAiSystem(),
  new CommandExecutionSystem(),
  new StrategicGeographySystem(),
  new TheaterMapSystem(),
  new TheaterSystem(),
  new CampaignSystem(),
  new VictorySystem(),
  new StorySystem(),
];

/** Exact gameplay pipeline for bulk runs; only narrative correlation is omitted. */
export const BATCH_SYSTEMS: readonly SimulationSystem[] = DEFAULT_SYSTEMS.filter(
  (system) => system.id !== "historical-story-correlator",
);
