
import { NATIONS } from "./nations";
import { STRUCTURE_RULES } from "./rules";
import type {
  Campaign,
  CampaignTarget,
  NationId,
  ReportImportance,
  ReportEventKind,
  ReportSubject,
  StoryArc,
  StructureType,
  WorldCommand,
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

export function realmSubject(id: NationId): ReportSubject {
  return {
    type: "realm",
    id,
    label: NATIONS[id].realmName,
    realmId: id,
  };
}

export function targetSubject(target: CampaignTarget): ReportSubject {
  return target === "wilderness"
    ? { type: "wilderness", id: "wilderness", label: "the wilderness" }
    : realmSubject(target);
}

export function campaignSubject(campaign: Campaign): ReportSubject {
  return {
    type: "campaign",
    id: campaign.id,
    label: campaign.target === "wilderness"
      ? `${NATIONS[campaign.attacker].name} settlement campaign`
      : `${NATIONS[campaign.attacker].name}–${NATIONS[campaign.target].name} campaign`,
    realmId: campaign.attacker,
  };
}

export function theaterSubject(
  id: string,
  attacker: NationId,
  ordinal?: number,
): ReportSubject {
  return {
    type: "theater",
    id,
    label: `${NATIONS[attacker].name} theater${ordinal === undefined ? "" : ` ${ordinal + 1}`}`,
    realmId: attacker,
  };
}

export function structureSubject(
  type: StructureType,
  tileIndex: number,
  owner: NationId,
): ReportSubject {
  return {
    type: "structure",
    id: `${type}:${tileIndex}`,
    label: `${NATIONS[owner].name} ${STRUCTURE_RULES[type].name.toLowerCase()}`,
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
