# Reporting and story architecture

The simulator records history in two deliberately separate layers.

## 1. Factual report

Every simulation system may append an immutable `WorldReportEvent` through
`SimulationContext.report`. An event contains:

- a versioned kind and domain;
- the exact tick and age;
- a generic initiator, targets and participants;
- stable links to relations, campaigns, theaters, structures, vehicles or
  future entities;
- machine-readable facts; and
- one plain-language factual summary.

Events are append-only. Simulation rules must never read prose or story state
to make decisions. The JSON export is therefore a deterministic audit record,
not a reconstruction from UI messages.

Every successfully executed command is additionally tagged with its exact
`action` link and `actionType` fact. `ACTION_REPORT_KINDS` is a compile-time
exhaustive contract over `WorldCommand`, so adding a future command without
declaring its factual event coverage fails validation instead of silently
creating an unlogged action. Passive per-tick accounting is summarized rather
than emitted as thousands of fake "actions."

## 2. Correlated stories

`StorySystem` observes all unprocessed report events through `storyCursor`.
Events with the same `storyKey` are consolidated into a `StoryArc`. Story arcs
may change headline, summary, importance and status, but never rewrite their
source facts. `eventIds` preserves the complete chain of evidence.

Examples:

- an alliance offer, acceptance, trade policy changes, expiry and betrayal
  share one alliance story key;
- a war declaration, every troop commitment, campaign, theater change,
  capital capture and peace share one war story key;
- all wilderness campaigns for a realm share one expansion story key;
- development and trade use time-bucketed keys so routine facts become readable
  eras instead of thousands of disconnected stories.

## Adding future features

Assassinations, marriages, revolts and other features should:

1. add their simulation state and rules without importing the story system;
2. report facts under an extension namespace such as `intrigue.assassination`,
   `dynasty.marriage` or `politics.revolt`;
3. use generic `character`, `realm`, `province` or other report subjects;
4. assign a stable story key to related facts; and
5. add or refine a story reducer only when the generic narrative is not enough.

The simulation test suite includes a future `dynasty.marriage` producer to
ensure extension events flow through the existing report and story pipeline.
