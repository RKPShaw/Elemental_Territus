# Element colors

Every element in the space owns one documented color set, authored in
`elements.ts` and assigned once at module load. These are the only colors the
political map paints with.

## How the map uses them

- **Territory.** A realm's ground is tinted with the `color` of the element it
  currently *expresses* (`FactionState.expressedElement`), not the element it
  was founded as. When conquest forges a new tier — a tide realm absorbing
  stone expresses Grove, two compounds meeting express an advanced element —
  the realm repaints in the new element's color the frame the ascension lands.
- **One color per element.** All twelve realms of a founding family wear the
  same color. There are no per-sibling shades: similarity within a family is
  deliberate, and identity is carried by borders, glyphs and labels instead.
- **Structures, vehicles, warships and campaign markers** use the expressed
  element's `deepColor`, so they repaint together with the territory.
- **Push tint.** While a realm is actively pushing a border, the border line
  is drawn in the attacker's `color` darkened to 65% — a slightly darker shade
  of the attacking nation, pointing at who is moving the line.
- **Soft/deep companions.** `softColor` and `deepColor` are the light and dark
  ends of each element's ramp, used by UI chrome (emblems, badges, bars).

## The palette

### Tier 1 — founding elements

| Element | Color | Soft | Deep |
| --- | --- | --- | --- |
| Ember | `#ef6a5b` | `#ffc2ad` | `#8e2f35` |
| Tide | `#45a9b8` | `#ade1dc` | `#176375` |
| Stone | `#c49a62` | `#ead2a0` | `#74543e` |
| Gale | `#9684c5` | `#d6cbef` | `#594d84` |

### Tier 2 — compound elements

| Element | Bases | Color | Soft | Deep |
| --- | --- | --- | --- | --- |
| Grove | tide + stone | `#71a366` | `#c9dda1` | `#426342` |
| Steam | ember + tide | `#9fb4bd` | `#d9e4e8` | `#5b7078` |
| Magma | ember + stone | `#d1603d` | `#f2b08a` | `#7a2e1d` |
| Lightning | ember + gale | `#e8c94a` | `#f7e9a8` | `#8a6d1f` |
| Ice | tide + gale | `#8fd0dd` | `#d8f1f4` | `#3f7f93` |
| Sand | stone + gale | `#d3b26a` | `#efdfb2` | `#8a6f3c` |

### Tier 3 — advanced elements

| Element | Bases | Color | Soft | Deep |
| --- | --- | --- | --- | --- |
| Geyser | steam + magma | `#6fb3ae` | `#c3e5e0` | `#2f6a68` |
| Tempest | steam + lightning | `#5f8fb4` | `#b7d4e8` | `#2b4f70` |
| Bloom | steam + grove | `#86c05a` | `#d6ecb2` | `#477330` |
| Mist | steam + ice | `#a9b8b4` | `#dde7e3` | `#62736f` |
| Mirage | steam + sand | `#c9a8d4` | `#ecdcf1` | `#7b5a88` |
| Plasma | magma + lightning | `#d76bc4` | `#f3c3e8` | `#7e2f72` |
| Ash | magma + grove | `#8d8578` | `#cfc9bd` | `#4c463c` |
| Obsidian | magma + ice | `#5a5668` | `#a9a5b8` | `#232030` |
| Glass | magma + sand | `#a9d6d0` | `#e2f4f0` | `#57847e` |
| Spirit | lightning + grove | `#9cc9a8` | `#d9eedd` | `#4f7a5c` |
| Aurora | lightning + ice | `#74c9a4` | `#c7ecd9` | `#3a7a6c` |
| Lodestone | lightning + sand | `#7d8fa6` | `#c4cfdd` | `#3e4c61` |
| Amber | grove + ice | `#d99b3d` | `#f2d59c` | `#8a5c1d` |
| Fungus | grove + sand | `#b08e6e` | `#e0cbb4` | `#5f4a35` |
| Crystal | ice + sand | `#9fb0e0` | `#dbe2f5` | `#4f5f94` |

### Non-element colors

| Use | Color |
| --- | --- |
| Neutral / wilderness overlay | `#d8cfb1` |
| Border line (settled) | `rgb(12, 16, 18)` |
| War front (no active push) | `rgb(145, 55, 58)` |
| Water | `TERRAIN_RULES.water.fill` |
