var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
// CRYPTFALL — js/dungeon.js — CF.DungeonGen procedural dungeon generator.
// API: generate({width,height,floor,seed}), findPath(d,sx,sy,tx,ty),
// hasLineOfSight(d,x0,y0,x1,y1), bfsDistances(d,sx,sy). Tiles: 0=wall 1=floor
// 2=door 3=stairs (2 and 3 walkable), Uint8Array at tiles[y*width+x].
// Deterministic mulberry32 PRNG; every layout is BFS-validated and retried
// (seed+i -> relaxed constraints -> safe fallback). Self-test: node dungeon.js
if (typeof CF.TILE === 'undefined') CF.TILE = 40; // shared world scale (px/tile)

(function () {
  'use strict';

  var FLOOR = 1, DOOR = 2, STAIRS = 3;
  var ROOM_GAP = 1;         // min wall thickness between rooms
  var PLACE_TRIES = 600;    // rejection-sampling attempts per room
  var GEN_TRIES = 50;       // strict regeneration attempts (seed+i)
  var RELAXED_TRIES = 10;   // further attempts with relaxed constraints
  var PATH_NODE_CAP = 10000;// findPath safety valve
  var ENEMY_DIST = 5, CHEST_DIST = 4, POTION_DIST = 3; // min BFS dist from spawn

  // ---- deterministic PRNG (mulberry32) + helpers --------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function shuffle(rng, arr) { // Fisher–Yates, in place
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ---- geometry -----------------------------------------------------------
  function inBounds(W, H, x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
  function inRect(x, y, r) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
  function roomCenter(r) { return { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) }; }
  function walkable(t) { return t === FLOOR || t === DOOR || t === STAIRS; }
  function roomsTooClose(a, b) { // overlapping OR nearer than ROOM_GAP
    return !(a.x + a.w + ROOM_GAP <= b.x || b.x + b.w + ROOM_GAP <= a.x ||
             a.y + a.h + ROOM_GAP <= b.y || b.y + b.h + ROOM_GAP <= a.y);
  }

  // ---- BFS distance field from (sx,sy); -1 = unreachable ------------------
  function bfsField(W, H, tiles, sx, sy) {
    var n = W * H;
    var dist = new Int32Array(n), seen = new Uint8Array(n), queue = new Int32Array(n);
    var head = 0, tail = 0, i;
    for (i = 0; i < n; i++) dist[i] = -1;
    if (!inBounds(W, H, sx, sy) || !walkable(tiles[sy * W + sx])) return dist;
    dist[sy * W + sx] = 0; seen[sy * W + sx] = 1; queue[tail++] = sy * W + sx;
    while (head < tail) {
      var idx = queue[head++], nd = dist[idx] + 1, x = idx % W;
      if (x > 0 && !seen[idx - 1] && walkable(tiles[idx - 1])) { seen[idx - 1] = 1; dist[idx - 1] = nd; queue[tail++] = idx - 1; }
      if (x < W - 1 && !seen[idx + 1] && walkable(tiles[idx + 1])) { seen[idx + 1] = 1; dist[idx + 1] = nd; queue[tail++] = idx + 1; }
      if (idx >= W && !seen[idx - W] && walkable(tiles[idx - W])) { seen[idx - W] = 1; dist[idx - W] = nd; queue[tail++] = idx - W; }
      if (idx + W < n && !seen[idx + W] && walkable(tiles[idx + W])) { seen[idx + W] = 1; dist[idx + W] = nd; queue[tail++] = idx + W; }
    }
    return dist;
  }

  // ---- carving ------------------------------------------------------------
  function carveRect(tiles, W, H, r) {
    for (var y = r.y; y < r.y + r.h; y++)
      for (var x = r.x; x < r.x + r.w; x++) tiles[y * W + x] = FLOOR;
  }
  // Ordered 4-connected L-shaped path between two points (endpoints included).
  function lPath(x1, y1, x2, y2, horizontalFirst) {
    var pts = [], x, y;
    if (horizontalFirst) {
      for (x = x1; x !== x2; x += x2 > x1 ? 1 : -1) pts.push({ x: x, y: y1 });
      for (y = y1; y !== y2; y += y2 > y1 ? 1 : -1) pts.push({ x: x2, y: y });
    } else {
      for (y = y1; y !== y2; y += y2 > y1 ? 1 : -1) pts.push({ x: x1, y: y });
      for (x = x1; x !== x2; x += x2 > x1 ? 1 : -1) pts.push({ x: x, y: y2 });
    }
    pts.push({ x: x2, y: y2 });
    return pts;
  }
  // Carve a corridor and record room-boundary crossings; each crossing tile
  // (on the room's wall ring) becomes a door once all carving is done.
  function carveCorridorPath(tiles, W, H, path, rooms, doorMarks) {
    var k, i;
    for (k = 0; k < path.length; k++) {
      var p = path[k];
      if (p.x > 0 && p.y > 0 && p.x < W - 1 && p.y < H - 1) // keep border solid
        tiles[p.y * W + p.x] = FLOOR;
    }
    for (k = 1; k < path.length; k++) {
      var prev = path[k - 1], cur = path[k];
      for (i = 0; i < rooms.length; i++) {
        var wasIn = inRect(prev.x, prev.y, rooms[i]);
        if (wasIn !== inRect(cur.x, cur.y, rooms[i])) { // crossed a boundary
          var d = wasIn ? cur : prev; // the boundary tile itself = the door
          if (d.x > 0 && d.y > 0 && d.x < W - 1 && d.y < H - 1)
            doorMarks.push(d.y * W + d.x);
        }
      }
    }
  }

  // ---- one candidate dungeon (null = constraint failure, caller retries) --
  function attemptDungeon(W, H, floor, seed, relaxed) {
    var rng = mulberry32(seed), n = W * H;
    var tiles = new Uint8Array(n); // all wall
    var isBoss = (floor % 5 === 0);
    var totalRooms = 6 + Math.min(floor, 8);
    var rooms = [], i, j;

    // Boss arena: sized first so the start room can be placed around it.
    var arena = null, ddx = 1, ddy = 1;
    if (isBoss) {
      var aw = randInt(rng, 13, 17), ah = randInt(rng, 13, 17);
      var ax = (W - aw) >> 1, ay = (H - ah) >> 1; // centered
      if (ax < 1 || ay < 1 || ax + aw > W - 1 || ay + ah > H - 1) return null;
      arena = { x: ax, y: ay, w: aw, h: ah, type: 'boss' };
    }
    // Rejection-sampled placement of 5-11 x 5-9 rooms with a 1-tile gap.
    function placeRoom(type, avoid) {
      for (var t = 0; t < PLACE_TRIES; t++) {
        var rw = randInt(rng, 5, 11), rh = randInt(rng, 5, 9);
        if (rw + 2 > W || rh + 2 > H) continue; // would touch the border
        var cand = { x: randInt(rng, 1, W - rw - 1), y: randInt(rng, 1, H - rh - 1),
                     w: rw, h: rh, type: type };
        var bad = false;
        for (var q = 0; q < avoid.length; q++)
          if (roomsTooClose(cand, avoid[q])) { bad = true; break; }
        if (!bad) return cand;
      }
      return null;
    }
    var startRoom = placeRoom('start', arena ? [arena] : []); // room 0 = start
    if (!startRoom) return null;
    rooms.push(startRoom);
    if (arena) rooms.push(arena);
    while (rooms.length < totalRooms) {
      var nr = placeRoom('normal', rooms);
      if (!nr) return null;
      rooms.push(nr);
    }
    for (i = 0; i < rooms.length; i++) carveRect(tiles, W, H, rooms[i]);

    // Corridors: nearest-neighbor chain (room i links to its nearest earlier
    // room). Boss floors carve a second parallel lane => 2-wide corridors.
    var doorMarks = [];
    for (i = 1; i < rooms.length; i++) {
      var a = roomCenter(rooms[i]), best = 0, bestD = Infinity;
      for (j = 0; j < i; j++) {
        var bb = roomCenter(rooms[j]);
        var dd = (a.x - bb.x) * (a.x - bb.x) + (a.y - bb.y) * (a.y - bb.y);
        if (dd < bestD) { bestD = dd; best = j; }
      }
      var b = roomCenter(rooms[best]), hFirst = rng() < 0.5;
      carveCorridorPath(tiles, W, H, lPath(a.x, a.y, b.x, b.y, hFirst), rooms, doorMarks);
      if (isBoss)
        carveCorridorPath(tiles, W, H, lPath(a.x + 1, a.y + 1, b.x + 1, b.y + 1, hFirst), rooms, doorMarks);
    }
    for (i = 0; i < doorMarks.length; i++) // doors applied after all carving
      if (tiles[doorMarks[i]] === FLOOR) tiles[doorMarks[i]] = DOOR;

    // Spawn = start room center; BFS distances from spawn.
    var sc = roomCenter(rooms[0]);
    var spawn = { x: sc.x, y: sc.y };
    var dist = bfsField(W, H, tiles, spawn.x, spawn.y);

    // Exit stairs: boss floors -> arena far side; else farthest room (BFS).
    var exit;
    if (isBoss) {
      var ac = roomCenter(arena); // corner pointing away from the start room
      ddx = ac.x > spawn.x ? 1 : -1;
      ddy = ac.y > spawn.y ? 1 : -1;
      exit = { x: ddx > 0 ? arena.x + arena.w - 2 : arena.x + 1,
               y: ddy > 0 ? arena.y + arena.h - 2 : arena.y + 1 };
    } else {
      var farD = -1, farRoom = null;
      for (i = 0; i < rooms.length; i++) {
        var rc = roomCenter(rooms[i]), rd = dist[rc.y * W + rc.x];
        if (rd > farD) { farD = rd; farRoom = rooms[i]; }
      }
      if (!farRoom || farD <= 0) return null; // disconnected — retry
      exit = { x: roomCenter(farRoom).x, y: roomCenter(farRoom).y };
    }
    tiles[exit.y * W + exit.x] = STAIRS;

    // ---- item/enemy placement ---------------------------------------------
    var used = {}; // tile index -> true; nothing may spawn twice
    used[exit.y * W + exit.x] = true;
    used[spawn.y * W + spawn.x] = true;
    function candidates(minDist, forbiddenRoom) { // shuffled eligible tiles
      var list = [];
      for (var idx = 0; idx < n; idx++) {
        if (!walkable(tiles[idx]) || dist[idx] < minDist || used[idx]) continue;
        if (forbiddenRoom) {
          var px = idx % W, py = (idx - px) / W;
          if (inRect(px, py, forbiddenRoom)) continue;
        }
        list.push(idx);
      }
      return shuffle(rng, list);
    }
    function take(list) { // pop a tile, mark it used, return {x,y}
      var idx = list.pop();
      used[idx] = true;
      return { x: idx % W, y: (idx - (idx % W)) / W };
    }
    function scatter(dest, src, count) { // false = unrecoverable shortage
      for (var q = 0; q < count; q++) {
        if (!src.length) return relaxed; // relaxed: keep what we have
        dest.push(take(src));
      }
      return true;
    }

    // Chests: 1-3 outside the start room; boss floors: one by the arena exit.
    var chests = [];
    if (isBoss) {
      var bcx = exit.x - ddx, bcy = exit.y - ddy; // one tile toward center
      if (!inBounds(W, H, bcx, bcy) || !walkable(tiles[bcy * W + bcx]) ||
          used[bcy * W + bcx]) return null;
      chests.push({ x: bcx, y: bcy });
      used[bcy * W + bcx] = true;
    } else {
      var chestN = randInt(rng, 1, 3);
      if (!scatter(chests, candidates(relaxed ? 0 : CHEST_DIST, rooms[0]), chestN)) return null;
    }
    for (i = 0; i < chests.length; i++) // chest rooms become treasure rooms
      for (j = 1; j < rooms.length; j++)
        if (rooms[j].type === 'normal' && inRect(chests[i].x, chests[i].y, rooms[j])) {
          rooms[j].type = 'treasure';
          break;
        }

    // Potions: 0-4 scattered floor tiles.
    var potions = [];
    if (!scatter(potions, candidates(relaxed ? 0 : POTION_DIST, null), randInt(rng, 0, 4))) return null;

    // Enemies: 5 + floor*2 (cap 40), each >= 5 tiles from spawn; boss floors
    // LEAD with the boss standing at the arena center.
    var enemies = [];
    if (isBoss) {
      var bc = roomCenter(arena);
      if (!walkable(tiles[bc.y * W + bc.x]) || used[bc.y * W + bc.x]) return null;
      enemies.push({ x: bc.x, y: bc.y });
      used[bc.y * W + bc.x] = true;
    }
    if (!scatter(enemies, candidates(relaxed ? 0 : ENEMY_DIST, null),
                 Math.min(5 + floor * 2, 40) - enemies.length)) return null;

    // ---- validation: BFS flood-fill from spawn ----------------------------
    // Everything spawned must be walkable, in-bounds, reachable and far
    // enough from spawn; every walkable tile must be connected. Else retry.
    var dist2 = bfsField(W, H, tiles, spawn.x, spawn.y);
    function posOk(p, minDist, notInStartRoom) {
      if (!inBounds(W, H, p.x, p.y) || !walkable(tiles[p.y * W + p.x])) return false;
      var pd = dist2[p.y * W + p.x];
      if (pd < 0) return false;                   // unreachable
      if (!relaxed && pd < minDist) return false; // too close to spawn
      return !(notInStartRoom && inRect(p.x, p.y, rooms[0]));
    }
    var ok = walkable(tiles[spawn.y * W + spawn.x]) && posOk(exit, 0, false);
    for (i = 0; i < enemies.length; i++) ok = ok && posOk(enemies[i], ENEMY_DIST, false);
    for (i = 0; i < chests.length; i++) ok = ok && posOk(chests[i], CHEST_DIST, true);
    for (i = 0; i < potions.length; i++) ok = ok && posOk(potions[i], POTION_DIST, false);
    var walkTotal = 0, walkReach = 0;
    for (i = 0; i < n; i++)
      if (walkable(tiles[i])) { walkTotal++; if (dist2[i] >= 0) walkReach++; }
    if (!ok || walkTotal !== walkReach) return null;

    for (i = 0; i < rooms.length; i++) { rooms[i].cx = roomCenter(rooms[i]).x; rooms[i].cy = roomCenter(rooms[i]).y; }
    return { width: W, height: H, tiles: tiles, rooms: rooms, spawn: spawn, exit: exit,
             enemySpawns: enemies, chests: chests, potions: potions, isBoss: isBoss };
  }

  // Guaranteed-valid last resort: one big chamber holding everything.
  function fallbackDungeon(W, H, floor, seed) {
    var rng = mulberry32((seed ^ 0x5BD1E995) >>> 0);
    var tiles = new Uint8Array(W * H);
    var rx = 1, ry = 1, rw = W - 3, rh = H - 3;
    carveRect(tiles, W, H, { x: rx, y: ry, w: rw, h: rh });
    var isBoss = (floor % 5 === 0);
    var room = { x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1),
                 type: isBoss ? 'boss' : 'start' };
    var spawn = { x: rx + 2, y: room.cy };
    var exit = { x: rx + rw - 3, y: room.cy };
    tiles[exit.y * W + exit.x] = STAIRS;
    var dist = bfsField(W, H, tiles, spawn.x, spawn.y);
    var used = {};
    used[exit.y * W + exit.x] = true;
    used[spawn.y * W + spawn.x] = true;
    function pick(minDist) { // random reachable tile at least minDist away
      for (var t = 0; t < 4000; t++) {
        var idx = randInt(rng, 0, W * H - 1);
        if (!used[idx] && dist[idx] >= minDist) {
          used[idx] = true;
          return { x: idx % W, y: (idx - (idx % W)) / W };
        }
      }
      return null;
    }
    var chests = [], potions = [], enemies = [], i, v;
    for (i = 0; i < (isBoss ? 1 : randInt(rng, 1, 3)); i++) { v = pick(CHEST_DIST); if (v) chests.push(v); }
    for (i = 0; i < randInt(rng, 0, 4); i++) { v = pick(POTION_DIST); if (v) potions.push(v); }
    for (i = 0; i < Math.min(5 + floor * 2, 40); i++) { v = pick(ENEMY_DIST); if (v) enemies.push(v); }
    return { width: W, height: H, tiles: tiles, rooms: [room], spawn: spawn, exit: exit,
             enemySpawns: enemies, chests: chests, potions: potions, isBoss: isBoss };
  }

  // ---- public API ---------------------------------------------------------
  function generate(opts) {
    var o = opts || {};
    var W = Math.max(24, Math.floor(o.width) || 80);
    var H = Math.max(24, Math.floor(o.height) || 80);
    var floor = Math.max(1, Math.floor(o.floor) || 1);
    var seed = (typeof o.seed === 'number') ? (o.seed >>> 0) : 1;
    var i, d;
    for (i = 0; i <= GEN_TRIES; i++) { // strict constraints, seed+i
      d = attemptDungeon(W, H, floor, (seed + i) >>> 0, false);
      if (d) return d;
    }
    for (i = 1; i <= RELAXED_TRIES; i++) { // then relax constraints
      d = attemptDungeon(W, H, floor, (seed + GEN_TRIES + i) >>> 0, true);
      if (d) return d;
    }
    return fallbackDungeon(W, H, floor, seed);
  }

  // BFS shortest path, 4-directional, walls block, no corner cutting.
  // Returns tile steps EXCLUDING the start and INCLUDING the target.
  function findPath(dungeon, sx, sy, tx, ty) {
    if (!dungeon || !dungeon.tiles || !dungeon.width || !dungeon.height) return null;
    var W = dungeon.width, H = dungeon.height, tiles = dungeon.tiles;
    if (!inBounds(W, H, sx, sy) || !inBounds(W, H, tx, ty)) return null;
    if (!walkable(tiles[sy * W + sx]) || !walkable(tiles[ty * W + tx])) return null;
    if (sx === tx && sy === ty) return [];
    var n = W * H, sIdx = sy * W + sx, tIdx = ty * W + tx;
    var prev = new Int32Array(n), seen = new Uint8Array(n), queue = new Int32Array(n);
    var head = 0, tail = 0, explored = 0;
    seen[sIdx] = 1;
    queue[tail++] = sIdx;
    function visit(idx, fromIdx) { // mark + enqueue; true when target found
      if (seen[idx] || !walkable(tiles[idx])) return false;
      seen[idx] = 1;
      prev[idx] = fromIdx;
      queue[tail++] = idx;
      return idx === tIdx;
    }
    function buildPath() {
      var path = [], cur = tIdx;
      while (cur !== sIdx) {
        path.push({ x: cur % W, y: (cur - (cur % W)) / W });
        cur = prev[cur];
      }
      return path.reverse();
    }
    while (head < tail) {
      if (++explored > PATH_NODE_CAP) return null; // safety cap
      var idx = queue[head++], x = idx % W;
      if (x > 0 && visit(idx - 1, idx)) return buildPath();
      if (x < W - 1 && visit(idx + 1, idx)) return buildPath();
      if (idx >= W && visit(idx - W, idx)) return buildPath();
      if (idx + W < n && visit(idx + W, idx)) return buildPath();
    }
    return null; // unreachable
  }

  // Bresenham over tile centers; a wall strictly BETWEEN the endpoints blocks
  // sight (the endpoints themselves never do).
  function hasLineOfSight(dungeon, x0, y0, x1, y1) {
    if (!dungeon || !dungeon.tiles || !dungeon.width || !dungeon.height) return false;
    var W = dungeon.width, H = dungeon.height, tiles = dungeon.tiles;
    if (!inBounds(W, H, x0, y0) || !inBounds(W, H, x1, y1)) return false;
    var x = x0, y = y0;
    var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    var dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    while (x !== x1 || y !== y1) {
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
      if (x === x1 && y === y1) break; // target reached — endpoints excluded
      if (!walkable(tiles[y * W + x])) return false; // wall in between
    }
    return true;
  }

  // Public distance field (handy for enemy AI too).
  function bfsDistances(dungeon, sx, sy) {
    if (!dungeon || !dungeon.tiles) return new Int32Array(0);
    return bfsField(dungeon.width | 0, dungeon.height | 0, dungeon.tiles, sx | 0, sy | 0);
  }

  // ---- self-test (node dungeon.js) ----------------------------------------
  function selfTest() {
    var failures = 0;
    function check(desc, cond) {
      if (cond) console.log('PASS ' + desc);
      else { failures++; console.log('FAIL: ' + desc); }
    }
    function isWalk(d, x, y) {
      if (x < 0 || y < 0 || x >= d.width || y >= d.height) return false;
      var t = d.tiles[y * d.width + x];
      return t === 1 || t === 2 || t === 3;
    }
    function clash(a, b) {
      return !(a.x + a.w + 1 <= b.x || b.x + b.w + 1 <= a.x ||
               a.y + a.h + 1 <= b.y || b.y + b.h + 1 <= a.y);
    }
    function tilesEqual(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    function posOk(d, dist, list, minD) { // walkable + reachable + >= minD
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!isWalk(d, p.x, p.y) || dist[p.y * d.width + p.x] < minD) return false;
      }
      return true;
    }
    function strip(d) { // full result minus the typed array
      return { width: d.width, height: d.height, rooms: d.rooms, spawn: d.spawn, exit: d.exit,
               enemySpawns: d.enemySpawns, chests: d.chests, potions: d.potions, isBoss: d.isBoss };
    }

    var FLOORS = [1, 3, 5, 10, 15];
    for (var fi = 0; fi < FLOORS.length; fi++) {
      var f = FLOORS[fi];
      var size = (f % 5 === 0) ? 96 : 80; // boss floors get a bigger grid
      var W = size;
      var d = CF.DungeonGen.generate({ width: size, height: size, floor: f, seed: 12345 });
      var tag = '[floor ' + f + '] ';
      check(tag + 'generate() returns a dungeon', !!d);
      if (!d) continue;
      var dist = CF.DungeonGen.bfsDistances(d, d.spawn.x, d.spawn.y);
      var i, k;

      check(tag + 'dimensions are ' + size + 'x' + size, d.width === size && d.height === size);
      check(tag + 'tiles is Uint8Array[' + size * size + ']', d.tiles instanceof Uint8Array && d.tiles.length === size * size);
      check(tag + 'isBoss === ' + (f % 5 === 0), d.isBoss === (f % 5 === 0));
      check(tag + 'room count is ' + (6 + Math.min(f, 8)), d.rooms.length === 6 + Math.min(f, 8));
      check(tag + 'room[0] is start, spawn at its center',
        d.rooms[0].type === 'start' && d.spawn.x === d.rooms[0].cx && d.spawn.y === d.rooms[0].cy);

      var roomsOk = true, sepOk = true; // bounds, sizes, centers, separation
      for (i = 0; i < d.rooms.length; i++) {
        var r = d.rooms[i];
        if (r.x < 1 || r.y < 1 || r.x + r.w > W - 1 || r.y + r.h > W - 1) roomsOk = false;
        if (r.w < 5 || r.h < 5 || r.cx !== r.x + (r.w >> 1) || r.cy !== r.y + (r.h >> 1)) roomsOk = false;
        for (k = i + 1; k < d.rooms.length; k++) if (clash(r, d.rooms[k])) sepOk = false;
      }
      check(tag + 'rooms in map bounds with valid centers', roomsOk);
      check(tag + 'rooms overlap-free (>= 1 tile gap)', sepOk);

      check(tag + 'spawn and exit walkable',
        isWalk(d, d.spawn.x, d.spawn.y) && isWalk(d, d.exit.x, d.exit.y));
      var path = CF.DungeonGen.findPath(d, d.spawn.x, d.spawn.y, d.exit.x, d.exit.y);
      check(tag + 'exit reachable via findPath',
        !!path && path.length >= 1 && path[path.length - 1].x === d.exit.x && path[path.length - 1].y === d.exit.y);

      var tot = 0, got = 0, doors = 0; // full flood-fill connectivity
      for (i = 0; i < d.tiles.length; i++) {
        var t = d.tiles[i];
        if (t === 2) doors++;
        if (t === 1 || t === 2 || t === 3) { tot++; if (dist[i] >= 0) got++; }
      }
      check(tag + 'all walkable tiles reachable from spawn', tot === got);
      check(tag + 'map contains door tiles', doors > 0);

      check(tag + 'enemy count is ' + Math.min(5 + f * 2, 40), d.enemySpawns.length === Math.min(5 + f * 2, 40));
      check(tag + 'enemies walkable, reachable, >= 5 from spawn', posOk(d, dist, d.enemySpawns, 5));

      var chestOk = d.chests.length >= 1 && d.chests.length <= 3 &&
        (!d.isBoss || d.chests.length === 1) && posOk(d, dist, d.chests, 4);
      for (i = 0; i < d.chests.length; i++) // none inside the start room
        if (inRect(d.chests[i].x, d.chests[i].y, d.rooms[0])) chestOk = false;
      if (d.isBoss && d.chests.length === 1) { // boss chest near arena exit
        var bc2 = d.chests[0];
        if (Math.abs(bc2.x - d.exit.x) + Math.abs(bc2.y - d.exit.y) > 2) chestOk = false;
      }
      check(tag + 'chests valid (count/walkable/reachable/>=4/outside start)', chestOk);
      check(tag + 'potions valid (0-4/walkable/reachable/>=3)',
        d.potions.length <= 4 && posOk(d, dist, d.potions, 3));

      var seen = {}, dup = false, all = [d.spawn, d.exit].concat(d.enemySpawns, d.chests, d.potions);
      for (i = 0; i < all.length; i++) { // no two spawned positions may coincide
        var key = all[i].y * W + all[i].x;
        if (seen[key]) dup = true;
        seen[key] = 1;
      }
      check(tag + 'no duplicate spawn/item positions', !dup);

      if (d.isBoss) { // exit on arena far side, boss at its center
        var arena = null;
        for (i = 0; i < d.rooms.length; i++) if (d.rooms[i].type === 'boss') arena = d.rooms[i];
        check(tag + 'boss arena exists (13-17 wide/tall)', !!arena &&
          arena.w >= 13 && arena.w <= 17 && arena.h >= 13 && arena.h <= 17);
        if (arena) {
          check(tag + 'exit inside arena (far side)', inRect(d.exit.x, d.exit.y, arena));
          check(tag + 'boss first at arena center', d.enemySpawns.length > 0 &&
            d.enemySpawns[0].x === arena.cx && d.enemySpawns[0].y === arena.cy);
        }
      } else { // exit must sit in the room farthest from spawn (BFS)
        var bestD = -1, exitD = -1;
        for (i = 0; i < d.rooms.length; i++) {
          var rr = d.rooms[i], dd = dist[rr.cy * W + rr.cx];
          if (dd > bestD) bestD = dd;
          if (inRect(d.exit.x, d.exit.y, rr)) exitD = dd;
        }
        check(tag + 'exit stairs in farthest room (BFS)', exitD > 0 && exitD === bestD);
      }

      var pathOk = true, items = d.enemySpawns.concat(d.chests, d.potions);
      for (i = 0; i < items.length; i++)
        if (CF.DungeonGen.findPath(d, d.spawn.x, d.spawn.y, items[i].x, items[i].y) === null) pathOk = false;
      check(tag + 'findPath reaches every enemy/chest/potion', pathOk);
    }

    // Determinism: same seed + floor must reproduce the exact same dungeon.
    var a = CF.DungeonGen.generate({ width: 80, height: 80, floor: 3, seed: 12345 });
    var b = CF.DungeonGen.generate({ width: 80, height: 80, floor: 3, seed: 12345 });
    check('determinism (floor 3): identical tiles', tilesEqual(a.tiles, b.tiles));
    check('determinism (floor 3): identical layout data', JSON.stringify(strip(a)) === JSON.stringify(strip(b)));
    var c = CF.DungeonGen.generate({ width: 96, height: 96, floor: 10, seed: 12345 });
    var e = CF.DungeonGen.generate({ width: 96, height: 96, floor: 10, seed: 12345 });
    check('determinism (floor 10 boss): identical tiles', tilesEqual(c.tiles, e.tiles));
    check('determinism (floor 10 boss): identical layout data', JSON.stringify(strip(c)) === JSON.stringify(strip(e)));
    check('different seed produces a different map',
      !tilesEqual(a.tiles, CF.DungeonGen.generate({ width: 80, height: 80, floor: 3, seed: 999 }).tiles));

    // Synthetic pathfinding / line-of-sight checks on hand-made maps.
    var st = { width: 9, height: 9, tiles: new Uint8Array(81) }; // plus shape
    for (var g = 1; g <= 7; g++) { st.tiles[4 * 9 + g] = 1; st.tiles[g * 9 + 4] = 1; }
    var pp = CF.DungeonGen.findPath(st, 1, 4, 4, 1);
    var pOk = !!pp && pp.length === 6; // must route through the crossing
    if (pOk) {
      var wx = 1, wy = 4;
      for (var si = 0; si < pp.length; si++) {
        if (Math.abs(pp[si].x - wx) + Math.abs(pp[si].y - wy) !== 1) { pOk = false; break; }
        wx = pp[si].x; wy = pp[si].y;
      }
      if (wx !== 4 || wy !== 1) pOk = false;
    }
    check('findPath: correct shortest path (steps + target)', pOk);
    check('findPath: start === target gives empty path',
      CF.DungeonGen.findPath(st, 1, 4, 1, 4) !== null &&
      CF.DungeonGen.findPath(st, 1, 4, 1, 4).length === 0);
    check('findPath: wall target gives null', CF.DungeonGen.findPath(st, 1, 4, 4, 0) === null);
    var st2 = { width: 9, height: 9, tiles: new Uint8Array(81) }; // disjoint rows
    for (g = 1; g <= 7; g++) { st2.tiles[2 * 9 + g] = 1; st2.tiles[6 * 9 + g] = 1; }
    check('findPath: unreachable target gives null', CF.DungeonGen.findPath(st2, 1, 2, 1, 6) === null);
    check('hasLineOfSight: clear straight line', CF.DungeonGen.hasLineOfSight(st, 1, 4, 7, 4) === true);
    check('hasLineOfSight: wall blocks diagonal', CF.DungeonGen.hasLineOfSight(st, 1, 4, 4, 1) === false);
    check('hasLineOfSight: same tile', CF.DungeonGen.hasLineOfSight(st, 1, 4, 1, 4) === true);
    check('hasLineOfSight: endpoints excluded', CF.DungeonGen.hasLineOfSight(st, 4, 4, 4, 0) === true);

    if (failures > 0) {
      console.log('SELF-TEST FAILED: ' + failures + ' check(s) failed');
      if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(1);
    } else {
      console.log('ALL TESTS PASSED');
    }
  }

  // ---- exports + node self-test guard -------------------------------------
  CF.DungeonGen = {
    generate: generate,
    findPath: findPath,
    hasLineOfSight: hasLineOfSight,
    bfsDistances: bfsDistances
  };
  if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('dungeon.js')) {
    selfTest();
  }
})();
