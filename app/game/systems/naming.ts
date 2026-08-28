import { PLAYER_ORDER } from "../players";
import { totalRealmsAbsorbed } from "../ascension";
import { ELEMENTS } from "../elements";
import { applyRename, combineNames, rankFor } from "../naming";
import { realmSubject } from "../reporting";
import type {
  NameChangeReason,
  PlayerId,
  SimulationContext,
  SimulationSystem,
} from "../types";

/**
 * Keeps every realm's living name true to its story.
 *
 * Runs after realm accounting and ascension, so the tick a conquest lands or
 * a new element is expressed is the tick the name answers it. Three forces
 * move a name, folded into at most one rename per realm per tick:
 *
 *  - the title ladder: absorbed realms and held land climb rank toward
 *    "Empire of ..." (rankFor);
 *  - elemental styling: a newly expressed compound or advanced element is
 *    woven into the title;
 *  - union: absorbing a realm that was itself a kingdom or greater folds the
 *    fallen name into the conqueror's ("Corvale-Ashmere").
 *
 * Every change lands in the realm's identity history and as a
 * dynasty.realm-renamed report, which the story system narrates as the
 * realm's naming arc. Future dynastic features (marriages, decrees) rename
 * through the same applyRename path with their own reasons.
 */
export class RealmNamingSystem implements SimulationSystem {
  readonly id = "realm-naming";

  update(context: SimulationContext): void {
    const { state } = context;

    // Fold newly fallen realms first, so a conqueror's rename this tick can
    // carry the union. absorbedAt marks a fall as processed exactly once.
    const pendingUnions = new Map<PlayerId, string>();
    for (const id of PLAYER_ORDER) {
      const fallen = state.factions[id];
      if (fallen.alive || fallen.identity.absorbedAt !== null) continue;
      fallen.identity.absorbedAt = state.tick;
      const conquerorId = fallen.lastConqueror;
      if (!conquerorId || !state.factions[conquerorId].alive) continue;
      // Only a great name is worth carrying: absorbing a freehold changes the
      // ledger, absorbing a kingdom changes what the conqueror is called.
      if (fallen.identity.rank >= 2) pendingUnions.set(conquerorId, fallen.identity.name);
    }

    for (const id of PLAYER_ORDER) {
      const faction = state.factions[id];
      if (!faction.alive) continue;
      const identity = faction.identity;
      const conquered = Math.max(0, totalRealmsAbsorbed(faction.elementCounts) - 1);
      const share = faction.territory / Math.max(1, state.landTiles);
      // Titles are never taken back: a diminished empire is still an empire.
      const rank = Math.max(identity.rank, rankFor(conquered, share));
      const element = faction.expressedElement;
      const unionWith = pendingUnions.get(id);
      const name = unionWith ? combineNames(identity.name, unionWith) : identity.name;
      const reason: NameChangeReason = unionWith
        ? "union"
        : element !== identity.styledElement
          ? "ascension"
          : "conquest";
      const outcome = applyRename(identity, state.tick, { name, rank, element }, reason);
      if (!outcome) continue;
      const summary = reason === "union"
        ? `${outcome.to} rises, joining the names of conqueror and conquered under one banner.`
        : reason === "ascension"
          ? `${outcome.from} takes the style of ${ELEMENTS[element].name} it now expresses: ${outcome.to}.`
          : `${outcome.from} is proclaimed ${outcome.to}.`;
      context.report({
        domain: "dynasty",
        kind: "dynasty.realm-renamed",
        importance: identity.rank >= 3 ? "major" : "notable",
        storyKey: `naming:${id}`,
        initiator: realmSubject(state, id),
        targets: [],
        participants: [],
        links: {},
        facts: {
          from: outcome.from,
          to: outcome.to,
          reason: outcome.reason,
          rank: identity.rank,
          element,
          realmsConquered: conquered,
        },
        summary,
      });
      context.emit(
        `${outcome.from} shall henceforth be known as ${outcome.to}.`,
        "rise",
        id,
      );
    }
  }
}
