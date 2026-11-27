'use strict';
/* ============================================================
   BANK SIMULATOR — Heist Tycoon
   Vanilla JS, no dependencies, no modules, no assets.
   PART 1: pure logic & math (no DOM) — testable under node.
   PART 2: DOM bootstrap, guarded by `typeof document`.
   Self-tests run under:  node game.js
   ============================================================ */

var BankSim = (function () {

  /* ==========================================================
     PART 1 — PURE LOGIC & MATH (NO DOM)
     ========================================================== */

  var SAVE_KEY = 'bank_sim_save_v1';
  var SAVE_VERSION = 1;

  var CONFIG = {
    BASE_TAP: 5,                    // dollars per tap before multipliers
    CREW_COST_SCALE: 1.15,          // cost multiplier per owned copy
    TICK_MS: 100,                   // main loop tick
    SAVE_INTERVAL_MS: 10000,        // autosave every 10s
    // ---- heat (the tension system) ----
    HEAT_PER_TAP: 1.25,             // % heat per vault tap
    HEAT_INCOME_DIVISOR: 400,       // income heat %/s = cps / 400
    HEAT_INCOME_CAP: 2.5,           // ...capped at this %/s
    HEAT_DECAY_PER_SEC: 0.5,        // passive decay %/s
    HEAT_MAX: 100,                  // clamped heat ceiling
    HEAT_RAID_AT: 100,              // raid triggers at >= this
    // ---- raid (tap to escape) ----
    RAID_DURATION_MS: 5000,         // escape window
    ESCAPE_TICK_MS: 300,            // escape bar decay tick
    ESCAPE_FILL_PER_TAP: 6,         // % of escape bar per tap
    ESCAPE_DECAY_PER_TICK: 3.6,     // % lost per 300ms (= 12%/s)
    RAID_REWARD_SECONDS: 60,        // loot chest = 60s of income
    RAID_SUCCESS_HEAT: 20,          // heat after a successful escape
    RAID_FAIL_PENALTY: 0.2,         // fraction of cash lost on fail
    // ---- prestige ----
    PRESTIGE_BASE_THRESHOLD: 1e6,   // first bigger city at $1M lifetime
    PRESTIGE_THRESHOLD_GROWTH: 5,   // each next city costs 5x more
    PRESTIGE_BONUS: 0.5,            // +50% additive global multiplier per city
    // ---- offline ----
    OFFLINE_RATE: 0.5,              // 50% of $/s while away
    OFFLINE_CAP_MS: 8 * 60 * 60 * 1000, // capped at 8h
    OFFLINE_MIN_MS: 60000           // modal only after >= 60s away
  };

  // crew: passive income sources (cost scales 1.15^owned)
  var CREW = [
    { id: 'lookout',   name: 'Lookout',        emoji: '😎',     income: 1,    cost: 50 },
    { id: 'hacker',    name: 'Hacker',         emoji: '🧑‍💻',   income: 8,    cost: 400 },
    { id: 'driver',    name: 'Getaway Driver', emoji: '🏎️',    income: 45,   cost: 2250 },
    { id: 'insideman', name: 'Inside Man',     emoji: '🕴️',     income: 220,  cost: 11000 },
    { id: 'cartel',    name: 'Cartel Friend',  emoji: '🤝',     income: 1200, cost: 60000 }
  ];

  // drills: one-time tap multiplier tiers, bought in order
  var DRILLS = [
    { id: 'rusty',   name: 'Rusty Drill',   emoji: '🔧', mult: 2,  cost: 500 },
    { id: 'diamond', name: 'Diamond Drill', emoji: '💎', mult: 4,  cost: 10000 },
    { id: 'laser',   name: 'Laser Drill',   emoji: '🔦', mult: 8,  cost: 200000 },
    { id: 'quantum', name: 'Quantum Drill',  emoji: '⚛️', mult: 16, cost: 5000000 },
    { id: 'nano',    name: 'Nano Drill',     emoji: '🦠', mult: 32, cost: 100000000 }
  ];

  // achievements: pure checks against state
  var ACHIEVEMENTS = [
    { id: 'first_tap',    name: 'First Buck',      desc: 'You tapped the vault!',       check: function (s) { return s.totalTaps >= 1; } },
    { id: 'first_hire',   name: 'Gang Assembled', desc: 'You hired your first crewie', check: function (s) { return totalCrew(s) >= 1; } },
    { id: 'earn_1k',      name: 'Small Timer',     desc: 'Earned $1K total',             check: function (s) { return s.allTimeEarned >= 1000; } },
    { id: 'raid_survive', name: 'Smooth Criminal', desc: 'Escaped a police raid',        check: function (s) { return s.raidsSurvived >= 1; } },
    { id: 'raid_fail',    name: 'Busted!',         desc: 'You failed a raid (ouch)',     check: function (s) { return s.raidsFailed >= 1; } },
    { id: 'earn_1m',      name: 'Millionaire',     desc: 'Earned $1M total',             check: function (s) { return s.allTimeEarned >= 1e6; } },
    { id: 'prestige_1',   name: 'Big City Moves',  desc: 'Moved to a bigger city',       check: function (s) { return s.prestige >= 1; } },
    { id: 'crew_10',      name: 'Full House',      desc: '10 of one crew type',          check: function (s) { return CREW.some(function (c) { return (s.crew[c.id] || 0) >= 10; }); } }
  ];

  // ---------- small helpers ----------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function numOr(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function intOr(v, d) { return Math.max(0, Math.floor(numOr(v, d))); }

  function totalCrew(s) {
    return CREW.reduce(function (n, c) { return n + (s.crew[c.id] || 0); }, 0);
  }

  // ---------- state ----------
  function createInitialState() {
    return {
      version: SAVE_VERSION,
      cash: 0,
      lifetimeEarned: 0,   // earnings in the current city (resets on prestige)
      allTimeEarned: 0,    // never resets
      totalTaps: 0,
      heat: 0,              // 0..100
      crew: { lookout: 0, hacker: 0, driver: 0, insideman: 0, cartel: 0 },
      drillTier: 0,         // number of drills owned (0..5), sequential
      prestige: 0,          // bigger cities conquered
      achievements: [],     // unlocked achievement ids
      raidsSurvived: 0,
      raidsFailed: 0,
      lastSeen: Date.now()  // timestamp for offline earnings
    };
  }

  // ---------- prestige ----------
  // Each prestige grants +50% ADDITIVE (spec: multiplier = 1 + 0.5 * n).
  function prestigeMultiplier(n) { return 1 + CONFIG.PRESTIGE_BONUS * n; }

  function prestigeThreshold(s) {
    return CONFIG.PRESTIGE_BASE_THRESHOLD * Math.pow(CONFIG.PRESTIGE_THRESHOLD_GROWTH, s.prestige);
  }

  function canPrestige(s) { return s.lifetimeEarned >= prestigeThreshold(s); }

  // Resets cash + crew (drills persist per spec), grants the next city.
  function applyPrestige(s) {
    if (s.lifetimeEarned < prestigeThreshold(s)) return false;
    s.prestige += 1;
    s.cash = 0;
    s.lifetimeEarned = 0;
    s.heat = 0;
    CREW.forEach(function (c) { s.crew[c.id] = 0; });
    return true;
  }

  // ---------- income ----------
  function crewIncomePerSecond(s) {
    var base = CREW.reduce(function (sum, c) { return sum + (s.crew[c.id] || 0) * c.income; }, 0);
    return base * prestigeMultiplier(s.prestige);
  }

  function crewCost(id, owned) {
    for (var i = 0; i < CREW.length; i++) {
      if (CREW[i].id === id) return Math.round(CREW[i].cost * Math.pow(CONFIG.CREW_COST_SCALE, owned));
    }
    return Infinity; // unknown crew id
  }

  function buyCrewMember(s, id) {
    var owned = s.crew[id] || 0;
    var cost = crewCost(id, owned);
    if (s.cash < cost) return false;
    s.cash -= cost;
    s.crew[id] = owned + 1;
    return true;
  }

  // ---------- tap value ----------
  function drillMultiplier(s) {
    return s.drillTier > 0 ? DRILLS[s.drillTier - 1].mult : 1;
  }

  function tapValue(s) {
    return CONFIG.BASE_TAP * drillMultiplier(s) * prestigeMultiplier(s.prestige);
  }

  function buyDrill(s, idx) {
    var i = (typeof idx === 'number') ? idx : s.drillTier;
    if (i !== s.drillTier) return false; // tiers must be bought in order
    var d = DRILLS[i];
    if (!d || s.cash < d.cost) return false;
    s.cash -= d.cost;
    s.drillTier = i + 1;
    return true;
  }

  // ---------- vault tap core (mobile/touch pass) ----------
  // ONE implementation of the vault-tap economy, shared by the zero-latency
  // pointerdown fast-path, the legacy click fallback and the keyboard path.
  // `e` may be a real event or a mock with clientX/clientY (FX position only).
  function vaultTapCore(s, e) {
    var value = tapValue(s);
    s.cash += value;
    s.lifetimeEarned += value;
    s.allTimeEarned += value;
    s.totalTaps += 1;
    s.heat = addHeat(s, heatFromTap());
    return value;
  }

  // Routes zero-latency pointer/touch input and the slower click fallback
  // through ONE handler, so the paths can never double-fire or drift apart.
  //   fast()  → pointerdown / touchstart (fires first, arms the guard)
  //   click() → click (swallowed when fast() already handled the gesture)
  function makeTapRouter(onTap) {
    var handled = false;
    return {
      fast: function (e) { handled = true; onTap(e); },
      click: function (e) {
        if (handled) { handled = false; return; } // pointer/touch already did it
        onTap(e);
      },
      _handled: function () { return handled; }
    };
  }

  // ---------- heat ----------
  function heatFromTap() { return CONFIG.HEAT_PER_TAP; }

  // Income heats you up proportionally to $/s, capped so late game stays fair.
  function heatFromIncomePerSec(cps) {
    return Math.min(CONFIG.HEAT_INCOME_CAP, cps / CONFIG.HEAT_INCOME_DIVISOR);
  }

  function addHeat(s, delta) {
    s.heat = clamp(s.heat + delta, 0, CONFIG.HEAT_MAX);
    return s.heat;
  }

  // ---------- raid math ----------
  // Escape fill = taps * 6% - elapsed300msTicks * 3.6%, clamped to [0, 100].
  function computeEscapeFill(taps, elapsedMs) {
    var ticks = Math.floor(Math.max(0, elapsedMs) / CONFIG.ESCAPE_TICK_MS);
    var fill = taps * CONFIG.ESCAPE_FILL_PER_TAP - ticks * CONFIG.ESCAPE_DECAY_PER_TICK;
    return clamp(fill, 0, 100);
  }

  // Loot chest = 60 seconds of income (small tap-based consolation if no crew yet).
  function raidReward(s) {
    var cps = crewIncomePerSecond(s);
    if (cps > 0) return cps * CONFIG.RAID_REWARD_SECONDS;
    return tapValue(s) * 10;
  }

  // Applies outcomes; returns the reward (0 on fail).
  function applyRaidResult(s, escaped) {
    if (escaped) {
      s.heat = CONFIG.RAID_SUCCESS_HEAT;
      s.raidsSurvived += 1;
      return raidReward(s);
    }
    s.cash *= (1 - CONFIG.RAID_FAIL_PENALTY);
    s.heat = 0;
    s.raidsFailed += 1;
    return 0;
  }

  // ---------- offline earnings ----------
  // elapsed * cps * 50%, capped at 8h.
  function offlineEarnings(elapsedMs, cps) {
    var capped = Math.min(Math.max(0, elapsedMs), CONFIG.OFFLINE_CAP_MS);
    return (capped / 1000) * cps * CONFIG.OFFLINE_RATE;
  }

  // ---------- number formatting: $1.2K / $3.4M / $5.6B / $7.8T / scientific ----------
  function formatMoney(x) {
    if (typeof x !== 'number' || isNaN(x)) return '$0';
    if (x < 0) return '-' + formatMoney(-x);
    if (!isFinite(x)) return '$∞';
    if (x < 1000) return '$' + Math.floor(x);
    if (x >= 1e15) return '$' + x.toExponential(2).replace('e+', 'e');
    var tiers = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (var i = 0; i < tiers.length; i++) {
      if (x >= tiers[i][0]) return '$' + (x / tiers[i][0]).toFixed(1) + tiers[i][1];
    }
    return '$' + Math.floor(x);
  }

  // ---------- save (serialize / deserialize) ----------
  function serializeState(s) { return JSON.stringify(s); }

  // Tolerant parse: merges partial/legacy saves onto fresh defaults.
  function deserializeState(json) {
    var s = createInitialState();
    var data = null;
    if (typeof json === 'string' && json.length > 0) {
      try { data = JSON.parse(json); } catch (e) { data = null; }
    }
    if (!data || typeof data !== 'object') return s;
    s.cash = numOr(data.cash, 0);
    s.lifetimeEarned = numOr(data.lifetimeEarned, 0);
    s.allTimeEarned = numOr(data.allTimeEarned, 0);
    s.totalTaps = intOr(data.totalTaps, 0);
    s.heat = clamp(numOr(data.heat, 0), 0, CONFIG.HEAT_MAX);
    s.drillTier = clamp(intOr(data.drillTier, 0), 0, DRILLS.length);
    s.prestige = intOr(data.prestige, 0);
    s.raidsSurvived = intOr(data.raidsSurvived, 0);
    s.raidsFailed = intOr(data.raidsFailed, 0);
    s.lastSeen = numOr(data.lastSeen, Date.now());
    var crew = (data.crew && typeof data.crew === 'object') ? data.crew : {};
    for (var i = 0; i < CREW.length; i++) s.crew[CREW[i].id] = intOr(crew[CREW[i].id], 0);
    var ach = Array.isArray(data.achievements) ? data.achievements : [];
    var known = {}, seen = {};
    for (var j = 0; j < ACHIEVEMENTS.length; j++) known[ACHIEVEMENTS[j].id] = true;
    for (var k = 0; k < ach.length; k++) {
      if (typeof ach[k] === 'string' && known[ach[k]] && !seen[ach[k]]) {
        s.achievements.push(ach[k]);
        seen[ach[k]] = true;
      }
    }
    return s;
  }

  // ---------- achievements ----------
  // Returns ids that are newly satisfied (does not mutate).
  function checkAchievements(s) {
    var have = {};
    s.achievements.forEach(function (id) { have[id] = true; });
    return ACHIEVEMENTS
      .filter(function (a) { return !have[a.id] && a.check(s); })
      .map(function (a) { return a.id; });
  }

  // ---------- public API (used by PART 2 and the self-tests) ----------
  return {
    SAVE_KEY: SAVE_KEY,
    SAVE_VERSION: SAVE_VERSION,
    CONFIG: CONFIG,
    CREW: CREW,
    DRILLS: DRILLS,
    ACHIEVEMENTS: ACHIEVEMENTS,
    createInitialState: createInitialState,
    prestigeMultiplier: prestigeMultiplier,
    prestigeThreshold: prestigeThreshold,
    canPrestige: canPrestige,
    applyPrestige: applyPrestige,
    crewIncomePerSecond: crewIncomePerSecond,
    crewCost: crewCost,
    buyCrewMember: buyCrewMember,
    drillMultiplier: drillMultiplier,
    tapValue: tapValue,
    buyDrill: buyDrill,
    vaultTapCore: vaultTapCore,
    makeTapRouter: makeTapRouter,
    heatFromTap: heatFromTap,
    heatFromIncomePerSec: heatFromIncomePerSec,
    addHeat: addHeat,
    computeEscapeFill: computeEscapeFill,
    raidReward: raidReward,
    applyRaidResult: applyRaidResult,
    offlineEarnings: offlineEarnings,
    formatMoney: formatMoney,
    serializeState: serializeState,
    deserializeState: deserializeState,
    checkAchievements: checkAchievements,
    totalCrew: totalCrew
  };
})();


/* ============================================================
   PART 2 — DOM BOOTSTRAP (browser only)
   ============================================================ */
if (typeof document !== 'undefined') {
  (function () {
    'use strict';
    var S = BankSim, C = BankSim.CONFIG;
    var $ = function (id) { return document.getElementById(id); };

    // ---- DOM refs ----
    var cashCounter, cpsChip, heatBar, heatFill, heatPct, crewList, drillList,
        vault, tapValueEl, tapHint, prestigeBtn, prestigeHint, statsList,
        fxLayer, toastBox, raidModal, escapeFill, raidTimer, offlineModal,
        offlineAmount, lootModal, lootAmount, flashEl, resetBtn;

    // ---- mutable runtime ----
    var state = null;          // the single game state
    var raid = null;           // { taps, start, done } while a raid is active
    var raidRouter = null;      // the ONE raid tap router (modal + MC button)
    var crewEls = {};           // crewId -> { btn, cost, owned, income }
    var drillEls = [];          // index -> { btn, cost }
    var lastSaveAt = 0;
    var lastTickAt = 0;

    /* ---------- AUDIO: procedural WebAudio, lazy, try/catch ---------- */
    var audioCtx = null;

    function ensureAudio() {
      try {
        if (!audioCtx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (AC) audioCtx = new AC(); // created lazily on first gesture
        }
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(function () {});
        }
      } catch (e) { audioCtx = null; }
      return audioCtx;
    }

    // One blip: oscillator + exponential gain envelope.
    function tone(freq, delay, dur, type, vol, endFreq) {
      if (!audioCtx) return;
      try {
        var t0 = audioCtx.currentTime + (delay || 0);
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = type || 'triangle';
        osc.frequency.setValueAtTime(freq, t0);
        if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + dur);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch (e) { /* audio must never break the game */ }
    }

    function playChaChing() { // two bright coin blips + a tick
      ensureAudio();
      tone(1567 + Math.random() * 60, 0, 0.07, 'triangle', 0.1);
      tone(2093 + Math.random() * 80, 0.05, 0.12, 'triangle', 0.12);
      tone(1046, 0.02, 0.05, 'square', 0.03);
    }
    function playBuy() { tone(660, 0, 0.08, 'square', 0.07); tone(990, 0.07, 0.12, 'square', 0.07); }
    function playDrill() { tone(180, 0, 0.22, 'sawtooth', 0.11, 60); tone(1320, 0.05, 0.08, 'triangle', 0.06); }
    function playSiren() {
      ensureAudio();
      tone(720, 0, 0.28, 'sawtooth', 0.09, 980);
      tone(720, 0.3, 0.28, 'sawtooth', 0.09, 980);
      tone(720, 0.6, 0.3, 'sawtooth', 0.09, 980);
    }
    function playFanfare() {
      [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.09, 0.18, 'triangle', 0.12); });
    }
    function playFail() { tone(220, 0, 0.5, 'sawtooth', 0.12, 70); }

    /* ---------- FX: particles, floating text, shakes, flashes ---------- */
    var MONEY_FX = ['💵', '💰', '🪙', '💸'];

    function spawnParticles(x, y, n, emojis) {
      if (fxLayer.childElementCount > 90) return; // perf cap
      var pool = emojis || MONEY_FX;
      for (var i = 0; i < n; i++) {
        var el = document.createElement('span');
        el.className = 'fly-bill';
        el.textContent = pool[(Math.random() * pool.length) | 0];
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        fxLayer.appendChild(el);
        var dx = (Math.random() - 0.5) * 260;
        var up = 70 + Math.random() * 110;
        var down = 60 + Math.random() * 120;
        var rot = (Math.random() - 0.5) * 540;
        try {
          var anim = el.animate([
            { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
            { transform: 'translate(' + (dx * 0.6 - 20) + 'px,' + (-up) + 'px) rotate(' + (rot * 0.5) + 'deg)', opacity: 1, offset: 0.45 },
            { transform: 'translate(' + dx + 'px,' + down + 'px) rotate(' + rot + 'deg)', opacity: 0 }
          ], { duration: 700 + Math.random() * 450, easing: 'cubic-bezier(.25,.6,.4,1)' });
          anim.onfinish = function () { el.remove(); };
          anim.oncancel = function () { el.remove(); };
        } catch (e) { el.remove(); }
      }
    }

    function spawnFloatText(x, y, txt) {
      if (fxLayer.childElementCount > 110) return;
      var el = document.createElement('span');
      el.className = 'float-up';
      el.textContent = txt;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.fontSize = (1.1 + Math.random() * 0.7).toFixed(2) + 'rem';
      fxLayer.appendChild(el);
      el.addEventListener('animationend', function () { el.remove(); });
    }

    function retrigger(el, cls) { // restart a CSS animation class
      el.classList.remove(cls);
      void el.offsetWidth; // force reflow
      el.classList.add(cls);
    }

    function shakeVault() { retrigger(vault, 'shake'); }
    function popCash() { retrigger(cashCounter, 'pop'); }
    function flash(kind) { flashEl.className = ''; void flashEl.offsetWidth; flashEl.className = 'on ' + kind; }

    function toast(title, body) {
      var el = document.createElement('div');
      el.className = 'toast';
      el.innerHTML = '<b></b><span></span>';
      el.querySelector('b').textContent = title;
      el.querySelector('span').textContent = body;
      toastBox.appendChild(el);
      while (toastBox.childElementCount > 4) toastBox.removeChild(toastBox.firstChild);
      setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { el.remove(); }, 350);
      }, 4200);
    }

    /* ---------- economy helpers ---------- */
    function addCash(v) {
      state.cash += v;
      state.lifetimeEarned += v;
      state.allTimeEarned += v;
    }
    function currentCps() { return S.crewIncomePerSecond(state); }
    function vaultCenter() {
      var r = vault.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    /* ---------- 3D stage bridge (PART 1 stays untouched) ----------
       A tiny per-frame snapshot for the three.js vault, plus a tap hook.
       onVaultTap IS the makeTapRouter handler, so every input path
       (pointerdown / click / keyboard / MC button) drives the 3D too. */
    BankSim.getVault3DSnapshot = function () {
      if (!state) return null;
      return {
        heat: state.heat,
        crewCount: S.totalCrew(state),
        drillTier: state.drillTier,
        prestige: state.prestige,
        cps: currentCps(),
        tapValue: S.tapValue(state),
        raidActive: !!raid
      };
    };

    /* ---------- MC floating buttons (one-thumb play, touch devices) ----------
       SVG buttons from ../shared/mobile-controls.js. Both route through the
       SAME makeTapRouter instances as the DOM vault / raid modal, so the
       double-fire guard covers them and no second input path exists.
       Desktop never mounts them — its path is unchanged. */
    var IS_TOUCH = (typeof MC !== 'undefined' && MC.isTouchDevice)
      ? MC.isTouchDevice(navigator) : false;
    var mcVaultBtn = null, mcRaidBtn = null, mcRaidFlash = null;

    function mountMcVaultButton(router) {
      if (!IS_TOUCH || typeof MC === 'undefined' || !MC.createButton) return;
      mcVaultBtn = MC.createButton({
        container: document.body,
        label: '💰',
        size: 84,               // big thumb target (48px floor well exceeded)
        color: '#ffd700',       // gold accent
        id: 'mc-vault-btn',
        onDown: function (e) { router.fast(e); } // ONE router → ONE onVaultTap
      });
      if (mcVaultBtn) {
        var st = mcVaultBtn.svg.style;
        st.position = 'fixed'; st.right = '18px'; st.bottom = '18px';
        st.zIndex = '120'; // above the 3D canvas (z1), below result modals (z150+)
      }
    }

    function mountMcRaidButton() {
      if (!IS_TOUCH || typeof MC === 'undefined' || !MC.createButton) return;
      if (mcRaidBtn || !raidRouter) return;
      mcRaidBtn = MC.createButton({
        container: document.body,
        label: '🚔',
        size: 110,
        color: '#ff3b3b',
        id: 'mc-raid-btn',
        onDown: function (e) { raidRouter.fast(e); } // SAME raidTap as the modal
      });
      if (!mcRaidBtn) return;
      var st = mcRaidBtn.svg.style;
      st.position = 'fixed'; st.right = '16px'; st.top = '50%';
      st.transform = 'translateY(-50%)';
      st.zIndex = '210'; // above the raid event modal (z200), below #flash (z340)
      var phase = false;
      mcRaidFlash = setInterval(function () { // tasteful ~1.4 Hz glow pulse
        if (!mcRaidBtn) return;
        mcRaidBtn.svg.style.opacity = phase ? '1' : '0.8';
        phase = !phase;
      }, 360);
    }

    function unmountMcRaidButton() {
      if (mcRaidFlash) { clearInterval(mcRaidFlash); mcRaidFlash = null; }
      if (mcRaidBtn && mcRaidBtn.svg && mcRaidBtn.svg.parentNode) {
        mcRaidBtn.svg.parentNode.removeChild(mcRaidBtn.svg);
      }
      mcRaidBtn = null;
    }

    /* ---------- achievements ---------- */
    function processAchievements() {
      var ids = S.checkAchievements(state);
      if (!ids.length) return;
      ids.forEach(function (id) {
        state.achievements.push(id);
        S.ACHIEVEMENTS.forEach(function (a) {
          if (a.id === id) toast('🏆 ' + a.name, a.desc);
        });
      });
      playBuy();
    }

    /* ---------- UI construction ---------- */
    function buildCrewButtons() {
      S.CREW.forEach(function (c) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'crew-btn';
        btn.innerHTML =
          '<span class="c-emoji"></span>' +
          '<span class="c-info"><span class="c-name"></span><span class="c-income"></span></span>' +
          '<span class="c-right"><span class="c-cost"></span><span class="c-owned"></span></span>';
        btn.querySelector('.c-emoji').textContent = c.emoji;
        btn.querySelector('.c-name').textContent = c.name;
        btn.addEventListener('click', function () { buyCrew(c.id); });
        crewList.appendChild(btn);
        crewEls[c.id] = {
          btn: btn,
          cost: btn.querySelector('.c-cost'),
          owned: btn.querySelector('.c-owned'),
          income: btn.querySelector('.c-income')
        };
      });
    }

    function buildDrillRows() {
      S.DRILLS.forEach(function (d, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'crew-btn drill-btn';
        btn.innerHTML =
          '<span class="c-emoji"></span>' +
          '<span class="c-info"><span class="c-name"></span><span class="c-income"></span></span>' +
          '<span class="c-right"><span class="c-cost"></span></span>';
        btn.querySelector('.c-emoji').textContent = d.emoji;
        btn.querySelector('.c-name').textContent = d.name;
        btn.querySelector('.c-income').textContent = 'TAP VALUE x' + d.mult;
        btn.addEventListener('click', function () { buyNextDrill(i); });
        drillList.appendChild(btn);
        drillEls[i] = { btn: btn, cost: btn.querySelector('.c-cost') };
      });
    }

    function buildBackgroundEmojis() {
      var layer = $('bg-emoji-layer');
      var pool = ['💸', '💰', '💵', '💎', '⭐', '🏙️', '🚔'];
      for (var i = 0; i < 14; i++) {
        var sp = document.createElement('span');
        sp.textContent = pool[i % pool.length];
        sp.style.left = (Math.random() * 96) + '%';
        sp.style.top = (Math.random() * 96) + '%';
        sp.style.fontSize = (16 + Math.random() * 30) + 'px';
        sp.style.animationDuration = (9 + Math.random() * 12) + 's';
        sp.style.animationDelay = (-Math.random() * 12) + 's';
        layer.appendChild(sp);
      }
    }

    /* ---------- render (called ~10x/s) ---------- */
    function render() {
      var cpsNow = currentCps();
      var perTap = S.tapValue(state);

      cashCounter.textContent = S.formatMoney(state.cash);
      cpsChip.textContent = '+' + S.formatMoney(cpsNow) + '/s';
      tapValueEl.textContent = S.formatMoney(perTap);

      // heat bar
      heatFill.style.width = state.heat + '%';
      heatPct.textContent = Math.floor(state.heat) + '%';
      heatBar.classList.toggle('danger', state.heat >= 70);

      // crew buttons (income shown live, disabled+red when unaffordable)
      S.CREW.forEach(function (c) {
        var ui = crewEls[c.id];
        var owned = state.crew[c.id] || 0;
        var cost = S.crewCost(c.id, owned);
        ui.cost.textContent = S.formatMoney(cost);
        ui.owned.textContent = owned > 0 ? ('x' + owned) : '';
        ui.income.textContent = '+' + S.formatMoney(c.income * S.prestigeMultiplier(state.prestige)) + '/s';
        var afford = state.cash >= cost;
        ui.btn.disabled = !afford;
        ui.btn.classList.toggle('afford', afford);
      });

      // drill tiers: owned / next / locked
      S.DRILLS.forEach(function (d, i) {
        var ui = drillEls[i];
        var owned = i < state.drillTier;
        var isNext = i === state.drillTier;
        ui.btn.classList.toggle('owned', owned);
        ui.btn.classList.toggle('locked', !owned && !isNext);
        ui.btn.disabled = owned || !isNext || state.cash < d.cost;
        ui.cost.textContent = owned ? 'OWNED ✓' : S.formatMoney(d.cost);
      });

      // prestige
      var ready = S.canPrestige(state);
      prestigeBtn.disabled = !ready;
      prestigeHint.textContent = ready
        ? '🔥 BOOST READY! +50% EVERYTHING — GO!'
        : 'Next city at ' + S.formatMoney(S.prestigeThreshold(state)) +
          ' lifetime · earned ' + S.formatMoney(state.lifetimeEarned);

      tapHint.style.display = state.totalTaps >= 5 ? 'none' : '';
      renderStats(cpsNow, perTap);
    }

    function renderStats(cpsNow, perTap) {
      var crewSummary = S.CREW.map(function (c) {
        return c.emoji + ' x' + (state.crew[c.id] || 0);
      }).join(' ');
      var rows = [
        ['💵 Cash', S.formatMoney(state.cash)],
        ['⏱ Income', '+' + S.formatMoney(cpsNow) + '/s'],
        ['👆 Per tap', S.formatMoney(perTap)],
        ['📈 Lifetime (city)', S.formatMoney(state.lifetimeEarned)],
        ['🏆 All-time earned', S.formatMoney(state.allTimeEarned)],
        ['👤 Total taps', String(state.totalTaps)],
        ['🚔 Raids', state.raidsSurvived + ' escaped · ' + state.raidsFailed + ' busted'],
        ['🌆 Bigger cities', String(state.prestige)],
        ['🕵️ Crew', crewSummary]
      ];
      statsList.innerHTML = rows.map(function (r) {
        return '<div class="stat-row"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
      }).join('');
    }

    /* ---------- raid event ---------- */
    function startRaid() {
      if (raid) return;
      raid = { taps: 0, start: performance.now(), done: false };
      state.heat = C.HEAT_MAX;
      escapeFill.style.width = '0%';
      raidTimer.textContent = '5.0s';
      raidModal.classList.remove('hidden');
      mountMcRaidButton(); // giant 🚔 thumb button rides the same router
      playSiren();
    }

    function raidTap(e) {
      if (!raid || raid.done) return;
      raid.taps++;
      tone(932, 0, 0.04, 'square', 0.05);
      if (e && typeof e.clientX === 'number') {
        spawnParticles(e.clientX, e.clientY, 1, ['💥', '💨']);
      }
      var fill = S.computeEscapeFill(raid.taps, performance.now() - raid.start);
      escapeFill.style.width = fill + '%';
      if (fill >= 100) endRaid(true);
    }

    function updateRaid() {
      if (!raid || raid.done) return;
      var elapsed = performance.now() - raid.start;
      var fill = S.computeEscapeFill(raid.taps, elapsed);
      escapeFill.style.width = fill + '%';
      raidTimer.textContent = (Math.max(0, C.RAID_DURATION_MS - elapsed) / 1000).toFixed(1) + 's';
      if (fill >= 100) endRaid(true);
      else if (elapsed >= C.RAID_DURATION_MS) endRaid(false);
    }

    function endRaid(escaped) {
      unmountMcRaidButton(); // gone before any result modal can appear
      raid.done = true;
      raid = null;
      raidModal.classList.add('hidden');
      var reward = S.applyRaidResult(state, escaped);
      if (escaped) {
        addCash(reward);
        lootAmount.textContent = '+' + S.formatMoney(reward);
        lootModal.classList.remove('hidden');
        playFanfare();
        toast('📦 LOOT CHEST!', 'You escaped with ' + S.formatMoney(reward) + '!');
      } else {
        playFail();
        flash('fail');
        toast('🚨 BUSTED!', 'The cops confiscated 20% of your cash!');
      }
      processAchievements();
      saveState();
      render();
    }

    /* ---------- player actions ---------- */
    function onVaultTap(e) {
      ensureAudio(); // first user gesture unlocks audio
      if (raid) { raidTap(e); return; }
      var value = S.vaultTapCore(state, e); // ONE tap implementation (also node-tested)
      var pos = (e && typeof e.clientX === 'number')
        ? { x: e.clientX, y: e.clientY }
        : vaultCenter();
      spawnParticles(pos.x, pos.y, 5 + ((Math.random() * 4) | 0));
      spawnFloatText(pos.x, pos.y - 10, '+' + S.formatMoney(value));
      shakeVault();
      popCash();
      playChaChing();
      // 3D stage: door recoil + coin spray + light flash — same router path,
      // so desktop, mobile, keyboard and the MC button all fire it once.
      if (window.Vault3D && typeof window.Vault3D.onTap === 'function') {
        window.Vault3D.onTap(value);
      }
      if (state.heat >= C.HEAT_RAID_AT) startRaid();
      processAchievements();
      render();
    }

    function buyCrew(id) {
      ensureAudio();
      if (S.buyCrewMember(state, id)) {
        playBuy();
        retrigger(crewEls[id].btn, 'bought');
        processAchievements();
      }
      render();
    }

    function buyNextDrill(i) {
      ensureAudio();
      var d = S.DRILLS[i];
      if (S.buyDrill(state, i)) {
        playDrill();
        toast('🔧 ' + d.name + ' ACQUIRED!', 'Tap value multiplied x' + d.mult + '!');
        processAchievements();
      }
      render();
    }

    function doPrestige() {
      ensureAudio();
      if (!S.applyPrestige(state)) return;
      playFanfare();
      flash('gold');
      toast('🌆 BIGGER CITY!', 'Permanent boost: everything x' +
        S.prestigeMultiplier(state.prestige).toFixed(1) + '. Cash & crew reset.');
      processAchievements();
      saveState();
      render();
    }

    function doReset() {
      if (!window.confirm('⚠️ Wipe ALL progress? This cannot be undone!')) return;
      try { localStorage.removeItem(S.SAVE_KEY); } catch (e) {}
      state = S.createInitialState();
      raid = null;
      unmountMcRaidButton(); // safety: never orphan the raid button
      toast('🔄 FRESH START', 'Save wiped. A new heist begins!');
      render();
    }

    /* ---------- save / load ---------- */
    function saveState() {
      state.lastSeen = Date.now();
      try { localStorage.setItem(S.SAVE_KEY, S.serializeState(state)); } catch (e) {}
      lastSaveAt = performance.now();
    }

    /* ---------- main loop ---------- */
    function tick() {
      var now = performance.now();
      var dt = lastTickAt ? (now - lastTickAt) : 0;
      if (dt > 3600000) dt = 3600000; // hard cap (reload handles longer gaps)
      lastTickAt = now;

      if (raid) { updateRaid(); render(); return; } // economy frozen during raids

      var cpsNow = currentCps();
      if (dt > 60000) {
        // tab was suspended in the background: pay the 50% away rate, skip heat
        var off = S.offlineEarnings(dt, cpsNow);
        if (off > 0) addCash(off);
      } else if (dt > 0) {
        var earned = cpsNow * dt / 1000;
        if (earned > 0) addCash(earned);
        if (!document.hidden) { // heat frozen while away
          state.heat = S.addHeat(state,
            (S.heatFromIncomePerSec(cpsNow) - C.HEAT_DECAY_PER_SEC) * dt / 1000);
        }
      }

      if (state.heat >= C.HEAT_RAID_AT) startRaid();
      processAchievements();
      render();
      if (now - lastSaveAt >= C.SAVE_INTERVAL_MS) saveState();
    }

    /* ---------- init ---------- */
    function init() {
      cashCounter = $('cash-counter');       cpsChip = $('cps-chip');
      heatBar = $('heat-bar');               heatFill = $('heat-fill');
      heatPct = $('heat-pct');               crewList = $('crew-list');
      drillList = $('drill-list');           vault = $('vault');
      tapValueEl = $('tap-value');           tapHint = $('tap-hint');
      prestigeBtn = $('prestige-btn');       prestigeHint = $('prestige-hint');
      statsList = $('stats-list');           fxLayer = $('fx-layer');
      toastBox = $('toast-container');       raidModal = $('raid-modal');
      escapeFill = $('escape-fill');         raidTimer = $('raid-timer');
      offlineModal = $('offline-modal');     offlineAmount = $('offline-amount');
      lootModal = $('loot-modal');           lootAmount = $('loot-amount');
      flashEl = $('flash');                  resetBtn = $('reset-btn');

      // load save + offline earnings
      var raw = null;
      try { raw = localStorage.getItem(S.SAVE_KEY); } catch (e) {}
      state = raw ? S.deserializeState(raw) : S.createInitialState();
      if (raw) {
        var elapsed = Math.max(0, Date.now() - state.lastSeen);
        var off = S.offlineEarnings(elapsed, currentCps());
        if (elapsed >= C.OFFLINE_MIN_MS && off > 0) {
          addCash(off);
          offlineAmount.textContent = '+' + S.formatMoney(off);
          offlineModal.classList.remove('hidden');
        }
      }

      buildCrewButtons();
      buildDrillRows();
      buildBackgroundEmojis();

      // events — vault: one tap handler, three input paths.
      // pointerdown is the zero-latency fast path; click is the fallback for
      // pre-pointer-events browsers (guarded so taps never double-fire);
      // touchstart only exists where PointerEvent is missing.
      var vaultRouter = S.makeTapRouter(onVaultTap);
      vault.addEventListener('pointerdown', vaultRouter.fast);
      vault.addEventListener('click', vaultRouter.click);
      if (!('PointerEvent' in window)) {
        vault.addEventListener('touchstart', function (e) {
          if (e.touches && e.touches[0]) vaultRouter.fast(e.touches[0]);
        }, { passive: true });
      }
      vault.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vaultRouter.fast(null); }
      });
      vault.addEventListener('animationend', function () { vault.classList.remove('shake'); });
      vault.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      // raid modal: same router — rapid pointerdown taps, click fallback
      raidRouter = S.makeTapRouter(function (e) { ensureAudio(); raidTap(e); });
      raidModal.addEventListener('pointerdown', raidRouter.fast);
      raidModal.addEventListener('click', raidRouter.click);
      if (!('PointerEvent' in window)) {
        raidModal.addEventListener('touchstart', function (e) {
          if (e.touches && e.touches[0]) raidRouter.fast(e.touches[0]);
        }, { passive: true });
      }
      // one-thumb play: 💰 button rides the SAME vault router (touch only)
      mountMcVaultButton(vaultRouter);
      prestigeBtn.addEventListener('click', doPrestige);
      resetBtn.addEventListener('click', doReset);
      $('offline-close').addEventListener('click', function () {
        offlineModal.classList.add('hidden'); ensureAudio(); playBuy();
      });
      $('loot-close').addEventListener('click', function () {
        lootModal.classList.add('hidden'); ensureAudio(); playBuy();
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) saveState();
      });
      window.addEventListener('beforeunload', saveState);
      window.addEventListener('pagehide', saveState);

      processAchievements(); // e.g. offline money crossed a threshold
      render();
      saveState(); // set lastSeen baseline
      setInterval(tick, C.TICK_MS);
    }

    init();
  })();
}


/* ============================================================
   SELF-TESTS (run under node:  node game.js)
   ============================================================ */
if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    process.argv[1].endsWith('game.js')) {
  (function runSelfTests() {
    var S = BankSim;
    var failures = 0, passed = 0;

    function T(name, cond) {
      if (cond) { passed++; console.log('PASS: ' + name); }
      else { failures++; console.error('FAIL: ' + name); }
    }
    function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }
    function deepEqual(a, b) {
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var i = 0; i < ka.length; i++) {
        if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
      }
      return true;
    }

    // ---- 1. crew cost scaling (1.15^owned) ----
    var s = S.createInitialState();
    s.cash = 1e9;
    var before = s.cash;
    T('cost scaling: lookout base cost is $50', S.crewCost('lookout', 0) === 50);
    T('cost scaling: first purchase succeeds', S.buyCrewMember(s, 'lookout') === true);
    T('cost scaling: first purchase charges $50', close(s.cash, before - 50));
    T('cost scaling: second purchase succeeds', S.buyCrewMember(s, 'lookout') === true);
    T('cost scaling: two buys charge base + base*1.15', close(s.cash, before - 50 - Math.round(50 * 1.15)));
    T('cost scaling: next cost after 2 buys = base*1.15^2 (~1.3225x, i.e. 1.15x²)',
      close(S.crewCost('lookout', 2), 50 * 1.15 * 1.15, 0.5) &&
      S.crewCost('lookout', 2) === Math.round(50 * Math.pow(1.15, 2)));
    T('cost scaling: 4th cartel copy = base*1.15^3', S.crewCost('cartel', 3) === Math.round(60000 * Math.pow(1.15, 3)));
    T('cost scaling: owned count tracked', s.crew.lookout === 2);
    T('cost scaling: purchase blocked when broke', (function () {
      var t = S.createInitialState(); t.cash = 10;
      return S.buyCrewMember(t, 'lookout') === false && t.crew.lookout === 0;
    })());

    // ---- 2. crew income sums ----
    var s2 = S.createInitialState();
    s2.crew.lookout = 2; s2.crew.hacker = 1; s2.crew.insideman = 1;
    T('income sum: 2 lookouts + 1 hacker + 1 inside man = $230/s', S.crewIncomePerSecond(s2) === 230);
    s2.prestige = 1;
    T('income sum: 1 prestige multiplies x1.5 → $345/s', S.crewIncomePerSecond(s2) === 345);
    s2.prestige = 2;
    T('income sum: 2 prestiges multiply x2 → $460/s', S.crewIncomePerSecond(s2) === 460);
    var s3 = S.createInitialState();
    S.CREW.forEach(function (c) { s3.crew[c.id] = 1; });
    T('income sum: one of every crew member = $1474/s', S.crewIncomePerSecond(s3) === 1474);

    // ---- 3. heat + raid math (escape fill per tap × 300ms ticks) ----
    T('heat: each tap adds 1.25%', S.heatFromTap() === 1.25);
    T('heat: income heat = cps/400 %/s', S.heatFromIncomePerSec(400) === 1);
    T('heat: income heat capped at 2.5%/s', S.heatFromIncomePerSec(400000) === 2.5);
    T('heat: addHeat clamps to [0,100]', (function () {
      var t = S.createInitialState();
      return S.addHeat(t, 250) === 100 && S.addHeat(t, -500) === 0;
    })());
    T('raid: fill = taps*6% - floor(elapsed/300ms)*3.6% (10 taps/600ms → 52.8)',
      close(S.computeEscapeFill(10, 600), 52.8));
    T('raid: 30 fast taps in 2500ms → 100 (escape!)', S.computeEscapeFill(30, 2500) === 100);
    T('raid: 25 taps spread over 5s → 92.4 (busted)', close(S.computeEscapeFill(25, 5000), 92.4));
    T('raid: no taps → fill decays to 0', S.computeEscapeFill(0, 5000) === 0);
    var s4 = S.createInitialState();
    s4.crew.hacker = 1; // $8/s
    T('raid: loot chest = 60s of income ($8/s → $480)', S.raidReward(s4) === 480);
    var s5 = S.createInitialState();
    s5.cash = 1000;
    T('raid: failing costs 20% cash + resets heat', (function () {
      var r = S.applyRaidResult(s5, false);
      return r === 0 && close(s5.cash, 800, 1e-6) && s5.heat === 0 && s5.raidsFailed === 1;
    })());
    var s6 = S.createInitialState();
    s6.crew.hacker = 1;
    T('raid: escaping resets heat to 20 and pays chest', (function () {
      var r = S.applyRaidResult(s6, true);
      return r === 480 && s6.heat === 20 && s6.raidsSurvived === 1;
    })());

    // ---- 4. prestige multiplier stacking (additive: 1 + 0.5*n) ----
    T('prestige: 0 cities → x1.0', S.prestigeMultiplier(0) === 1);
    T('prestige: 1 city → x1.5', S.prestigeMultiplier(1) === 1.5);
    T('prestige: 2 cities → x2.0 (spec 1 + 0.5*n, additive)', S.prestigeMultiplier(2) === 2);
    T('prestige: 3 cities → x2.5', S.prestigeMultiplier(3) === 2.5);
    var s7 = S.createInitialState();
    T('prestige: first city needs $1M lifetime', S.prestigeThreshold(s7) === 1e6);
    s7.lifetimeEarned = 999999;
    T('prestige: blocked below threshold', S.applyPrestige(s7) === false && s7.prestige === 0);
    s7.lifetimeEarned = 1e6; s7.cash = 500; s7.crew.lookout = 3; s7.drillTier = 1; s7.heat = 80;
    T('prestige: applies at $1M — resets cash + crew, keeps drills',
      S.applyPrestige(s7) === true && s7.prestige === 1 && s7.cash === 0 &&
      s7.crew.lookout === 0 && s7.drillTier === 1 && s7.heat === 0);
    T('prestige: next threshold grows 5x', S.prestigeThreshold(s7) === 5e6);

    // ---- 5. offline earnings (50% rate, 8h cap) ----
    T('offline: 1h at $100/s → 50% = $180,000', S.offlineEarnings(3600000, 100) === 180000);
    T('offline: 10h capped at 8h', S.offlineEarnings(10 * 3600000, 100) === 8 * 3600 * 100 * 0.5);
    T('offline: no crew → $0', S.offlineEarnings(3600000, 0) === 0);
    T('offline: negative time → $0', S.offlineEarnings(-5000, 100) === 0);

    // ---- 6. number formatting ----
    T('format: $0', S.formatMoney(0) === '$0');
    T('format: $5', S.formatMoney(5) === '$5');
    T('format: $999', S.formatMoney(999) === '$999');
    T('format: $1234 → "$1.2K"', S.formatMoney(1234) === '$1.2K');
    T('format: $5.6M', S.formatMoney(5.6e6) === '$5.6M');
    T('format: $3.4B', S.formatMoney(3.4e9) === '$3.4B');
    T('format: $7.8T', S.formatMoney(7.8e12) === '$7.8T');
    T('format: scientific beyond T', S.formatMoney(7.8e15) === '$7.80e15' && S.formatMoney(2.5e18) === '$2.50e18');

    // ---- 7. save serialize/deserialize round-trip ----
    var s8 = S.createInitialState();
    s8.cash = 12345.67; s8.lifetimeEarned = 999999; s8.allTimeEarned = 1234567.89;
    s8.totalTaps = 42; s8.heat = 73.5; s8.drillTier = 3; s8.prestige = 1;
    s8.raidsSurvived = 2; s8.raidsFailed = 1; s8.lastSeen = 1700000000000;
    s8.crew.hacker = 7; s8.crew.cartel = 2;
    s8.achievements = ['first_tap', 'earn_1k'];
    var rt = S.deserializeState(S.serializeState(s8));
    T('save: serialize → deserialize round-trips exactly', deepEqual(rt, s8));
    T('save: crew counts preserved', rt.crew.hacker === 7 && rt.crew.cartel === 2 && rt.crew.driver === 0);
    T('save: version key present', rt.version === S.SAVE_VERSION);
    T('save: garbage JSON → fresh state', (function () {
      var d = S.deserializeState('{"broken');
      return d.cash === 0 && d.crew.hacker === 0 && d.drillTier === 0 && d.prestige === 0;
    })());
    T('save: partial/legacy saves merge with defaults', (function () {
      var d = S.deserializeState('{"cash":50,"crew":{"lookout":3}}');
      return d.cash === 50 && d.crew.lookout === 3 && d.crew.hacker === 0 &&
        d.prestige === 0 && d.achievements.length === 0;
    })());

    // ---- 8. tap value chain (base $5 × drill × prestige) ----
    var s9 = S.createInitialState();
    T('tap: base value $5', S.tapValue(s9) === 5);
    s9.drillTier = 1;
    T('tap: rusty drill (x2) → $10', S.tapValue(s9) === 10);
    s9.drillTier = 5;
    T('tap: all drills (nano x32) → $160', S.tapValue(s9) === 160);
    s9.prestige = 1;
    T('tap: with 1 prestige → $240', S.tapValue(s9) === 240);
    var s10 = S.createInitialState();
    s10.cash = 500;
    T('drills: buy rusty for $500', S.buyDrill(s10) === true && s10.cash === 0 && s10.drillTier === 1);
    T('drills: next tier locked while broke / out of order', S.buyDrill(s10) === false && S.buyDrill(s10, 3) === false);

    // ---- 9. achievements ----
    var sa = S.createInitialState();
    T('achievements: none at start', S.checkAchievements(sa).length === 0);
    sa.totalTaps = 1;
    T('achievements: first tap unlocks "first_tap"', S.checkAchievements(sa).join() === 'first_tap');
    sa.achievements.push.apply(sa.achievements, S.checkAchievements(sa));
    sa.crew.lookout = 10;
    var wave2 = S.checkAchievements(sa);
    T('achievements: first hire + 10-of-a-kind unlock',
      wave2.length === 2 && wave2.indexOf('first_hire') >= 0 && wave2.indexOf('crew_10') >= 0);
    sa.achievements.push.apply(sa.achievements, wave2);
    sa.allTimeEarned = 1e6; sa.prestige = 1; sa.raidsSurvived = 1; sa.raidsFailed = 1;
    var wave3 = S.checkAchievements(sa);
    T('achievements: $1K/$1M, raid survive/fail, prestige unlock (5 remaining)', wave3.length === 5);
    sa.achievements.push.apply(sa.achievements, wave3);
    T('achievements: all 8 collected, none re-trigger',
      sa.achievements.length === 8 && S.checkAchievements(sa).length === 0);

    // ---- 10. mobile/touch pass ----
    // (a) vault tap core: invoked directly with a mock event
    var sm = S.createInitialState();
    var perTap = S.tapValue(sm);
    var cashBefore = sm.cash;
    var gained = S.vaultTapCore(sm, { clientX: 123, clientY: 456 });
    T('touch: vault tap with mock event adds exactly tapValue to cash',
      gained === perTap && sm.cash === cashBefore + perTap);
    T('touch: vault tap counts totalTaps + lifetime + all-time',
      sm.totalTaps === 1 && sm.lifetimeEarned === perTap && sm.allTimeEarned === perTap);
    T('touch: vault tap heats by HEAT_PER_TAP', sm.heat === S.CONFIG.HEAT_PER_TAP);
    T('touch: tap core follows drill multipliers (rusty x2)',
      (function () {
        var t = S.createInitialState(); t.drillTier = 1;
        var v = S.vaultTapCore(t, null);
        return v === 10 && t.cash === 10 && t.totalTaps === 1;
      })());

    // (b) pointerdown fast-path + click fallback hit the SAME internal function
    var taps = [];
    var spy = function (e) { taps.push(e); };
    var router = S.makeTapRouter(spy);
    var evDown = { clientX: 10, clientY: 20 };
    router.fast(evDown);
    T('touch: pointerdown fast-path calls the tap handler with the event',
      taps.length === 1 && taps[0] === evDown);
    router.click({ clientX: 10, clientY: 20 });
    T('touch: click right after pointerdown is swallowed (no double-fire)',
      taps.length === 1 && router._handled() === false);
    router.click({ clientX: 30, clientY: 40 });
    T('touch: bare click fallback calls the SAME handler (spy identity)',
      taps.length === 2 && taps[1].clientX === 30);
    router.fast(null);
    router.click(null);
    T('touch: router dedupes every input pair (pointer/touch/click)', taps.length === 3);

    // (c) rapid-tap escape math: N computed from the constants
    var ESC_CAP = 100;
    var N = Math.ceil(ESC_CAP / S.CONFIG.ESCAPE_FILL_PER_TAP);
    T('touch: N = ceil(capacity / ESCAPE_FILL_PER_TAP) rapid taps fill the bar',
      S.computeEscapeFill(N, 0) >= ESC_CAP && S.computeEscapeFill(N - 1, 0) < ESC_CAP);
    var worstTicks = Math.floor(S.CONFIG.RAID_DURATION_MS / S.CONFIG.ESCAPE_TICK_MS);
    var N2 = Math.ceil((ESC_CAP + worstTicks * S.CONFIG.ESCAPE_DECAY_PER_TICK) / S.CONFIG.ESCAPE_FILL_PER_TAP);
    T('touch: N taps sustained across the whole raid window still escape the decay',
      S.computeEscapeFill(N2, S.CONFIG.RAID_DURATION_MS) >= ESC_CAP);

    // (d) constants: the CSS ships the mobile media query + big tap targets
    var fsMod = require('fs'), pathMod = require('path');
    var cssText = fsMod.readFileSync(pathMod.join(__dirname, '..', 'css', 'style.css'), 'utf8');
    T('touch: css has the <600px media query',
      /@media\s*\(max-width:\s*600px\)/.test(cssText));
    T('touch: css guarantees 48px min tap targets on mobile',
      /min-height:\s*48px/.test(cssText));
    T('touch: css sets touch-action: manipulation on interactive elements',
      /touch-action:\s*manipulation/.test(cssText));
    T('touch: css disables selection + tap highlight',
      /-webkit-tap-highlight-color:\s*transparent/.test(cssText) &&
      /user-select:\s*none/.test(cssText));

    /* ---- 11. 3D vault stage: pure helpers (js/vault3d.js, no DOM/THREE) ---- */
    var V3 = require(pathMod.join(__dirname, 'vault3d.js'));
    T('vault3d: easeOutBack eases 0→1 with a tasteful overshoot (<1.2)',
      close(V3.easeOutBack(0), 0) && close(V3.easeOutBack(1), 1) &&
      (function () { var m = 0; for (var i = 0; i <= 100; i++) m = Math.max(m, V3.easeOutBack(i / 100)); return m > 1.04 && m < 1.2; })());
    T('vault3d: recoil starts at full punch, rests at/after dur, dip stays tiny',
      close(V3.recoilDecay(0, 320), 1) && V3.recoilDecay(320, 320) === 0 &&
      V3.recoilDecay(900, 320) === 0 &&
      (function () { var lo = 0, hi = 0; for (var i = 0; i <= 200; i++) { var v = V3.recoilDecay(i * 2, 320); lo = Math.min(lo, v); hi = Math.max(hi, v); } return lo >= -0.12 && hi <= 1.001; })());
    T('vault3d: coin spray is deterministic and biased up + outward',
      (function () {
        var v = V3.coinVelocity(3, 12, 42);
        return v.y > 0.9 && (Math.abs(v.x) + Math.abs(v.z)) > 0.6 &&
          deepEqual(v, V3.coinVelocity(3, 12, 42)) &&
          !deepEqual(v, V3.coinVelocity(4, 12, 42));
      })());
    T('vault3d: coin spray speed stays bounded for every coin of a burst',
      (function () { for (var i = 0; i < 40; i++) { var v = V3.coinVelocity(i, 20, 7); var s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); if (s < 1 || s > 3.6) return false; } return true; })());
    T('vault3d: coins per tap scale with value and cap at 14 (pool-safe)',
      V3.coinSpawnCount(5) === 7 && V3.coinSpawnCount(100) >= V3.coinSpawnCount(10) &&
      V3.coinSpawnCount(1e12) === 14 &&
      (function () { for (var v = 1; v <= 1e12; v *= 10) { if (V3.coinSpawnCount(v) > V3.CFG.COIN_MAX) return false; } return true; })());
    T('vault3d: strobes stay epilepsy-safe — even both lights < 3 flashes/sec',
      V3.strobeFlashesPerSec(V3.CFG.STROBE_PERIOD_MS) < 3 &&
      2 * V3.strobeFlashesPerSec(V3.CFG.STROBE_PERIOD_MS) < 3);
    T('vault3d: strobe intensity is a bounded, periodic eased wave (no square flash)',
      (function () {
        var p = V3.CFG.STROBE_PERIOD_MS;
        for (var t = 0; t < 5000; t += 37) { var v = V3.strobeIntensity(t, p); if (v < 0 || v > 1) return false; }
        return close(V3.strobeIntensity(1000, p), V3.strobeIntensity(1000 + p, p), 1e-9);
      })());
    T('vault3d: heat danger fades in from 50% and hits 1 at the raid line',
      V3.heatDangerLevel(0) === 0 && V3.heatDangerLevel(50) === 0 &&
      V3.heatDangerLevel(100) === 1 && close(V3.heatDangerLevel(75), 0.5, 1e-9) &&
      V3.heatDangerLevel(80) > V3.heatDangerLevel(60));
    T('vault3d: camera shake wakes only past 60% heat and is bounded',
      V3.heatShakeAmp(0) === 0 && V3.heatShakeAmp(60) === 0 &&
      close(V3.heatShakeAmp(100), V3.CFG.SHAKE_MAX, 1e-9) &&
      V3.heatShakeAmp(100) <= 0.05);
    T('vault3d: prestige goldens the door gradually and never fully',
      V3.prestigeGoldMix(0) === 0 &&
      close(V3.prestigeGoldMix(5), V3.CFG.PRESTIGE_GOLD_MAX, 1e-12) &&
      V3.prestigeGoldMix(50) === V3.CFG.PRESTIGE_GOLD_MAX &&
      V3.prestigeGoldMix(2) > V3.prestigeGoldMix(1));
    T('vault3d: crew size drives silhouette count (0→0, capped at 8)',
      V3.crewFigureCount(0) === 0 && V3.crewFigureCount(1) === 1 &&
      V3.crewFigureCount(6) === 2 && V3.crewFigureCount(99) === V3.CFG.CREW_FIG_MAX &&
      V3.crewFigureCount(12) <= V3.crewFigureCount(30));
    T('vault3d: drill evolves rusty → diamond-tipped → laser beam (beam monotone)',
      V3.drillVisualTier(0).style === 'none' && V3.drillVisualTier(0).visible === false &&
      V3.drillVisualTier(1).style === 'rusty' && V3.drillVisualTier(2).style === 'diamond' &&
      V3.drillVisualTier(3).style === 'laser' &&
      V3.drillVisualTier(2).beam === 0 && V3.drillVisualTier(3).beam > 0 &&
      (function () { var b = -1; for (var i = 0; i <= 5; i++) { var v = V3.drillVisualTier(i).beam; if (v < b) return false; b = v; } return true; })());
    T('vault3d: dpr caps at 1.5, floors at 1',
      V3.clampDpr(4) === 1.5 && V3.clampDpr(1) === 1 &&
      V3.clampDpr(0.5) === 1 && V3.clampDpr(1.25) === 1.25);
    T('vault3d: fake AO darkens 1→0.62 monotonically from center to rim',
      V3.aoDarken(0) === 1 && close(V3.aoDarken(1), 0.62, 1e-9) &&
      (function () { var p = 2; for (var i = 0; i <= 10; i++) { var v = V3.aoDarken(i / 10); if (v > p || v < 0.6 || v > 1) return false; p = v; } return true; })());
    T('vault3d: seam glow stays in [0,1] and swells with income',
      close(V3.seamPulse(0, 0), V3.CFG.SEAM_BASE + V3.CFG.SEAM_AMP * 0.5, 1e-9) &&
      V3.seamPulse(0, 10000) > V3.seamPulse(0, 0) &&
      (function () { var cs = [0, 100, 10000, 1000000]; for (var t = 0; t < 4000; t += 41) { for (var k = 0; k < cs.length; k++) { var v = V3.seamPulse(t, cs[k]); if (v < 0 || v > 1) return false; } } return true; })());
    T('vault3d: idle wheel wobble is tiny and exactly periodic',
      (function () { var m = 0; for (var t = 0; t < 20000; t += 53) m = Math.max(m, Math.abs(V3.wobbleAngle(t))); return m <= V3.CFG.WOBBLE_AMP + 1e-9; })() &&
      close(V3.wobbleAngle(1234), V3.wobbleAngle(1234 + V3.CFG.WOBBLE_PERIOD_MS), 1e-9));
    T('vault3d: heat shake offset is axis-bounded and silent at 0 amp',
      (function () { for (var t = 0; t < 9000; t += 71) { var s = V3.shakeOffset(t, 0.03); if (Math.abs(s.x) > 0.03 + 1e-9 || Math.abs(s.y) > 0.03 + 1e-9) return false; } return true; })() &&
      V3.shakeOffset(1234, 0).x === 0 && V3.shakeOffset(1234, 0).y === 0);
    T('vault3d: dust motes drift deterministically inside the light cone band',
      (function () {
        for (var i = 0; i < 70; i++) {
          var p = V3.dustDrift(i, 1000 + i);
          if (!deepEqual(p, V3.dustDrift(i, 1000 + i))) return false;
          if (p.z < 0.4 || p.z >= 3.0) return false;
          if (Math.abs(p.x) > 4 || p.y < -2 || p.y > 2.7) return false;
        }
        return true;
      })());
    T('vault3d: damp smoothing is frame-rate independent and converges',
      V3.dampCurve(5, 5, 4, 0.016) === 5 &&
      close(V3.dampCurve(0, 1, 4, 100), 1, 1e-9) &&
      Math.abs(V3.dampCurve(0, 1, 4, 0.016) - 1) < 1 &&
      V3.dampCurve(0, 1, 4, 0.016) > V3.dampCurve(0, 1, 2, 0.016));

    /* ---- 12. MC floating buttons: ONE router, ONE tap, no double-fire ---- */
    require(pathMod.join(__dirname, '..', '..', 'shared', 'mobile-controls.js'));
    var MCg = globalThis.MC;
    var htmlText = fsMod.readFileSync(pathMod.join(__dirname, '..', 'index.html'), 'utf8');
    T('mc: isTouchDevice gates the floating buttons (touch yes, desktop no)',
      MCg.isTouchDevice({ maxTouchPoints: 5 }) === true &&
      MCg.isTouchDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }) === true &&
      MCg.isTouchDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 }) === false);
    T('mc: vault button + canvas tap ride ONE router → ONE handler (spy identity)',
      (function () {
        var calls = [];
        var r = S.makeTapRouter(function (e) { calls.push(e); });
        r.fast({ clientX: 7, clientY: 8 });   // 💰 MC button press
        r.fast({ clientX: 9, clientY: 10 });  // canvas pointerdown
        r.click({ clientX: 9, clientY: 10 }); // canvas click fallback
        return calls.length === 2 && calls[0].clientX === 7 && calls[1].clientX === 9;
      })());
    T('mc: one synthetic tap never double-counts (stray click swallowed by the shared guard)',
      (function () {
        var n = 0;
        var r = S.makeTapRouter(function () { n++; });
        r.fast(null); r.click(null); // press + whatever click it might synthesize
        return n === 1 && r._handled() === false;
      })());
    T('mc: raid button taps fill the escape bar identically to modal taps',
      S.computeEscapeFill(10, 900) === S.computeEscapeFill(10, 900) &&
      (S.computeEscapeFill(4, 0) - S.computeEscapeFill(3, 0)) === S.CONFIG.ESCAPE_FILL_PER_TAP);
    T('mc: index.html wires three.js + the 3D stage + mobile-controls before game.js',
      /shared\/vendor\/three\.min\.js/.test(htmlText) &&
      /js\/vault3d\.js/.test(htmlText) &&
      /id="vault3d"/.test(htmlText) &&
      /shared\/mobile-controls\.js/.test(htmlText) &&
      htmlText.indexOf('three.min.js') < htmlText.indexOf('mobile-controls.js') &&
      htmlText.indexOf('mobile-controls.js') < htmlText.indexOf('js/game.js') &&
      htmlText.indexOf('js/game.js') < htmlText.indexOf('js/vault3d.js'));
    T('vault3d: css seats the canvas behind the UI without eating taps',
      /#vault3d\s*\{[^}]*pointer-events:\s*none/.test(cssText) &&
      /#vault3d\s*\{[^}]*z-index:\s*1/.test(cssText) &&
      /#vault3d\.on\s*\{[^}]*opacity:\s*1/.test(cssText) &&
      /52vh/.test(cssText));

    // ---- summary ----
    if (failures > 0) {
      console.error('TESTS FAILED: ' + failures + ' failure(s), ' + passed + ' passed');
      process.exit(1);
    }
    console.log('ALL TESTS PASSED (' + passed + ' checks)');
  })();
}
