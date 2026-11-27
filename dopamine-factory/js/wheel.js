var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
/* DOPAMINE FACTORY — js/wheel.js — DP.Wheel: pure bonus-wheel state machine.
 * One free spin per 60s. 8 weighted canon sectors: coin shower 15% + coin
 * storm 25% (40% coins), income x2 30s 15%, lucky rain (next 5 spawns lucky)
 * 12%, ONE pair merge-up 10%, quest reroll 8%, JACKPOT 5% (120s of income via
 * the caller's incomeFn), dud "SO CLOSE!" 10% — an engineered near-miss: the
 * dud slot sits immediately next to JACKPOT, so the pointer visibly stops one
 * step short; the result carries nearMiss=true + landIndex (the adjacent slot)
 * + nearMissOf (the jackpot index) so the UI can rub it in.
 * Pure: no DOM, no audio, no three.js, no event bus. game.js applies effects
 * by result.id (coins -> addCoins; income_x2 -> x boostMult(wheel,now);
 * lucky_rain -> takeLucky(wheel) per spawn; merge_up -> ONE random same-tier
 * pair; quest_reroll -> DP.Quests.reroll). All chance flows from the rng
 * passed to spin() (DP.Wheel.rng = seeded mulberry32). node js/wheel.js */

DP.Wheel = (function () {
  'use strict';

  var COOLDOWN_MS = 60000; // canon: a free spin every 60s of play
  var BOOST_MS = 30000;   // income x2 boost duration
  var LUCKY_SPAWNS = 5;    // lucky rain: the next 5 spawns are lucky

  /* SECTORS doubles as the UI layout: array order = clockwise wheel order.
   * The dud deliberately sits right next to JACKPOT — locked by the self-test. */
  var SECTORS = [
    { id: 'coins_small',  label: 'COIN SHOWER',   emoji: '🪙', weight: 15, color: '#f0b429' },
    { id: 'lucky_rain',   label: 'LUCKY RAIN',    emoji: '🍀', weight: 12, color: '#4cc9f0' },
    { id: 'coins_medium', label: 'COIN STORM',    emoji: '💰', weight: 25, color: '#ffd60a' },
    { id: 'quest_reroll', label: 'QUEST REROLL',  emoji: '🎲', weight: 8,  color: '#7209b7' },
    { id: 'income_x2',    label: 'INCOME x2 30s', emoji: '⚡', weight: 15, color: '#70e000' },
    { id: 'jackpot',      label: 'JACKPOT',       emoji: '💎', weight: 5,  color: '#ff477e' },
    { id: 'dud',          label: 'SO CLOSE!',     emoji: '😬', weight: 10, color: '#3d4a6d' },
    { id: 'merge_up',     label: 'MERGE UP',      emoji: '⬆️', weight: 10, color: '#f72585' }
  ];
  var JACKPOT_INDEX = 5, DUD_INDEX = 6; // dud = jackpot's clockwise neighbor

  function newState() { // lastSpin starts negative: the very first spin is free
    return { now: 0, lastSpin: -COOLDOWN_MS, spins: 0, boostUntil: 0, luckyRain: 0, lastResult: null };
  }

  function canSpin(state, nowMs) {
    if (typeof nowMs !== 'number' || !isFinite(nowMs)) nowMs = state.now;
    return nowMs - state.lastSpin >= COOLDOWN_MS;
  }

  /* tick(state, nowMs) -> ms until the next free spin (0 = ready). UI countdown. */
  function tick(state, nowMs) {
    if (typeof nowMs !== 'number' || !isFinite(nowMs)) nowMs = state.now;
    state.now = nowMs;
    return Math.max(0, COOLDOWN_MS - (nowMs - state.lastSpin));
  }

  function pickSector(rng) { // weighted draw over the 8 canon sectors
    var r = rng() * 100, acc = 0;
    for (var i = 0; i < SECTORS.length; i++) { acc += SECTORS[i].weight; if (r < acc) return i; }
    return SECTORS.length - 1; // unreachable (rng() < 1); safe fallback
  }

  /* spin(state, rng[, incomeFn][, nowMs]) -> result | null (null = on cooldown).
   * incomeFn() returns current coins/sec; jackpot pays 120s of it, coin sectors
   * scale off it (25s / 50s, early-game minimums) so the wheel stays worth
   * spinning forever. The cooldown gates BEFORE any rng draw, so a refused
   * spin is a pure no-op. */
  function spin(state, rng, incomeFn, nowMs) {
    if (typeof rng !== 'function') rng = Math.random;
    if (typeof incomeFn === 'number') { nowMs = incomeFn; incomeFn = null; }
    if (typeof nowMs !== 'number' || !isFinite(nowMs)) nowMs = state.now;
    if (!canSpin(state, nowMs)) return null;
    var income = (typeof incomeFn === 'function') ? Number(incomeFn()) : 0;
    if (!isFinite(income) || income < 0) income = 0;

    var idx = pickSector(rng), s = SECTORS[idx];
    state.lastSpin = nowMs;
    state.spins++;
    var res = {
      sector: idx, landIndex: idx,      // index into SECTORS / slot the pointer stops on
      id: s.id, label: s.label, emoji: s.emoji, color: s.color,
      coins: 0, boostMs: 0, luckySpawns: 0,
      nearMiss: false, nearMissOf: -1, // dud only: true + the JACKPOT it lands beside
      revealMs: 3600 + Math.floor(rng() * 901), spin: state.spins // 3.6-4.5s animation
    };
    if (s.id === 'coins_small') res.coins = Math.max(50, Math.round(income * 25));        // 25s of income
    else if (s.id === 'coins_medium') res.coins = Math.max(150, Math.round(income * 50)); // 50s of income
    else if (s.id === 'jackpot') res.coins = Math.max(1000, Math.round(income * 120));    // canon: 120s of income
    else if (s.id === 'income_x2') { res.boostMs = BOOST_MS; state.boostUntil = Math.max(state.boostUntil, nowMs + BOOST_MS); }
    else if (s.id === 'lucky_rain') { res.luckySpawns = LUCKY_SPAWNS; state.luckyRain = LUCKY_SPAWNS; } // fresh shower, no stacking
    else if (s.id === 'dud') { // the whole point: stop ONE slot from JACKPOT
      res.nearMiss = true;
      res.nearMissOf = JACKPOT_INDEX;
      res.landIndex = DUD_INDEX;
      res.revealMs += 500; // let the tease linger a beat longer
    }
    state.lastResult = res;
    return res;
  }

  /* Income multiplier granted by the wheel (x2 while a boost is live). */
  function boostMult(state, nowMs) {
    if (typeof nowMs !== 'number' || !isFinite(nowMs)) nowMs = state.now;
    return nowMs < state.boostUntil ? 2 : 1;
  }

  /* game.js calls this once per spawn: true while the lucky rain lasts. */
  function takeLucky(state) {
    if (state.luckyRain > 0) { state.luckyRain--; return true; }
    return false;
  }

  function rng(seed) { // seeded mulberry32 — pass to spin() for deterministic wheels
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return { SECTORS: SECTORS, COOLDOWN_MS: COOLDOWN_MS, JACKPOT_INDEX: JACKPOT_INDEX,
    DUD_INDEX: DUD_INDEX, newState: newState, canSpin: canSpin, spin: spin, tick: tick,
    boostMult: boostMult, takeLucky: takeLucky, rng: rng };
})();

/* ---- node self-test ------------------------------------------------------ */
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].endsWith('wheel.js')) {
  (function () {
    var W = DP.Wheel, failures = 0, total = 0;
    function check(desc, cond) {
      total++;
      if (cond) console.log('PASS ' + desc);
      else { failures++; console.log('FAIL: ' + desc); }
    }
    /* deterministic seed search: first seed (1..20000) whose spin lands on id */
    function findSpin(id, incomeFn, atMs) {
      for (var seed = 1; seed <= 20000; seed++) {
        var st = W.newState();
        var r = W.spin(st, W.rng(seed), incomeFn || null, atMs || 0);
        if (r && r.id === id) return { st: st, res: r, seed: seed };
      }
      return null;
    }
    var canon = { coins_small: 15, lucky_rain: 12, coins_medium: 25, quest_reroll: 8,
                  income_x2: 15, jackpot: 5, dud: 10, merge_up: 10 };
    var wOf = {}, sum = 0, shapeOk = true, canonOk = true;
    W.SECTORS.forEach(function (s) {
      sum += s.weight; wOf[s.id] = s.weight;
      if (!s.id || !s.label || !s.emoji || typeof s.weight !== 'number' ||
          !/^#[0-9a-f]{6}$/i.test(s.color || '')) shapeOk = false;
      if (canon[s.id] !== s.weight) canonOk = false;
    });
    check('8 sectors exported with id/label/emoji/weight/color, weights sum to exactly 100',
      W.SECTORS.length === 8 && shapeOk && sum === 100);
    check('per-sector weights match canon exactly (coins total 40%)',
      canonOk && wOf.coins_small + wOf.coins_medium === 40);
    check('dud slot sits immediately adjacent to JACKPOT on the wheel',
      (W.DUD_INDEX + 1) % 8 === W.JACKPOT_INDEX || (W.DUD_INDEX + 7) % 8 === W.JACKPOT_INDEX);
    var st = W.newState();
    var first = W.spin(st, W.rng(11), null, 0);
    check('fresh wheel spins immediately, returns a result (spin 1)',
      W.canSpin(W.newState(), 0) === true && !!first && typeof first.sector === 'number' && first.spin === 1);
    check('cooldown blocks from +1ms through +59,999ms',
      W.canSpin(st, 1) === false && W.canSpin(st, 59999) === false);
    check('cooldown releases exactly at +60,000ms', W.canSpin(st, 60000) === true);
    var frozen = st.spins + ':' + st.lastSpin;
    check('spin during cooldown returns null and leaves state untouched',
      W.spin(st, W.rng(12), null, 30000) === null && st.spins + ':' + st.lastSpin === frozen);
    var N = 10000, counts = {}, nm = 0, iffOk = true, adjOk = true, revealOk = true;
    var dist = W.newState(), g = W.rng(0xC0FFEE);
    W.SECTORS.forEach(function (s) { counts[s.id] = 0; });
    for (var i = 0; i < N; i++) {
      var r = W.spin(dist, g, null, i * W.COOLDOWN_MS);
      if (!r) { revealOk = false; break; }
      counts[r.id]++;
      if (r.nearMiss !== (r.id === 'dud')) iffOk = false;
      if (r.nearMiss) {
        nm++;
        if ((r.landIndex + 1) % 8 !== W.JACKPOT_INDEX && (r.landIndex + 7) % 8 !== W.JACKPOT_INDEX) adjOk = false;
        if (r.nearMissOf !== W.JACKPOT_INDEX) adjOk = false;
        if (r.revealMs < 4100 || r.revealMs > 5000) revealOk = false; // dud lingers
      } else if (r.revealMs < 3600 || r.revealMs > 4500) revealOk = false;
    }
    var distOk = true, buckets = [];
    W.SECTORS.forEach(function (s) {
      var pct = 100 * counts[s.id] / N;
      buckets.push(s.id + ' ' + pct.toFixed(2) + '%/' + s.weight + '%');
      if (Math.abs(pct - s.weight) > 2) distOk = false;
    });
    check('10k seeded spins all legal (one cooldown apart), revealMs sane', revealOk);
    check('distribution within +/-2% per bucket over 10k spins [' + buckets.join(' ') + ']', distOk);
    check('near-miss occurs iff dud, always adjacent to JACKPOT', iffOk && adjOk);
    check('near-miss rate is exactly 10% by canon dud weight, ~10% empirically (' + nm + '/10000)',
      W.SECTORS[W.DUD_INDEX].weight === 10 && nm >= 800 && nm <= 1200);
    var jack = findSpin('jackpot', function () { return 10; }, 0);
    check('seeded jackpot found via incomeFn; pays round(income x 120): 10/sec -> 1200 coins',
      !!jack && jack.res.coins === 1200);
    var j2 = W.spin(W.newState(), W.rng(jack ? jack.seed : 1), function () { return 123.456; }, 0);
    check('jackpot scales with incomeFn: 123.456/sec -> 14815',
      !!jack && j2.id === 'jackpot' && j2.coins === Math.round(123.456 * 120));
    var j3 = W.spin(W.newState(), W.rng(jack ? jack.seed : 1), null, 0);
    check('jackpot without income data still pays a 1000-coin minimum',
      !!jack && j3.id === 'jackpot' && j3.coins === 1000);
    var med = findSpin('coins_medium', function () { return 10; }, 0);
    var small = findSpin('coins_small', function () { return 10; }, 0);
    var med0 = W.spin(W.newState(), W.rng(med ? med.seed : 1), null, 0);
    var small0 = W.spin(W.newState(), W.rng(small ? small.seed : 1), null, 0);
    check('coin sectors: 25s/50s of income (250/500 at 10 per sec), minimums 50/150',
      !!med && med.res.coins === 500 && !!small && small.res.coins === 250 &&
      med0.id === 'coins_medium' && med0.coins === 150 &&
      small0.id === 'coins_small' && small0.coins === 50);
    var boost = findSpin('income_x2', null, 1000);
    check('income x2: exactly 30s (boostUntil=31000), boostMult 2 during, 1 at expiry',
      !!boost && boost.res.boostMs === 30000 && boost.st.boostUntil === 31000 &&
      W.boostMult(boost.st, 1000) === 2 && W.boostMult(boost.st, 30999) === 2 &&
      W.boostMult(boost.st, 31000) === 1);
    var lucky = findSpin('lucky_rain', null, 0);
    var drains = [];
    for (var k = 0; k < 6; k++) drains.push(W.takeLucky(lucky ? lucky.st : W.newState()));
    check('lucky rain makes exactly the next 5 spawns lucky',
      !!lucky && lucky.res.luckySpawns === 5 && lucky.st.luckyRain === 0 &&
      drains.join(' ') === 'true true true true true false');
    var t = W.newState();
    W.spin(t, W.rng(99), null, 0);
    var t2 = W.newState();
    W.tick(t2, 12345);
    check('tick advances cooldown: 50000/30000/1 remaining -> 0 at 60s (canSpin agrees), clamps at 0, syncs state.now',
      W.tick(t, 10000) === 50000 && W.tick(t, 30000) === 30000 && W.tick(t, 59999) === 1 &&
      W.tick(t, 60000) === 0 && W.canSpin(t, 60000) === true && W.tick(t, 999999) === 0 &&
      W.canSpin(t2) === true);
    function seq(seed) {
      var s = W.newState(), gg = W.rng(seed), out = [];
      for (var q = 0; q < 50; q++) {
        var r = W.spin(s, gg, function () { return 7.5; }, q * W.COOLDOWN_MS);
        out.push(r.sector + ':' + r.revealMs + ':' + r.coins);
      }
      return out.join('|');
    }
    check('deterministic: same seed replays an identical 50-spin sequence, different seeds diverge',
      seq(77) === seq(77) && seq(77) !== seq(78));

    if (failures === 0) console.log('ALL TESTS PASSED');
    else {
      console.log('FAIL: ' + failures + ' of ' + total + ' checks failed');
      process.exit(1);
    }
  })();
}
