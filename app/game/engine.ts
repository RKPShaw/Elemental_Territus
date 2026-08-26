import { SeededRandom } from "./random";
import { DEFAULT_SYSTEMS } from "./systems";
import type {
  ChronicleEvent,
  SimulationSystem,
  WorldReportEvent,
  WorldReportDraft,
  WorldState,
} from "./types";
import { cloneEconomyLedger } from "./economics";
import { createWorld } from "./world";

export interface ElementalWarEngineOptions {
  retainChronicle?: boolean;
  retainReports?: boolean;
  onReport?: (event: WorldReportEvent, state: WorldState) => void;
  onTick?: (state: WorldState) => void;
}

export class ElementalWarEngine {
  private state: WorldState;
  private random: SeededRandom;
  private eventId = 2;
  private reportId: number;

  constructor(
    seed: number,
    private readonly systems: readonly SimulationSystem[] = DEFAULT_SYSTEMS,
    private readonly options: ElementalWarEngineOptions = {},
  ) {
    this.state = createWorld(seed);
    this.random = new SeededRandom(seed ^ 0xb5297a4d);
    this.reportId = this.state.reports.length + 1;
    if (this.options.retainReports === false) {
      this.state.reports = [];
      this.state.stories = [];
      this.state.storyCursor = 0;
    }
    if (this.options.retainChronicle === false) this.state.chronicle = [];
  }

  /** Advances the authoritative state without allocating an immutable UI snapshot. */
  advance(iterations = 1): void {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (this.state.champion) break;
      const emit = (
        text: string,
        tone: ChronicleEvent["tone"],
        actor: ChronicleEvent["actor"] = null,
      ) => {
        if (this.options.retainChronicle === false) return;
        this.state.chronicle.unshift({
          id: this.eventId++,
          tick: this.state.tick,
          tone,
          text,
          actor,
        });
        this.state.chronicle = this.state.chronicle.slice(0, 24);
      };
      const report = (draft: WorldReportDraft) => {
        const id = this.reportId++;
        const event: WorldReportEvent = {
          schemaVersion: 1,
          id,
          tick: this.state.tick,
          age: this.state.age,
          domain: draft.domain,
          kind: draft.kind,
          importance: draft.importance ?? "routine",
          storyKey: draft.storyKey,
          initiator: draft.initiator,
          targets: draft.targets ?? [],
          participants: draft.participants ?? [],
          links: draft.links ?? {},
          facts: draft.facts ?? {},
          summary: draft.summary,
        };
        this.options.onReport?.(event, this.state);
        if (this.options.retainReports !== false) this.state.reports.push(event);
        return id;
      };
      for (const system of this.systems) {
        system.update({ state: this.state, random: this.random, emit, report });
      }
      this.options.onTick?.(this.state);
    }
  }

  step(iterations = 1): WorldState {
    this.advance(iterations);
    return this.snapshot();
  }

  setAggression(value: number): WorldState {
    this.state.config.aggression = Math.max(0.55, Math.min(1.55, value));
    return this.snapshot();
  }

  get tick(): number {
    return this.state.tick;
  }

  /** Read-only-by-convention access for headless observers; callers must not mutate state. */
  observe<T>(reader: (state: WorldState) => T): T {
    return reader(this.state);
  }

  snapshot(): WorldState {
    return {
      ...this.state,
      cells: this.state.cells.map((cell) => ({ ...cell })),
      factions: Object.fromEntries(
        Object.entries(this.state.factions).map(([id, faction]) => [
          id,
          {
            ...faction,
            absorbedElements: [...faction.absorbedElements],
            structures: { ...faction.structures },
            intent: { ...faction.intent },
            economy: cloneEconomyLedger(faction.economy),
          },
        ]),
      ) as WorldState["factions"],
      relations: Object.fromEntries(
        Object.entries(this.state.relations).map(([key, relation]) => [
          key,
          {
            ...relation,
            parties: [...relation.parties] as typeof relation.parties,
            tradeDisabledBy: [...relation.tradeDisabledBy],
          },
        ]),
      ),
      campaigns: this.state.campaigns.map((campaign) => ({
        ...campaign,
        pathIndices: [...campaign.pathIndices],
      })),
      strategicRegions: this.state.strategicRegions.map((region) => ({
        ...region,
        cells: [...region.cells],
        terrainProfile: { ...region.terrainProfile },
      })),
      strategicMeta: {
        value: this.state.strategicMeta.value.slice(),
        productivity: this.state.strategicMeta.productivity.slice(),
        relief: this.state.strategicMeta.relief.slice(),
        infrastructure: this.state.strategicMeta.infrastructure.slice(),
        updatedAt: this.state.strategicMeta.updatedAt,
      },
      theaterMap: {
        byPlayer: Object.fromEntries(
          Object.entries(this.state.theaterMap.byPlayer).map(([player, store]) => [
            player,
            {
              value: store.value.slice(),
              trend: store.trend.slice(),
              observedAt: store.observedAt.slice(),
            },
          ]),
        ) as typeof this.state.theaterMap.byPlayer,
        regionCount: this.state.theaterMap.regionCount,
      },
      regionByCell: [...this.state.regionByCell],
      theaters: this.state.theaters.map((theater) => ({
        ...theater,
        boundaryCells: [...theater.boundaryCells],
        objectiveCells: [...theater.objectiveCells],
        terrainProfile: { ...theater.terrainProfile },
        valueHistory: [...theater.valueHistory],
      })),
      tradeRoutes: this.state.tradeRoutes.map((route) => ({
        ...route,
        parties: [...route.parties] as typeof route.parties,
        pathIndices: [...route.pathIndices],
      })),
      tradeVehicles: this.state.tradeVehicles.map((vehicle) => ({
        ...vehicle,
        pathIndices: [...vehicle.pathIndices],
        stopIndices: [...vehicle.stopIndices],
      })),
      tradeDispatches: Object.fromEntries(
        Object.entries(this.state.tradeDispatches).map(([key, dispatch]) => [
          key,
          { ...dispatch, activeVehicleIds: [...dispatch.activeVehicleIds] },
        ]),
      ),
      activePressureCells: [...this.state.activePressureCells],
      commands: this.state.commands.map((command) => ({ ...command })),
      chronicle: this.state.chronicle.map((event) => ({ ...event })),
      // Report events are immutable after append, so snapshots only copy the
      // ledger array. This keeps a complete world history without making late
      // game frame cost scale with every fact ever recorded.
      reports: [...this.state.reports],
      stories: this.state.stories.map((story) => ({
        ...story,
        participants: story.participants.map((participant) => ({ ...participant })),
        eventIds: [...story.eventIds],
        metrics: { ...story.metrics },
      })),
      config: { ...this.state.config },
    };
  }
}
