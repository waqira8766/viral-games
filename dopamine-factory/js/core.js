/* ============================================================================
 * DOPAMINE FACTORY — js/core.js — DP.Core (pure economy)
 * Pure logic only: no DOM, no THREE, no event bus. Owns the coin/lifetime
 * ledger, combo chain, ascend (prestige), offline earnings, save round-trip
 * and number formatting.
 *
 * Combo model (canon): a pop within 2.0s of the previous increments
 * state.combo (chained pops); the first pop of a chain leaves it at 0, so a
 * lone pop pays ×1.0. Multiplier = 1 + 0.1 * min(combo, 20) (cap ×3.0).
 *   state.comboT     — countdown (s) of the combo window; comboTick(dt) decays
 *   state.comboLast  — timestamp of the last pop (when comboPop got one)
 *
 * Ascend (canon): unlocked at lifetime ≥ 1,000,000. Resets coins, lifetime,
 * upgrades, combo, spawn timer, maxTierReached. Discovery collection and
 * settings are permanent. Permanent multiplier = 1 + 0.5 * ascensions.
 *
 * maxTierReached = highest tier ever seen + 1, so the canon spawn range
 * [max(1, mTR-4), mTR-1] is valid from the first frame (fresh value 2 ⇒
 * spawns are tier 1).
 * ==========================================================================*/
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});

(function () {
  'use strict';

  // ------------------------------------------------------------ constants --
  var COMBO_WINDOW   = 2.0;                    // seconds between pops to chain
  var COMBO_CAP      = 20;                     // ladder caps at mult ×3.0
  var ASCEND_GATE    = 1000000;                // lifetime coins to unlock ascend
  var OFFLINE_CAP_MS = 8 * 60 * 60 * 1000;     // 8h max offline window
  var OFFLINE_RATE   = 0.5;                    // offline pays half rate
  var SAVE_VERSION   = 1;
  var SAVE_KEY       = 'dopamine_factory_v1';

  var NUM_FIELDS = ['coins', 'lifetime', 'ascensions', 'combo', 'comboT',
                    'comboLast', 'maxTierReached', 'spawnT', 'lastSeen'];
  var UPGRADE_IDS = ['tapPower', 'spawnRate', 'incomeMult',
                     'gridSize', 'luckyChance', 'chainPower'];
  var FMT_SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function hop(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ----------------------------------------------------------------- state --
  function newState() {
    return {
      coins: 0, lifetime: 0, ascensions: 0,
      combo: 0, comboT: 0, comboLast: 0,
      upgrades: { tapPower: 0, spawnRate: 0, incomeMult: 0,
                  gridSize: 0, luckyChance: 0, chainPower: 0 },
      maxTierReached: 2,             // highest tier seen + 1 (pebbles = tier 1)
      discovered: { 1: true },       // tier 1 is known from the start
      spawnT: 0,
      settings: { muted: false },
      lastSeen: 0
    };
  }

  // ---------------------------------------------------------------- ledger --
  function addCoins(state, n) {
    // Gains only. Negative/NaN amounts are ignored so lifetime stays an
    // honest "total earned"; spending must go through spendCoins.
    if (!isNum(n) || n <= 0) return state.coins;
    state.coins += n;
    state.lifetime += n;
    return state.coins;
  }

  function spendCoins(state, n) {
    if (!isNum(n) || n < 0 || state.coins < n) return false; // declines when short
    state.coins -= n;                // lifetime untouched (tracks earned, not net)
    return true;
  }

  // ------------------------------------------------------------------ combo --
  function comboMult(state) {
    return 1 + 0.1 * Math.min(state.combo || 0, COMBO_CAP);
  }

  // Seconds since the last pop, in the caller's clock scale (epoch-ms like
  // Date.now() is sniffed and normalized; anything smaller reads as seconds).
  function comboSince(state, now) {
    var last = state.comboLast;
    if (!isNum(last) || last === 0) return Infinity;   // never popped
    var d = now - last;
    if (d < 0) d = 0;                                  // clock jumped backwards
    return (Math.abs(now) >= 1e11) ? d / 1000 : d;
  }

  function comboPop(state, now) {
    // Chain if the ticked window is still open (comboTick) or the caller's
    // timestamps say the previous pop was <= 2.0s ago. `now` is optional and
    // any monotonic clock works — only differences matter.
    var chained = (state.comboT || 0) > 0;
    if (!chained && isNum(now)) chained = comboSince(state, now) <= COMBO_WINDOW;
    state.combo  = chained ? (state.combo || 0) + 1 : 0;
    state.comboT = COMBO_WINDOW;                      // window (re)opens
    if (isNum(now)) state.comboLast = now;
    return comboMult(state);
  }

  function comboTick(state, dt) {
    if (isNum(dt) && dt > 0 && (state.comboT || 0) > 0) {
      state.comboT = Math.max(0, state.comboT - dt);
      if (state.comboT < 1e-9) { state.comboT = 0; state.combo = 0; } // expired
    }
    return state.combo;
  }

  // ----------------------------------------------------------------- ascend --
  function canAscend(state) { return (state.lifetime || 0) >= ASCEND_GATE; }

  // Projected permanent multiplier for n ascensions (canon: 1 + 0.5 * n).
  function ascensionMult(n) { return 1 + 0.5 * (n || 0); }

  function ascend(state) {
    if (!canAscend(state)) return ascensionMult(state.ascensions); // no-op
    state.ascensions += 1;
    state.coins = 0;
    state.lifetime = 0;                   // gate re-arms for the next run
    state.combo = 0; state.comboT = 0; state.comboLast = 0;
    state.spawnT = 0;
    state.maxTierReached = 2;             // fresh spawn range [1,1]
    for (var i = 0; i < UPGRADE_IDS.length; i++) state.upgrades[UPGRADE_IDS[i]] = 0;
    // discovered + settings are permanent (collection canon)
    return ascensionMult(state.ascensions);
  }

  // ---------------------------------------------------------------- offline --
  // incomePerSec: the live idle income (game.js passes it when it can).
  // Without it we estimate from state alone: one top-tier cube's income
  // (canon coinValue × 0.05 × income mult), via DP.Content when present.
  function estimateIncome(state) {
    var top = Math.max(1, (state.maxTierReached || 2) - 1);
    var value = Math.round(10 * Math.pow(3.5, top - 1));   // canon coinValue
    var C = (typeof DP !== 'undefined') ? DP.Content : null;
    if (C && typeof C.coinValue === 'function' && typeof C.incomeMult === 'function') {
      return Math.max(0, C.coinValue(top)) * 0.05 * Math.max(0, C.incomeMult(state));
    }
    var lvl = (state.upgrades && state.upgrades.incomeMult) || 0;
    var found = 0, k;
    for (k in state.discovered) if (state.discovered[k]) found++;
    return value * 0.05
      * (1 + 0.1 * lvl)
      * Math.pow(1.02, found)
      * ascensionMult(state.ascensions);
  }

  function offlineGain(state, nowMs, incomePerSec) {
    var last = state.lastSeen || 0;
    if (!last || !isNum(nowMs)) return 0;                 // no prior save / bad clock
    var elapsed = Math.min(Math.max(0, nowMs - last), OFFLINE_CAP_MS);
    var rate = (isNum(incomePerSec) && incomePerSec >= 0)
      ? incomePerSec : estimateIncome(state);
    return (elapsed / 1000) * rate * OFFLINE_RATE;        // ×0.5, capped 8h
  }

  // ------------------------------------------------------------------- save --
  function serialize(state) {
    var o = { v: SAVE_VERSION }, k;
    for (k in state) if (hop(state, k)) o[k] = state[k];
    return JSON.stringify(o);
  }

  function deserialize(str) {
    var s = newState(), o = null, k;
    if (typeof str === 'string') {
      try { o = JSON.parse(str); } catch (e) { return null; }
    } else if (str && typeof str === 'object') o = str;  // accept pre-parsed
    if (!o || typeof o !== 'object') return null;
    for (k = 0; k < NUM_FIELDS.length; k++) {            // numeric scalars
      var f = NUM_FIELDS[k];
      if (isNum(o[f])) s[f] = o[f];
    }
    if (o.upgrades && typeof o.upgrades === 'object') {  // upgrade levels
      for (k in o.upgrades) {
        if (isNum(o.upgrades[k]) && o.upgrades[k] >= 0) s.upgrades[k] = Math.floor(o.upgrades[k]);
      }
    }
    if (o.discovered && typeof o.discovered === 'object') { // collection flags
      for (k in o.discovered) if (o.discovered[k]) s.discovered[k] = true;
    }
    if (o.settings && typeof o.settings === 'object' && o.settings.muted) {
      s.settings.muted = true;
    }
    return s;
  }

  // -------------------------------------------------------------------- fmt --
  // 999 → "999", 1000 → "1K", 1500000 → "1.5M", 999999 → "1M" (rounds up a
  // unit), negatives keep their sign, non-finite → "0" / "∞".
  function fmt(n) {
    if (n === Infinity) return '∞';
    if (!isNum(n)) return '0';                           // NaN / junk / non-number
    var neg = n < 0 ? '-' : '';
    var v = Math.abs(n), t = 0, str;
    if (v < 1000) return neg + Math.floor(v);           // small: honest floor
    while (v >= 1000 && t < FMT_SUFFIX.length - 1) { v /= 1000; t++; }
    if (v >= 1000) {                                    // past the ladder: sci
      return neg + v.toExponential(2).replace('e+', 'e');
    }
    str = (v >= 100) ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
    if (t < FMT_SUFFIX.length - 1 && parseFloat(str) >= 1000) { str = '1'; t++; }
    return neg + str + FMT_SUFFIX[t];
  }

  // ---------------------------------------------------------------- exports --
  DP.Core = {
    newState: newState,
    addCoins: addCoins,
    spendCoins: spendCoins,
    comboMult: comboMult,
    comboPop: comboPop,
    comboTick: comboTick,
    canAscend: canAscend,
    ascensionMult: ascensionMult,
    ascend: ascend,
    offlineGain: offlineGain,
    serialize: serialize,
    deserialize: deserialize,
    fmt: fmt,
    COMBO_WINDOW: COMBO_WINDOW,
    ASCEND_GATE: ASCEND_GATE,
    OFFLINE_CAP_MS: OFFLINE_CAP_MS,
    SAVE_KEY: SAVE_KEY,
    SAVE_VERSION: SAVE_VERSION
  };

  /* ====================== SELF-TEST (node js/core.js) ==================== */
  if (typeof process !== 'undefined' && process.argv &&
      process.argv[1] && String(process.argv[1]).endsWith('core.js')) {
    (function () {
      var total = 0, fails = 0;
      function eq(name, got, want) {
        total++;
        if (got !== want) { fails++; console.log('FAIL ' + name + ': got ' + got + ' want ' + want); }
      }
      function ok(name, cond) {
        total++;
        if (!cond) { fails++; console.log('FAIL ' + name); }
      }
      function deepEq(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b || a === null || b === null ||
            typeof a !== 'object') return false;
        var ka = Object.keys(a).sort(), kb = Object.keys(b).sort(), i;
        if (ka.length !== kb.length) return false;
        for (i = 0; i < ka.length; i++) {
          if (ka[i] !== kb[i] || !deepEq(a[ka[i]], b[kb[i]])) return false;
        }
        return true;
      }
      var C = DP.Core;

      // -- combo ladder, decay, cap ------------------------------------------
      var s = C.newState();
      eq('first pop mult 1.0', C.comboPop(s), 1.0);
      C.comboTick(s, 0.5); eq('chained pop 1.1', C.comboPop(s), 1.1);
      C.comboTick(s, 1.9); ok('window still open', s.comboT > 0);
      eq('chained pop 1.2', C.comboPop(s), 1.2);
      C.comboTick(s, 2.1); eq('combo decayed', s.combo, 0);
      eq('fresh pop after decay', C.comboPop(s), 1.0);
      for (var i = 0; i < 30; i++) { C.comboPop(s); C.comboTick(s, 0.1); }
      eq('combo counts all continuations', s.combo, 30);
      eq('mult cap 3.0', C.comboMult(s), 3.0);
      var t2 = C.newState();                                  // timestamp mode
      C.comboPop(t2, 100);
      eq('timestamp chain', C.comboPop(t2, 101.5), 1.1);
      C.comboTick(t2, 2.5);                                   // window closes
      eq('chain broken', C.comboPop(t2, 200), 1.0);
      var t3 = C.newState();                                  // epoch-ms clock
      C.comboPop(t3, 1.77e12);
      eq('ms-clock chain', C.comboPop(t3, 1.77e12 + 500), 1.1);

      // -- ledger & spend ----------------------------------------------------
      var s2 = C.newState();
      eq('addCoins returns total', C.addCoins(s2, 40), 40);
      C.addCoins(s2, 60);
      eq('lifetime tracks earned', s2.lifetime, 100);
      eq('addCoins ignores junk', C.addCoins(s2, NaN), 100);
      eq('spend succeeds', C.spendCoins(s2, 60), true);
      eq('coins after spend', s2.coins, 40);
      eq('spend declines when short', C.spendCoins(s2, 41), false);
      eq('coins unchanged on decline', s2.coins, 40);
      eq('lifetime survives spend', s2.lifetime, 100);
      eq('spend exact drains', C.spendCoins(s2, 40), true);
      eq('spend on empty declines', C.spendCoins(s2, 1), false);
      eq('spend NaN declines', C.spendCoins(s2, NaN), false);

      // -- ascend gate & reset -----------------------------------------------
      var s3 = C.newState();
      C.addCoins(s3, 999999);
      eq('canAscend below gate', C.canAscend(s3), false);
      C.addCoins(s3, 1);
      eq('canAscend at gate', C.canAscend(s3), true);
      s3.upgrades.tapPower = 3; s3.combo = 5; s3.discovered[7] = true;
      s3.settings.muted = true; s3.spawnT = 1.25;
      eq('ascend returns new mult', C.ascend(s3), 1.5);
      eq('ascensions incremented', s3.ascensions, 1);
      eq('coins reset', s3.coins, 0);
      eq('lifetime reset (gate re-arms)', s3.lifetime, 0);
      eq('upgrades reset', s3.upgrades.tapPower, 0);
      eq('combo reset', s3.combo, 0);
      eq('discovery permanent', s3.discovered[7], true);
      eq('settings permanent', s3.settings.muted, true);
      eq('locked ascend no-op', C.ascend(s3), 1.5);
      C.addCoins(s3, 1000000);
      eq('second ascend mult', C.ascend(s3), 2.0);

      // -- offline: ×0.5 rate, 8h cap ---------------------------------------
      var s4 = C.newState();
      s4.lastSeen = 1000000;
      eq('offline half rate', C.offlineGain(s4, 1000000 + 3600000, 10), 3600 * 10 * 0.5);
      eq('offline capped at 8h', C.offlineGain(s4, 1000000 + 10 * 3600000, 10), 8 * 3600 * 10 * 0.5);
      eq('offline zero income', C.offlineGain(s4, 1000000 + 60000, 0), 0);
      eq('offline without lastSeen', C.offlineGain(C.newState(), 9e15, 10), 0);
      eq('offline clock skew', C.offlineGain(s4, 500000, 10), 0);
      var est = C.offlineGain(s4, 1000000 + 1000, undefined);   // estimate mode
      ok('offline estimate finite', isNum(est) && est >= 0);

      // -- serialize round-trip ---------------------------------------------
      var s5 = C.newState();
      s5.coins = 12345.6; s5.lifetime = 999999.5; s5.ascensions = 2;
      s5.combo = 7; s5.comboT = 1.25; s5.comboLast = 1234567.8;
      s5.upgrades.tapPower = 4; s5.upgrades.gridSize = 1;
      s5.maxTierReached = 9; s5.spawnT = 0.7;
      s5.discovered[5] = true; s5.discovered[12] = true;
      s5.settings.muted = true; s5.lastSeen = 1700000000000;
      var str = C.serialize(s5), back = C.deserialize(str);
      ok('round-trip deep equality', deepEq(back, s5));
      ok('payload versioned v:1', JSON.parse(str).v === 1);
      ok('save key', C.SAVE_KEY === 'dopamine_factory_v1');
      eq('corrupt save returns null', C.deserialize('not json{{{'), null);
      eq('null save returns null', C.deserialize(null), null);
      var partial = C.deserialize('{"v":1,"coins":5,"discovered":{"9":true}}');
      eq('partial save coins', partial.coins, 5);
      eq('partial save discovery', partial.discovered[9], true);
      ok('partial save defaults', partial.ascensions === 0 && partial.settings.muted === false);

      // -- fmt ---------------------------------------------------------------
      eq('fmt 0', C.fmt(0), '0');
      eq('fmt 999', C.fmt(999), '999');
      eq('fmt 1000', C.fmt(1000), '1K');
      eq('fmt 1234', C.fmt(1234), '1.2K');
      eq('fmt 1.5e6', C.fmt(1500000), '1.5M');
      eq('fmt 2.3e12', C.fmt(2.3e12), '2.3T');
      eq('fmt rounds up a unit', C.fmt(999999), '1M');
      eq('fmt negative', C.fmt(-1500), '-1.5K');
      eq('fmt junk', C.fmt('x'), '0');
      eq('fmt infinity', C.fmt(Infinity), '∞');
      eq('fmt big', C.fmt(12345678), '12.3M');

      if (fails > 0) { console.log(fails + '/' + total + ' TESTS FAILED'); process.exit(1); }
      console.log('ALL TESTS PASSED (' + total + ' tests)');
    })();
  }
})();
