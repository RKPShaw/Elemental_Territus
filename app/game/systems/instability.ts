import { createTransmutationState } from "../ascension";
import { draftSites, elementAffinityField } from "../draft";
import { ELEMENTS, FOUNDING_ELEMENTS, baseMaskOf, compositionOf } from "../elements";
import { cellsWithin } from "../grid";
import { applyRename, realmTitle } from "../naming";
import { PLAYER_ORDER, playerElement } from "../players";
import { createPowerState } from "../powers";
import { getRelation } from "../diplomacy";
import { realmSubject } from "../reporting";
import {
  FISSION_RULES,
  SPAWN_RULES,
  clamp,
  normalizedCellLength,
} from "../rules";
import { initialStrategy } from "../strategy";
import { markCellsChanged } from "../structure-index";
import { recalculateRealm } from "./shared";
import type {
  ElementId,
  FactionState,
  FoundingElementId,
  PlayerId,
  SimulationContext,
  SimulationSystem,
} from "../types";

/**
 * Imperial instability: the slow clock that breaks compound empires apart.
 *
 * Strain accrues for realms expressing tier 2 or 3 from three pressures —
 * territory beyond what cities and forts administer, saturation (a country
 * fully turned to the empire's own signature ground has nothing left to give
 * its element), and war weariness. Fresh conquest relieves all three, which
 * closes the game's loop: conquer, fuse, transform, saturate, strain, break.
 *
 * At full strain the realm FISSIONS along its elemental fault lines. Its
 * founding constituents come free as restarted realms — dead roster slots of
 * those families revived with their old names, re-seated through the same
 * settlement draft that opened the world, each picking the best ground of
 * the former empire with full knowledge and paying the cost of crowding the
 * rump and each other. The rump survives humbled around its capital, demoted
 * to its founding element (the one sanctioned demotion in the game). All
 * remaining territory reverts to wilderness with every structure standing:
 * collapse never razes, so the freed, built-up, terraformed country is the
 * next age's prize. Tier 1 never strains — fission ends a story without
 * starting a death spiral, and the freed elements must conquer their way
 * back up the ladder.
 */
export class InstabilitySystem implements SimulationSystem {
  readonly id = "imperial-instability";

  update(context: SimulationContext): void {
    const { state } = context;
    if (state.tick % FISSION_RULES.cadenceTicks !== 0) return;
    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) {
        faction.strain = 0;
        continue;
      }
      const tier = ELEMENTS[faction.expressedElement].tier;
      const amplification = FISSION_RULES.tierAmplification[tier];
      if (
        amplification === 0
        || faction.territory < FISSION_RULES.minimumTerritoryCells
        || state.tick < faction.strainGraceUntil
      ) {
        faction.strain = clamp(
          faction.strain - FISSION_RULES.recoveryPerTick * FISSION_RULES.cadenceTicks,
          0,
          1,
        );
        continue;
      }
      const supported = FISSION_RULES.supportedBaseArea
        + FISSION_RULES.supportedPerCityLevel * faction.structures.city
        + FISSION_RULES.supportedPerFort * faction.structures.fort;
      const unsupportedShare = Math.max(0, 1 - supported / Math.max(1, faction.territory));
      const saturationPressure = Math.max(0, faction.saturation - FISSION_RULES.saturationGrace)
        / (1 - FISSION_RULES.saturationGrace);
      const pressure = FISSION_RULES.overextensionWeight * unsupportedShare
        + FISSION_RULES.saturationWeight * saturationPressure
        + FISSION_RULES.wearinessWeight * faction.warWeariness;
      const before = faction.strain;
      // Accrual and recovery pull against each other, so sustained partial
      // pressure finds an equilibrium below the breaking point and only a
      // genuinely overreached empire climbs all the way to fission.
      const delta = (FISSION_RULES.strainPerTick * pressure * amplification
        - FISSION_RULES.recoveryPerTick * (1 - Math.min(1, pressure)))
        * FISSION_RULES.cadenceTicks;
      faction.strain = clamp(before + delta, 0, 1);
      for (const threshold of [0.5, 0.85] as const) {
        if (before < threshold && faction.strain >= threshold) {
          context.report({
            domain: "politics",
            kind: "politics.instability-rising",
            importance: threshold === 0.5 ? "notable" : "major",
            storyKey: `fission:${id}`,
            initiator: realmSubject(state, id),
            targets: [],
            participants: [],
            links: {},
            facts: {
              strain: faction.strain,
              unsupportedShare,
              saturation: faction.saturation,
              warWeariness: faction.warWeariness,
              tier,
            },
            summary: threshold === 0.5
              ? `Strain builds within ${realmTitle(state, id)}: the ${ELEMENTS[faction.expressedElement].name.toLowerCase()} empire has outgrown what its cities can hold together.`
              : `${realmTitle(state, id)} is coming apart at its elemental seams — the constituents pull toward their old natures.`,
          });
          if (threshold === 0.85) {
            context.emit(
              `${realmTitle(state, id)} strains at its seams — the old elements stir beneath the crown.`,
              "fall",
              id,
            );
          }
        }
      }
      if (faction.strain >= 1) this.fission(context, id);
    }
  }

  private fission(context: SimulationContext, id: PlayerId): void {
    const { state } = context;
    const faction = state.factions[id];
    const expressed = faction.expressedElement;
    const composition = compositionOf(expressed);
    const cellLength = normalizedCellLength(state.config);
    const capital = faction.capitalIndex;

    // The capital ring always survives: collapse humbles a realm, it never
    // kills it. Everything outside the ring is what comes free.
    const rumpKeep = new Set(
      cellsWithin(state, capital, FISSION_RULES.rumpRadius / cellLength)
        .filter((index) => state.cells[index]!.owner === id),
    );
    const freed: number[] = [];
    let structuresFreed = 0;
    for (let index = 0; index < state.cells.length; index += 1) {
      const cell = state.cells[index]!;
      if (cell.owner !== id || rumpKeep.has(index)) continue;
      freed.push(index);
      if (cell.structure) structuresFreed += 1;
    }

    // The freed constituents, heaviest first; the rump keeps its own
    // founding family, so that base is never spawned against it.
    const constituents = FOUNDING_ELEMENTS
      .filter((base) => composition[base] > 0 && base !== faction.element)
      .sort((first, second) =>
        composition[second] - composition[first]
        || FOUNDING_ELEMENTS.indexOf(first) - FOUNDING_ELEMENTS.indexOf(second))
      .slice(0, FISSION_RULES.maxSuccessors);

    const dispersed: FoundingElementId[] = [];
    const picks: Array<{ key: string; element: ElementId }> = [];
    const used = new Set<PlayerId>();
    for (const base of constituents) {
      const slot = PLAYER_ORDER.find((candidate) =>
        playerElement(candidate) === base
        && !state.factions[candidate].alive
        && !used.has(candidate));
      if (!slot) {
        // No fallen realm of that family to restore: the element disperses
        // unclaimed into the freed country.
        dispersed.push(base);
        continue;
      }
      used.add(slot);
      picks.push({ key: slot, element: base });
    }

    // Free the country first, then let the constituents draft their seats on
    // it — the same full-knowledge settlement draft that opened the world,
    // crowded by the rump capital and each other.
    for (const index of freed) {
      const cell = state.cells[index]!;
      cell.owner = null;
      cell.pressure = 0;
      cell.pressureBy = null;
      cell.pressureTracked = false;
    }
    const freedSet = new Set(freed);
    const drafted = picks.length === 0 ? [] : draftSites(state, picks, {
      value: state.strategicMeta.value,
      affinityOf: (element) => elementAffinityField(state, element, SPAWN_RULES.affinityRadius),
      valueWeight: SPAWN_RULES.valueWeight,
      affinityWeight: SPAWN_RULES.affinityWeight,
      crowdingWeight: SPAWN_RULES.crowdingWeight,
      crowdingFalloff: SPAWN_RULES.crowdingFalloff,
      separation: FISSION_RULES.successorSeparation,
      separationRelaxation: SPAWN_RULES.separationRelaxation,
      candidate: (index) => freedSet.has(index),
      priorSites: [capital],
    });
    for (const pick of picks) {
      if (!drafted.some((site) => site.key === pick.key)) {
        dispersed.push(pick.element as FoundingElementId);
      }
    }

    const successorIds: string[] = [];
    const successorElements: string[] = [];
    const successorSeeds: number[] = [];
    const successorCells: number[] = [];
    for (const site of drafted) {
      const slot = site.key as PlayerId;
      const successor = state.factions[slot];
      const base = site.element;
      let claimed = 0;
      for (const index of cellsWithin(state, site.index, FISSION_RULES.successorRadius / cellLength)) {
        const cell = state.cells[index]!;
        if (!freedSet.has(index) || cell.owner !== null) continue;
        cell.owner = slot;
        cell.capturedAt = state.tick;
        claimed += 1;
      }
      const seat = state.cells[site.index]!;
      seat.capitalOf = slot;
      if (seat.structure === null) {
        // A restored court founds its seat where nothing stands; standing
        // works are claimed as they are — nothing is ever razed.
        seat.structure = "city";
        seat.structureLevel = 1;
        seat.structureHeritage = base;
      }
      this.restoreRealm(state, successor, base, site.index);
      recalculateRealm(state, slot);
      successor.troops = Math.min(FISSION_RULES.successorTroops, successor.troopCap);
      successor.gold = FISSION_RULES.successorGold;
      successorIds.push(slot);
      successorElements.push(base);
      successorSeeds.push(site.index);
      successorCells.push(claimed);
    }

    // The rump: same polity, humbled — demoted to its founding element with
    // its held powers spent, its name and titles kept. Its wars, weariness
    // and grudges are still its own.
    const previousTitle = faction.identity.title;
    faction.expressedElement = faction.element;
    faction.absorbedElements = [faction.element];
    faction.elementCounts = { [faction.element]: 1 } as Record<ElementId, number>;
    faction.baseMask = baseMaskOf(faction.absorbedElements);
    faction.power = createPowerState();
    faction.power.tally = faction.capturedTiles;
    faction.transmutation = createTransmutationState();
    faction.saturation = 0;
    faction.strain = 0;
    faction.strainGraceUntil = state.tick + FISSION_RULES.graceTicks;
    applyRename(faction.identity, state.tick, { element: faction.element }, "restoration");
    markCellsChanged(state);
    recalculateRealm(state, id);
    state.railNetworkNeedsExpansion = true;

    context.report({
      domain: "politics",
      kind: "politics.fission",
      importance: "historic",
      storyKey: `fission:${id}`,
      initiator: realmSubject(state, id),
      targets: [],
      participants: drafted.map((site) => realmSubject(state, site.key as PlayerId)),
      links: {},
      facts: {
        element: expressed,
        tier: ELEMENTS[expressed].tier,
        freedCells: freed.length,
        structuresFreed,
        successorIds,
        successorElements,
        successorSeeds,
        successorCells,
        dispersed: [...dispersed],
        rumpElement: faction.element,
        previousTitle,
      },
      summary: `${previousTitle} shatters along its elemental seams: ${ELEMENTS[expressed].name} comes apart, and its freed lands — every road and work still standing — lie open to whoever claims them.`,
    });
    context.emit(
      `${previousTitle} breaks apart — the age of its ${ELEMENTS[expressed].name.toLowerCase()} empire ends.`,
      "fall",
      id,
    );
    for (const site of drafted) {
      const slot = site.key as PlayerId;
      context.report({
        domain: "politics",
        kind: "politics.realm-restored",
        importance: "major",
        storyKey: `fission:${id}`,
        initiator: realmSubject(state, slot),
        targets: [realmSubject(state, id)],
        participants: [],
        links: {},
        facts: {
          element: site.element,
          from: id,
          seedIndex: site.index,
        },
        summary: `${realmTitle(state, slot)} rises again: the freed ${ELEMENTS[site.element].name.toLowerCase()} of the fallen empire gathers under an old banner.`,
      });
      context.emit(
        `${realmTitle(state, slot)} rises from the breaking of ${previousTitle}.`,
        "rise",
        slot,
      );
    }
  }

  /** Wakes a fallen roster slot as a freed founding-element realm. */
  private restoreRealm(
    state: SimulationContext["state"],
    successor: FactionState,
    base: ElementId,
    seedIndex: number,
  ): void {
    successor.expressedElement = base;
    successor.absorbedElements = [base];
    successor.elementCounts = { [base]: 1 } as Record<ElementId, number>;
    successor.baseMask = baseMaskOf(successor.absorbedElements);
    successor.capitalIndex = seedIndex;
    successor.power = createPowerState();
    successor.power.tally = successor.capturedTiles;
    successor.transmutation = createTransmutationState();
    successor.saturation = 0;
    successor.strain = 0;
    successor.strainGraceUntil = state.tick + FISSION_RULES.graceTicks;
    successor.warWeariness = 0;
    successor.traitorUntil = 0;
    successor.warships = 0;
    successor.lastConqueror = null;
    successor.previousTerritory = 0;
    // A restored court re-reads its temperament from its element and seat,
    // seeded off the world and the moment rather than any RNG stream.
    successor.strategy = initialStrategy(
      state.seed ^ Math.imul(state.tick + 1, 2654435761) ^ seedIndex,
      successor.id,
      base,
    );
    successor.identity.absorbedAt = null;
    applyRename(successor.identity, state.tick, { element: base }, "restoration");
    successor.intent = {
      target: null,
      posture: "peaceful",
      confidence: 0.58,
      plannedCommitment: 0,
      reason: "Restored from the breaking of an empire. Gather the old lands and begin again.",
    };
    // The slot's old life may have left campaigns and treaties mid-flight;
    // a restoration starts clean at peace with the whole world.
    state.campaigns = state.campaigns.filter(
      (campaign) => campaign.attacker !== successor.id && campaign.target !== successor.id,
    );
    for (const other of PLAYER_ORDER) {
      if (other === successor.id) continue;
      const relation = getRelation(state, successor.id, other);
      relation.status = "peace";
      relation.since = state.tick;
      relation.cooldownUntil = state.tick + state.config.minimumPeaceTicks;
      relation.truceUntil = 0;
      relation.truceOfferBy = null;
      relation.truceOfferAt = 0;
      relation.lastAggressor = null;
      relation.tradeActive = true;
      relation.tradeDisabledBy = [];
      relation.storyKey = null;
    }
  }
}
