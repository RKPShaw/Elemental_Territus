"use client";

import { useMemo } from "react";
import { ElementalWarEngine } from "../game/engine";
import { WorldMap } from "../ui/WorldMap";

const CAPTURE_SEED = 0x240823;

export function TheaterSnapshot({ tick }: { tick: number }) {
  const world = useMemo(() => {
    const engine = new ElementalWarEngine(CAPTURE_SEED);
    engine.advance(tick);
    return engine.snapshot();
  }, [tick]);
  const active = world.theaters.filter(
    (theater) => theater.staleRefreshes === 0 && theater.allocation > 0,
  ).length;

  return (
    <main style={{ width: 1220, margin: "0 auto", padding: 20 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginBottom: 10, color: "#fff6d8" }}>
        <div>
          <p className="eyebrow">Three-theater wilderness study</p>
          <h1 style={{ margin: 0, color: "#fff6d8" }}>{world.worldName}</h1>
        </div>
        <strong data-capture-ready={tick}>tick {tick} · {active} active assignments</strong>
      </header>
      <WorldMap
        state={world}
        selected="ember"
        onSelect={() => undefined}
        showAllTheaters
        renderMarker={String(tick)}
      />
    </main>
  );
}
