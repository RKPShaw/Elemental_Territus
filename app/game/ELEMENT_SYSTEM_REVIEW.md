# Element System Design Review

A review of the *Elemental Territus — Element System Design* document (elements,
affinities, economy, combat, trade, weaknesses, and inherited infrastructure)
against the running simulation, written August 2026. It evaluates how well the
proposed 25-element, three-tier system integrates with the engine as it exists,
names the hurdles, recommends an implementation path, and questions the parts
of the design that would detract from the game.

Two decisions were made during this review and are baked into the roadmap:

1. **The roster reworks to the four founding families.** Grove retires as a
   *starting* family; the roster redistributes over ember (Fire), tide (Water),
   stone (Earth) and gale (Air). Grove/Nature remains in the element space as
   an **acquirable** Tier 2 element — the first compound a conqueror of Water
   and Earth realms can express.
2. **A strategic-priorities system joins the design.** Each realm carries a
   weighted priority list — economy, conquest, ascension, diplomacy, defense,
   trade — that element identity seeds and situation modulates. It is the
   connective tissue between "elements describe complete civilizational
   behavior" and the three AI systems that actually behave.

---

## 1. Verdict

**Strong conceptual fit; large but phaseable mechanical lift.** The design
document's philosophy is nearly a restatement of principles this codebase
already enforces:

- *"Elemental advantage should matter without deciding the battle — roughly
  10–15%."* The engine's only elemental combat effect is already a ±12%
  pressure multiplier (`elements.ts:84-88`), applied in exactly two places in
  campaign resolution (`systems/campaign.ts:390,527`).
- *"Ports, roads, grids and specialist populations do not vanish when an
  element changes."* Already true, absolutely: no code path ever destroys a
  structure, captured buildings transfer intact at full level
  (`systems/campaign.ts:64-159`), and rail track persists through ownership
  and diplomacy changes as a documented, tested invariant
  (`STRATEGIC_GEOGRAPHY.md`, asserted in `tests/simulation.test.ts`).
- *"Numerical modifiers should be derived from these identities rather than
  defining them."* The `rules.ts` centralized-balance convention is the same
  idea applied to code.

The document reads like it was written for this engine. What it adds —
tiers, trade-form affinity, infrastructure *efficiency* memory, ascension —
are layers on seams the codebase deliberately left open: `elementCounts` is
maintained and read by nothing (`types.ts:133`), `defenseMultiplier` is
exported dead code (`systems/shared.ts:24-42`), report namespaces
`dynasty.*` / `leadership.*` are reserved and tested but unused
(`types.ts:391-397`, `tests/simulation.test.ts:496`), and
`ElementDefinition.temperament` promises per-element behavior that no AI
reads today.

### Fit table

| Design-doc concept | Existing state | Fit |
|---|---|---|
| 10–15% advantage, "matters without deciding" | `matchup()` is exactly ±12% on pressure | already true |
| Infrastructure survives element/owner change | Never destroyed; rail is permanent world memory | already true (physical layer) |
| Native / Legacy / Incompatible efficiency | Nothing — capture is 100% efficient instantly | additive layer |
| Element acquisition through history | `absorbedElements` union on conquest; unused `elementCounts` | natural progression vehicle |
| Waterway trade form | Harbors + ships + sea lanes | direct map |
| Land trade form | Rails + trains + cities | direct map |
| Energy trade form | Factories exist as rail nodes; no energy concept | reinterpret factories as the Energy carrier |
| Airborne trade form | Nothing | no carrier — see cuts |
| Trade resonance / synergy | Allied host share (0.18 → 0.35) is the only relational trade modifier | additive multipliers on one balance surface |
| 4-base counter cycle | Symmetric 5-cycle over 5 families | roster rework (decided) |
| Tiers, failure states, special mechanics | Nothing — five flat elements | the big build |
| Resonant conquest | Theater/AI valuation element-blind except matchup | new terms in existing scorers |
| Information mechanics (Mist/Mirage/Glass) | Per-player belief layer with staleness already drives AI | reinterpretable without fog-of-war |
| Specialists / guilds | No unit or population entities | fold into structure status |
| Scorched-earth denial | Contradicts the documented permanence invariant | **cut** |

## 2. What already aligns

- **The matchup magnitude is done.** `matchup()` returns 1.12 / 1.0 / 0.88 —
  inside the document's band. The numbers are hardcoded in `elements.ts`
  rather than `rules.ts` (the one violation of the stated balance-surface
  convention); moving them into an `ELEMENT_RULES` block is part of Phase 1.
- **Absorption is the progression vehicle.** Capturing a realm's last
  territory unions its `absorbedElements` into the conqueror transitively
  (`systems/accounting.ts:17-33`), and `elementCounts` already tallies how
  many realms of each element a dynasty has taken. Tier formability can be
  computed from these two existing fields alone.
- **Infrastructure memory exists physically.** What the document calls
  "infrastructure remembers" needs only the *efficiency* half built: who can
  exploit a captured network best, not whether it survives.
- **Observation memory exists.** `theater-map.ts` holds per-player,
  per-region beliefs (infrastructure, access, undefended, prize) refreshed
  only where a realm has contact — its own ground, its fronts, **and its
  trade-route corridors** — with allies and live trade partners pooling the
  freshest reading (`sightGroup`). Trade routes are already an intelligence
  mechanic; the information-flavored elements can be built on this instead of
  a fog-of-war system.
- **The extension protocol was built for this.** Types → rules block → new
  `SimulationSystem` registered in the composition root → commands through
  the validation boundary with compile-time report coverage → reserved
  report namespaces → a doctor check. The future-feature test at
  `tests/simulation.test.ts:496` even demonstrates a `dynasty.*` event
  flowing into stories.

## 3. Major hurdles

1. **Roster migration (decided: four founding families).** Player ids
   (`"ember-1"`), colors, the snake draft, tests, the README and the map
   raster protocol all assume five families of ten. The rework touches
   `players.ts`, `scripts/sim/render-map.ts` (five hardcoded realm letters),
   `tests/world-digest.ts` element codes, batch aggregation, UI legend and
   README, and re-records every determinism baseline (drafted starts change,
   so every world differs — intended).
2. **The document has no progression rule.** How a civilization *reaches*
   Steam or Geyser is unspecified — the single biggest design gap. This
   review authors one (section 7) from the existing absorption mechanics.
3. **The matchup model must be restructured.** Today's `realmMatchup` is a
   maximin over flat element sets (`elements.ts:102-112`): it returns only
   {0.88, 1, 1.12} and *saturates* — a defender holding three well-chosen
   elements is already immune to the edge. Tiered matchups need a
   precomputed table and graded history relief, and the function sits in the
   innermost per-tile combat loop, so it must stay O(1).
4. **Two of four trade forms have no carrier.** Energy is reinterpretable
   over factories (they are the industrial dispatchers already); Airborne has
   nothing and should not get a third vehicle network (see cuts).
5. **Per-structure provenance.** Legacy status needs a builder-heritage field
   on cells, which ripples through the snapshot clone, the world digest and
   the determinism baselines. Mechanical but wide.
6. **AI must understand the new value space** — promotion targets ("that
   realm holds the base I need"), trade-form affinity in construction siting,
   resonant conquest in war planning. The strategic-priorities system
   (section 6) is the coherent home for these instead of scattered magic
   weights.
7. **The balance-sweep tooling is broken today.** `npm run simulate:batch`
   crashes: `scripts/simulate-batch.ts` indexes player-keyed snapshots with
   `ELEMENT_ORDER` ids, divides per-realm statistics by 5 instead of the
   roster size, and compares champion `PlayerId`s against `ElementId`s (never
   equal). No sweep-driven balancing can happen until this is fixed
   (roadmap Phase 0). `scripts/simulate-balance.ts` is orphaned dead code
   from the pre-50-player era and should be deleted.
8. **Twenty-five special mechanics is not twenty-five subsystems.** The
   document's own derivation principle licenses shipping most element
   identities as bounded stat profiles over shared systems; only a curated
   subset of Tier 3 earns bespoke code (section 8, Phase 6).
9. **Determinism discipline.** Every behavior phase re-records the nine
   golden digests. The policy in `tests/determinism.test.ts` supports this —
   each re-baseline must simply be deliberate and documented.
10. **Legibility.** Compound elements need badges, tier glyphs and titles
    that ride on top of the family color system rather than replacing it.

## 4. Design critique — what would detract from the game

These are the parts of the document this review recommends changing or
cutting. Everything else stands.

1. **Cut scorched-earth denial.** "The defender dismantles or scorches a
   low-value legacy network before capture" contradicts the document's own
   closing principle — *"trade networks, populations and institutions allow
   the map to remember former civilizations"* — and the engine's tested
   permanence invariant that makes resonant conquest possible at all. Razing
   deletes exactly the strategic texture the rest of the design celebrates.
2. **Reinterpret, don't build, deception.** Mirage's false armies and market
   manipulation, and Mist's obscured positioning, presuppose actors that can
   be deceived. The simulation is perfect-information for the observer — but
   the AI already acts on a stale, per-player belief layer, so the identities
   survive translation: Mist makes rivals' observations of your regions go
   stale faster; Glass makes your own observations refresh faster; Mirage
   distorts rivals' *believed* prize and defense of your regions, collapsing
   automatically for any viewer whose sight group has real contact — "an
   informed opponent can collapse the illusion" as pooled sight, which trade
   routes and alliances already create. Literal decoy armies and market
   manipulation are cut.
3. **The counterless trio is a dominance trap unless weaknesses are
   automatic.** Mirage, Obsidian and Spirit have no elemental counter by
   design; "opponents must break their special mechanic." A self-playing sim
   cannot rely on bespoke AI cleverness per element — if the AI can't execute
   the counter, these become an uncounterable apex. Their weaknesses must
   trigger mechanically from world state: Obsidian's fracture cascades after
   sustained defense; Spirit requires living population and meaningful
   territory; Mirage collapses under pooled sight. (The proposed matchup
   model produces their "no inherent counter" automatically — a balanced
   composition has zero edge against everything — so their entire power
   budget lives in their mechanic and its breakable weakness.)
4. **Specialists and guilds should not be simulated people.** Armies are
   already a scalar in this engine. A per-structure operating status (native /
   legacy / incompatible efficiency) delivers the same fiction, and story
   events can *narrate* guilds staying or fleeing without a population
   subsystem.
5. **Tier 3 must be rare.** If ascension is easy, the late game becomes
   fifteen exotic mechanics nobody can follow. The progression thresholds are
   deliberately steep — a handful of Tier 3 realms per game, each arrival a
   `historic` story event. Scarcity is what makes "conditional power, severe
   failure state" legible and dramatic.
6. **Ascension must not rename dynasties.** Realm identity — name, colors,
   family — is how an observer tracks fifty powers. Expressed elements are
   titles and badges ("Ember III, Steam-ascended"), never new names. The
   document's own framing supports this: the current element determines what
   comes naturally; history determines the rest.
7. **Neutral pairs flatten combat texture.** The document's 4-cycle makes
   Fire–Air and Water–Earth flatly even, where today's 5-cycle gives every
   pair an edge. With the tier layer carrying matchup interest this is
   acceptable, but the rules block should keep an optional small edge knob
   for neutral pairs (default 0, document-faithful) in case sweeps show
   mid-game combat going elementally flat.
8. **One counter flips, deliberately.** Three of the document's four edges
   already match the game (tide beats ember; stone beats gale; gale beats
   tide) but **Fire–Earth reverses**: today stone beats ember, while the
   document has Fire countering Earth. Adopting the document's cycle is a
   real gameplay change to a long-standing matchup and is gated by the
   balance sweep in Phase 3.

## 5. The chosen direction: four founding families

- `ELEMENT_ORDER` (the founding roster) becomes `ember, tide, stone, gale`.
  Grove keeps its name, glyph and colors but exists only as the acquirable
  Tier 2 Nature (tide + stone).
- `PLAYERS_PER_ELEMENT` goes 10 → 12: **48 players**, the closest even-family
  count to today's 50. `ORDINALS` gains XI and XII (the digit fallback
  already exists). Player ids `grove-*` disappear; `ember-11`, `tide-12` and
  friends appear.
- **The terrain bijection breaks, and that is a flavor win.** Forest — grove's
  favored terrain — is orphaned at the start: no founding family favors it,
  so forests begin as contested neutral ground and become prized territory
  the moment someone ascends to Nature. Spawn affinity fields are memoized
  per element, so four founding fields work unchanged.
- The document's counter cycle lands wholesale at the combat switch: the
  ember–stone edge flips, ember–gale and tide–stone go neutral.
- **Product note:** removing a starting family is a visible identity change.
  The mitigation is that Nature's *arrival* becomes a story beat — the
  Mossbound return as something earned rather than given.

## 6. The strategic-priorities system

A per-realm priority list is the missing connective tissue between element
identity and behavior, and the coherent home for every new AI concern the
element system introduces.

**State** (on `FactionState`, cloned in the snapshot, hashed by the digest):

```ts
export type StrategicDomain =
  | "economy" | "conquest" | "ascension" | "diplomacy" | "defense" | "trade";

export interface StrategicPriorities {
  weights: Record<StrategicDomain, number>; // normalized, sum 1
  focus: StrategicDomain;                   // leading domain, for display and stories
  adoptedAt: number;
  reason: string;                           // like AiIntent.reason
}
```

"Tech" in the usual 4X sense maps to `ascension` — element mastery *is* this
game's technology tree.

**A new `StrategicPlanningSystem`** (id `strategic-planning`), registered
between the trade network and the diplomacy AI, recomputes priorities on a
slow cadence (~40 ticks):

- **Element identity seeds the baseline.** Every element definition carries a
  `priorityProfile`: Fire leans conquest and industry, Water leans trade and
  diplomacy, Earth leans economy and defense, Air leans diplomacy and
  opportunism; compounds blend their constituents plus a signature shift.
  This finally makes `temperament` real — the existing strings ("Invests in
  harbors, trade and carefully timed naval landings") describe exactly these
  profiles and are read by nothing today.
- **Situation modulates.** Threatened realms surge defense and conquest; a
  realm one conquest away from a tier-up surges ascension; rich treasuries
  with thin infrastructure surge economy; war-weary realms surge diplomacy; a
  hegemon on the map pushes everyone toward coalition diplomacy. A small
  seeded per-ordinal noise keeps twelve siblings from being clones, and keeps
  it deterministic.
- **Existing AI systems consume, bounded.** Scorers multiply by weight
  factors clamped to [0.6, 1.6] so priorities *influence rather than gate*:
  war desire by the conquest factor, truce scoring by diplomacy, trade policy
  thresholds by trade, campaign commitment by conquest, defensive reservation
  by defense, and construction quota mix by economy/defense/conquest.
  Ascension weight scales the war-target bonus for realms whose absorption
  advances formability — the "how does the AI pursue tiers" gap, answered.
  Defense commitment stays need-driven: a pacifist realm still defends
  itself.
- **Reporting.** `leadership.strategy-adopted` on focus change — the reserved
  `leadership.*` namespace exists for exactly this — so the observer reads
  "The Cinderkin turn to conquest" in the chronicle, the story correlator
  builds strategy-era arcs, and the council panel shows the priority list
  beside the existing intent.

**Risks:** double-counting with situation terms already inside `warDesire`
(bounded multipliers and A/B sweeps mitigate); one more balance-dial layer
(every domain gets a batch counter); and the temptation to let priorities
gate behavior rather than weight it (resisted by the clamp).

## 7. Element space, matchup model, progression

### The element space

The 25 ids join the closed `ElementId` union — the compiler then enforces
every `Record<ElementId, …>` site. Each definition gains `tier`, `bases`,
`dominantBase` and `tradeForms`; the legacy `strongAgainst`/`weakAgainst`
lists retire at the combat switch.

A verified property makes the space data-driven: expanding every Tier 3
element's two Tier 2 constituents into a four-slot founding-base multiset
reproduces the document's dominance labels exactly (Geyser = Steam + Magma =
F,F,W,E, Fire-dominant; Mirage = Steam + Sand = F,W,E,A, balanced; all
fifteen check out). Dominance and counters are *computed from composition*,
never hand-authored. Trade forms stay per-element data because the document
deliberately breaks derivation there (Tempest is Fire-dominant but trades
Waterway + Airborne).

### Matchup model (replaces the maximin)

- Every element gets a composition vector over the four bases: Tier 1 is 1.0
  on its base; Tier 2 is 0.5/0.5; Tier 3 dominant is 0.5/0.25/0.25; Tier 3
  balanced is 0.25 × 4.
- A cycle matrix encodes the document's counters (+1 counter, −1 countered,
  0 for neutral pairs and same base).
- `edge(A,D) = Σ wA·wD·cycle`, and
  `mult = clamp(1 + 0.12 · edge · tierAmplitude[max tier], 0.85, 1.15)` with
  `tierAmplitude {1: 1, 2: 1.15, 3: 1.25}`.
- Consequences: Tier 1 versus its counter stays exactly ±12% (today's number,
  preserved); mixed-tier pairs grade continuously (±2–7.5%); the balanced
  trio's symmetric vectors produce zero edge against everything —
  "no inherent counter" as arithmetic. Amplitude amplifies *both* directions,
  which is the document's "higher ceiling, not a higher floor": a Tier 3
  realm caught by its counter suffers more, never enjoys a flat bonus.
- The full table precomputes into a `Float64Array(625)` at module load — an
  O(1) lookup in the innermost combat loop, cheaper than today's maximin.
- **History relief replaces saturation.** `realmMatchup` looks up the two
  *expressed* elements, then grades the edge down by at most one third based
  on how many of the rival's founding bases the defender's history covers
  (a 4-bit `baseMask` per faction). Matchups become a continuum instead of
  three values, and never fully flatten — the old failure mode, where three
  absorbed elements bought total immunity, is gone. The function signature
  does not change; all seven call sites are untouched.

### Progression (fills the document's gap)

`baseDepth[b] = Σ elementCounts[e] × multiplicity of b in e's founding-base
multiset` — a conquered Steam realm feeds both Fire and Water depth. Then:

- **Tier 2 X is formable** iff both constituent base depths ≥ 2.
- **Tier 3 Y is formable** iff both its Tier 2 constituents are formable and
  total `elementCounts` ≥ 6.
- **Expression** picks the highest formable tier (deterministic tie-breaks),
  and only ever *upgrades* — no flapping, no demotion: "history determines
  what it has learned not to forget."

With a realm's own founding stock counting one, Tier 2 takes roughly three
conquests and Tier 3 at least six absorbed realms with the right spread —
rare and late by construction. A new `ElementAscensionSystem` (registered
right after realm accounting, where absorption happens) recomputes
expression, maintains the mask, and reports `dynasty.element-ascended`
(`major` for Tier 2, `historic` for Tier 3). Conquering an ascended realm
unions its titles into the victor's history — absorbing a Steam civilization
is absorbing Steam.

## 8. Phased roadmap

Each phase is independently shippable, ends with its named checks green, and
re-records the nine determinism digests deliberately (with the documented
rationale the test header requires). Sizes: S/M/L.

| Phase | Content | Size |
|---|---|---|
| **0** | Fix `scripts/simulate-batch.ts` (three bugs: ELEMENT_ORDER indexing throw, per-realm stats divided by 5, winner counts comparing PlayerId to ElementId); delete orphaned `simulate-balance.ts`; capture a 100-game pre-elements baseline. | S |
| **1** | The 25-element data space: widened `ElementId` union, `tier`/`bases`/`dominantBase`/`tradeForms` on definitions, the `ELEMENT_RULES` block (the 1.12/0.88 finally move into `rules.ts`), the precomputed matchup table, and `tests/elements.test.ts`. **Dormant — zero behavior change; digests must not move (that is the proof).** Also fixes the latent `ReportFact` type error (`accounting.ts` passes a record the type forbids). | M |
| **2** | The strategic-priorities system: faction state, `StrategicPlanningSystem`, founding-family priority profiles (slots for all 25), bounded consumption factors in the three AI systems, `leadership.strategy-adopted` reports, doctor check, time-in-focus batch metrics. Valuable standalone — families behave differently before any new element mechanics exist. Digest re-baseline. | M |
| **3** | The 4-family roster rework + ascension + combat switch: roster to 12×4, expressed element/ascended titles/base mask, `ElementAscensionSystem`, matchup table live with history relief, legacy matchup lists deleted, ascension-seeking war targeting through the strategy system, tier metrics, `sim inspect elements`, doctor check. Digest re-baseline. **Balance gate:** 100-game sweep, every family within 12–38% of wins (4-family expectation 25%), watching the Fire–Earth flip. | L |
| **4** | Trade forms on existing carriers: Energy gives factory-owned trains +15% owner income; Land gives stations +15% host income; Waterway gives ships +15% payout; resonant sea host shares 0.24 (one shared form) / 0.30 (two) against the allied 0.35 still winning; construction affinity siting (harbor +1.4 / factory +1.2 / city +0.8, Waterway harbor quota 0.22 → 0.34) composed with the priority factors. Rewards only — no penalties at introduction. If Phase 3's sweep showed a large family swing, ship 3+4 together. | M |
| **5** | Infrastructure memory: one new cell field, `structureHeritage` (builder's expressed element, stamped at build, never cleared). Captured structures pay at 1.0 native / 0.9 legacy / 0.78 incompatible by trade-form coverage; **resonant conquest** grants ×1.2 within 600 ticks of `capturedAt` (an existing field — no new timer) plus a `territory.resonant-capture` report; theater valuation weights heritage-matching enemy structures ×1.3. No scorched earth. | M |
| **6** | Bespoke mechanics for **five** Tier 3 elements chosen for observer-visible drama on existing systems: **Geyser** (pressure bank → sudden commitment surge; the refill weakness finally animates the dead `defenseMultiplier` seam), **Tempest** (naval momentum that decays without captures), **Bloom** (settlement ×1.5 with instant sustain, automatic overextension check), **Plasma** (payouts ×1.6 with gold upkeep; treasury-zero containment failure), **Obsidian** (reflective defense with a fracture counter that flips to shatter). Everything else ships as bounded ±15% stat profiles at existing chokepoints; accumulate/release postures ride the strategy system. New `ElementPowersSystem`, per-mechanic batch counters, doctor lines (`inconclusive` allowed when no Tier 3 realm appeared). | L |
| **7** | Information elements on the belief layer (no fog-of-war build): Glass observes twice per interval; Mist blends rivals' measurements of its plurality regions toward their stale beliefs, pierced by contact and sight-group pooling; Mirage distorts rivals' believed prize/defense ×0.6, collapsing for any viewer whose sight group has two members with region contact. Airborne realms get the faster-observation identity — **no third vehicle network.** | M |
| **8** | Legibility and docs: tier glyphs in badges, ascension titles in panels and matchup labels, strategy focus in the council panel, story surfacing; README/REPORTING/STRATEGIC_GEOGRAPHY updates (the README's "fourteen systems" is already stale — fifteen exist). | S |

### Explicitly not built

Scorched-earth denial · an Airborne vehicle network · goods/commodities ·
specialist/guild population entities · literal decoy armies and market
manipulation · twenty-five bespoke mechanic kits (five + three information
elements; the rest are profiles) · demotion or element loss · per-cell
fog of war.

## 9. Verification protocol

- `npm run test:sim` green at every phase. Phase 1 additionally proves the
  digests *unchanged*; every later phase re-records the nine golden digests
  (`DETERMINISM_DEEP=1`) with a documented rationale, per the test header's
  own convention. The digests hash report text too, so wording freezes before
  each re-baseline; cell-digest stability is the "map didn't change" proof.
- `npm run sim -- doctor` green, with new checks: `strategic-planning`
  (Phase 2), `element-ascension` (Phase 3), per-mechanic lines (Phase 6), a
  belief-asymmetry assertion (Phase 7).
- `npm run simulate:batch -- --games 100` A/B against the Phase 0 baseline at
  every behavior phase; family winrate band 12–38%; new checkpoint metrics
  for tier distribution, time-in-focus, resonant captures and per-family
  income split.
- Observational: `npm run sim -- watch` shows ascension and strategy-turn
  chronicle lines; a new `inspect elements` subject shows expressed element,
  tier, base depths and next formable element per realm.

## 10. Pre-existing issues found during this review

Worth fixing regardless of the element system:

- `scripts/simulate-batch.ts` is broken three ways (Phase 0 above).
- `scripts/simulate-balance.ts` is orphaned dead code.
- `systems/accounting.ts` passes a record as a report fact, which
  `ReportFact` forbids — a latent type error.
- The README says "fourteen systems"; there are fifteen.
- `tests/world-digest.ts` carries a stale five-element owner-code table.
- `Cell.capitalOf` is never cleared on conquest: a captured capital tile
  keeps its fallen realm's capital marker (and map glyph) forever, and
  several scorers keep valuing it as one. Possibly a feature — old capitals
  *should* stay storied ground — but today it is an accident, not a rule.
