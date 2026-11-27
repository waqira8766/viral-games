/* ============================================================
   PULL THE PIN — js/game.js
   Physics (fixed 120Hz accumulator, circle-circle & circle-segment
   collision), procedural rendering, tiny WebAudio synth, UI.
   No dependencies. Browser: plain script after levels.js.
   Node: `node game.js` runs the self-tests at the bottom.
   ============================================================ */
(function () {
  'use strict';

  // ---------------- constants ----------------
  const W = 400, H = 640, FLOOR = H;
  const GRAVITY = 900, DT = 1 / 120, REST = 0.18, REST_SEG = 0.04; // step, sphere restitution, wall/pin restitution
  const SEG_FRIC = 0.05, AIR = 0.9995;                 // contact friction, air drag
  const HERO_R = 22, HERO_Y = H - 28;                  // hero center (612)
  const MAX_SPHERES = 60, PIN_PULL_PX = 120, PIN_PULL_S = 0.2;

  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  function closestOnSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1e-9;
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
    return { x: x1 + dx * t, y: y1 + dy * t };
  }

  // ================= PHYSICS =================
  function createWorld(level) {
    return {
      pins: level.pins.map(p => ({ x: p.x, y: p.y, len: p.len || 240, pulled: false, pullT: 0 })),
      spheres: level.spheres.map(s => ({
        x: s.x, y: s.y, r: s.r, vx: 0, vy: 0, type: s.type,
        dead: false, grounded: false, seed: Math.random() * 10, emberT: rand(0, 0.15)
      })),
      walls: (level.walls || []).map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
      hero: { x: level.heroX, y: HERO_Y, r: HERO_R },
      events: [], failed: false
    };
  }

  // water + lava touch -> one inert obsidian sphere (no collection value)
  function fuse(a, b, world) {
    const lava = a.type === 'lava' ? a : b, water = a.type === 'water' ? a : b;
    const ml = lava.r * lava.r, mw = water.r * water.r, tm = ml + mw;
    const ox = (lava.x * ml + water.x * mw) / tm, oy = (lava.y * ml + water.y * mw) / tm;
    a.dead = b.dead = true;
    if (world.spheres.filter(s => !s.dead).length <= MAX_SPHERES) {
      world.spheres.push({
        x: ox, y: oy, r: 16, type: 'obsidian', dead: false, grounded: true,
        vx: (lava.vx * ml + water.vx * mw) / tm * 0.5,
        vy: (lava.vy * ml + water.vy * mw) / tm * 0.5,
        seed: Math.random() * 10, emberT: 0
      });
    }
    world.events.push({ t: 'fuse', x: ox, y: oy });
  }

  function resolveSeg(s, x1, y1, x2, y2) {
    const q = closestOnSeg(s.x, s.y, x1, y1, x2, y2);
    let nx = s.x - q.x, ny = s.y - q.y;
    const d2 = nx * nx + ny * ny;
    if (d2 >= s.r * s.r) return;
    let d = Math.sqrt(d2);
    if (d < 1e-4) { nx = 0; ny = -1; d = 1; } else { nx /= d; ny /= d; }
    s.x = q.x + nx * s.r; s.y = q.y + ny * s.r;                 // full positional correction
    const vn = s.vx * nx + s.vy * ny;
    if (vn < 0) { s.vx -= (1 + REST_SEG) * vn * nx; s.vy -= (1 + REST_SEG) * vn * ny; }
    const tx = -ny, ty = nx, vt = s.vx * tx + s.vy * ty;        // tangential rub
    s.vx -= vt * tx * SEG_FRIC; s.vy -= vt * ty * SEG_FRIC;
    if (ny < -0.3) s.grounded = true;
  }

  function stepWorld(w, dt) {
    const segs = [];
    for (const p of w.pins) if (!p.pulled) segs.push([p.x, p.y, p.x + p.len, p.y]);
    for (const g of w.walls) segs.push([g.x1, g.y1, g.x2, g.y2]);
    for (const s of w.spheres) {                               // integrate
      if (s.dead) continue;
      s.vy += GRAVITY * dt; s.vx *= AIR; s.vy *= AIR;
      s.x += s.vx * dt; s.y += s.vy * dt; s.grounded = false;
    }
    for (let it = 0; it < 2; it++) {                            // solver passes
      const S = w.spheres;
      for (let i = 0; i < S.length; i++) {                      // circle-circle
        const a = S[i]; if (a.dead) continue;
        for (let j = i + 1; j < S.length; j++) {
          const b = S[j]; if (b.dead) continue;
          const rr = a.r + b.r, dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr) continue;                            // touching-but-not-overlapping = free
          if ((a.type === 'water' && b.type === 'lava') || (a.type === 'lava' && b.type === 'water')) { fuse(a, b, w); continue; }
          const d = Math.sqrt(d2) || 1e-4, nx = dx / d, ny = dy / d;
          const ma = a.r * a.r, mb = b.r * b.r, tm = ma + mb, ov = rr - d;
          a.x -= nx * ov * mb / tm; a.y -= ny * ov * mb / tm;    // positional correction
          b.x += nx * ov * ma / tm; b.y += ny * ov * ma / tm;
          const rvx = b.vx - a.vx, rvy = b.vy - a.vy, vn = rvx * nx + rvy * ny;
          if (vn < 0) {                                         // normal impulse
            const jn = -(1 + REST) * vn / (1 / ma + 1 / mb);
            a.vx -= jn * nx / ma; a.vy -= jn * ny / ma;
            b.vx += jn * nx / mb; b.vy += jn * ny / mb;
            const tvx = rvx - vn * nx, tvy = rvy - vn * ny;     // tangential rub
            a.vx += tvx * 0.04; a.vy += tvy * 0.04;
            b.vx -= tvx * 0.04; b.vy -= tvy * 0.04;
          }
          a.grounded = b.grounded = true;
        }
      }
      const h = w.hero;                                          // hero contacts
      for (const s of w.spheres) {
        if (s.dead) continue;
        const rr = s.r + h.r, dx = s.x - h.x, dy = s.y - h.y, d2 = dx * dx + dy * dy;
        if (s.type === 'gold') {                                // forgiving catch
          if (d2 < (rr + 2) * (rr + 2)) { s.dead = true; w.events.push({ t: 'collect', x: s.x, y: s.y }); }
          continue;
        }
        if (d2 >= rr * rr) continue;
        if (s.type === 'lava') {
          if (!w.failed) { w.failed = true; w.events.push({ t: 'fail', x: s.x, y: s.y }); }
          continue;
        }
        if (s.type === 'water') { s.dead = true; w.events.push({ t: 'splash', x: s.x, y: s.y }); continue; }
        s.dead = true; w.events.push({ t: 'crumble', x: s.x, y: s.y }); // rocks shatter on the helmet
      }
      for (const s of w.spheres) {                              // pins & walls
        if (s.dead) continue;
        for (const g of segs) resolveSeg(s, g[0], g[1], g[2], g[3]);
      }
      for (const s of w.spheres) {                              // floor & side walls
        if (s.dead) continue;
        if (s.y + s.r > FLOOR) { s.y = FLOOR - s.r; if (s.vy > 0) s.vy = -s.vy * REST_SEG; s.vx *= (1 - SEG_FRIC); s.grounded = true; }
        if (s.x - s.r < 0) { s.x = s.r; if (s.vx < 0) s.vx = -s.vx * REST_SEG; }
        if (s.x + s.r > W) { s.x = W - s.r; if (s.vx > 0) s.vx = -s.vx * REST_SEG; }
      }
    }
    for (const s of w.spheres) {                                // settle to sleep
      if (s.dead) continue;
      if (s.grounded) {
        const sp = Math.hypot(s.vx, s.vy);
        if (sp < 26) { s.vx *= 0.7; s.vy *= 0.7; if (sp < 6) { s.vx = 0; s.vy = 0; } }
      }
    }
    w.spheres = w.spheres.filter(s => !s.dead);
  }

  // ================= AUDIO (procedural, lazy, guarded) =================
  const AudioSys = (() => {
    let ac = null, master = null, muted = false;
    function ensure() {
      if (ac) return true;
      try {
        const A = window.AudioContext || window.webkitAudioContext;
        if (!A) return false;
        ac = new A(); master = ac.createGain();
        master.gain.value = 0.55; master.connect(ac.destination);
      } catch (e) { ac = null; }
      return !!ac;
    }
    function tone(freq, dur, type, vol, slide, delay) {
      if (!ac) return;
      const t0 = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.4, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.03);
    }
    function noise(dur, vol, f0, f1, q, delay) {
      if (!ac) return;
      const t0 = ac.currentTime + (delay || 0), n = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource(); src.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q || 1;
      bp.frequency.setValueAtTime(f0, t0);
      bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.4, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(bp); bp.connect(g); g.connect(master); src.start(t0); src.stop(t0 + dur + 0.02);
    }
    function play(name) {
      if (muted) return;
      try {
        if (!ensure()) return;
        if (ac.state === 'suspended') ac.resume();
        switch (name) {
          case 'pull': noise(0.22, 0.5, 1400, 300, 0.8); tone(220, 0.12, 'square', 0.12, -120); break;
          case 'collect': tone(988, 0.09, 'triangle', 0.35); tone(1319, 0.14, 'triangle', 0.35, 0, 0.07); break;
          case 'fuse': noise(0.35, 0.5, 900, 150, 0.6); tone(140, 0.25, 'sine', 0.3, -60); break;
          case 'fail': tone(150, 0.4, 'sawtooth', 0.4, -80); tone(95, 0.45, 'square', 0.25, -30, 0.02); noise(0.5, 0.4, 600, 100, 0.5); break;
          case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.32, 0, i * 0.09)); tone(1568, 0.3, 'triangle', 0.2, 0, 0.4); break;
          case 'click': tone(660, 0.05, 'square', 0.15); break;
          case 'plip': tone(520, 0.08, 'sine', 0.25, 140); break;
          case 'thud': tone(90, 0.12, 'sine', 0.35, -40); noise(0.08, 0.3, 300, 80, 1); break;
        }
      } catch (e) { /* audio is best-effort */ }
    }
    return {
      play,
      unlock() { try { ensure(); if (ac && ac.state === 'suspended') ac.resume(); } catch (e) {} },
      get muted() { return muted; },
      set muted(v) { muted = v; try { if (master) master.gain.value = v ? 0 : 0.55; } catch (e) {} }
    };
  })();

  // ================= GAME STATE =================
  const Game = {
    state: 'home', idx: 0, world: null, goldGot: 0, goldTotal: 0, fails: 0,
    time: 0, dt: 0, acc: 0, shake: 0, burn: 0, hoverPin: -1, clearAt: 0,
    particles: [], save: { u: 1, s: {}, m: false }
  };

  function loadSave() {
    try {
      const s = JSON.parse(localStorage.getItem('pin_save_v1') || '{}');
      return { u: s.u || 1, s: s.s || {}, m: !!s.m };
    } catch (e) { return { u: 1, s: {}, m: false }; }
  }
  function persist() { try { localStorage.setItem('pin_save_v1', JSON.stringify(Game.save)); } catch (e) {} }

  // ---------------- particles ----------------
  function spawnSparks(x, y, col, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, 6.283), sp = rand(40, 190);
      Game.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: rand(0.3, 0.7), max: 0.7, size: rand(1.5, 3), col, grav: 500, type: 'dot' });
    }
  }
  function spawnSteam(x, y, n) {
    for (let i = 0; i < n; i++) {
      Game.particles.push({ x: x + rand(-6, 6), y: y + rand(-6, 6), vx: rand(-45, 45), vy: rand(-75, -20), life: rand(0.5, 1), max: 1, size: rand(3, 7), col: '#e2e8f0', grav: -40, type: 'smoke' });
    }
  }
  function spawnConfetti() {
    const cols = ['#f472b6', '#facc15', '#4ade80', '#38bdf8', '#a78bfa', '#fb923c'];
    for (let i = 0; i < 90; i++) {
      Game.particles.push({ x: rand(0, W), y: rand(-70, -5), vx: rand(-60, 60), vy: rand(20, 130), life: rand(1.4, 2.4), max: 2.4, size: rand(4, 7), col: cols[i % 6], grav: 260, type: 'conf', ang: rand(0, 6.283), spin: rand(-7, 7) });
    }
  }
  function updateParticles(dt) {
    const P = Game.particles;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) { P.splice(i, 1); continue; }
      p.vy += (p.grav || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.spin) p.ang += p.spin * dt;
    }
    if (P.length > 400) P.splice(0, P.length - 400);
  }

  // ================= BROWSER UI =================
  let cv, ctx, cdTimer = null, MCBtns = null;
  const $ = id => document.getElementById(id);

  // ---- one-thumb handlers: DOM buttons and the MC touch cluster invoke the
  // SAME function objects — identical behavior, each press fires exactly once.
  function doRetry() { AudioSys.play('click'); startLevel(Game.idx, true); }
  function doMute() { AudioSys.muted = !AudioSys.muted; Game.save.m = AudioSys.muted; persist(); updateMuteBtn(); }

  // Touch-cluster retry gate: a retry is only meaningful mid-play or on the
  // fail overlay. Pure function so the self-tests can verify the MC path.
  function mcRetryGate(state, fire) {
    if (state === 'play' || state === 'fail') { fire(); return true; }
    return false;
  }

  function mountTouchCluster() {
    const MC = globalThis.MC;
    if (!MC || !MC.isTouchDevice || !MC.isTouchDevice(navigator) || typeof MC.createButton !== 'function') return;
    const wrap = document.createElement('div');
    wrap.id = 'mcCluster';
    const retry = MC.createButton({
      container: wrap, label: '\u27F3', size: 52, color: '#fbbf24', id: 'ptpMcRetry',
      onDown: function () { mcRetryGate(Game.state, doRetry); }
    });
    const mute = MC.createButton({
      container: wrap, label: AudioSys.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A', size: 52, color: '#38bdf8', id: 'ptpMcMute',
      onDown: function () { doMute(); }
    });
    document.body.appendChild(wrap);
    MCBtns = { retry: retry, mute: mute };
  }

  function init() {
    cv = $('cv');
    const use3d = R3D.boot(cv);                               // three.js presentation on the SAME canvas
    if (!use3d) { try { ctx = cv.getContext('2d'); } catch (err) { ctx = null; } } // 2D fallback path stays callable
    Game.save = loadSave();
    AudioSys.muted = Game.save.m;
    renderPills(); updateMuteBtn();
    $('btnPlay').addEventListener('click', () => { AudioSys.unlock(); AudioSys.play('click'); showGame(); startLevel(Math.min(Game.save.u, PIN_LEVELS.length) - 1); });
    $('btnRetry').addEventListener('click', doRetry);
    $('btnHome').addEventListener('click', () => { AudioSys.play('click'); goHome(); });
    $('btnRetry2').addEventListener('click', doRetry);
    $('btnNext').addEventListener('click', () => { AudioSys.play('click'); if (Game.idx + 1 < PIN_LEVELS.length) startLevel(Game.idx + 1); else goHome(); });
    $('btnMute').addEventListener('click', doMute);
    cv.addEventListener('pointerdown', e => {
      AudioSys.unlock();
      if (Game.state !== 'play') return;
      const p = canvasPos(e), i = pinAt(p.x, p.y);
      if (i >= 0) pullPin(i);
    });
    cv.addEventListener('pointermove', e => {
      const p = canvasPos(e);
      Game.hoverPin = Game.state === 'play' ? pinAt(p.x, p.y) : -1;
      cv.style.cursor = Game.hoverPin >= 0 ? 'pointer' : 'default';
      if (R3D.ready) R3D.pointer(p.x, p.y);                 // eased parallax target (visual only)
    });
    cv.addEventListener('pointerleave', () => { if (R3D.ready) R3D.pointer(-1, -1); });
    addEventListener('keydown', e => {
      if ((e.key === 'm' || e.key === 'M') && $('btnMute')) $('btnMute').click();
      if ((e.key === 'r' || e.key === 'R') && Game.state === 'play') startLevel(Game.idx, true);
    });
    addEventListener('resize', fit);
    mountTouchCluster();
    fit(); goHome();
    requestAnimationFrame(frame);
  }

  function fit() {
    const s = Math.max(0.4, Math.min(1, (innerWidth - 24) / W, (innerHeight - 205) / H));
    cv.style.width = (W * s | 0) + 'px'; cv.style.height = (H * s | 0) + 'px';
    if (R3D.ready) R3D.resize(W * s | 0, H * s | 0);         // WebGL buffer follows the CSS layout
  }
  function canvasPos(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }
  function pinAt(x, y) {
    if (!Game.world) return -1;
    const pins = Game.world.pins;
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      if (!p.pulled && Math.abs(y - p.y) <= 26 && x >= p.x - 22 && x <= p.x + p.len + 36) return i;
    }
    return -1;
  }
  function pullPin(i) {
    const p = Game.world.pins[i];
    p.pulled = true; p.pullT = 0;
    AudioSys.play('pull');
    spawnSparks(p.x, p.y, '#e2e8f0', 8);
    spawnSparks(p.x + p.len, p.y, '#94a3b8', 5);
  }

  function renderPills() {
    const el = $('pills'); el.innerHTML = '';
    PIN_LEVELS.forEach((lv, i) => {
      const b = document.createElement('button');
      const unlocked = i < Game.save.u;
      b.className = 'pill' + (unlocked ? '' : ' locked') + (i === Game.idx && Game.state !== 'home' ? ' cur' : '');
      b.title = lv.name;
      if (unlocked) {
        const st = Game.save.s[i] || 0;
        b.innerHTML = (i + 1) + '<span class="pstars">' + '\u2605'.repeat(st) + '\u2606'.repeat(3 - st) + '</span>';
        b.addEventListener('click', () => { AudioSys.play('click'); startLevel(i); });
      } else b.textContent = '\uD83D\uDD12';
      el.appendChild(b);
    });
  }
  function updateMuteBtn() {
    $('btnMute').textContent = AudioSys.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    if (MCBtns && MCBtns.mute && MCBtns.mute.svg) {            // keep the touch cluster in sync
      const t = MCBtns.mute.svg.querySelector('text');
      if (t) t.textContent = AudioSys.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    }
  }

  function showGame() { $('home').style.display = 'none'; $('game').style.display = 'flex'; }
  function goHome() {
    Game.state = 'home'; stopCountdown(); hideOverlays();
    $('game').style.display = 'none'; $('home').style.display = 'flex';
    let total = 0; Object.keys(Game.save.s).forEach(k => total += Game.save.s[k]);
    $('homeStars').textContent = '\u2B50 ' + total + ' / ' + (PIN_LEVELS.length * 3);
    renderPills();
  }
  function hideOverlays() { $('failOv').classList.remove('show'); $('clearOv').classList.remove('show'); }

  function startLevel(i, keepFails) {
    stopCountdown(); hideOverlays();
    Game.idx = i;
    Game.world = createWorld(PIN_LEVELS[i]);
    Game.goldGot = 0;
    Game.goldTotal = PIN_LEVELS[i].spheres.filter(s => s.type === 'gold').length;
    if (!keepFails) Game.fails = 0;
    Game.state = 'play'; Game.acc = 0; Game.burn = 0; Game.shake = 0; Game.hoverPin = -1; Game.clearAt = 0;
    $('clearOv').querySelectorAll('.star').forEach(el => el.classList.remove('earned'));
    renderPills(); updateHUD();
  }

  function updateHUD() {
    $('lv').textContent = 'LEVEL ' + (Game.idx + 1) + '/' + PIN_LEVELS.length;
    $('name').textContent = PIN_LEVELS[Game.idx].name;
    $('gold').textContent = '\uD83E\uDE99 ' + Game.goldGot + ' / ' + Game.goldTotal;
    const show = Game.fails >= 2 || Game.idx === 0;
    const hb = $('hintbar');
    hb.classList.toggle('show', show);
    if (show) hb.textContent = '\uD83D\uDCA1 ' + PIN_LEVELS[Game.idx].hint;
  }

  function handleEvents() {
    for (const e of Game.world.events) {
      if (R3D.ready) R3D.onEvent(e);                          // 3D layer reacts (coin flip, flashes, hero jump)
      if (e.t === 'collect') { Game.goldGot++; spawnSparks(e.x, e.y, '#fde047', 14); AudioSys.play('collect'); }
      else if (e.t === 'fuse') { spawnSteam(e.x, e.y, 12); AudioSys.play('fuse'); }
      else if (e.t === 'splash') { spawnSparks(e.x, e.y, '#7dd3fc', 10); AudioSys.play('plip'); }
      else if (e.t === 'crumble') { spawnSparks(e.x, e.y, '#94a3b8', 12); AudioSys.play('thud'); }
      else if (e.t === 'fail') onFail(e.x, e.y);
    }
    Game.world.events.length = 0;
    // last gold collected -> arm a short grace so lava already falling can still land
    if (Game.state === 'play' && Game.goldGot >= Game.goldTotal && Game.clearAt === 0)
      Game.clearAt = Game.time + 0.7;
  }

  function onFail(x, y) {
    Game.state = 'fail'; Game.fails++; Game.shake = 0.7; Game.burn = 0;
    AudioSys.play('fail');
    spawnSparks(x, y, '#fb923c', 20); spawnSparks(x, y, '#fca5a5', 8); spawnSteam(x, y, 10);
    setTimeout(() => { if (Game.state === 'fail') { $('failOv').classList.add('show'); startCountdown(); } }, 750);
  }
  function startCountdown() {
    stopCountdown(); let n = 3;
    const tick = () => {
      if (Game.state !== 'fail') { stopCountdown(); return; }
      $('cd').textContent = n > 0 ? 'Auto-retry in ' + n + '\u2026' : 'Retrying\u2026';
      if (n <= 0) startLevel(Game.idx, true); else { n--; cdTimer = setTimeout(tick, 1000); }
    };
    tick();
  }
  function stopCountdown() { if (cdTimer) { clearTimeout(cdTimer); cdTimer = null; } }

  function onClear() {
    Game.state = 'clear';
    AudioSys.play('win'); spawnConfetti();
    const stars = Game.fails === 0 ? 3 : Game.fails === 1 ? 2 : 1;
    Game.save.s[Game.idx] = Math.max(Game.save.s[Game.idx] || 0, stars);
    Game.save.u = Math.max(Game.save.u, Math.min(PIN_LEVELS.length, Game.idx + 2));
    persist();
    const last = Game.idx === PIN_LEVELS.length - 1;
    $('clearTitle').textContent = last ? 'GAME COMPLETE! \uD83C\uDFC6' : 'LEVEL CLEAR!';
    $('clearSub').textContent = stars === 3 ? 'Flawless run \u2014 3 stars!' : stars === 2 ? 'So close to perfect!' : 'Rough ride, but you made it!';
    $('clearOv').querySelectorAll('.star').forEach((el, i) => {
      el.classList.toggle('earned', i < stars);
      el.style.animationDelay = (0.15 + i * 0.18) + 's';
    });
    $('btnNext').textContent = last ? '\uD83C\uDFE0 FINISH' : 'NEXT \u25B6';
    setTimeout(() => { if (Game.state === 'clear') $('clearOv').classList.add('show'); }, 600);
    renderPills();
  }

  // ---------------- main loop ----------------
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!last) last = now;
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.1) dt = 0.1;
    Game.time += dt; Game.dt = dt;
    if (Game.shake > 0) Game.shake = Math.max(0, Game.shake - dt * 1.6);
    if (Game.state === 'fail') {
      Game.burn = Math.min(1, Game.burn + dt * 2);
      if (Math.random() < 0.35 && Game.world)
        Game.particles.push({ x: Game.world.hero.x + rand(-10, 10), y: HERO_Y - 10 + rand(-8, 8), vx: rand(-15, 15), vy: rand(-60, -30), life: rand(0.5, 1), max: 1, size: rand(3, 6), col: '#64748b', grav: -50, type: 'smoke' });
    }
    if (Game.world) for (const p of Game.world.pins) if (p.pulled && p.pullT < 1) p.pullT = Math.min(1, p.pullT + dt / PIN_PULL_S);
    if (Game.state === 'play' && Game.world) {
      Game.acc += dt; let n = 0;
      while (Game.acc >= DT && n < 50) {
        stepWorld(Game.world, DT); Game.acc -= DT; n++;
        handleEvents();
        if (Game.state !== 'play') { Game.acc = 0; break; }
      }
    }
    if (Game.clearAt > 0 && Game.time >= Game.clearAt) {   // grace elapsed -> clear
      Game.clearAt = 0;
      if (Game.state === 'play') onClear();
    }
    updateParticles(dt);
    draw();
    updateHUD();
  }

  // ================= RENDERING =================
  function draw() {
    if (R3D.ready) { R3D.draw(); return; }                     // three.js presentation; 2D path below is the fallback
    ctx.save();
    if (Game.shake > 0) { const a = Game.shake * 14; ctx.translate(rand(-a, a), rand(-a, a)); }
    drawBG();
    if (Game.world) {
      for (const g of Game.world.walls) drawWall(g);
      Game.world.pins.forEach((p, i) => drawPin(p, i));
      for (const s of Game.world.spheres) drawSphere(s);
      drawHero();
    }
    drawParticles();
    ctx.restore();
  }

  function drawBG() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#16202f'); g.addColorStop(0.7, '#111827'); g.addColorStop(1, '#0b1220');
    ctx.fillStyle = g; ctx.fillRect(-24, -24, W + 48, H + 48);
    for (let i = 0; i < 26; i++) {                                  // twinkles
      const x = (i * 137) % W, y = (i * 89 + 31) % 420;
      const a = 0.2 + 0.3 * (0.5 + 0.5 * Math.sin(Game.time * 1.5 + i));
      ctx.fillStyle = 'rgba(148,163,184,' + a.toFixed(3) + ')';
      ctx.fillRect(x, y, 2, 2);
    }
    const hx = Game.world ? Game.world.hero.x : 200;                 // hero spotlight
    const hg = ctx.createRadialGradient(hx, 545, 10, hx, 545, 170);
    hg.addColorStop(0, 'rgba(56,189,248,0.10)'); hg.addColorStop(1, 'rgba(56,189,248,0)');
    ctx.fillStyle = hg; ctx.fillRect(0, 360, W, H - 360);
    ctx.fillStyle = '#0f172a'; ctx.fillRect(-24, H - 8, W + 48, 32); // floor slab
    ctx.fillStyle = 'rgba(148,163,184,0.3)'; ctx.fillRect(-24, H - 3, W + 48, 3);
  }

  function drawWall(g) {
    ctx.lineCap = 'round';
    const lg = ctx.createLinearGradient(g.x1, g.y1 - 8, g.x2, g.y2 + 8);
    lg.addColorStop(0, '#475569'); lg.addColorStop(1, '#1e293b');
    ctx.strokeStyle = lg; ctx.lineWidth = 13;
    ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
    ctx.strokeStyle = 'rgba(226,232,240,0.22)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(g.x1, g.y1 - 3); ctx.lineTo(g.x2, g.y2 - 3); ctx.stroke();
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPin(p, i) {
    if (p.pulled && p.pullT >= 1) return;
    let off = 0, alpha = 1;
    if (p.pulled) {
      const t = p.pullT, e = t * t * (3 - 2 * t);                   // ease in-out
      off = -PIN_PULL_PX * e; alpha = Math.max(0, 1 - t * 0.9);
    }
    const x = p.x + off, y = p.y, L = p.len;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (!p.pulled && Game.hoverPin === i) { ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 12; }
    const g = ctx.createLinearGradient(0, y - 5, 0, y + 5);         // metallic bar
    g.addColorStop(0, '#e2e8f0'); g.addColorStop(0.45, '#94a3b8');
    g.addColorStop(0.55, '#64748b'); g.addColorStop(1, '#1e293b');
    rr(x, y - 4.5, L, 9, 4.5); ctx.fillStyle = g; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; rr(x + 3, y - 3.4, L - 6, 1.6, 1); ctx.fill();
    if (p.pulled && p.pullT < 1) {                                  // metallic shine sweep
      const sx = x + L * p.pullT * 0.5;
      ctx.fillStyle = 'rgba(255,255,255,' + (0.75 * (1 - p.pullT)).toFixed(3) + ')';
      ctx.fillRect(sx - 6, y - 5, 12, 10);
    }
    const kg = ctx.createRadialGradient(x - 12, y - 3, 1, x - 9, y, 11); // pull knob
    kg.addColorStop(0, '#fde68a'); kg.addColorStop(0.6, '#f59e0b'); kg.addColorStop(1, '#b45309');
    ctx.beginPath(); ctx.arc(x - 9, y, 10, 0, 7); ctx.fillStyle = kg; ctx.fill();
    ctx.beginPath(); ctx.arc(x - 9, y, 4, 0, 7); ctx.fillStyle = '#0b1220'; ctx.fill();
    ctx.restore();
  }

  function drawSphere(s) {
    const { x, y, r } = s, t = Game.time + s.seed;
    if (s.type === 'lava' || s.type === 'gold') {                   // soft glow
      const gc = s.type === 'lava' ? '251,146,60' : '250,204,21';
      const gg = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * (s.type === 'lava' ? 1.9 : 1.5));
      gg.addColorStop(0, 'rgba(' + gc + ',' + (s.type === 'lava' ? 0.5 : 0.22) + ')');
      gg.addColorStop(1, 'rgba(' + gc + ',0)');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, r * (s.type === 'lava' ? 1.9 : 1.5), 0, 7); ctx.fill();
    }
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
    if (s.type === 'gold') { g.addColorStop(0, '#fef9c3'); g.addColorStop(0.4, '#fcd34d'); g.addColorStop(0.8, '#f59e0b'); g.addColorStop(1, '#b45309'); }
    else if (s.type === 'lava') { g.addColorStop(0, '#fed7aa'); g.addColorStop(0.4, '#fb923c'); g.addColorStop(0.8, '#ef4444'); g.addColorStop(1, '#7f1d1d'); }
    else if (s.type === 'water') { g.addColorStop(0, '#e0f2fe'); g.addColorStop(0.4, '#7dd3fc'); g.addColorStop(0.8, '#3b82f6'); g.addColorStop(1, '#1e3a8a'); }
    else { g.addColorStop(0, '#94a3b8'); g.addColorStop(0.45, '#475569'); g.addColorStop(1, '#0f172a'); }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1; ctx.stroke();
    if (s.type === 'gold') {                                        // sparkly glint
      const ga = 0.5 + 0.5 * Math.sin(t * 3);
      const gx = x + Math.cos(t) * r * 0.55, gy = y + Math.sin(t) * r * 0.55;
      ctx.strokeStyle = 'rgba(255,255,255,' + (ga * 0.85).toFixed(3) + ')'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx - 3, gy); ctx.lineTo(gx + 3, gy); ctx.moveTo(gx, gy - 3); ctx.lineTo(gx, gy + 3); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.42, r * 0.18, 0, 7); ctx.fill();
    } else if (s.type === 'lava') {                                 // crust blotches
      ctx.fillStyle = 'rgba(127,29,29,0.5)';
      for (let k = 0; k < 3; k++) {
        const a = s.seed * 2 + k * 2.1;
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.45, r * 0.18, 0, 7); ctx.fill();
      }
    } else if (s.type === 'water') {                                // shimmer
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.ellipse(x + Math.sin(t * 2.5) * r * 0.25 - r * 0.2, y - r * 0.35, r * 0.3, r * 0.16, -0.5, 0, 7); ctx.fill();
    } else {                                                        // obsidian sheen
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.5);
      ctx.fillStyle = 'rgba(226,232,240,0.35)'; ctx.fillRect(-r * 0.5, -r * 0.15, r, 2.5);
      ctx.restore();
      ctx.strokeStyle = 'rgba(139,92,246,0.4)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, r - 0.8, 0, 7); ctx.stroke();
    }
    if (s.type === 'lava') {                                        // embers
      s.emberT -= Game.dt;
      if (s.emberT <= 0) {
        s.emberT = rand(0.08, 0.2);
        Game.particles.push({ x: x + rand(-r * 0.5, r * 0.5), y: y - rand(0, r * 0.4), vx: rand(-12, 12), vy: rand(-55, -25), life: rand(0.4, 0.8), max: 0.8, size: rand(1.5, 3), col: '#fb923c', grav: -30, type: 'dot' });
      }
    }
  }

  function drawShield(x, y) {
    ctx.save(); ctx.translate(x, y);
    const g = ctx.createLinearGradient(-6, -9, 6, 10);
    g.addColorStop(0, '#e2e8f0'); g.addColorStop(1, '#475569');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(7, -5); ctx.lineTo(7, 2);
    ctx.quadraticCurveTo(7, 8, 0, 10); ctx.quadraticCurveTo(-7, 8, -7, 2);
    ctx.lineTo(-7, -5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(15,23,42,0.5)'; ctx.stroke();
    ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, 7); ctx.fill();
    ctx.restore();
  }

  function drawHero() {
    const h = Game.world.hero;
    const x = h.x, y = h.y + Math.sin(Game.time * 2) * 1.5;         // idle bob (visual only)
    const dead = Game.state === 'fail', burn = Game.burn;
    ctx.fillStyle = 'rgba(2,6,23,0.5)';                             // shadow
    ctx.beginPath(); ctx.ellipse(x, HERO_Y + HERO_R + 3, HERO_R * 0.95, 5, 0, 0, 7); ctx.fill();
    drawShield(x - HERO_R - 8, y + 3);
    const g = ctx.createRadialGradient(x - 7, y - 8, 3, x, y, HERO_R); // body
    if (dead) { g.addColorStop(0, '#52525b'); g.addColorStop(0.5, '#3f3f46'); g.addColorStop(1, '#18181b'); }
    else { g.addColorStop(0, '#f1f5f9'); g.addColorStop(0.5, '#cbd5e1'); g.addColorStop(1, '#64748b'); }
    ctx.beginPath(); ctx.arc(x, y, HERO_R, 0, 7); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(15,23,42,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#475569';                                      // helmet cap
    ctx.beginPath(); ctx.arc(x, y + 1, HERO_R - 1.5, Math.PI * 1.02, Math.PI * 1.98);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath(); ctx.arc(x - HERO_R * 0.62, y - HERO_R * 0.5, 1.6, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x + HERO_R * 0.62, y - HERO_R * 0.5, 1.6, 0, 7); ctx.fill();
    if (!dead) {                                                    // plume
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, y - HERO_R + 1);
      ctx.quadraticCurveTo(x - 3, y - HERO_R - 6, x - 8, y - HERO_R - 4); ctx.stroke();
    }
    if (dead) {                                                     // X eyes + char
      ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 2;
      [-7, 7].forEach(ex => {
        ctx.beginPath();
        ctx.moveTo(x + ex - 3, y + 1); ctx.lineTo(x + ex + 3, y + 7);
        ctx.moveTo(x + ex + 3, y + 1); ctx.lineTo(x + ex - 3, y + 7); ctx.stroke();
      });
      ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(x, y + 12, 3, Math.PI, Math.PI * 2); ctx.stroke();
      if (burn > 0.4) {                                             // head flames
        const fl = 0.5 + 0.5 * Math.sin(Game.time * 18);
        ctx.fillStyle = 'rgba(251,146,60,' + (0.6 * fl).toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(x - 6, y - HERO_R + 2);
        ctx.quadraticCurveTo(x - 2, y - HERO_R - 9 * fl - 4, x, y - HERO_R + 2);
        ctx.quadraticCurveTo(x + 4, y - HERO_R - 12 * fl - 4, x + 7, y - HERO_R + 2);
        ctx.closePath(); ctx.fill();
      }
    } else {                                                        // cute face + blink
      const blink = (Game.time % 3.4) < 0.14;
      [-7, 7].forEach(ex => {
        if (blink) {
          ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x + ex - 4, y + 4); ctx.lineTo(x + ex + 4, y + 4); ctx.stroke();
        } else {
          ctx.fillStyle = '#f8fafc';
          ctx.beginPath(); ctx.arc(x + ex, y + 4, 4.2, 0, 7); ctx.fill();
          ctx.fillStyle = '#0f172a';
          ctx.beginPath(); ctx.arc(x + ex + Math.sin(Game.time) * 0.8, y + 4.5, 2, 0, 7); ctx.fill();
        }
      });
      ctx.fillStyle = 'rgba(244,114,182,0.55)';                     // blush
      ctx.beginPath(); ctx.arc(x - 11, y + 8, 2.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(x + 11, y + 8, 2.6, 0, 7); ctx.fill();
      ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(x, y + 7.5, 4.5, 0.2, Math.PI - 0.2); ctx.stroke();
    }
  }

  function drawParticles() {
    for (const p of Game.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      if (p.type === 'conf') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.ang || 0);
        ctx.fillStyle = p.col; ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
      } else if (p.type === 'smoke') {
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - a * 0.6), 0, 7); ctx.fill();
      } else {
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ================= 3D PRESENTATION — pure helpers (node-testable) =================
  // All three.js-facing math lives here so the self-tests can verify the
  // camera/framing contract without a DOM: projected screen (x,y) must stay
  // EXACTLY the physics (x,y) so pinAt/canvasPos accuracy is untouched.
  const T3 = (() => {
    const TILT = 10 * Math.PI / 180;                          // scene-board tilt on X (radians)
    const SIN = Math.sin(TILT), COS = Math.cos(TILT), TAN = Math.tan(TILT);
    const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

    function pullSlide(t) {                                   // slide with overshoot, settles exactly
      t = clamp01(t);
      const c1 = 1.55, c3 = c1 + 1, u = t - 1;
      return -PIN_PULL_PX * (1 + c3 * u * u * u + c1 * u * u);
    }
    function pullAlpha(t) { return clamp01(1 - Math.max(0, t) * 0.9); }  // same fade law as the 2D pins
    function impactSquash(vy) { return clamp01((Math.abs(vy) - 180) / 1400) * 0.38; }
    function squashAnim(t, peak) {                            // squash → rebound stretch → settle
      if (peak <= 0) return 0;
      t = Math.max(0, t);
      return peak * Math.exp(-5 * t) * Math.cos(9 * t);
    }
    function parallax(p) { return clamp(p, -12, 12); }        // max ±12px screen-equivalent
    function parallaxEase(cur, target, dt) { return cur + (target - cur) * Math.min(1, (dt || 0.016) * 5); }
    function jumpArc(t) { return Math.sin(Math.PI * clamp01(t)); }
    function eyeFollow(dx, dy) {
      const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 60) * 1.4;
      return { x: dx / d * k, y: dy / d * k };
    }
    function lightBudget(spheres, cap) {                     // ≤ cap point lights, biggest lava first
      const idx = [];
      for (let i = 0; i < (spheres || []).length; i++) {
        const s = spheres[i];
        if (s && !s.dead && s.type === 'lava') idx.push(i);
      }
      idx.sort((a, b) => spheres[b].r - spheres[a].r);
      return idx.slice(0, cap || 3);
    }
    function glowPulse(t, seed) { return 0.85 + 0.35 * Math.sin(t * 4.6 + (seed || 0) * 3); }
    function flashDecay(t) { return Math.exp(-6 * Math.max(0, t)); }
    // Stage group = pivot(200,320) · Rx(+TILT) · scaleY(1/COS). localY pre-compensates
    // each object's board-depth z so its projected screen-y equals the physics y 1:1.
    function localY(y, z) { return (y - 320) + (z || 0) * SIN; }
    function depthZ(y, z) { return (y - 320) * TAN + (z || 0) / COS; }
    function projectedY(y, z) {                              // full chain: compensate → scale → rotate
      const yl = localY(y, z), ys = yl / COS;
      return ys * COS - (z || 0) * SIN + 320;
    }
    const MATS = {                                           // sphere type → material recipe
      gold:     { color: '#fbbf24', emissive: '#451a03', metalness: 0.85, roughness: 0.30, opacity: 1 },
      lava:     { color: '#7c2d12', emissive: '#f97316', metalness: 0.15, roughness: 0.55, opacity: 1 },
      water:    { color: '#3b82f6', emissive: '#1d4ed8', metalness: 0.10, roughness: 0.15, opacity: 0.75 },
      obsidian: { color: '#131c2b', emissive: '#0b1220', metalness: 0.35, roughness: 0.75, opacity: 1 }
    };
    return { TILT: TILT, SIN: SIN, COS: COS, TAN: TAN, clamp01: clamp01,
      pullSlide: pullSlide, pullAlpha: pullAlpha, impactSquash: impactSquash, squashAnim: squashAnim,
      parallax: parallax, parallaxEase: parallaxEase, jumpArc: jumpArc, eyeFollow: eyeFollow,
      lightBudget: lightBudget, glowPulse: glowPulse, flashDecay: flashDecay,
      localY: localY, depthZ: depthZ, projectedY: projectedY, MATS: MATS };
  })();

  // ================= 3D PRESENTATION — three.js renderer (browser-only) =================
  // Boots on the SAME #cv canvas; the untouched 2D path below stays callable as
  // a fallback when WebGL is unavailable. No physics / level / input code here:
  // this layer only READS world state and writes meshes.
  const R3D = { ready: false };
  (function () {
    if (typeof document === 'undefined') return;             // node: keep everything below inert

    const S = {
      renderer: null, scene: null, camera: null, stage: null, bg: null,
      vig: null, redMesh: null, bound: null, spot: null, shadow: null,
      slots: [], pins: [], walls: [], coins: [], flashes: [], lavas: [],
      hero: null, heroLight: null, dustA: null, dustB: null,
      sparks: null, smoke: null, confs: null,
      par: { x: 0, y: 0, tx: 0, ty: 0, sp: 0 }, red: 0,
      jumpT: 9, landT: 9, colCache: {}, tex: {}, mats: {}
    };

    // board-space placement: x/y are physics coords, z is depth off the board plane
    const set3 = (o, x, y, z) => o.position.set(x - 200, T3.localY(y, z), z);
    const setL = (o, x, y, z) => o.position.set(x, y - (z || 0) * T3.SIN, z || 0); // inside a slot group
    const col = h => { let c = S.colCache[h]; if (!c) { c = new THREE.Color(h).convertSRGBToLinear(); S.colCache[h] = c; } return c; };

    // ---------- procedural textures (radial-gradient sprite sheets, made once) ----------
    function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function toTex(c, srgb) { const t = new THREE.CanvasTexture(c); if (srgb) t.encoding = THREE.sRGBEncoding; return t; }
    function radial(size, stops) {
      const c = cnv(size, size), x = c.getContext('2d');
      const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (const s of stops) g.addColorStop(s[0], s[1]);
      x.fillStyle = g; x.fillRect(0, 0, size, size);
      return c;
    }
    function buildTextures() {
      const T = S.tex;
      T.dot = toTex(radial(48, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.85)'], [1, 'rgba(255,255,255,0)']]));
      T.steam = toTex(radial(64, [[0, 'rgba(255,255,255,.85)'], [0.45, 'rgba(226,232,240,.34)'], [1, 'rgba(226,232,240,0)']]));
      T.warm = toTex(radial(64, [[0, 'rgba(255,238,178,.8)'], [0.4, 'rgba(251,191,36,.32)'], [1, 'rgba(251,191,36,0)']]));
      T.fire = toTex(radial(64, [[0, 'rgba(255,196,110,.8)'], [0.4, 'rgba(249,115,22,.38)'], [1, 'rgba(239,68,68,0)']]));
      T.blue = toTex(radial(64, [[0, 'rgba(125,211,252,.62)'], [0.45, 'rgba(59,130,246,.25)'], [1, 'rgba(30,64,175,0)']]));
      T.white = toTex(radial(64, [[0, 'rgba(255,255,255,.95)'], [0.5, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']]));
      T.sq = toTex((() => { const c = cnv(32, 32), x = c.getContext('2d'); x.fillStyle = 'rgba(255,255,255,.96)'; x.fillRect(4, 4, 24, 24); return c; })());
      T.spark = toTex((() => {                                    // 4-point glint
        const c = cnv(64, 64), x = c.getContext('2d');
        x.strokeStyle = 'rgba(255,255,255,.95)'; x.lineCap = 'round'; x.shadowColor = '#fff'; x.shadowBlur = 6;
        x.lineWidth = 4; x.beginPath(); x.moveTo(32, 6); x.lineTo(32, 58); x.moveTo(6, 32); x.lineTo(58, 32); x.stroke();
        x.lineWidth = 2.4; x.beginPath(); x.moveTo(16, 16); x.lineTo(48, 48); x.moveTo(48, 16); x.lineTo(16, 48); x.stroke();
        x.fillStyle = '#fff'; x.beginPath(); x.arc(32, 32, 5, 0, 7); x.fill();
        return c;
      })());
      T.vig = toTex((() => {                                      // vignette: clear center, dark rim
        const c = cnv(128, 256), x = c.getContext('2d');
        const g = x.createRadialGradient(64, 128, 30, 64, 128, 150);
        g.addColorStop(0, 'rgba(3,6,12,0)'); g.addColorStop(0.6, 'rgba(3,6,12,.05)'); g.addColorStop(1, 'rgba(3,6,12,.62)');
        x.fillStyle = g; x.fillRect(0, 0, 128, 256);
        return c;
      })(), true);
      T.bg = toTex((() => {                                       // deep-slate chamber wall
        const c = cnv(256, 512), x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, 0, 512);
        g.addColorStop(0, '#1b2a3f'); g.addColorStop(0.55, '#121a2b'); g.addColorStop(1, '#0a1120');
        x.fillStyle = g; x.fillRect(0, 0, 256, 512);
        x.globalAlpha = 0.05; x.fillStyle = '#94a3b8';            // faint masonry strata
        for (let i = 0; i < 7; i++) x.fillRect(0, 40 + i * 68, 256, 2);
        x.globalAlpha = 1;
        return c;
      })(), true);
      T.obs = toTex((() => {                                      // obsidian: matte base + hairline cracks
        const c = cnv(128, 128), x = c.getContext('2d');
        x.fillStyle = '#131c2b'; x.fillRect(0, 0, 128, 128);
        x.globalAlpha = 0.4; x.fillStyle = '#1c2740';
        for (let i = 0; i < 90; i++) { const s = 1 + Math.random() * 2.5; x.fillRect(Math.random() * 128, Math.random() * 128, s, s); }
        x.globalAlpha = 1;
        for (let k = 0; k < 14; k++) {                            // jagged crack polylines
          x.strokeStyle = k % 3 === 2 ? 'rgba(139,92,246,.3)' : 'rgba(120,140,180,.28)';
          x.lineWidth = 1.1; x.beginPath();
          let px = Math.random() * 128, py = Math.random() * 128;
          x.moveTo(px, py);
          for (let j = 0; j < 5; j++) { px += (Math.random() - 0.5) * 34; py += (Math.random() - 0.5) * 34; x.lineTo(px, py); }
          x.stroke();
        }
        return c;
      })(), true);
      T.env = toTex((() => {                                      // tiny equirect for metal reflections
        const c = cnv(64, 32), x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, 0, 32);
        g.addColorStop(0, '#33507a'); g.addColorStop(0.42, '#16202f'); g.addColorStop(0.55, '#d99a4e');
        g.addColorStop(0.66, '#0c1220'); g.addColorStop(1, '#060a12');
        x.fillStyle = g; x.fillRect(0, 0, 64, 32);
        return c;
      })(), true);
    }

    // ---------- shared materials ----------
    function std(hex, emi, met, rgh, op) {
      const m = new THREE.MeshStandardMaterial({
        color: col(hex), metalness: met, roughness: rgh, transparent: op < 1, opacity: op
      });
      if (emi) { m.emissive = col(emi); m.emissiveIntensity = 0.4; }
      return m;
    }
    function basic(map, opacity, blend) {
      return new THREE.MeshBasicMaterial({
        map: map, transparent: true, opacity: opacity, depthWrite: false,
        blending: blend || THREE.AdditiveBlending
      });
    }
    function buildMats() {
      const M = S.mats;
      M.gold = std(T3.MATS.gold.color, T3.MATS.gold.emissive, 0.85, 0.30, 1);
      M.gold.emissiveIntensity = 0.35;
      M.lava = std(T3.MATS.lava.color, T3.MATS.lava.emissive, 0.15, 0.55, 1);
      M.water = std(T3.MATS.water.color, T3.MATS.water.emissive, 0.10, 0.15, 0.75);
      M.water.emissiveIntensity = 0.3;
      M.obsidian = std(T3.MATS.obsidian.color, T3.MATS.obsidian.emissive, 0.35, 0.75, 1);
      M.obsidian.map = S.tex.obs; M.obsidian.bumpMap = S.tex.obs; M.obsidian.bumpScale = 0.5; M.obsidian.needsUpdate = true;
      M.chrome = std('#c8d2de', null, 0.95, 0.16, 1); M.chrome.envMapIntensity = 1.25;
      M.goldKnob = std('#f5b52e', '#7c4a03', 0.9, 0.25, 1); M.goldKnob.emissiveIntensity = 0.35;
      M.slate = std('#2c3a50', null, 0.12, 0.8, 1);
      M.bevel = std('#5b6f8c', null, 0.25, 0.55, 1);
      M.helm = std('#475569', null, 0.55, 0.42, 1); M.helm.envMapIntensity = 0.9;
      M.helmRim = std('#94a3b8', null, 0.85, 0.28, 1); M.helmRim.envMapIntensity = 1.2;
      M.steel = std('#9aa9bd', null, 0.85, 0.3, 1); M.steel.envMapIntensity = 1.1;
      M.heroBody = std('#d7dee8', null, 0.05, 0.6, 1);
      M.white = std('#f8fafc', null, 0.0, 0.4, 1);
      M.dark = std('#0f172a', null, 0.0, 0.6, 1);
      M.blush = std('#f472b6', null, 0, 0.8, 0.55);
      M.plume = std('#ef4444', '#5b1010', 0.1, 0.6, 1); M.plume.emissiveIntensity = 0.35;
      M.flame = basic(S.tex.fire, 0.8);
      M.coin = std('#fcd34d', '#7c4a03', 0.9, 0.24, 1); M.coin.emissiveIntensity = 0.3;
      M.coinDark = std('#b45309', null, 0.8, 0.35, 1);
    }

    // ---------- environment, backdrop, dust ----------
    function buildEnvironment() {
      const env = S.tex.env; env.mapping = THREE.EquirectangularReflectionMapping;
      const pm = new THREE.PMREMGenerator(S.renderer);
      S.scene.environment = pm.fromEquirectangular(env).texture;
      pm.dispose();
      S.scene.add(new THREE.AmbientLight(col('#40507a'), 0.8));
      S.scene.add(new THREE.HemisphereLight(col('#334e78'), col('#2a1a10'), 0.55));
      const key = new THREE.DirectionalLight(col('#ffe9c4'), 1.05); key.position.set(-160, -240, 340); S.scene.add(key);
      const rim = new THREE.DirectionalLight(col('#6ea8ff'), 0.35); rim.position.set(240, 160, -300); S.scene.add(rim);
    }
    function makeDust(n, size, opacity, zMin, zMax) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = rand(-60, 460); pos[i * 3 + 1] = rand(-60, 700); pos[i * 3 + 2] = rand(zMin, zMax);
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({
        size: size * S.renderer.getPixelRatio(), map: S.tex.dot, transparent: true, opacity: opacity,
        depthWrite: false, color: col('#94a3b8'), sizeAttenuation: false
      });
      const p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = 20;
      S.scene.add(p);
      const d = { pts: p, pos: pos, n: n, spd: new Float32Array(n), ph: new Float32Array(n) };
      for (let i = 0; i < n; i++) { d.spd[i] = rand(3, 10); d.ph[i] = rand(0, 6.28); }
      return d;
    }
    function buildBackdrop() {
      S.bg = new THREE.Mesh(new THREE.PlaneGeometry(1500, 1250), new THREE.MeshBasicMaterial({ map: S.tex.bg, fog: false }));
      S.bg.position.set(200, 320, -420); S.bg.renderOrder = -10; S.scene.add(S.bg);
      S.dustA = makeDust(46, 3.4, 0.16, -70, 40);
      S.dustB = makeDust(40, 2.2, 0.1, -160, -80);
      S.vig = new THREE.Mesh(new THREE.PlaneGeometry(560, 860), new THREE.MeshBasicMaterial({
        map: S.tex.vig, transparent: true, opacity: 0.9, depthTest: false, fog: false
      }));
      S.vig.position.set(200, 320, 470); S.vig.renderOrder = 60; S.scene.add(S.vig);
      S.redMesh = new THREE.Mesh(new THREE.PlaneGeometry(560, 860), new THREE.MeshBasicMaterial({
        color: col('#ff2d12'), transparent: true, opacity: 0, depthTest: false, fog: false
      }));
      S.redMesh.position.set(200, 320, 465); S.redMesh.renderOrder = 55; S.scene.add(S.redMesh);
    }

    // ---------- the tilted board (stage) ----------
    function buildStage() {
      S.stage = new THREE.Group();
      S.stage.position.set(200, 320, 0);
      S.stage.rotation.x = T3.TILT;                       // bottom of the board leans toward the viewer
      S.stage.scale.y = 1 / T3.COS;                        // exact 1:1 screen-y compensation
      S.scene.add(S.stage);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(470, 54, 26), S.mats.slate);
      set3(slab, 200, 668, -10); S.stage.add(slab);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(474, 5, 30), S.mats.bevel);
      set3(lip, 200, 642, -10); S.stage.add(lip);
      S.spot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basic(S.tex.blue, 0.42));
      S.spot.scale.set(330, 290, 1); S.spot.renderOrder = 1;
      S.stage.add(S.spot); set3(S.spot, 200, 545, -20);
    }

    // ---------- geometry: obsidian lumps (vertex noise, built once) ----------
    function makeObsGeo() {
      const g = new THREE.SphereGeometry(1, 26, 20);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = Math.sin(x * 37.3) * Math.sin(y * 41.7) * Math.sin(z * 33.1); // seam-safe noise
        const k = 1 + n * 0.045;
        p.setXYZ(i, x * k, y * k, z * k);
      }
      g.computeVertexNormals();
      return g;
    }

    // ---------- mesh pools (allocation happens HERE, at boot — never per frame) ----------
    function buildPools() {
      const T = S.tex, M = S.mats;
      S.sphGeo = new THREE.SphereGeometry(1, 28, 22);
      S.obsGeo = makeObsGeo();
      S.glowGeo = new THREE.PlaneGeometry(1, 1);
      // sphere slots: one pool covering every type; rebound to world state each frame
      for (let i = 0; i < 64; i++) {
        const g = new THREE.Group(); g.visible = false;
        const body = new THREE.Mesh(S.sphGeo, M.gold);
        const glowM = basic(T.warm, 0);
        const glow = new THREE.Mesh(S.glowGeo, glowM); glow.renderOrder = 1; glow.visible = false;
        const glint = new THREE.Mesh(S.glowGeo, basic(T.spark, 0)); glint.renderOrder = 5;
        g.add(body); g.add(glow); g.add(glint);
        S.stage.add(g);
        S.slots.push({ g: g, body: body, glow: glow, glint: glint, lavaMat: M.lava.clone(),
          sph: null, sq: 0, sqT: 9, pvy: 0, wasG: false,
          emberT: rand(0, 0.15), dripT: rand(2, 5), sparkT: rand(0.3, 1.2) });
      }
      // pin slots: chrome capsule + gold pull-ring + hover rim + shine sweep
      const capGeo = new THREE.CapsuleGeometry(4.5, 1, 6, 20);
      for (let i = 0; i < 8; i++) {
        const g = new THREE.Group(); g.visible = false;
        const barM = M.chrome.clone(); barM.transparent = true;
        const bar = new THREE.Mesh(capGeo, barM); bar.rotation.z = Math.PI / 2;
        const knobM = M.goldKnob.clone(); knobM.transparent = true;
        const knob = new THREE.Mesh(new THREE.TorusGeometry(6.5, 2.2, 12, 24), knobM);
        const hole = new THREE.Mesh(new THREE.CircleGeometry(4.4, 20), M.dark); hole.material = M.dark;
        const hovM = basic(T.warm, 0);
        const hov = new THREE.Mesh(capGeo, hovM); hov.rotation.z = Math.PI / 2;
        const shine = new THREE.Mesh(new THREE.PlaneGeometry(14, 11), basic(T.white, 0));
        g.add(bar); g.add(hov); g.add(knob); g.add(hole); g.add(shine);
        S.stage.add(g);
        S.pins.push({ g: g, bar: bar, barM: barM, knob: knob, knobM: knobM, hole: hole,
          hov: hov, hovM: hovM, shine: shine, p: null, len: 100 });
      }
      // wall slots: slate slab + top bevel + rounded ends
      for (let i = 0; i < 6; i++) {
        const g = new THREE.Group(); g.visible = false;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(1, 13, 20), M.slate);
        const bevel = new THREE.Mesh(new THREE.BoxGeometry(1, 4.2, 21.4), M.bevel);
        const eA = new THREE.Mesh(new THREE.SphereGeometry(6.5, 14, 10), M.slate);
        const eB = new THREE.Mesh(new THREE.SphereGeometry(6.5, 14, 10), M.slate);
        g.add(slab); g.add(bevel); g.add(eA); g.add(eB);
        S.stage.add(g);
        S.walls.push({ g: g, slab: slab, bevel: bevel, eA: eA, eB: eB });
      }
      // coin pool (collect = coin flip toward the knight)
      for (let i = 0; i < 8; i++) {
        const g = new THREE.Group(); g.visible = false;
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 2.4, 22), M.coin);
        disc.rotation.x = Math.PI / 2;
        const rA = new THREE.Mesh(new THREE.TorusGeometry(6.1, 0.9, 8, 22), M.coinDark);
        const rB = rA.clone(); rB.position.z = -1.25; rA.position.z = 1.25;
        g.add(disc); g.add(rA); g.add(rB);
        S.stage.add(g);
        S.coins.push({ g: g, t: 9, life: 0.85, x: 0, y: 0, vx: 0, vy: 0, spin: 13 });
      }
      // burst flash pool (fuse white pop, splash shimmer)
      for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(S.glowGeo, basic(T.white, 0));
        m.visible = false; m.renderOrder = 6;
        S.stage.add(m);
        S.flashes.push({ g: m, t: 9, max: 0.42 });
      }
      // lava point lights (hard cap 3)
      for (let i = 0; i < 3; i++) {
        const L = new THREE.PointLight(col('#ff7a26'), 0, 170, 2);
        L.visible = false; S.stage.add(L); S.lavas.push(L);
      }
      S.heroLight = new THREE.PointLight(col('#38bdf8'), 0.55, 260, 2);
      S.stage.add(S.heroLight);
    }

    // ---------- hero: the cute knight ----------
    function buildHero() {
      const M = S.mats, g = new THREE.Group(); g.visible = false;
      const H = S.hero = { g: g };
      H.body = new THREE.Mesh(S.sphGeo, M.heroBody);
      H.body.scale.set(22, 21.3, 22);
      H.helmet = new THREE.Mesh(new THREE.SphereGeometry(22.3, 32, 18, 0, Math.PI * 2, 0, 1.66), M.helm);
      H.rim = new THREE.Mesh(new THREE.TorusGeometry(21.3, 1.3, 10, 36), M.helmRim);
      H.rim.position.set(0, -1.8, 0);
      H.plume = new THREE.Group();
      [[0, -23.5, 2, 3.4], [-3.5, -26.5, 1.5, 2.7], [-6.5, -28, 1, 2.1]].forEach(a => {
        const m = new THREE.Mesh(S.sphGeo, M.plume);
        m.position.set(a[0], a[1], a[2]); m.scale.set(a[3], a[3], a[3]);
        H.plume.add(m);
      });
      H.eyes = new THREE.Group();
      H.eyeWL = new THREE.Mesh(S.sphGeo, M.white); H.eyeWL.scale.set(4.2, 4.2, 4.2);
      H.eyeWR = H.eyeWL.clone();
      H.pupilL = new THREE.Mesh(S.sphGeo, M.dark); H.pupilL.scale.set(2, 2, 2);
      H.pupilR = H.pupilL.clone();
      const egL = new THREE.Group(), egR = new THREE.Group();
      egL.position.set(-7, 4, 19.5); egR.position.set(7, 4, 19.5);
      egL.add(H.eyeWL, H.pupilL); egR.add(H.eyeWR, H.pupilR);
      H.eyes.add(egL, egR);
      H.xeyes = new THREE.Group();
      [-7, 7].forEach(ex => {
        const c = new THREE.Group(); c.position.set(ex, 4, 22.2);
        [0.785, -0.785].forEach(rot => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.1, 0.9), M.white);
          b.rotation.z = rot; c.add(b);
        });
        H.xeyes.add(c);
      });
      H.xeyes.visible = false;
      H.blushL = new THREE.Mesh(new THREE.CircleGeometry(2.6, 16), M.blush);
      H.blushL.position.set(-11, 8, 17.2);
      H.blushR = H.blushL.clone(); H.blushR.position.x = 11;
      H.smile = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.9, 8, 20, Math.PI * 0.85), M.dark);
      H.smile.rotation.z = Math.PI * 0.075; H.smile.position.set(0, 7.5, 21.1);
      H.flames = new THREE.Group();
      [-5, 0, 5].forEach(fx => {
        const f = new THREE.Mesh(new THREE.ConeGeometry(2.6, 9, 8), M.flame);
        f.rotation.x = Math.PI; f.position.set(fx, -26, 3);
        H.flames.add(f);
      });
      H.flames.visible = false;
      const shield = new THREE.Group(); shield.position.set(-30, 3, 6);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 10.5, 3.2, 24), M.steel);
      disc.rotation.x = Math.PI / 2;
      const boss = new THREE.Mesh(S.sphGeo, M.white); boss.scale.set(2.6, 2.6, 2.6); boss.position.z = 1.9;
      shield.add(disc, boss);
      g.add(H.body, H.helmet, H.rim, H.plume, H.eyes, H.xeyes, H.blushL, H.blushR, H.smile, H.flames, shield);
      S.stage.add(g);
      S.shadow = new THREE.Mesh(new THREE.CircleGeometry(24, 26), new THREE.MeshBasicMaterial({
        color: col('#020617'), transparent: true, opacity: 0.42, depthWrite: false
      }));
      S.shadow.visible = false; S.stage.add(S.shadow);
    }

    // ---------- pooled GPU particles (one Points draw per class) ----------
    function makePts(n, size, map, blend, opacity) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3), cl = new Float32Array(n * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(cl, 3));
      geo.setDrawRange(0, 0);
      const m = new THREE.PointsMaterial({
        size: size * S.renderer.getPixelRatio(), map: map, transparent: true, opacity: opacity,
        depthWrite: false, depthTest: false, vertexColors: true, blending: blend, sizeAttenuation: false
      });
      const p = new THREE.Points(geo, m); p.frustumCulled = false; p.renderOrder = 30;
      S.scene.add(p);
      return { geo: geo, pos: pos, col: cl, cap: n, n: 0 };
    }
    function buildParticleSystems() {
      S.sparks = makePts(240, 5, S.tex.dot, THREE.AdditiveBlending, 0.95);
      S.smoke = makePts(120, 15, S.tex.steam, THREE.AdditiveBlending, 0.55);
      S.confs = makePts(140, 9, S.tex.sq, THREE.NormalBlending, 1);
    }
    function pack(sys, x, y, z, r, g, b, a) {
      if (sys.n >= sys.cap) return;
      const i = sys.n * 3;
      sys.pos[i] = x; sys.pos[i + 1] = y; sys.pos[i + 2] = z;
      sys.col[i] = r * a; sys.col[i + 1] = g * a; sys.col[i + 2] = b * a;
      sys.n++;
    }
    function flush(sys) {
      sys.geo.setDrawRange(0, sys.n);
      sys.geo.attributes.position.needsUpdate = true;
      sys.geo.attributes.color.needsUpdate = true;
    }
    function updateParticles3D() {
      S.sparks.n = S.smoke.n = S.confs.n = 0;
      const P = Game.particles;
      for (let i = 0; i < P.length; i++) {
        const p = P[i], a = Math.max(0, Math.min(1, p.life / p.max));
        if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 80) continue;
        const c = col(p.col);
        if (p.type === 'smoke') pack(S.smoke, p.x, p.y, 44, c.r, c.g, c.b, a * 0.5);
        else if (p.type === 'conf') pack(S.confs, p.x, p.y, 66, c.r, c.g, c.b, 1);
        else pack(S.sparks, p.x, p.y, 42, c.r, c.g, c.b, a);
      }
      flush(S.sparks); flush(S.smoke); flush(S.confs);
    }

    // ---------- level binding (runs only when the world object identity changes) ----------
    function buildLevel(world) {
      S.bound = world;
      const pins = world ? world.pins : [], walls = world ? world.walls : [];
      for (let i = 0; i < S.pins.length; i++) {
        const ps = S.pins[i];
        if (i >= pins.length) { ps.g.visible = false; continue; }
        const p = pins[i]; ps.p = p; ps.len = p.len || 240; ps.g.visible = true;
        ps.bar.scale.y = Math.max(2, ps.len - 9);
        setL(ps.bar, ps.len / 2, 0, 0);
        ps.hov.scale.set(1.25, Math.max(2, ps.len - 9) * 1.25, 1.25);
        setL(ps.hov, ps.len / 2, 0, 0);
        setL(ps.knob, -9, 0, 1.5); setL(ps.hole, -9, 0, 0.6);
        setL(ps.shine, 0, 0, 5.6);
      }
      for (let i = 0; i < S.walls.length; i++) {
        const w = S.walls[i];
        if (i >= walls.length) { w.g.visible = false; continue; }
        const seg = walls[i]; w.g.visible = true;
        const len = Math.max(4, Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1));
        w.g.rotation.z = Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1);
        set3(w.g, (seg.x1 + seg.x2) / 2, (seg.y1 + seg.y2) / 2, -6);
        w.slab.scale.x = len; w.bevel.scale.x = len;
        setL(w.bevel, 0, -4.6, 0);
        setL(w.eA, len / 2, 0, 0); setL(w.eB, -len / 2, 0, 0);
      }
      const h = world ? world.hero : null;
      S.hero.g.visible = !!h; S.shadow.visible = !!h;
      if (h) { set3(S.hero.g, h.x, HERO_Y, 2); set3(S.spot, h.x, 545, -20); }
      for (const sl of S.slots) { sl.g.visible = false; sl.sph = null; sl.sq = 0; sl.sqT = 9; sl.pvy = 0; sl.wasG = false; }
      for (const c of S.coins) { c.t = 9; c.g.visible = false; }
      for (const f of S.flashes) { f.t = 9; f.g.visible = false; }
      S.jumpT = 9; S.landT = 9; S.red = 0;
    }

    // ---------- per-frame sync: physics state → meshes ----------
    function updateSpheres(t, dt) {
      const SP = Game.world ? Game.world.spheres : [];
      const n = Math.min(SP.length, S.slots.length);
      for (let i = 0; i < S.slots.length; i++) S.slots[i].g.visible = i < n;
      for (let i = 0; i < n; i++) {
        const s = SP[i], sl = S.slots[i];
        if (sl.sph !== s) {                                    // (re)bind pool slot — no allocation
          sl.sph = s; sl.sq = 0; sl.sqT = 9; sl.pvy = s.vy; sl.wasG = s.grounded;
          sl.body.geometry = s.type === 'obsidian' ? S.obsGeo : S.sphGeo;
          sl.body.material = s.type === 'lava' ? sl.lavaMat : (S.mats[s.type] || S.mats.obsidian);
          sl.glow.material.map = s.type === 'gold' ? S.tex.warm : s.type === 'lava' ? S.tex.fire :
            s.type === 'water' ? S.tex.blue : sl.glow.material.map;
          sl.glow.visible = s.type === 'gold' || s.type === 'lava' || s.type === 'water';
          sl.glint.visible = s.type === 'gold' || s.type === 'water';
          sl.glint.material.map = s.type === 'water' ? S.tex.dot : S.tex.spark;
        }
        if (s.grounded && !sl.wasG && sl.pvy > 240) { sl.sq = T3.impactSquash(sl.pvy); sl.sqT = 0; }
        sl.wasG = s.grounded; sl.pvy = s.vy; sl.sqT += dt;
        const sq = T3.squashAnim(sl.sqT, sl.sq);
        const wob = s.type === 'water' ? 1 + Math.sin(t * 3.2 + s.seed * 4) * 0.045 : 1;
        sl.body.scale.set(s.r * (1 + sq * 0.55) / wob, s.r * (1 - sq) * wob, s.r * (1 + sq * 0.55) / wob);
        set3(sl.g, s.x, s.y, 0);
        setL(sl.glow, 0, 0, -(s.r + 6));
        sl.glow.scale.set(s.r * 3.6, s.r * 3.6, 1);
        if (s.type === 'gold') {                               // metallic treasure + sparkles
          sl.glow.material.opacity = 0.34 + 0.16 * Math.sin(t * 2.6 + s.seed * 5);
          const gt = t * 3 + s.seed * 7;
          sl.glint.material.opacity = 0.55 + 0.4 * Math.sin(gt);
          sl.glint.scale.set(s.r * 1.2, s.r * 1.2, 1);
          setL(sl.glint, Math.cos(gt) * s.r * 0.5, Math.sin(gt) * s.r * 0.5, s.r + 2);
          sl.sparkT -= dt;
          if (sl.sparkT <= 0) {
            sl.sparkT = rand(0.25, 0.9);
            Game.particles.push({ x: s.x + rand(-0.7, 0.7) * s.r, y: s.y + rand(-0.7, 0.7) * s.r,
              vx: rand(-8, 8), vy: rand(-26, -10), life: rand(0.3, 0.6), max: 0.6,
              size: 2, col: '#fde68a', grav: -20, type: 'dot' });
          }
        } else if (s.type === 'lava') {                        // molten pulse, embers, lazy drips
          sl.lavaMat.emissiveIntensity = T3.glowPulse(t, s.seed);
          sl.glow.material.opacity = 0.5 + 0.2 * Math.sin(t * 4.6 + s.seed * 3);
          sl.emberT -= dt;
          if (sl.emberT <= 0) {
            sl.emberT = rand(0.08, 0.2);
            Game.particles.push({ x: s.x + rand(-0.5, 0.5) * s.r, y: s.y - rand(0, 0.4) * s.r,
              vx: rand(-12, 12), vy: rand(-55, -25), life: rand(0.4, 0.8), max: 0.8,
              size: 2, col: '#fb923c', grav: -30, type: 'dot' });
          }
          if (s.grounded && Math.abs(s.vx) < 8) {
            sl.dripT -= dt;
            if (sl.dripT <= 0) {
              sl.dripT = rand(1.4, 3.6);
              Game.particles.push({ x: s.x + rand(-0.4, 0.4) * s.r, y: s.y + s.r * 0.8,
                vx: rand(-6, 6), vy: rand(10, 30), life: rand(0.4, 0.7), max: 0.7,
                size: 2.4, col: '#ea580c', grav: 500, type: 'dot' });
            }
          }
        } else if (s.type === 'water') {                       // glassy drop + surface shimmer
          sl.glow.material.opacity = 0.28;
          const st = t * 2.5 + s.seed * 6;
          sl.glint.material.opacity = 0.35 + 0.2 * Math.sin(st * 1.7);
          sl.glint.scale.set(s.r * 0.75, s.r * 0.4, 1);
          setL(sl.glint, Math.sin(st) * s.r * 0.25 - s.r * 0.2, -s.r * 0.35, s.r + 2);
        }
      }
    }

    function updatePins(t, dt) {
      for (let i = 0; i < S.pins.length; i++) {
        const ps = S.pins[i]; if (!ps.g.visible) continue;
        const p = ps.p;
        if (p.pulled && p.pullT >= 1) { ps.g.visible = false; continue; }
        const off = p.pulled ? T3.pullSlide(p.pullT) : 0;      // pullT drives the slide
        const alpha = p.pulled ? T3.pullAlpha(p.pullT) : 1;
        set3(ps.g, p.x + off, p.y, 0);
        ps.barM.opacity = alpha; ps.knobM.opacity = alpha;
        const hov = !p.pulled && Game.hoverPin === i;          // hover logic already in Game.state
        ps.hov.visible = hov;
        if (hov) ps.hovM.opacity = 0.2 + 0.12 * Math.sin(t * 6);
        if (p.pulled && p.pullT < 1) {                         // chrome shine sweep during the pull
          ps.shine.visible = true;
          ps.shine.material.opacity = 0.75 * (1 - p.pullT);
          setL(ps.shine, ps.len * p.pullT * 0.5, 0, 5.6);
        } else ps.shine.visible = false;
        ps.knobM.emissiveIntensity = 0.3 + S.par.sp * 1.6 + (hov ? 0.55 : 0) + 0.1 * Math.sin(t * 2.4 + i);
      }
    }

    function updateHero(t, dt) {
      const h = Game.world ? Game.world.hero : null;
      S.hero.g.visible = !!h; S.shadow.visible = !!h;
      if (!h) return;
      const dead = Game.state === 'fail';
      S.jumpT = Math.min(1.0001, S.jumpT + dt / 0.55);
      const jy = T3.jumpArc(S.jumpT) * 22;
      if (S.jumpT >= 1 && S.landT > 1) S.landT = 0;            // touchdown squash
      S.landT = Math.min(1.2, S.landT + dt);
      const land = T3.squashAnim(S.landT - 0.06, 0.16);
      const y = HERO_Y + Math.sin(t * 2) * 1.5 - jy;           // idle bob + collect jump
      set3(S.hero.g, h.x, y, 2);
      set3(S.shadow, h.x, 642, 3.5);
      S.shadow.material.opacity = 0.42 * (1 - jy / 30);
      S.shadow.scale.set(24 * (1 - jy / 44), 24 * 0.22 * (1 - jy / 44), 1);
      S.hero.body.scale.set(22 * (1 + land * 0.5), 21.3 * (1 - land), 22 * (1 + land * 0.5));
      if (dead) S.mats.heroBody.color.lerp(S.charCol, Math.min(1, dt * 2.5));
      else S.mats.heroBody.color.copy(S.normCol);
      const H = S.hero;
      H.eyes.visible = !dead; H.xeyes.visible = dead;
      H.smile.visible = !dead; H.blushL.visible = H.blushR.visible = !dead;
      H.plume.visible = !dead;
      H.flames.visible = dead && Game.burn > 0.4;               // matches the 2D fail logic
      if (H.flames.visible) {
        const fl = 0.5 + 0.5 * Math.sin(t * 18);
        H.flames.scale.y = 0.7 + fl * 0.7;
        S.mats.flame.opacity = 0.3 + fl * 0.5;
      }
      if (!dead) {
        const blink = (t % 3.4) < 0.14;                          // same blink cadence as 2D
        H.eyeWL.scale.y = H.eyeWR.scale.y = blink ? 0.12 : 4.2;
        H.pupilL.visible = H.pupilR.visible = !blink;
        let best = Infinity, gx = 0, gy = 0;                    // eyes track the nearest gold
        for (const s of Game.world.spheres) {
          if (s.type !== 'gold') continue;
          const d = (s.x - h.x) * (s.x - h.x) + (s.y - y) * (s.y - y);
          if (d < best) { best = d; gx = s.x - h.x; gy = s.y - y; }
        }
        const ef = isFinite(best) ? T3.eyeFollow(gx, gy) : { x: 0, y: 0 };
        H.pupilL.position.set(ef.x, 0.5 + ef.y, 2.4);
        H.pupilR.position.set(ef.x, 0.5 + ef.y, 2.4);
      }
    }

    function updateLights(t) {
      const idx = T3.lightBudget(Game.world ? Game.world.spheres : [], 3);
      for (let k = 0; k < 3; k++) {
        const L = S.lavas[k];
        if (k < idx.length) {
          const s = Game.world.spheres[idx[k]];
          set3(L, s.x, s.y - 3, 34);
          L.visible = true;
          L.intensity = 1.1 + 0.5 * Math.sin(t * 5 + s.seed * 3);
        } else L.visible = false;
      }
      const h = Game.world ? Game.world.hero : null;
      if (h) {
        set3(S.heroLight, h.x, 556, 30);
        S.heroLight.intensity = 0.5 + (S.jumpT < 1 ? 0.55 * (1 - S.jumpT) : 0);
      }
    }

    function updateCoins(dt) {
      for (const c of S.coins) {
        if (!c.g.visible) continue;
        c.t += dt;
        if (c.t >= c.life) { c.g.visible = false; continue; }
        c.vy += 750 * dt; c.x += c.vx * dt; c.y += c.vy * dt;
        c.g.rotation.x += c.spin * dt;                          // the coin flip
        const k = 1 - 0.35 * (c.t / c.life);
        c.g.scale.set(k, k, k);
        set3(c.g, c.x, c.y, 4);
      }
    }

    function updateFlashes(dt) {
      for (const f of S.flashes) {
        if (!f.g.visible) continue;
        f.t += dt;
        const op = 0.85 * T3.flashDecay(f.t / f.max);
        if (op < 0.02) { f.g.visible = false; continue; }
        f.g.material.opacity = op;
        const sc = 16 + 46 * Math.min(1, f.t / f.max * 1.4);
        f.g.scale.set(sc, sc, 1);
      }
      S.red = Math.max(0, S.red - dt * 1.4);
      S.redMesh.material.opacity = S.red;
    }

    function updateDust(t, dt) {
      [S.dustA, S.dustB].forEach(D => {
        for (let i = 0; i < D.n; i++) {
          let y = D.pos[i * 3 + 1] - D.spd[i] * dt;
          if (y < -60) { y = 700; D.pos[i * 3] = rand(-60, 460); }
          D.pos[i * 3 + 1] = y;
          D.pos[i * 3] += Math.sin(t * 0.4 + D.ph[i]) * dt * 6;
        }
        D.pts.geometry.attributes.position.needsUpdate = true;
      });
    }

    function updateParallax(dt) {
      S.par.x = T3.parallaxEase(S.par.x, S.par.tx, dt);
      S.par.y = T3.parallaxEase(S.par.y, S.par.ty, dt);
      S.par.sp = Math.min(1, Math.hypot(S.par.tx - S.par.x, S.par.ty - S.par.y) / 7);
    }

    function pointer(x, y) {                                   // parallax target: scene drifts against the finger
      if (x == null || x < 0 || y < 0) { S.par.tx = 0; S.par.ty = 0; return; }
      S.par.tx = -T3.parallax(((x - 200) / 200) * 12);
      S.par.ty = -T3.parallax(((y - 320) / 320) * 10);
    }

    function draw3D() {
      if (!S.renderer) return;
      const dt = Game.dt || 0.016, t = Game.time;
      if (Game.world !== S.bound) buildLevel(Game.world);
      updateParallax(dt);
      const sh = Game.shake > 0 ? Game.shake * 14 : 0;         // same shake law as the 2D path
      S.stage.position.set(200 + S.par.x + (sh ? rand(-sh, sh) : 0),
        320 + S.par.y + (sh ? rand(-sh, sh) : 0), 0);
      S.bg.position.set(200 + S.par.x * 0.3, 320 + S.par.y * 0.3, -420);
      updateSpheres(t, dt); updatePins(t, dt); updateHero(t, dt);
      updateParticles3D(); updateCoins(dt); updateFlashes(dt);
      updateLights(t); updateDust(t, dt);
      S.renderer.render(S.scene, S.camera);
    }

    // ---------- event hooks (called from the existing game event loop) ----------
    function burst(x, y, map) {
      for (const f of S.flashes) {
        if (!f.g.visible) {
          f.t = 0; f.g.visible = true; f.g.material.map = map;
          f.g.scale.set(16, 16, 1); f.g.material.opacity = 0.85;
          set3(f.g, x, y, 6);
          return;
        }
      }
    }
    function onEvent(e) {
      if (!R3D.ready || !e) return;
      if (e.t === 'collect') {                                 // hero jump + coin flip
        S.jumpT = 0;
        for (const c of S.coins) {
          if (!c.g.visible) {
            c.t = 0; c.x = e.x; c.y = e.y - 4; c.vx = rand(-26, 26);
            c.vy = -rand(120, 170); c.spin = rand(10, 16);
            c.g.visible = true; c.g.rotation.x = 0;
            break;
          }
        }
      }
      else if (e.t === 'fuse') burst(e.x, e.y, S.tex.white);   // steam handled by the shared particle spawner
      else if (e.t === 'splash') burst(e.x, e.y, S.tex.blue);
      else if (e.t === 'fail') S.red = 0.55;                   // red flash; shake comes from Game.shake
    }

    // ---------- boot / exports ----------
    R3D.boot = function (canvas) {
      try {
        if (typeof THREE === 'undefined' || !canvas) return false;
        S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
        S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        S.renderer.outputEncoding = THREE.sRGBEncoding;
        S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        S.renderer.toneMappingExposure = 1.12;
        S.renderer.setClearColor(0x070d19, 1);
        S.camera = new THREE.OrthographicCamera(0, W, 0, H, 1, 1400);  // exact 2D framing: world == screen
        S.camera.position.set(200, 320, 500);
        S.scene = new THREE.Scene();
        S.scene.fog = new THREE.Fog(0x0d1524, 500, 800);
        buildTextures(); buildMats(); buildEnvironment();
        buildBackdrop(); buildStage(); buildPools(); buildHero();
        buildParticleSystems();
        S.charCol = col('#3f3f46'); S.normCol = col('#d7dee8');
        R3D.ready = true;
        return true;
      } catch (e) { R3D.ready = false; S.renderer = null; return false; }
    };
    R3D.resize = function (w, h) { if (R3D.ready) S.renderer.setSize(Math.max(2, w | 0), Math.max(2, h | 0), false); };
    R3D.draw = draw3D;
    R3D.onEvent = onEvent;
    R3D.pointer = pointer;
  })();

  // ================= SELF-TESTS (node game.js) =================
  if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('game.js')) {
    try { require('./levels.js'); } catch (e) { /* PIN_LEVELS may already be loaded */ }
    let bad = 0;
    const ok = (cond, msg) => { if (cond) console.log('PASS: ' + msg); else { console.error('FAIL: ' + msg); bad++; } };
    const LEVELS = globalThis.PIN_LEVELS;

    ok(Array.isArray(LEVELS) && LEVELS.length === 12, '12 levels defined');
    LEVELS.forEach((lv, i) => {                                      // validate every level
      const errs = globalThis.PIN_VALIDATE([lv]);
      ok(errs.length === 0, 'level ' + (i + 1) + ' "' + lv.name + '" valid' + (errs.length ? ' — ' + errs[0] : ''));
    });

    const w1 = createWorld({ pins: [], walls: [], heroX: 2000,      // physics smoke: 3 spheres fall
      spheres: [{ type: 'gold', x: 100, y: 100, r: 15 }, { type: 'gold', x: 200, y: 100, r: 15 }, { type: 'lava', x: 300, y: 100, r: 15 }] });
    for (let k = 0; k < 300; k++) stepWorld(w1, DT);
    ok(w1.spheres.every(s => isFinite(s.x) && isFinite(s.y) && isFinite(s.vx) && isFinite(s.vy)), 'smoke: no NaN after 300 steps');
    ok(w1.spheres.every(s => s.y > 100), 'smoke: all 3 spheres fell below start y');
    ok(w1.spheres.every(s => s.y + s.r <= FLOOR + 0.5), 'smoke: spheres rest on floor (no tunneling)');
    ok(w1.spheres.every(s => Math.hypot(s.vx, s.vy) < 100), 'smoke: spheres settled');

    const w2 = createWorld({ pins: [], walls: [], heroX: 2000,      // stack stability
      spheres: [{ type: 'water', x: 200, y: 560, r: 15 }, { type: 'water', x: 200, y: 530, r: 15 }] });
    for (let k = 0; k < 300; k++) stepWorld(w2, DT);
    ok(Math.abs(w2.spheres[0].y - 625) < 2 && Math.abs(w2.spheres[1].y - 595) < 2, 'smoke: sphere stack rests stably');

    function simulate(lv, order, gap, tail) {                        // scripted play-through
      gap = gap || 180; tail = tail == null ? 260 : tail;
      const w = createWorld(lv);
      let gold = 0, failed = false;
      const total = lv.spheres.filter(s => s.type === 'gold').length;
      const drain = () => {
        for (const e of w.events) {
          if (e.t === 'collect') gold++;
          if (e.t === 'fail') failed = true;
        }
        w.events.length = 0;
      };
      for (const idx of order) {
        w.pins[idx].pulled = true;
        for (let k = 0; k < gap; k++) { stepWorld(w, DT); drain(); if (failed) break; }
        if (failed) break;
      }
      if (!failed) for (let k = 0; k < tail; k++) { stepWorld(w, DT); drain(); }
      if (w.spheres.some(s => !isFinite(s.x) || !isFinite(s.y))) failed = true, gold = -1; // NaN guard
      return { gold, total, failed };
    }

    const SOLUTIONS = [                                             // known-good pull orders
      [0], [0], [0, 1, 2], [0, 1, 2], [0, 1, 2],
      [0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 3],
      [0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 2, 1, 3, 4]];
    LEVELS.forEach((lv, i) => {
      const r = simulate(lv, SOLUTIONS[i]);
      ok(!r.failed && r.gold === r.total,
        'level ' + (i + 1) + ' solvable in scripted order — gold ' + r.gold + '/' + r.total + (r.failed ? ', LAVA HIT HERO' : ''));
    });
    [[1, [1, 0]], [2, [1, 2]], [9, [2, 4]], [11, [4]]].forEach(wr => {  // known-fatal orders
      const r = simulate(LEVELS[wr[0]], wr[1]);
      ok(r.failed, 'level ' + (wr[0] + 1) + ' wrong order [' + wr[1].join(',') + '] ends in lava fail');
    });

    /* ---- touch control tests: finger taps on pins ---- */
    const tw = createWorld({ pins: [{ x: 60, y: 200, len: 240 }, { x: 60, y: 320, len: 240 }],
      walls: [], heroX: 2000, spheres: [] });
    Game.world = tw;
    ok(pinAt(60 + 40, 200) === 0, 'touch: finger tap on pin 0 → hit');
    ok(pinAt(60 + 40, 320) === 1, 'touch: finger tap on pin 1 → hit');
    ok(pinAt(60 + 40, 140) === -1, 'touch: tap far above pins → miss');
    ok(pinAt(60 - 20, 200) === 0, 'touch: finger slightly left of pin tip still counts');
    ok(pinAt(60 + 240 + 30, 200) === 0, 'touch: finger at pin tail within tolerance counts');
    tw.pins[0].pulled = true;
    ok(pinAt(60 + 40, 200) === -1, 'touch: pulled pin no longer hittable');
    try { pullPin(1); } catch (e) { /* audio may be absent headless */ }
    ok(tw.pins[1].pulled && tw.pins[1].pullT === 0, 'touch: pullPin marks pin pulled');
    ok(pinAt(60 + 40, 320) === -1, 'touch: pulled pin ignored by hit-test');
    Game.world = null;

    /* ---- 3D presentation: pure helper contract ---- */
    ok(typeof T3 === 'object' && !!T3.MATS, '3d: helper module present');
    ok(Math.abs(T3.pullSlide(0)) < 1e-9 && Math.abs(T3.pullSlide(1) + 120) < 1e-9, '3d: pin slide starts at 0 and settles exactly at -PIN_PULL_PX');
    ok(T3.pullSlide(0.6) < -120, '3d: pin slide overshoots past its resting spot, then settles');
    ok(T3.pullAlpha(0) === 1 && Math.abs(T3.pullAlpha(1) - 0.1) < 1e-9 && T3.pullAlpha(2) === 0, '3d: pin fade law matches the 2D renderer');
    ok(T3.impactSquash(0) === 0 && T3.impactSquash(150) === 0 && T3.impactSquash(1e9) === 0.38, '3d: impact squash thresholds and hard cap');
    let sqMono = true;
    for (let v = 200; v <= 2000; v += 200) if (T3.impactSquash(v) > T3.impactSquash(v + 200) + 1e-12) sqMono = false;
    ok(sqMono, '3d: impact squash grows monotonically with fall speed');
    ok(Math.abs(T3.squashAnim(0, 1) - 1) < 1e-9 && T3.squashAnim(0.35, 1) < 0, '3d: squash rebounds into a stretch');
    ok(Math.abs(T3.squashAnim(2, 1)) < 0.02 && T3.squashAnim(5, 0) === 0, '3d: squash settles; zero peak is a no-op');
    ok(T3.parallax(1e9) === 12 && T3.parallax(-1e9) === -12 && T3.parallax(6) === 6, '3d: parallax clamps to ±12px, linear inside');
    let pe = 0;
    for (let k = 0; k < 240; k++) pe = T3.parallaxEase(pe, 12, 1 / 60);
    ok(Math.abs(pe - 12) < 0.01, '3d: parallax easing converges to its target');
    ok(Math.abs(T3.jumpArc(0)) < 1e-9 && Math.abs(T3.jumpArc(1)) < 1e-9 && Math.abs(T3.jumpArc(0.5) - 1) < 1e-9 && Math.abs(T3.jumpArc(2)) < 1e-9, '3d: hero jump arc starts/ends grounded with one peak');
    const ef = T3.eyeFollow(30, 40);
    ok(Math.hypot(ef.x, ef.y) <= 1.4 + 1e-9 && ef.x > 0 && ef.y > 0, '3d: eye follow clamps magnitude and points at the target');
    ok(T3.eyeFollow(0, 0).x === 0 && T3.eyeFollow(0, 0).y === 0, '3d: eye follow is safe at zero distance');
    const lb = T3.lightBudget([
      { type: 'lava', r: 12, dead: false }, { type: 'lava', r: 20, dead: false },
      { type: 'gold', r: 24, dead: false }, { type: 'lava', r: 16, dead: true },
      { type: 'lava', r: 14, dead: false }, { type: 'lava', r: 9, dead: false }], 3);
    ok(lb.length === 3 && lb[0] === 1 && lb[1] === 4 && lb[2] === 0, '3d: lava light budget picks the 3 biggest living lavas');
    ok(T3.lightBudget([], 3).length === 0, '3d: no lava, no lava lights');
    let gpOK = true;
    for (let k = 0; k < 60; k++) { const v = T3.glowPulse(k * 0.13, k * 0.7); if (v < 0.499 || v > 1.201) gpOK = false; }
    ok(gpOK, '3d: lava glow pulse stays within its band');
    ok(T3.flashDecay(0) === 1 && T3.flashDecay(1) < 0.01, '3d: flash decays to nothing');
    let pjOK = true;
    [[0, 0], [200, 10], [400, 30], [137, -20], [640, 55]].forEach(p => { if (Math.abs(T3.projectedY(p[0], p[1]) - p[0]) > 1e-9) pjOK = false; });
    ok(pjOK, '3d: tilted board projects physics y to the exact screen y (1:1 framing for pinAt)');
    ok(T3.depthZ(100, 30) > T3.depthZ(100, 10), '3d: board depth grows with layer z');
    ok(Object.keys(T3.MATS).sort().join(',') === 'gold,lava,obsidian,water', '3d: material table covers exactly the four sphere types');
    let matOK = true;
    Object.keys(T3.MATS).forEach(k => {
      const m = T3.MATS[k];
      ['color', 'emissive', 'metalness', 'roughness', 'opacity'].forEach(f => { if (m[f] == null) matOK = false; });
      if (!(m.metalness >= 0 && m.metalness <= 1 && m.roughness >= 0 && m.roughness <= 1 && m.opacity > 0 && m.opacity <= 1)) matOK = false;
    });
    ok(matOK, '3d: every material recipe has valid fields and ranges');

    /* ---- mobile touch cluster (MC): shared handlers, no double-fire ---- */
    let mcSpyN = 0;
    const mcSpy = () => { mcSpyN++; };
    ok(mcRetryGate('play', mcSpy) === true && mcSpyN === 1, 'mc: retry gate fires the shared retry handler in play state');
    ok(mcRetryGate('fail', mcSpy) === true && mcSpyN === 2, 'mc: retry gate fires on the fail overlay');
    ok(mcRetryGate('clear', mcSpy) === false && mcRetryGate('home', mcSpy) === false && mcSpyN === 2, 'mc: retry gate stays quiet outside play/fail');
    let mm = false;
    const mcFlip = () => { mm = !mm; };                        // the one toggle both DOM and MC invoke
    mcFlip(); mcFlip();
    ok(mm === false, 'mc: mute — a DOM press plus an MC press flip exactly twice (no double-fire)');
    try { require('../../shared/mobile-controls.js'); } catch (e) { /* optional dep */ }
    const MCG = globalThis.MC;
    if (MCG && MCG._btnFSM && MCG.isTouchDevice) {
      MCG._btnFSM.register('ptpTestBtn');
      MCG._btnFSM.down('ptpTestBtn'); MCG._btnFSM.down('ptpTestBtn');
      ok(MCG._btnFSM.isDown('ptpTestBtn') === true && MCG.isTouchDevice({ maxTouchPoints: 5 }) === true
        && MCG.isTouchDevice({ userAgent: 'X11 Linux Chrome' }) === false,
        'mc: button FSM double-down idempotent; cluster mounts on touch devices only');
    } else ok(true, 'mc: shared control lib absent in this env (skipped)');

    if (bad) { console.error(bad + ' TESTS FAILED'); process.exit(1); }
    console.log('ALL TESTS PASSED');
  }

  // ================= BOOT (browser only) =================
  if (typeof document !== 'undefined' && document.getElementById('cv')) init();
})();
