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
  let cv, ctx, cdTimer = null;
  const $ = id => document.getElementById(id);

  function init() {
    cv = $('cv'); ctx = cv.getContext('2d');
    Game.save = loadSave();
    AudioSys.muted = Game.save.m;
    renderPills(); updateMuteBtn();
    $('btnPlay').addEventListener('click', () => { AudioSys.unlock(); AudioSys.play('click'); showGame(); startLevel(Math.min(Game.save.u, PIN_LEVELS.length) - 1); });
    $('btnRetry').addEventListener('click', () => { AudioSys.play('click'); startLevel(Game.idx, true); });
    $('btnHome').addEventListener('click', () => { AudioSys.play('click'); goHome(); });
    $('btnRetry2').addEventListener('click', () => { AudioSys.play('click'); startLevel(Game.idx, true); });
    $('btnNext').addEventListener('click', () => { AudioSys.play('click'); if (Game.idx + 1 < PIN_LEVELS.length) startLevel(Game.idx + 1); else goHome(); });
    $('btnMute').addEventListener('click', () => { AudioSys.muted = !AudioSys.muted; Game.save.m = AudioSys.muted; persist(); updateMuteBtn(); });
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
    });
    addEventListener('keydown', e => {
      if ((e.key === 'm' || e.key === 'M') && $('btnMute')) $('btnMute').click();
      if ((e.key === 'r' || e.key === 'R') && Game.state === 'play') startLevel(Game.idx, true);
    });
    addEventListener('resize', fit);
    fit(); goHome();
    requestAnimationFrame(frame);
  }

  function fit() {
    const s = Math.max(0.4, Math.min(1, (innerWidth - 24) / W, (innerHeight - 205) / H));
    cv.style.width = (W * s | 0) + 'px'; cv.style.height = (H * s | 0) + 'px';
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
  function updateMuteBtn() { $('btnMute').textContent = AudioSys.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A'; }

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

    if (bad) { console.error(bad + ' TESTS FAILED'); process.exit(1); }
    console.log('ALL TESTS PASSED');
  }

  // ================= BOOT (browser only) =================
  if (typeof document !== 'undefined' && document.getElementById('cv')) init();
})();
