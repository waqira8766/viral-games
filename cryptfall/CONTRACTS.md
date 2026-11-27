# CRYPTFALL — module contracts

Browser roguelike. No dependencies, no build step, no asset files.
Open `index.html` and play. All files are plain `<script>` tags using a single
global namespace: `globalThis.CF`.

## Shared conventions
- Every js file starts with:
  ```js
  var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
  ```
- No ES modules, no imports, no external libraries.
- Must be loadable in a browser AND runnable under plain `node <file>` for its
  self-test (guard browser-only APIs with `typeof` checks; guard the self-test
  with `if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('<thisfile>.js'))`).
- Self-test prints `PASS` lines and `ALL TESTS PASSED`, or `FAIL: <reason>`
  and exits with code 1.

## Tiles
`0 = wall`, `1 = floor`, `2 = door` (walkable), `3 = exit stairs` (walkable).
Grid is `tiles[y * width + x]`, Uint8Array. World scale: `CF.TILE = 40` px.
Tile center in world px: `(x * 40 + 20, y * 40 + 20)`.

## js/dungeon.js — CF.DungeonGen (subagent A)
- `CF.DungeonGen.generate({ width, height, floor, seed })`
  → `{ width, height, tiles, rooms, spawn:{x,y}, exit:{x,y},
        enemySpawns:[{x,y}], chests:[{x,y}], potions:[{x,y}], isBoss:bool }`
  - `rooms`: `[{x,y,w,h,cx,cy,type}]`, type ∈ `start|normal|treasure|boss`
  - Deterministic: same seed+floor → identical map (mulberry32 PRNG).
  - Every floor reachable: BFS flood-fill from spawn validates all floor
    tiles connected; retry on failure.
  - `floor % 5 === 0` → boss layout: one big arena room.
  - enemySpawns ≥ 4, all ≥ 5 tiles from spawn. chests 1–3, none in start room.
  - potions 0–4 scattered.
- `CF.DungeonGen.findPath(dungeon, sx, sy, tx, ty)` → `[{x,y},...] | null`
  BFS, 4-dir, no corner cutting.
- `CF.DungeonGen.hasLineOfSight(dungeon, x0, y0, x1, y1)` → bool (Bresenham).

## js/audio.js — CF.SoundFX (subagent B)
- `init()`, `play(name)`, `startMusic(intensity 0|1|2)`, `stopMusic()`,
  `setVolume(0..1)`, `toggleMute() → bool`, `isMuted() → bool`.
- Sound names: `hit, hurt, swing, pickup, coin, levelup, dash, shoot, explode,
  death, boss, chest, click, stairs, gameover, win`.
- 100% synthesized WebAudio (oscillators + noise envelopes). No files, no blobs.
- Never throws: wrap all audio API calls; node-run prints a static self-check.

## js/content.js — CF.Content (subagent C)
- `CF.ENEMIES` registry (id → def), `CF.ENEMY_STATS(id, floor)` → scaled stats,
  `CF.spawnTableFor(floor)`, `CF.ITEMS`, `CF.randomItem(floor, rand)`,
  `CF.UPGRADES` (each `{id,name,desc,max,apply(playerRef)}`),
  `CF.playerBase()`, `CF.xpForLevel(level)`, `CF.shopStock(floor, rand)`.
- Pure data + math. No DOM. Node self-test validates references + scaling.

## Core (main session)
- `js/engine.js` loop, input, camera, particles, floating text.
- `js/entities.js` player, enemies (AI), projectiles, pickups, chests.
- `js/ui.js` HUD, minimap, overlays: title, inventory, upgrade, shop, death, win.
- `js/main.js` state machine, floor orchestration, save/load (localStorage).
