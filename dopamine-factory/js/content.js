var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
/* DOPAMINE FACTORY — js/content.js — DP.Content: pure data + canon math.
 * Single source of truth: 25 tiers (coinValue canon round(10 x 3.5^(t-1)),
 * a precomputed 25-hex rainbow-to-gold ladder, escalating names Pebble ->
 * STARDUST -> SINGULARITY), 6 canon upgrades (cost = base x 1.35^level),
 * prestigeMult, discoverBonus, incomeMult = income upgrade x discovery x
 * prestige. Pure: no DOM, canvas, events or dependencies. Safe to load
 * first (defines the DP namespace root). Self-test: node js/content.js */

var C = (typeof DP.Content !== 'undefined') ? DP.Content : (DP.Content = {});

/* ================================ TIERS ================================ */

C.tiers = 25;

/* coinValue(t) — THE canon: round(10 x 3.5^(t-1)), tiers 1..25 (tier 1 = 10,
 * tier 25 = 114,191,312,420,706). Every merge multiplies value ~3.5x — the
 * dopamine engine of the whole game. Out-of-range tiers pay 0. */
C.coinValue = function (t) {
  var n = Math.floor(Number(t) || 0);
  if (n < 1 || n > C.tiers) return 0;
  return Math.round(10 * Math.pow(3.5, n - 1));
};
C.tierValue = C.coinValue; /* contract alias */

/* TIER_COLORS — 25 precomputed hexes. Warm amber start, up through yellow/
 * green/cyan/blue/purple/magenta, crimson blaze at 22-23, blazing gold at
 * 24, white-hot gold for SINGULARITY. Every hex distinct; tuned to pop as
 * emissive glow on deep space navy. */
C.TIER_COLORS = [
  '#FFA929', '#FFD633', '#F2F924', '#ACF122', '#41DA1B', /*  1- 5 amber -> green  */
  '#20D544', '#1CD47E', '#18D8B1', '#14D7E1', '#0DB5F2', /*  6-10 emerald -> sky  */
  '#1E8DF6', '#3471F4', '#4B5EF1', '#685AED', '#855DE9', /* 11-15 azure -> violet */
  '#9F60E6', '#B762E4', '#D057E5', '#E84AE0', '#ED3BC0', /* 16-20 purple -> pink   */
  '#F3359D', '#F9397C', '#FF4763', '#FFC53D', '#F9F6EB'  /* 21-25 blaze -> white   */
];

/* tierColor(t) — hex for tier t, clamped into 1..25 so a renderer can
 * never crash on junk input (NaN/negatives snap to the ladder ends). */
C.tierColor = function (t) {
  var n = Math.max(1, Math.min(C.tiers, Math.floor(Number(t) || 0)));
  return C.TIER_COLORS[n - 1];
};

/* TIER_NAMES — escalating flavor: rocks -> gems -> exotic matter -> cosmic
 * -> transcendence. Caps switch at tier 14 (PLASMA): beyond ordinary matter. */
C.TIER_NAMES = [
  'Pebble', 'Chunk', 'Nugget', 'Geode', 'Quartz',           /*  1- 5 rocks   */
  'Crystal', 'Gemstone', 'Prism', 'Opal', 'Amethyst',       /*  6-10 gems    */
  'Emerald', 'Sapphire', 'Diamond', 'PLASMA', 'AURORA',     /* 11-15 exotic  */
  'COMET', 'METEOR', 'NEBULA', 'PULSAR', 'MAGNETAR',        /* 16-20 cosmic  */
  'NOVA', 'SUPERNOVA', 'QUASAR', 'STARDUST', 'SINGULARITY'  /* 21-25 the end */
];

C.tierName = function (t) {
  var n = Math.max(1, Math.min(C.tiers, Math.floor(Number(t) || 0)));
  return C.TIER_NAMES[n - 1];
};

/* =============================== UPGRADES ============================== */
/* Six canon upgrades. cost(level) = price of the NEXT purchase at `level`:
 * round(base x 1.35^level), whole coins. effect(level) = stat after that
 * many purchases:
 *   tapPower    coin-value x(1 + 0.15 lvl)
 *   spawnRate   spawn-interval x0.92^lvl (2.5s base; lvl 22 hits the 0.4s floor)
 *   incomeMult  idle-income x(1 + 0.10 lvl)
 *   gridSize    board side 5 + lvl (5x5 -> 6x6 -> 7x7, max 2 purchases)
 *   luckyChance total golden odds 0.05 + 0.015 lvl (20% at max)
 *   chainPower  +1 chain cube per lvl (chains cap at 8 total)             */

C.UPGRADES = [
  { id: 'tapPower', name: 'Golden Touch', max: 20, base: 50,
    desc: '+15% coin value per level — every pop pays harder.',
    effect: function (l) { return 1 + 0.15 * l; } },
  { id: 'spawnRate', name: 'Fast Conveyor', max: 22, base: 100,
    desc: '-8% spawn interval per level, down to the 0.4s floor.',
    effect: function (l) { return Math.pow(0.92, l); } },
  { id: 'incomeMult', name: 'Idle Engine', max: 20, base: 250,
    desc: '+10% idle income per level — the factory never sleeps.',
    effect: function (l) { return 1 + 0.10 * l; } },
  { id: 'gridSize', name: 'Bigger Floor', max: 2, base: 2000,
    desc: 'Expand the arena: 5x5 -> 6x6 -> 7x7 — room for more dopamine.',
    effect: function (l) { return 5 + l; } },
  { id: 'luckyChance', name: 'Luck Infusion', max: 10, base: 750,
    desc: '+1.5% golden cube chance per level (5% base, 20% max).',
    effect: function (l) { return 0.05 + 0.015 * l; } },
  { id: 'chainPower', name: 'Chain Overdrive', max: 6, base: 1500,
    desc: '+1 chain cube per level — lightning loves company (cap 8).',
    effect: function (l) { return l; } }
];

C.UPGRADE_MAP = {};
C.UPGRADES.forEach(function (u) {
  u.cost = function (level) { return C.upgradeCost(u.id, level); };
  C.UPGRADE_MAP[u.id] = u;
});

C.upgradeById = function (id) { return C.UPGRADE_MAP[id] || null; };

/* upgradeCost(id, level) — canon curve base x 1.35^level, rounded to whole
 * coins. Unknown ids or levels at/above max cost Infinity (nothing left to
 * buy — spendCoins() declines it automatically). Negative levels clamp to 0. */
C.upgradeCost = function (id, level) {
  var u = C.UPGRADE_MAP[id];
  if (!u) return Infinity;
  var l = Math.max(0, Math.floor(Number(level) || 0));
  if (l >= u.max) return Infinity;
  return Math.round(u.base * Math.pow(1.35, l));
};

/* ========================== PRESTIGE & DISCOVERY ======================== */

/* prestigeMult(n) — ASCEND canon: permanent x(1 + 0.5 x ascensions). */
C.prestigeMult = function (n) {
  var k = Math.max(0, Math.floor(Number(n) || 0));
  return 1 + 0.5 * k;
};

/* discoverBonus(count) — collection canon: x1.02 per tier discovered
 * (a full 25-tier collection pays x1.64 idle income). */
C.discoverBonus = function (count) {
  var k = Math.max(0, Math.floor(Number(count) || 0));
  return Math.pow(1.02, k);
};

/* incomeMult(state) — idle-income multiplier from the shared game state:
 * income upgrade x discovery x prestige, stacked. Pure and defensive —
 * missing or foreign fields contribute x1; only truthy entries in
 * state.discovered count (a half-saved tier is not a discovery). */
C.incomeMult = function (state) {
  var lvl = 0, disc = 0, asc = 0, k;
  if (state) {
    var up = state.upgrades;
    if (up && typeof up.incomeMult === 'number' && isFinite(up.incomeMult) &&
        up.incomeMult > 0) lvl = up.incomeMult;
    if (state.discovered) {
      for (k in state.discovered) {
        if (Object.prototype.hasOwnProperty.call(state.discovered, k) &&
            state.discovered[k]) disc++;
      }
    }
    if (typeof state.ascensions === 'number' && isFinite(state.ascensions) &&
        state.ascensions > 0) asc = state.ascensions;
  }
  return C.UPGRADE_MAP.incomeMult.effect(lvl) *
         C.discoverBonus(disc) * C.prestigeMult(asc);
};

/* =============================== SELF-TEST ============================== */
function selfTest() {
  var log = (typeof console !== 'undefined' && typeof console.log === 'function')
    ? function (m) { console.log(m); } : function () {};
  var fails = 0, total = 0;
  function ok(name, cond) {
    total++;
    if (cond) log('PASS: ' + name); else { fails++; log('FAIL: ' + name); }
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function approx(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  function rgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function hueOf(h) {
    var c = rgb(h), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), d = max - Math.min(r, g, b), x;
    if (d === 0) return 0;
    if (max === r) x = ((g - b) / d) % 6;
    else if (max === g) x = (b - r) / d + 2;
    else x = (r - g) / d + 4;
    x *= 60;
    return x < 0 ? x + 360 : x;
  }

  ok('DP.Content exposes the full contract API (tierValue === coinValue alias)',
    C.tiers === 25 && typeof C.coinValue === 'function' && C.tierValue === C.coinValue &&
    typeof C.tierColor === 'function' && typeof C.tierName === 'function' &&
    Array.isArray(C.TIER_COLORS) && Array.isArray(C.TIER_NAMES) && Array.isArray(C.UPGRADES) &&
    typeof C.upgradeCost === 'function' && typeof C.upgradeById === 'function' &&
    typeof C.prestigeMult === 'function' && typeof C.discoverBonus === 'function' &&
    typeof C.incomeMult === 'function');

  /* ---- value curve ---- */
  var mono = true, canon = true, intOk = true, ratioOk = true, prev = 0;
  for (var t = 1; t <= 25; t++) {
    var v = C.tierValue(t);
    if (!isNum(v) || v <= prev) mono = false;
    if (v % 1 !== 0) intOk = false;
    if (v !== Math.round(10 * Math.pow(3.5, t - 1)) || C.coinValue(t) !== v) canon = false;
    if (t > 1 && (v / prev < 3.4 || v / prev > 3.6)) ratioOk = false;
    prev = v;
  }
  ok('tierValue strictly increases across all 25 tiers (10 -> ' + C.tierValue(25) + ')', mono);
  ok('coinValue canon round(10 x 3.5^(t-1)) exact for every tier; whole coins, ~3.5x steps',
    canon && intOk && ratioOk);
  ok('canon spot checks tier 1=10/3=123/5=1501/25=114191312420706; out-of-range pays 0',
    C.tierValue(1) === 10 && C.tierValue(3) === 123 && C.tierValue(5) === 1501 &&
    C.tierValue(25) === 114191312420706 && C.tierValue(0) === 0 &&
    C.tierValue(-7) === 0 && C.tierValue(26) === 0 && C.tierValue(NaN) === 0);

  /* ---- names ---- */
  var nameOk = true, capsOk = true, seen = {}, i;
  for (i = 0; i < 25; i++) {
    var nm = C.TIER_NAMES[i];
    if (typeof nm !== 'string' || nm.length < 3 || seen[nm]) nameOk = false;
    seen[nm] = 1;
    if (!(i < 13 ? /^[A-Z][a-z]+$/.test(nm) : /^[A-Z][A-Z ]+$/.test(nm))) capsOk = false;
  }
  ok('25 unique names, caps escalate at tier 14, anchors Pebble/Chunk/STARDUST/SINGULARITY; tierName clamps junk',
    nameOk && capsOk && C.TIER_NAMES.length === 25 && C.TIER_NAMES[0] === 'Pebble' &&
    C.TIER_NAMES[1] === 'Chunk' && C.TIER_NAMES[23] === 'STARDUST' &&
    C.TIER_NAMES[24] === 'SINGULARITY' && C.tierName(0) === 'Pebble' &&
    C.tierName(99) === 'SINGULARITY' && C.tierName(NaN) === 'Pebble');

  /* ---- colors ---- */
  var hexOk = true, distinctOk = true, seenHex = {}, hues = {}, k;
  for (i = 0; i < 25; i++) {
    var h = C.TIER_COLORS[i];
    if (typeof h !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(h)) hexOk = false;
    k = String(h).toLowerCase();
    if (seenHex[k]) distinctOk = false;
    seenHex[k] = 1;
    hues[Math.round(hueOf(h))] = 1;
  }
  var mapOk = true;
  for (var tc = 1; tc <= 25; tc++) if (C.tierColor(tc) !== C.TIER_COLORS[tc - 1]) mapOk = false;
  ok('TIER_COLORS: 25 valid #rrggbb hexes, every one distinct; tierColor maps + clamps',
    hexOk && distinctOk && C.TIER_COLORS.length === 25 && mapOk &&
    C.tierColor(0) === C.TIER_COLORS[0] && C.tierColor(26) === C.TIER_COLORS[24] &&
    C.tierColor(NaN) === C.TIER_COLORS[0]);
  var c1 = rgb(C.TIER_COLORS[0]), c24 = rgb(C.TIER_COLORS[23]), c25 = rgb(C.TIER_COLORS[24]);
  ok('ladder arcs warm amber -> rainbow -> blazing gold -> white-hot',
    c1[0] >= 240 && c1[1] > 120 && c1[2] < 130 && c1[0] > c1[1] && c1[1] > c1[2] &&
    hueOf(C.TIER_COLORS[0]) > 30 && hueOf(C.TIER_COLORS[0]) <= 50 &&
    hueOf(C.TIER_COLORS[23]) > 35 && hueOf(C.TIER_COLORS[23]) <= 55 &&
    c24[0] >= 250 && c24[2] < 130 &&
    Math.min(c25[0], c25[1], c25[2]) >= 230 && c25[0] >= c25[1] && c25[1] >= c25[2]);
  var BANDS = [[30, 60], [60, 150], [150, 200], [200, 255], [255, 300], [300, 345], [345, 360]];
  var bandOk = BANDS.every(function (b) {
    return C.TIER_COLORS.some(function (hx) {
      var hu = hueOf(hx);
      return hu > b[0] && hu <= b[1];
    });
  });
  var hueCount = 0;
  for (k in hues) if (hues[k]) hueCount++;
  ok('ladder walks the whole rainbow: amber/green/cyan/blue/purple/magenta/crimson (' + hueCount + ' distinct hues)',
    bandOk && hueCount >= 20);

  /* ---- upgrades ---- */
  var IDS = ['tapPower', 'spawnRate', 'incomeMult', 'gridSize', 'luckyChance', 'chainPower'];
  var BASES = [50, 100, 250, 2000, 750, 1500];
  var shapeOk = true, baseOk = true, ix;
  for (ix = 0; ix < C.UPGRADES.length; ix++) {
    var u = C.UPGRADES[ix];
    if (!u) { shapeOk = false; continue; }
    if (u.id !== IDS[ix] || typeof u.name !== 'string' || u.name.length < 1 ||
        typeof u.desc !== 'string' || u.desc.length < 1 || !isNum(u.max) ||
        u.max < 1 || u.max % 1 !== 0 || !isNum(u.base) || typeof u.cost !== 'function' ||
        typeof u.effect !== 'function') shapeOk = false;
    if (u.base !== BASES[ix] || C.upgradeById(IDS[ix]) !== u) baseOk = false;
  }
  ok('6 upgrades in canon order (tapPower..chainPower), complete shape, bases 50/100/250/2000/750/1500',
    shapeOk && baseOk && C.UPGRADES.length === 6);
  var curveOk = true, climbOk = true, mirrorOk = true, capOk = true;
  C.UPGRADES.forEach(function (up) {
    var last = 0;
    for (var l = 0; l < up.max; l++) {
      var cost = C.upgradeCost(up.id, l);
      if (!isNum(cost) || cost !== Math.round(up.base * Math.pow(1.35, l))) curveOk = false;
      if (cost <= last) climbOk = false;
      if (up.cost(l) !== cost) mirrorOk = false;
      last = cost;
    }
    if (C.upgradeCost(up.id, up.max) !== Infinity) capOk = false;
  });
  ok('upgradeCost = base x 1.35^level exactly (rounded), climbing strictly, u.cost mirrors it',
    curveOk && climbOk && mirrorOk);
  ok('level >= max and unknown ids cost Infinity; negative levels clamp to level 0',
    capOk && C.upgradeCost('darkMatter', 0) === Infinity &&
    C.upgradeCost('tapPower', -9) === 50);
  var tp = C.upgradeById('tapPower'), sr = C.upgradeById('spawnRate'),
      im = C.upgradeById('incomeMult'), lc = C.upgradeById('luckyChance'),
      cp = C.upgradeById('chainPower'), gr = C.upgradeById('gridSize');
  var effOk = true;
  [0, 1, 5, tp.max].forEach(function (l) { if (tp.effect(l) !== 1 + 0.15 * l) effOk = false; });
  [0, 1, 10, sr.max].forEach(function (l) { if (sr.effect(l) !== Math.pow(0.92, l)) effOk = false; });
  [0, 3, im.max].forEach(function (l) { if (im.effect(l) !== 1 + 0.10 * l) effOk = false; });
  [0, 4, lc.max].forEach(function (l) { if (lc.effect(l) !== 0.05 + 0.015 * l) effOk = false; });
  [0, 2, cp.max].forEach(function (l) { if (cp.effect(l) !== l) effOk = false; });
  ok('effect curves canon-exact: +15%/lvl tap, x0.92/lvl spawn (0.4s floor), +10%/lvl income, +1.5%/lvl lucky (20% max), +1 chain/lvl; gridSize 5x5->6x6->7x7',
    effOk && tp.max === 20 && sr.max === 22 && im.max === 20 && lc.max === 10 &&
    cp.max === 6 && gr.max === 2 && gr.effect(0) === 5 && gr.effect(1) === 6 &&
    gr.effect(2) === 7 && 2.5 * sr.effect(sr.max) <= 0.4 &&
    lc.effect(lc.max) === 0.05 + 0.015 * 10);

  /* ---- prestige + discovery ---- */
  var prOk = true, dbOk = true, dbMono = true, lastD = 0;
  for (var n = 0; n <= 40; n++) {
    if (C.prestigeMult(n) !== 1 + 0.5 * n) prOk = false;
    if (n <= 30) {
      var b = C.discoverBonus(n);
      if (b !== Math.pow(1.02, n)) dbOk = false;
      if (b <= lastD) dbMono = false;
      lastD = b;
    }
  }
  ok('prestigeMult = 1 + 0.5 x ascensions (1 at 0, 1.5 first, 3 at four); junk -> x1',
    prOk && C.prestigeMult(0) === 1 && C.prestigeMult(1) === 1.5 &&
    C.prestigeMult(4) === 3 && C.prestigeMult(-3) === 1 && C.prestigeMult(NaN) === 1);
  ok('discoverBonus = 1.02^count (1 at 0, monotonic to full 25); junk -> x1',
    dbOk && dbMono && C.discoverBonus(0) === 1 && C.discoverBonus(1) === 1.02 &&
    C.discoverBonus(-2) === 1 && C.discoverBonus(NaN) === 1);

  /* ---- income stacking ---- */
  function mkState(lv, disc, asc) {
    var d = {};
    for (var j = 1; j <= disc; j++) d[j] = true;
    return { upgrades: { incomeMult: lv }, discovered: d, ascensions: asc };
  }
  ok('incomeMult is safe on null/empty state and ignores foreign upgrades',
    C.incomeMult(null) === 1 && C.incomeMult(undefined) === 1 &&
    C.incomeMult({}) === 1 && C.incomeMult({ upgrades: { tapPower: 9 } }) === 1);
  ok('incomeMult solo factors: upgrade 1.5 at lvl 5, discovery 1.02^10, prestige 2.5 at 3; only truthy discoveries count',
    C.incomeMult(mkState(5, 0, 0)) === 1.5 &&
    approx(C.incomeMult(mkState(0, 10, 0)), Math.pow(1.02, 10)) &&
    C.incomeMult(mkState(0, 0, 3)) === 2.5 &&
    approx(C.incomeMult({ discovered: { 1: true, 2: true, 3: false, 4: 0 } }), Math.pow(1.02, 2)));
  var stackOk = true;
  [0, 3, 7, im.max].forEach(function (lv) {
    [0, 4, 12, 25].forEach(function (disc) {
      [0, 1, 5, 17].forEach(function (asc) {
        var m = C.incomeMult(mkState(lv, disc, asc));
        var up = 1 + 0.10 * lv, dv = Math.pow(1.02, disc), p = 1 + 0.5 * asc;
        var orders = [up * dv * p, dv * up * p, p * up * dv,
                      up * p * dv, dv * p * up, p * dv * up];
        for (var oi = 0; oi < 6; oi++) if (!approx(m, orders[oi])) stackOk = false;
        if (!approx(m, im.effect(lv) * C.discoverBonus(disc) * C.prestigeMult(asc))) stackOk = false;
      });
    });
  });
  ok('incomeMult stacks upgrade x discovery x prestige, order-independent within 1e-9 (64 states)', stackOk);

  if (fails === 0) log('ALL TESTS PASSED');
  else {
    log('FAIL: ' + fails + ' of ' + total + ' checks failed');
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
  }
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].endsWith('content.js')) {
  selfTest();
}
