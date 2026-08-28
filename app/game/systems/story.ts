import { ELEMENTS } from "../elements";
import { compactNumber } from "../rules";
import { greaterImportance } from "../reporting";
import { DOMAIN_LABELS } from "../strategy";
import type {
  ElementId,
  ReportSubject,
  SimulationContext,
  SimulationSystem,
  StoryArc,
  StoryKind,
  StrategicDomain,
  WorldReportEvent,
} from "../types";

function uniqueSubjects(subjects: ReportSubject[]): ReportSubject[] {
  const seen = new Set<string>();
  return subjects.filter((subject) => {
    const key = `${subject.type}:${subject.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function realmNames(story: StoryArc): string[] {
  return story.participants
    .filter((subject) => subject.type === "realm")
    .map((subject) => subject.label);
}

function numericFact(event: WorldReportEvent, key: string): number {
  const value = event.facts[key];
  return typeof value === "number" ? value : 0;
}

function stringFact(event: WorldReportEvent, key: string): string | null {
  const value = event.facts[key];
  return typeof value === "string" ? value : null;
}

/**
 * The bespoke tier-3 mechanics report under one powers:<realm> story key, so
 * a realm's whole mechanic reads as one arc. Each dramatic moment counts its
 * own metric and names its own deed in the arc's summary.
 */
const POWER_STORY: Partial<Record<string, { metric: string; deed: string }>> = {
  "dynasty.geyser-erupted": { metric: "eruptions", deed: "eruption" },
  "dynasty.tempest-crested": { metric: "crests", deed: "crest" },
  "dynasty.bloom-overextended": { metric: "overextensions", deed: "overextension" },
  "dynasty.plasma-containment-failed": { metric: "containmentFailures", deed: "containment failure" },
  "dynasty.obsidian-shattered": { metric: "shatters", deed: "shattering" },
};

function booleanFact(event: WorldReportEvent, key: string): boolean {
  return event.facts[key] === true;
}

function increment(story: StoryArc, key: string, amount = 1): void {
  story.metrics[key] = (story.metrics[key] ?? 0) + amount;
}

function inferStoryKind(event: WorldReportEvent): StoryKind {
  if (event.domain === "intrigue") return "intrigue";
  if (event.domain === "dynasty") return "dynasty";
  if (event.domain === "leadership") return "leadership";
  if (event.kind === "politics.revolt" || event.kind.includes("revolt")) return "revolt";
  if (event.kind === "world.created" || event.kind === "world.victory") return "world";
  if (event.kind.includes("alliance")) return "alliance";
  if (event.domain === "trade" || event.kind === "diplomacy.trade-policy-changed") return "trade";
  if (event.domain === "infrastructure" || event.kind === "military.warship-built") return "development";
  if (
    event.kind.startsWith("military.") ||
    event.kind.startsWith("territory.") ||
    event.kind === "diplomacy.war-declared" ||
    event.kind === "diplomacy.peace-made"
  ) {
    return event.targets.some((target) => target.type === "wilderness") ? "expansion" : "war";
  }
  return "world";
}

function initialHeadline(event: WorldReportEvent, kind: StoryKind): string {
  const initiator = event.initiator?.label ?? "The world";
  const target = event.targets[0]?.label;
  if (kind === "alliance") return target ? `${initiator} courts ${target}` : `${initiator} seeks an alliance`;
  if (kind === "war") return target ? `${initiator} moves against ${target}` : `${initiator} goes to war`;
  if (kind === "expansion") return `${initiator} presses into the wilds`;
  if (kind === "development") return `${initiator} builds for the future`;
  if (kind === "trade") return target ? `${initiator} trades with ${target}` : `${initiator} expands its trade`;
  if (kind === "intrigue") return `Intrigue within ${initiator}`;
  if (kind === "dynasty") {
    if (event.kind === "dynasty.element-ascended") return `${initiator} ascends`;
    if (POWER_STORY[event.kind]) return `The power within ${initiator}`;
    return `A new bond for ${initiator}`;
  }
  if (kind === "leadership") return `${initiator} sets its course`;
  if (kind === "revolt") return `Revolt challenges ${target ?? initiator}`;
  return event.kind === "world.created" ? `${initiator} begins` : event.summary;
}

function createStory(event: WorldReportEvent): StoryArc {
  const kind = inferStoryKind(event);
  return {
    id: `story:${event.storyKey}`,
    storyKey: event.storyKey,
    kind,
    status: "developing",
    importance: event.importance,
    startedAt: event.tick,
    updatedAt: event.tick,
    concludedAt: null,
    headline: initialHeadline(event, kind),
    summary: event.summary,
    participants: uniqueSubjects([
      ...(event.initiator ? [event.initiator] : []),
      ...event.targets,
      ...event.participants,
    ]),
    eventIds: [],
    metrics: {},
  };
}

function applyMetrics(story: StoryArc, event: WorldReportEvent): void {
  switch (event.kind) {
    case "diplomacy.alliance-offered":
      increment(story, "offers");
      break;
    case "diplomacy.alliance-formed":
      increment(story, "alliances");
      story.metrics.duration = numericFact(event, "duration");
      break;
    case "diplomacy.alliance-betrayed":
      increment(story, "betrayals");
      break;
    case "diplomacy.trade-policy-changed":
      increment(story, booleanFact(event, "enabled") ? "tradeOpened" : "tradeClosed");
      break;
    case "military.campaign-launched":
    case "military.campaign-reinforced":
      increment(story, "attackersCommitted", numericFact(event, "troops"));
      increment(story, event.kind === "military.campaign-launched" ? "campaigns" : "reinforcements");
      break;
    case "military.defense-committed":
      increment(story, "defendersCommitted", numericFact(event, "troops"));
      break;
    case "military.theater-formed":
      increment(story, "theatersFormed");
      break;
    case "military.theater-realigned":
      increment(story, "theaterRealignments");
      break;
    case "military.theater-victory":
      increment(story, "theatersWon");
      increment(story, "theaterCaptures", numericFact(event, "captures"));
      break;
    case "military.campaign-concluded":
      increment(story, "campaignsConcluded");
      increment(story, "capturedTiles", numericFact(event, "captures"));
      increment(story, "casualties", numericFact(event, "casualties"));
      break;
    case "territory.capital-captured":
      increment(story, "capitalsCaptured");
      break;
    case "territory.structure-captured":
      increment(story, "structuresCaptured");
      break;
    case "territory.resonant-capture":
      increment(story, "resonantCaptures");
      break;
    case "territory.settlement-milestone":
      story.metrics.settledTiles = Math.max(
        story.metrics.settledTiles ?? 0,
        numericFact(event, "claimedTiles"),
      );
      break;
    case "infrastructure.structure-built": {
      increment(story, "buildings");
      const structure = event.facts.structure;
      if (typeof structure === "string") increment(story, structure);
      break;
    }
    case "military.warship-built":
      increment(story, "warships");
      break;
    case "trade.rail-network-changed":
      story.metrics.railEdges = numericFact(event, "edges");
      story.metrics.foreignRailEdges = numericFact(event, "foreignEdges");
      break;
    case "trade.journey-completed":
      increment(story, "journeys");
      increment(story, "income", numericFact(event, "income"));
      increment(story, "distance", numericFact(event, "distance"));
      if (booleanFact(event, "foreign")) increment(story, "foreignJourneys");
      if (booleanFact(event, "allied")) increment(story, "alliedJourneys");
      break;
    case "trade.journey-cancelled":
      increment(story, "cancelledJourneys");
      break;
    case "dynasty.element-ascended":
      increment(story, "ascensions");
      story.metrics.tier = numericFact(event, "tier");
      story.metrics.realmsAbsorbed = numericFact(event, "realmsAbsorbed");
      break;
    case "leadership.strategy-adopted":
      increment(story, "turns");
      break;
    default: {
      const power = POWER_STORY[event.kind];
      if (power) increment(story, power.metric);
      break;
    }
  }
}

function summarizeAlliance(story: StoryArc, event: WorldReportEvent): void {
  const [first = "Two realms", second = "their neighbor"] = realmNames(story);
  if (event.kind === "diplomacy.alliance-formed") {
    story.headline = `${first} and ${second} bind themselves in alliance`;
  } else if (event.kind === "diplomacy.alliance-offer-expired") {
    story.headline = `${first} and ${second} decline an alliance`;
  } else if (event.kind === "diplomacy.alliance-betrayed") {
    story.headline = `${event.initiator?.label ?? first} betrays ${event.targets[0]?.label ?? second}`;
  } else if (event.kind === "diplomacy.alliance-expired") {
    story.headline = `${first} and ${second} complete their alliance`;
  }
  const duration = story.metrics.duration ? ` for ${Math.round(story.metrics.duration / 60)} world-minutes` : "";
  const tradeChanges = (story.metrics.tradeOpened ?? 0) + (story.metrics.tradeClosed ?? 0);
  story.summary = (story.metrics.betrayals ?? 0) > 0
    ? `A negotiated truce ended in betrayal, opening the former ally to retaliation.`
    : (story.metrics.alliances ?? 0) > 0
      ? `${first} and ${second} accepted mutual peace${duration} and favored trade${tradeChanges ? `, revising trade policy ${tradeChanges} times` : ""}.`
      : event.summary;
}

function summarizeWar(story: StoryArc, event: WorldReportEvent): void {
  const [first = "One realm", second = "its rival"] = realmNames(story);
  if (event.kind === "diplomacy.war-declared") {
    story.headline = `${event.initiator?.label ?? first} declares war on ${event.targets[0]?.label ?? second}`;
  }
  if (event.kind === "territory.realm-conquered") {
    story.headline = `${event.initiator?.label ?? first} conquers ${event.targets[0]?.label ?? second}`;
  }
  const attack = story.metrics.attackersCommitted ?? 0;
  const defense = story.metrics.defendersCommitted ?? 0;
  const theaters = story.metrics.theatersFormed ?? 0;
  const won = story.metrics.theatersWon ?? 0;
  const captured = story.metrics.capturedTiles ?? 0;
  const details = [
    attack > 0 ? `${compactNumber(attack)} troops committed by the aggressor` : null,
    defense > 0 ? `${compactNumber(defense)} reserved in defense` : null,
    theaters > 0 ? `${theaters} theater ${theaters === 1 ? "formation" : "formations"} recorded` : null,
    won > 0 ? `${won} theater ${won === 1 ? "victory" : "victories"}` : null,
    captured > 0 ? `${captured} sectors taken in concluded campaigns` : null,
  ].filter(Boolean);
  story.summary = details.length > 0
    ? `${first} and ${second} fought across a changing front: ${details.join(", ")}.`
    : event.summary;
}

function summarizeExpansion(story: StoryArc, event: WorldReportEvent): void {
  const realm = realmNames(story)[0] ?? event.initiator?.label ?? "A realm";
  const committed = story.metrics.attackersCommitted ?? 0;
  const theaters = story.metrics.theatersFormed ?? 0;
  const settled = Math.max(story.metrics.settledTiles ?? 0, story.metrics.capturedTiles ?? 0);
  story.headline = `${realm} settles the wilderness`;
  story.summary = `${realm} committed ${compactNumber(committed)} settlers through ${theaters} recorded theater ${theaters === 1 ? "formation" : "formations"}${settled ? ` and brought ${settled} sectors under its banner` : ""}.`;
}

function summarizeDevelopment(story: StoryArc, event: WorldReportEvent): void {
  const realm = realmNames(story)[0] ?? event.initiator?.label ?? "A realm";
  const labels = [
    ["city", "cities"],
    ["fort", "forts"],
    ["factory", "factories"],
    ["harbor", "harbors"],
    ["plant", "plants"],
    ["skyport", "skyports"],
    ["warships", "warships"],
  ] as const;
  const built = labels
    .filter(([key]) => (story.metrics[key] ?? 0) > 0)
    .map(([key, label]) => `${story.metrics[key]} ${label}`);
  story.headline = `${realm} builds for power and prosperity`;
  story.summary = built.length > 0
    ? `${realm}'s latest building era produced ${built.join(", ")}.`
    : event.summary;
}

/**
 * Dynasty arcs carry two very different tales under one domain: a realm's
 * climb through the tiers (one ascension:<realm> arc for its whole history)
 * and the moments its bespoke mechanic breaks the surface (one powers:<realm>
 * arc per realm). Anything else in the namespace — a future marriage, say —
 * keeps the generic telling.
 */
function summarizeDynasty(story: StoryArc, event: WorldReportEvent): void {
  const realm = realmNames(story)[0] ?? event.initiator?.label ?? "A realm";
  if (event.kind === "dynasty.element-ascended") {
    const to = stringFact(event, "to");
    const name = to && to in ELEMENTS ? ELEMENTS[to as ElementId].name : null;
    story.headline = name ? `${realm} rises to ${name}` : `${realm} ascends`;
    const ascensions = story.metrics.ascensions ?? 0;
    story.summary = ascensions > 1
      ? `${event.summary} Its history has now carried it up the tiers ${ascensions} times.`
      : event.summary;
    return;
  }
  const power = POWER_STORY[event.kind];
  if (power) {
    const element = stringFact(event, "elementName");
    story.headline = element ? `${realm} wields ${element}` : `The power within ${realm}`;
    const deeds = Object.values(POWER_STORY)
      .filter((entry) => entry && (story.metrics[entry.metric] ?? 0) > 0)
      .map((entry) => {
        const count = story.metrics[entry!.metric]!;
        return `${count} ${entry!.deed}${count === 1 ? "" : "s"}`;
      });
    story.summary = deeds.length > 0
      ? `${element ?? "Its element"} has spoken through ${realm}: ${deeds.join(", ")}.`
      : event.summary;
    return;
  }
  story.summary = event.summary;
}

/** A court's course-turns: each era's arc reads its latest heading and how restless it has been. */
function summarizeLeadership(story: StoryArc, event: WorldReportEvent): void {
  const realm = realmNames(story)[0] ?? event.initiator?.label ?? "A realm";
  const to = stringFact(event, "to");
  const label = to && to in DOMAIN_LABELS ? DOMAIN_LABELS[to as StrategicDomain] : null;
  story.headline = label ? `${realm} turns to ${label}` : `${realm} sets its course`;
  const turns = story.metrics.turns ?? 0;
  story.summary = turns > 1
    ? `${event.summary} The council has turned ${turns} times this era.`
    : event.summary;
}

function summarizeTrade(story: StoryArc, event: WorldReportEvent): void {
  const names = realmNames(story);
  const journeys = story.metrics.journeys ?? 0;
  const income = story.metrics.income ?? 0;
  story.headline = names.length > 1
    ? `Commerce flows between ${names[0]} and ${names[1]}`
    : `${names[0] ?? "A realm"} expands its commerce`;
  story.summary = journeys > 0
    ? `${journeys} completed ${journeys === 1 ? "journey has" : "journeys have"} generated ${compactNumber(income)} gold${story.metrics.alliedJourneys ? `, including ${story.metrics.alliedJourneys} allied runs` : ""}.`
    : event.summary;
}

function updateStory(story: StoryArc, event: WorldReportEvent): void {
  if (event.kind === "military.campaign-launched") {
    story.status = "developing";
    story.concludedAt = null;
  }
  story.updatedAt = event.tick;
  story.importance = greaterImportance(story.importance, event.importance);
  story.eventIds.push(event.id);
  story.participants = uniqueSubjects([
    ...story.participants,
    ...(event.initiator ? [event.initiator] : []),
    ...event.targets,
    ...event.participants,
  ]);
  applyMetrics(story, event);

  if (story.kind === "alliance") summarizeAlliance(story, event);
  else if (story.kind === "war") summarizeWar(story, event);
  else if (story.kind === "expansion") summarizeExpansion(story, event);
  else if (story.kind === "development") summarizeDevelopment(story, event);
  else if (story.kind === "trade") summarizeTrade(story, event);
  else if (story.kind === "dynasty") summarizeDynasty(story, event);
  else if (story.kind === "leadership") summarizeLeadership(story, event);
  else {
    if (event.kind === "world.victory") {
      story.headline = `${event.initiator?.label ?? "A realm"} closes the age`;
    }
    story.summary = event.summary;
  }

  const concludes =
    event.kind === "world.victory" ||
    event.kind === "diplomacy.alliance-offer-expired" ||
    event.kind === "diplomacy.alliance-expired" ||
    event.kind === "diplomacy.alliance-betrayed" ||
    event.kind === "diplomacy.peace-made" ||
    event.kind === "territory.realm-conquered";
  if (concludes) {
    story.status = "concluded";
    story.concludedAt = event.tick;
  }
}

export class StorySystem implements SimulationSystem {
  readonly id = "historical-story-correlator";

  update({ state }: SimulationContext): void {
    while (state.storyCursor < state.reports.length) {
      const event = state.reports[state.storyCursor++]!;
      let story = state.stories.find((candidate) => candidate.storyKey === event.storyKey);
      if (!story) {
        story = createStory(event);
        state.stories.push(story);
      }
      updateStory(story, event);
    }
  }
}
