/* DOPAMINE FACTORY — js/game.js
 * Orchestrator + event bus + integration glue. DP.Events is defined FIRST
 * (every other module guards on it), then DP.Game: boot sequence, fixed-dt
 * logic loop (1/60 accumulator, max 5 steps/frame), input semantics (tap =
 * pop, drag same-tier = merge, drag empty = move), spawn timer, continuous
 * income, combo decay, wheel cooldown, quests fed from the bus, autosave
 * (5s + unload + hidden), ascend flow, MC touch button cluster.
 *
 * Every module call is guarded: missing/broken modules degrade gracefully
 * (warn list at boot + canon-math fallbacks below) — game.js alone boots a
 * playable game. No per-frame allocations on the hot path.
 */
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});

/* ================= EVENT BUS (FIRST — everything guards on it) =================
 * emit(name, data) · on(name, fn) → off() · off(name, fn)
 * '*' subscribers receive every event as fn(name, data) (quest feed).
 * A throwing subscriber never breaks emit; off() is tombstone-based so it is
 * safe to call from inside a handler while emit is iterating.
 */
DP.Events = {
  _subs: {},

  on: function (name, fn) {
    if (typeof fn !== 'function') return function () {};
    var subs = this._subs;
    var a = subs[name];
    if (!a) a = subs[name] = [];
    else if (a.length > 64) {              /* compact dead entries when grown */
      var live = [], i;
      for (i = 0; i < a.length; i++) if (a[i]) live.push(a[i]);
      a = subs[name] = live;
    }
    a.push(fn);
    var self = this;
    return function () { self.off(name, fn); };
  },

  off: function (name, fn) {
    var a = this._subs[name];
    if (!a) return;
    for (var i = 0; i < a.length; i++) if (a[i] === fn) a[i] = null;   /* tombstone */
  },

  emit: function (name, data) {
    var a = this._subs[name], i, fn;
    if (a) {
      for (i = 0; i < a.length; i++) {
        fn = a[i];
        if (fn) { try { fn(data); } catch (e) { /* one bad subscriber never breaks emit */ } }
      }
    }
    a = this._subs['*'];
    if (a) {
      for (i = 0; i < a.length; i++) {
        fn = a[i];
        if (fn) { try { fn(name, data); } catch (e) {} }
      }
    }
  },

  count: function (name) {
    var a = this._subs[name], n = 0;
    if (a) for (var i = 0; i < a.length; i++) if (a[i]) n++;
    return n;
  }
};

/* ================= GAME (orchestrator) ================= */
DP.Game = {
  SAVE_KEY: 'dopamine_factory_v1',
  LOGIC_DT: 1 / 60,
  MAX_STEPS: 5,
  SAVE_EVERY: 5,
  INCOME_FLUSH_EVERY: 0.25,
  VERSION: '1.0.0',

  state: null, board: null, wheelState: null, questState: null,
  mods: null, missing: [],
  headless: false, running: false,
  time: 0, nowMs: 0, acc: 0, saveT: 0,
  incomeAcc: 0, incomeAccT: 0, buffT: 0, luckyRain: 0,
  _raf: 0, _lastRaf: 0, _boundFrame: null,
  _boardDirty: true, _questHook: null, _questBusy: false, _lifeHooked: false,
  _lastTapIdx: -1, _lastTapMs: -1e9, _lastDragFrom: -1, _lastDragTo: -1, _lastDragMs: -1e9,
  _scratchWorld: { x: 0, z: 0 },
  _qBefore: [false, false, false, false, false, false, false, false],
  _qAfter: [false, false, false, false, false, false, false, false],
  _questCap: null, _questEmits: null, _questEmitN: 0,
  _mc: null,

  /* ---------- module presence (warn-missing list) ---------- */
  _detectModules: function () {
    var M = this.mods = {
      content: typeof DP.Content !== 'undefined',
      core: typeof DP.Core !== 'undefined',
      board: typeof DP.Board !== 'undefined',
      wheel: typeof DP.Wheel !== 'undefined',
      quests: typeof DP.Quests !== 'undefined',
      audio: typeof DP.Audio !== 'undefined',
      fx: typeof DP.FX !== 'undefined',
      render3d: typeof DP.Render3D !== 'undefined',
      input: typeof DP.Input !== 'undefined',
      ui: typeof DP.UI !== 'undefined'
    };
    var missing = this.missing = [];
    if (!M.content) missing.push('js/content.js (DP.Content)');
    if (!M.core) missing.push('js/core.js (DP.Core)');
    if (!M.board) missing.push('js/board.js (DP.Board)');
    if (!M.wheel) missing.push('js/wheel.js (DP.Wheel)');
    if (!M.quests) missing.push('js/quests.js (DP.Quests)');
    if (!M.audio) missing.push('js/audio.js (DP.Audio)');
    if (!M.fx) missing.push('js/fx.js (DP.FX)');
    if (!M.render3d) missing.push('js/render3d.js (DP.Render3D)');
    if (!M.input) missing.push('js/input.js (DP.Input)');
    if (!M.ui) missing.push('js/ui.js (DP.UI)');
    if (missing.length && typeof console !== 'undefined') {
      console.warn('[DOPAMINE FACTORY] missing modules — running degraded:\n  ' + missing.join('\n  '));
    }
    return missing;
  },

  /* ---------- boot ---------- */
  boot: function (opts) {
    opts = opts || {};
    this.headless = !!(opts.headless);
    this._detectModules();

    /* sim clock (authoritative — drives combo window + wheel cooldown) */
    this.nowMs = Date.now();
    this.time = 0; this.acc = 0; this.saveT = 0;
    this.incomeAcc = 0; this.incomeAccT = 0;
    this._boardDirty = true; this._questBusy = false;
    this._lastTapIdx = -1; this._lastTapMs = -1e9;
    this._lastDragFrom = -1; this._lastDragTo = -1; this._lastDragMs = -1e9;

    /* core state: load save or newState */
    var data = this._loadSave();
    var fresh = !data;
    this.state = data ? this._restoreState(data) : this._newState();
    if (!this.state.discovered || typeof this.state.discovered !== 'object') this.state.discovered = {};
    if (!this.state.upgrades || typeof this.state.upgrades !== 'object') this.state.upgrades = {};
    if (!this.state.settings || typeof this.state.settings !== 'object') this.state.settings = { muted: false };
    if (!isFinite(this.state.spawnT)) this.state.spawnT = 1;

    /* board (gridSize upgrade level decides size) */
    var size = (data && isFinite(data.size) && data.size >= 3) ? data.size : this.gridSize();
    this.board = this._createBoard(size);
    if (data && data.cells) this._restoreCells(data.cells);

    /* wheel + quests */
    this.wheelState = this._newWheelState();
    if (data && data.wheel) this._mergeInto(this.wheelState, data.wheel);
    this.questState = this._newQuestState();
    if (data && data.quests) this._mergeInto(this.questState, data.quests);
    this.buffT = (data && isFinite(data.buffT) && data.buffT > 0) ? data.buffT : 0;
    this.luckyRain = (data && isFinite(data.luckyRain) && data.luckyRain > 0) ? data.luckyRain : 0;

    /* wire modules (guarded; headless skips the THREE/canvas stack) */
    this._initRender();
    this._initFx();
    this._initAudio();
    this._initUi();
    this._initInput();
    this._hookQuests();

    /* offline earnings (modal when UI provides one) */
    this._applyOffline();

    DP.Events.emit('load', { fresh: fresh });

    /* fresh game: rotating quests + starter cubes for instant dopamine */
    if (fresh) {
      this.rerollQuests();
      this._spawnOne(); this._spawnOne(); this._spawnOne();
      this.state.spawnT = this.spawnInterval();
    }

    this._mountMc(false);          /* touch / narrow screens only */
    this._hookLife();
    if (!this.headless) this.start();
    return true;
  },

  /* ---------- loop: fixed-dt logic accumulator + rAF render ---------- */
  start: function () {
    if (this.running) return;
    this.running = true;
    this._lastRaf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!this._boundFrame) this._boundFrame = this._frame.bind(this);
    if (typeof requestAnimationFrame === 'function') this._raf = requestAnimationFrame(this._boundFrame);
  },

  stop: function () {
    this.running = false;
    try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf); } catch (e) {}
  },

  _frame: function () {
    if (!this.running) return;
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var dt = (now - this._lastRaf) / 1000;
    this._lastRaf = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;                  /* tab-return clamp */
    this.acc += dt;
    var steps = 0;
    while (this.acc >= this.LOGIC_DT && steps < this.MAX_STEPS) {
      this.update(this.LOGIC_DT);
      this.acc -= this.LOGIC_DT;
      steps++;
    }
    if (steps === this.MAX_STEPS) this.acc = 0; /* drop backlog */
    this.render(dt);
    if (this.running && typeof requestAnimationFrame === 'function') {
      this._raf = requestAnimationFrame(this._boundFrame);
    }
  },

  /* ---------- one logic step (1/60) ---------- */
  update: function (dt) {
    if (!this.state || !(dt > 0)) return;
    var s = this.state;
    this.time += dt;
    this.nowMs += dt * 1000;

    /* spawn timer (contract interval; lucky rain forces lucky) */
    s.spawnT -= dt;
    if (s.spawnT <= 0) {
      var spawned = this._spawnOne();
      s.spawnT = spawned ? this.spawnInterval() : 0.5;
    }

    /* idle income: totalValue × 0.05/s × incomeMult, paid continuously */
    var inc = this.incomePerSec() * dt;
    if (inc > 0 && isFinite(inc)) {
      if (this.mods.core && typeof DP.Core.addCoins === 'function') {
        try { DP.Core.addCoins(s, inc); } catch (e) { s.coins += inc; s.lifetime += inc; }
      } else { s.coins += inc; s.lifetime += inc; }
      this.incomeAcc += inc;
    }
    this.incomeAccT += dt;
    if (this.incomeAccT >= this.INCOME_FLUSH_EVERY) {      /* coins event max 4/s */
      this.incomeAccT = 0;
      if (this.incomeAcc > 0) {
        DP.Events.emit('coins', { amount: this.incomeAcc, total: s.coins });
        this.incomeAcc = 0;
      }
    }

    /* combo decay */
    if (this.mods.core && typeof DP.Core.comboTick === 'function') {
      try { DP.Core.comboTick(s, dt); } catch (e) { this._fbComboTick(s, dt); }
    } else this._fbComboTick(s, dt);

    /* income×2 wheel buff */
    if (this.buffT > 0) { this.buffT -= dt; if (this.buffT <= 0) this.buffT = 0; }

    /* wheel cooldown tick */
    if (this.mods.wheel && typeof DP.Wheel.tick === 'function') {
      try { DP.Wheel.tick(this.wheelState, this.nowMs); } catch (e) {}
    }

    /* autosave */
    this.saveT += dt;
    if (this.saveT >= this.SAVE_EVERY) { this.saveT = 0; this.save(); }
  },

  render: function (dt) {
    if (this.mods.render3d && !this.headless) {
      if (this._boardDirty) {
        this._boardDirty = false;
        try { DP.Render3D.setBoard(this.board); } catch (e) {}
      }
      try { DP.Render3D.frame(dt || this.LOGIC_DT, this); } catch (e) {}
    }
    if (this.mods.fx) { try { DP.FX.update(dt || this.LOGIC_DT); } catch (e) {} }
  },

  /* ---------- spawn ---------- */
  _spawnOne: function () {
    if (!this.board) return false;
    var s = this.state, m = s.maxTierReached || 1;
    var minT = Math.max(1, m - 4);
    var maxT = Math.max(minT, m - 1);
    var r = null;
    if (this.mods.board && typeof DP.Board.spawn === 'function') {
      /* 5th arg lets Board apply the luckyChance upgrade on top of canon 5% */
      var lc = Math.min(1, 0.05 + 0.015 * this._upgradeLevel('luckyChance'));
      try { r = DP.Board.spawn(this.board, minT, maxT, Math.random, lc); } catch (e) { r = null; }
    }
    if (!r || !isFinite(r.idx)) r = this._fbSpawn(this.board, minT, maxT);
    if (!r || !isFinite(r.idx)) return false;                 /* board full */
    var cell = this.board.cells[r.idx];
    if (!cell) return false;
    /* lucky rain from the wheel forces lucky (module counter first, ours as fallback) */
    var rain = false;
    if (this.mods.wheel && typeof DP.Wheel.takeLucky === 'function') {
      try { rain = DP.Wheel.takeLucky(this.wheelState) === true; } catch (e) { rain = false; }
    } else if (this.luckyRain > 0) { this.luckyRain--; rain = true; }
    if (rain) cell.lucky = true;
    DP.Events.emit('spawn', { idx: r.idx, tier: cell.tier, lucky: !!cell.lucky });
    this._boardDirty = true;
    return true;
  },

  /* ---------- tap = pop (full semantics: value, combo, lucky, chain) ---------- */
  tapCell: function (idx) {
    if (!this.board || idx === null || idx === undefined) return 0;
    if (idx === this._lastTapIdx && (this.nowMs - this._lastTapMs) < 40) return 0;  /* double-wire guard */
    this._lastTapIdx = idx; this._lastTapMs = this.nowMs;
    var cell = this.board.cells[idx];
    if (!cell) return 0;
    var popped = this._popAt(idx);
    if (!popped) return 0;
    var s = this.state;
    var mult = this._comboPop();
    var base = Math.round(this.coinValue(popped.tier) * this.tapPowerMult() * mult);
    var value = popped.lucky ? base * 10 : base;
    this._gain(value);
    DP.Events.emit('pop', { idx: idx, tier: popped.tier, value: value, lucky: !!popped.lucky, chained: false });
    DP.Events.emit('combo', { count: s.combo || 0, mult: mult });
    var c = s.combo || 0;
    if (c === 10 || c === 20) this._fxLabel(idx, 'COMBO ×' + mult.toFixed(1), '#7df9ff', 16);
    this._fxPop(idx, popped.tier, value, !!popped.lucky, false);
    this._sfxPop(popped.tier, c, !!popped.lucky);
    if (popped.tier >= 5) this._doChain(idx, popped.tier);
    this._boardDirty = true;
    return value;
  },

  _popAt: function (idx) {
    var r = null;
    if (this.mods.board && typeof DP.Board.pop === 'function') {
      try { r = DP.Board.pop(this.board, idx); } catch (e) { r = null; }
    }
    if (!r) r = this._fbPop(this.board, idx);
    if (!r || !isFinite(r.tier)) return null;
    return { tier: r.tier, lucky: !!r.lucky };
  },

  /* chain reaction: tier ≥ 5 pops 2 + floor((tier-5)/2) (+chainPower) more, ×0.5 pay */
  _doChain: function (srcIdx, srcTier) {
    var n = this.chainCount(srcTier);
    if (n <= 0 || !this.board) return;
    var targets = null;
    if (this.mods.board && typeof DP.Board.chainTargets === 'function') {
      try { targets = DP.Board.chainTargets(this.board, n, Math.random, srcIdx); } catch (e) { targets = null; }
    }
    if (!targets || !targets.length) targets = this._fbChainTargets(this.board, n, srcIdx);
    if (!targets || !targets.length) return;
    var chained = 0, i, t, popped, v;
    for (i = 0; i < targets.length; i++) {
      t = targets[i];
      if (!isFinite(t) || !this.board.cells[t]) continue;
      popped = this._popAt(t);
      if (!popped) continue;
      v = Math.round(this.coinValue(popped.tier) * 0.5) * (popped.lucky ? 10 : 1);
      this._gain(v);
      DP.Events.emit('pop', { idx: t, tier: popped.tier, value: v, lucky: !!popped.lucky, chained: true });
      this._lightning(srcIdx, t);
      chained++;
    }
    if (chained > 0) { this._sfx('chain'); this._boardDirty = true; }
  },

  /* ---------- drag gestures ---------- */
  dragStart: function (idx) {
    if (this.mods.render3d && typeof DP.Render3D.setDrag === 'function') {
      try { DP.Render3D.setDrag(idx, true); } catch (e) {}
    }
  },

  dragMove: function (idx, sx, sy) {
    if (this.mods.render3d) {
      if (typeof DP.Render3D.setDragTarget === 'function') { try { DP.Render3D.setDragTarget(idx); } catch (e) {} }
      if (typeof DP.Render3D.dragMove === 'function') { try { DP.Render3D.dragMove(idx, sx, sy); } catch (e) {} }
    }
  },

  dragEnd: function (from, to) {
    if (this.mods.render3d && typeof DP.Render3D.setDrag === 'function') {
      try { DP.Render3D.setDrag(from, false); } catch (e) {}
    }
    if (!this.board || from === null || from === undefined || to === null || to === undefined) return false;
    if (from === to) return false;
    if (from === this._lastDragFrom && to === this._lastDragTo && (this.nowMs - this._lastDragMs) < 40) return false;
    this._lastDragFrom = from; this._lastDragTo = to; this._lastDragMs = this.nowMs;
    var cells = this.board.cells;
    var a = cells[from], b = cells[to];
    if (!a) return false;
    if (!b) { cells[to] = a; cells[from] = null; this._boardDirty = true; return 'move'; }
    if (a.tier === b.tier) return this._mergeCell(from, to);
    this._sfx('fail');                       /* different tier → snap back */
    return false;
  },

  _mergeCell: function (a, b) {
    var res = null;
    if (this.mods.board && typeof DP.Board.merge === 'function') {
      try { res = DP.Board.merge(this.board, a, b); } catch (e) { res = null; }
    }
    if (!res) res = this._fbMerge(this.board, a, b);
    if (!res || !isFinite(res.tier)) { this._sfx('fail'); return false; }
    var tier = res.tier, s = this.state;
    if (tier > (s.maxTierReached || 1)) {
      s.maxTierReached = tier;
      DP.Events.emit('tierReached', { tier: tier });
    }
    if (!s.discovered[tier]) {
      s.discovered[tier] = true;
      DP.Events.emit('discover', { tier: tier });
      this._sfx('quest');
      this._fxLabel(b, 'NEW: ' + this._tierName(tier), '#ffe066', 18);
    }
    DP.Events.emit('merge', { a: a, b: b, tier: tier });
    this._fxMerge(b, tier);
    this._sfxMerge(tier);
    this._boardDirty = true;
    return true;
  },

  /* ---------- MC touch cluster (SVG buttons via shared mobile-controls) ---------- */
  _shouldMountMc: function () {
    if (typeof MC === 'undefined' || typeof MC.createButton !== 'function') return false;
    if (typeof document === 'undefined') return false;
    var touch = false;
    try { touch = MC.isTouchDevice(typeof navigator !== 'undefined' ? navigator : null); } catch (e) {}
    var w = 1024;
    try { if (typeof window !== 'undefined' && window.innerWidth) w = window.innerWidth; } catch (e) {}
    return touch || w < 820;
  },

  _mountMc: function (force) {
    if (this._mc) return this._mc;
    if (typeof MC === 'undefined' || typeof MC.createButton !== 'function') return null;
    if (typeof document === 'undefined') return null;
    if (!force && !this._shouldMountMc()) return null;
    var box = null;
    try { box = document.createElement('div'); } catch (e) { return null; }
    var st = box.style;
    st.position = 'fixed'; st.right = '10px'; st.bottom = '74px';
    st.display = 'flex'; st.flexDirection = 'column'; st.gap = '10px';
    st.zIndex = '45';                     /* above stage/labels, below modals */
    st.pointerEvents = 'none';             /* cluster never eats board taps */
    try { document.body.appendChild(box); } catch (e) {}
    var self = this;
    var pop = MC.createButton({ container: box, label: '⚡', size: 58, color: '#ffd166', id: 'dpMcPop',
      onDown: function () { self.mcPop(); } });
    var wheel = MC.createButton({ container: box, label: '🎡', size: 58, color: '#c58cff', id: 'dpMcWheel',
      onDown: function () { self.mcWheel(); } });
    var mute = MC.createButton({ container: box, label: '🔊', size: 48, color: '#7de8ff', id: 'dpMcMute',
      onDown: function () { self.toggleMute(); } });
    var btns = [pop, wheel, mute], i;      /* each button its own pointer area */
    for (i = 0; i < btns.length; i++) {
      if (btns[i] && btns[i].svg) {
        btns[i].svg.style.pointerEvents = 'auto';
        btns[i].svg.style.position = 'relative';
      }
    }
    this._mc = { container: box, pop: pop, wheel: wheel, mute: mute };
    return this._mc;
  },

  /* one-thumb play: pop the highest-tier cell through the EXACT tap routine */
  mcPop: function () {
    if (!this.board) return 0;
    var cells = this.board.cells, best = -1, bestTier = 0, i;
    for (i = 0; i < cells.length; i++) {
      if (cells[i] && cells[i].tier > bestTier) { bestTier = cells[i].tier; best = i; }
    }
    if (best < 0) { this._sfx('fail'); return 0; }
    return this.tapCell(best);              /* zero logic fork: value+combo+lucky+chain */
  },

  /* wheel button: SAME gate + modal path the HUD wheel button uses */
  mcWheel: function () {
    if (this.mods.wheel && typeof DP.Wheel.canSpin === 'function') {
      var can = false;
      try { can = DP.Wheel.canSpin(this.wheelState, this.nowMs) !== false; } catch (e) { can = true; }
      if (!can) { this._sfx('fail'); this._ui('toast', 'Wheel recharging…'); return null; }
    }
    return this.openWheel();
  },

  openWheel: function () {
    var names = ['showWheel', 'openWheel', 'wheelModal', 'showWheelModal'], fn = null, i;
    for (i = 0; i < names.length; i++) { fn = this._uiFn(names[i]); if (fn) break; }
    if (fn) { try { fn.call(DP.UI, this); } catch (e) {} return 'modal'; }
    return this.spinWheel();
  },

  toggleMute: function () {
    var s = this.state;
    if (!s.settings) s.settings = {};
    var m = !(s.settings.muted);
    s.settings.muted = m;
    if (this.mods.audio && typeof DP.Audio !== 'undefined') {
      var A = DP.Audio;
      try {
        if (typeof A.setMuted === 'function') A.setMuted(m);
        else if (typeof A.mute === 'function') A.mute(m);
        else if (m && typeof A.stopAll === 'function') A.stopAll();
      } catch (e) {}
    }
    this._mcMuteVisual();
    return m;
  },

  _mcMuteVisual: function () {
    if (!this._mc || !this._mc.mute || !this._mc.mute.svg) return;
    try {
      var t = this._mc.mute.svg.querySelector('text');
      if (t) t.textContent = (this.state && this.state.settings && this.state.settings.muted) ? '🔇' : '🔊';
    } catch (e) {}
  }

,

  /* ---------- coin helpers ---------- */
  _gain: function (n) {
    if (!(n > 0) || !isFinite(n)) return;
    var s = this.state;
    if (this.mods.core && typeof DP.Core.addCoins === 'function') {
      try { DP.Core.addCoins(s, n); } catch (e) { s.coins += n; s.lifetime += n; }
    } else { s.coins += n; s.lifetime += n; }
    DP.Events.emit('coins', { amount: n, total: s.coins });
  },

  _spend: function (n) {
    if (!(n >= 0) || !isFinite(n)) return false;
    var s = this.state;
    if (this.mods.core && typeof DP.Core.spendCoins === 'function') {
      try { if (DP.Core.spendCoins(s, n)) return true; } catch (e) {}
    }
    if (s.coins >= n) { s.coins -= n; return true; }
    return false;
  },

  _tierName: function (t) {
    if (this.mods.content && typeof DP.Content.tierName === 'function') {
      try { var n = DP.Content.tierName(t); if (n) return n; } catch (e) {}
    }
    return 'TIER ' + t;
  },

  /* ---------- bonus wheel ---------- */
  spinWheel: function () {
    if (!this.mods.wheel || typeof DP.Wheel.spin !== 'function') return null;
    if (typeof DP.Wheel.canSpin === 'function') {
      var can = false;
      try { can = DP.Wheel.canSpin(this.wheelState, this.nowMs) !== false; } catch (e) { can = true; }
      if (!can) { this._sfx('fail'); return null; }
    }
    var res = null, self = this;
    try { res = DP.Wheel.spin(this.wheelState, Math.random, function () { return self.incomePerSec(); }, this.nowMs); } catch (e) { res = null; }
    if (!res) return null;
    this._applyWheel(res);
    return res;
  },

  _sectorKind: function (sector) {
    var s = '';
    if (sector) {
      if (typeof sector === 'string') s = sector;
      else s = String(sector.kind || sector.id || sector.name || sector.label || sector.type || '');
    }
    s = s.toLowerCase();
    if (s.indexOf('jackpot') >= 0) return 'jackpot';
    if (s.indexOf('income') >= 0 || s.indexOf('boost') >= 0 || s.indexOf('x2') >= 0 ||
        s.indexOf('double') >= 0 || s.indexOf('buff') >= 0) return 'income';
    if (s.indexOf('lucky') >= 0 || s.indexOf('rain') >= 0) return 'lucky';
    if (s.indexOf('merge') >= 0 || s.indexOf('pair') >= 0) return 'merge';
    if (s.indexOf('quest') >= 0 || s.indexOf('reroll') >= 0) return 'quest';
    if (s.indexOf('dud') >= 0 || s.indexOf('close') >= 0 || s.indexOf('nothing') >= 0 ||
        s.indexOf('miss') >= 0) return 'dud';
    return 'coins';                                  /* default: grant coins */
  },

  _sectorCoins: function (sector) {
    if (sector && typeof sector === 'object') {
      if (isFinite(sector.amount) && sector.amount > 0) return Math.round(sector.amount);
      if (isFinite(sector.min) && isFinite(sector.max) && sector.max >= sector.min) {
        return Math.round(sector.min + Math.random() * (sector.max - sector.min));
      }
    }
    return Math.max(1, Math.round(this.coinValue(this.state.maxTierReached || 1) *
      (2 + Math.random() * 6) * this.tapPowerMult()));
  },

  _applyWheel: function (res) {
    var sector = res.sector;
    if (typeof sector === 'number' && this.mods.wheel && DP.Wheel.SECTORS && DP.Wheel.SECTORS[sector]) {
      sector = DP.Wheel.SECTORS[sector];
    }
    var kind = this._sectorKind(sector);
    var modBoost = this.mods.wheel && typeof DP.Wheel.boostMult === 'function';
    var modLucky = this.mods.wheel && typeof DP.Wheel.takeLucky === 'function';
    if (isFinite(res.coins) && res.coins > 0) {
      /* the wheel priced this sector itself (coins_small/medium, jackpot floors) */
      this._gain(res.coins);
      this._fxLabel(-1, (kind === 'jackpot' ? 'JACKPOT +' : '+') + this.fmt(res.coins), '#ffd700', kind === 'jackpot' ? 22 : 16);
      if (kind === 'jackpot') {
        this._sfx('jackpot');
        if (this.mods.fx) { try { DP.FX.burst('jackpot', 0, 0, { tier: 5 }); } catch (e) {} }
        this._ui('toast', 'JACKPOT! +' + this.fmt(res.coins));
      } else this._sfx('coin');
    } else if (kind === 'income') {
      /* wheel module tracks its own boostUntil; buffT is the no-module fallback */
      if (!modBoost) this.buffT = Math.max(this.buffT, 30);
      this._sfx('lucky');
      this._ui('toast', 'INCOME ×2 FOR 30s!');
    } else if (kind === 'lucky') {
      if (!modLucky) this.luckyRain = 5;             /* next 5 spawns lucky */
      this._sfx('lucky');
      this._ui('toast', 'LUCKY RAIN! 5 GOLD CUBES');
    } else if (kind === 'merge') {
      var ok = this._mergeRandomPair();              /* ONE random pair merges up */
      this._sfx(ok ? 'quest' : 'fail');
      if (ok) this._ui('toast', 'FREE MERGE!');
    } else if (kind === 'quest') {
      this.rerollQuests();
      this._sfx('quest');
      this._ui('toast', 'NEW QUESTS!');
    } else if (kind === 'dud') {
      this._sfx('fail');
      this._ui('toast', res.nearMiss ? 'SO CLOSE!' : 'Nothing…');
    } else if (kind === 'coins') {
      /* fallback: wheel module returned an unpriced coin sector */
      var amt = this._sectorCoins(sector);
      this._gain(amt);
      this._fxLabel(-1, '+' + this.fmt(amt), '#ffd700', 16);
      this._sfx('coin');
    }
    DP.Events.emit('wheel', { result: res });
  },

  _mergeRandomPair: function () {
    if (!this.board) return false;
    var cells = this.board.cells, byTier = {}, tiers = [], i, t;
    for (i = 0; i < cells.length; i++) {
      if (!cells[i]) continue;
      t = cells[i].tier;
      if (!byTier[t]) { byTier[t] = [i]; tiers.push(t); }
      else if (byTier[t].length === 1) byTier[t].push(i);
    }
    if (!tiers.length) return false;
    t = tiers[Math.floor(Math.random() * tiers.length)];
    var pair = byTier[t];
    if (!pair || pair.length < 2) return false;
    return !!this._mergeCell(pair[0], pair[1]);
  },

  /* ---------- shop ---------- */
  _upgradeLevel: function (id) {
    var u = this.state && this.state.upgrades;
    return (u && isFinite(Number(u[id]))) ? Math.max(0, Math.floor(Number(u[id]))) : 0;
  },

  _findUpgrade: function (id) {
    if (this.mods.content && Array.isArray(DP.Content.UPGRADES)) {
      for (var i = 0; i < DP.Content.UPGRADES.length; i++) {
        if (DP.Content.UPGRADES[i] && DP.Content.UPGRADES[i].id === id) return DP.Content.UPGRADES[i];
      }
    }
    var fb = DP.Game.UPGRADES_FB;
    return fb[id] ? { id: id, name: fb[id].name, desc: fb[id].desc, base: fb[id].base, max: fb[id].max } : null;
  },

  upgradeCost: function (id) {
    var lvl = this._upgradeLevel(id);
    if (this.mods.content && typeof DP.Content.upgradeCost === 'function') {
      try {
        var c = DP.Content.upgradeCost(id, lvl);
        if (isFinite(c) && c >= 0) return c;
      } catch (e) {}
    }
    var up = this._findUpgrade(id);
    var base = (up && isFinite(up.base)) ? up.base : 100;
    return Math.round(base * Math.pow(1.35, lvl));
  },

  canBuy: function (id) {
    var up = this._findUpgrade(id);
    var lvl = this._upgradeLevel(id);
    if (up && isFinite(up.max) && lvl >= up.max) return false;
    return this.state.coins >= this.upgradeCost(id);
  },

  buyUpgrade: function (id) {
    var up = this._findUpgrade(id);
    if (!up) return false;
    var lvl = this._upgradeLevel(id);
    if (up && isFinite(up.max) && lvl >= up.max) { this._sfx('fail'); return false; }
    var cost = this.upgradeCost(id);
    if (!isFinite(cost) || cost < 0) return false;
    if (!this._spend(cost)) { this._sfx('fail'); return false; }
    var s = this.state;
    s.upgrades[id] = lvl + 1;
    if (id === 'gridSize') {
      var ns = Math.max(5, Math.min(7, 5 + (lvl + 1)));
      if (ns !== this.board.size) {
        var rb = null;
        if (this.mods.board && typeof DP.Board.resize === 'function') {
          try { rb = DP.Board.resize(this.board, ns); } catch (e) { rb = null; }
        }
        this._fbResize(this.board, ns);
        if (rb && rb.cells) this.board = rb;
      }
    }
    DP.Events.emit('spend', { id: id, level: lvl + 1 });
    this._sfx('coin');
    this._boardDirty = true;
    return true;
  },

  shopModel: function () {
    var ids = ['tapPower', 'spawnRate', 'incomeMult', 'gridSize', 'luckyChance', 'chainPower'];
    if (this.mods.content && Array.isArray(DP.Content.UPGRADES) && DP.Content.UPGRADES.length) {
      ids = [];
      for (var i = 0; i < DP.Content.UPGRADES.length; i++) ids.push(DP.Content.UPGRADES[i].id);
    }
    var out = [], j, up;
    for (j = 0; j < ids.length; j++) {
      up = this._findUpgrade(ids[j]);
      if (!up) continue;
      out.push({
        id: ids[j], name: up.name || ids[j], desc: up.desc || '',
        level: this._upgradeLevel(ids[j]),
        cost: this.upgradeCost(ids[j]),
        max: isFinite(up.max) ? up.max : 99,
        affordable: this.canBuy(ids[j])
      });
    }
    return out;
  },

  /* ---------- ascend (prestige) ---------- */
  canAscend: function () {
    if (this.mods.core && typeof DP.Core.canAscend === 'function') {
      try { if (DP.Core.canAscend(this.state)) return true; } catch (e) {}
    }
    return (this.state.lifetime || 0) >= 1000000;
  },

  ascend: function () {                         /* UI confirm modal if present */
    var fn = this._uiFn('showAscend') || this._uiFn('ascendModal') || this._uiFn('showAscendModal');
    if (fn) { try { fn.call(DP.UI, this); return true; } catch (e) {} }
    return this.doAscend();
  },

  doAscend: function () {
    var s = this.state;
    if (!this.canAscend()) { this._sfx('fail'); return false; }
    if (this.mods.core && typeof DP.Core.ascend === 'function') {
      try { DP.Core.ascend(s); } catch (e) { this._fbAscend(); }
    } else this._fbAscend();
    if (!s.upgrades || typeof s.upgrades !== 'object') s.upgrades = {};
    if (!s.discovered || typeof s.discovered !== 'object') s.discovered = {};
    if (!isFinite(s.spawnT)) s.spawnT = 0.5;
    this.board = this._createBoard(this.gridSize());
    this.buffT = 0; this.luckyRain = 0;
    this.rerollQuests();
    this._sfx('ascend');
    this._fxLabel(-1, 'ASCEND ×' + (1 + 0.5 * (s.ascensions || 0)).toFixed(1), '#ffd700', 24);
    this._ui('toast', 'ASCENDED! Income ×' + (1 + 0.5 * (s.ascensions || 0)).toFixed(1));
    DP.Events.emit('ascend', { n: s.ascensions || 0 });
    this._boardDirty = true;
    return true;
  },

  _fbAscend: function () {
    var s = this.state;
    s.ascensions = (s.ascensions || 0) + 1;
    s.coins = 0; s.upgrades = {}; s.combo = 0; s.comboT = 0; s.spawnT = 0.5;
    /* lifetime, discovered and maxTierReached persist (canon: reset board/coins/upgrades) */
  },

  /* ---------- quests (fed centrally from the bus) ---------- */
  claimQuests: function () {
    var applied = [];
    if (!this.mods.quests || typeof DP.Quests.claim !== 'function') return applied;
    var rewards = null;
    try { rewards = DP.Quests.claim(this.questState); } catch (e) { rewards = null; }
    if (!rewards || !rewards.length) return applied;
    var total = 0, i, r, n;
    for (i = 0; i < rewards.length; i++) {
      r = rewards[i];
      n = 0;
      if (typeof r === 'number') n = r;
      else if (r) {
        if (isFinite(r.coins)) n = r.coins;
        else if (isFinite(r.amount)) n = r.amount;
        else if (isFinite(r.reward)) n = r.reward;
      }
      if (n > 0) { total += n; applied.push(n); }
    }
    if (total > 0) { this._gain(total); this._sfx('quest'); }
    /* every slot freed by claims → rotate a fresh set in so the strip never dies */
    var arr = this._questList();
    if (arr && arr.length) {
      var allFree = true, k;
      for (k = 0; k < arr.length; k++) if (arr[k]) { allFree = false; break; }
      if (allFree) this.rerollQuests();
    }
    return applied;
  },

  rerollQuests: function () {
    if (!this.mods.quests || typeof DP.Quests.reroll !== 'function') return false;
    var s = this.state;
    var prog = Math.max(1, Math.floor(s.maxTierReached || 1));   /* numeric progression level */
    var seed = (Math.floor(this.nowMs) ^ ((s.ascensions || 0) * 7919)) & 0x7fffffff;
    try { DP.Quests.reroll(this.questState, seed, prog); return true; } catch (e) { return false; }
  },

  _questList: function () {
    var qs = this.questState;
    if (!qs) return null;
    if (Array.isArray(qs.quests)) return qs.quests;
    if (Array.isArray(qs.list)) return qs.list;
    if (Array.isArray(qs)) return qs;
    return null;
  },

  _questDone: function (q) {
    return !!(q && (q.done === true || q.complete === true || q.completed === true));
  },

  _hookQuests: function () {
    if (this._questHook) { try { DP.Events.off('*', this._questHook); } catch (e) {} this._questHook = null; }
    if (!this.mods.quests) return;
    var self = this;
    /* capture 'quest' emissions so we never double-emit a module's own events */
    if (!this._questCap) {
      this._questEmits = [];
      this._questCap = function (d) {
        if (self._questEmits && self._questEmitN < 8) self._questEmits[self._questEmitN++] = d && d.id;
      };
      DP.Events.on('quest', this._questCap);
    }
    this._questHook = function (name, data) { self._questEvent(name, data); };
    DP.Events.on('*', this._questHook);
  },

  _questEvent: function (name, data) {
    if (this._questBusy || !this.mods.quests || !this.questState) return;
    if (typeof DP.Quests.onEvent !== 'function') return;
    var arr = this._questList();
    var b = this._qBefore;
    var n = 0, i, q;
    if (arr) {
      n = Math.min(arr.length, 8);
      for (i = 0; i < n; i++) b[i] = this._questDone(arr[i]);
    }
    this._questEmitN = 0;                       /* window: capture module-emitted quest events */
    this._questBusy = true;
    try { DP.Quests.onEvent(this.questState, name, data); }
    catch (e) { /* quest logic must never break the game loop */ }
    finally { this._questBusy = false; }
    var emittedN = this._questEmitN, emitted = this._questEmits;
    this._questEmits = null;                   /* stop capturing before our own re-emits */
    if (arr) {                                 /* re-emit completions the module didn't announce */
      for (i = 0; i < n; i++) {
        q = arr[i];
        if (this._questDone(q) && !b[i]) {
          var qid = (q && q.id !== undefined) ? q.id : i, seen = false, j;
          for (j = 0; j < emittedN; j++) if (emitted[j] === qid) { seen = true; break; }
          if (!seen) { DP.Events.emit('quest', { id: qid, done: true }); this._sfx('quest'); }
        }
      }
    }
    this._questEmits = emitted;                /* re-arm the capture for the next event */
  },

  /* ---------- UI plumbing ---------- */
  _uiFn: function (name) {
    if (!this.mods.ui || typeof DP.UI === 'undefined' || !DP.UI) return null;
    var fn = DP.UI[name];
    return typeof fn === 'function' ? fn : null;
  },

  _ui: function (name, a, b) {
    var fn = this._uiFn(name);
    if (fn) { try { fn.call(DP.UI, a, b); } catch (e) {} }
  }

,

  /* ---------- save / load ---------- */
  serialize: function () {
    var s = this.state;
    if (!s) return null;
    var so = {
      coins: s.coins, lifetime: s.lifetime, ascensions: s.ascensions || 0,
      combo: s.combo || 0, comboT: s.comboT || 0,
      upgrades: this._shallowCopy(s.upgrades),
      maxTierReached: s.maxTierReached || 1,
      discovered: this._shallowCopy(s.discovered),
      spawnT: isFinite(s.spawnT) ? s.spawnT : 0,
      settings: { muted: !!(s.settings && s.settings.muted) },
      lastSeen: Math.floor(this.nowMs)
    };
    if (this.mods.core && typeof DP.Core.serialize === 'function') {
      try {
        var cs = DP.Core.serialize(s);
        var cso = (typeof cs === 'string') ? JSON.parse(cs) : cs;
        if (cso && typeof cso === 'object') this._mergeInto(so, cso);   /* Core extras win */
      } catch (e) {}
    }
    so.lastSeen = Math.floor(this.nowMs);          /* authoritative stamp */
    return {
      v: 1, t: Math.floor(this.nowMs), s: so,
      size: this.board ? this.board.size : 5,
      cells: this._boardToSave(),
      nextId: this.board ? this.board.nextId : 1,
      wheel: this.wheelState ? this._shallowCopy(this.wheelState) : null,
      quests: this.questState ? this._shallowCopy(this.questState) : null,
      buffT: this.buffT || 0,
      luckyRain: this.luckyRain || 0
    };
  },

  save: function () {
    try {
      var data = this.serialize();
      if (data && typeof localStorage !== 'undefined') {
        localStorage.setItem(this.SAVE_KEY, JSON.stringify(data));
        DP.Events.emit('save', { t: data.t });
      }
    } catch (e) { /* storage absent/full — never crash the loop */ }
  },

  _loadSave: function () {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(this.SAVE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || data.v !== 1) return null;
      if (!data.s && isFinite(data.coins)) data = { v: 1, s: data };   /* flat-save tolerance */
      return data;
    } catch (e) { return null; }
  },

  _restoreState: function (data) {
    var saved = (data && data.s) ? data.s : {};
    var st = this._newState();
    var keys = ['coins', 'lifetime', 'ascensions', 'combo', 'comboT', 'maxTierReached', 'spawnT', 'lastSeen'];
    if (this.mods.core && typeof DP.Core.deserialize === 'function') {
      var r = null;
      try { r = DP.Core.deserialize(saved); } catch (e) { r = null; }
      if (!r) { try { r = DP.Core.deserialize(JSON.stringify(saved)); } catch (e2) { r = null; } }
      if (r && typeof r === 'object' && isFinite(r.coins)) st = r;
    }
    this._copyNums(st, saved, keys);                       /* canon fields authoritative */
    if (saved.upgrades && typeof saved.upgrades === 'object') {
      st.upgrades = st.upgrades || {};
      this._mergeInto(st.upgrades, saved.upgrades);
    }
    if (saved.discovered && typeof saved.discovered === 'object') {
      st.discovered = st.discovered || {};
      this._mergeInto(st.discovered, saved.discovered);
    }
    st.settings = { muted: !!(saved.settings && saved.settings.muted) };
    if (!isFinite(st.maxTierReached) || st.maxTierReached < 1) st.maxTierReached = 2;
    if (!isFinite(st.coins) || st.coins < 0) st.coins = 0;
    if (!isFinite(st.lifetime) || st.lifetime < 0) st.lifetime = 0;
    return st;
  },

  _restoreCells: function (cells) {
    var b = this.board;
    if (!b || !Array.isArray(cells)) return;
    if (!isFinite(b.nextId) || b.nextId < 1) b.nextId = 1;
    var n = Math.min(cells.length, b.cells.length), i, c;
    for (i = 0; i < n; i++) {
      c = cells[i];
      if (c && isFinite(c[0]) && c[0] >= 1) {
        b.cells[i] = { tier: Math.max(1, Math.min(25, Math.floor(c[0]))), lucky: !!c[1], id: b.nextId++ };
      }
    }
  },

  _boardToSave: function () {
    var b = this.board;
    if (!b) return [];
    var out = [], i, c;
    for (i = 0; i < b.cells.length; i++) {
      c = b.cells[i];
      out.push((c && isFinite(c.tier)) ? (c.lucky ? [c.tier, 1] : [c.tier]) : 0);
    }
    return out;
  },

  _copyNums: function (dst, src, keys) {
    if (!src) return dst;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (src[k] === null || src[k] === undefined || src[k] === '') continue;
      var n = Number(src[k]);
      if (isFinite(n)) dst[k] = n;
    }
    return dst;
  },

  /* ---------- constructors (module or canon fallback) ---------- */
  _newState: function () {
    if (this.mods.core && typeof DP.Core.newState === 'function') {
      try { var s = DP.Core.newState(); if (s && isFinite(s.coins)) return s; } catch (e) {}
    }
    return this._fbNewState();
  },

  _newWheelState: function () {
    if (this.mods.wheel && typeof DP.Wheel.newState === 'function') {
      try { var w = DP.Wheel.newState(); if (w) return w; } catch (e) {}
    }
    return { lastSpin: 0 };
  },

  _newQuestState: function () {
    if (this.mods.quests && typeof DP.Quests.newState === 'function') {
      try { var q = DP.Quests.newState(); if (q) return q; } catch (e) {}
    }
    return { quests: [] };
  },

  _createBoard: function (size) {
    size = Math.max(3, Math.min(9, Math.floor(size || 5)));
    if (this.mods.board && typeof DP.Board.create === 'function') {
      try { var b = DP.Board.create(size); if (b && b.cells) return b; } catch (e) {}
    }
    return this._fbBoardCreate(size);
  },

  _mergeInto: function (dst, src) {
    if (!dst || !src) return dst;
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
    return dst;
  },

  _shallowCopy: function (o) {
    var r = {}, k;
    if (o) for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    return r;
  },

  /* ---------- offline earnings ---------- */
  _applyOffline: function () {
    var s = this.state;
    var gain = 0;
    if (this.mods.core && typeof DP.Core.offlineGain === 'function') {
      try { gain = DP.Core.offlineGain(s, this.nowMs, this.incomePerSec()); } catch (e) { gain = 0; }
    }
    if (!(gain > 0) || !isFinite(gain)) gain = this._fbOfflineGain();
    s.lastSeen = this.nowMs;
    if (gain > 0) {
      var amt = Math.round(gain);
      this._gain(amt);
      var shown = false, names = ['showOffline', 'offlineModal', 'showOfflineModal', 'offlineEarnings'], i;
      for (i = 0; i < names.length && !shown; i++) {
        if (this._uiFn(names[i])) { this._ui(names[i], amt); shown = true; }
      }
    }
  },

  _fbOfflineGain: function () {
    var s = this.state;
    var elapsed = (this.nowMs - (s.lastSeen || 0)) / 1000;
    if (!(elapsed > 0)) return 0;
    if (elapsed > 28800) elapsed = 28800;              /* cap 8h */
    return this.incomePerSec() * elapsed * 0.5;        /* ×0.5 offline rate */
  },

  _hookLife: function () {
    if (this._lifeHooked) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this._lifeHooked = true;
    var self = this;
    try { window.addEventListener('beforeunload', function () { self.save(); }); } catch (e) {}
    try {
      document.addEventListener('visibilitychange', function () {
        try { if (document.hidden) self.save(); } catch (e2) {}
      });
    } catch (e) {}
  },

  /* ---------- canon getters (module or fallback) ---------- */
  coinValue: function (t) {
    t = Math.max(1, Math.min(25, Math.floor(Number(t) || 1)));
    if (this.mods.content) {
      try { var v = DP.Content.coinValue(t); if (isFinite(v) && v > 0) return v; } catch (e) {}
    }
    return Math.round(10 * Math.pow(3.5, t - 1));
  },

  tapPowerMult: function () { return Math.pow(1.15, this._upgradeLevel('tapPower')); },

  spawnInterval: function () { return Math.max(0.4, 2.5 * Math.pow(0.92, this._upgradeLevel('spawnRate'))); },

  gridSize: function () { return Math.max(5, Math.min(7, 5 + this._upgradeLevel('gridSize'))); },

  chainCount: function (tier) {
    if (!(tier >= 5)) return 0;
    return Math.min(2 + Math.floor((tier - 5) / 2) + this._upgradeLevel('chainPower'), 8);
  },

  incomeMult: function () {
    if (this.mods.content && typeof DP.Content.incomeMult === 'function') {
      try { var m = DP.Content.incomeMult(this.state); if (isFinite(m) && m > 0) return m; } catch (e) {}
    }
    var s = this.state, disc = 0, k;
    for (k in s.discovered) if (s.discovered[k]) disc++;
    return Math.pow(1.1, this._upgradeLevel('incomeMult')) * Math.pow(1.02, disc) * (1 + 0.5 * (s.ascensions || 0));
  },

  totalBoardValue: function () {
    if (this.mods.board && typeof DP.Board.totalValue === 'function') {
      try { var v = DP.Board.totalValue(this.board); if (isFinite(v)) return v; } catch (e) {}
    }
    return this._fbTotalValue(this.board);
  },

  incomePerSec: function () {
    if (!this.board) return 0;
    var boost = 1;
    if (this.mods.wheel && typeof DP.Wheel.boostMult === 'function') {
      try { boost = DP.Wheel.boostMult(this.wheelState, this.nowMs); if (!(boost >= 1)) boost = 1; } catch (e) { boost = 1; }
    } else if (this.buffT > 0) boost = 2;              /* no-module fallback buff */
    return this.totalBoardValue() * 0.05 * this.incomeMult() * boost;
  },

  comboMultNow: function () {
    var c = this.state.combo || 0;
    return c > 0 ? 1 + 0.1 * Math.min(c, 20) : 1;
  },

  emptyCells: function () {
    if (this.mods.board && typeof DP.Board.emptyCells === 'function') {
      try { var e = DP.Board.emptyCells(this.board); if (e) return e; } catch (err) {}
    }
    var out = [], i, b = this.board;
    if (!b) return out;
    for (i = 0; i < b.cells.length; i++) if (!b.cells[i]) out.push(i);
    return out;
  },

  fmt: function (n) {
    if (this.mods.core && typeof DP.Core.fmt === 'function') {
      try { var f = DP.Core.fmt(n); if (typeof f === 'string') return f; } catch (e) {}
    }
    n = Number(n);
    if (!isFinite(n)) return '0';
    if (n < 1000) return (n < 100 && n % 1 !== 0) ? n.toFixed(1) : String(Math.floor(n));
    var units = ['K', 'M', 'B', 'T', 'Qa', 'Qi'], u = -1, v = n;
    while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + units[u];
  },

  /* ---------- FX / audio plumbing ---------- */
  _sfx: function (name, opts) {
    if (!this.mods.audio || typeof DP.Audio.play !== 'function') return;
    try { DP.Audio.play(name, opts || {}); } catch (e) {}
  },

  _sfxPop: function (tier, combo, lucky) {
    if (!this.mods.audio || typeof DP.Audio.play !== 'function') return;
    try { DP.Audio.play(lucky ? 'lucky' : 'pop', { combo: combo || 1, tier: tier }); } catch (e) {}
    if (tier >= 8) this._shake(0.5);
  },

  _sfxMerge: function (tier) {
    if (!this.mods.audio || typeof DP.Audio.play !== 'function') return;
    try { DP.Audio.play('merge', { tier: tier }); } catch (e) {}
  },

  _cellWorld: function (idx) {
    var out = this._scratchWorld, b = this.board;
    if (!b) { out.x = 0; out.z = 0; return out; }
    if (this.mods.render3d && typeof DP.Render3D.cellWorld === 'function') {
      try {
        var p = DP.Render3D.cellWorld(idx);
        if (p) { out.x = p.x || 0; out.z = (p.z !== undefined ? p.z : (p.y || 0)); return out; }
      } catch (e) {}
    }
    var size = b.size || 5;
    var col = ((idx % size) + size) % size, row = Math.floor(idx / size);
    out.x = (col - (size - 1) / 2) * 1.15;
    out.z = (row - (size - 1) / 2) * 1.15;
    return out;
  },

  _fxPop: function (idx, tier, value, lucky, chained) {
    if (!this.mods.fx) return;
    var w = this._cellWorld(idx), wx = w.x, wz = w.z;
    try { DP.FX.burst(lucky ? 'lucky' : 'pop', wx, wz, { tier: tier, lucky: lucky, value: value }); } catch (e) {}
    if (!chained) {
      try { DP.FX.label(wx, wz, '+' + this.fmt(value), lucky ? '#ffd700' : this._tierColor(tier), lucky ? 20 : 14); } catch (e) {}
    }
  },

  _fxMerge: function (idx, tier) {
    if (!this.mods.fx) return;
    var w = this._cellWorld(idx), wx = w.x, wz = w.z;
    try { DP.FX.burst('merge', wx, wz, { tier: tier }); } catch (e) {}
  },

  _fxLabel: function (idx, text, color, size) {
    if (!this.mods.fx || typeof DP.FX.label !== 'function') return;
    var target = (idx >= 0) ? idx : (this.board ? Math.floor(this.board.size * this.board.size / 2) : 12);
    var w = this._cellWorld(target);
    try { DP.FX.label(w.x, w.z, text, color || '#fff', size || 14); } catch (e) {}
  },

  _lightning: function (a, b) {
    /* render3d.js self-subscribes to 'pop' events and draws the jagged bolts;
       we add the FX chain particle burst midway between the two cells */
    if (this.mods.fx && typeof DP.FX.burst === 'function') {
      var wa = this._cellWorld(a), ax = wa.x, az = wa.z;
      var wb = this._cellWorld(b);
      try { DP.FX.burst('chain', (ax + wb.x) / 2, (az + wb.z) / 2, { a: a, b: b }); } catch (e) {}
    }
  },

  _shake: function (mag) {
    if (this.mods.render3d) {
      var R = DP.Render3D, names = ['shake', 'bump', 'kick'], i;
      for (i = 0; i < names.length; i++) {
        if (typeof R[names[i]] === 'function') { try { R[names[i]](mag); return; } catch (e) {} }
      }
    }
  },

  _tierColor: function (t) {
    if (this.mods.content && typeof DP.Content.tierColor === 'function') {
      try { var c = DP.Content.tierColor(t); if (c) return c; } catch (e) {}
    }
    return 'hsl(' + Math.floor(((t - 1) / 24) * 330) + ', 90%, 60%)';
  },

  /* ---------- module wiring ---------- */
  _initRender: function () {
    if (this.headless || !this.mods.render3d || typeof DP.Render3D.init !== 'function') return;
    if (typeof document === 'undefined') return;
    try {
      var el = document.getElementById('stage');
      if (!el) return;
      DP.Render3D.init(el, this.board, (typeof DP.Content !== 'undefined') ? DP.Content : null);
    } catch (e) {
      console.warn('[DP] Render3D init failed:', e && e.message);
    }
  },

  _initFx: function () {
    if (this.headless || !this.mods.fx) return;
    try {
      var R = (typeof DP.Render3D !== 'undefined') ? DP.Render3D : null;
      var cam = R && (R.camera || R.cam);
      if (cam && typeof DP.FX.setCamera === 'function') DP.FX.setCamera(cam);
      var scene = R && R.scene;
      if (scene) {
        if (typeof DP.FX.render === 'function') DP.FX.render(scene);
        else if (typeof DP.FX.attach === 'function') DP.FX.attach(scene);
        else if (typeof DP.FX.setScene === 'function') DP.FX.setScene(scene);
      }
    } catch (e) {}
  },

  _initAudio: function () {
    if (!this.mods.audio) return;
    try { if (typeof DP.Audio.init === 'function') DP.Audio.init(); } catch (e) {}
    var m = !!(this.state.settings && this.state.settings.muted);
    try {
      if (typeof DP.Audio.setMuted === 'function') DP.Audio.setMuted(m);
      else if (typeof DP.Audio.mute === 'function') DP.Audio.mute(m);
    } catch (e) {}
  },

  _initUi: function () {
    if (!this.mods.ui) return;
    try { DP.UI.game = this; } catch (e) {}
    var names = ['init', 'build', 'mount', 'start'], i;
    for (i = 0; i < names.length; i++) {
      if (typeof DP.UI[names[i]] === 'function') {
        try { DP.UI[names[i]](this); return; } catch (e) {}
      }
    }
  },

  _initInput: function () {
    if (this.headless || !this.mods.input || typeof DP.Input.init !== 'function') return;
    if (typeof document === 'undefined') return;
    var self = this;
    var canvas = null;
    try {
      var R = (typeof DP.Render3D !== 'undefined') ? DP.Render3D : null;
      if (R && R.renderer && R.renderer.domElement) canvas = R.renderer.domElement;
      else if (R && R.canvas) canvas = R.canvas;
      if (!canvas) canvas = document.querySelector('#stage canvas');
    } catch (e) { canvas = null; }
    if (!canvas) return;
    var h = {
      onTap: function (idx) { self.tapCell(idx); },
      onDragStart: function (idx) { self.dragStart(idx); },
      onDragMove: function (idx, sx, sy) { self.dragMove(idx, sx, sy); },
      onDragEnd: function (from, to) { self.dragEnd(from, to); }
    };
    try { DP.Input.init(canvas, h); } catch (e) { try { DP.Input.init(canvas); } catch (e2) {} }
    try { DP.Input.handlers = h; } catch (e) {}
    try {
      DP.Input.onTap = h.onTap; DP.Input.onDragStart = h.onDragStart;
      DP.Input.onDragMove = h.onDragMove; DP.Input.onDragEnd = h.onDragEnd;
    } catch (e) {}
  },

  /* ---------- canon fallbacks (only run when a module is missing/broken) ---------- */
  UPGRADES_FB: {
    tapPower:    { name: 'Tap Power',    desc: '+15% coin value per level',   base: 50,   max: 50 },
    spawnRate:   { name: 'Spawn Rate',   desc: '-8% spawn interval per level', base: 100,  max: 50 },
    incomeMult:  { name: 'Income',       desc: '+10% idle income per level',  base: 250,  max: 50 },
    gridSize:    { name: 'Grid Size',    desc: '5×5 → 6×6 → 7×7',             base: 2000, max: 2 },
    luckyChance: { name: 'Lucky Chance', desc: '+1.5% lucky cubes per level',  base: 750,  max: 30 },
    chainPower:  { name: 'Chain Power',  desc: '+1 chain cube per level',      base: 1500, max: 20 }
  },

  _fbNewState: function () {
    return {
      coins: 0, lifetime: 0, ascensions: 0, combo: 0, comboT: 0,
      upgrades: {}, maxTierReached: 2, discovered: { 1: true },
      spawnT: 1, settings: { muted: false }, lastSeen: Date.now()
    };
  },

  _fbBoardCreate: function (size) {
    var cells = new Array(size * size), i;
    for (i = 0; i < cells.length; i++) cells[i] = null;
    return { size: size, cells: cells, nextId: 1 };
  },

  _fbSpawn: function (board, minT, maxT) {
    if (!board || !board.cells) return null;
    var empt = [], i;
    for (i = 0; i < board.cells.length; i++) if (!board.cells[i]) empt.push(i);
    if (!empt.length) return null;
    var roll = Math.random();
    var span = Math.max(0, maxT - minT);
    var tier = minT + Math.floor(roll * roll * (span + 1));       /* weighted low */
    if (tier > maxT) tier = maxT;
    var idx = empt[Math.floor(Math.random() * empt.length)];
    board.cells[idx] = { tier: tier, lucky: Math.random() < 0.05, id: board.nextId++ };
    return { idx: idx, tier: tier, lucky: board.cells[idx].lucky };
  },

  _fbPop: function (board, idx) {
    if (!board || !board.cells || !board.cells[idx]) return null;
    var c = board.cells[idx];
    board.cells[idx] = null;
    return { tier: c.tier, lucky: !!c.lucky };
  },

  _fbMerge: function (board, a, b) {
    if (!board || !board.cells) return null;
    var ca = board.cells[a], cb = board.cells[b];
    if (!ca || !cb || ca.tier !== cb.tier) return null;
    if (ca.tier >= 25) return null;
    cb.tier = ca.tier + 1;
    board.cells[a] = null;
    return { tier: cb.tier };
  },

  _fbTotalValue: function (board) {
    if (!board || !board.cells) return 0;
    var sum = 0, i;
    for (i = 0; i < board.cells.length; i++) {
      if (board.cells[i]) sum += this.coinValue(board.cells[i].tier);
    }
    return sum;
  },

  _fbResize: function (board, ns) {
    if (!board || !isFinite(ns)) return;
    ns = Math.max(3, Math.min(9, Math.floor(ns)));
    var old = board.cells, oldSize = board.size || Math.floor(Math.sqrt(old.length));
    if (ns === oldSize) return;
    var cells = new Array(ns * ns), i, r, c, idx;
    for (i = 0; i < cells.length; i++) cells[i] = null;
    for (r = 0; r < oldSize; r++) {
      for (c = 0; c < oldSize; c++) {
        idx = r * oldSize + c;
        if (old[idx] && r < ns && c < ns) cells[r * ns + c] = old[idx];   /* same coords */
      }
    }
    board.size = ns;
    board.cells = cells;
  },

  _fbChainTargets: function (board, count, exclude) {
    if (!board || !board.cells) return [];
    var pool = [], i, j, tmp;
    for (i = 0; i < board.cells.length; i++) {
      if (board.cells[i] && i !== exclude) pool.push(i);
    }
    var n = Math.min(count, pool.length), out = [];
    for (i = 0; i < n; i++) {                       /* partial Fisher–Yates */
      j = i + Math.floor(Math.random() * (pool.length - i));
      tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      out.push(pool[i]);
    }
    return out;
  },

  _comboPop: function () {
    var s = this.state;
    if (this.mods.core && typeof DP.Core.comboPop === 'function') {
      try { var m = DP.Core.comboPop(s, this.nowMs); if (isFinite(m) && m > 0) return m; } catch (e) {}
    }
    return this._fbComboPop();
  },

  _fbComboPop: function () {
    var s = this.state;
    if ((this.nowMs - (s.comboT || 0)) <= 2000) s.combo = (s.combo || 0) + 1;
    else s.combo = 1;
    s.comboT = this.nowMs;
    return 1 + 0.1 * Math.min(s.combo, 20);
  },

  _fbComboTick: function (s, dt) {
    /* comboT holds the timestamp of the last pop (see _fbComboPop) */
    if (s.combo > 0 && (this.nowMs - (s.comboT || 0)) > 2000) { s.combo = 0; s.comboT = 0; }
  }

};

/* shared entry points (aliases keep other modules' call sites simple) */
DP.Game.spin = DP.Game.spinWheel;
DP.Game.buy = DP.Game.buyUpgrade;
DP.Game.saveNow = DP.Game.save;

/* ================= NODE SELF-TEST (bus + canon glue) ================= */
if (typeof process !== 'undefined' && process.argv && typeof process.argv[1] === 'string' && /game\.js$/.test(process.argv[1])) {
  (function () {
    var pass = 0, fail = 0;
    function check(name, cond) {
      if (cond) { pass++; console.log('PASS: ' + name); }
      else { fail++; console.log('FAIL: ' + name); }
    }
    var E = DP.Events, G = DP.Game;
    G._detectModules();          /* mods must exist before any helper runs */

    /* ---- event bus ---- */
    var seen = [];
    var aCount = 0;
    var offA = E.on('t', function (d) { aCount++; seen.push(['a', d.v]); });
    E.on('t', function () { throw new Error('boom'); });
    E.on('t', function (d) { seen.push(['c', d.v]); });
    E.emit('t', { v: 1 });
    check('bus: emit reaches subscribers in order', seen.length === 2 && seen[0][0] === 'a' && seen[1][0] === 'c');
    check('bus: subscriber error does not break emit', seen.length === 2 && seen[1][1] === 1);
    offA();
    E.emit('t', { v: 2 });
    check('bus: returned off() stops delivery (others still live)',
      aCount === 1 && seen.length === 3 && seen[2][0] === 'c' && seen[2][1] === 2);
    var fnD = function (d) { seen.push(['d', d.v]); };
    E.on('x', fnD);
    E.off('x', fnD);
    E.emit('x', { v: 3 });
    check('bus: direct off(name, fn) stops delivery', seen.length === 3);
    E.off('nope', function () {});
    check('bus: off on unknown event is safe', true);
    var wild = [];
    var offW = E.on('*', function (name, data) { wild.push(name); });
    E.emit('y', { v: 4 });
    E.emit('y', { v: 5 });
    offW();
    check('bus: wildcard receives (name, data) for every emit', wild.length === 2 && wild[0] === 'y' && wild[1] === 'y');
    check('bus: count() reports live subscribers only', E.count('t') === 2);   /* thrower + c */
    E.emit('t', { v: 6 });
    check('bus: emit with only erroring subscriber still safe', true);
    check('bus: count on unknown event is 0', E.count('zz') === 0);

    /* ---- canon glue (fallback math — identical to CONTRACTS) ---- */
    G.state = G._fbNewState();
    G.nowMs = 1000;
    check('coinValue canon: tier 1 = 10', G.coinValue(1) === 10);
    check('coinValue canon: tier 2 = 35', G.coinValue(2) === 35);
    check('coinValue canon: tier 3 = 123 (rounded)', G.coinValue(3) === 123);
    check('coinValue clamps tier to 1..25', G.coinValue(0) === 10 && G.coinValue(99) === G.coinValue(25));
    check('tapPower: level 0 → ×1, level 1 → ×1.15',
      G.tapPowerMult() === 1 && (G.state.upgrades.tapPower = 1, Math.abs(G.tapPowerMult() - 1.15) < 1e-9));
    G.state.upgrades.tapPower = 0;
    check('spawnInterval: level 0 → 2.5s', G.spawnInterval() === 2.5);
    G.state.upgrades.spawnRate = 50;
    check('spawnInterval: floors at 0.4s', G.spawnInterval() === 0.4);
    G.state.upgrades.spawnRate = 0;
    check('gridSize: level 0 → 5, level 3 → 7 (clamp)',
      G.gridSize() === 5 && (G.state.upgrades.gridSize = 3, G.gridSize() === 7));
    G.state.upgrades.gridSize = 0;
    check('chainCount: tier<5 → 0, tier5 → 2, tier9 → 4, cap 8',
      G.chainCount(4) === 0 && G.chainCount(5) === 2 && G.chainCount(9) === 4 && G.chainCount(30) === 8);
    G.state.upgrades.chainPower = 1;
    check('chainCount: chainPower +1/lvl', G.chainCount(5) === 3);
    G.state.upgrades.chainPower = 0;
    G.state.upgrades.incomeMult = 3;
    G.state.discovered = { 1: true, 2: true };
    check('incomeMult fallback: upgrade × discovery stacking',
      Math.abs(G.incomeMult() - 1.331 * 1.0404) < 1e-9);
    G.state = G._fbNewState();

    /* ---- combo fallback ladder ---- */
    G.nowMs = 100000;
    var m1 = G._fbComboPop(), m2 = G._fbComboPop(), m3 = G._fbComboPop();
    check('combo ladder: 1.1 → 1.2 → 1.3 rising',
      Math.abs(m1 - 1.1) < 1e-9 && Math.abs(m2 - 1.2) < 1e-9 && Math.abs(m3 - 1.3) < 1e-9 && m3 > m2 && m2 > m1);
    G.nowMs += 2100;
    G._fbComboTick(G.state, 2.1);
    check('combo decays after 2s window', G.state.combo === 0 && G.state.comboT === 0);

    /* ---- fallback board ---- */
    var b = G._createBoard(5);
    check('fallback board: 5×5 empty grid', b.size === 5 && b.cells.length === 25);
    b.cells[1] = { tier: 2, lucky: false, id: 99 };          /* merge partner first */
    var sp = null;
    for (var tries = 0; tries < 40 && !sp; tries++) sp = G._fbSpawn(b, 1, 1);
    check('fallback spawn fills an empty cell (never the occupied one)',
      !!sp && !!b.cells[sp.idx] && sp.idx !== 1);
    b.cells[sp.idx].tier = 2;                                /* match the partner */
    var mres = G._fbMerge(b, sp.idx, 1);
    check('fallback merge: same tier → tier+1 at target, source cleared',
      !!mres && mres.tier === 3 && !b.cells[sp.idx] && b.cells[1].tier === 3);
    b.cells[3] = { tier: 5, lucky: false, id: 100 };
    check('fallback merge: tier mismatch → null', G._fbMerge(b, 1, 3) === null);
    G._fbResize(b, 6);
    check('fallback resize: 5→6 preserves cube coords',
      b.size === 6 && b.cells.length === 36 && b.cells[1] && b.cells[1].tier === 3 && b.cells[3] && b.cells[3].tier === 5);
    b.cells[4] = { tier: 1, lucky: false, id: 101 };
    b.cells[5] = { tier: 1, lucky: false, id: 102 };
    check('fallback chainTargets: only non-empty, excludes source',
      (function () {
        var t = G._fbChainTargets(b, 8, 1);
        if (t.length < 3) return false;                      /* cubes at 3, 4, 5 */
        for (var q = 0; q < t.length; q++) { if (t[q] === 1 || !b.cells[t[q]]) return false; }
        return true;
      })());

    /* ---- save/restore round-trip (fallback path) ---- */
    G.board = G._createBoard(5);
    G.board.cells[0] = { tier: 4, lucky: true, id: 1 };
    G.board.nextId = 2;
    G.state.coins = 1234.5; G.state.lifetime = 9999;
    G.state.maxTierReached = 4;
    G.state.discovered = { 1: true, 2: true, 3: true, 4: true };
    G.state.upgrades = { tapPower: 2 };
    G.wheelState = { lastSpin: 77 };
    G.questState = { quests: [] };
    G.nowMs = 500000;
    var ser = G.serialize();
    check('serialize: versioned payload {v:1, s:{…}}', ser.v === 1 && !!ser.s && ser.size === 5);
    var st2 = G._restoreState(ser);
    check('serialize/restore: canon fields round-trip',
      st2.coins === 1234.5 && st2.lifetime === 9999 && st2.maxTierReached === 4);
    check('serialize/restore: discovered + upgrades round-trip',
      st2.discovered[4] === true && st2.upgrades.tapPower === 2);
    G.board = G._createBoard(ser.size);
    G._restoreCells(ser.cells);
    check('serialize/restore: board cells round-trip',
      !!G.board.cells[0] && G.board.cells[0].tier === 4 && G.board.cells[0].lucky === true);

    /* ---- wheel sector normalization ---- */
    check('sector kind: jackpot/income/lucky/merge/quest/dud/coins',
      G._sectorKind({ id: 'jackpot' }) === 'jackpot' &&
      G._sectorKind({ id: 'income_x2' }) === 'income' &&
      G._sectorKind('lucky_rain') === 'lucky' &&
      G._sectorKind({ kind: 'merge' }) === 'merge' &&
      G._sectorKind('quest_reroll') === 'quest' &&
      G._sectorKind({ name: 'SO CLOSE!' }) === 'dud' &&
      G._sectorKind('coins_med') === 'coins');

    /* ---- MC guards (no MC in node → methods still safe) ---- */
    check('MC: cluster skipped cleanly without mobile-controls',
      G._mountMc(true) === null && G._shouldMountMc() === false);
    G.board.cells[0] = null;                        /* only cube → empty board */
    check('MC: mcPop on empty board → 0, no crash', G.mcPop() === 0);
    G.board = b;                                    /* cubes at 1(t3), 3(t5), 4(t1), 5(t1) */
    b.cells[2] = { tier: 2, lucky: false, id: 300 };
    var vMc = G.mcPop();                            /* highest = tier 5 at idx 3 */
    check('MC: mcPop pops the highest-tier cell through the tap routine',
      vMc > 0 && !b.cells[3]);

    console.log(fail === 0 ? '\nALL TESTS PASSED (' + pass + ')' : '\n' + fail + ' FAILURES of ' + (pass + fail));
    process.exit(fail === 0 ? 0 : 1);
  })();
}

/* ================= BROWSER BOOTSTRAP ================= */
if (typeof window !== 'undefined') {
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { DP.Game.boot(); });
  } else {
    DP.Game.boot();
  }
}
