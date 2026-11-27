/* ============================================================
 * ULTIMATE COOKING — js/tests.js
 * Node self-test suite: PART 1 logic + MC router + day sim bots.
 * Loaded by js/game.js when run under node (`node js/game.js`).
 * ============================================================ */
(function () {
  'use strict';

  var UC = (typeof require === 'function') ? require('./logic-core.js') : window.UC;
  var MC = null;
  if (typeof require === 'function') {
    try {
      require('../../shared/mobile-controls.js'); /* attaches to globalThis.MC */
      MC = (typeof globalThis.MC !== 'undefined') ? globalThis.MC : null;
    } catch (e) { MC = null; }
  } else {
    MC = (typeof window !== 'undefined') ? window.MC : null;
  }

  var passed = 0, failed = 0, failures = [];

  function check(name, cond) {
    if (cond) { passed++; if (typeof console !== 'undefined') console.log('PASS: ' + name); }
    else { failed++; failures.push(name); if (typeof console !== 'undefined') console.log('FAIL: ' + name); }
  }

  /* ---------------- helpers ---------------- */
  function huntDay(rid, save, pred, maxSeed) {
    for (var s = 1; s <= (maxSeed || 2000); s++) {
      var st = UC.createDay(rid, 1, save, s);
      if (pred(st)) return st;
    }
    return null;
  }
    /* assemble everything up to (not including) frosting */
  function assembleUntilFrost(st) {
    var guard = 0, g2;
    while (st.active && st.plate.phase === 'build' && guard++ < 100) {
      var exp = UC.expectedItem(st);
      if (!exp || exp.def.prep === 'frost') break;
      UC.tapBin(st, exp.id);
      g2 = 0;
      while (st.board && g2++ < 50) UC.tapBoard(st);
    }
  }

  /* ---------------- day sim bot (public API only) ---------------- */
  function botAct(st) {
    if (!st.active) return 0;
    var plate = st.plate;
    if (plate.phase === 'burnt') { UC.trashPlate(st); return 1; }
    if (plate.phase === 'complete') { UC.servePlate(st); return 1; }
    if (plate.phase === 'oven') { UC.startBake(st); return 1; }
    if (plate.phase === 'baking' && st.oven) {
      var ov = st.oven;
      var p = ov.t / ov.T;
      var gc = (ov.greenA + ov.greenB) / 2;
      var gh = (ov.greenB - ov.greenA) / 2 * ov.scale;
      if (p >= gc - gh && p <= gc + gh) { UC.pullOven(st); return 1; }
      return 0;
    }
    if (st.frost && !st.frost.done) {
      if (st.frost.t >= UC.FROST_BAND[0]) { UC.releaseFrost(st); return 1; }
      UC.setFrostHolding(st, true);
      return 0;
    }
    for (var i = 0; i < st.pans.length; i++) {
      var pan = st.pans[i];
      if (pan.phase === 'cooking' && pan.windowOpen && Math.abs(pan.pos - 0.5) <= pan.green / 2) {
        UC.tapPan(st, i); return 1;
      }
      if (pan.phase === 'burnt') { UC.tapPan(st, i); return 1; }
    }
    if (st.board) {
      var b = st.board;
      if (b.kind === 'chop') { UC.tapBoard(st); return 1; }
      if (b.kind === 'pchop' && Math.abs(b.sweep - 0.5) <= b.zoneW / 2) { UC.tapBoard(st); return 1; }
      return 0;
    }
    var exp = UC.expectedItem(st);
    if (!exp) return 0;
    UC.tapBin(st, exp.id);
    return 1;
  }

  function simulateDay(rid, day, save, seed, dt) {
    var st = UC.createDay(rid, day, save, seed);
    var ticks = 0, maxTicks = 400000;
    dt = dt || 0.05;
    while (!st.finished && ticks < maxTicks) {
      UC.dayTick(st, dt);
      botAct(st);
      ticks++;
    }
    return { st: st, ticks: ticks };
  }

  function run() {
    passed = 0; failed = 0; failures = [];
    var i, res;

    /* ============ RNG & generation ============ */
    var r1 = UC.makeRNG(12345), r2 = UC.makeRNG(12345), same = true;
    for (i = 0; i < 5; i++) { if (r1() !== r2()) same = false; }
    check('rng: same seed → same sequence', same);
    var r3 = UC.makeRNG(999), inRange = true;
    for (i = 0; i < 100; i++) { var v = r3(); if (v < 0 || v >= 1) inRange = false; }
    check('rng: values in [0,1)', inRange);

    var rest = UC.RESTAURANTS[0];
    var o = UC.generateOrder(0, UC.makeRNG(7));
    check('order: items are known ingredients', o.items.every(function (id) { return !!UC.ING[id]; }));
    check('order: diner starts with bun bottom, ends with bun top',
      o.items[0] === 'bun_bottom' && o.items[o.items.length - 1] === 'bun_top');
    check('order: price formula', UC.orderPrice(0, rest.menu[0]) === Math.round(12 + 5 * 1.2));
    var seenIds = {};
    for (i = 0; i < 40; i++) { seenIds[UC.generateOrder(0, UC.makeRNG(100 + i)).id] = 1; }
    check('order: weighted random yields menu variety', Object.keys(seenIds).length >= 2);
    var seen2 = {};
    for (i = 0; i < 40; i++) { seen2[UC.generateOrder(2, UC.makeRNG(200 + i)).id] = 1; }
    check('order: sushi menu valid + varied', Object.keys(seen2).length >= 2);

    check('day: customer count day1=6', UC.dayCustomerCount(1) === 6);
    check('day: customer count day2=7', UC.dayCustomerCount(2) === 7);
    check('day: customer count caps at 10', UC.dayCustomerCount(5) === 10 && UC.dayCustomerCount(9) === 10);

    var cust = UC.genCustomer(0, 1, UC.makeRNG(42), 0);
    check('customer: has order, patience and look', cust.order.items.length > 0 &&
      cust.patienceMax > 0 && cust.look.hat >= 0 && cust.look.hat < 5 && !!cust.name);
    var chill = UC.genCustomer(0, 1, function () { return 0; }, 0);
    var hasty = UC.genCustomer(0, 1, function () { return 0.99; }, 0);
    check('customer: hasty customers are less patient than chill',
      hasty.patienceMax < chill.patienceMax);
    var diff = UC.dayDifficulty(0, 8);
    check('difficulty: patience shrinks with day but floors', diff.patience < rest.patience && diff.patience >= rest.patience * 0.55);
    check('difficulty: zone scale shrinks but floors', diff.zoneScale < 1 && diff.zoneScale >= 0.55);

    check('restIngredients: diner bins match menu', (function (list) {
      return list.indexOf('patty') >= 0 && list.indexOf('lettuce') >= 0 && list.indexOf('cheese') >= 0;
    })(UC.restIngredients(0)));

    /* ============ chop logic ============ */
    var save = UC.defaultSave();
    var seedGarden = null, seedClassic = null, seedSalmon = null;
    var stH = huntDay(0, save, function (s) { return s.active.order.items[1] === 'lettuce'; });
    seedGarden = stH ? stH.seed : null;
    check('chop: found a garden-style order (lettuce second)', !!stH);
    var stH2 = huntDay(0, save, function (s) { return s.active.order.items[1] === 'patty'; });
    seedClassic = stH2 ? stH2.seed : null;
    check('chop: found a classic order (patty second)', !!stH2);

    res = UC.tapBin(stH, 'bun_bottom');
    check('assembly: ready ingredient plates on tap', res.code === 'placed' && stH.plate.items[0] === 'bun_bottom');
    res = UC.tapBin(stH, 'lettuce');
    check('chop: veg goes to board', res.code === 'toBoard' && stH.board.kind === 'chop');
    var taps = 0;
    while (stH.board && taps < 30) { UC.tapBoard(stH); taps++; }
    check('chop: 4 taps at knife tier 0', taps === 4);
    check('chop: plated after chopping', stH.plate.items[1] === 'lettuce' && stH.board === null);
    check('chop: expected index advanced', stH.plate.expected === 2);

    var saveK = UC.defaultSave(); saveK.upgrades.knife = 1;
    var stK = UC.createDay(0, 1, saveK, seedGarden);
    UC.tapBin(stK, 'bun_bottom'); UC.tapBin(stK, 'lettuce');
    var tapsK = 0;
    while (stK.board && tapsK < 30) { UC.tapBoard(stK); tapsK++; }
    check('upgrade: knife tier1 → 3 taps (1.4× per tap)', tapsK === 3);
    check('upgrade: knife mult table', UC.knifeMult(saveK) === 1.4 && UC.knifeMult(save) === 1);

    /* ============ precision chop (sushi) ============ */
    var stS = huntDay(2, save, function (s) { return s.active.order.items[2] === 'salmon'; });
    seedSalmon = stS ? stS.seed : null;
    check('sushi: found a fish order', !!stS);
    check('sushi: first items are nori + rice',
      stS.active.order.items[0] === 'nori' && stS.active.order.items[1] === 'rice');
    UC.tapBin(stS, 'nori'); UC.tapBin(stS, 'rice');
    check('sushi: salmon needs precision chop', UC.ING.salmon.prep === 'pchop');
    res = UC.tapBin(stS, 'salmon');
    check('pchop: fish goes to board with sweep', res.code === 'toBoard' && stS.board.kind === 'pchop' && stS.board.sweep === 0);
    stS.board.sweep = 0.5;
    res = UC.tapBoard(stS);
    check('pchop: centered tap is perfect', res.code === 'pslice' && res.result === 'perfect');
    check('pchop: quality up on perfect', stS.plate.quality > UC.QUALITY_BASE);
    stS.board.sweep = 0.5; UC.tapBoard(stS);
    stS.board.sweep = 0.5;
    res = UC.tapBoard(stS);
    check('pchop: 3 slices complete the fish',
      stS.board === null && (res.code === 'placed' || res.code === 'orderComplete'));
    /* sloppy tap */
    var stS2 = UC.createDay(2, 1, save, seedSalmon);
    UC.tapBin(stS2, 'nori'); UC.tapBin(stS2, 'rice'); UC.tapBin(stS2, 'salmon');
    stS2.board.sweep = 0.5; UC.tapBoard(stS2);
    var qAfterPerfect = stS2.plate.quality;
    stS2.board.sweep = 0.05; res = UC.tapBoard(stS2);
    check('pchop: off-zone tap is sloppy (quality down, combo reset)',
      res.result === 'sloppy' && stS2.plate.quality < qAfterPerfect && stS2.combo.level === 1);
    var before = stS2.plate.quality;
    var laps = 0;
    while (stS2.board && laps < 200) { UC.dayTick(stS2, 0.5); laps++; }
    check('pchop: untapped sweeps auto-resolve sloppy', stS2.board === null && stS2.plate.quality < before);

    /* ============ cook / flip logic ============ */
    var stC = UC.createDay(0, 1, save, seedClassic);
    UC.tapBin(stC, 'bun_bottom');
    res = UC.tapBin(stC, 'patty');
    check('cook: patty starts on the pan', res.code === 'toPan' && stC.pans[0].phase === 'cooking');
    var pan = stC.pans[0];
    check('cook: pan cooking with two flip windows', pan.windows.length === 2 && pan.wi === 0);
    res = UC.tapPan(stC, 0);
    check('cook: tap before window is a no-op', res.code === 'tooEarly');
    UC.dayTick(stC, pan.T * 0.28);
    check('cook: window opens', pan.windowOpen === true);
    pan.pos = 0.5;
    res = UC.tapPan(stC, 0);
    check('cook: green-zone flip is PERFECT (+combo point)', res.code === 'flipPerfect' && stC.combo.points === 1);
    check('cook: quality up on perfect flip', stC.plate.quality > UC.QUALITY_BASE);
    UC.dayTick(stC, pan.T);
    check('cook: missed window penalizes + combo reset',
      pan.windows[1].result === 'miss' && stC.combo.level === 1);
    check('cook: pan ready after cook time', pan.phase === 'ready');
    res = UC.tapPan(stC, 0);
    check('cook: ready patty plates onto the stack', res.code === 'placed' && stC.plate.items[1] === 'patty');
    check('cook: pan freed after plating', stC.pans[0].phase === 'empty');

    var stB = UC.createDay(0, 1, save, seedClassic);
    UC.tapBin(stB, 'bun_bottom'); UC.tapBin(stB, 'patty');
    UC.dayTick(stB, stB.pans[0].T * 1.5);
    check('cook: missed flips → still ready', stB.pans[0].phase === 'ready');
    UC.dayTick(stB, UC.COOK_HOLD + 1);
    check('cook: ready patty burns after hold window', stB.pans[0].phase === 'burnt');
    res = UC.tapPan(stB, 0);
    check('cook: burnt pan clears on tap', res.code === 'panCleared' && stB.pans[0].phase === 'empty');

    var saveD = UC.defaultSave(); saveD.upgrades.burner = 1;
    var stD = UC.createDay(0, 1, saveD, seedClassic);
    check('upgrade: double burner gives two pans', stD.pans.length === 2);
    check('upgrade: base game has one pan', UC.createDay(0, 1, save, 1).pans.length === 1);
    UC.tapBin(stD, 'bun_bottom');
    UC.tapBin(stD, 'patty');
    /* patty is cooking on pan0; pre-cook another on pan1 via burner */
    res = UC.tapPan(stD, 1);
    check('cook: second pan idle until a patty lands', res.code === 'none');

    /* ============ oven (pizza) ============ */
    var stP = UC.createDay(1, 1, save, 5001);
    var pitems = stP.active.order.items;
    UC.tapBin(stP, pitems[0]);
    res = UC.startBake(stP);
    check('oven: cannot bake mid-assembly', res.code === 'busy');
    assembleUntilFrost(stP);
    check('oven: assembled pizza awaits oven', stP.plate.phase === 'oven');
    res = UC.startBake(stP);
    check('oven: baking starts', res.code === 'baking' && stP.plate.phase === 'baking' && stP.oven.phase === 'baking');
    stP.oven.t = stP.oven.T * 0.2;
    res = UC.pullOven(stP);
    check('oven: early pull penalizes', res.code === 'ovenDone' && res.result === 'early' && stP.plate.quality < UC.QUALITY_BASE);
    UC.trashPlate(stP);
    check('oven: trash resets assembly for rebuild', stP.plate.expected === 0 && stP.oven === null);
    assembleUntilFrost(stP);
    UC.startBake(stP);
    var ovgc = (stP.oven.greenA + stP.oven.greenB) / 2;
    stP.oven.t = stP.oven.T * ovgc;
    res = UC.pullOven(stP);
    check('oven: green-zone pull is PERFECT', res.result === 'perfect' && stP.plate.phase === 'complete');
    var stP2 = UC.createDay(1, 1, save, 5002);
    assembleUntilFrost(stP2);
    UC.startBake(stP2);
    UC.dayTick(stP2, stP2.oven.T * 1.2);
    check('oven: forgotten pizza burns', stP2.oven.phase === 'burnt' && stP2.plate.phase === 'burnt');
    res = UC.trashPlate(stP2);
    check('oven: trash clears burnt pizza', res.code === 'trashed' && stP2.oven === null && stP2.plate.expected === 0);

    /* ============ frosting ============ */
    var stF = UC.createDay(3, 1, save, 6001);
    var fitems = stF.active.order.items;
    var frostIdx = fitems.indexOf('frosting');
    check('dessert: cake has a frosting step', frostIdx >= 0);
    assembleUntilFrost(stF);
    check('dessert: assembly stops at frosting', stF.plate.expected === frostIdx && !stF.frost);
    res = UC.tapBin(stF, 'frosting');
    check('frost: hold step starts', res.code === 'frostStart' && !!stF.frost && !stF.frost.done);
    UC.setFrostHolding(stF, true);
    UC.dayTick(stF, 0.5);
    UC.setFrostHolding(stF, false);
    res = UC.releaseFrost(stF);
    check('frost: release before band keeps going', res.code === 'frostKeep' && !!stF.frost);
    UC.setFrostHolding(stF, true);
    var g3 = 0;
    while (stF.frost && !stF.frost.done && stF.frost.t < UC.FROST_BAND[0] + 0.05 && g3++ < 100) UC.dayTick(stF, 0.05);
    res = UC.releaseFrost(stF);
    check('frost: release in band is perfect (+combo point)', res.frost === 'perfect' && stF.combo.points >= 1);
    check('frost: frosting plated, cherry next',
      stF.plate.items[stF.plate.items.length - 1] === 'frosting' &&
      stF.active.order.items[stF.plate.expected] === 'cherry');
    var stF2 = UC.createDay(3, 1, save, 6002);
    assembleUntilFrost(stF2);
    UC.tapBin(stF2, 'frosting');
    UC.setFrostHolding(stF2, true);
    var guard = 0;
    while (stF2.frost && !stF2.frost.done && guard++ < 100) UC.dayTick(stF2, 0.1);
    check('frost: overflow penalizes', stF2.frost === null && stF2.plate.quality < UC.QUALITY_BASE + 10);

    /* ============ patience & walkouts ============ */
    var stW = UC.createDay(0, 1, save, 7001);
    var startPat = stW.active.patience;
    UC.dayTick(stW, 1);
    check('patience: decays over time', stW.active.patience < startPat);
    var saveR = UC.defaultSave(); saveR.upgrades.radio = 1;
    var stR = UC.createDay(0, 1, saveR, 7002);
    var stR2 = UC.createDay(0, 1, save, 7003);
    UC.dayTick(stR, 1); UC.dayTick(stR2, 1);
    check('upgrade: radio slows patience decay 15%',
      (stR.active.patienceMax - stR.active.patience) < (stR2.active.patienceMax - stR2.active.patience) * 0.9);
    var stT = UC.createDay(0, 1, save, 7004);
    var ticks = 0;
    while (!stT.finished && ticks < 10000) { UC.dayTick(stT, 0.5); ticks++; }
    check('patience: full neglect drains the day via walkouts',
      stT.finished && stT.walkouts === stT.n && stT.served === 0 && stT.coins === 0);

    /* ============ combo ============ */
    var combo = { points: 0, level: 1 };
    check('combo: starts at x1', combo.level === 1);
    UC.comboAddPoint(combo); UC.comboAddPoint(combo);
    check('combo: 2 points → x2', combo.level === 2);
    UC.comboAddPoint(combo); UC.comboAddPoint(combo);
    check('combo: 4 points → x3', combo.level === 3);
    UC.comboAddPoint(combo); UC.comboAddPoint(combo);
    check('combo: 6 points → x4', combo.level === 4);
    UC.comboAddPoint(combo); UC.comboAddPoint(combo);
    check('combo: 8 points → x5', combo.level === 5);
    UC.comboAddPoint(combo); UC.comboAddPoint(combo);
    check('combo: caps at x5 / 10 points', combo.level === 5 && combo.points === 10);
    UC.comboReset(combo);
    check('combo: mistake resets to x1', combo.level === 1 && combo.points === 0);
    check('combo: level thresholds', UC.comboLevelFromPoints(0) === 1 && UC.comboLevelFromPoints(5) === 3 && UC.comboLevelFromPoints(9) === 5);

    /* ============ rewards ============ */
    var rw1 = UC.computeReward({ base: 18, quality: 100, patienceFrac: 0.8, combo: 1 });
    var rw5 = UC.computeReward({ base: 18, quality: 100, patienceFrac: 0.8, combo: 5 });
    check('tip: scales with combo', rw5.tip > rw1.tip * 2);
    var rwq1 = UC.computeReward({ base: 18, quality: 40, patienceFrac: 0.8, combo: 1 });
    var rwq2 = UC.computeReward({ base: 18, quality: 95, patienceFrac: 0.8, combo: 1 });
    check('tip: quality scales tips', rwq2.tip > rwq1.tip * 1.5);
    var rws1 = UC.computeReward({ base: 18, quality: 90, patienceFrac: 0.1, combo: 1 });
    var rws2 = UC.computeReward({ base: 18, quality: 90, patienceFrac: 0.95, combo: 1 });
    check('tip: speed scales tips', rws2.tip > rws1.tip);
    var rwg1 = UC.computeReward({ base: 18, quality: 90, patienceFrac: 0.8, combo: 2 });
    var rwg2 = UC.computeReward({ base: 18, quality: 90, patienceFrac: 0.8, combo: 2, golden: true });
    check('upgrade: golden plate adds 10% tips', rwg2.tip >= Math.round(rwg1.tip * 1.1) - 1 && rwg2.tip > rwg1.tip);
    check('reward: coins = base + tip', rw1.coins === 18 + rw1.tip);
    check('quality: clamps to 5..100', (function () {
      var p = { quality: 100 }; UC.qualityAdd(p, -500); if (p.quality !== 5) return false;
      UC.qualityAdd(p, 999); return p.quality === 100;
    })());

    /* ============ stars ============ */
    check('stars: 3 for perfect day', UC.dayStars(6, 6, 999, 700) === 3);
    check('stars: 2 for solid day', UC.dayStars(6, 6, 600, 700) === 2);
    check('stars: 1 for passable day', UC.dayStars(4, 6, 200, 700) === 1);
    check('stars: 0 for bad day', UC.dayStars(2, 6, 100, 700) === 0);
    check('stars: all served but broke → capped at 1', UC.dayStars(6, 6, 300, 700) === 1);

    /* ============ upgrades & shop ============ */
    check('upgrade: costs ascend per tier', UC.upgradeCost('knife', 0) === 50 && UC.upgradeCost('knife', 1) === 140 && UC.upgradeCost('knife', 2) === 320);
    check('upgrade: maxed returns null', UC.upgradeCost('knife', 3) === null && UC.upgradeMaxed('burner', 1) === true);
    check('upgrade: unknown id → null', UC.upgradeCost('nope', 0) === null);
    var sv = UC.defaultSave();
    sv.coins = 100;
    check('shop: buy deducts coins', UC.buyUpgrade(sv, 'radio') === true && sv.coins === 10 && sv.upgrades.radio === 1);
    check('shop: cannot buy when broke', UC.buyUpgrade(sv, 'radio') === false && sv.coins === 10);
    check('shop: cannot buy unknown', UC.buyUpgrade(sv, 'zap') === false);
    sv.coins = 1000;
    check('shop: knife tiers buy out', (function () {
      var ok = UC.buyUpgrade(sv, 'knife') && sv.upgrades.knife === 1;
      ok = ok && UC.buyUpgrade(sv, 'knife') && sv.upgrades.knife === 2;
      ok = ok && UC.buyUpgrade(sv, 'knife') && sv.upgrades.knife === 3;
      return ok && UC.upgradeMaxed('knife', sv.upgrades.knife);
    })());

    /* ============ save ============ */
    var s0 = UC.defaultSave();
    s0.coins = 555; s0.muted = true; s0.tutorialDone = true;
    s0.restaurants[0].stars = 7; s0.restaurants[0].day = 3;
    s0.upgrades.cat = 1; s0.upgrades.knife = 2;
    var s1 = UC.deserialize(UC.serialize(s0));
    check('save: roundtrip keeps coins/stars/upgrades/flags',
      s1.coins === 555 && s1.muted === true && s1.tutorialDone === true &&
      s1.restaurants[0].stars === 7 && s1.restaurants[0].day === 3 &&
      s1.upgrades.cat === 1 && s1.upgrades.knife === 2);
    check('save: garbage falls back to defaults', (function () {
      var d = UC.deserialize('{{{not json');
      return d.coins === 0 && d.restaurants[0].day === 1 && d.upgrades.knife === 0;
    })());
    check('save: partial/old save merges safely', (function () {
      var d = UC.deserialize('{"v":1,"coins":42}');
      return d.coins === 42 && d.restaurants.length === 4 && d.upgrades.radio === 0;
    })());
    check('save: negative/invalid values sanitized', (function () {
      var d = UC.deserialize('{"v":1,"coins":-9,"upgrades":{"knife":99}}');
      return d.coins === 0 && d.upgrades.knife === 3;
    })());

    /* ============ unlock gates ============ */
    var sv2 = UC.defaultSave();
    check('gates: L1 always unlocked', UC.isUnlocked(sv2, 0) === true);
    check('gates: L2 locked at 0 stars', UC.isUnlocked(sv2, 1) === false);
    sv2.restaurants[0].stars = 5;
    check('gates: L2 unlocks at 5 stars', UC.isUnlocked(sv2, 1) === true && UC.isUnlocked(sv2, 2) === false);
    sv2.restaurants[0].stars = 12;
    check('gates: L3 unlocks at 12 stars', UC.isUnlocked(sv2, 2) === true && UC.isUnlocked(sv2, 3) === false);
    sv2.restaurants[1].stars = 8;
    check('gates: L4 unlocks at 20 total', UC.isUnlocked(sv2, 3) === true);
    check('gates: totalStars sums restaurants', UC.totalStars(sv2) === 20);

    /* ============ mess / trash / serve rules ============ */
    var stM = UC.createDay(0, 1, save, seedGarden);
    UC.tapBin(stM, 'bun_bottom');
    var qBefore = stM.plate.quality;
    res = UC.tapBin(stM, 'cheese');
    if (stM.active.order.items.indexOf('cheese') < 0 || stM.plate.expected !== stM.active.order.items.indexOf('cheese')) {
      check('mess: wrong bin makes a mess (quality down, combo reset)',
        res.code === 'wrong' && stM.plate.mess === 1 && stM.plate.quality < qBefore);
    }
    res = UC.servePlate(stM);
    check('serve: rejected before order complete', res.code === 'notReady' && stM.served === 0);
    res = UC.trashPlate(stM);
    check('trash: resets plate, mess and quality', res.code === 'trashed' &&
      stM.plate.items.length === 0 && stM.plate.mess === 0 && stM.plate.quality === UC.QUALITY_BASE);

    var stG = UC.createDay(0, 1, save, seedGarden);
    assembleUntilFrost(stG);
    check('serve: full stack completes the order', stG.plate.phase === 'complete');
    res = UC.servePlate(stG);
    check('serve: pays coins and moves the queue',
      res.code === 'served' && res.coins > 0 && stG.coins > 0 && stG.served === 1 && stG.idx === 1);
    check('serve: combo point for fast serve', res.fast === true && stG.combo.points >= 1);
    check('serve: plate cleared for next customer', stG.plate.items.length === 0 && stG.plate.expected === 0);

    /* ============ cat assistant ============ */
    var saveCat = UC.defaultSave(); saveCat.upgrades.cat = 1;
    var stCat = UC.createDay(0, 1, saveCat, seedGarden);
    UC.tapBin(stCat, 'bun_bottom');
    res = UC.tapBin(stCat, 'lettuce');
    check('upgrade: cat auto-chops first veg instantly',
      res.cat === true && stCat.plate.items[1] === 'lettuce' && stCat.board === null);
    res = UC.tapBin(stCat, 'tomato');
    check('upgrade: cat only helps once per order', res.code === 'toBoard' && !!stCat.board);

    /* ================================================================
     * MC ACTION BAR MANDATE TESTS
     * ================================================================ */
    check('mc: shared module loads', !!MC && typeof MC.isTouchDevice === 'function');
    if (MC) {
      check('mc: isTouchDevice true for touch nav', MC.isTouchDevice({ maxTouchPoints: 5 }) === true);
      check('mc: isTouchDevice true for mobile UA', MC.isTouchDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }) === true);
      check('mc: isTouchDevice false for desktop nav',
        MC.isTouchDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 }) === false);
      check('mc: isTouchDevice false for null nav', MC.isTouchDevice(null) === false);
    }
    check('mc: mount gating — touch device at any width',
      UC.shouldMountActionBar({ maxTouchPoints: 5 }, 1400) === true);
    check('mc: mount gating — desktop wide screen stays off',
      UC.shouldMountActionBar({ userAgent: 'Mozilla/5.0 (X11; Linux)', maxTouchPoints: 0 }, 1400) === false);
    check('mc: mount gating — narrow screen (<820px) mounts even on desktop',
      UC.shouldMountActionBar({ userAgent: 'Mozilla/5.0 (X11; Linux)', maxTouchPoints: 0 }, 390) === true);

    check('mc: bindings cover chop/flip/serve', (function () {
      var b = UC.MC_BINDINGS;
      return b.chop === 'chop' && b.flip === 'flip' && b.serve === 'serve' &&
        Object.keys(b).length === 3;
    })());

    /* spy equality: MC buttons and direct 3D taps hit the SAME core fns */
    var spies = { board: 0, pan: 0, serve: 0 };
    var origBoard = UC.tapBoard, origPan = UC.tapPan, origServe = UC.servePlate;
    UC.tapBoard = function (s) { spies.board++; return origBoard(s); };
    UC.tapPan = function (s, idx) { spies.pan++; return origPan(s, idx); };
    UC.servePlate = function (s) { spies.serve++; return origServe(s); };
    check('mc: actionImpl maps to the exact core functions',
      UC.actionImpl('chop') === UC.tapBoard &&
      UC.actionImpl('flip') === UC.tapPan &&
      UC.actionImpl('serve') === UC.servePlate &&
      UC.actionImpl('nope') === null);

    var stMC = UC.createDay(0, 1, save, seedGarden);
    UC.tapBin(stMC, 'bun_bottom');
    UC.tapBin(stMC, 'lettuce');
    var progA = stMC.board.progress;
    UC.dispatch(stMC, 'chop', 1);   /* MC button path */
    UC.tapBoard(stMC);              /* direct 3D path (same wrapped core fn) */
    check('mc: CHOP button and board tap both advance chop via tapBoard',
      spies.board === 2 && stMC.board.progress === progA + 2 * UC.knifeMult(save));
    var twin1 = UC.createDay(0, 1, save, seedGarden);
    UC.tapBin(twin1, 'bun_bottom'); UC.tapBin(twin1, 'lettuce');
    UC.dispatch(twin1, 'chop', 1);
    var twin2 = UC.createDay(0, 1, save, seedGarden);
    UC.tapBin(twin2, 'bun_bottom'); UC.tapBin(twin2, 'lettuce');
    UC.tapBoard(twin2);
    check('mc: one button press ≡ one board tap (identical state effect)',
      twin1.board.progress === twin2.board.progress);

    var stFL = UC.createDay(0, 1, save, seedClassic);
    UC.tapBin(stFL, 'bun_bottom'); UC.tapBin(stFL, 'patty');
    UC.dayTick(stFL, stFL.pans[0].T * 0.28);
    stFL.pans[0].pos = 0.5;
    var rMC = UC.dispatch(stFL, 'flip', 2, { pan: 0 });
    check('mc: FLIP button routes through tapPan', rMC.code === 'flipPerfect' && spies.pan === 1);
    check('mc: activePanIndex targets the cooking pan', UC.activePanIndex(stFL) === 0);

    var twinA = UC.createDay(0, 1, save, seedGarden);
    assembleUntilFrost(twinA);
    rMC = UC.dispatch(twinA, 'serve', 3);
    check('mc: SERVE button routes through servePlate', rMC.code === 'served' && spies.serve === 1);

    /* no double-advance when both paths fire the same frame */
    var stDD = UC.createDay(0, 1, save, seedGarden);
    UC.tapBin(stDD, 'bun_bottom'); UC.tapBin(stDD, 'lettuce');
    var progBefore = stDD.board.progress;
    UC.dispatch(stDD, 'chop', 42);   /* board tap */
    var dupRes = UC.dispatch(stDD, 'chop', 42); /* button same frame */
    check('mc: same-frame duplicate action is ignored (no double-advance)',
      stDD.board.progress === progBefore + UC.knifeMult(save) && dupRes.code === 'dup');
    UC.dispatch(stDD, 'chop', 43);
    check('mc: new frame accepts the action again',
      stDD.board.progress === progBefore + 2 * UC.knifeMult(save));
    UC.tapBoard = origBoard; UC.tapPan = origPan; UC.servePlate = origServe;

    /* contextual visibility state machine */
    var stV = UC.createDay(0, 1, save, seedClassic);
    var vis = UC.buttonVisibility(stV);
    check('mc visibility: nothing needed at order start', vis.chop === false && vis.flip === false && vis.serve === false);
    UC.tapBin(stV, 'bun_bottom');
    vis = UC.buttonVisibility(stV);
    check('mc visibility: still nothing while plating ready items', vis.chop === false && vis.serve === false);
    UC.tapBin(stV, 'patty');
    vis = UC.buttonVisibility(stV);
    check('mc visibility: FLIP shows while pan is sizzling', vis.flip === true && vis.chop === false && vis.serve === false);
    UC.dayTick(stV, stV.pans[0].T + 0.1);
    UC.dayTick(stV, stV.pans[0].T);
    vis = UC.buttonVisibility(stV);
    check('mc visibility: FLIP hides when pan is ready', vis.flip === false);
    UC.tapPan(stV, 0);
    UC.tapBin(stV, 'lettuce');
    vis = UC.buttonVisibility(stV);
    check('mc visibility: CHOP shows during chop phase only',
      vis.chop === true && vis.flip === false && vis.serve === false);
    while (stV.board) UC.tapBoard(stV);
    vis = UC.buttonVisibility(stV);
    check('mc visibility: CHOP hides when veg plated', vis.chop === false);
    assembleUntilFrost(stV);
    vis = UC.buttonVisibility(stV);
    check('mc visibility: SERVE shows only when plate is ready', vis.serve === true);
    UC.servePlate(stV);
    vis = UC.buttonVisibility(stV);
    check('mc visibility: all hidden after serve (fresh order)', vis.serve === false && vis.chop === false && vis.flip === false);
    check('mc visibility: nothing shows when day finished', (function () {
      var f = UC.buttonVisibility({ finished: true });
      return f.chop === false && f.flip === false && f.serve === false;
    })());
    check('mc visibility: sushi has no FLIP (no pans)', UC.buttonVisibility(UC.createDay(2, 1, save, 3001)).flip === false);

    /* ================================================================
     * FULL DAY SIMULATIONS (playtest bots)
     * ================================================================ */
    function simCase(rid, name) {
      var svSim = UC.defaultSave();
      var out = simulateDay(rid, 1, svSim, 77 + rid * 13, 0.05);
      var s = out.st;
      var sum = UC.finishDay(s);
      check('sim ' + name + ': day completes, queue drains',
        s.finished === true && s.idx === s.n && out.ticks < 390000);
      check('sim ' + name + ': every customer served, none walked',
        s.served === s.n && s.walkouts === 0);
      check('sim ' + name + ': revenue > 0', s.coins > 0);
      check('sim ' + name + ': stars earned ≥ 1', sum.stars >= 1);
      check('sim ' + name + ': summary math consistent',
        sum.served === s.served && sum.total === s.n && sum.coins === s.coins);
    }
    simCase(0, 'L1 Diner');
    simCase(1, 'L2 Pizzeria');
    simCase(2, 'L3 Sushi Bar');
    simCase(3, 'L4 Dessert Café');

    (function () {
      var sv5 = UC.defaultSave();
      var out5 = simulateDay(0, 5, sv5, 555, 0.05);
      check('sim L1 day5: harder day still completable', out5.st.finished && out5.st.walkouts === 0);
    })();

    (function () {
      var svN = UC.defaultSave();
      var s = UC.createDay(0, 1, svN, 123);
      var t = 0;
      while (!s.finished && t < 100000) { UC.dayTick(s, 0.5); t++; }
      check('sim neglect: all customers storm off, day ends cleanly',
        s.finished && s.walkouts === s.n && s.idx === s.n);
      var sum = UC.finishDay(s);
      check('sim neglect: zero stars and zero revenue', sum.stars === 0 && sum.coins === 0);
    })();

    (function () {
      var svA = UC.defaultSave();
      var outA = simulateDay(0, 1, svA, 77, 0.05);
      var sumA = UC.finishDay(outA.st);
      var before = svA.coins;
      UC.applyDayResult(svA, sumA);
      check('progress: day result adds coins', svA.coins === before + sumA.coins);
      check('progress: stars recorded', svA.restaurants[0].stars === sumA.stars);
      check('progress: day advances on success', svA.restaurants[0].day === 2);
      check('progress: expected revenue formula sane', sumA.expected > 0 && sumA.expected < sumA.coins * 3);
    })();

    return { passed: passed, failed: failed, failures: failures };
  }

  var API = { run: run, botAct: botAct, simulateDay: simulateDay, assembleUntilFrost: assembleUntilFrost };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.UCTests = API;
})();
