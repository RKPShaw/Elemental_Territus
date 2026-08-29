# The Long Game — design intent

Status: **design only**. Nothing in this document is implemented. It records
the direction agreed for turning Elemental Frontiers into a world that runs
for days — nations rising, dissolving, and being resettled — plus the
evidence from a throwaway prototype of these mechanics that was built,
measured, and then deliberately reverted so the build stays clean while
tuning work continues.

## Where the current build stands

Three tuning eras are already in the shipped rules and set the stage:

- **The slow economy** (income ÷20, population growth ÷6, trade reaches ÷6):
  a 100-game batch showed the world fully settled by ~tick 180, then ~2,300
  ticks of dead calm while courts saved for their first 18K building, and
  **zero wars ever** — income fell 20× but the 20K mobilization floor did
  not, so a war chest was ~10,000+ ticks of saving. That floor has since
  been removed outright: war is free to declare, and the treasury is a
  builder's purse alone.
- **The long frontier** (starts ÷10 in area, settlement pressure 0.62 →
  0.03): the frontier era now runs thousands of ticks instead of ~180, so
  the opening age is watchable growth instead of an instant fill.
- **Population as a resource** (committed hosts leave the cap; growth pays
  across a 40–70% band and collapses outside it; courts size settlement to
  what the frontier can absorb and ship their surplus out at 70%): realms
  stopped parking at ~91% of capacity growing at a quarter of peak, and now
  run the opening in the band instead. On the calibration seed that roughly
  doubles the pace of the frontier era — 74% of the world settled by tick
  ~440 where it used to take ~1,200 — while leaving `pressurePerTick`
  untouched. That dial is where the era's length would be given back if the
  faster opening is not wanted.

The dead calm is the problem the mechanics below exist to solve: with tax
income a trickle and war unaffordable, nothing happens between the frontier
closing and the heat death of the run.

## The intended engine of a days-long world

Three mechanics, designed to feed each other in a loop:

**settlement bounty → funded wars → overextension → collapse → new
wilderness and ruins → settlement bounty again.**

### 1. Settlement bounty — expansion *is* the opening economy

Settling one wilderness cell pays gold once, scaled by the ground's own
yield (`goldYield`), booked as land income. A growing nation is rich; a
static one lives on the tax trickle. Conquest of *enemy* land deliberately
pays nothing, so resettlement earns and war does not — war stays a
deliberate act rather than a profit engine.

The bounty was designed partly to fund war chests as frontiers closed. That
half is moot: the mobilization chest is gone and wars are free. What remains
is the reason to write it anyway — a frontier boom is what pays for the
cities and works an empire needs to hold what it takes.

Prototype constant: `CLAIM_RULES.wildernessGoldPerCell: 1_200` (per
normalized area unit × terrain goldYield ≈ 150–450 gold per cell; roughly
40–60K per realm across a full frontier era on the default map).

### 2. Wild structures — prizes that make the race mean something

12–20 neutral structures scattered at world creation on unclaimed land
(weighted mix — cities and trade posts mostly; plants and skyports rare),
owned by nobody, claimed by whoever settles the ground under them.

Placement is deliberately blind to the elements in play. The pull is meant
to be emergent: `regions.ts` already prices standing infrastructure into
strategic value regardless of owner, and `theater-intelligence.ts` already
values unowned structures, so realms should migrate toward the prizes that
suit them without any affinity seeding — and if they don't, that is a
finding about the priority system, which is half the point.

Implementation notes proven out by the prototype:
- `structureHeritage: null` already means "runs at par for anyone" — a
  found thing, not a captured one. No new heritage rules needed.
- `RealmAccountingSystem` recounts structures from cells every tick, so
  transfer-on-claim is automatic; only the claim report is new.
- Both renderers need a neutral (no-owner) structure style; today they
  skip unowned structures.
- Prototype constants: min 12 / max 20, ≥3.5 wu from any capital, ≥2.5 wu
  apart, weights `{city .3, factory .28, harbor .16, fort .02, plant .12,
  skyport .12}`, harbor draws require a coastal cell.

### 3. Imperial collapse — the system that resets the map

A realm whose territory outruns what its cities support accrues **strain**;
at full strain it collapses: its farthest provinces return to wilderness,
some structures burn (razed), the rest survive as unowned ruins — the same
shape as the founding wild structures, claimed through the same door. Shed
land is bounty-bearing wilderness again, so every collapse funds the rises
that follow.

Design constraints that mattered:
- Collapse is mechanical, never a dice roll against a healthy realm — only
  overextension accrues strain.
- Support comes from city levels (+forts cheaply), so an empire that
  *consolidates* — builds cities across its conquests — raises its ceiling
  and can genuinely outgrow the system. Victory at 80% stays possible, just
  generationally slow. The shed set is deterministic (distance from
  capital), so runs stay reproducible.
- The capital ring always survives: collapse humbles a realm, it never
  kills it.

Prototype constants (a working starting point, not a tuning verdict):
supported area = 30 base + 16/city level + 6/fort (normalized units);
strain +0.0025/tick × unsupported share, −0.004/tick recovery; collapse
sheds 50% of territory farthest-first; 35% of structures on shed ground
razed, survivors become neutral ruins (cities decay to level 1); 900 ticks
of grace after; nothing tracked under 40 cells held.

## What the prototype actually did (one seed, 0x240823)

The full loop ran and closed:

| tick | event |
|---:|---|
| 0 | 12 wild structures placed; realms open at ~4.4 cells each |
| 181–2400 | wild structures claimed one by one as frontiers reach them |
| 600 | 58% of land settled; treasuries filling on bounty |
| 2400 | 86% settled; strongest settler at strain 0.93 |
| 2504 | **first collapse** — a settler empire that outran its cities |
| 2912 | **first war** — chests funded by the frontier boom |
| 4800 | 4 collapses; a collapse ruin has already been re-claimed (13 claims from 12 prizes) |
| 5692 | first capital captured |
| 7200 | 17 wars declared; income spikes as shed land is resettled |

Compare the tuning-only build over the same window: zero wars, zero
structure purchases before ~tick 2400, nothing destroyed, nothing reset.

## Open questions for when this gets built for real

- Should war-taken land pay a reduced bounty on *re*settlement after a
  collapse, or full? (Prototype paid full; watch for gold-pump cycles.)
- Does the strain ceiling need an era term so late-game empires can win at
  all, or is city-support enough? Needs a 50k+ tick batch to answer.
- Population cost of collapse: the prototype let the troop-cap clamp do the
  work; an explicit "lost in the sundering" cut may read better in stories.
- Whether razed-vs-ruin should depend on structure type (burn the fort,
  keep the harbor?).
