/* CRYPTFALL — js/engine.js
 * Canvas, game loop, input, camera, particles, floating text, math helpers.
 * Plain script, no dependencies. Global namespace: globalThis.CF
 */
var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});

/* ---------------- math helpers ---------------- */
CF.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
CF.rand = function (a, b) { return a + Math.random() * (b - a); };
CF.randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
CF.dist = function (x0, y0, x1, y1) { return Math.hypot(x1 - x0, y1 - y0); };
CF.angleTo = function (x0, y0, x1, y1) { return Math.atan2(y1 - y0, x1 - x0); };
CF.lerp = function (a, b, t) { return a + (b - a) * t; };
CF.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
/* deterministic PRNG (mulberry32) — used for per-floor seeds & rendering hash */
CF.mulberry32 = function (seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/* cheap deterministic hash for tile decoration variety */
CF.hash2 = function (x, y) {
  var h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = (Math.imul(h, 1274126177)) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/* ---------------- Engine (canvas + loop) ---------------- */
CF.Engine = {
  canvas: null, ctx: null,
  W: 0, H: 0, dpr: 1,
  running: false, _raf: 0, _last: 0,
  updateFn: null, renderFn: null,
  time: 0,

  init: function (canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) throw new Error('canvas #' + canvasId + ' not found');
    this.ctx = this.canvas.getContext('2d');
    var self = this;
    this._resize = function () { self.resize(); };
    window.addEventListener('resize', this._resize);
    this.resize();
  },

  resize: function () {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.floor(this.W * this.dpr);
    this.canvas.height = Math.floor(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  },

  start: function (updateFn, renderFn) {
    this.updateFn = updateFn;
    this.renderFn = renderFn;
    this.running = true;
    this._last = performance.now();
    var self = this;
    function frame(now) {
      if (!self.running) return;
      var dt = (now - self._last) / 1000;
      self._last = now;
      if (dt > 0.05) dt = 0.05;          /* clamp big hitches */
      if (dt < 0) dt = 0;
      self.time += dt;
      try {
        self.updateFn(dt, self.time);
        self.renderFn(self.ctx, dt, self.time);
      } catch (err) {
        self.running = false;
        console.error(err);
        if (typeof CF.Game !== 'undefined') CF.Game.fatal(err);
        return;
      }
      self._raf = requestAnimationFrame(frame);
    }
    this._raf = requestAnimationFrame(frame);
  },

  stop: function () {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }
};

/* ---------------- Input ---------------- */
CF.Input = {
  keys: Object.create(null),      /* held: e.code -> true */
  pressed: Object.create(null),   /* pressed this frame */
  mouse: { x: 0, y: 0, down: false, pressedThisFrame: false },
  axes: { mx: 0, my: 0 },          /* analog joystick (touch) */
  attackHeld: false,              /* touch ATTACK button held */
  mobile: false,                   /* touch controls mounted */
  _initialized: false,

  init: function (canvas) {
    if (this._initialized) return;
    this._initialized = true;
    var self = this;
    window.addEventListener('keydown', function (e) {
      /* stop page scroll / browser hotkeys we use */
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
           'KeyE', 'KeyQ', 'KeyI'].indexOf(e.code) !== -1) e.preventDefault();
      if (!e.repeat) { self.keys[e.code] = true; self.pressed[e.code] = true; }
      if (typeof CF.SoundFX !== 'undefined' && CF.SoundFX.unlock) {
        try { CF.SoundFX.unlock(); } catch (err) {}
      }
    });
    window.addEventListener('keyup', function (e) { self.keys[e.code] = false; });
    window.addEventListener('blur', function () { self.keys = Object.create(null); });
    canvas.addEventListener('mousemove', function (e) {
      var r = canvas.getBoundingClientRect();
      self.mouse.x = e.clientX - r.left;
      self.mouse.y = e.clientY - r.top;
    });
    canvas.addEventListener('mousedown', function (e) {
      if (e.button === 0) { self.mouse.down = true; self.mouse.pressedThisFrame = true; }
      if (typeof CF.SoundFX !== 'undefined' && CF.SoundFX.unlock) {
        try { CF.SoundFX.unlock(); } catch (err) {}
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) self.mouse.down = false;
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  },

  /* call at end of every frame */
  endFrame: function () {
    this.pressed = Object.create(null);
    this.mouse.pressedThisFrame = false;
  },

  held: function (code) { return !!this.keys[code]; },
  hit: function (code) { return !!this.pressed[code]; },
  mouseClicked: function () { return this.mouse.pressedThisFrame; }
};

/* ---------------- Camera ---------------- */
CF.Camera = {
  x: 0, y: 0, W: 0, H: 0,
  shakeT: 0, shakeMag: 0, shakeX: 0, shakeY: 0,
  worldW: 0, worldH: 0,

  setBounds: function (worldW, worldH) { this.worldW = worldW; this.worldH = worldH; },

  snapTo: function (px, py) {
    this.W = CF.Engine.W; this.H = CF.Engine.H;
    this.x = this._cx(px); this.y = this._cy(py);
  },

  _cx: function (px) {
    var half = CF.Engine.W / 2;
    if (this.worldW <= CF.Engine.W) return (this.worldW - CF.Engine.W) / 2; /* center small maps */
    return CF.clamp(px - half, 0, this.worldW - CF.Engine.W);
  },
  _cy: function (py) {
    var half = CF.Engine.H / 2;
    if (this.worldH <= CF.Engine.H) return (this.worldH - CF.Engine.H) / 2;
    return CF.clamp(py - half, 0, this.worldH - CF.Engine.H);
  },

  follow: function (px, py, dt) {
    this.W = CF.Engine.W; this.H = CF.Engine.H;
    var tx = this._cx(px), ty = this._cy(py);
    var k = 1 - Math.pow(0.0008, dt);   /* smooth, framerate independent */
    this.x = CF.lerp(this.x, tx, k);
    this.y = CF.lerp(this.y, ty, k);
    /* shake decay */
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      this.shakeX = CF.rand(-1, 1) * this.shakeMag * (this.shakeT > 0 ? 1 : 0);
      this.shakeY = CF.rand(-1, 1) * this.shakeMag * (this.shakeT > 0 ? 1 : 0);
    } else { this.shakeX = 0; this.shakeY = 0; }
  },

  shake: function (mag, t) {
    if (mag > this.shakeMag || this.shakeT <= 0) { this.shakeMag = mag; this.shakeT = t; }
  },

  apply: function (ctx) {
    ctx.translate(-Math.round(this.x + this.shakeX), -Math.round(this.y + this.shakeY));
  },

  worldToScreen: function (wx, wy) { return { x: wx - this.x - this.shakeX, y: wy - this.y - this.shakeY }; },
  screenToWorld: function (sx, sy) { return { x: sx + this.x + this.shakeX, y: sy + this.y + this.shakeY }; }
};

/* ---------------- Particles ---------------- */
CF.Particles = {
  list: [],

  spawn: function (o) {
    this.list.push({
      x: o.x, y: o.y,
      vx: o.vx || 0, vy: o.vy || 0,
      grav: o.grav || 0,
      life: 0, maxLife: o.life || 0.5,
      size: o.size || 3,
      color: o.color || '#fff',
      shrink: o.shrink !== false,
      fade: o.fade !== false,
      glow: !!o.glow
    });
  },

  burst: function (x, y, o) {
    o = o || {};
    var n = o.count || 10;
    var speed = o.speed || 120;
    for (var i = 0; i < n; i++) {
      var a = CF.rand(0, Math.PI * 2);
      var s = CF.rand(speed * 0.3, speed);
      this.spawn({
        x: x, y: y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: CF.rand(0.25, (o.life || 0.6)),
        size: CF.rand(1.5, (o.size || 4)),
        color: o.color || '#fff',
        grav: o.grav || 0,
        glow: o.glow
      });
    }
  },

  /* fading wedge trail for melee slashes */
  slash: function (x, y, angle, arc, range, color) {
    var steps = 7;
    for (var i = 0; i < steps; i++) {
      var a = angle - arc / 2 + (arc * i) / (steps - 1);
      this.spawn({
        x: x + Math.cos(a) * range * CF.rand(0.55, 0.95),
        y: y + Math.sin(a) * range * CF.rand(0.55, 0.95),
        vx: Math.cos(a) * 60, vy: Math.sin(a) * 60,
        life: 0.16, size: CF.rand(2, 5),
        color: color || '#e8e8ff', glow: true
      });
    }
  },

  update: function (dt) {
    var L = this.list;
    for (var i = L.length - 1; i >= 0; i--) {
      var p = L[i];
      p.life += dt;
      if (p.life >= p.maxLife) { L.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= (1 - 3 * dt); p.vy *= (1 - 3 * dt);
    }
  },

  render: function (ctx) {
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i];
      var t = 1 - p.life / p.maxLife;
      ctx.globalAlpha = p.fade ? t : 1;
      var s = p.shrink ? Math.max(0.5, p.size * t) : p.size;
      ctx.fillStyle = p.color;
      if (p.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = 8; }
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      if (p.glow) { ctx.shadowBlur = 0; }
    }
    ctx.globalAlpha = 1;
  },

  clear: function () { this.list.length = 0; }
};

/* ---------------- Floating damage/loot text ---------------- */
CF.FloatText = {
  list: [],

  add: function (x, y, text, color, size) {
    this.list.push({
      x: x + CF.rand(-6, 6), y: y,
      vy: -46, life: 0, maxLife: 0.9,
      text: String(text), color: color || '#fff',
      size: size || 14
    });
  },

  update: function (dt) {
    var L = this.list;
    for (var i = L.length - 1; i >= 0; i--) {
      var f = L[i];
      f.life += dt;
      if (f.life >= f.maxLife) { L.splice(i, 1); continue; }
      f.y += f.vy * dt;
      f.vy *= (1 - 1.5 * dt);
    }
  },

  render: function (ctx) {
    ctx.textAlign = 'center';
    for (var i = 0; i < this.list.length; i++) {
      var f = this.list[i];
      var t = 1 - f.life / f.maxLife;
      ctx.globalAlpha = t;
      ctx.font = 'bold ' + f.size + 'px monospace';
      ctx.fillStyle = '#000';
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  },

  clear: function () { this.list.length = 0; }
};

/* ---------------- audio convenience (guards missing module) ---------------- */
CF.sfx = function (name) {
  if (typeof CF.SoundFX !== 'undefined' && CF.SoundFX.play) {
    try { CF.SoundFX.play(name); } catch (err) {}
  }
};

/* Resolve a consumable's heal value. Supports number form (30) and the
 * object form from content.js ({heal:30}, {heal:'full', cleanse:true}). */
CF.healValue = function (item, player) {
  if (!item) return 0;
  var e = item.effect;
  if (typeof e === 'number') return e;
  if (e && typeof e === 'object') {
    if (e.heal === 'full') return player ? (player.maxHp - player.hp) : 999;
    return +e.heal || 0;
  }
  return 0;
};
