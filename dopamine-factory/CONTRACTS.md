# DOPAMINE FACTORY — module contracts

Browser game. ONE dependency: three.js at `../shared/vendor/three.min.js`
(r147, UMD, global `THREE`). No build step, no asset files, works via file://.
Plain `<script>` tags, load order defined in index.html. Global namespace:

```js
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
```

## The game (one paragraph)
A glowing 5×5 3D board (upgradable to 7×7). Cubes spawn over time. TAP a cube
= POP → coins fly out, particles, rising-pitch sounds. Drag an identical cube
onto another = MERGE → next tier (≈4× value, rainbow glow ladder). Fast pops
chain a COMBO multiplier. Lucky golden cubes pay ×10. Popping big tiers
triggers lightning CHAINS. A bonus WHEEL (free spin every 60s of play),
rotating QUESTS, a collection bonus per discovered tier, and ASCEND
(prestige) multipliers. Numbers go up forever. Maximum juice.

## Canon numbers (every module MUST obey exactly)
- `coinValue(tier) = Math.round(10 * Math.pow(3.5, tier - 1))` — 25 tiers
- merge: two same-tier cubes → tier+1 (max 25)
- combo: pop within 2.0s of previous → comboCount++; multiplier = `1 + 0.1 * min(comboCount, 20)` (max ×3.0, display capped)
- lucky cube: 5% of spawns → pop value ×10, gold shower
- chain reaction: popping tier ≥ 5 auto-pops `2 + floor((tier-5)/2)` more random cubes (cap 8 total), each pays coinValue × 0.5 (lucky ×10 applies to chains too)
- spawn: every spawnInterval (base 2.5s, min 0.4s) into a random empty cell; tier = random in `[max(1, maxTierReached-4), maxTierReached-1]` weighted toward the low end
- idle income: sum of coinValue(tier) × 0.05/sec × incomeMult (paid continuously)
- ASCEND: unlocked at lifetime ≥ 1,000,000 coins; resets board, coins, upgrades; permanent multiplier = `1 + 0.5 * ascensions`
- collection: first time reaching tier t → permanent incomeMult × 1.02 per tier discovered
- upgrades (6): tapPower (+15%/lvl coin value), spawnRate (−8%/lvl interval), incomeMult (+10%/lvl), gridSize (3 levels: 5×5→6×6→7×7), luckyChance (+1.5%/lvl), chainPower (+1 chain cube/lvl). Cost = base × 1.35^level; bases: 50, 100, 250, 2000, 750, 1500.
- offline earnings: elapsed × income × 0.5, capped 8h
- save key: `dopamine_factory_v1`, versioned {v:1, ...}; save every 5s + beforeunload

## Shared game state (owned by DP.Game, passed to modules)
```
Game.state = {
  coins, lifetime, ascensions, combo, comboT,
  upgrades: {id: level}, maxTierReached,
  discovered: {tier: true}, spawnT,
  settings: {muted}, lastSeen
}
```

## Event bus (DP.Events — DEFINED in game.js, consumed by all)
`DP.Events.emit(name, data)`, `DP.Events.on(name, fn) → off()`.
Events fired: `spawn{idx,tier,lucky}`, `pop{idx,tier,value,lucky,chained}`,
`merge{a,b,tier}`, `tierReached{tier}`, `discover{tier}`, `coins{amount,total}`,
`combo{count,mult}`, `spend{id,level}`, `ascend{n}`, `quest{id,done}`,
`wheel{result}`, `load`, `save`.
Modules must never crash if the bus is absent (guard `typeof DP.Events !== 'undefined'`).

## Files & owners (one agent per file — do NOT touch others)

### js/content.js — DP.Content (pure data + canon math)
- `DP.Content.tiers` = 25; `tierValue(t)`, `tierColor(t)` (25-entry rainbow→gold HSL ladder, exact hexes precomputed), `tierName(t)` (escalating flavor: "Pebble" → … → "SINGULARITY"), `coinValue(t)` canon
- `UPGRADES`: array `{id,name,desc,max,base,cost(level),effect(level)}` per canon; `upgradeCost(id, level)`
- `prestigeMult(n)`, `discoverBonus(count)`, `incomeMult(state)` (income upgrade × discovery × prestige)
- self-test: value curve monotonic, colors unique, upgrade cost curve, income stacking order-independent

### js/core.js — DP.Core (economy, pure)
- `newState()`, `addCoins(state, n)`, `spendCoins(state, n) → bool`, `comboPop(state, now) → mult` (2s window), `comboTick(state, dt)`, `canAscend(state)`, `ascend(state) → new mult`, `offlineGain(state, nowMs) → gain` (cap 8h, ×0.5), `serialize/deserialize` round-trip, `fmt(n)` (1.2K/3.4M/5.6B/T…)
- self-test: combos decay, multiplier cap ×3, spend declines properly, offline cap, round-trip equality, fmt cases

### js/board.js — DP.Board (grid logic, pure)
- `create(size) → board {size, cells:[{tier, lucky, id} or null], nextId}`
- `spawn(board, minTier, maxTier, rng) → {idx, tier, lucky}` | null when full
- `pop(board, idx) → {tier, lucky}` (removes)
- `merge(board, a, b) → {tier} | null` (a==b indices, same tier, b keeps cell)
- `totalValue(board)` (for idle income), `emptyCells(board)`, `resize(board, newSize)` (preserve existing cubes at same coords)
- `chainTargets(board, count, rng) → idx[]` (random non-empty, excludes source)
- self-test: spawn respects empty cells + tier range + lucky 5%, merge rules (mismatch fails), chain caps, resize migration, full-board behavior

### js/wheel.js — DP.Wheel (pure state machine)
- `newState()`, `canSpin(state, nowMs)` (60s cooldown), `spin(state, rng) → {sector, revealMs, nearMiss}` — 8 sectors weighted: 40% coins(small-med), 15% income×2 for 30s, 12% lucky rain (next 5 spawns lucky), 10% instant merge-up (all tier+1... too strong: ONE random pair merges up), 8% quest reroll, 5% jackpot (coins = 120s of income), 10% dud "SO CLOSE!" (near-miss by design: wheel visually lands adjacent to jackpot)
- `tick(state, nowMs)`; sector table exported for UI
- self-test: cooldown, weights sum, distribution sanity (10k spins ±tolerance), near-miss rate, jackpot size math

### js/quests.js — DP.Quests (pure, event-fed)
- `newState()`, `reroll(state, seed, progress) → 3 quests`, `onEvent(state, name, data)` (updates progress), `claim(state) → rewards[]`
- Quest pool (10+ templates): "Pop N cubes", "Reach tier T", "Merge M times", "Hit combo C", "Earn X coins", "Spin the wheel", "Pop a lucky cube", "Chain L cubes", "Discover tier T", "Spend on upgrades". Rewards: coins scaled by current progression
- self-test: progress updates per event type, completion + claim once, reroll seeds deterministic

### js/audio.js — DP.Audio (WebAudio synth)
- `play('pop', {combo})` — pop pitch RISES with combo count (addictive!), `play('merge', {tier})` — rising two-tone per tier, `coin`, `chain` (crackle), `lucky` (sparkle arpeggio), `wheelTick`, `jackpot`, `quest` (jingle), `ascend` (5s swell), `fail`
- All synthesized; ±8% pitch jitter except combo ladder (deterministic rising scale); try/catch guards; node-safe self-test (spec table + pitch math)

### js/fx.js — DP.FX (3D particle system)
- Pools: coins (spinning gold discs), confetti, glow sparks, shockwave rings, "+123" DOM floating labels (pooled divs, world→screen projection helper exposed)
- `burst(type, worldX, worldZ, opts)`, `label(worldX, worldZ, text, color, size)`, `update(dt)`, `render(scene)` — attaches to THREE scene; `projectToScreen(x, z) → {x, y}` needs camera ref set by game.js via `DP.FX.setCamera(cam)`
- DOM-guarded; pure parts (pool math, projection) self-test

### js/render3d.js — DP.Render3D (three.js scene)
- `init(stageEl, board, content)`; `frame(dt, game)`; `setBoard(board)` (rebuild meshes on resize/board change); `screenToCell(sx, sy) → {idx, cell} | null` (raycast to grid cells, used by input); `cellToScreen(idx)`; `setDrag(idx, active)` drag ghost visuals
- Cubes: rounded box geometry per tier (size +0.06/tier, emissive glow scaled), lucky = gold material + sparkle idle, spawn scale-in elastic, pop = explode handled by fx, merge = new cube pops in with overshoot + flash ring, chain lightning = jagged emissive line segments briefly
- Arena: dark glossy floor, rim neon glow, gentle camera sway, fog; dpr cap 1.5; pooled meshes per tier; 60fps with 49 cubes
- DOM-guarded; node-safe self-test for pure helpers (cell math, tier→color mapping via DP.Content)

### js/input.js — DP.Input (gestures)
- Pointer events on the renderer canvas (game.js injects callbacks): `classify(down, up) → 'tap'|'drag'|'hold'` (tap: <12px & <250ms), drag threshold 12px
- Callbacks: `onTap(cellIdx)`, `onDragStart(cellIdx)`, `onDragMove(cellIdx|null, sx, sy)`, `onDragEnd(cellIdx|null, targetIdx)` — game.js decides semantics (pop vs merge)
- `isTouchDevice` reuse; self-test for the pure classifier

### js/ui.js — DP.UI (DOM panels)
- Builds (via JS into existing mounts — NEVER edits index.html): coin counter (count-up tween, bump on gain), combo meter (pulse, color shifts ×1→×3), top HUD, bottom quest strip (3 chips w/ progress), shop modal (6 upgrades w/ cost, affordability, press states), wheel modal (spins via CSS transform; sector order from DP.Wheel; tick sounds synced), collection modal (25 tier grid, locked = silhouette), ascend modal (confirmation + projected mult), offline modal, toast queue
- All modals: backdrop blur, spring-in, ≥48px targets, responsive portrait 390px → landscape
- Tween/count-up math in a pure section; self-test it

### js/game.js — DP.Game (orchestrator + event bus + integration) — ALSO builds test/integration.js
- `DP.Events` bus implementation; boot sequence in contract load order; fixed-dt loop (logic 1/60 accumulator, render rAF); wires: spawn timer → Board.spawn → Render3D.setBoard/FX; input callbacks → pop/merge semantics (tap = pop; drag same-tier onto = merge; drag onto empty = move cube); income ticking; combo decay; quests.onEvent on every event; wheel cooldown; save loop (5s + unload); offline modal on load; ascend flow
- MUST define the bus FIRST so other modules' guards pass
- `test/integration.js`: headless boot with DOM/canvas shims (pattern: cryptfall/test/integration.js), then a PLAYTEST BOT: simulate 5 minutes of play — random taps/drags at 4 taps/sec, assert: coins only increase, merges occur, combo ladder climbs, chains fire, quest completes claim, wheel spins after cooldown, serialize → reload → state equality, no NaN anywhere, no exceptions. ALL TESTS PASSED format.

## QUALITY BAR (NO AI SLOP — the entire point of this game)
Cohesive palette: deep space navy + neon rainbow cubes + gold. Every state
change eased (elastic spawns, overshoot merges, spring modals). Sound for
EVERYTHING (rising combo pitch is the addiction core). 5+ unsolicited juice
touches per module where sensible (coin trails, screen bump on big pops,
ambient starfield in render3d, wheel pointer wobble, quest chip shine).
Zero per-frame allocations (pools everywhere). 60fps mid-phone.
