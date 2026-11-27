/* ============================================================================
   DOPAMINE FACTORY — js/board.js — DP.Board (pure grid logic, no DOM/THREE)
   Contract (CONTRACTS.md § board.js):
     create(size)                         -> {size, cells:[{tier,lucky,id}|null], nextId}
     spawn(board, minTier, maxTier, rng)   -> {idx, tier, lucky} | null (full)
     pop(board, idx)                      -> {tier, lucky} | null (cell removed)
     merge(board, a, b)                   -> {tier} | null (same tier only, result at b)
     totalValue(board)                    -> sum of canon coinValue (idle income base)
     emptyCells(board)                    -> number of free cells
     resize(board, newSize)               -> board (cubes keep their x/y coordinates)
     chainTargets(board, count, rng[,src]) -> idx[] (random non-empty, source excluded)
   ============================================================================ */

var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});

(function () {
  'use strict';

  var MAX_TIER = 25;     // canon: 25 tiers, merge ceiling
  var LUCKY_BASE = 0.05; // canon: 5% of spawns are lucky (pop value x10)

  /* Canon coinValue. DP.Content owns the canon; the identical formula is the
     fallback so this file stays correct standalone (node test, odd load order). */
  function coinValue(tier) {
    if (typeof DP.Content !== 'undefined' && DP.Content &&
        typeof DP.Content.coinValue === 'function') return DP.Content.coinValue(tier);
    return Math.round(10 * Math.pow(3.5, tier - 1));
  }

  /* Normalize any rng into a finite float in [0, 1). */
  function rnd(rng) {
    var r = (typeof rng === 'function') ? Number(rng()) : Math.random();
    if (typeof r !== 'number' || !isFinite(r) || r < 0) r = Math.random();
    return r >= 1 ? 0.9999999999999998 : r;
  }

  function validIdx(board, idx) {
    return typeof idx === 'number' && isFinite(idx) && idx >= 0 &&
           Math.floor(idx) === idx && idx < board.cells.length;
  }

  function nextIdOf(board) {
    var id = (typeof board.nextId === 'number' && isFinite(board.nextId)) ? board.nextId : 1;
    board.nextId = id + 1;
    return id;
  }

  /* ---- create ----------------------------------------------------------- */
  function create(size) {
    size = Math.floor(Number(size));
    if (!isFinite(size) || size < 1) size = 5; // canon default board
    var cells = new Array(size * size);
    for (var i = 0; i < cells.length; i++) cells[i] = null;
    return { size: size, cells: cells, nextId: 1 };
  }

  /* ---- spawn ------------------------------------------------------------
     Random EMPTY cell. Tier random in [minTier, maxTier] skewed toward the
     low end (r^2 weighting). lucky: 5% canon (5th arg lets game.js apply the
     luckyChance upgrade). rng call order fixed: cell, tier, lucky.         */
  function spawn(board, minTier, maxTier, rng, luckyChance) {
    if (!board || !board.cells) return null;
    var empties = [];
    for (var i = 0; i < board.cells.length; i++) if (!board.cells[i]) empties.push(i);
    if (empties.length === 0) return null; // full board

    var lo = Math.max(1, Math.floor(Number(minTier) || 1));
    var hi = Math.min(MAX_TIER, Math.floor(Number(maxTier) || lo));
    if (hi < lo) hi = lo;
    var span = hi - lo + 1;

    var idx = empties[Math.floor(rnd(rng) * empties.length)];
    var r = rnd(rng);
    var tier = lo + Math.min(span - 1, Math.floor(r * r * span));
    var chance = (typeof luckyChance === 'number' && isFinite(luckyChance))
      ? Math.min(1, Math.max(0, luckyChance)) : LUCKY_BASE;
    var lucky = rnd(rng) < chance;

    board.cells[idx] = { tier: tier, lucky: lucky, id: nextIdOf(board) };
    return { idx: idx, tier: tier, lucky: lucky };
  }

  /* ---- pop -------------------------------------------------------------- */
  function pop(board, idx) {
    if (!board || !validIdx(board, idx)) return null;
    var cube = board.cells[idx];
    if (!cube) return null;
    board.cells[idx] = null;
    return { tier: cube.tier, lucky: !!cube.lucky };
  }

  /* ---- merge ------------------------------------------------------------
     Drag a onto b: needs a !== b, both occupied, same tier. Result tier+1
     (max 25) lands at b; a cleared. Fresh cube (new id, not lucky).
     Two tier-25s -> null (ceiling).                                         */
  function merge(board, a, b) {
    if (!board || !validIdx(board, a) || !validIdx(board, b) || a === b) return null;
    var ca = board.cells[a], cb = board.cells[b];
    if (!ca || !cb || ca.tier !== cb.tier) return null;
    if (ca.tier >= MAX_TIER) return null;
    var tier = ca.tier + 1;
    board.cells[a] = null;
    board.cells[b] = { tier: tier, lucky: false, id: nextIdOf(board) };
    return { tier: tier };
  }

  /* ---- totalValue: idle income base = totalValue * 0.05/s * incomeMult --- */
  function totalValue(board) {
    if (!board || !board.cells) return 0;
    var sum = 0;
    for (var i = 0; i < board.cells.length; i++) {
      var c = board.cells[i];
      if (c && typeof c.tier === 'number') sum += coinValue(c.tier);
    }
    return sum;
  }

  /* ---- emptyCells -------------------------------------------------------- */
  function emptyCells(board) {
    if (!board || !board.cells) return 0;
    var n = 0;
    for (var i = 0; i < board.cells.length; i++) if (!board.cells[i]) n++;
    return n;
  }

  /* ---- resize ------------------------------------------------------------
     Grid resize (5x5 -> 6x6 -> 7x7 upgrade). Cubes KEEP their (x, y) coords;
     a down-size drops cubes outside the new bounds. Mutates in place, cube
     objects move by reference (identity kept). Returns the same board.     */
  function resize(board, newSize) {
    if (!board || !board.cells) return board;
    newSize = Math.floor(Number(newSize));
    if (!isFinite(newSize) || newSize < 1 || newSize === board.size) return board;
    var oldSize = Math.max(1, Math.floor(board.size) || 1);
    var cells = new Array(newSize * newSize);
    for (var i = 0; i < cells.length; i++) cells[i] = null;
    for (var j = 0; j < board.cells.length; j++) {
      var cube = board.cells[j];
      if (!cube) continue;
      var x = j % oldSize, y = Math.floor(j / oldSize);
      if (x < newSize && y < newSize) cells[y * newSize + x] = cube;
    }
    board.size = newSize;
    board.cells = cells;
    return board;
  }

  /* ---- chainTargets ------------------------------------------------------
     Up to `count` distinct random NON-EMPTY indices for chain reactions. The
     popped source is never targeted: pass its idx as optional 4th arg if it
     is still on the board (already-popped sources are skipped anyway).     */
  function chainTargets(board, count, rng, sourceIdx) {
    if (!board || !board.cells) return [];
    count = Math.floor(Number(count));
    if (!isFinite(count) || count <= 0) return [];
    var pool = [];
    for (var i = 0; i < board.cells.length; i++) {
      if (board.cells[i] && i !== sourceIdx) pool.push(i);
    }
    var n = Math.min(count, pool.length);
    for (var k = 0; k < n; k++) { // partial Fisher-Yates: distinct sample
      var j = k + Math.floor(rnd(rng) * (pool.length - k));
      var t = pool[k]; pool[k] = pool[j]; pool[j] = t;
    }
    pool.length = n;
    return pool;
  }

  /* ---- exports ----------------------------------------------------------- */
  DP.Board = {
    MAX_TIER: MAX_TIER, LUCKY_BASE: LUCKY_BASE, create: create, spawn: spawn,
    pop: pop, merge: merge, totalValue: totalValue, emptyCells: emptyCells,
    resize: resize, chainTargets: chainTargets
  };

  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = DP.Board;
  }

  /* ================= node self-test (run: node js/board.js) ================ */
  function selfTest() {
    var CV = function (t) { return Math.round(10 * Math.pow(3.5, t - 1)); };
    var PASS = 0, FAIL = 0, failures = [];
    function check(name, cond) {
      if (cond) { PASS++; console.log('  ok   ' + name); }
      else { FAIL++; failures.push(name); console.log('  FAIL ' + name); }
    }
    function mulberry32(seed) { // seeded rng -> deterministic tests
      var a = seed >>> 0;
      return function () {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    function allUnique(arr) {
      for (var i = 0; i < arr.length; i++) {
        if (arr.indexOf(arr[i]) !== arr.lastIndexOf(arr[i])) return false;
      }
      return true;
    }

    console.log('DP.Board self-test');

    /* create */
    var b0 = DP.Board.create(5);
    check('create: {size:5, 25 null cells, nextId:1}',
      b0.size === 5 && b0.cells.length === 25 && b0.nextId === 1 &&
      b0.cells.every(function (c) { return c === null; }));
    check('create: clamps invalid size',
      DP.Board.create(0).size >= 1 && DP.Board.create('x').size >= 1);

    /* spawn: empty cells, tier bounds, low-end weighting, ids */
    var big = DP.Board.create(25); // 625 cells: never fills within 500 spawns
    var rngA = mulberry32(1234), LO = 2, HI = 5, seen = {}, okCells = true, okRange = true;
    for (var s = 0; s < 500; s++) {
      var sp = DP.Board.spawn(big, LO, HI, rngA);
      if (!sp || !big.cells[sp.idx] || big.cells[sp.idx].tier !== sp.tier ||
          big.cells[sp.idx].lucky !== sp.lucky) okCells = false;
      if (sp && (sp.tier < LO || sp.tier > HI)) okRange = false;
      if (sp) seen[sp.tier] = (seen[sp.tier] || 0) + 1;
    }
    check('spawn: 500 spawns land on empty cells, cell data matches result', okCells);
    check('spawn: tier always within [' + LO + ',' + HI + ']', okRange);
    check('spawn: every tier in range occurs',
      seen[LO] > 0 && seen[LO + 1] > 0 && seen[HI - 1] > 0 && seen[HI] > 0);
    check('spawn: weighted toward low end (tier ' + LO + ' most common)',
      seen[LO] > seen[LO + 1] && seen[LO + 1] > seen[HI]);
    check('spawn: ids strictly increasing, nextId tracks spawns',
      big.nextId === 501 && DP.Board.emptyCells(big) === 625 - 500);

    /* lucky ~ 5% (statistical: 2000 spawns, tolerance band 2%..8%) */
    var stat = DP.Board.create(50), rngB = mulberry32(777), luckyCount = 0, N = 2000;
    for (var q = 0; q < N; q++) {
      if (DP.Board.spawn(stat, 1, 3, rngB).lucky) luckyCount++;
    }
    var rate = luckyCount / N;
    check('lucky rate ~5% over 2000 spawns (got ' + (rate * 100).toFixed(2) + '%)',
      rate > 0.02 && rate < 0.08);

    /* pop */
    var pb = DP.Board.create(3);
    pb.cells[4] = { tier: 6, lucky: true, id: 99 };
    var popped = DP.Board.pop(pb, 4);
    check('pop: returns {tier, lucky} and clears the cell',
      popped && popped.tier === 6 && popped.lucky === true && pb.cells[4] === null);
    check('pop: empty cell -> null', DP.Board.pop(pb, 4) === null);
    check('pop: out-of-range / invalid -> null',
      DP.Board.pop(pb, 99) === null && DP.Board.pop(pb, -1) === null &&
      DP.Board.pop(pb, 1.5) === null);

    /* merge */
    var mb = DP.Board.create(3);
    mb.nextId = 10;
    mb.cells[0] = { tier: 3, lucky: false, id: 1 };
    mb.cells[1] = { tier: 3, lucky: false, id: 2 };
    mb.cells[2] = { tier: 4, lucky: false, id: 3 };
    check('merge: tier mismatch -> null', DP.Board.merge(mb, 0, 2) === null);
    check('merge: same index a===b -> null', DP.Board.merge(mb, 0, 0) === null);
    check('merge: empty cell involved -> null', DP.Board.merge(mb, 0, 8) === null);
    var mg = DP.Board.merge(mb, 0, 1);
    check('merge: result at target index b, a cleared, fresh id',
      mg && mg.tier === 4 && mb.cells[1].tier === 4 && mb.cells[1].id === 10 &&
      mb.cells[1].lucky === false && mb.cells[0] === null);
    mb.cells[5] = { tier: 25, lucky: false, id: 4 };
    mb.cells[6] = { tier: 25, lucky: false, id: 5 };
    check('merge: two tier-25 cubes -> null (ceiling)', DP.Board.merge(mb, 5, 6) === null);
    mb.cells[5] = { tier: 24, lucky: false, id: 4 };
    mb.cells[6] = { tier: 24, lucky: false, id: 5 };
    var top = DP.Board.merge(mb, 5, 6);
    check('merge: tier 24 + 24 -> 25 allowed',
      top && top.tier === 25 && mb.cells[6].tier === 25 && mb.cells[5] === null);

    /* totalValue / emptyCells */
    var vb = DP.Board.create(2);
    vb.cells[0] = { tier: 1, lucky: false, id: 1 };
    vb.cells[3] = { tier: 3, lucky: true, id: 2 };
    check('totalValue: canon coinValue sum (lucky does not boost idle)',
      DP.Board.totalValue(vb) === CV(1) + CV(3));
    check('emptyCells: counts holes', DP.Board.emptyCells(vb) === 2);

    /* chainTargets */
    var cb = DP.Board.create(4);
    for (var ci = 0; ci < 7; ci++) cb.cells[ci] = { tier: 1, lucky: false, id: 100 + ci };
    var t1 = DP.Board.chainTargets(cb, 3, mulberry32(42), 0);
    check('chainTargets: respects count, non-empty only, unique, source excluded',
      t1.length === 3 && t1.indexOf(0) === -1 && allUnique(t1) &&
      t1.every(function (ix) { return !!cb.cells[ix]; }));
    var t2 = DP.Board.chainTargets(cb, 99, mulberry32(43));
    check('chainTargets: caps at available cubes (no source given)',
      t2.length === 7 && allUnique(t2) && t2.indexOf(0) !== -1);
    var t3 = DP.Board.chainTargets(cb, 5, mulberry32(44), 0);
    check('chainTargets: source excluded when passed', t3.length === 5 && t3.indexOf(0) === -1);
    check('chainTargets: count 0 -> []', DP.Board.chainTargets(cb, 0, Math.random).length === 0);
    check('chainTargets: empty board -> []',
      DP.Board.chainTargets(DP.Board.create(3), 4, Math.random).length === 0);

    /* resize: cubes keep coordinates */
    var rb = DP.Board.create(5);
    var k1 = { tier: 2, lucky: true, id: 11 };  // (0,0) idx 0
    var k2 = { tier: 5, lucky: false, id: 12 };  // (2,1) idx 7
    var k3 = { tier: 7, lucky: false, id: 13 };  // (4,4) idx 24
    rb.cells[0] = k1; rb.cells[7] = k2; rb.cells[24] = k3;
    var valBefore = DP.Board.totalValue(rb);
    var rb7 = DP.Board.resize(rb, 7);
    check('resize: same board object, new size 7, 49 cells',
      rb7 === rb && rb7.size === 7 && rb7.cells.length === 49);
    check('resize: cubes keep (x,y) coords & object identity',
      rb7.cells[0] === k1 && rb7.cells[9] === k2 && rb7.cells[32] === k3 &&
      rb7.cells[9].tier === 5 && rb7.cells[0].lucky === true);
    check('resize: totalValue preserved on upsize', DP.Board.totalValue(rb7) === valBefore);
    check('resize: new cells start empty', DP.Board.emptyCells(rb7) === 49 - 3);
    rb7.cells[48] = { tier: 3, lucky: false, id: 14 }; // (6,6): outside 5x5
    var rb5 = DP.Board.resize(rb7, 5);
    check('resize: down-size keeps in-bounds cubes, drops out-of-bounds',
      rb5.size === 5 && rb5.cells.length === 25 && rb5.cells[0] === k1 &&
      rb5.cells[7] === k2 && rb5.cells[24] === k3 && DP.Board.emptyCells(rb5) === 22);

    /* full board */
    var fb = DP.Board.create(2);
    for (var fi = 0; fi < 4; fi++) fb.cells[fi] = { tier: 1, lucky: false, id: fi + 1 };
    check('full board: emptyCells === 0', DP.Board.emptyCells(fb) === 0);
    check('full board: spawn -> null', DP.Board.spawn(fb, 1, 3, Math.random) === null);
    DP.Board.pop(fb, 2);
    check('full board: after a pop, spawn succeeds and refills the hole',
      DP.Board.spawn(fb, 1, 3, Math.random) !== null && DP.Board.emptyCells(fb) === 0);

    console.log('');
    if (FAIL === 0) console.log('ALL TESTS PASSED (' + PASS + ' checks)');
    else {
      console.error(FAIL + ' TEST' + (FAIL > 1 ? 'S' : '') + ' FAILED');
      failures.forEach(function (n) { console.error('  - ' + n); });
      process.exit(1);
    }
  }

  /* Guard: run the self-test only when this file is the direct node target
     (argv[1] ends with .../board.js — not a require, not another main file). */
  function isDirectRun() {
    if (typeof process === 'undefined' || !process.argv) return false;
    return /(^|[\/\\])board\.js$/.test(String(process.argv[1] || ''));
  }
  if (isDirectRun()) {
    try { selfTest(); }
    catch (e) {
      console.error('SELF-TEST CRASHED: ' + ((e && e.stack) || e));
      process.exit(1);
    }
  }

})();
