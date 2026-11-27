var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
// =============================================================================
// DOPAMINE FACTORY — js/fx.js — DP.FX — pooled 3D particle/FX system
//
// ZERO per-frame allocations: coins, confetti, sparks, rings, bolts and the
// "+123" DOM labels all live in preallocated pools; update() only mutates
// structs, instance matrices, buffer attributes and label transforms.
//
//   burst(type, x, z, opts)         'pop'|'merge'|'lucky'|'chain'|'jackpot'
//                                   opts: {tier, lucky, color, count, y, text, size}
//   label(x, z, text, color, size)  pooled div in #labels: pop-in + rise + fade
//   lightning(x1, z1, x2, z2, opts) jagged additive bolt between cells (life .15s)
//   update(dt)                      advance all pools (call every frame)
//   render(scene)                   lazy-build + attach to the THREE scene (idempotent)
//   setCamera(cam, stageEl)         injected by game.js (viewport from stageEl)
//   projectToScreen(x, z, y?, out?) -> {x, y} in CSS px, or null without camera
//   clear()  counts()
//
// Pools: coins 200 (spinning gold discs, InstancedMesh), confetti 150
// (instanced quads, per-instance color), sparks 300 (additive Points),
// rings 12 (expanding torus meshes), bolts 6, labels 24 (pooled divs).
// DOM guarded by typeof document; THREE resolved lazily with a defensive
// build, so the module boots headless. `node js/fx.js` self-tests the PURE
// parts: pool index math, label tween math, projection with a mock camera.
// =============================================================================

DP.FX = (function () {
  'use strict';

  // ------------------------------------------------------------- constants --
  var COIN_MAX = 200, CONFETTI_MAX = 150, SPARK_MAX = 300;
  var RING_MAX = 12, BOLT_MAX = 6, BOLT_SEGS = 8, LABEL_MAX = 24;
  var GRAV = 14, COIN_REST = 0.06, LABEL_LIFT = 0.55, TAU = Math.PI * 2;
  var WHITE_RGB = [1, 1, 1];

  // ------------------------------------------- pure: LIFO index pool --------
  // inUse guard: releasing a free/invalid slot is rejected, so acquire/release
  // cycles can NEVER grow the free list or hand out a slot twice.
  function makeIndexPool(cap) {
    var free = new Array(cap), inUse = new Uint8Array(cap), n = cap, active = 0, i;
    for (i = 0; i < cap; i++) free[i] = cap - 1 - i;
    return {
      capacity: function () { return cap; },
      freeCount: function () { return n; },
      activeCount: function () { return active; },
      acquire: function () {
        if (n <= 0) return -1;
        var idx = free[--n];
        inUse[idx] = 1; active++;
        return idx;
      },
      release: function (idx) {
        if (idx < 0 || idx >= cap || inUse[idx] !== 1) return false;
        inUse[idx] = 0; free[n++] = idx; active--;
        return true;
      }
    };
  }

  // -------------------------------------------------------- pure: tweens ---
  function clamp01(k) { return k < 0 ? 0 : (k > 1 ? 1 : k); }
  function easeOutCubic(k) { var e = 1 - k; return 1 - e * e * e; }
  function easeOutBack(k) {
    var c = 1.70158, u = k - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  }
  // Label tween over normalized life k: rise 0→-1 (px factor; up is -y on
  // screen), alpha holds 1 for the first 30% then fades linearly to 0,
  // scale pops in with an overshoot during the first 12%.
  function tweenInto(k, out) {
    k = clamp01(k);
    out.rise = -easeOutCubic(k);
    out.alpha = k < 0.3 ? 1 : Math.max(0, 1 - (k - 0.3) / 0.7);
    out.scale = k < 0.12 ? easeOutBack(k / 0.12) : 1;
    return out;
  }
  function labelTween(k) { return tweenInto(k, { rise: 0, alpha: 1, scale: 1 }); }

  // -------------------------------------------------- pure: projection -----
  // Column-major 4x4 (THREE Matrix4.elements layout): clip = P * V * p.
  function ndcInto(px, py, pz, proj, view, out) {
    var vx = view[0] * px + view[4] * py + view[8] * pz + view[12];
    var vy = view[1] * px + view[5] * py + view[9] * pz + view[13];
    var vz = view[2] * px + view[6] * py + view[10] * pz + view[14];
    var vw = view[3] * px + view[7] * py + view[11] * pz + view[15];
    var w = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;
    if (w === 0) w = 1e-6;
    out.x = (proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw) / w;
    out.y = (proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw) / w;
    return out;
  }

  // --------------------------------------------------- pure: color parse ----
  function hslToRgb(h, s, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    h = ((h % 360) + 360) % 360 / 360; s /= 100; l /= 100;
    if (s === 0) return [l, l, l];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  function parseColor(str) {  // '#rgb'|'#rrggbb'|'hsl(h,s%,l%)' -> [r,g,b]
    var out = [1, 1, 1];
    try {
      if (typeof str !== 'string') return out;
      var s = str.trim(), h;
      if (s.charAt(0) === '#') {
        h = s.slice(1);
        if (h.length === 3) {
          out[0] = parseInt(h.charAt(0) + h.charAt(0), 16) / 255;
          out[1] = parseInt(h.charAt(1) + h.charAt(1), 16) / 255;
          out[2] = parseInt(h.charAt(2) + h.charAt(2), 16) / 255;
        } else if (h.length >= 6) {
          out[0] = parseInt(h.slice(0, 2), 16) / 255;
          out[1] = parseInt(h.slice(2, 4), 16) / 255;
          out[2] = parseInt(h.slice(4, 6), 16) / 255;
        }
      } else if (s.slice(0, 4) === 'hsl(' && s.slice(-1) === ')') {
        var parts = s.slice(4, -1).split(',');
        if (parts.length >= 3) {
          var rgb = hslToRgb(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
          out[0] = rgb[0]; out[1] = rgb[1]; out[2] = rgb[2];
        }
      }
    } catch (e) { out[0] = out[1] = out[2] = 1; }
    var i;
    for (i = 0; i < 3; i++) if (!(out[i] >= 0 && out[i] <= 1)) out[i] = 1;
    return out;
  }

  // ---------------------------------------------------------- pool state ----
  function mkStructs(n, factory) {
    var a = new Array(n), i;
    for (i = 0; i < n; i++) a[i] = factory();
    return a;
  }
  var coins = mkStructs(COIN_MAX, function () {
    return { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rot: 0,
      vrot: 0, t: 0, life: 1, size: 1 };
  });
  var confs = mkStructs(CONFETTI_MAX, function () {
    return { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0,
      vrx: 0, vry: 0, phase: 0, sway: 0, t: 0, life: 1, size: 1, r: 1, g: 1, b: 1 };
  });
  var sparks = mkStructs(SPARK_MAX, function () {
    return { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      t: 0, life: 1, r: 1, g: 1, b: 1, phase: 0 };
  });
  var rings = mkStructs(RING_MAX, function () {
    return { active: false, x: 0, z: 0, t: 0, life: 1, r0: 0.3, r1: 1.5 };
  });
  var bolts = mkStructs(BOLT_MAX, function () {
    return { active: false, t: 0, life: 0.15, pos: new Float32Array((BOLT_SEGS + 1) * 3) };
  });
  var labels = mkStructs(LABEL_MAX, function () {
    return { active: false, el: null, t: 0, dur: 0.95, wx: 0, wz: 0,
      dx: 0, risePx: 40, lx: 0, ly: 0 };
  });
  var sparkPos = new Float32Array(SPARK_MAX * 3);
  var sparkCol = new Float32Array(SPARK_MAX * 3);

  var coinPool = makeIndexPool(COIN_MAX), confPool = makeIndexPool(CONFETTI_MAX);
  var sparkPool = makeIndexPool(SPARK_MAX), ringPool = makeIndexPool(RING_MAX);
  var boltPool = makeIndexPool(BOLT_MAX);

  // Preallocated temps — the only objects update() ever touches.
  var _tw = { rise: 0, alpha: 1, scale: 1 }, _pt = { x: 0, y: 0 };
  var _ndcTmp = { x: 0, y: 0 };

  // ------------------------------------------------------- THREE (lazy) -----
  var built = false, attached = null, coinMesh = null, confMesh = null;
  var sparkPoints = null, sparkPosAttr = null, sparkColAttr = null;
  var ringMeshes = new Array(RING_MAX), boltLines = new Array(BOLT_MAX);
  var _v = null, _v2 = null, _e = null, _q = null, _m = null, _zero = null, _c = null;
  var coinDirty = false, confDirty = false, sparkDirty = false, threeRef = null;

  function three() {
    if (threeRef) return threeRef;
    try {
      threeRef = (typeof globalThis.THREE !== 'undefined') ? globalThis.THREE : null;
    } catch (e) { threeRef = null; }
    return threeRef;
  }

  function makeSparkTexture(T) {  // soft radial glow sprite (DOM-guarded)
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      var cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      var g = cv.getContext('2d');
      var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.35, 'rgba(255,255,255,.55)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      return new T.CanvasTexture(cv);
    } catch (e) { return null; }
  }

  function build(T) {  // one-time GPU-side construction; mock-defensive
    try {
      _v = new T.Vector3(); _v2 = new T.Vector3(); _e = new T.Euler();
      _q = new T.Quaternion(); _m = new T.Matrix4(); _c = new T.Color();
      _zero = new T.Matrix4().makeScale(0, 0, 0);
      var i;
      // coins: spinning gold discs (instanced cylinder, axis along Z)
      var coinGeo = new T.CylinderGeometry(0.16, 0.16, 0.05, 14);
      coinGeo.rotateX(Math.PI / 2);
      coinMesh = new T.InstancedMesh(coinGeo, new T.MeshStandardMaterial({
        color: 0xffd24a, metalness: 0.65, roughness: 0.3,
        emissive: 0xb8860b, emissiveIntensity: 0.55 }), COIN_MAX);
      coinMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      coinMesh.frustumCulled = false;
      for (i = 0; i < COIN_MAX; i++) coinMesh.setMatrixAt(i, _zero);
      // confetti: instanced quads, per-instance color
      confMesh = new T.InstancedMesh(new T.PlaneGeometry(0.14, 0.085),
        new T.MeshBasicMaterial({ side: T.DoubleSide }), CONFETTI_MAX);
      confMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      confMesh.frustumCulled = false;
      for (i = 0; i < CONFETTI_MAX; i++) {
        confMesh.setMatrixAt(i, _zero);
        confMesh.setColorAt(i, _c.setRGB(1, 1, 1));
      }
      if (confMesh.instanceColor) confMesh.instanceColor.setUsage(T.DynamicDrawUsage);
      // glow sparks: additive Points with a soft sprite map (fade == color
      // intensity under AdditiveBlending, so black means invisible)
      var sparkGeo = new T.BufferGeometry();
      sparkPosAttr = new T.BufferAttribute(sparkPos, 3);
      sparkPosAttr.setUsage(T.DynamicDrawUsage);
      sparkColAttr = new T.BufferAttribute(sparkCol, 3);
      sparkColAttr.setUsage(T.DynamicDrawUsage);
      sparkGeo.setAttribute('position', sparkPosAttr);
      sparkGeo.setAttribute('color', sparkColAttr);
      sparkPoints = new T.Points(sparkGeo, new T.PointsMaterial({ size: 0.22,
        map: makeSparkTexture(T), transparent: true, depthWrite: false,
        blending: T.AdditiveBlending, vertexColors: true, sizeAttenuation: true }));
      sparkPoints.frustumCulled = false;
      // shockwave rings: flat additive torus meshes
      var ringGeo = new T.TorusGeometry(1, 0.05, 8, 40);
      ringGeo.rotateX(Math.PI / 2);
      for (i = 0; i < RING_MAX; i++) {
        ringMeshes[i] = new T.Mesh(ringGeo, new T.MeshBasicMaterial({ transparent: true,
          opacity: 0, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide }));
        ringMeshes[i].visible = false;
      }
      // chain lightning: jagged additive lines (BOLT_SEGS+1 points)
      for (i = 0; i < BOLT_MAX; i++) {
        var bg = new T.BufferGeometry();
        bg.setAttribute('position', new T.BufferAttribute(bolts[i].pos, 3));
        boltLines[i] = new T.Line(bg, new T.LineBasicMaterial({ color: 0xbfe0ff,
          transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
        boltLines[i].visible = false;
        boltLines[i].frustumCulled = false;
      }
      built = true;
      return true;
    } catch (e) {
      built = false;
      coinMesh = confMesh = sparkPoints = sparkPosAttr = sparkColAttr = null;
      _v = _v2 = _e = _q = _m = _zero = _c = null;
      return false;
    }
  }

  // ---------------------------------------------------- kills (pool-safe) ---
  function killCoin(i) {
    if (!coinPool.release(i)) return;
    coins[i].active = false;
    if (coinMesh) { coinMesh.setMatrixAt(i, _zero); coinDirty = true; }
  }
  function killConfetti(i) {
    if (!confPool.release(i)) return;
    confs[i].active = false;
    if (confMesh) { confMesh.setMatrixAt(i, _zero); confDirty = true; }
  }
  function killSpark(i) {
    if (!sparkPool.release(i)) return;
    sparks[i].active = false;
    sparkPos[i * 3] = 0; sparkPos[i * 3 + 1] = -1000; sparkPos[i * 3 + 2] = 0;
    sparkCol[i * 3] = sparkCol[i * 3 + 1] = sparkCol[i * 3 + 2] = 0;
    sparkDirty = true;
  }
  function killRing(i) {
    if (!ringPool.release(i)) return;
    rings[i].active = false;
    if (ringMeshes[i]) ringMeshes[i].visible = false;
  }
  function killBolt(i) {
    if (!boltPool.release(i)) return;
    bolts[i].active = false;
    if (boltLines[i]) boltLines[i].visible = false;
  }
  function killLabel(i) {
    labels[i].active = false;
    if (labels[i].el) { labels[i].el.style.display = 'none'; labels[i].el.style.opacity = '0'; }
  }

  // When a pool is full, steal the particle closest to death — juice is never
  // dropped mid-frenzy. LIFO guarantees the released slot re-acquires.
  function acquireSteal(pool, structs, kill) {
    var idx = pool.acquire();
    if (idx >= 0) return idx;
    var i, best = -1, bestK = -1;
    for (i = 0; i < pool.capacity(); i++) {
      if (structs[i].active && structs[i].t / structs[i].life > bestK) {
        bestK = structs[i].t / structs[i].life; best = i;
      }
    }
    if (best < 0) return -1;
    kill(best);
    return pool.acquire();
  }

  // -------------------------------------------------------------- spawns ----
  function spawnCoin(x, y, z, size) {
    var i = acquireSteal(coinPool, coins, killCoin);
    if (i < 0) return;
    var c = coins[i], a = Math.random() * TAU, sp = 0.4 + Math.random() * 1.6;
    c.active = true;
    c.x = x; c.y = y; c.z = z;
    c.vx = Math.cos(a) * sp; c.vz = Math.sin(a) * sp;
    c.vy = 2.2 + Math.random() * 2.4;
    c.rot = Math.random() * TAU; c.vrot = 8 + Math.random() * 10;
    c.t = 0; c.life = 0.9 + Math.random() * 0.5;
    c.size = (typeof size === 'number' && size > 0) ? size : 0.85 + Math.random() * 0.4;
  }
  function spawnConfetti(x, y, z, rgb, spread, up) {
    var i = acquireSteal(confPool, confs, killConfetti);
    if (i < 0) return;
    var f = confs[i], a = Math.random() * TAU;
    var sp = (spread || 1) * (0.3 + Math.random() * 1.4);
    f.active = true;
    f.x = x; f.y = y; f.z = z;
    f.vx = Math.cos(a) * sp; f.vz = Math.sin(a) * sp;
    f.vy = (up || 1) * (1.1 + Math.random() * 1.9);
    f.rx = Math.random() * TAU; f.ry = Math.random() * TAU;
    f.vrx = (Math.random() * 2 - 1) * 9; f.vry = (Math.random() * 2 - 1) * 9;
    f.phase = Math.random() * TAU; f.sway = 0.25 + Math.random() * 0.5;
    f.t = 0; f.life = 1.1 + Math.random() * 0.7;
    f.size = 0.8 + Math.random() * 0.5;
    f.r = rgb ? rgb[0] : 1; f.g = rgb ? rgb[1] : 1; f.b = rgb ? rgb[2] : 1;
    if (confMesh) { _c.setRGB(f.r, f.g, f.b); confMesh.setColorAt(i, _c); confDirty = true; }
  }
  function spawnSpark(x, y, z, rgb, speed, life) {
    var i = acquireSteal(sparkPool, sparks, killSpark);
    if (i < 0) return;
    var s = sparks[i], a = Math.random() * TAU;
    var sp = (speed || 1) * (0.3 + Math.random() * 1.1);
    s.active = true;
    s.x = x; s.y = y; s.z = z;
    s.vx = Math.cos(a) * sp; s.vz = Math.sin(a) * sp; s.vy = Math.random() * sp;
    s.t = 0; s.life = (life || 0.5) * (0.6 + Math.random() * 0.8);
    s.r = rgb ? rgb[0] : 1; s.g = rgb ? rgb[1] : 1; s.b = rgb ? rgb[2] : 1;
    s.phase = Math.random() * TAU;
    sparkPos[i * 3] = x; sparkPos[i * 3 + 1] = y; sparkPos[i * 3 + 2] = z;
    sparkCol[i * 3] = s.r; sparkCol[i * 3 + 1] = s.g; sparkCol[i * 3 + 2] = s.b;
    sparkDirty = true;
  }
  function spawnRing(x, z, r0, r1, life, rgb) {
    var i = acquireSteal(ringPool, rings, killRing);
    if (i < 0) return;
    var R = rings[i];
    R.active = true; R.t = 0;
    R.life = (life > 0) ? life : 0.5;
    R.x = x; R.z = z; R.r0 = r0; R.r1 = r1;
    if (ringMeshes[i]) {
      var m = ringMeshes[i];
      m.visible = true;
      m.position.set(x, 0.06, z);
      m.material.color.setRGB(rgb ? rgb[0] : 1, rgb ? rgb[1] : 1, rgb ? rgb[2] : 1);
      m.material.opacity = 0.95;
      m.scale.set(r0, r0, r0);
    }
  }
  function tierColor(tier) {
    try {
      if (DP.Content && typeof DP.Content.tierColor === 'function') {
        var c = DP.Content.tierColor(tier);
        if (typeof c === 'string' && c) return c;
      }
    } catch (e) { /* fall through */ }
    return 'hsl(' + ((tier * 137) % 360) + ',92%,62%)';
  }

  // -------------------------------------------------------------- bursts ----
  function burst(type, wx, wz, opts) {
    opts = opts || {};
    wx = +wx; if (!isFinite(wx)) wx = 0;
    wz = +wz; if (!isFinite(wz)) wz = 0;
    var tier = opts.tier | 0;
    if (!(tier >= 1 && tier <= 25)) tier = 1;
    var lucky = !!opts.lucky;
    var y = (typeof opts.y === 'number' && isFinite(opts.y)) ? opts.y : 0.45;
    var colStr = (typeof opts.color === 'string' && opts.color) ? opts.color : tierColor(tier);
    var col = parseColor(colStr), gold = parseColor('#ffd24a');
    var mul = (typeof opts.count === 'number' && isFinite(opts.count) && opts.count > 0)
      ? opts.count : 1;
    var i, n;

    if (type === 'merge') {
      n = Math.round((12 + Math.min(tier, 18)) * mul);
      for (i = 0; i < n; i++) {
        spawnConfetti(wx, y, wz, i % 3 === 0 ? gold : (i % 3 === 1 ? col : WHITE_RGB), 1.4, 1.6);
      }
      for (i = 0; i < Math.round(12 * mul); i++) {
        spawnSpark(wx, y, wz, i % 2 ? col : WHITE_RGB, 1.8, 0.45);
      }
      spawnRing(wx, wz, 0.3, 1.1 + tier * 0.1, 0.5, col);
    } else if (type === 'lucky' || (type === 'pop' && lucky)) {
      // GOLD SHOWER
      n = Math.round((type === 'lucky' ? 26 : Math.min((4 + tier) * 2, 26)) * mul);
      for (i = 0; i < n; i++) spawnCoin(wx, y, wz, 1);
      for (i = 0; i < Math.round(18 * mul); i++) spawnConfetti(wx, y, wz, gold, 1.7, 1.8);
      for (i = 0; i < Math.round(28 * mul); i++) {
        spawnSpark(wx, y, wz, i % 2 ? gold : WHITE_RGB, 2.2, 0.55);
      }
      spawnRing(wx, wz, 0.2, 1.5, 0.55, gold);
      spawnRing(wx, wz, 0.6, 2.3, 0.7, gold);
    } else if (type === 'chain') {
      var elec = parseColor('#9fd0ff');
      for (i = 0; i < Math.round(16 * mul); i++) {
        spawnSpark(wx, y, wz, i % 2 ? elec : WHITE_RGB, 2.4, 0.4);
      }
      spawnRing(wx, wz, 0.15, 0.8, 0.35, elec);
    } else if (type === 'jackpot' || type === 'big') {
      for (i = 0; i < Math.round(20 * mul); i++) spawnCoin(wx, y, wz, 1);
      for (i = 0; i < Math.round(34 * mul); i++) {
        spawnConfetti(wx, y, wz, i % 4 === 0 ? gold : col, 2.2, 2);
      }
      for (i = 0; i < Math.round(46 * mul); i++) {
        spawnSpark(wx, y, wz, i % 3 === 0 ? gold : col, 2.6, 0.7);
      }
      spawnRing(wx, wz, 0.2, 2.4, 0.75, gold);
      spawnRing(wx, wz, 0.5, 3.1, 0.9, col);
    } else {  // 'pop' + any unknown type
      n = Math.round(Math.min(4 + tier, 15) * mul);
      for (i = 0; i < n; i++) spawnCoin(wx, y, wz);
      n = Math.round(Math.min(8 + tier * 2, 36) * mul);
      for (i = 0; i < n; i++) spawnSpark(wx, y, wz, i % 2 ? col : WHITE_RGB, 1.6, 0.45);
      if (tier >= 2 || lucky) {
        spawnRing(wx, wz, 0.2, 1 + tier * 0.12, 0.45 + tier * 0.02, col);
      }
    }
    if (opts.text) label(wx, wz, opts.text, colStr, opts.size || 14 + Math.min(tier, 10));
  }

  // -------------------------------------------------- chain lightning bolt --
  function lightning(x1, z1, x2, z2, opts) {
    x1 = +x1; if (!isFinite(x1)) x1 = 0;
    z1 = +z1; if (!isFinite(z1)) z1 = 0;
    x2 = +x2; if (!isFinite(x2)) x2 = 0;
    z2 = +z2; if (!isFinite(z2)) z2 = 0;
    opts = opts || {};
    var i = acquireSteal(boltPool, bolts, killBolt);
    if (i < 0) return null;
    var b = bolts[i], arr = b.pos, n = BOLT_SEGS + 1;
    var lift = (typeof opts.y === 'number' && isFinite(opts.y)) ? opts.y : LABEL_LIFT;
    var dx = x2 - x1, dz = z2 - z1;
    var len = Math.sqrt(dx * dx + dz * dz) || 1;
    var px = -dz / len, pz = dx / len;  // perpendicular for the jag
    var rgb = parseColor(opts.color || '#9fd0ff');
    var j, k, off;
    for (j = 0; j < n; j++) {
      k = j / BOLT_SEGS;
      off = (j === 0 || j === BOLT_SEGS) ? 0
        : (Math.random() * 2 - 1) * 0.38 * (1 - Math.abs(k * 2 - 1));
      arr[j * 3] = x1 + dx * k + px * off;
      arr[j * 3 + 1] = lift + ((j > 0 && j < BOLT_SEGS) ? Math.random() * 0.3 : 0);
      arr[j * 3 + 2] = z1 + dz * k + pz * off;
    }
    b.active = true; b.t = 0;
    b.life = (opts.life > 0) ? opts.life : 0.15;
    if (boltLines[i]) {
      var line = boltLines[i];
      line.geometry.attributes.position.needsUpdate = true;
      line.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
      line.material.opacity = 1;
      line.visible = true;
    }
    for (j = 0; j < 9; j++) {  // crackle sparks along the jagged path
      var a = (Math.random() * BOLT_SEGS) | 0;
      spawnSpark(arr[a * 3], arr[a * 3 + 1], arr[a * 3 + 2], rgb, 1.6, 0.3);
    }
    return i;
  }

  // ------------------------------------------------------------- labels -----
  var labelElsBuilt = false;

  function ensureLabelEls() {
    if (labelElsBuilt || typeof document === 'undefined') return;
    labelElsBuilt = true;
    var host = document.getElementById('labels');
    if (!host) return;  // mount point owned by index.html; stay headless
    var i, el;
    for (i = 0; i < LABEL_MAX; i++) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;display:none;pointer-events:none;' +
        'white-space:nowrap;font-weight:800;line-height:1;text-align:center;' +
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;' +
        'text-shadow:0 2px 6px rgba(0,0,0,.55),0 0 12px currentColor;' +
        'will-change:transform,opacity;';
      host.appendChild(el);
      labels[i].el = el;
    }
  }

  function labelAcquire() {  // first free slot, else steal closest-to-death
    var i, best = -1, bestT = -1;
    for (i = 0; i < LABEL_MAX; i++) if (!labels[i].active) return i;
    for (i = 0; i < LABEL_MAX; i++) if (labels[i].t > bestT) { bestT = labels[i].t; best = i; }
    return best;  // LABEL_MAX > 0 so there is always a slot
  }

  function label(wx, wz, text, color, size) {
    text = (text === null || typeof text === 'undefined') ? '' : String(text);
    if (!text) return null;
    wx = +wx; if (!isFinite(wx)) wx = 0;
    wz = +wz; if (!isFinite(wz)) wz = 0;
    size = +size;
    if (!(size >= 8 && size <= 72)) size = 16;
    if (!projectToScreen(wx, wz, LABEL_LIFT, _pt)) return null;  // no camera yet
    var i = labelAcquire(), L = labels[i];
    L.active = true; L.t = 0; L.dur = 0.95;
    L.wx = wx; L.wz = wz;
    L.dx = (Math.random() * 2 - 1) * 10;
    L.risePx = 34 + size * 1.2;
    L.lx = -1e9; L.ly = -1e9;  // force a transform write on the next update
    ensureLabelEls();
    if (L.el) {
      L.el.textContent = text;
      L.el.style.display = 'block';
      L.el.style.color = color || '#ffd24a';
      L.el.style.fontSize = size + 'px';
    }
    return i;
  }

  // -------------------------------------------------------------- update ----
  function update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;  // tab-switch spike guard
    var i, c, f, s, r, b, k, sc, drag, fade, touched;
    // coins: gravity, floor bounce, spin, scale-out
    touched = false;
    for (i = 0; i < COIN_MAX; i++) {
      c = coins[i];
      if (!c.active) continue;
      c.t += dt;
      if (c.t >= c.life) { killCoin(i); continue; }
      touched = true;
      c.vy -= GRAV * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      if (c.y < COIN_REST) {  // bounce on the glossy floor
        c.y = COIN_REST;
        if (c.vy < -0.4) { c.vy = -c.vy * 0.45; c.vx *= 0.7; c.vz *= 0.7; }
        else c.vy = 0;
      }
      c.rot += c.vrot * dt;
      if (coinMesh) {
        k = c.t / c.life;
        sc = c.size * (k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25);
        _e.set(c.rot * 0.4, c.rot, 0);
        _q.setFromEuler(_e);
        _v.set(c.x, c.y, c.z);
        _v2.set(sc, sc, sc);
        coinMesh.setMatrixAt(i, _m.compose(_v, _q, _v2));
      }
    }
    if (coinMesh && (touched || coinDirty)) {
      coinMesh.instanceMatrix.needsUpdate = true; coinDirty = false;
    }
    // confetti: flutter, sway, tumble, settle
    touched = false;
    for (i = 0; i < CONFETTI_MAX; i++) {
      f = confs[i];
      if (!f.active) continue;
      f.t += dt;
      if (f.t >= f.life) { killConfetti(i); continue; }
      touched = true;
      f.vy -= 3.6 * dt; if (f.vy < -1.35) f.vy = -1.35;
      f.x += (f.vx + Math.sin(f.t * 5.5 + f.phase) * f.sway) * dt;
      f.z += (f.vz + Math.cos(f.t * 4.2 + f.phase) * f.sway) * dt;
      f.y += f.vy * dt;
      if (f.y < 0.02) { f.y = 0.02; f.vy = 0; }
      f.rx += f.vrx * dt; f.ry += f.vry * dt;
      if (confMesh) {
        k = f.t / f.life;
        sc = f.size * (k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2);
        _e.set(f.rx, f.ry, f.rx * 0.6);
        _q.setFromEuler(_e);
        _v.set(f.x, f.y, f.z);
        _v2.set(sc, sc, sc);
        confMesh.setMatrixAt(i, _m.compose(_v, _q, _v2));
      }
    }
    if (confMesh && (touched || confDirty)) {
      confMesh.instanceMatrix.needsUpdate = true;
      if (confMesh.instanceColor) confMesh.instanceColor.needsUpdate = true;
      confDirty = false;
    }
    // sparks: drag, light gravity, additive twinkle fade
    touched = false;
    for (i = 0; i < SPARK_MAX; i++) {
      s = sparks[i];
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.life) { killSpark(i); continue; }
      touched = true;
      drag = Math.max(0, 1 - 2.6 * dt);
      s.vx *= drag; s.vz *= drag;
      s.vy = s.vy * drag - 1.4 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      k = s.t / s.life;
      fade = (1 - k) * (0.75 + 0.25 * Math.sin(s.t * 42 + s.phase));
      sparkPos[i * 3] = s.x; sparkPos[i * 3 + 1] = s.y; sparkPos[i * 3 + 2] = s.z;
      sparkCol[i * 3] = s.r * fade;
      sparkCol[i * 3 + 1] = s.g * fade;
      sparkCol[i * 3 + 2] = s.b * fade;
    }
    if (sparkPoints && (touched || sparkDirty)) {
      sparkPosAttr.needsUpdate = true;
      sparkColAttr.needsUpdate = true;
      sparkDirty = false;
    }
    // rings: ease-out expansion + quadratic fade
    for (i = 0; i < RING_MAX; i++) {
      r = rings[i];
      if (!r.active) continue;
      r.t += dt;
      if (r.t >= r.life) { killRing(i); continue; }
      k = r.t / r.life;
      sc = r.r0 + (r.r1 - r.r0) * easeOutCubic(k);
      if (ringMeshes[i]) {
        ringMeshes[i].scale.set(sc, sc, sc);
        ringMeshes[i].material.opacity = 0.9 * (1 - k) * (1 - k);
      }
    }
    // bolts: 0.15s flickering arc
    for (i = 0; i < BOLT_MAX; i++) {
      b = bolts[i];
      if (!b.active) continue;
      b.t += dt;
      if (b.t >= b.life) { killBolt(i); continue; }
      if (boltLines[i]) {
        k = b.t / b.life;
        boltLines[i].material.opacity =
          (1 - k) * (0.6 + 0.4 * Math.abs(Math.sin(b.t * 90)));
      }
    }
    updateLabels(dt);
  }

  function updateLabels(dt) {
    var i, L, k, px, py;
    for (i = 0; i < LABEL_MAX; i++) {
      L = labels[i];
      if (!L.active) continue;
      L.t += dt;
      if (L.t >= L.dur) { killLabel(i); continue; }
      if (!projectToScreen(L.wx, L.wz, LABEL_LIFT, _pt)) { killLabel(i); continue; }
      tweenInto(L.t / L.dur, _tw);
      px = Math.round(_pt.x + L.dx);
      py = Math.round(_pt.y + _tw.rise * L.risePx);
      if (L.el) {
        if (Math.abs(px - L.lx) > 0.5 || Math.abs(py - L.ly) > 0.5) {
          L.el.style.transform = 'translate(-50%,-100%) translate3d(' + px +
            'px,' + py + 'px,0) scale(' + (Math.round(_tw.scale * 100) / 100) + ')';
          L.lx = px; L.ly = py;
        }
        L.el.style.opacity = _tw.alpha;
      }
    }
  }

  // ------------------------------------------------- camera & projection ----
  var cam = null, stage = null, viewW = 800, viewH = 600, vpT = 0;

  function refreshViewport() {
    var w = 0, h = 0;
    if (stage && stage.clientWidth) { w = stage.clientWidth; h = stage.clientHeight; }
    else if (typeof window !== 'undefined' && window.innerWidth) {
      w = window.innerWidth; h = window.innerHeight;
    }
    viewW = w > 0 ? w : 800;
    viewH = h > 0 ? h : 600;
  }

  function setCamera(nextCam, nextStage) {
    cam = nextCam || null;
    stage = nextStage || null;
    refreshViewport();
  }

  // world (x, z[, height y]) -> CSS pixels; null when no camera is set.
  function projectToScreen(x, z, optY, out) {
    out = out || { x: 0, y: 0 };
    var y = (typeof optY === 'number') ? optY : 0;
    if (!cam || !cam.projectionMatrix || !cam.matrixWorldInverse) return null;
    ndcInto(x, y, z, cam.projectionMatrix.elements, cam.matrixWorldInverse.elements, _ndcTmp);
    out.x = (_ndcTmp.x * 0.5 + 0.5) * viewW;
    out.y = (0.5 - _ndcTmp.y * 0.5) * viewH;
    return out;
  }

  // --------------------------------------------------------------- render ---
  function render(scene) {
    var T = three();
    if (!T || !scene) return false;
    if (!built && !build(T)) return false;
    if (attached !== scene) {
      if (attached) {  // re-attach (board rebuild): move, don't clone
        attached.remove(coinMesh); attached.remove(confMesh);
        attached.remove(sparkPoints);
        var i;
        for (i = 0; i < RING_MAX; i++) attached.remove(ringMeshes[i]);
        for (i = 0; i < BOLT_MAX; i++) attached.remove(boltLines[i]);
      }
      scene.add(coinMesh); scene.add(confMesh); scene.add(sparkPoints);
      var j;
      for (j = 0; j < RING_MAX; j++) scene.add(ringMeshes[j]);
      for (j = 0; j < BOLT_MAX; j++) scene.add(boltLines[j]);
      attached = scene;
    }
    return true;
  }

  // ---------------------------------------------------------------- misc ----
  function clear() {
    var i;
    for (i = 0; i < COIN_MAX; i++) if (coins[i].active) killCoin(i);
    for (i = 0; i < CONFETTI_MAX; i++) if (confs[i].active) killConfetti(i);
    for (i = 0; i < SPARK_MAX; i++) if (sparks[i].active) killSpark(i);
    for (i = 0; i < RING_MAX; i++) if (rings[i].active) killRing(i);
    for (i = 0; i < BOLT_MAX; i++) if (bolts[i].active) killBolt(i);
    for (i = 0; i < LABEL_MAX; i++) if (labels[i].active) killLabel(i);
  }

  function counts() {
    var n = 0, i;
    for (i = 0; i < LABEL_MAX; i++) if (labels[i].active) n++;
    return {
      coins: coinPool.activeCount(), confetti: confPool.activeCount(),
      sparks: sparkPool.activeCount(), rings: ringPool.activeCount(),
      bolts: boltPool.activeCount(), labels: n
    };
  }

  var api = {
    burst: burst, label: label, lightning: lightning, update: update,
    render: render, setCamera: setCamera, projectToScreen: projectToScreen,
    clear: clear, counts: counts
  };

  // ------------------------------------------------------------ self-test ---
  function selfTest() {
    var failures = 0, checks = 0;
    function check(ok, msg) {
      checks++;
      if (!ok) { failures++; console.log('  FAIL: ' + msg); }
    }
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }
    var i, j, ok, idx, tw, viol, st;

    console.log('DP.FX self-test (pure parts: no DOM, no THREE)');

    // 1. pool index math
    var p = makeIndexPool(8);
    check(p.capacity() === 8 && p.freeCount() === 8 && p.activeCount() === 0,
      'fresh pool: 8 free / 0 active');
    var order = [], seen = {};
    ok = true;
    for (i = 0; i < 8; i++) {
      idx = p.acquire();
      if (idx < 0 || seen[idx]) ok = false;
      seen[idx] = 1; order.push(idx);
    }
    check(ok && p.freeCount() === 0 && p.activeCount() === 8,
      'acquire x8 gives unique indices and exhausts the pool');
    check(p.acquire() === -1, 'acquire on a full pool returns -1');
    ok = true;
    for (i = 0; i < 8; i++) if (p.release(order[i]) !== true) ok = false;
    check(ok && p.freeCount() === 8 && p.activeCount() === 0,
      'release all returns the pool to 8 free / 0 active');
    var order2 = [];
    for (i = 0; i < 8; i++) order2.push(p.acquire());
    ok = true;
    for (i = 0; i < 8; i++) if (order2[i] !== order[7 - i]) ok = false;
    check(ok, 'wrap-around: LIFO re-acquire mirrors the release order exactly');
    check(p.release(order[0]) === true && p.release(order[0]) === false &&
      p.freeCount() === 1, 'double release is rejected; free count unchanged');
    check(p.release(-1) === false && p.release(8) === false &&
      p.release(9999) === false, 'release of invalid indices is rejected');
    var q = makeIndexPool(8), occ = new Uint8Array(8), act = 0;
    viol = 0;
    for (i = 0; i < 4000; i++) {  // randomized acquire/release stress
      if (act < 8 && (Math.random() < 0.55 || act === 0)) {
        idx = q.acquire();
        if (idx < 0 || occ[idx]) viol++;
        else { occ[idx] = 1; act++; }
      } else {
        var picks = [];
        for (j = 0; j < 8; j++) if (occ[j]) picks.push(j);
        if (picks.length) {
          var pick = picks[(Math.random() * picks.length) | 0];
          if (!q.release(pick)) viol++;
          else { occ[pick] = 0; act--; }
        }
      }
      if (q.freeCount() + q.activeCount() !== 8) viol++;
    }
    check(viol === 0, '4000 random ops: never grows, never duplicates, ' +
      'free+active == cap throughout (' + viol + ' violations)');

    // 2. label tween math
    tw = labelTween(0);
    check(tw.rise === 0 && tw.alpha === 1 && near(tw.scale, 0, 1e-12),
      'tween(0): rise 0, alpha 1, scale 0');
    tw = labelTween(1);
    check(tw.rise === -1 && tw.alpha === 0 && tw.scale === 1,
      'tween(1): rise -1, alpha 0, scale 1');
    tw = labelTween(0.3);
    check(tw.alpha === 1 && near(tw.rise, -0.657),
      'tween(0.3): alpha still holds 1, rise -0.657');
    tw = labelTween(0.65);
    check(near(tw.rise, -0.957125) && near(tw.alpha, 0.5) && tw.scale === 1,
      'tween(0.65): rise -0.957125, alpha 0.5, scale settled at 1');
    var prevRise = 1, prevAlpha = 1.1, maxScale = 0, mono = true;
    for (i = 0; i <= 100; i++) {
      tw = labelTween(i / 100);
      if (tw.rise > prevRise + 1e-12 || tw.alpha > prevAlpha + 1e-12) mono = false;
      prevRise = tw.rise; prevAlpha = tw.alpha;
      if (i / 100 < 0.12 && tw.scale > maxScale) maxScale = tw.scale;
      if (i / 100 >= 0.12 && tw.scale !== 1) mono = false;
      if (tw.alpha < 0 || tw.alpha > 1 || tw.scale < -0.01 || tw.scale > 1.2) mono = false;
    }
    check(mono, 'rise/alpha monotonic; scale bounded and settles at exactly 1');
    check(maxScale > 1.05, 'pop-in overshoots past 1.05 (peak ' +
      maxScale.toFixed(4) + ')');
    var t0 = labelTween(0), tn = labelTween(-0.5), tp = labelTween(9);
    check(tn.rise === t0.rise && tn.alpha === t0.alpha &&
      tp.rise === -1 && tp.alpha === 0, 't clamps below 0 and above 1');

    // 3. projection with a mock orthographic camera
    // THREE.Matrix4.makeOrthographic(-5, 5, 4, -4, -10, 10), column-major:
    var ORTHO = [0.2, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, -0.1, 0, 0, 0, 0, 1];
    var IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    var o = { x: 0, y: 0 };
    ndcInto(2, 1, 0, ORTHO, IDENT, o);
    check(near(o.x, 0.4) && near(o.y, 0.25), 'ortho NDC of (2,1,0) = (0.4, 0.25)');
    ndcInto(-5, -4, 0, ORTHO, IDENT, o);
    check(near(o.x, -1) && near(o.y, -1), 'ortho NDC corner (-5,-4) = (-1,-1)');
    ndcInto(5, 4, 0, ORTHO, IDENT, o);
    check(near(o.x, 1) && near(o.y, 1), 'ortho NDC corner (5,4) = (1,1)');
    var VIEWT = IDENT.slice(); VIEWT[12] = -1;  // camera translated to x=+1
    ndcInto(3, 0, 0, ORTHO, VIEWT, o);
    check(near(o.x, 0.4) && near(o.y, 0), 'view matrix applied (world x=3 at cam x=1)');
    var PERSP = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.02, -1, 0, 0, -2.02, 0];
    ndcInto(0, 0, -2, PERSP, IDENT, o);
    check(near(o.x, 0) && near(o.y, 0),
      'perspective NDC of (0,0,-2) = (0,0) dead center');
    var mockCam = {
      projectionMatrix: { elements: ORTHO },
      matrixWorldInverse: { elements: IDENT }
    };
    setCamera(mockCam, null);  // node: no window -> 800x600 fallback
    var pt = projectToScreen(2, 0, 0, { x: -1, y: -1 });
    check(pt && near(pt.x, 560) && near(pt.y, 300),
      'projectToScreen(2,0) @800x600 = (560,300)');
    projectToScreen(2, 0, 1, pt);
    check(near(pt.x, 560) && near(pt.y, 225), 'projectToScreen(2,0,y=1) = (560,225)');
    projectToScreen(-5, 0, -4, pt);
    check(near(pt.x, 0) && near(pt.y, 600), 'projectToScreen(-5,y=-4) = (0,600)');
    setCamera(mockCam, { clientWidth: 400, clientHeight: 300 });
    projectToScreen(2, 0, 0, pt);
    check(near(pt.x, 280) && near(pt.y, 150),
      'stage element size is respected: (280,150) @400x300');
    setCamera(null, null);
    check(projectToScreen(1, 1) === null, 'projectToScreen without a camera = null');
    setCamera(mockCam, null);  // restore for the lifecycle section

    // 4. color parsing
    var c1 = parseColor('#ff0000');
    check(near(c1[0], 1) && near(c1[1], 0) && near(c1[2], 0), 'parseColor #ff0000 = red');
    var c2 = parseColor('#0f0');
    check(near(c2[0], 0) && near(c2[1], 1) && near(c2[2], 0), 'parseColor #0f0 = green');
    var c3 = parseColor('#3366cc');
    check(near(c3[0], 51 / 255) && near(c3[1], 102 / 255) && near(c3[2], 204 / 255),
      'parseColor #3366cc exact');
    var c4 = parseColor('hsl(120,100%,50%)');
    check(near(c4[0], 0) && near(c4[1], 1) && near(c4[2], 0),
      'parseColor hsl(120,100%,50%) = green');
    var c5 = parseColor('nonsense'), c6 = parseColor(null);
    check(c5[0] === 1 && c5[1] === 1 && c5[2] === 1 && c6[0] === 1,
      'parseColor falls back to white for junk input');

    // 5. label slot pick/steal
    clear();
    check(labelAcquire() === 0, 'labelAcquire returns the first free slot');
    labels[0].active = true; labels[0].t = 0.1;
    check(labelAcquire() === 1, 'labelAcquire skips to the next free slot');
    for (i = 0; i < LABEL_MAX; i++) { labels[i].active = true; labels[i].t = (i + 1) / 26; }
    check(labelAcquire() === LABEL_MAX - 1,
      'when full, labelAcquire steals the slot closest to death');

    // 6. headless lifecycle (no THREE, no DOM)
    clear();
    var types = ['pop', 'merge', 'lucky', 'chain', 'jackpot', 'who-knows'];
    for (i = 0; i < 60; i++) {
      burst(types[i % types.length], (i % 7) - 3, (i % 5) - 2, {
        tier: 1 + (i % 25), lucky: i % 3 === 0,
        text: i % 10 === 0 ? '+12' : undefined
      });
    }
    for (i = 0; i < 20; i++) lightning(i - 10, 0, 10 - i, 3, { color: '#9fd0ff' });
    var cn = counts();
    check(cn.coins <= COIN_MAX && cn.confetti <= CONFETTI_MAX && cn.sparks <= SPARK_MAX &&
      cn.rings <= RING_MAX && cn.bolts <= BOLT_MAX && cn.labels <= LABEL_MAX,
      'every burst type respects its pool cap: ' + JSON.stringify(cn));
    check(coinPool.freeCount() + coinPool.activeCount() === COIN_MAX &&
      confPool.freeCount() + confPool.activeCount() === CONFETTI_MAX &&
      sparkPool.freeCount() + sparkPool.activeCount() === SPARK_MAX &&
      ringPool.freeCount() + ringPool.activeCount() === RING_MAX &&
      boltPool.freeCount() + boltPool.activeCount() === BOLT_MAX,
      'pool invariants hold under load (free+active == cap)');
    burst('pop', 'x', undefined, { tier: 'nope', count: 'x', y: 'zz' });
    lightning('a', 0, 1, 'b');
    for (i = 0; i < 40; i++) update(1 / 60);
    ok = true;
    for (i = 0; i < COIN_MAX; i++) {
      st = coins[i];
      if (st.active && !(isFinite(st.x) && isFinite(st.y) && isFinite(st.z))) ok = false;
    }
    for (i = 0; i < CONFETTI_MAX; i++) {
      st = confs[i];
      if (st.active && !(isFinite(st.x) && isFinite(st.y) && isFinite(st.z))) ok = false;
    }
    for (i = 0; i < SPARK_MAX; i++) {
      st = sparks[i];
      if (st.active && !(isFinite(st.x) && isFinite(st.y) && isFinite(st.z))) ok = false;
    }
    check(ok, 'NaN/junk burst inputs are sanitized; positions stay finite');
    for (i = 0; i < 260; i++) update(1 / 60);  // ~4.3s: longer than any life
    cn = counts();
    check(cn.coins === 0 && cn.confetti === 0 && cn.sparks === 0 &&
      cn.rings === 0 && cn.bolts === 0 && cn.labels === 0,
      'updates drain every pool back to 0: ' + JSON.stringify(cn));
    var li = label(1, 2, '+50', '#fff', 16);
    check(li !== null && counts().labels === 1, 'label() spawns headless (no DOM)');
    for (i = 0; i < 70; i++) update(1 / 60);
    check(counts().labels === 0, 'label expires after its rise+fade life');
    ok = true;
    try { update(0); update(-1); update(NaN); update(1e9); render(null); render({}); }
    catch (e) { ok = false; }
    check(ok, 'update(0|-1|NaN|huge) and render(null|fake) never throw');

    // 7. API surface
    var methods = ['burst', 'label', 'lightning', 'update', 'render', 'setCamera',
      'projectToScreen', 'clear', 'counts'];
    ok = true;
    for (i = 0; i < methods.length; i++) {
      if (typeof api[methods[i]] !== 'function') ok = false;
    }
    check(ok, 'all ' + methods.length + ' public API methods are functions');

    console.log('DP.FX self-test: ' + checks + ' checks, ' + failures + ' failure(s)');
    if (failures > 0) {
      console.log('FAIL: ' + failures + ' check(s) failed');
      if (typeof process !== 'undefined' && process.exit) process.exit(1);
    } else {
      console.log('ALL TESTS PASSED');
    }
  }

  // Node self-test: run only when executed directly (`node js/fx.js`).
  if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
      process.argv[1].endsWith('fx.js')) {
    selfTest();
  }

  return api;
})();
