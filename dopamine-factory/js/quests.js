/* js/quests.js — DP.Quests. Rotating quests. PURE + event-fed. See CONTRACTS.md.
 * State (JSON-safe, embedded in the save by game.js):
 *   { quests:[quest|null ×3], progression, level, seed, rerolls, completed, claimed }
 *   quest = { id, text, goal, progress, reward, done }
 * API:
 *   newState()                        → 3 empty slots
 *   reroll(state, seed, progression)  → exactly 3 fresh quests (=== state.quests)
 *       seed: number|string — same seed + same progression ⇒ identical quests
 *       progression: player LIFETIME COINS → level 0..20 (one per ×10 coins)
 *       that scales every N/T/M/C/X goal and reward so quests stay relevant
 *   onEvent(state, name, data)        → quests that JUST completed (also emits
 *       'quest'{id,done:true} on DP.Events when the bus exists). Fed: pop{tier,
 *       lucky,chained} merge{tier} combo{count} coins{amount} wheel{result}
 *       spend{id} discover{tier} tierReached{tier}
 *   claim(state) → [{id,text,coins}] per completed quest; those slots become
 *       null until the next reroll — a second claim before rerolling returns []
 *   spec(id,level) · create(id,level) · level(progression) · progressText(q) · pool
 */
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
DP.Quests = (function () {
  'use strict';

  var SLOTS = 3;
  var SCALE = 3.5; // reward ladder mirrors the canon tier-value curve

  function progLevel(p) { // lifetime coins → 0..20
    p = Number(p);
    if (!isFinite(p) || p < 0) p = 0;
    return Math.max(0, Math.min(20, Math.floor(Math.log10(p + 1))));
  }

  function niceRound(n) { // feel-good numbers — never a 3.7-coin reward
    if (n < 100) return Math.max(5, Math.round(n / 5) * 5);
    if (n < 1000) return Math.round(n / 10) * 10;
    return Math.round(n / 25) * 25;
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  /* 11 templates (contract pool ≥ 10) */
  var POOL = [
    { id: 'pop',       goal: function (L) { return 10 + 4 * L; },
      text: function (g) { return 'Pop ' + g + plural(g, ' cube', ' cubes'); },           reward: 25 },
    { id: 'tier',      goal: function (L) { return Math.min(24, 2 + Math.round(1.4 * L)); },
      text: function (g) { return 'Reach tier ' + g; },                                  reward: 120 },
    { id: 'merge',     goal: function (L) { return 4 + 2 * L; },
      text: function (g) { return 'Merge ' + g + plural(g, ' time', ' times'); },        reward: 40 },
    { id: 'combo',     goal: function (L) { return Math.min(15, 3 + L); },
      text: function (g) { return 'Hit a ×' + (1 + 0.1 * g).toFixed(1) + ' combo'; },   reward: 55 },
    { id: 'earn',      goal: function (L) { return niceRound(60 * Math.pow(1.9, L)); },
      text: function (g) { return 'Earn ' + g + ' coins'; },                             reward: 18 },
    { id: 'wheel',     goal: function (L) { return Math.min(3, 1 + Math.floor(L / 3)); },
      text: function (g) { return 'Spin the wheel ' + g + plural(g, ' time', ' times'); }, reward: 35 },
    { id: 'lucky',     goal: function (L) { return Math.min(3, 1 + Math.floor(L / 4)); },
      text: function (g) { return 'Pop ' + g + ' lucky ' + plural(g, 'cube', 'cubes'); }, reward: 85 },
    { id: 'chain',     goal: function (L) { return Math.min(8, 2 + Math.floor(L / 2)); },
      text: function (g) { return 'Chain-pop ' + g + plural(g, ' cube', ' cubes'); },     reward: 70 },
    { id: 'discover',  goal: function (L) { return Math.min(24, 3 + Math.round(1.3 * L)); },
      text: function (g) { return 'Discover tier ' + g; },                               reward: 140 },
    { id: 'upgrade',   goal: function (L) { return Math.min(4, 1 + Math.floor(L / 2)); },
      text: function (g) { return 'Buy ' + g + plural(g, ' upgrade', ' upgrades'); },     reward: 60 },
    { id: 'chainstart', goal: function (L) { return Math.min(3, 1 + Math.floor(L / 3)); },
      text: function (g) { return 'Trigger ' + g + ' chain reaction' + plural(g, '', 's'); }, reward: 50 }
  ];

  function spec(id, level) {
    var t = null, i;
    for (i = 0; i < POOL.length; i++) if (POOL[i].id === id) t = POOL[i];
    if (!t) return null;
    var L = Math.max(0, level | 0);
    var goal = Math.max(1, Math.round(t.goal(L)));
    return { id: t.id, goal: goal, reward: niceRound(t.reward * Math.pow(SCALE, L)), text: t.text(goal) };
  }

  function create(id, level) {
    var s = spec(id, level);
    return s ? { id: s.id, text: s.text, goal: s.goal, reward: s.reward, progress: 0, done: false } : null;
  }

  /* deterministic rng — same seed ⇒ same quests */
  function xmur3(str) {
    var h = 1779033703 ^ str.length, i;
    for (i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    if (typeof seed === 'number' && isFinite(seed)) return mulberry32(seed >>> 0);
    if (typeof seed === 'string' && seed.length) return mulberry32(xmur3(seed)());
    return mulberry32(1); // no seed → stable, never Math.random: stays deterministic
  }

  function newState() {
    return { quests: [null, null, null], progression: 0, level: 0, seed: null,
             rerolls: 0, completed: 0, claimed: 0 };
  }

  function reroll(state, seed, progression) {
    if (!state) state = newState();
    var L = progLevel(progression);
    var rng = makeRng(seed);
    var order = [], i, j, tmp;
    for (i = 0; i < POOL.length; i++) order[i] = i;
    for (i = order.length - 1; i > 0; i--) { // Fisher–Yates: 3 distinct templates
      j = Math.floor(rng() * (i + 1));
      tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    var quests = [];
    for (i = 0; i < SLOTS; i++) quests.push(create(POOL[order[i]].id, L));
    state.quests = quests;
    state.level = L;
    var p = Number(progression);
    state.progression = (isFinite(p) && p > 0) ? p : 0;
    state.seed = (seed === undefined) ? null : seed;
    state.rerolls = (state.rerolls || 0) + 1;
    return quests;
  }

  function add(q, n) { // count-style: capped at goal ⇒ completes exactly
    if (!q || q.done) return false;
    q.progress = Math.min(q.goal, q.progress + n);
    if (q.progress >= q.goal) { q.done = true; return true; }
    return false;
  }

  function reach(q, v) { // max-style (tier/combo): best seen so far, capped
    if (!q || q.done || !(v > q.progress)) return false;
    q.progress = Math.min(q.goal, v);
    if (q.progress >= q.goal) { q.done = true; return true; }
    return false;
  }

  function onEvent(state, name, data) {
    var newly = [];
    if (!state || !state.quests) return newly;
    data = data || {};
    var qs = state.quests, i, q;
    for (i = 0; i < qs.length; i++) {
      q = qs[i];
      if (!q || q.done) continue;
      switch (name) {
        case 'pop': // one pop can feed several quests at once
          if (q.id === 'pop' && add(q, 1)) newly.push(q);
          if (q.id === 'lucky' && data.lucky && add(q, 1)) newly.push(q);
          if (q.id === 'chain' && data.chained && add(q, 1)) newly.push(q);
          if (q.id === 'chainstart' && data.tier >= 5 && !data.chained && add(q, 1)) newly.push(q);
          if (q.id === 'tier' && data.tier && reach(q, data.tier)) newly.push(q);
          break;
        case 'merge':
          if (q.id === 'merge' && add(q, 1)) newly.push(q);
          if (q.id === 'tier' && data.tier && reach(q, data.tier)) newly.push(q);
          break;
        case 'combo':
          if (q.id === 'combo' && data.count && reach(q, data.count)) newly.push(q);
          break;
        case 'coins':
          if (q.id === 'earn' && data.amount > 0 && add(q, data.amount)) newly.push(q);
          break;
        case 'wheel':
          if (q.id === 'wheel' && add(q, 1)) newly.push(q);
          break;
        case 'spend':
          if (q.id === 'upgrade' && add(q, 1)) newly.push(q);
          break;
        case 'discover':
          if (q.id === 'discover' && data.tier && reach(q, data.tier)) newly.push(q);
          if (q.id === 'tier' && data.tier && reach(q, data.tier)) newly.push(q);
          break;
        case 'tierReached':
          if (q.id === 'tier' && data.tier && reach(q, data.tier)) newly.push(q);
          break;
      }
    }
    if (newly.length) {
      state.completed = (state.completed || 0) + newly.length;
      if (typeof DP.Events !== 'undefined' && DP.Events && typeof DP.Events.emit === 'function') {
        for (i = 0; i < newly.length; i++) DP.Events.emit('quest', { id: newly[i].id, done: true });
      }
    }
    return newly;
  }

  function claim(state) {
    var rewards = [];
    if (!state || !state.quests) return rewards;
    for (var i = 0; i < state.quests.length; i++) {
      var q = state.quests[i];
      if (q && q.done) {
        rewards.push({ id: q.id, text: q.text, coins: q.reward });
        state.quests[i] = null; // slot freed until the next reroll
        state.claimed = (state.claimed || 0) + 1;
      }
    }
    return rewards;
  }

  function progressText(q) { return q ? q.progress + '/' + q.goal : ''; }

  return {
    newState: newState, reroll: reroll, onEvent: onEvent, claim: claim,
    spec: spec, create: create, level: progLevel, progressText: progressText,
    pool: POOL.map(function (t) { return t.id; }), slots: SLOTS
  };
})();

/* ================= self-test (node js/quests.js — headless, no DOM/THREE/bus) ================= */
if (typeof process !== 'undefined' && typeof window === 'undefined' &&
    String(process.argv[1] || '').endsWith('quests.js')) {
  (function () {
    var Q = DP.Quests;
    var pass = 0, fail = 0, failures = [];
    function t(name, fn) {
      try { fn(); pass++; console.log('  ✓ ' + name); }
      catch (e) { fail++; failures.push(name + ' — ' + e.message); console.log('  ✗ ' + name + ' — ' + e.message); }
    }
    function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + ': expected ' + b + ', got ' + a); }
    function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
    function has(arr, v) { for (var i = 0; i < arr.length; i++) if (arr[i] === v || arr[i].id === v) return true; return false; }

    function drive(st, q) { // complete a quest purely through the event stream
      var i;
      switch (q.id) {
        case 'pop':       for (i = 0; i < q.goal; i++) Q.onEvent(st, 'pop', { tier: 1 }); break;
        case 'tier':      Q.onEvent(st, 'tierReached', { tier: q.goal }); break;
        case 'merge':     for (i = 0; i < q.goal; i++) Q.onEvent(st, 'merge', { a: 0, b: 1, tier: 1 }); break;
        case 'combo':     Q.onEvent(st, 'combo', { count: q.goal, mult: 1 }); break;
        case 'earn':      Q.onEvent(st, 'coins', { amount: q.goal, total: 0 }); break;
        case 'wheel':     for (i = 0; i < q.goal; i++) Q.onEvent(st, 'wheel', { result: 'coins' }); break;
        case 'lucky':     for (i = 0; i < q.goal; i++) Q.onEvent(st, 'pop', { tier: 1, lucky: true }); break;
        case 'chain':     for (i = 0; i < q.goal; i++) Q.onEvent(st, 'pop', { tier: 2, chained: true }); break;
        case 'discover':  Q.onEvent(st, 'discover', { tier: q.goal }); break;
        case 'upgrade':   for (i = 0; i < q.goal; i++) Q.onEvent(st, 'spend', { id: 'incomeMult', level: 1 }); break;
        case 'chainstart': for (i = 0; i < q.goal; i++) Q.onEvent(st, 'pop', { tier: 5 }); break;
      }
    }

    function snap(st) { // "id=progress(* if done)" for every slot — catches cross-contamination
      var s = [];
      for (var i = 0; i < st.quests.length; i++) {
        var q = st.quests[i];
        s.push(q.id + '=' + q.progress + (q.done ? '*' : ''));
      }
      return s.join(' ');
    }

    console.log('DP.Quests — self-test');

    t('reroll installs exactly 3 distinct quests from the pool', function () {
      var st = Q.newState(), qs = Q.reroll(st, 'fresh', 0), i;
      ok(qs === st.quests, 'reroll must return state.quests');
      eq(qs.length, 3, 'slot count');
      ok(qs[0].id !== qs[1].id && qs[0].id !== qs[2].id && qs[1].id !== qs[2].id, 'duplicate template active');
      for (i = 0; i < 3; i++) {
        ok(has(Q.pool, qs[i].id), 'unknown template ' + qs[i].id);
        eq(qs[i].progress, 0); ok(!qs[i].done); ok(qs[i].goal >= 1); ok(qs[i].reward >= 5); ok(qs[i].text.length > 3);
      }
      eq(st.level, 0); eq(st.rerolls, 1); eq(st.progression, 0);
    });

    t('reroll is deterministic (same seed ⇒ same quests)', function () {
      var a = Q.reroll(Q.newState(), 'determinism', 777);
      var b = Q.reroll(Q.newState(), 'determinism', 777);
      var c = Q.reroll(Q.newState(), 424242, 50);
      var d = Q.reroll(Q.newState(), 424242, 50);
      for (var i = 0; i < 3; i++) {
        eq(b[i].id, a[i].id, 'id@' + i); eq(b[i].goal, a[i].goal, 'goal@' + i);
        eq(b[i].reward, a[i].reward, 'reward@' + i); eq(b[i].text, a[i].text, 'text@' + i);
        eq(d[i].id, c[i].id, 'numseed id@' + i); eq(d[i].goal, c[i].goal, 'numseed goal@' + i);
        eq(d[i].reward, c[i].reward, 'numseed reward@' + i);
      }
    });

    t('every event type advances the right quest', function () {
      var st = Q.newState();
      st.quests = [];
      var i;
      for (i = 0; i < Q.pool.length; i++) st.quests.push(Q.create(Q.pool[i], 0)); // all 11 active at once
      var r;
      r = Q.onEvent(st, 'pop', { tier: 1 });
      eq(r.length, 0); eq(snap(st), 'pop=1 tier=1 merge=0 combo=0 earn=0 wheel=0 lucky=0 chain=0 discover=0 upgrade=0 chainstart=0');
      r = Q.onEvent(st, 'pop', { tier: 6 });
      eq(r.length, 2); ok(has(r, 'tier')); ok(has(r, 'chainstart'));
      eq(snap(st), 'pop=2 tier=2* merge=0 combo=0 earn=0 wheel=0 lucky=0 chain=0 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'pop', { tier: 2, lucky: true });
      eq(r.length, 1); ok(has(r, 'lucky'));
      eq(snap(st), 'pop=3 tier=2* merge=0 combo=0 earn=0 wheel=0 lucky=1* chain=0 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'pop', { tier: 3, chained: true });
      eq(r.length, 0);
      eq(snap(st), 'pop=4 tier=2* merge=0 combo=0 earn=0 wheel=0 lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'merge', { a: 0, b: 1, tier: 5 });
      eq(r.length, 0);
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=0 earn=0 wheel=0 lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      Q.onEvent(st, 'combo', { count: 2, mult: 1.2 });
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=2 earn=0 wheel=0 lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'combo', { count: 7, mult: 1.7 });
      eq(r.length, 1); ok(has(r, 'combo'));
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=0 wheel=0 lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      Q.onEvent(st, 'coins', { amount: 45, total: 45 });
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=45 wheel=0 lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'coins', { amount: 45, total: 90 });
      eq(r.length, 1); ok(has(r, 'earn'));
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=60* wheel=0 lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'wheel', { result: 'dud' });
      eq(r.length, 1); ok(has(r, 'wheel'));
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=60* wheel=1* lucky=1* chain=1 discover=0 upgrade=0 chainstart=1*');
      r = Q.onEvent(st, 'spend', { id: 'tapPower', level: 2 });
      eq(r.length, 1); ok(has(r, 'upgrade'));
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=60* wheel=1* lucky=1* chain=1 discover=0 upgrade=1* chainstart=1*');
      r = Q.onEvent(st, 'discover', { tier: 4 });
      eq(r.length, 1); ok(has(r, 'discover'));
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=60* wheel=1* lucky=1* chain=1 discover=3* upgrade=1* chainstart=1*');
      r = Q.onEvent(st, 'tierReached', { tier: 9 });
      eq(r.length, 0); // done quests never move again
      eq(snap(st), 'pop=4 tier=2* merge=1 combo=3* earn=60* wheel=1* lucky=1* chain=1 discover=3* upgrade=1* chainstart=1*');
      eq(st.completed, 8, 'completed counter');
    });

    t('thresholds complete exactly (progress caps at goal)', function () {
      var st = Q.newState();
      var q = Q.create('pop', 0); st.quests = [q]; eq(q.goal, 10);
      for (var i = 0; i < 9; i++) Q.onEvent(st, 'pop', { tier: 1 });
      eq(q.progress, 9); ok(!q.done);
      Q.onEvent(st, 'pop', { tier: 1 });
      eq(q.progress, 10); ok(q.done);
      Q.onEvent(st, 'pop', { tier: 1 });
      eq(q.progress, 10, 'progress must never overshoot');
      var e = Q.create('earn', 0); st.quests = [e]; eq(e.goal, 60);
      Q.onEvent(st, 'coins', { amount: 30, total: 30 }); eq(e.progress, 30);
      Q.onEvent(st, 'coins', { amount: 999, total: 999 }); eq(e.progress, 60); ok(e.done);
      var c = Q.create('combo', 0); st.quests = [c]; eq(c.goal, 3);
      Q.onEvent(st, 'combo', { count: 1, mult: 1.1 }); eq(c.progress, 1); ok(!c.done);
      Q.onEvent(st, 'combo', { count: 5, mult: 1.5 }); eq(c.progress, 3); ok(c.done);
      var tr = Q.create('tier', 0); st.quests = [tr]; eq(tr.goal, 2);
      Q.onEvent(st, 'pop', { tier: 1 }); eq(tr.progress, 1); ok(!tr.done);
      Q.onEvent(st, 'tierReached', { tier: 2 }); eq(tr.progress, 2); ok(tr.done);
      Q.onEvent(st, 'tierReached', { tier: 25 }); eq(tr.progress, 2, 'tier progress caps at goal');
    });

    t('claim pays every completed quest once, then nothing', function () {
      var st = Q.newState();
      var qs = Q.reroll(st, 'claim-all', 0);
      var snapBefore = qs.map(function (q) { return { id: q.id, text: q.text, reward: q.reward }; });
      for (var i = 0; i < qs.length; i++) drive(st, qs[i]);
      ok(qs[0].done && qs[1].done && qs[2].done, 'drive must complete all three');
      var r = Q.claim(st);
      eq(r.length, 3, 'first claim pays all');
      for (i = 0; i < 3; i++) {
        eq(r[i].id, snapBefore[i].id, 'reward id order');
        eq(r[i].text, snapBefore[i].text, 'reward text');
        eq(r[i].coins, snapBefore[i].reward, 'reward coins');
        eq(st.quests[i], null, 'slot freed');
      }
      eq(st.claimed, 3);
      eq(Q.claim(st).length, 0, 'second claim returns nothing');
    });

    t('partial claim frees only the finished slot', function () {
      var seed = null;
      for (var s = 0; s < 300; s++) { // find a seed whose slot 0 is the pop quest
        if (Q.reroll(Q.newState(), 'pp' + s, 0)[0].id === 'pop') { seed = 'pp' + s; break; }
      }
      ok(seed, 'no pop-first seed found');
      var st = Q.newState();
      var qs = Q.reroll(st, seed, 0);
      drive(st, qs[0]); // plain tier-1 pops can only ever finish the pop quest
      ok(qs[0].done); ok(!qs[1].done); ok(!qs[2].done);
      var r = Q.claim(st);
      eq(r.length, 1); eq(r[0].id, 'pop');
      eq(r[0].coins, Q.spec('pop', 0).reward, 'reward scaled by progression');
      eq(st.quests[0], null);
      ok(st.quests[1] && !st.quests[1].done, 'slot 1 intact');
      ok(st.quests[2] && !st.quests[2].done, 'slot 2 intact');
      eq(Q.claim(st).length, 0);
    });

    t('quest scaling grows with progression', function () {
      for (var i = 0; i < Q.pool.length; i++) {
        var id = Q.pool[i];
        var a = Q.spec(id, 0), b = Q.spec(id, 4), c = Q.spec(id, 8);
        ok(a.goal < b.goal && b.goal < c.goal, id + ' goals must grow');
        ok(a.reward < b.reward && b.reward < c.reward, id + ' rewards must grow');
        ok(a.reward >= 5, id + ' baseline reward too small');
      }
      eq(Q.level(0), 0); eq(Q.level(50), 1); eq(Q.level(1000000), 6);
      eq(Q.level(1e12), 12); eq(Q.level(1e30), 20);
      eq(Q.level(NaN), 0); eq(Q.level(-100), 0); eq(Q.level('garbage'), 0);
    });

    t('never 2 identical active quests, whole pool reachable', function () {
      var seen = {}, s, i, qs;
      for (s = 0; s < 50; s++) {
        qs = Q.reroll(Q.newState(), 'uniq-' + s, s * 977);
        eq(qs.length, 3);
        ok(qs[0].id !== qs[1].id && qs[0].id !== qs[2].id && qs[1].id !== qs[2].id, 'dup at seed ' + s);
        for (i = 0; i < 3; i++) { ok(has(Q.pool, qs[i].id), 'unknown template'); seen[qs[i].id] = true; }
      }
      for (i = 0; i < Q.pool.length; i++) ok(seen[Q.pool[i]], 'template never sampled: ' + Q.pool[i]);
    });

    t('robust: no bus, missing data, unknown events, empty state', function () {
      ok(typeof DP.Events === 'undefined', 'bus must be absent under node');
      var st = Q.newState();
      eq(Q.claim(st).length, 0, 'claim on empty state');
      eq(Q.onEvent(st, 'pop', undefined).length, 0, 'onEvent over null slots');
      var st2 = Q.newState();
      Q.reroll(st2, 'robust', 0);
      var names = ['spawn', 'pop', 'merge', 'tierReached', 'discover', 'coins',
                   'combo', 'spend', 'ascend', 'wheel', 'quest', 'load', 'save', 'nonsense'];
      for (var i = 0; i < names.length; i++) Q.onEvent(st2, names[i]); // no data → must not throw
      var back = JSON.parse(JSON.stringify(st2)); // save-embed safe
      eq(back.quests.length, 3);
      eq(Q.progressText(back.quests[0]), back.quests[0].progress + '/' + back.quests[0].goal);
      eq(Q.progressText(null), '');
    });

    if (fail === 0) {
      console.log('DP.Quests: ALL TESTS PASSED (' + pass + '/' + pass + ')');
    } else {
      console.log('DP.Quests: TESTS FAILED (' + pass + ' passed, ' + fail + ' failed)');
      for (var f = 0; f < failures.length; f++) console.log('  FAIL ' + failures[f]);
      process.exit(1);
    }
  })();
}

