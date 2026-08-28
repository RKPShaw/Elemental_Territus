# Elemental Frontiers

A deterministic, self-playing pressure-front strategy simulation. Forty-eight
players across four founding elemental families begin at peace, grow troops and
economies, declare wars, commit armies, and push continuous political borders
across land and sea. Conquest accumulates elemental history: a realm that
absorbs the right rivals ascends to compound and advanced elements from a
25-element, three-tier space, changing its matchups and its strategic
character.

## Run locally

```bash
npm run dev
```

Useful checks:

```bash
npm run lint
npm test
npm run simulate:batch -- --games 100 --max-ticks 1800 --workers 8
```

Node.js `>=22.13.0` is required.

## Play and inspect from the terminal

`npm run sim` runs the real engine with the real ordered systems — no browser,
no bundler, and no installed dependencies, since `app/game` imports nothing
outside itself:

```bash
npm run sim -- watch --speed 8          # play a world in the terminal
npm run sim -- map --tick 900 --mode regions
npm run sim -- events --domain trade --limit 20
npm run sim -- inspect trade --tick 900 # or diplomacy, campaigns, theaters, regions, economy, structures, elements, stories
npm run sim -- systems                  # per-system timing profile
npm run sim -- doctor                   # check every system is doing its job
```

`doctor` runs a world and asserts each of the eighteen systems produced its
characteristic activity — trade completed journeys, campaigns concluded,
ascensions expressed, theaters formed, the partition moved — and exits non-zero
naming anything that has gone quiet. It is the fastest way to find a system that silently stopped
working, which aggregate balance metrics tend to hide.

`npm run sim -- help` lists every command and flag. Because none of this needs
`node_modules`, `npm run test:sim` runs the whole gameplay and determinism suite
from a bare checkout too.

## Architecture

The simulation is a headless TypeScript domain core. React renders immutable
snapshots but does not own game rules, timers, AI decisions or random state.

```text
seeded world
    ↓
ordered simulation systems
    ↓
AI intents → validated commands → domain mutations
    ↓
immutable snapshot
    ↓
canvas map + React intelligence panels
```

The core is deterministic: the same seed, configuration and ordered system list
produce the same world. This makes balance sweeps, replays, multiplayer lockstep,
server-authoritative simulation and save migration natural future extensions.

### Players and elements

A player is not an element. Forty-eight players compete, twelve sharing each of
the four founding elements — ember, tide, stone and gale — so siblings inherit
an element's matchups, favoured terrain and temperament while playing as
separate powers with their own territory, treasury and diplomacy.
`app/game/players.ts` holds the roster, the element behind each id, and a
distinct colour per player; `ElementId` still means the elemental character,
and `PlayerId` means the power.

The wider space is earned, not seated. Grove retired as a starting family and
returns as the first acquirable compound: every element beyond the founding
four — six tier-2 compounds and fifteen tier-3 advanced elements — is declared
in `app/game/elements.ts` and expressed through ascension. Conquest transfers
a fallen realm's element tallies to its conqueror; when those tallies cover a
compound's founding bases deeply enough (or an advanced element's compounds,
with a long enough conquest record), the realm ascends: `dynasty.element-ascended`
enters the report, its priorities lean toward what it became, and its combat
matchups read its expressed element. Expression only ever upgrades.
`app/game/ascension.ts` owns the arithmetic; combat resolves matchups through
the composed 25×25 table with graded relief for the founding bases a
disadvantaged realm's history covers.

Identity now answers the story. Realms wake with plain, generic founding
names — unique village names like "Corvale", drafted from the world seed in
`app/game/naming.ts` — and earn grander ones as their history is written: the
`realm-naming` system climbs a title ladder from freehold through March and
Kingdom to "Empire of …" on conquest and held land, weaves a newly expressed
compound or advanced element into the style ("Steam Kingdom of Corvale"), and
folds a fallen kingdom's name into its conqueror's ("Corvale-Ashmere").
Every change is recorded on the realm's identity history and reported as
`dynasty.realm-renamed`, so the story system narrates the naming arc; the
"marriage" and "decree" rename reasons are reserved for future dynastic
systems to rename realms through the same machinery. Colors repaint the same
way: territory, icons, emblems and legend chips all wear the color of the
element a realm currently expresses, so combining elements visibly recolors
the realm.

Ascension is legible wherever the observer looks. Badges wear the expressed
element's glyph, tier numeral and colors — in the realm strip, the council
emblem, the map's capital markers and the terminal standings alike. Panels carry ascension titles
("Steam-ascended"), matchup labels name the expressed elements meeting
("Steam edge over Tide"), the council panel shows each court's standing
priorities beside the moment's intent — and its power meter, when the
expressed element carries a bespoke mechanic. One realm's ascensions, power
releases and strategy turns each consolidate into story arcs of their own;
`npm run sim -- inspect stories --kind dynasty` reaches them under the
historic wars.

An advanced element also *does* something. Five tier-3 identities carry a
bespoke mechanic — geyser banks pressure and erupts into its wars, tempest
gathers conquest momentum that decays when pinned down, bloom settles half
again as fast until overextension checks it, plasma runs every payout hot
against a gold burn that can fail containment, obsidian reflects attacker
casualties until sustained siege shatters the edge — and every remaining
tier-3 identity leans through a bounded stat profile at the same
chokepoints. `app/game/powers.ts` owns the meters and factors, the
`element-powers` system advances them, and each mechanic's weakness triggers
mechanically from world state rather than relying on rival AI cleverness.

Three identities are information instead. Every realm acts on remembered,
imperfect beliefs about the ground (`app/game/theater-map.ts`), and the
mist–mirage–glass trio expresses entirely on that layer: glass observes
twice per interval and acts on fresher ground than anyone; the regions the
Veilfolk hold in plurality veil distant rivals' measurements toward what
those rivals already believed, pierced only by a real foothold, a pressing
front, or an ally standing there whose clear reading pools through the
sight group; and rivals read the prize and openness of the Falselights'
plurality regions at a fraction of what their own stores honestly hold,
an illusion that collapses for any viewer whose sight group has two members
with contact on the region. Realms whose expressed element trades by air
share glass's swift sight — the view from above stacks on the skyport
carrier. `app/game/information.ts` owns all of it; no fog-of-war system
exists, and no other system knows the identities are there.

Starts are drafted rather than fixed. Terrain is generated first, then each
player in turn takes the best site still available to it, scoring the shared
strategic value field against how well the surrounding terrain suits its
element, with a minimum separation between rivals. The pick order snakes across
the elements, because picking sequentially is otherwise unfair to whoever picks
last. `app/game/spawn.ts` owns this; `SPAWN_RULES` in `rules.ts` tunes it.

### Domain boundaries

- `app/game/types.ts` is the shared domain contract.
- `app/game/rules.ts` is the centralized balance surface: terrain, buildings,
  diplomacy, economy, troop capacity, spawn placement and campaign constants.
- `app/game/players.ts` is the player roster and the player-to-element mapping.
- `app/game/world.ts` generates seeded terrain and water, then drafts starts
  through `spawn.ts` and builds the all-peace diplomatic graph.
- `app/game/engine.ts` owns deterministic stepping and immutable snapshots.
- `app/game/batch.ts` runs the exact headless pipeline, while
  `batch-metrics.ts` collects compact balance counters and checkpoint snapshots.
- `app/game/diplomacy.ts`, `grid.ts` and `elements.ts` expose focused domain
  queries with no UI dependencies.
- `app/game/campaigns.ts` owns derived troop-reservation selectors shared by the
  economy and interface, so committed-population accounting cannot drift.
- `app/game/systems/` contains small ordered systems. Each implements the same
  `SimulationSystem` interface and can be inserted, replaced or tested alone.
- `app/ui/WorldMap.tsx` is the political-map renderer.
- `app/ui/Simulator.tsx` is the observer interface and simulation controls.

### Continuous tick pipeline

`app/game/systems/index.ts` is the composition root. Every shared clock tick runs:

1. clock and pressure decay;
2. neutral-land settlement, realm accounting, elemental ascension, power
   meters and troop-cap recalculation;
3. economic growth and trade-vehicle resolution;
4. truce timers plus diplomatic and military AI intent;
5. construction intent;
6. command validation/execution;
7. land and naval pressure-front resolution;
8. victory evaluation.

AI systems enqueue typed commands rather than mutating unrelated state directly.
The command system is the validation boundary for declarations, peace treaties,
troop commitments, naval launches and construction. That separation allows a
future human controller, network client, replay file or different AI policy to
drive the same simulation safely.

## Core invariants

- Every diplomatic pair begins at peace; territory cannot be attacked until a
  formal declaration of war succeeds.
- Every player begins with a compact territory, roughly 12–16K home population,
  a 20K treasury, and a single founded city on its capital tile. Settlement
  fronts spend population while later city development raises capacity toward
  the 1.5M cap.
- Players score, offer and accept ten-minute alliance truces from power parity,
  trade potential, geography and shared threats. A truce can be betrayed only
  for a strong strategic opening.
- A truce betrayer is exposed for 30 ticks and is 35% easier for every player to
  attack. Betraying an already exposed traitor carries no new traitor penalty.
- Every war has one directional offensive front owned by its declarer. A defender
  may reserve troops to stunt it; those troops cancel the attacker one-for-one
  instead of opening a reciprocal front.
- Launching or defending a campaign deducts committed troops from the home population.
- Committed troops still count against the troop cap but do not contribute to
  growth; the deployed reservation dwindles through the cost of advancing.
- Border movement uses hidden local pressure rendered as one advancing front;
  it does not paint contested squares or spawn skirmish units.
- Visible borders are threshold bands in a filtered ownership field. They are
  raster contours rather than splines or paths through grid corners, and local
  campaign pressure shifts the field continuously before a tile changes owner.
- Attack advantage saturates at a 2:1 troop-density ratio.
- Terrain changes defense and sustainable growth in opposite directions.
- Fort coverage doubles invasion cost; forts are the only defensive structure.
- Distinct infrastructure sites obey a shared spacing rule. Cities are the sole
  exception: they may stack into defensible urban centers, with each extra level
  adding 50% station value but yielding less coverage than a spread-out network.
- Factory catchments generate a sparse minimum-link rail graph rather than an
  all-to-all mesh. New cities are founded directly on laid track whenever the
  rails have reached a realm's territory, so stations sit on the line itself.
- Every trade form owns its own carrier network: land is the road-and-rail
  graph and whatever rolls over it — wagons, cars, trains, any convoy; the
  waterway is the harbors and their ships; energy is the power plants and the
  straight conduits they string; airborne is the skyports flying freight
  point to point. A realm whose expressed element trades by a form earns 15%
  more on that carrier's income, rewards only.
- Each factory may operate one land convoy at a time. A convoy runs the
  shortest physical path over the laid network from its factory to its
  destination, dwells two seconds at each station that path actually passes
  through -- a city off the line is passed by -- and excludes its own launch
  factory from the payout. Domestic stops pay the convoy realm 50K; foreign
  stops pay both convoy and host realms 100K, for 4× total value; a land
  realm's stations host foreign stops for 15% more. The world supports up to
  75 simultaneous convoys.
- Power plants rise only for realms whose expressed element trades by
  energy. A plant strings straight conduits to up to three stations within
  reach and sends paying pulses down them — a flat 45K per delivery, so
  energy trade is frequency, not distance. Captured plants keep pulsing for
  their captor, who earns no energy bonus without the form.
- Skyports rise only for realms whose expressed element trades by air, and
  fly freight in a straight line to any other skyport in the world — no
  network to lay, no ground to answer to — paying 5.5K per planned travel
  second, with a minimum worthwhile hop.
- Every realm opens with its capital as a founded city. Capturing a capital
  annexes the defender's entire remaining territory on the spot: the realm
  falls to the captor along with its elements.
- Merchant ships select random destination harbors and use contiguous water-only
  paths. Their fixed velocity makes long voyages last several world minutes;
  payout is 4K per planned travel second -- 15% more for a realm whose
  expressed element trades by waterway -- and the world supports up to 1,000
  ships.
- On every carrier that pays a host on arrival — ships, pulses and flyers —
  the foreign destination receives a host share: 18% between strangers, 24%
  or 30% when the parties' expressed elements share one or both trade forms,
  and 35% between allies -- the best applicable rate wins, so resonance never
  costs a host what diplomacy earned. Either peaceful party may close or
  reopen trade, while war always cancels it.
- Cities use a separate 25K / 50K / 100K / 250K+ construction ladder; every
  trade building — factories, harbors, plants and skyports — advances one
  shared ladder. Every city level adds exactly 10,000 troop capacity on top of sustainable-land
  capacity, with the realm total hard-capped at 1.5 million.
- Fallen realms do not remain in active diplomacy or consume war planning.
- The player taking a realm's final territory absorbs every element that realm
  held, and its conquest tallies with them. Matchups read each realm's
  expressed element against its rival's, graded down by at most a third when
  the disadvantaged side's absorbed history covers the advantaged element's
  founding bases — history softens a matchup, it never erases one.
- Ascension is the technology tree: tier 2 needs depth two in both founding
  constituents, tier 3 needs both compound constituents formable and six realms
  absorbed altogether. Expression upgrades once and never demotes, and an
  ascended realm keeps its name and colors — titles, not rebrands.
- Information identities act only on beliefs, never on the world. A glass or
  airborne-trading realm observes twice per interval instead of once; a mist
  realm's plurality regions blend distant rivals' measurements 70% back
  toward what those rivals already believed, pierced by holding 4% of the
  region's cells or pressing a front there; a mirage realm's plurality
  regions read at 60% of their believed prize and openness, collapsing for
  any viewer whose sight group holds two members with contact on the region.
  Belief stores stay honest under mirage — the illusion lives in the reading
  — and a veiled look still stamps fresh, so mist ground is never invisible,
  only chronically misjudged.
- Trade forms lean construction through the same strategy quotas: a realm
  whose expressed element trades by waterway wants harbors at a 34% share of
  its trade buildings instead of 22% and reaches for them first; energy
  realms reach for their plants, airborne realms for their skyports, and
  land realms let road-laying trade buildings jump the city queue without
  wanting fewer of either.

## Extending the simulation

- Add a rule by extending the domain types and central balance surface first.
- Add behavior as a new `SimulationSystem` and register it explicitly in the
  composition root.
- Add a controller by emitting existing `WorldCommand` values; avoid bypassing
  command validation.
- Add persistence by serializing `WorldState` plus a schema version. Randomness
  remains reproducible from the seed and deterministic system order.
- Add replay/network support by storing seed, config and the command stream rather
  than recording rendered frames.

## Deployment

This project is hosted with ChatGPT Sites. `.openai/hosting.json` is the hosting
manifest, and `npm run build` produces the Vinext/Cloudflare artifact.
