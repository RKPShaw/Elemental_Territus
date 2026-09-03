import { realmTitle } from "../naming";
import { PLAYERS, PLAYER_ORDER } from "../players";
import { ELEMENTS } from "../elements";
import { advancePowerState, type PowerEvent } from "../powers";
import { gridDensity, POWER_RULES } from "../rules";
import { realmSubject } from "../reporting";
import type {
  ChronicleEvent,
  PlayerId,
  ReportImportance,
  SimulationContext,
  SimulationSystem,
} from "../types";

interface PowerEventVoice {
  importance: ReportImportance;
  tone: ChronicleEvent["tone"] | null;
  summary: (realm: string) => string;
  chronicle: (realm: string) => string;
}

/** How each dramatic moment reads; null tone keeps it out of the chronicle. */
const EVENT_VOICES: Record<PowerEvent, PowerEventVoice> = {
  "geyser-erupted": {
    importance: "major",
    tone: "battle",
    summary: (realm) =>
      `${realm} released its banked pressure: the eruption surges through its campaigns while the deep springs refill.`,
    chronicle: (realm) =>
      `${realm} erupts — the banked deep pressure bursts into its wars, and its emptied springs must refill.`,
  },
  "tempest-crested": {
    importance: "notable",
    tone: null,
    summary: (realm) =>
      `${realm}'s storm crested: conquest momentum now drives its campaigns, and only further captures will sustain it.`,
    chronicle: (realm) => "",
  },
  "bloom-overextended": {
    importance: "notable",
    tone: null,
    summary: (realm) =>
      `${realm} overextended: the overgrowth outran its people, pausing the wild settlement and softening its frontier until the population recovers.`,
    chronicle: (realm) => "",
  },
  "plasma-containment-failed": {
    importance: "major",
    tone: "economy",
    summary: (realm) =>
      `${realm}'s treasury ran dry beneath the burn and containment failed: its furious works limp below par while the outage lasts.`,
    chronicle: (realm) =>
      `${realm}'s sunforges fail containment — the treasury could not feed the burn, and the works go dark.`,
  },
  "obsidian-shattered": {
    importance: "major",
    tone: "fall",
    summary: (realm) =>
      `${realm}'s honed edge shattered under sustained siege: the reflection fails and its ground lies soft until the knives are ground anew.`,
    chronicle: (realm) =>
      `${realm}'s obsidian edge shatters under the long siege — attackers pour through where they once broke.`,
  },
};

/**
 * Advances every realm's elemental mechanic once per tick.
 *
 * Runs right after ascension so a fresh expression starts its mechanic the
 * same tick, and before the economy and trade systems so the payout factors
 * and the plasma burn read consistently within the tick. All meter arithmetic
 * lives in powers.ts (advancePowerState); this system only gathers each
 * realm's situation — is it campaigning, is it besieged — and gives the
 * dramatic moments their voice in the report and the chronicle.
 */
export class ElementPowersSystem implements SimulationSystem {
  readonly id = "element-powers";

  update(context: SimulationContext): void {
    const { state } = context;
    const campaigning = new Set<PlayerId>();
    const pressed = new Set<PlayerId>();
    for (const campaign of state.campaigns) {
      if (campaign.remaining <= 0 || campaign.target === "wilderness") continue;
      campaigning.add(campaign.attacker);
      pressed.add(campaign.target);
    }

    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const event = advancePowerState(faction, {
        cellDensity: gridDensity(state.config),
        tick: state.tick,
        campaigning: campaigning.has(id),
        pressed: pressed.has(id),
      });
      if (!event) continue;
      const voice = EVENT_VOICES[event];
      const realmName = realmTitle(state, id);
      context.report({
        domain: "dynasty",
        kind: `dynasty.${event}`,
        importance: voice.importance,
        storyKey: `powers:${id}`,
        initiator: realmSubject(state, id),
        targets: [],
        participants: [],
        links: {},
        facts: {
          element: faction.expressedElement,
          elementName: ELEMENTS[faction.expressedElement].name,
          tick: state.tick,
          ...(event === "geyser-erupted"
            ? { surgeTicks: POWER_RULES.geyserSurgeTicks, ventTicks: POWER_RULES.geyserVentTicks }
            : {}),
          ...(event === "plasma-containment-failed"
            ? { outageTicks: POWER_RULES.plasmaFailureTicks }
            : {}),
          ...(event === "obsidian-shattered"
            ? { shatterTicks: POWER_RULES.obsidianShatterTicks }
            : {}),
        },
        summary: voice.summary(realmName),
      });
      if (voice.tone) context.emit(voice.chronicle(realmName), voice.tone, id);
    }
  }
}
