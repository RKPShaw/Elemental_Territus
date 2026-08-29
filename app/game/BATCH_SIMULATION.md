# Batch simulation and balance metrics

The batch runner uses the same deterministic world, random stream, commands,
AI systems and gameplay rules as the live simulator. It removes only UI
snapshots, chronicles, retained factual reports and story correlation. A parity
test compares the complete gameplay state of live and batch worlds.

## Snapshot cadence

The default checkpoints are 1, 3, 5, 10, 15, 20, 30, 45, 60, 90 and 120
simulated minutes, plus the actual completion tick. The dense opening cadence
supports population-management tuning; the sparse late cadence captures
conquest, concentration and resource-sink requirements without bloating output.

## Metric families

### World pacing and competitiveness

- settled land share and settlement milestone ticks;
- living realms, champion and completion tick;
- leader land share, land HHI and population HHI;
- treasury Gini coefficient;
- active wars, alliances, campaigns and theaters;
- rail edges and active vehicle utilization.

These identify slow openings, runaway leaders, durable parity and stalemates.

### Population management

- home, committed and total living population — living may exceed the cap,
  because a committed host neither occupies capacity at home nor grows;
- population cap, home ratio and committed-to-cap ratio;
- current growth efficiency and troop growth;
- cumulative time depleted, below the growth band, inside it and crowded
  above it — read from `POPULATION_RULES`, so retuning the curve's thresholds
  moves the counters with it;
- attacking and defending commitments and casualties.

These show whether a realm is making meaningful growth-versus-expansion trades,
or merely sitting overfilled or chronically depleted.

### Territory and infrastructure

- current territory, sustainable land, frontier exposure and land share;
- current city levels and physical city sites;
- city levels/sites built, captured and lost;
- stacked city levels;
- factories, harbors and forts built, owned, captured and lost;
- infrastructure spend and milestone ticks for 1/5/10/25/50/80 cities and
  1/5/10/25/50/100 trade buildings.

One stacked city level counts as a built city because it costs a city purchase
and adds population capacity. Capturing a stacked city records every transferred
level but only one captured physical site. Captures are transfer events and do
not inflate the world's total developed-city count.

### Economy and trade

- treasury, current income and cumulative nominal passive income;
- infrastructure and warship spending;
- convoy/ship/pulse/flyer owner income and foreign-host income;
- domestic and foreign station stops;
- completed train and ship journeys;
- trade-income-to-construction-spend ratio;
- lifetime share at the treasury cap.

These separate bootstrap health, trade incentives and late-game currency
saturation rather than treating current treasury as the whole economy.

### Diplomacy and war

- declarations, peace treaties, alliance offers/formations/betrayals;
- lifetime shares at war, allied and traitor-exposed;
- campaigns launched/reinforced, troop commitments and defenses;
- theaters formed/won, capitals captured and realms conquered;
- generic event counts and first-event ticks for future systems.

Future assassination, marriage, revolt and other report kinds automatically
appear in generic counts; decision-specific counters can be added without
changing the batch engine.

## Completion semantics

A game is resolved only when the normal victory system names a champion. The
runner accepts a maximum tick as a safety horizon and labels any world reaching
it as unresolved. It never awards a plurality or score victory that the live
game would not award.

## Running a batch

```sh
npm run simulate:batch -- --games 100 --max-ticks 1800 --workers 8
```

Use `--output <path>` to retain the aggregate summary and every game snapshot as
JSON. Independent seeds are distributed across workers; worker count changes
runtime, not simulation outcomes.
