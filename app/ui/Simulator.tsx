"use client";

import { useEffect, useRef, useState } from "react";
import { getRelation, otherParty, warsFor } from "../game/diplomacy";
import { committedTroopsFor } from "../game/campaigns";
import { ELEMENT_ORDER, ELEMENTS, realmMatchupLabel } from "../game/elements";
import { PLAYERS, PLAYER_ORDER, playerElement } from "../game/players";
import { latestStories } from "../game/reporting";
import {
  STRUCTURE_RULES,
  STRUCTURE_MIN_SPACING,
  TERRAIN_RULES,
  TRADE_RULES,
  WILDERNESS_TERRAIN_COST,
  ENEMY_TERRAIN_COST,
  POPULATION_RULES,
  compactNumber,
  normalizedCellArea,
  populationGrowthEfficiency,
} from "../game/rules";
import type { ElementId, PlayerId, WorldState } from "../game/types";
import {
  THEATER_LAYERS,
  THEATER_LAYER_LABELS,
} from "../game/theater-intelligence";
import type { TheaterLayer } from "../game/theater-intelligence";
import {
  BASE_SIMULATION_TICKS_PER_SECOND,
} from "../game/simulation-protocol";
import type { SimulationWorkerCommand, SimulationWorkerEvent } from "../game/simulation-protocol";
import { WorldMap } from "./WorldMap";

const INITIAL_SEED = 0x240823;
const SPEEDS = [1, 2, 4, 8, 16] as const;
const TEMPERAMENTS = [
  { label: "Patient", value: 0.72, note: "long peace, slower fronts" },
  { label: "Strategic", value: 1, note: "balanced decisions" },
  { label: "Restless", value: 1.3, note: "earlier wars, faster fronts" },
] as const;

const POSTURE_LABEL = {
  peaceful: "Keeping the peace",
  expanding: "Settling the frontier",
  mobilizing: "Mobilizing reserves",
  invading: "Pressing the frontier",
  defending: "Defending the realm",
  recovering: "Rebuilding the host",
  trading: "Growing through trade",
} as const;

function shareOf(state: WorldState, id: PlayerId) {
  return (state.factions[id].territory / state.landTiles) * 100;
}

function seasonFor(tick: number) {
  return ["Dewrise", "Sunhigh", "Leafturn", "Starlong"][Math.floor(tick / 15) % 4];
}

function formatSeed(seed: number) {
  return seed.toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

function formatWorldTime(ticks: number) {
  const seconds = Math.max(0, Math.ceil(ticks));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type SmoothNumberFormat = "compact" | "integer" | "percent" | "decimal";

function SmoothNumber({
  value,
  format = "compact",
  prefix = "",
  suffix = "",
}: {
  value: number;
  format?: SmoothNumberFormat;
  prefix?: string;
  suffix?: string;
}) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  const displayedRef = useRef(value);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const start = displayedRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const display = (amount: number) => {
      const copy = format === "compact"
        ? compactNumber(amount)
        : format === "decimal"
          ? amount.toFixed(1)
          : String(Math.round(amount));
      node.textContent = `${prefix}${copy}${suffix}`;
    };
    const animate = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / 260);
      const current = start + (value - start) * progress;
      displayedRef.current = current;
      display(current);
      if (progress < 1) frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [format, prefix, suffix, value]);

  const initial = format === "compact"
    ? compactNumber(value)
    : format === "decimal"
      ? value.toFixed(1)
      : String(Math.round(value));
  return <span ref={nodeRef} className="smooth-number">{prefix}{initial}{suffix}</span>;
}

export function Simulator() {
  const workerRef = useRef<Worker | null>(null);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [temper, setTemper] = useState(1);
  const [selected, setSelected] = useState<PlayerId>(PLAYER_ORDER[0]!);
  const [historyView, setHistoryView] = useState<"stories" | "report">("stories");
  const [mapMode, setMapMode] = useState<"political" | "theaters">("political");
  const [theaterLayer, setTheaterLayer] = useState<TheaterLayer>("composite");

  useEffect(() => {
    const worker = new Worker(new URL("../game/simulation.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.addEventListener("message", (event: MessageEvent<SimulationWorkerEvent>) => {
      if (event.data.type !== "snapshot") return;
      setWorld((previous) => ({
        ...event.data.world,
        reports: event.data.replaceHistory
          ? event.data.reportDelta
          : [...(previous?.reports ?? []), ...event.data.reportDelta],
      }));
      if (event.data.world.champion) setRunning(false);
    });
    const initialize: SimulationWorkerCommand = {
      type: "initialize",
      seed: INITIAL_SEED,
      running: true,
      speed: 1,
      aggression: 1,
    };
    worker.postMessage(initialize);
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "set-running", running } satisfies SimulationWorkerCommand);
  }, [running]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "set-speed", speed } satisfies SimulationWorkerCommand);
  }, [speed]);

  if (!world) {
    return (
      <main className="simulator-app simulation-loading" aria-busy="true">
        <div className="brand-orbit" aria-hidden="true">
          {ELEMENT_ORDER.map((id) => <i key={id} style={{ background: ELEMENTS[id].color }} />)}
        </div>
        <p className="eyebrow">Awakening the elemental world</p>
      </main>
    );
  }

  const chosen = world.factions[selected];
  const chosenElement = ELEMENTS[playerElement(selected)];
  const chosenPlayer = PLAYERS[selected]!;
  const target = chosen.intent.target ? PLAYERS[chosen.intent.target] : null;
  const targetRelation = target ? getRelation(world, selected, target.id) : null;
  const leader = PLAYER_ORDER.filter((id) => world.factions[id].alive).sort(
    (a, b) => world.factions[b].territory - world.factions[a].territory,
  )[0];
  const selectedRelations = Object.values(world.relations)
    .filter((relation) => relation.parties.includes(selected))
    .sort((a, b) => {
      const rank = (status: typeof a.status) => status === "war" ? 0 : status === "truce" ? 1 : 2;
      return rank(a.status) - rank(b.status);
    });
  const selectedCampaigns = world.campaigns.filter(
    (campaign) => campaign.attacker === selected || campaign.target === selected,
  );
  const selectedOffensives = world.campaigns.filter((campaign) => campaign.attacker === selected);
  const committedTroops = committedTroopsFor(world, selected);
  const homeFilled = Math.min(100, (chosen.troops / Math.max(1, chosen.troopCap)) * 100);
  const committedFilled = Math.min(
    100 - homeFilled,
    (committedTroops / Math.max(1, chosen.troopCap)) * 100,
  );
  const filled = homeFilled + committedFilled;
  const homeRatio = chosen.troops / Math.max(1, chosen.troopCap);
  const growthEfficiency = populationGrowthEfficiency(homeRatio);
  const populationBand = homeRatio < POPULATION_RULES.lowGrowthThreshold
    ? "depleted"
    : homeRatio < 0.52
      ? "recovering"
      : homeRatio <= 0.75
        ? "peak"
        : homeRatio <= POPULATION_RULES.highGrowthThreshold
          ? "crowding"
          : "constrained";
  const stories = latestStories(world.stories).slice(0, 8);
  const recentReports = [...world.reports].reverse().slice(0, 18);

  function createNewWorld() {
    const seed = (world.seed * 1664525 + 1013904223 + world.tick) >>> 0;
    setWorld(null);
    workerRef.current?.postMessage({ type: "new-world", seed, aggression: temper } satisfies SimulationWorkerCommand);
    // "ember" is not a player id -- the roster is "ember-1" through "gale-10".
    // Selecting it left the council panel dereferencing an undefined faction on
    // the new world's first frame, which crashed the whole page.
    setSelected(PLAYER_ORDER[0]!);
    setRunning(true);
  }

  function changeTemper(value: number) {
    setTemper(value);
    workerRef.current?.postMessage({ type: "set-aggression", aggression: value } satisfies SimulationWorkerCommand);
  }

  function exportWorldArchive() {
    const archive = {
      schemaVersion: 1,
      world: {
        name: world.worldName,
        seed: world.seed,
        tick: world.tick,
        age: world.age,
        champion: world.champion,
      },
      reports: world.reports,
      stories: world.stories,
    };
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${world.worldName.toLowerCase()}-world-archive.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="simulator-app">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-orbit" aria-hidden="true">
            {ELEMENT_ORDER.map((id) => (
              <i key={id} style={{ background: ELEMENTS[id].color }} />
            ))}
          </div>
          <div>
            <p className="eyebrow">Autonomous elemental strategy</p>
            <h1>Elemental Frontiers</h1>
          </div>
        </div>

        <div className="world-heading" aria-live="polite">
          <span>{seasonFor(world.tick)} · Age {world.age}</span>
          <strong>{world.worldName}</strong>
          <small>seed {formatSeed(world.seed)}</small>
        </div>

        <div className="top-controls" aria-label="Simulation controls">
          <button
            type="button"
            className="control-button primary-control"
            onClick={() => setRunning((value) => !value)}
            aria-pressed={!running}
          >
            <span aria-hidden="true">{running ? "Ⅱ" : "▶"}</span>
            {running ? "Pause" : world.champion ? "Finished" : "Play"}
          </button>
          <div className="speed-control" aria-label="Simulation speed">
            {SPEEDS.map((value) => (
              <button
                type="button"
                key={value}
                className={speed === value ? "active" : ""}
                onClick={() => setSpeed(value)}
                aria-label={`${value} times speed`}
              >
                {value}×
              </button>
            ))}
          </div>
          <button type="button" className="control-button icon-control" onClick={createNewWorld}>
            <span aria-hidden="true">↻</span>
            New world
          </button>
        </div>
      </header>

      <section className="world-balance" aria-label="Share of sustainable land">
        {PLAYER_ORDER.map((id) => {
          const share = shareOf(world, id);
          return (
            <button
              type="button"
              key={id}
              className={`balance-slice ${selected === id ? "selected" : ""}`}
              style={{ width: `${Math.max(0.5, share)}%`, background: PLAYERS[id]!.color }}
              onClick={() => setSelected(id)}
              aria-label={`${PLAYERS[id]!.name}: ${share.toFixed(1)} percent of sustainable land`}
              title={`${PLAYERS[id]!.name} · ${share.toFixed(1)}%`}
            />
          );
        })}
      </section>

      <div className="simulator-grid">
        <section className="map-card" aria-label="World simulation">
          {world.champion && (
            <div className="victory-banner" role="status">
              <span aria-hidden="true">♛</span>
              <div>
                <small>{world.worldName} is united</small>
                <strong>{PLAYERS[world.champion]!.realmName} wins the age!</strong>
              </div>
              <button type="button" onClick={createNewWorld}>Grow another world</button>
            </div>
          )}
          <div className="map-mode-control" role="tablist" aria-label="Map view">
            <button
              type="button"
              role="tab"
              aria-selected={mapMode === "political"}
              className={mapMode === "political" ? "active" : ""}
              onClick={() => setMapMode("political")}
            >Political</button>
            <button
              type="button"
              role="tab"
              aria-selected={mapMode === "theaters"}
              className={mapMode === "theaters" ? "active" : ""}
              onClick={() => setMapMode("theaters")}
            >Theater value</button>
          </div>
          {mapMode === "theaters" && (
            <div className="theater-layer-control" role="tablist" aria-label="Theater value layers">
              {THEATER_LAYERS.map((layer) => (
                <button
                  type="button"
                  role="tab"
                  key={layer}
                  aria-selected={theaterLayer === layer}
                  className={theaterLayer === layer ? "active" : ""}
                  onClick={() => setTheaterLayer(layer)}
                >{THEATER_LAYER_LABELS[layer]}</button>
              ))}
            </div>
          )}
          <WorldMap
            state={world}
            selected={selected}
            onSelect={setSelected}
            mapMode={mapMode}
            theaterLayer={theaterLayer}
            playbackTicksPerSecond={running ? BASE_SIMULATION_TICKS_PER_SECOND * speed : 0}
          />

          <div className="realm-strip" aria-label="Realm standings">
            {PLAYER_ORDER.map((id) => {
              const faction = world.factions[id];
              const element = ELEMENTS[playerElement(id)];
              const player = PLAYERS[id]!;
              const share = shareOf(world, id);
              const realmWars = warsFor(world, id).length;
              const committed = committedTroopsFor(world, id);
              return (
                <button
                  type="button"
                  key={id}
                  className={`realm-pill ${selected === id ? "selected" : ""} ${!faction.alive ? "fallen" : ""}`}
                  onClick={() => setSelected(id)}
                >
                  <span
                    className="realm-glyph"
                    style={{ color: element.deepColor, background: element.softColor }}
                    aria-hidden="true"
                  >
                    {element.glyph}
                  </span>
                  <span className="realm-pill-copy">
                    <strong>{player.name}</strong>
                    <small>
                      {faction.alive
                        ? `${compactNumber(faction.troops)} home${committed ? ` + ${compactNumber(committed)} away` : ""} · ${realmWars ? `${realmWars} war${realmWars > 1 ? "s" : ""}` : "peace"}`
                        : "fallen"}
                    </small>
                  </span>
                  {id === leader && faction.alive && <span className="leader-crown" title="Land leader">♛</span>}
                  <span className="mini-bar" aria-hidden="true">
                    <i style={{ width: `${share}%`, background: element.color }} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="war-room" aria-label="Realm intelligence">
          <section className="panel council-panel" style={{ "--realm": chosenPlayer.color } as React.CSSProperties}>
            <div className="panel-heading">
              <div className="selected-emblem" style={{ background: chosenElement.softColor, color: chosenElement.deepColor }}>
                {chosenElement.glyph}
              </div>
              <div>
                <p className="eyebrow">Council of {chosenPlayer.name}</p>
                <h2>{chosenPlayer.realmName}</h2>
                <span className="realm-status">{chosen.alive ? chosenElement.title : "Its banner has fallen"}</span>
              </div>
              <strong className="share-number">
                <SmoothNumber value={shareOf(world, selected)} format="decimal" suffix="%" />
              </strong>
            </div>

            {chosen.alive ? (
              <>
                <div className="army-ledger">
                  <div className="army-total">
                    <span>Population at home</span>
                    <strong><SmoothNumber value={chosen.troops} /></strong>
                    <small><SmoothNumber value={chosen.troopGrowth} prefix="+" suffix=" / tick" /></small>
                  </div>
                  <div className="cap-copy">
                    <span>
                      <SmoothNumber value={homeFilled} format="integer" suffix="%" /> home · {committedTroops
                        ? <><SmoothNumber value={committedTroops} /> committed</>
                        : "none committed"}
                    </span>
                    <b><SmoothNumber value={chosen.troopCap} suffix=" cap" /></b>
                  </div>
                  <div className="capacity-meter population-meter" aria-label={`${Math.round(filled)} percent of population capacity alive; peak growth is near 65 percent at home`}>
                    <i style={{ width: `${homeFilled}%`, background: chosenPlayer.color }} />
                    <i className="committed-share" style={{ width: `${committedFilled}%` }} />
                    <b className="growth-peak-marker" title="Peak population growth at 65%">65%</b>
                  </div>
                  <div className={`growth-readout ${populationBand}`}>
                    <span>Growth efficiency</span>
                    <strong><SmoothNumber value={growthEfficiency * 100} format="integer" suffix="%" /> · {populationBand}</strong>
                  </div>
                  {committedTroops > 0 && <p className="commitment-copy">The army abroad is reserved from the population and does not contribute to growth.</p>}
                </div>

                {chosen.traitorUntil > world.tick && (
                  <div className="traitor-alert">
                    <strong>Traitor exposed</strong>
                    <span>{formatWorldTime(chosen.traitorUntil - world.tick)} remaining · enemies attack at 1.35× strength</span>
                  </div>
                )}

                <div className="intent-card">
                  <div className="intent-topline">
                    <span>Thinking now</span>
                    <strong>{POSTURE_LABEL[chosen.intent.posture]}</strong>
                  </div>
                  <p>“{chosen.intent.reason}”</p>
                  <div className="confidence-row">
                    <span>confidence</span>
                    <div className="meter"><i style={{ width: `${chosen.intent.confidence * 100}%` }} /></div>
                    <strong>{Math.round(chosen.intent.confidence * 100)}%</strong>
                  </div>
                </div>

                <div className="target-row">
                  <span>Strategic focus</span>
                  {target ? (
                    <button type="button" onClick={() => setSelected(target.id)}>
                      <i style={{ background: target.color }} />
                      {target.name}
                      <small>{targetRelation?.status} · {realmMatchupLabel(world, selected, target.id)}</small>
                      <b aria-hidden="true">→</b>
                    </button>
                  ) : (
                    <em>Domestic growth</em>
                  )}
                </div>

                {selectedOffensives.length > 0 && (
                  <div className="campaign-ledger" aria-label="Active target-specific campaigns">
                    <span>Campaigns</span>
                    <div>
                      {selectedOffensives.map((campaign) => {
                        const theaters = world.theaters.filter(
                          (theater) => theater.campaignId === campaign.id && theater.staleRefreshes === 0,
                        );
                        const targetName = campaign.target === "wilderness"
                          ? "Wilderness"
                          : PLAYERS[campaign.target]!.name;
                        return (
                          <p key={campaign.id}>
                            <i style={{ background: campaign.target === "wilderness" ? "#b7aa79" : PLAYERS[campaign.target]!.color }} />
                            <strong>{targetName}</strong>
                            <small>{compactNumber(campaign.remaining)} committed · {theaters.length} automatic {theaters.length === 1 ? "theater" : "theaters"}</small>
                          </p>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="economy-ledger">
                  <div><span>Gold</span><strong><SmoothNumber value={chosen.gold} /></strong></div>
                  <div><span>Income</span><strong><SmoothNumber value={chosen.goldRate} prefix="+" /></strong></div>
                  <div><span>Land</span><strong><SmoothNumber value={chosen.territory * normalizedCellArea(world.config)} format="integer" /></strong></div>
                  <div><span>Losses</span><strong><SmoothNumber value={chosen.casualties} /></strong></div>
                </div>

                <div className="absorbed-elements" aria-label="Elements held by this player">
                  <span>Elements</span>
                  <div>
                    {chosen.absorbedElements.map((elementId) => {
                      const held = chosen.elementCounts[elementId] ?? 0;
                      return (
                        <b
                          key={elementId}
                          title={held > 1
                            ? `${ELEMENTS[elementId].name} — ${held} realms absorbed`
                            : ELEMENTS[elementId].name}
                          style={{ background: ELEMENTS[elementId].softColor, color: ELEMENTS[elementId].deepColor }}
                        >
                          {ELEMENTS[elementId].glyph}
                          {held > 1 && <sup>{held}</sup>}
                        </b>
                      );
                    })}
                  </div>
                  <small>{(() => {
                    const realms = Object.values(chosen.elementCounts).reduce((total, count) => total + count, 0);
                    return realms > 1 ? `${realms} realms absorbed` : "native power";
                  })()}</small>
                </div>

                <div className="infrastructure-row" aria-label="Infrastructure counts">
                  {(Object.keys(chosen.structures) as Array<keyof typeof chosen.structures>).map((structure) => (
                    <span key={structure} title={STRUCTURE_RULES[structure].name}>
                      <b>{STRUCTURE_RULES[structure].glyph}</b>{chosen.structures[structure]}
                    </span>
                  ))}
                  <span title="Warships"><b>▰</b>{chosen.warships}</span>
                </div>
              </>
            ) : (
              <div className="fallen-note">The realm has no territory left, though its old capital remains marked.</div>
            )}
          </section>

          <section className="panel diplomacy-panel">
            <div className="section-title-row">
              <div>
                <p className="eyebrow">Every pair begins at peace</p>
                <h2>Diplomacy</h2>
              </div>
              <span className="scribe-dot" aria-hidden="true">⚑</span>
            </div>
            <div className="relation-list">
              {selectedRelations.map((relation) => {
                const other = otherParty(relation, selected);
                const rival = PLAYERS[other]!;
                const rivalAlive = world.factions[other].alive;
                const rivalTraitorTime = world.factions[other].traitorUntil - world.tick;
                const campaign = selectedCampaigns.find(
                  (item) =>
                    (item.attacker === selected && item.target === other) ||
                    (item.attacker === other && item.target === selected),
                );
                const campaignSummary = campaign
                  ? campaign.attacker === selected
                    ? `${compactNumber(campaign.remaining)} attacking · ${compactNumber(campaign.defenderRemaining)} opposed`
                    : `${compactNumber(campaign.defenderRemaining)} defending · ${compactNumber(campaign.remaining)} incoming`
                  : "war declared";
                const relationSummary = relation.status === "war"
                  ? campaignSummary
                  : relation.status === "truce"
                    ? `${formatWorldTime(relation.truceUntil - world.tick)} alliance · trade ${relation.tradeActive ? "open" : "closed"}`
                    : relation.truceOfferBy
                      ? `${PLAYERS[relation.truceOfferBy]!.name} offered a truce`
                      : `ordinary peace · trade ${relation.tradeActive ? "open" : "closed"}`;
                const badge = relation.status === "peace" && relation.truceOfferBy ? "offer" : relation.status;
                return (
                  <button type="button" key={relation.key} onClick={() => setSelected(other)}>
                    <i style={{ background: rival.color }} />
                    <span>
                      <strong>{rival.name}</strong>
                      <small>{!rivalAlive ? "realm fallen" : `${relationSummary}${rivalTraitorTime > 0 ? ` · traitor ${formatWorldTime(rivalTraitorTime)}` : ""}`}</small>
                    </span>
                    <b className={rivalAlive ? badge : "fallen"}>{rivalAlive ? badge : "fallen"}</b>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel dispatch-panel history-panel">
            <div className="section-title-row">
              <div>
                <p className="eyebrow">Observed, correlated, remembered</p>
                <h2>World archive</h2>
              </div>
              <button type="button" className="archive-export" onClick={exportWorldArchive} title="Download the complete structured archive">
                ⇩ JSON
              </button>
            </div>
            <div className="history-tabs" role="tablist" aria-label="World archive view">
              <button
                type="button"
                role="tab"
                aria-selected={historyView === "stories"}
                className={historyView === "stories" ? "active" : ""}
                onClick={() => setHistoryView("stories")}
              >Stories <b>{world.stories.length}</b></button>
              <button
                type="button"
                role="tab"
                aria-selected={historyView === "report"}
                className={historyView === "report" ? "active" : ""}
                onClick={() => setHistoryView("report")}
              >Factual report <b>{world.reports.length}</b></button>
            </div>

            {historyView === "stories" ? (
              <ol className="story-list" aria-live="polite">
                {stories.length === 0 && (
                  <li className="archive-empty">The scribes are listening for the first connected story…</li>
                )}
                {stories.map((story) => {
                  const realmParticipants = story.participants.filter(
                    (participant) => participant.type === "realm" && participant.realmId,
                  );
                  return (
                    <li key={story.id} className={`story-card ${story.kind} ${story.status}`}>
                      <div className="story-topline">
                        <span>{story.kind} · {story.status}</span>
                        <small>Age {Math.floor(story.startedAt / 60) + 1}{story.updatedAt !== story.startedAt ? `–${Math.floor(story.updatedAt / 60) + 1}` : ""} · {story.eventIds.length} facts</small>
                      </div>
                      <strong>{story.headline}</strong>
                      <p>{story.summary}</p>
                      <div className="story-participants" aria-label="Story participants">
                        {realmParticipants.map((participant) => (
                          <button
                            type="button"
                            key={participant.id}
                            onClick={() => setSelected(participant.realmId!)}
                            title={participant.label}
                            style={{
                              background: ELEMENTS[playerElement(participant.realmId!)].softColor,
                              color: ELEMENTS[playerElement(participant.realmId!)].deepColor,
                            }}
                          >{ELEMENTS[playerElement(participant.realmId!)].glyph}</button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <ol className="report-list" aria-live="polite">
                {recentReports.map((event) => {
                  const realm = event.initiator?.realmId;
                  return (
                    <li key={event.id} className={`report-event ${event.importance}`}>
                      <span className="event-mark" style={{ background: realm ? PLAYERS[realm]!.color : "#f1c46d" }} />
                      <div>
                        <small>#{event.id} · tick {event.tick} · {event.kind.replaceAll(".", " / ")}</small>
                        <p>{event.summary}</p>
                        <em>{event.initiator?.label ?? "World"}{event.targets.length ? ` → ${event.targets.map((target) => target.label).join(", ")}` : ""}</em>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </aside>
      </div>

      <details className="systems-drawer">
        <summary>
          <span className="drawer-icon" aria-hidden="true">◎</span>
          <span>
            <strong>How conquest, terrain and prosperity work</strong>
            <small>target campaigns, automatic theaters, absorbed elements, diplomacy and trade</small>
          </span>
          <b aria-hidden="true">⌄</b>
        </summary>
        <div className="drawer-grid conquest-rules-grid">
          <section className="temper-card">
            <p className="eyebrow">World temperament</p>
            <h3>How patient are the empires?</h3>
            <div className="temper-buttons">
              {TEMPERAMENTS.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  className={temper === option.value ? "active" : ""}
                  onClick={() => changeTemper(option.value)}
                >
                  <strong>{option.label}</strong>
                  <small>{option.note}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="ratio-card">
            <p className="eyebrow">Population strategy</p>
            <h3>Grow at 65%, spend with care</h3>
            <div className="population-curve" aria-label="Population growth peaks at 65 percent capacity">
              <i /><b>65%</b><span>peak growth</span>
            </div>
            <p>Growth slows below 20% and again as the realm becomes crowded. Campaign commitments leave the breeding population, so reckless expansion gains land and capacity now but can surrender the next generation to a more patient rival.</p>
          </section>

          <section className="terrain-card">
            <p className="eyebrow">Land trade-off</p>
            <h3>Food or fortification?</h3>
            <div className="terrain-rule-list">
              {(["farmland", "plains", "forest", "hills", "mountains"] as const).map((terrain) => (
                <div key={terrain}><i style={{ background: TERRAIN_RULES[terrain].fill }} /><span>{TERRAIN_RULES[terrain].shortName}</span><b>{TERRAIN_RULES[terrain].defenseCost.toFixed(2)}× defense</b><small>{TERRAIN_RULES[terrain].sustain.toFixed(2)} sustain</small></div>
              ))}
            </div>
            <p className="terrain-invariant">
              Wilderness mountains cost {WILDERNESS_TERRAIN_COST.mountains.toFixed(1)}× to settle; even enemy farmland starts at {ENEMY_TERRAIN_COST.farmland.toFixed(2)}×. Every accessible wilderness theater keeps a baseline share until it advances.
            </p>
          </section>

          <section className="building-card">
            <p className="eyebrow">Infrastructure</p>
            <h3>Prosper, protect, then project</h3>
            <div className="building-rule-list">
              {(Object.keys(STRUCTURE_RULES) as Array<keyof typeof STRUCTURE_RULES>).map((structure) => (
                <div key={structure}><span>{STRUCTURE_RULES[structure].glyph}</span><p><strong>{STRUCTURE_RULES[structure].name}</strong><small>{STRUCTURE_RULES[structure].description}</small></p></div>
              ))}
            </div>
            <p className="terrain-invariant">
              New sites stay {STRUCTURE_MIN_SPACING.toFixed(1)} world units apart. Train stops pay {compactNumber(TRADE_RULES.domesticTrainStopPayout)} at home or {compactNumber(TRADE_RULES.foreignTrainStopPayout)} to each player abroad; ships earn {compactNumber(TRADE_RULES.shipPayoutPerTravelTick)} per travel second.
            </p>
          </section>
        </div>
      </details>
    </main>
  );
}
