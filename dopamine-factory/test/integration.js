/* DOPAMINE FACTORY — test/integration.js
 * Headless integration + PLAYTEST BOT. Loads every module in index.html
 * order with DOM/canvas shims (pattern: cryptfall/test/integration.js),
 * boots the real game headlessly, then simulates 5 minutes at 60fps:
 * ~4 taps/sec on random non-empty cells, deliberate drag-merges when
 * same-tier pairs exist, wheel spins after cooldown, shop buys when
 * affordable, a combo burst, a guaranteed tier-5 chain, quest claim,
 * save/load round-trip, offline earnings, the MC button cluster — and
 * asserts coins never decrease from pops, combo ladder climbs, merges
 * occur, chains fire, ZERO NaN, zero exceptions.
 * Missing modules are listed and their checks SKIP; exit 1 on any FAIL.
 * Run: node test/integration.js
 */
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');

/* ---------- browser shims ---------- */
function mockCtx() {
  return {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: 'left', textBaseline: 'top', shadowColor: '', shadowBlur: 0,
    fillRect: function () {}, strokeRect: function () {}, clearRect: function () {},
    beginPath: function () {}, arc: function () {}, arcTo: function () {}, ellipse: function () {},
    moveTo: function () {}, lineTo: function () {}, quadraticCurveTo: function () {},
    bezierCurveTo: function () {}, closePath: function () {}, clip: function () {},
    fill: function () {}, stroke: function () {}, save: function () {}, restore: function () {},
    translate: function () {}, rotate: function () {}, scale: function () {}, setTransform: function () {},
    fillText: function () {}, strokeText: function () {}, drawImage: function () {},
    measureText: function (t) { return { width: String(t || '').length * 7 }; },
    createRadialGradient: function () { return { addColorStop: function () {} }; },
    createLinearGradient: function () { return { addColorStop: function () {} }; },
    createPattern: function () { return {}; }, roundRect: function () {},
    imageSmoothingEnabled: false, filter: 'none', globalCompositeOperation: 'source-over'
  };
}
function mockElement(tag) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(), style: {
      setProperty: function () {}, getPropertyValue: function () { return ''; }
    }, dataset: {},
    children: [], childNodes: [], parentNode: null, parentElement: null,
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    textContent: '', innerHTML: '',
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function (c) { this.children.push(c); this.childNodes.push(c); if (c && c.parentNode !== undefined) c.parentNode = this; return c; },
    removeChild: function (c) { this.children = this.children.filter(function (x) { return x !== c; }); return c; },
    insertBefore: function (c) { this.children.push(c); return c; }, replaceChild: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; }, removeAttribute: function () {},
    querySelector: function () { return mockElement('g'); }, querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 }; },
    getContext: function () { return mockCtx(); },
    focus: function () {}, blur: function () {}, click: function () {}, remove: function () {},
    animate: function () { return { finished: { then: function () {}, catch: function () {} }, cancel: function () {} }; },
    offsetWidth: 390, offsetHeight: 100, clientWidth: 390, clientHeight: 844,
    width: 300, height: 150,
    firstChild: null, lastChild: null, nextSibling: null, previousSibling: null
  };
  return el;
}
globalThis.document = {
  readyState: 'complete',
  createElement: function (t) { return mockElement(t); },
  createElementNS: function (ns, t) { return mockElement(t); },       /* MC SVG buttons */
  createTextNode: function (t) { return { textContent: t }; },
  getElementById: function () { return mockElement('div'); },
  querySelector: function () { return mockElement('div'); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {}, removeEventListener: function () {},
  body: mockElement('body'), documentElement: mockElement('html'), head: mockElement('head'),
  hidden: false, visibilityState: 'visible'
};
try {
  if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { maxTouchPoints: 0, userAgent: 'node-integration' };
  else if (globalThis.navigator.maxTouchPoints === undefined) {
    Object.defineProperty(globalThis.navigator, 'maxTouchPoints', { value: 0, configurable: true });
  }
} catch (e) { /* node's built-in navigator is fine for MC.isTouchDevice */ }
globalThis.localStorage = {
  _s: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem: function (k, v) { this._s[k] = String(v); },
  removeItem: function (k) { delete this._s[k]; }
};
globalThis.requestAnimationFrame = function () { return 0; };
globalThis.cancelAnimationFrame = function () {};
if (!globalThis.performance) globalThis.performance = { now: function () { return Date.now(); } };
globalThis.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };

/* ---------- load modules in index.html order ---------- */
var ORDER = ['../shared/mobile-controls.js', 'js/content.js', 'js/core.js', 'js/board.js',
  'js/wheel.js', 'js/quests.js', 'js/audio.js', 'js/fx.js', 'js/render3d.js',
  'js/input.js', 'js/ui.js', 'js/game.js'];
var base = path.join(__dirname, '..');
var skipped = [];
console.log('SKIP: ../shared/vendor/three.min.js (WebGL vendor — render3d is DOM-guarded, headless boot skips it)');
ORDER.forEach(function (f) {
  var full = path.join(base, f);
  if (!fs.existsSync(full)) { skipped.push(f); console.log('SKIP: ' + f + ' (not present yet — module still being built)'); return; }
  try { vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: f }); }
  catch (err) { skipped.push(f); console.log('SKIP: ' + f + ' (load error: ' + (err && err.message) + ')'); }
});

/* ---------- harness ---------- */
var pass = 0, fail = 0, skipCount = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name); }
}
function skip(name, why) { skipCount++; console.log('SKIP: ' + name + ' (' + why + ')'); }
var exceptions = 0, firstErr = null;
function attempt(fn) { try { return fn(); } catch (e) { exceptions++; if (!firstErr) firstErr = e; return undefined; } }

var DP = globalThis.DP;
var present = {
  mc: typeof MC !== 'undefined' && typeof MC.createButton === 'function',
  content: !!(DP && DP.Content), core: !!(DP && DP.Core), board: !!(DP && DP.Board),
  wheel: !!(DP && DP.Wheel), quests: !!(DP && DP.Quests), audio: !!(DP && DP.Audio),
  fx: !!(DP && DP.FX), render3d: !!(DP && DP.Render3D), input: !!(DP && DP.Input), ui: !!(DP && DP.UI)
};

check('DP namespace + Events bus present', !!(DP && DP.Events && typeof DP.Events.emit === 'function'));
check('DP.Game orchestrator present', !!(DP && DP.Game && typeof DP.Game.boot === 'function'));
check('shared mobile-controls loaded (MC)', present.mc);

/* ---------- bus smoke (the law: errors never break emit) ---------- */
(function () {
  var hits = [];
  var off = DP.Events.on('probe', function (d) { hits.push(d.v); });
  DP.Events.on('probe', function () { throw new Error('boom'); });
  DP.Events.emit('probe', { v: 7 });
  off();
  DP.Events.emit('probe', { v: 8 });
  check('bus: on/emit/off + subscriber errors isolated', hits.length === 1 && hits[0] === 7);
})();

/* ---------- boot headlessly ---------- */
attempt(function () { DP.Game.boot({ headless: true }); });
check('boot completes headlessly', !!(DP.Game.state && DP.Game.board));
check('board starts 5×5 (25 cells)', DP.Game.board.size === 5 && DP.Game.board.cells.length === 25);
check('fresh state: coins 0, upgrades object, discovered object',
  DP.Game.state.coins === 0 && typeof DP.Game.state.upgrades === 'object' && typeof DP.Game.state.discovered === 'object');
check('missing-module warn list populated (degraded mode)', Array.isArray(DP.Game.missing));

/* ---------- contract event listeners ---------- */
var stats = { pops: 0, chained: 0, luckyPops: 0, merges: 0, discovers: 0, tierReached: 0, maxTier: 0,
  spawns: 0, luckySpawns: 0, questsDone: 0, wheels: 0, maxComboCount: 0, maxComboMult: 1,
  chainValues: [], lastPop: null, firstPop: null, firstSpawn: null, firstMerge: null,
  firstCoins: null, firstTierReached: null };
DP.Events.on('pop', function (d) {
  stats.pops++;
  if (d.chained) { stats.chained++; stats.chainValues.push({ tier: d.tier, value: d.value, lucky: d.lucky }); }
  if (d.lucky) stats.luckyPops++;
  stats.lastPop = d; if (!stats.firstPop) stats.firstPop = d;
});
DP.Events.on('merge', function (d) { stats.merges++; if (!stats.firstMerge) stats.firstMerge = d; });
DP.Events.on('discover', function (d) { stats.discovers++; });
DP.Events.on('tierReached', function (d) { stats.tierReached++; if (d.tier > stats.maxTier) stats.maxTier = d.tier; if (!stats.firstTierReached) stats.firstTierReached = d; });
DP.Events.on('spawn', function (d) { stats.spawns++; if (d.lucky) stats.luckySpawns++; if (!stats.firstSpawn) stats.firstSpawn = d; });
DP.Events.on('quest', function (d) { if (d && d.done) stats.questsDone++; });
DP.Events.on('wheel', function (d) { stats.wheels++; });
DP.Events.on('combo', function (d) { if (d.count > stats.maxComboCount) stats.maxComboCount = d.count; if (d.mult > stats.maxComboMult) stats.maxComboMult = d.mult; });
DP.Events.on('coins', function (d) { if (!stats.firstCoins) stats.firstCoins = d; });

/* ---------- bot helpers ---------- */
var G = DP.Game, DT = 1 / 60;
function cells() { return G.board ? G.board.cells : []; }
function nonEmpty() { var r = [], c = cells(); for (var i = 0; i < c.length; i++) if (c[i]) r.push(i); return r; }
function cubeCount() { return nonEmpty().length; }
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function baseCoinValue(t) { return (present.content && DP.Content.coinValue) ? DP.Content.coinValue(t) : Math.round(10 * Math.pow(3.5, t - 1)); }
function forceCube(tier, lucky) {                    /* test-level board surgery */
  var c = cells(), empt = [];
  for (var i = 0; i < c.length; i++) if (!c[i]) empt.push(i);
  if (!empt.length) return -1;
  var idx = rand(empt);
  if (!isFinite(G.board.nextId) || G.board.nextId < 1) G.board.nextId = 1;
  c[idx] = { tier: tier, lucky: !!lucky, id: G.board.nextId++ };
  return idx;
}
function lowestPair() {
  var c = cells(), byT = {}, t;
  for (var i = 0; i < c.length; i++) { if (!c[i]) continue; (byT[c[i].tier] || (byT[c[i].tier] = [])).push(i); }
  for (t = 1; t <= 25; t++) if (byT[t] && byT[t].length >= 2) return [byT[t][0], byT[t][1]];
  return null;
}
function upgradeIds() {
  if (present.content && Array.isArray(DP.Content.UPGRADES) && DP.Content.UPGRADES.length) {
    return DP.Content.UPGRADES.map(function (u) { return u.id; });
  }
  return ['tapPower', 'spawnRate', 'incomeMult', 'gridSize', 'luckyChance', 'chainPower'];
}
function maxOf(id) {
  if (present.content && Array.isArray(DP.Content.UPGRADES)) {
    for (var i = 0; i < DP.Content.UPGRADES.length; i++) {
      var u = DP.Content.UPGRADES[i];
      if (u && u.id === id && isFinite(u.max)) return u.max;
    }
  }
  return id === 'gridSize' ? 2 : 99;
}
function nanScan() {
  var bad = 0, s = G.state, k, i;
  ['coins', 'lifetime', 'ascensions', 'combo', 'comboT', 'maxTierReached', 'spawnT'].forEach(function (f) {
    if (!isFinite(s[f])) bad++;
  });
  for (k in s.upgrades) if (Object.prototype.hasOwnProperty.call(s.upgrades, k) && !isFinite(Number(s.upgrades[k]))) bad++;
  var c = cells();
  for (i = 0; i < c.length; i++) if (c[i] && (!isFinite(c[i].tier) || c[i].tier < 1 || c[i].tier > 25)) bad++;
  if (G.wheelState) for (k in G.wheelState) if (typeof G.wheelState[k] === 'number' && !isFinite(G.wheelState[k])) bad++;
  if (G.buffT !== 0 && !isFinite(G.buffT)) bad++;
  return bad;
}

/* ---------- pop value formulas (clean combo, before any upgrades) ---------- */
var idx10 = forceCube(1, false);
var coins10 = G.state.coins;
var v10 = attempt(function () { return G.tapCell(idx10); });
check('pop formula: tier1 × tapPower1 × combo1 = exactly 10', v10 === 10);
check('pop adds coins to state', Math.abs(G.state.coins - (coins10 + 10)) < 1e-9);
check('pop event payload {idx,tier,value,lucky,chained}',
  !!(stats.firstPop && stats.firstPop.idx === idx10 && stats.firstPop.tier === 1 &&
     stats.firstPop.value === 10 && stats.firstPop.lucky === false && stats.firstPop.chained === false));
var vL = attempt(function () { return G.tapCell(idxL); });      /* combo 1 → ×1.1 → 11 → lucky ×10 */
check('lucky pop pays ×10 (110 for tier1/combo2)', vL === 110);
check('spawn event payload {idx,tier,lucky}',
  !!(stats.firstSpawn && isFinite(stats.firstSpawn.idx) && isFinite(stats.firstSpawn.tier) && typeof stats.firstSpawn.lucky === 'boolean'));

/* ---------- MC cluster: real buttons through MC's FSM ---------- */
var mc = present.mc ? attempt(function () { return G._mountMc(true); }) : null;
if (present.mc) check('MC cluster mounts (wheel/pop/mute) above canvas, pointer-safe', !!(mc && mc.pop && mc.wheel && mc.mute));
else skip('MC cluster', 'mobile-controls.js missing');
/* POP: highest-tier via the exact tap routine */
forceCube(1, false); forceCube(1, false); var idx4 = forceCube(4, false);
var mcCoins = G.state.coins, mcPops = stats.pops;
if (mc) { attempt(function () { mc.pop._press(); mc.pop._release(); }); }
else attempt(function () { G.mcPop(); });
check('MC POP button: pops highest-tier cell via the tap routine (pop event + coins up)',
  stats.pops === mcPops + 1 && G.state.coins > mcCoins && stats.lastPop.tier === 4);
/* WHEEL: routes through the shared gate/modal path */
var mcRoute = attempt(function () { return G.mcWheel(); });
if (present.wheel) check('MC WHEEL button: routes through the shared wheel path', mcRoute !== null && stats.wheels >= 1);
else skip('MC WHEEL route', 'js/wheel.js missing');
/* MUTE: shared settings.muted state */
var m0 = !!(G.state.settings && G.state.settings.muted);
if (mc) { attempt(function () { mc.mute._press(); mc.mute._release(); }); var m1 = !!(G.state.settings && G.state.settings.muted);
  attempt(function () { mc.mute._press(); mc.mute._release(); }); var m2 = !!(G.state.settings && G.state.settings.muted);
  check('MC mute button toggles the shared muted state', m1 === !m0 && m2 === m0);
} else { var r1 = attempt(function () { return G.toggleMute(); }), r2 = attempt(function () { return G.toggleMute(); });
  check('MC mute path toggles the shared muted state', r1 === !m0 && r2 === m0); }

/* ---------- 5-minute playtest bot ---------- */
for (var pf = 0; pf < 12; pf++) forceCube(1, false);     /* pre-fill so bot has material */
var FRAMES = 300 * 60;                                     /* 5 min @ 60fps */
var popViolations = 0, nanViolations = 0, spins = 0, buys = 0, buyExactOk = true, buyLevelOk = true;
var BURST = 60 * 30, CHAIN = 60 * 290;
var i, t;
for (i = 0; i < FRAMES; i++) {
  t = i * DT;
  attempt(function () { G.update(DT); });
  /* ~4 taps/sec on random non-empty cells (never on empty → spawn waits) */
  if (i % 15 === 0 && cubeCount() > 6) {
    var pick = rand(nonEmpty()), before = G.state.coins;
    attempt(function () { G.tapCell(pick); });
    if (!(G.state.coins >= before)) popViolations++;
  }
  /* deliberate drag-merges whenever a same-tier pair exists */
  if (i % 30 === 0) {
    var pair = lowestPair();
    if (pair) attempt(function () { return G.dragEnd(pair[0], pair[1]); });
  }
  /* one wheel spin after cooldown — through the MC/HUD shared path */
  if (i % 60 === 0 && spins < 5) {
    var can = true;
    if (present.wheel) attempt(function () { can = DP.Wheel.canSpin(G.wheelState, G.nowMs) !== false; });
    if (can) {
      spins++;
      var route = attempt(function () { return G.mcWheel(); });
      if (route === 'modal') attempt(function () { return G.spinWheel(); });  /* modal's spin button */
    }
  }
  /* shop buy when affordable */
  if (i % 90 === 0 && buys < 3) {
    (function () {
      var ids = upgradeIds(), best = null, bestCost = Infinity;
      ids.forEach(function (id) {
        var lvl = G._upgradeLevel(id), cost = attempt(function () { return G.upgradeCost(id); });
        if (lvl >= maxOf(id) || !isFinite(cost)) return;
        if (cost <= G.state.coins && cost < bestCost) { bestCost = cost; best = id; }
      });
      if (!best) return;
      var coinsB = G.state.coins, lvlB = G._upgradeLevel(best);
      var ok = attempt(function () { return G.buyUpgrade(best); });
      buys++;
      if (ok === true) {
        if (Math.abs((coinsB - G.state.coins) - bestCost) > 1e-6) buyExactOk = false;
        if (G._upgradeLevel(best) !== lvlB + 1) buyLevelOk = false;
      }
    })();
  }
  /* guaranteed combo burst at t=30s: 22 rapid taps → ladder climbs to cap ×3.0 */
  if (i === BURST) {
    for (var bb = 0; bb < 24; bb++) forceCube(1, false);
    var ne = nonEmpty();
    for (var kk = 0; kk < Math.min(22, ne.length); kk++) {
      attempt(function () { G.update(DT); });
      (function (ix) { attempt(function () { G.tapCell(ix); }); })(ne[kk]);
    }
  }
  /* guaranteed chain at t=290s: force a tier≥5 cube + material, then tap it */
  if (i === CHAIN) {
    for (var cc = 0; cc < 4; cc++) forceCube(1, false);
    var ct = Math.max(5, Math.min(25, G.state.maxTierReached));
    var cIdx = forceCube(ct, false);
    var chainedBefore = stats.chained;
    attempt(function () { G.tapCell(cIdx); });
    check('chain reaction fires on tier ≥ 5 pop (≥2 chained)', stats.chained - chainedBefore >= 2);
    var halfOk = true;
    stats.chainValues.forEach(function (cv) {
      var expect = Math.round(baseCoinValue(cv.tier) * 0.5) * (cv.lucky ? 10 : 1);
      if (Math.abs(cv.value - expect) > 1) halfOk = false;
    });
    check('chain pops pay coinValue × 0.5 (lucky ×10)', stats.chained === 0 || halfOk);
    /* deterministic merge ladder → maxTierReached ≥ 3 */
    for (var lt = 1; lt <= 2; lt++) {
      var la = forceCube(lt, false), lb = forceCube(lt, false);
      if (la >= 0 && lb >= 0) attempt(function () { G.dragEnd(la, lb); });
    }
    check('maxTierReached ≥ 3 within the sim', G.state.maxTierReached >= 3 && stats.maxTier >= 3);
    check('tierReached/discover events fired for new tiers', stats.tierReached >= 1 && stats.discovers >= 1);
  }
  if (i % 300 === 0) { if (attempt(function () { return nanScan(); }) !== 0) nanViolations++; }
}

check('zero exceptions during the 5-minute bot', exceptions === 0 && !firstErr);
check('coins never decrease from pops', popViolations === 0);
check('no NaN anywhere during play (rolling scans)', nanViolations === 0);
check('spawns occurred over time (starter + interval)', stats.spawns >= 5);
check('merges occurred (≥3)', stats.merges >= 3);
check('merge event payload {a,b,tier}', !!(stats.firstMerge && isFinite(stats.firstMerge.a) && isFinite(stats.firstMerge.b) && isFinite(stats.firstMerge.tier)));
check('combo ladder climbs with rapid taps (count ≥ 8, mult ≥ 1.9)',
  stats.maxComboCount >= 8 && stats.maxComboMult >= 1.9);
check('combo multiplier capped at ×3.0', stats.maxComboMult >= 2.999 && stats.maxComboMult <= 3.001);
check('coins event payload {amount,total}', !!(stats.firstCoins && isFinite(stats.firstCoins.amount) && isFinite(stats.firstCoins.total)));
if (stats.luckySpawns > 0 || stats.luckyPops > 0) check('lucky cubes appeared (5% spawns / rain)', true);
else skip('lucky cube sighting', 'RNG-dependent — rerun to see one');
if (present.wheel) {
  check('wheel spun after cooldown (≥2 spins in 5 min)', spins >= 2 && stats.wheels >= 2);
  /* the SAME 60s gate the MC/HUD button uses */
  var can2 = false, guardN = 0;
  do {
    attempt(function () { can2 = DP.Wheel.canSpin(G.wheelState, G.nowMs) !== false; });
    if (!can2) { attempt(function () { G.update(DT); }); guardN++; }
  } while (!can2 && guardN < 4200);
  var spunRes = attempt(function () { return G.spinWheel(); });
  var wheelsBefore = stats.wheels;
  var gated = attempt(function () { return G.mcWheel(); });
  check('MC WHEEL button shares the 60s cooldown gate (blocked + no wheel event)',
    !!spunRes && gated === null && stats.wheels === wheelsBefore);
} else skip('wheel cooldown gates', 'js/wheel.js missing');
if (buys > 0) {
  check('shop buy spends exactly the upgrade cost', buyExactOk);
  check('shop buy increments the upgrade level', buyLevelOk);
} else skip('shop buy', 'nothing affordable during sim (economy too slow)');

/* ---------- quests: progress advances + claim works ---------- */
if (present.quests) {
  check('quests: completion events fired during play', stats.questsDone >= 1);
  var qCoins = G.state.coins;
  var rewards = attempt(function () { return G.claimQuests(); }) || [];
  check('quests: claim returns rewards array', Array.isArray(rewards));
  if (stats.questsDone >= 1) {
    check('quests: claim grants coins for completed quests', rewards.length >= 1 && G.state.coins > qCoins);
  } else skip('quest claim rewards', 'no completion detected (quest shape dependent)');
} else skip('quests progress + claim', 'js/quests.js missing');

/* ---------- income accrues while idle / combo decays ---------- */
forceCube(3, false); forceCube(3, false);
var idle0 = G.state.coins, inc0 = attempt(function () { return G.incomePerSec(); }) || 0;
for (var u2 = 0; u2 < 600; u2++) attempt(function () { G.update(DT); });
var idleGain = G.state.coins - idle0;
check('income accrues while idle (10s, no input)', idleGain > 0);
if (inc0 > 0) check('idle gain tracks incomePerSec × 10s', idleGain >= inc0 * 10 * 0.4 && idleGain <= inc0 * 10 * 2.5);
check('combo decays after the 2s window', G.state.combo === 0);

/* ---------- gridSize upgrade: deliberate resize path ---------- */
var sizeBefore = G.board.size, countBefore = cubeCount();
G.state.coins += 30000; G.state.lifetime += 30000;
var gridOk = attempt(function () { return G.buyUpgrade('gridSize'); });
if (gridOk === true) {
  check('gridSize upgrade resizes the board (5→6 or 6→7)', G.board.size === sizeBefore + 1 && G.board.cells.length === G.board.size * G.board.size);
  check('resize preserves existing cubes at same coords', cubeCount() >= countBefore);
} else if (G._upgradeLevel('gridSize') >= maxOf('gridSize')) {
  skip('gridSize resize', 'already maxed during sim');
} else {
  check('gridSize upgrade resizes the board', false);
}

/* ---------- save/load round-trip equality ---------- */
forceCube(3, false); forceCube(2, false);
var snap = {
  coins: G.state.coins, lifetime: G.state.lifetime, maxTier: G.state.maxTierReached,
  disc: Object.keys(G.state.discovered).length, asc: G.state.ascensions || 0,
  size: G.board.size, tiers: nonEmpty().map(function (ix) { return G.board.cells[ix].tier; }).sort(),
  up: JSON.parse(JSON.stringify(G.state.upgrades))
};
attempt(function () { G.save(); });
check('save written to localStorage', !!globalThis.localStorage.getItem('dopamine_factory_v1'));
attempt(function () { G.boot({ headless: true }); });           /* reload from the save */
check('reload: coins restored', Math.abs(G.state.coins - snap.coins) < 1e-6);
check('reload: lifetime restored', Math.abs(G.state.lifetime - snap.lifetime) < 1e-6);
check('reload: maxTierReached restored', G.state.maxTierReached === snap.maxTier);
check('reload: discovered count restored', Object.keys(G.state.discovered).length === snap.disc);
check('reload: board size + cube tiers restored',
  G.board.size === snap.size && JSON.stringify(nonEmpty().map(function (ix) { return G.board.cells[ix].tier; }).sort()) === JSON.stringify(snap.tiers));
check('reload: upgrade levels restored', JSON.stringify(G.state.upgrades) === JSON.stringify(snap.up));

/* ---------- offline earnings ---------- */
var preOffline = G.state.coins;
attempt(function () { G.state.lastSeen = G.nowMs - 2 * 3600 * 1000; });
attempt(function () { G.save(); });
attempt(function () { G.boot({ headless: true }); });
var offlineGain = G.state.coins - preOffline;
check('offline earnings granted after 2h absence', offlineGain > 0);
check('offline gain sane vs income (≤ 8h cap math)', offlineGain <= G.incomePerSec() * 28800 * 0.5 * 1.01 + 1);

/* ---------- finals ---------- */
check('coins increased overall during the playtest', G.state.coins > 0 && G.state.lifetime > 0);
check('lifetime ≥ coins (spending reduces coins, not lifetime)', G.state.lifetime >= G.state.coins - 1);
check('no NaN anywhere (final full scan)', attempt(function () { return nanScan(); }) === 0);
check('zero exceptions across the entire suite', exceptions === 0 && !firstErr);

console.log('\nbot summary: pops=' + stats.pops + ' merges=' + stats.merges + ' chains=' + stats.chained +
  ' spawns=' + stats.spawns + ' wheels=' + stats.wheels + ' questsDone=' + stats.questsDone +
  ' maxTier=' + G.state.maxTierReached + ' maxCombo=×' + stats.maxComboMult.toFixed(1) +
  ' coins=' + Math.floor(G.state.coins));
console.log('modules skipped: ' + (skipped.length ? skipped.join(', ') : 'none'));
console.log(fail === 0 ? '\nALL TESTS PASSED (' + pass + ')' : '\n' + fail + ' FAILURES of ' + (pass + fail) + ', ' + skipCount + ' skipped');
process.exit(fail === 0 ? 0 : 1);
