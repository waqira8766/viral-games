/* ============================================================
 * ULTIMATE COOKING — js/logic-core.js
 * PART 1: pure game logic. No DOM, no THREE, no audio.
 * Node-testable; consumed by the three.js view and by tests.
 * ============================================================ */
(function () {
  'use strict';

  var UC = {};

  UC.VERSION = 1;
  UC.SAVE_KEY = 'ultimate_cooking_v1';

  /* ---------------- helpers ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* ---------------- RNG (seeded, deterministic) ---------------- */
  UC.makeRNG = function (seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  function pick(rng, arr) { return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]; }
  function pickWeighted(rng, list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].w;
    var r = rng() * total;
    for (i = 0; i < list.length; i++) { r -= list[i].w; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }

  /* ---------------- ingredient table ----------------
   * prep: null = ready | 'chop' = rhythm taps | 'pchop' = precision window chops
   *       'cook' = pan + flip windows | 'frost' = hold-to-frost
   * chops: taps needed at knife tier 0. */
  UC.ING = {
    bun_bottom: { label: 'Bun',      color: 0xF2C14E, prep: null },
    bun_top:    { label: 'Bun',      color: 0xF7CB6A, prep: null },
    patty:      { label: 'Patty',    color: 0x8C5A33, prep: 'cook' },
    lettuce:    { label: 'Lettuce', color: 0x7BC950, prep: 'chop', chops: 4 },
    tomato:     { label: 'Tomato',   color: 0xFF5A4E, prep: 'chop', chops: 4 },
    cheese:     { label: 'Cheese',   color: 0xFFC93C, prep: null },

    dough:      { label: 'Dough',     color: 0xF0D9A8, prep: null },
    sauce:      { label: 'Sauce',     color: 0xE23E2B, prep: null },
    cheese_p:   { label: 'Cheese',    color: 0xFFC93C, prep: null },
    pepperoni:  { label: 'Pepperoni', color: 0xD4452B, prep: null },
    mushroom:   { label: 'Mushroom',  color: 0xCBB49B, prep: 'chop', chops: 4 },
    pepper:     { label: 'Pepper',    color: 0x2FA84F, prep: 'chop', chops: 4 },
    olive:      { label: 'Olives',    color: 0x4A3B2A, prep: null },

    nori:       { label: 'Nori',    color: 0x2E4034, prep: null },
    rice:       { label: 'Rice',     color: 0xFDF6E3, prep: null },
    salmon:     { label: 'Fish',    color: 0xFF8A6B, prep: 'pchop', chops: 3 },
    avocado:    { label: 'Avocado',  color: 0x6FA84C, prep: 'chop', chops: 3 },
    cucumber:   { label: 'Cucumber', color: 0x5FB56B, prep: 'chop', chops: 3 },

    sponge:     { label: 'Sponge', color: 0xF2C77E, prep: null },
    cream:      { label: 'Cream',  color: 0xFFF7EA, prep: null },
    chocolate:  { label: 'Choco',  color: 0x6B4226, prep: null },
    strawberry: { label: 'Berry',  color: 0xE8344E, prep: 'chop', chops: 3 },
    frosting:   { label: 'Frost',  color: 0xFFB7D5, prep: 'frost' },
    cherry:     { label: 'Cherry', color: 0xE8344E, prep: null }
  };

  /* ---------------- restaurants ---------------- */
  UC.RESTAURANTS = [
    {
      id: 'diner', name: 'Sunny Diner', tag: 'Burgers & smiles',
      unlockStars: 0, basePrice: 12, patience: 42, cookT: 5.0, ovenT: 0,
      pans: 1, oven: false,
      menu: [
        { id: 'classic', w: 30, items: ['bun_bottom', 'patty', 'lettuce', 'tomato', 'bun_top'] },
        { id: 'cheese',  w: 25, items: ['bun_bottom', 'patty', 'cheese', 'bun_top'] },
        { id: 'deluxe',  w: 18, items: ['bun_bottom', 'patty', 'lettuce', 'tomato', 'cheese', 'bun_top'] },
        { id: 'garden',  w: 15, items: ['bun_bottom', 'lettuce', 'tomato', 'cheese', 'bun_top'] },
        { id: 'double',  w: 12, items: ['bun_bottom', 'patty', 'patty', 'cheese', 'bun_top'] }
      ]
    },
    {
      id: 'pizza', name: "Mama's Pizzeria", tag: 'Wood-fire oven',
      unlockStars: 5, basePrice: 16, patience: 48, cookT: 0, ovenT: 4.2,
      pans: 0, oven: true,
      menu: [
        { id: 'margherita', w: 22, items: ['dough', 'sauce', 'cheese_p'] },
        { id: 'pepperoni',  w: 25, items: ['dough', 'sauce', 'cheese_p', 'pepperoni'] },
        { id: 'veggie',     w: 20, items: ['dough', 'sauce', 'cheese_p', 'mushroom', 'pepper'] },
        { id: 'funghi',     w: 15, items: ['dough', 'sauce', 'cheese_p', 'mushroom', 'olive'] },
        { id: 'everything', w: 18, items: ['dough', 'sauce', 'cheese_p', 'pepperoni', 'mushroom', 'pepper'] }
      ]
    },
    {
      id: 'sushi', name: 'Sakura Sushi', tag: 'Precision rolls',
      unlockStars: 12, basePrice: 20, patience: 45, cookT: 0, ovenT: 0,
      pans: 0, oven: false,
      menu: [
        { id: 'salmon',   w: 25, items: ['nori', 'rice', 'salmon'] },
        { id: 'cali',     w: 22, items: ['nori', 'rice', 'salmon', 'avocado'] },
        { id: 'cucumber', w: 20, items: ['nori', 'rice', 'cucumber'] },
        { id: 'avocado',  w: 12, items: ['nori', 'rice', 'avocado'] },
        { id: 'chefs',    w: 15, items: ['nori', 'rice', 'salmon', 'avocado', 'cucumber'] }
      ]
    },
    {
      id: 'dessert', name: 'Sugar Cloud Café', tag: 'Cakes & frosting',
      unlockStars: 20, basePrice: 24, patience: 52, cookT: 0, ovenT: 0,
      pans: 0, oven: false,
      menu: [
        { id: 'berrycloud', w: 25, items: ['sponge', 'cream', 'strawberry', 'sponge', 'cream', 'frosting', 'cherry'] },
        { id: 'choclayer',  w: 22, items: ['sponge', 'chocolate', 'sponge', 'chocolate', 'sponge', 'frosting', 'cherry'] },
        { id: 'berrybloom', w: 18, items: ['sponge', 'cream', 'strawberry', 'cream', 'strawberry', 'frosting', 'cherry'] },
        { id: 'triple',     w: 15, items: ['sponge', 'chocolate', 'cream', 'chocolate', 'cream', 'sponge', 'frosting', 'cherry'] }
      ]
    }
  ];

  var NAMES = ['Pip', 'Momo', 'Waffle', 'Biscuit', 'Sunny', 'Peanut', 'Clover', 'Miso',
    'Pudding', 'Basil', 'Poppy', 'Ginger', 'Noodle', 'Bean', 'Cocoa', 'Sprout',
    'Olive', 'Peaches', 'Dumpling', 'Tofu'];

  /* unique ingredient ids used by a restaurant (for the bin row) */
  UC.restIngredients = function (rid) {
    var rest = UC.RESTAURANTS[rid], seen = {}, out = [], i, j;
    for (i = 0; i < rest.menu.length; i++) {
      var items = rest.menu[i].items;
      for (j = 0; j < items.length; j++) {
        if (!seen[items[j]]) { seen[items[j]] = 1; out.push(items[j]); }
      }
    }
    return out;
  };

  /* ---------------- order generation ---------------- */
  UC.orderPrice = function (rid, tpl) {
    return Math.round(UC.RESTAURANTS[rid].basePrice + tpl.items.length * 1.2);
  };

  UC.generateOrder = function (rid, rng) {
    var tpl = pickWeighted(rng, UC.RESTAURANTS[rid].menu);
    return { id: tpl.id, items: tpl.items.slice(), price: UC.orderPrice(rid, tpl) };
  };

  /* ---------------- day / customer generation ---------------- */
  UC.dayCustomerCount = function (day) { return Math.min(10, 5 + day); };

  UC.dayDifficulty = function (rid, day) {
    var rest = UC.RESTAURANTS[rid];
    return {
      patience: rest.patience * Math.max(0.55, 1 - (day - 1) * 0.06),
      zoneScale: Math.max(0.55, 1 - (day - 1) * 0.05)
    };
  };

  UC.genCustomer = function (rid, day, rng, i) {
    var rest = UC.RESTAURANTS[rid];
    var order = UC.generateOrder(rid, rng);
    var moodRoll = rng();
    var mood = moodRoll < 0.2 ? 'chill' : (moodRoll > 0.85 ? 'hasty' : 'normal');
    var mult = mood === 'chill' ? 1.2 : (mood === 'hasty' ? 0.82 : 1.0);
    var pMax = UC.dayDifficulty(rid, day).patience * mult;
    return {
      i: i, name: pick(rng, NAMES), mood: mood,
      order: order,
      patienceMax: pMax, patience: pMax,
      tipBias: round1(0.9 + rng() * 0.2),
      look: {
        hat: Math.floor(rng() * 5), head: Math.floor(rng() * 3),
        body: Math.floor(rng() * 6), hue: rng()
      }
    };
  };

  /* ---------------- combo ---------------- */
  UC.comboLevelFromPoints = function (p) {
    return p >= 8 ? 5 : p >= 6 ? 4 : p >= 4 ? 3 : p >= 2 ? 2 : 1;
  };
  UC.comboAddPoint = function (c) {
    c.points = Math.min(10, c.points + 1);
    var before = c.level;
    c.level = UC.comboLevelFromPoints(c.points);
    return c.level > before ? c.level : 0; /* returns new level on level-up else 0 */
  };
  UC.comboReset = function (c) { c.points = 0; c.level = 1; };

  /* ---------------- quality ---------------- */
  UC.QUALITY_BASE = 75;
  UC.qualityAdd = function (plate, delta) {
    plate.quality = clamp(plate.quality + delta, 5, 100);
  };

  /* ---------------- rewards ---------------- */
  UC.computeReward = function (o) {
    var qualityF = clamp01(o.quality / 100);
    var speedF = 0.35 + 0.65 * clamp01(o.patienceFrac);
    var tip = o.base * 0.7 * (0.25 + 0.75 * qualityF) * speedF * (o.combo || 1);
    if (o.golden) tip *= 1.1;
    tip = Math.round(tip);
    return { coins: o.base + tip, tip: tip };
  };

  /* ---------------- stars ---------------- */
  UC.dayStars = function (served, total, coins, expected) {
    if (total <= 0) return 0;
    var ratio = served / total;
    if (ratio >= 0.999 && coins >= expected) return 3;
    if (ratio >= 0.85 && coins >= expected * 0.8) return 2;
    if (ratio >= 0.6) return 1;
    return 0;
  };

  /* ---------------- upgrades ---------------- */
  UC.UPGRADES = {
    knife:     { name: 'Sharper Knife',  desc: 'Fewer chops per veg',      tiers: [{ cost: 50, mult: 1.4 }, { cost: 140, mult: 1.8 }, { cost: 320, mult: 2.4 }] },
    burner:    { name: 'Double Burner',  desc: 'Cook two patties at once', tiers: [{ cost: 120 }] },
    shoes:     { name: 'Speed Shoes',    desc: 'Plates slide out faster',  tiers: [{ cost: 80 }] },
    cat:       { name: 'Assistant Cat',  desc: 'Auto-chops 1 veg per order', tiers: [{ cost: 200 }] },
    goldplate: { name: 'Golden Plate',   desc: '+10% tips',                tiers: [{ cost: 150 }] },
    radio:     { name: 'Kitchen Radio', desc: 'Customers wait 15% longer', tiers: [{ cost: 90 }] }
  };

  UC.upgradeCost = function (id, level) {
    var u = UC.UPGRADES[id];
    if (!u) return null;
    return level < u.tiers.length ? u.tiers[level].cost : null;
  };
  UC.upgradeMaxed = function (id, level) { return UC.upgradeCost(id, level) === null; };
  /* chop power per tap: level 0 = base 1.0; each purchased tier multiplies */
  UC.knifeMult = function (save) {
    var lv = clamp(save.upgrades.knife, 0, 3);
    if (lv === 0) return 1;
    return UC.UPGRADES.knife.tiers[lv - 1].mult;
  };

  UC.buyUpgrade = function (save, id) {
    var level = save.upgrades[id];
    if (level === undefined) return false;
    var cost = UC.upgradeCost(id, level);
    if (cost === null || save.coins < cost) return false;
    save.coins -= cost;
    save.upgrades[id] = level + 1;
    return true;
  };

  /* ---------------- save ---------------- */
  UC.defaultSave = function () {
    return {
      v: UC.VERSION, coins: 0, muted: false, tutorialDone: false, current: 0,
      restaurants: [
        { stars: 0, day: 1 }, { stars: 0, day: 1 },
        { stars: 0, day: 1 }, { stars: 0, day: 1 }
      ],
      upgrades: { knife: 0, burner: 0, shoes: 0, cat: 0, goldplate: 0, radio: 0 }
    };
  };

  UC.serialize = function (save) { return JSON.stringify(save); };

  UC.deserialize = function (str) {
    var d = UC.defaultSave();
    if (typeof str !== 'string' || !str) return d;
    var o;
    try { o = JSON.parse(str); } catch (e) { return d; }
    if (!o || typeof o !== 'object') return d;
    if (typeof o.coins === 'number' && isFinite(o.coins) && o.coins >= 0) d.coins = Math.floor(o.coins);
    if (typeof o.muted === 'boolean') d.muted = o.muted;
    if (typeof o.tutorialDone === 'boolean') d.tutorialDone = o.tutorialDone;
    if (typeof o.current === 'number' && o.current >= 0 && o.current < 4) d.current = Math.floor(o.current);
    if (Array.isArray(o.restaurants)) {
      for (var i = 0; i < 4; i++) {
        var r = o.restaurants[i];
        if (r && typeof r === 'object') {
          if (typeof r.stars === 'number' && r.stars >= 0) d.restaurants[i].stars = Math.floor(r.stars);
          if (typeof r.day === 'number' && r.day >= 1) d.restaurants[i].day = Math.floor(r.day);
        }
      }
    }
    if (o.upgrades && typeof o.upgrades === 'object') {
      var keys = Object.keys(d.upgrades);
      for (var k = 0; k < keys.length; k++) {
        var v = o.upgrades[keys[k]];
        if (typeof v === 'number' && v >= 0) d.upgrades[keys[k]] = Math.floor(Math.min(v, 3));
      }
    }
    return d;
  };

  UC.totalStars = function (save) {
    var s = 0;
    for (var i = 0; i < save.restaurants.length; i++) s += save.restaurants[i].stars;
    return s;
  };
  UC.isUnlocked = function (save, rid) {
    if (rid <= 0) return true;
    return UC.totalStars(save) >= UC.RESTAURANTS[rid].unlockStars;
  };

  /* apply a finished day's summary to the save */
  UC.applyDayResult = function (save, summary) {
    save.coins += summary.coins;
    var r = save.restaurants[summary.rid];
    r.stars += summary.stars;
    if (summary.stars > 0) r.day = summary.day + 1;
    return save;
  };

  /* ================================================================
   * DAY STATE MACHINE (headless-playable)
   * ================================================================ */
  UC.COOK_HOLD = 6;      /* seconds a ready patty survives before burning */
  UC.PCHOP_PERIOD = 1.1; /* seconds per precision sweep */
  UC.FROST_RATE = 0.65;  /* frost meter fill per second while holding */
  UC.FROST_BAND = [0.5, 0.78];

  function freshPlate(st) {
    return { items: [], mess: 0, expected: 0, phase: 'build', quality: UC.QUALITY_BASE,
      completeAt: 0, rev: 0, hot: false };
  }
  function freshPan() { return { phase: 'empty' }; }

  UC.createDay = function (rid, day, save, seed, forceFirstMenuId) {
    var rest = UC.RESTAURANTS[rid];
    var rng = UC.makeRNG(seed);
    var diff = UC.dayDifficulty(rid, day);
    var n = UC.dayCustomerCount(day);
    var customers = [];
    for (var i = 0; i < n; i++) customers.push(UC.genCustomer(rid, day, rng, i));
    if (forceFirstMenuId) {
      for (var m = 0; m < rest.menu.length; m++) {
        if (rest.menu[m].id === forceFirstMenuId) {
          var tpl = rest.menu[m];
          customers[0].order = { id: tpl.id, items: tpl.items.slice(), price: UC.orderPrice(rid, tpl) };
          break;
        }
      }
    }
    var panCount = rest.pans === 0 ? 0 : (save.upgrades.burner > 0 ? 2 : 1);
    var pans = [];
    for (var p = 0; p < panCount; p++) pans.push(freshPan());
    var st = {
      rid: rid, day: day, rest: rest, n: n, customers: customers,
      idx: 0, active: customers[0] || null,
      plate: freshPlate(), board: null, pans: pans, oven: null,
      frost: null, frostHolding: false,
      combo: { points: 0, level: 1 },
      coins: 0, served: 0, walkouts: 0, finished: false, t: 0,
      up: save.upgrades, diff: diff, catUsed: false,
      zoneScale: diff.zoneScale, seed: seed,
      last: null,
      evts: { pan0: 0, pan1: 0, oven: 0, lap: false, walkout: false, frostOver: false },
      actFrames: { chop: -1, flip: -1, serve: -1 },
      _ev: { window: false, miss: false, ready: false, burnt: false }
    };
    return st;
  };

  /* expected ingredient def for the active order */
  UC.expectedItem = function (st) {
    if (!st.active) return null;
    var items = st.active.order.items;
    if (st.plate.expected >= items.length) return null;
    var id = items[st.plate.expected];
    return { id: id, def: UC.ING[id] };
  };

  function platePush(st, exp) {
    var plate = st.plate;
    plate.items.push(exp.id);
    plate.expected++;
    plate.rev++;
    if (plate.expected >= st.active.order.items.length) {
      if (st.rest.oven) { plate.phase = 'oven'; } else { plate.phase = 'complete'; }
      plate.completeAt = st.t;
      return 'orderComplete';
    }
    return 'placed';
  }

  function startCook(st, panIdx) {
    var pans = st.pans;
    var i = (panIdx === undefined || panIdx === null) ? -1 : panIdx;
    if (i < 0) { for (var j = 0; j < pans.length; j++) { if (pans[j].phase === 'empty') { i = j; break; } } }
    if (i < 0 || pans[i].phase !== 'empty') return { code: 'pansFull' };
    var T = st.rest.cookT;
    pans[i] = {
      phase: 'cooking', t: 0, T: T, ing: 'patty',
      windows: [
        { s: T * 0.28, e: T * 0.52, flipped: false, result: null },
        { s: T * 0.62, e: T * 0.86, flipped: false, result: null }
      ],
      wi: 0, windowOpen: false, pos: 0, green: 0.45 * st.zoneScale,
      hold: 0, side: 0
    };
    return { code: 'toPan', pan: i };
  }

  /* ---- pan cooking tick; returns evt code 0=none 1=windowOpen 2=ready 3=burnt 4=missedFlip */
  function panTick(pan, dt, st, evtOut) {
    if (pan.phase === 'cooking') {
      pan.t += dt;
      var w = pan.windows[pan.wi];
      if (w) {
        if (pan.t >= w.s && pan.t <= w.e) {
          pan.pos = (pan.t - w.s) / (w.e - w.s);
          if (!pan.windowOpen) { pan.windowOpen = true; if (evtOut) evtOut.window = true; }
        } else if (pan.t > w.e && !w.flipped) {
          w.flipped = true; w.result = 'miss';
          UC.qualityAdd(st.plate, -18);
          UC.comboReset(st.combo);
          pan.wi++; pan.windowOpen = false; pan.pos = 0;
          if (evtOut) evtOut.miss = true;
        }
      }
      if (pan.t >= pan.T) {
        pan.phase = 'ready'; pan.windowOpen = false; pan.hold = 0;
        if (evtOut) evtOut.ready = true;
      }
    } else if (pan.phase === 'ready') {
      pan.hold += dt;
      if (pan.hold > UC.COOK_HOLD) { pan.phase = 'burnt'; if (evtOut) evtOut.burnt = true; }
    }
    return 0;
  }

  function evtsForPan(st, i) { return i === 0 ? st.evts.pan0 : st.evts.pan1; }

  /* ---- walkout ---- */
  function walkout(st) {
    st.walkouts++;
    UC.comboReset(st.combo);
    st.plate = freshPlate();
    st.board = null;
    st.frost = null; st.frostHolding = false; st.catUsed = false;
    st.evts.walkout = true;
    advanceCustomer(st);
    st.last = { code: 'walkout' };
  }

  function advanceCustomer(st) {
    st.idx++;
    st.active = st.customers[st.idx] || null;
    if (!st.active) st.finished = true;
  }

  /* ---- day tick: patience, pans, oven, board sweeps, frosting ---- */
  UC.dayTick = function (st, dt) {
    if (st.finished) return;
    st.t += dt;
    var e = st.evts;
    e.pan0 = 0; e.pan1 = 0; e.oven = 0; e.lap = false; e.walkout = false; e.frostOver = false;

    /* patience */
    if (st.active) {
      var decay = dt / st.active.patienceMax;
      if (st.up.radio > 0) decay *= 0.85;
      st.active.patience -= decay * st.active.patienceMax;
      if (st.active.patience <= 0) {
        st.active.patience = 0;
        walkout(st);
        if (st.finished) return;
      }
    }

    /* pans (scratch event object reused — no per-frame allocation) */
    var ev = st._ev;
    for (var i = 0; i < st.pans.length; i++) {
      var pan = st.pans[i];
      if (pan.phase === 'empty') continue;
      ev.window = false; ev.miss = false; ev.ready = false; ev.burnt = false;
      panTick(pan, dt, st, ev);
      var code = ev.burnt ? 3 : (ev.ready ? 2 : (ev.miss ? 4 : (ev.window ? 1 : 0)));
      if (code) {
        if (i === 0) st.evts.pan0 = code; else st.evts.pan1 = code;
      }
    }

    /* oven */
    if (st.oven && st.oven.phase === 'baking') {
      var ov = st.oven;
      ov.t += dt;
      if (ov.t > ov.T * 1.18) {
        ov.phase = 'burnt'; ov.result = 'burnt';
        st.plate.phase = 'burnt';
        st.evts.oven = 1;
      }
    }

    /* precision chop sweep */
    if (st.board && st.board.kind === 'pchop') {
      var b = st.board;
      var prev = b.sweep;
      b.sweep = (b.sweep + dt / UC.PCHOP_PERIOD) % 1;
      if (b.sweep < prev && !b.justTapped) {
        /* completed a sweep without a tap → sloppy */
        UC.qualityAdd(st.plate, -6);
        UC.comboReset(st.combo);
        b.results.push('sloppy');
        b.si++;
        if (b.si >= b.slices) finishPchop(st);
        st.evts.lap = true;
      }
      b.justTapped = false;
    }

    /* frosting fill */
    if (st.frost && !st.frost.done && st.frostHolding) {
      st.frost.t = Math.min(1.05, st.frost.t + UC.FROST_RATE * dt);
      if (st.frost.t > 1.0) {
        st.frost.done = true; st.frost.result = 'over';
        UC.qualityAdd(st.plate, -12);
        st.evts.frostOver = true;
        finishFrost(st);
      }
    }
  };

  function finishPchop(st) {
    var id = st.board.ing;
    st.board = null;
    var exp = UC.expectedItem(st);
    st.last = { code: platePush(st, exp || { id: id }) };
  }

  function finishFrost(st) {
    var id = st.frost.ing;
    var result = st.frost.result;
    st.frost = null; st.frostHolding = false;
    var exp = UC.expectedItem(st);
    var code = platePush(st, exp || { id: id });
    st.last = { code: code, frost: result };
  }

  /* ---------------- actions ---------------- */

  /* tap an ingredient bin */
  UC.tapBin = function (st, ingId) {
    if (st.finished || !st.active) return { code: 'nobody' };
    var plate = st.plate;
    if (plate.phase === 'baking' || plate.phase === 'oven' || plate.phase === 'burnt') return { code: 'busy' };
    var exp = UC.expectedItem(st);
    if (!exp) return { code: 'busy' };

    if (ingId !== exp.id) {
      plate.mess++;
      UC.qualityAdd(plate, -16);
      UC.comboReset(st.combo);
      plate.rev++;
      return { code: 'wrong', ing: ingId };
    }

    var def = exp.def;
    /* cook: use a ready pan if we have one, else start one */
    if (def.prep === 'cook') {
      for (var i = 0; i < st.pans.length; i++) {
        if (st.pans[i].phase === 'ready') return { code: platePush(st, exp), from: 'pan', pan: i };
      }
      var r = startCook(st);
      st.last = r;
      return r;
    }
    if (def.prep === 'chop') {
      if (st.board) return { code: 'busy' };
      if (st.up.cat > 0 && !st.catUsed) {
        st.catUsed = true;
        st.last = { code: platePush(st, exp), cat: true };
        return st.last;
      }
      st.board = { kind: 'chop', ing: exp.id, progress: 0, needed: def.chops };
      return { code: 'toBoard', ing: exp.id };
    }
    if (def.prep === 'pchop') {
      if (st.board) return { code: 'busy' };
      st.board = {
        kind: 'pchop', ing: exp.id, si: 0, slices: def.chops,
        sweep: 0, zoneW: 0.22 * st.zoneScale, results: [], justTapped: false
      };
      return { code: 'toBoard', ing: exp.id, precision: true };
    }
    if (def.prep === 'frost') {
      if (st.frost) return { code: 'busy' };
      st.frost = { ing: exp.id, t: 0, done: false, result: null };
      return { code: 'frostStart' };
    }
    /* ready ingredient */
    st.last = { code: platePush(st, exp) };
    return st.last;
  };

  /* tap the cutting board (chop / precision chop) */
  UC.tapBoard = function (st) {
    if (st.finished || !st.active) return { code: 'nobody' };
    if (!st.board) {
      /* convenience: if the current item needs chopping, pull it to the board */
      var exp0 = UC.expectedItem(st);
      if (exp0 && (exp0.def.prep === 'chop' || exp0.def.prep === 'pchop')) {
        return UC.tapBin(st, exp0.id);
      }
      return { code: 'none' };
    }
    var b = st.board;
    if (b.kind === 'chop') {
      b.progress += UC.knifeMult({ upgrades: st.up }) || 1;
      b.rev = (b.rev || 0) + 1;
      if (b.progress >= b.needed) {
        var exp = UC.expectedItem(st);
        st.board = null;
        st.last = { code: platePush(st, exp || { id: b.ing }) };
        return st.last;
      }
      return { code: 'chop', progress: b.progress, needed: b.needed };
    }
    /* precision chop */
    var d = Math.abs(b.sweep - 0.5);
    var hit = d <= b.zoneW / 2;
    var res = hit ? 'perfect' : 'sloppy';
    if (hit) { UC.qualityAdd(st.plate, 6); UC.comboAddPoint(st.combo); }
    else { UC.qualityAdd(st.plate, -6); UC.comboReset(st.combo); }
    b.results.push(res);
    b.si++;
    b.justTapped = true;
    b.sweep = 0;
    if (b.si >= b.slices) { finishPchop(st); return st.last; }
    return { code: 'pslice', result: res, si: b.si, slices: b.slices };
  };

  /* tap a pan: flip while cooking, plate while ready, clear while burnt */
  UC.tapPan = function (st, i) {
    if (st.finished || !st.active) return { code: 'nobody' };
    var pan = st.pans[i];
    if (!pan || pan.phase === 'empty') return { code: 'none' };
    if (pan.phase === 'burnt') {
      st.pans[i] = freshPan();
      return { code: 'panCleared', pan: i };
    }
    if (pan.phase === 'cooking') {
      if (!pan.windowOpen) return { code: 'tooEarly', pan: i };
      var w = pan.windows[pan.wi];
      var d = Math.abs(pan.pos - 0.5);
      var perfect = d <= pan.green / 2;
      w.flipped = true;
      w.result = perfect ? 'perfect' : 'ok';
      if (perfect) { UC.qualityAdd(st.plate, 12); UC.comboAddPoint(st.combo); }
      pan.wi++;
      pan.windowOpen = false; pan.pos = 0;
      return { code: perfect ? 'flipPerfect' : 'flipOk', pan: i, side: pan.wi };
    }
    if (pan.phase === 'ready') {
      var exp = UC.expectedItem(st);
      if (exp && exp.id === pan.ing) {
        st.last = { code: platePush(st, exp), from: 'pan', pan: i };
        st.pans[i] = freshPan();
        return st.last;
      }
      return { code: 'notYet', pan: i };
    }
    return { code: 'none' };
  };

  /* pizza oven: start baking when the assembled pizza is on it */
  UC.startBake = function (st) {
    if (st.finished || !st.active) return { code: 'nobody' };
    if (st.plate.phase !== 'oven') return { code: 'busy' };
    st.oven = { phase: 'baking', t: 0, T: st.rest.ovenT, result: null,
      greenA: 0.7, greenB: 0.92, scale: st.zoneScale };
    st.plate.phase = 'baking';
    st.plate.rev++;
    return { code: 'baking' };
  };

  /* pull the pizza out of the oven */
  UC.pullOven = function (st) {
    if (st.finished || !st.active) return { code: 'nobody' };
    var ov = st.oven;
    if (!ov || ov.phase !== 'baking') return { code: 'none' };
    var p = ov.t / ov.T;
    var res, dq = 0;
    /* green zone shrinks around its center as days get harder */
    var gc = (ov.greenA + ov.greenB) / 2, gh = (ov.greenB - ov.greenA) / 2 * ov.scale;
    if (p >= gc - gh && p <= gc + gh) {
      res = 'perfect'; dq = 12; UC.comboAddPoint(st.combo);
    } else if (p < 0.55) { res = 'early'; dq = -10; UC.comboReset(st.combo); }
    else if (p > 0.97) { res = 'late'; dq = -14; UC.comboReset(st.combo); }
    else { res = 'ok'; dq = 0; }
    UC.qualityAdd(st.plate, dq);
    ov.phase = 'done'; ov.result = res;
    st.plate.phase = 'complete';
    st.plate.hot = true;
    st.plate.rev++;
    st.last = { code: 'ovenDone', result: res };
    return st.last;
  };

  /* frosting */
  UC.setFrostHolding = function (st, holding) {
    st.frostHolding = !!holding;
  };
  UC.releaseFrost = function (st) {
    if (st.finished || !st.active) return { code: 'nobody' };
    var f = st.frost;
    if (!f || f.done) return { code: 'none' };
    st.frostHolding = false;
    var t = f.t;
    if (t < UC.FROST_BAND[0]) return { code: 'frostKeep', t: t };
    if (t <= UC.FROST_BAND[1]) { f.result = 'perfect'; UC.qualityAdd(st.plate, 10); UC.comboAddPoint(st.combo); }
    else { f.result = 'over'; UC.qualityAdd(st.plate, -12); UC.comboReset(st.combo); }
    f.done = true;
    finishFrost(st);
    return st.last;
  };

  /* serve the plate to the active customer */
  UC.servePlate = function (st) {
    if (st.finished || !st.active) return { code: 'nobody' };
    var plate = st.plate;
    if (plate.phase !== 'complete' || plate.expected < st.active.order.items.length) {
      return { code: 'notReady' };
    }
    var c = st.active;
    var patFrac = clamp01(c.patience / c.patienceMax);
    var fast = patFrac >= 0.55 || (st.t - plate.completeAt) <= 3;
    if (fast) { UC.qualityAdd(plate, 5); UC.comboAddPoint(st.combo); }
    var reward = UC.computeReward({
      base: c.order.price,
      quality: plate.quality,
      patienceFrac: patFrac,
      combo: st.combo.level,
      golden: st.up.goldplate > 0
    });
    st.coins += reward.coins;
    st.served++;
    var res = { code: 'served', coins: reward.coins, tip: reward.tip, fast: fast,
      quality: plate.quality, combo: st.combo.level, name: c.name, look: c.look };
    advanceCustomer(st);
    st.plate = freshPlate();
    st.board = null; st.catUsed = false;
    st.last = res;
    return res;
  };

    /* trash the current plate (and oven contents) */
  UC.trashPlate = function (st) {
    var plate = st.plate;
    if (plate.items.length === 0 && plate.mess === 0 && !st.oven && !st.board && !st.frost) {
      return { code: 'nothing' };
    }
    st.plate = freshPlate();
    st.board = null;
    st.frost = null; st.frostHolding = false;
    st.oven = null;
    st.last = { code: 'trashed' };
    return st.last;
  };

  /* ================================================================
   * ACTION ROUTER — one dispatcher for every input path.
   * 3D raycast taps AND MC glass buttons call dispatch() with the same
   * action ids, so there are zero logic forks. Same-frame duplicates
   * (e.g. board tap + button press in the same frame) are ignored.
   * ================================================================ */
  UC.MC_BINDINGS = { chop: 'chop', flip: 'flip', serve: 'serve' };

  UC.activePanIndex = function (st) {
    var best = -1;
    for (var i = 0; i < st.pans.length; i++) {
      var p = st.pans[i];
      if (p.phase === 'cooking') { if (p.windowOpen) return i; best = best < 0 ? i : best; }
    }
    return best;
  };

  /* the exact core function each action id maps to */
  UC.actionImpl = function (actionId) {
    if (actionId === 'chop') return UC.tapBoard;
    if (actionId === 'flip') return UC.tapPan;
    if (actionId === 'serve') return UC.servePlate;
    return null;
  };

  UC.dispatch = function (st, actionId, frameId, args) {
    if (!st || st.finished) return { code: 'finished' };
    var last = st.actFrames[actionId];
    if (last === frameId) return { code: 'dup' }; /* no double-advance same frame */
    st.actFrames[actionId] = frameId;
    if (actionId === 'chop') return UC.tapBoard(st);
    if (actionId === 'flip') {
      var i = (args && typeof args.pan === 'number') ? args.pan : UC.activePanIndex(st);
      if (i < 0) return { code: 'none' };
      return UC.tapPan(st, i);
    }
    if (actionId === 'serve') return UC.servePlate(st);
    return { code: 'unknown' };
  };

  /* ---------------- MC button visibility FSM (pure; pass `out` to reuse) ---------------- */
  UC.buttonVisibility = function (st, out) {
    out = out || {};
    var chop = false, flip = false, serve = false;
    if (st && !st.finished && st.active) {
      chop = !!(st.board); /* something on the board needing taps */
      flip = false;
      for (var i = 0; i < st.pans.length; i++) {
        if (st.pans[i].phase === 'cooking') { flip = true; break; }
      }
      serve = st.plate.phase === 'complete';
    }
    out.chop = chop; out.flip = flip; out.serve = serve;
    return out;
  };

  /* mount gating: touch devices OR narrow screens */
  UC.shouldMountActionBar = function (nav, width) {
    var touch = false;
    if (typeof MC !== 'undefined' && MC && typeof MC.isTouchDevice === 'function') {
      touch = MC.isTouchDevice(nav);
    } else if (nav) {
      touch = ((nav.maxTouchPoints || 0) > 0) || ((nav.msMaxTouchPoints || 0) > 0) ||
        /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(nav.userAgent || '');
    }
    return touch || (typeof width === 'number' && width < 820);
  };

  /* ---------------- day summary ---------------- */
  UC.expectedDayRevenue = function (st) {
    var sum = 0;
    for (var i = 0; i < st.customers.length; i++) sum += st.customers[i].order.price;
    return Math.round(sum * 1.7);
  };

  UC.finishDay = function (st) {
    var expected = UC.expectedDayRevenue(st);
    return {
      rid: st.rid, day: st.day, coins: st.coins,
      served: st.served, walkouts: st.walkouts, total: st.n,
      expected: expected,
      stars: UC.dayStars(st.served, st.n, st.coins, expected)
    };
  };

  /* exports */
  UC._clamp = clamp; UC._clamp01 = clamp01;
  if (typeof module !== 'undefined' && module.exports) module.exports = UC;
  if (typeof window !== 'undefined') window.UC = UC;
})();
