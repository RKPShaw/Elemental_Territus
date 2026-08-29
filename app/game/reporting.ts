
import { realmLabel, realmTitle } from "./naming";
import { STRUCTURE_RULES } from "./rules";
import type {
  Campaign,
  CampaignTarget,
  PlayerId,
  ReportImportance,
  ReportEventKind,
  ReportSubject,
  StoryArc,
  StructureType,
  WorldCommand,
  WorldState,
} from "./types";

/** Compile-time audit contract: every executable player/AI action has factual event coverage. */
export const ACTION_REPORT_KINDS = {
  "declare-war": ["diplomacy.war-declared", "diplomacy.alliance-betrayed"],
  "make-peace": ["diplomacy.peace-made"],
  "offer-truce": ["diplomacy.alliance-offered"],
  "accept-truce": ["diplomacy.alliance-formed"],
  "set-trade": ["diplomacy.trade-policy-changed"],
  "launch-campaign": ["military.campaign-launched", "military.campaign-reinforced"],
  "commit-defense": ["military.defense-committed"],
  "build-structure": ["infrastructure.structure-built"],
  "build-warship": ["military.warship-built"],
} as const satisfies Record<WorldCommand["type"], readonly ReportEventKind[]>;

// Every subject label reads the realm's living name from world state, so a
// report written after a realm is crowned or renamed carries the name it bore
// at that moment — the story system then tells the arc in period style.
export function realmSubject(state: WorldState, id: PlayerId): ReportSubject {
  return {
    type: "realm",
    id,
    label: realmTitle(state, id),
    realmId: id,
  };
}

export function targetSubject(state: WorldState, target: CampaignTarget): ReportSubject {
  return target === "wilderness"
    ? { type: "wilderness", id: "wilderness", label: "the wilderness" }
    : realmSubject(state, target);
}

export function campaignSubject(state: WorldState, campaign: Campaign): ReportSubject {
  return {
    type: "campaign",
    id: campaign.id,
    label: campaign.target === "wilderness"
      ? `${realmLabel(state, campaign.attacker)} settlement campaign`
      : `${realmLabel(state, campaign.attacker)}–${realmLabel(state, campaign.target)} campaign`,
    realmId: campaign.attacker,
  };
}

export function theaterSubject(
  state: WorldState,
  id: string,
  attacker: PlayerId,
  ordinal?: number,
): ReportSubject {
  return {
    type: "theater",
    id,
    label: `${realmLabel(state, attacker)} theater${ordinal === undefined ? "" : ` ${ordinal + 1}`}`,
    realmId: attacker,
  };
}

export function structureSubject(
  state: WorldState,
  type: StructureType,
  tileIndex: number,
  owner: PlayerId,
): ReportSubject {
  return {
    type: "structure",
    id: `${type}:${tileIndex}`,
    label: `${realmLabel(state, owner)} ${STRUCTURE_RULES[type].name.toLowerCase()}`,
    realmId: owner,
  };
}

export const IMPORTANCE_RANK: Record<ReportImportance, number> = {
  routine: 0,
  notable: 1,
  major: 2,
  historic: 3,
};

export function greaterImportance(
  first: ReportImportance,
  second: ReportImportance,
): ReportImportance {
  return IMPORTANCE_RANK[first] >= IMPORTANCE_RANK[second] ? first : second;
}

export function latestStories(stories: StoryArc[]): StoryArc[] {
  return [...stories].sort((first, second) => {
    const importance = IMPORTANCE_RANK[second.importance] - IMPORTANCE_RANK[first.importance];
    return importance || second.updatedAt - first.updatedAt;
  });
}
