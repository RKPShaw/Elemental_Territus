# Elemental Frontiers

A deterministic, self-playing pressure-front strategy simulation. Five elemental
realms begin at peace, grow troops and economies, declare wars, commit armies,
and push continuous political borders across land and sea.

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
npm run sim -- inspect trade --tick 900 # or diplomacy, campaigns, theaters, regions, economy, structures, stories
npm run sim -- systems                  # per-system timing profile
npm run sim -- doctor                   # check every system is doing its job
```

`doctor` runs a world and asserts each of the fourteen systems produced its
characteristic activity — trade completed journeys, campaigns concluded,
theaters formed, the partition moved — and exits non-zero naming anything that
has gone quiet. It is the fastest way to find a system that silently stopped
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

### Domain boundaries

- `app/game/types.ts` is the shared domain contract.
- `app/game/rules.ts` is the centralized balance surface: terrain, buildings,
  diplomacy, economy, troop capacity and campaign constants.
- `app/game/world.ts` generates seeded terrain, water, starting realms and the
  all-peace diplomatic graph.
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
2. neutral-land settlement, realm accounting and troop-cap recalculation;
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
- Every nation begins with a compact territory, roughly 12–16K home population,
  a 20K treasury, and no prebuilt city or factory. Settlement fronts spend
  population while later city development raises capacity toward the 1.5M cap.
- Nations score, offer and accept ten-minute alliance truces from power parity,
  trade potential, geography and shared threats. A truce can be betrayed only
  for a strong strategic opening.
- A truce betrayer is exposed for 30 ticks and is 35% easier for every nation to
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
  all-to-all mesh. Cities can bridge factory networks or snap into a nearby rail
  edge, becoming true shortest-path stations.
- Each factory may operate one train at a time. A train follows the least-cost
  graph path, dwells two seconds at each reached station, and excludes its own
  launch factory from the payout. Domestic stops pay the train realm 50K;
  foreign stops pay both train and host realms 100K, for 4× total value. The
  world supports up to 300 simultaneous trains.
- Merchant ships select random destination harbors and use contiguous water-only
  paths. Their fixed velocity makes long voyages last several world minutes;
  payout is 4K per planned travel second and the world supports up to 1,000 ships.
- Foreign destination nations receive a host share. Either peaceful party may
  close or reopen trade, while war always cancels it.
- Cities use a separate 25K / 50K / 100K / 250K+ construction ladder; factories
  and harbors share another. Every city level adds exactly 10,000 troop capacity on top of sustainable-land
  capacity, with the realm total hard-capped at 1.5 million.
- Fallen realms do not remain in active diplomacy or consume war planning.
- The nation taking a realm's final territory absorbs every element that realm
  held. Absorbed elements expand its combat options through a best-attack versus
  best-counter matchup rather than a permanent flat strength bonus.

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
