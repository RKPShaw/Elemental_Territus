# Strategic geography and persistent rail architecture

## Three spatial layers

The simulation deliberately separates geography from politics and campaigns:

1. **Cells** contain terrain, ownership, structures and local pressure.
2. **Strategic regions** are connected, near-equal-area value basins. Their
   stable identities do not belong to a player and may cross borders.
3. **Theaters** are the current intersection of one target-specific campaign,
   its active frontier and one strategic region.

Every twelve ticks, the geography system rebuilds four shared data layers:
terrain productivity, relief, infrastructure density and combined strategic
value. Cities, capitals, factories, harbors, forts and durable rail are diffused
into commerce basins. Relief and productivity are independently smoothed, so
ridges, valleys and changes in useful land remain visible to the partition.

Each region measures the value-weighted center of its current cells, then moves
its anchor with a damped alpha-beta estimator and a strict maximum step. An
eight-direction, capacity-weighted wavefront uses true diagonal distance and
charges extra cost for crossing sharp gradients between the meta-map layers.
The result is gradual geographic movement, stable region IDs, organic contours,
and area budgets that converge around the same target rather than cardinal
point-source diamonds.

The partition is shared truth, but its value is not: every realm separately
scores every region using ownership, access, elemental affinity, diplomacy,
infrastructure and campaign focus. Selecting a player in Theater Value mode
therefore changes the heat colors without changing the underlying areas.

A campaign theater keeps the stable identity `campaign + region`; changes to
its economic observation pass through a second alpha-beta state estimator and
a bounded history instead of replacing the theater every time the frontier or
strategic partition moves.

## Campaign allocation and advance

A campaign owns the troop commitment. The theater allocator cannot create
troops: active theater allocations normalize to the campaign's usable reserve.
Theater priority combines:

- productive land and economic depth;
- cities, factories, harbors, capitals and rail corridors ahead of the front;
- supply from friendly neighboring cells;
- terrain and fort resistance;
- wilderness neglect and late-settlement completion pressure.

Within a theater, the finite allocation is normalized across its current front
cells. Local weights favor valuable terrain and objectives, preserve partially
developed pushes, and use a low-frequency geographic field to prevent radial or
diamond expansion. Combat speed is therefore independent of how many theater
objects happen to represent a border.

## Rail construction

Factories produce a union of pathfinding coverage areas; they no longer emit a
straight connection to every nearby station. Rail construction is incremental:

- routes are land paths that account for terrain;
- existing track has a very low traversal cost, so new branches naturally join
  and reuse the established network;
- newly built cities and factories become nodes and connect to the nearest
  reachable network;
- physical routes persist through ownership and diplomacy changes;
- war or closed trade prevents use, but does not erase the track;
- the graph remains sparse because each new station adds at most one connection
  to an existing component.

Train routing uses shortest paths through this durable graph. Vehicles retain a
cell-by-cell physical path for movement and a separate ordered station list for
income and dwell calculations.
