/* CRYPTFALL — js/render3d.js
 * Optional three.js 3D renderer (renderer swap; zero game-logic changes).
 * - Loads after engine.js/ui.js, before main.js. Uses the vendored UMD
 *   three.min.js (global THREE). If THREE or WebGL is unavailable this module
 *   stays dormant (available=false) and the 2D canvas renderer is used.
 * - One world tile = one three.js unit. 2D world (x,y) px -> scene (x, 0, z=y).
 * - Static floor/walls/doors are merged into single BufferGeometries with baked
 *   vertex-color AO (walls darker at the base, subtle per-tile floor tone).
 * - All per-frame mesh work is pooled: enemies, projectiles, pickups, chests,
 *   dash trails, particles (one THREE.Points draw call), float text.
 * - Pure helpers (tile classification, camera/easing math, pooling, disposal)
 *   are node-safe and covered by test/render3d-test.js.
 */
var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
if (CF.TILE === undefined) CF.TILE = 40;
/* math helpers live in engine.js; mirror them so this file also runs
 * standalone under plain node (contract) without changing behavior */
if (CF.clamp === undefined) CF.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
if (CF.lerp === undefined) CF.lerp = function (a, b, t) { return a + (b - a) * t; };
if (CF.hash2 === undefined) CF.hash2 = function (x, y) {
  var h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = (Math.imul(h, 1274126177)) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

CF.Render3D = {
  version: '1.0',
  available: false,          /* true once a WebGL renderer came up */
  active: false,             /* true while it renders frames */
  S: 1 / CF.TILE,           /* world px -> scene units */
  MAX_ENEMIES: 48,
  MAX_PROJECTILES: 48,
  MAX_PICKUPS: 80,
  MAX_CHESTS: 12,
  MAX_PARTICLES: 320,
  MAX_TRAILS: 10,
  MAX_FLOATS: 64,

  /* ============ PURE HELPERS (node-safe, no THREE) ============ */

  /* tile values per CONTRACTS: 0 wall, 1 floor, 2 door, 3 exit stairs */
  isWallTile: function (t) { return t === 0; },
  isWalkableTile: function (t) { return t !== 0; },
  tileKind: function (t) {
    return t === 0 ? 'wall' : (t === 1 ? 'floor' : (t === 2 ? 'door' : 'stairs'));
  },

  /* wall tiles worth meshing: only those touching a walkable tile (8-dir) */
  collectWallTiles: function (d) {
    var out = [], W = d.width, H = d.height, T = d.tiles, x, y, i, dx, dy, tx, ty;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        i = y * W + x;
        if (T[i] !== 0) continue;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            tx = x + dx; ty = y + dy;
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
            if (T[ty * W + tx] !== 0) { out.push({ x: x, y: y }); dx = 2; dy = 2; break; }
          }
        }
      }
    }
    return out;
  },

  worldToScene: function (x, y) { var s = 1 / CF.TILE; return { x: x * s, z: y * s }; },

  /* framerate-independent lerp factor: k in [0,1), k(0)=0 */
  lerpRate: function (dt, base) {
    if (!(dt > 0)) return 0;
    return 1 - Math.pow(base, dt);
  },

  /* shortest-path angular lerp */
  angleLerp: function (a, b, t) {
    var d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + d * t;
  },

  /* easeOutBack: e(0)=0, e(1)=1, overshoots in between */
  easeOutBack: function (t) {
    t = CF.clamp(t, 0, 1);
    var c1 = 1.70158, c3 = c1 + 1, u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  },

  /* deterministic torch flicker in [0,1] */
  flicker: function (t) {
    var v = 0.5 + 0.25 * Math.sin(t * 7.1) + 0.14 * Math.sin(t * 13.7) + 0.07 * Math.sin(t * 23.9);
    return CF.clamp(v, 0, 1);
  },

  /* deterministic per-tile brightness variance in [0,1) */
  floorTone: function (x, y) { return CF.hash2(x, y); },

  /* floor darkening next to n wall neighbors (baked AO) */
  aoWalls: function (n) { return 1 - Math.min(n, 4) * 0.055; },

  _colorCache: {},
  hexToRGB: function (h) {
    var key = String(h);
    if (CF.Render3D._colorCache[key]) return CF.Render3D._colorCache[key];
    var s = key.replace('#', '');
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    var v = {
      r: parseInt(s.substring(0, 2), 16) / 255,
      g: parseInt(s.substring(2, 4), 16) / 255,
      b: parseInt(s.substring(4, 6), 16) / 255
    };
    if (!isFinite(v.r) || !isFinite(v.g) || !isFinite(v.b)) v = { r: 1, g: 1, b: 1 };
    CF.Render3D._colorCache[key] = v;
    return v;
  },

  /* generic capped pool: acquire never grows past cap, released objects are reused */
  makePool: function (cap, factory) {
    return {
      cap: cap, live: 0, _free: [],
      acquire: function () {
        if (this._free.length) return this._free.pop();
        if (this.live >= this.cap) return null;
        this.live++;
        return factory();
      },
      release: function (o) { if (o != null) this._free.push(o); },
      inUse: function () { return this.live - this._free.length; }
    };
  },

  /* recursively dispose geometries + materials of a THREE-like tree.
   * shared materials/geometries are disposed exactly once. returns count. */
  disposeObject3D: function (root) {
    if (!root) return 0;
    var seen = [], n = 0;
    function disp(res) {
      if (!res || typeof res.dispose !== 'function') return;
      if (seen.indexOf(res) !== -1) return;
      seen.push(res);
      res.dispose();
      n++;
    }
    function walk(o) {
      if (!o) return;
      disp(o.geometry);
      var m = o.material;
      if (m) {
        if (Array.isArray(m)) { for (var i = 0; i < m.length; i++) disp(m[i]); }
        else disp(m);
      }
      var ch = o.children;
      if (ch) for (var c = 0; c < ch.length; c++) walk(ch[c]);
    }
    walk(root);
    return n;
  },

  /* camera aim-follow target in scene units */
  cameraGoal: function (px, py, aim, lookahead) {
    var s = 1 / CF.TILE;
    return {
      x: px * s + Math.cos(aim) * lookahead,
      z: py * s + Math.sin(aim) * lookahead
    };
  },

  /* ---- float-text projection (world px -> screen px) ---- */
  _floatSlots: (function () {
    var a = [], i;
    for (i = 0; i < 64; i++) a.push({ x: 0, y: 0, text: '', color: '#fff', size: 14, alpha: 1 });
    return a;
  })(),
  _floatOut: { items: null, count: 0 },
  _camera: null,          /* set by init() in the browser */
  _snap: false,           /* new floor: snap camera target to the player */

  projectedFloats: function (game) {
    var out = CF.Render3D._floatOut;
    out.items = CF.Render3D._floatSlots;
    out.count = 0;
    if (!CF.Render3D.active || !CF.Render3D._camera) return out;
    var L = CF.FloatText.list, n = Math.min(L.length, CF.Render3D.MAX_FLOATS);
    var cam = CF.Render3D._camera, v = CF.Render3D._pv;
    for (var i = 0; i < n; i++) {
      var f = L[i], slot = out.items[i];
      v.set(f.x * CF.Render3D.S, 1.1 + f.life * 0.9, f.y * CF.Render3D.S).project(cam);
      slot.x = (v.x * 0.5 + 0.5) * CF.Engine.W;
      slot.y = (-v.y * 0.5 + 0.5) * CF.Engine.H;
      slot.text = f.text; slot.color = f.color; slot.size = f.size;
      slot.alpha = CF.clamp(1 - f.life / f.maxLife, 0, 1);
    }
    out.count = n;
    return out;
  },

  drawProjectedFloats: function (ctx, game) {
    var out = this.projectedFloats(game);
    var n = out.count;
    if (n === 0) return;
    ctx.textAlign = 'center';
    for (var i = 0; i < n; i++) {
      var f = out.items[i];
      ctx.globalAlpha = f.alpha;
      ctx.font = 'bold ' + f.size + 'px monospace';
      ctx.fillStyle = '#000';
      ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  },

  /* ============ NODE SELF-TEST ============ */
  _selfTest: function () {
    var R = CF.Render3D, pass = 0, fail = 0;
    function check(name, cond) {
      if (cond) { pass++; console.log('PASS: ' + name); }
      else { fail++; console.log('FAIL: ' + name); }
    }
    check('dormant without DOM/THREE', R.available === false && R.active === false);
    check('tileKind classification', R.tileKind(0) === 'wall' && R.tileKind(1) === 'floor' &&
      R.tileKind(2) === 'door' && R.tileKind(3) === 'stairs');
    check('worldToScene scale', (function () { var p = R.worldToScene(120, 200); return p.x === 3 && p.z === 5; })());
    check('empty projection when dormant', R.projectedFloats({}).count === 0);
    check('lerpRate(0) is 0', R.lerpRate(0, 0.0008) === 0);
    var k1 = R.lerpRate(0.016, 0.0008), k2 = R.lerpRate(0.032, 0.0008);
    check('lerpRate framerate independence', Math.abs(1 - Math.pow(1 - k1, 2) - k2) < 1e-9);
    check('easeOutBack endpoints', Math.abs(R.easeOutBack(0)) < 1e-6 && Math.abs(R.easeOutBack(1) - 1) < 1e-6 && R.easeOutBack(0.5) > 1);
    check('angleLerp wraps shortest path', Math.abs(R.angleLerp(3.0, -3.0, 0.5) - Math.PI) < 1e-9);
    var pool = R.makePool(4, function () { return { id: Math.random() }; });
    var a = pool.acquire(), ok = pool.live <= 4;
    pool.release(a);
    check('pool reuses released object', pool.acquire() === a && pool.live <= 4);
    console.log(fail === 0 ? 'ALL TESTS PASSED (' + pass + ')' : 'FAILED: ' + fail);
    return fail === 0;
  }
};

/* ============ BROWSER-ONLY 3D IMPLEMENTATION ============ */
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof THREE !== 'undefined') {
  (function () {
    var R = CF.Render3D;
    var S = R.S;
    var T = CF.TILE;

    /* ---- palette (cohesive dark-fantasy: blue-violet shadow, torch gold, cyan magic) ---- */
    var PAL = {
      bg: 0x060508,
      fogNear: 9, fogFar: 30,
      ambient: 0x1a1a2e,
      hemiSky: 0x252047, hemiGround: 0x0b0912,
      torch: 0xffa050, stairs: 0x7de8ff, boss: 0xa06bff,
      wallTop: [0.20, 0.17, 0.29], wallBot: 0.42,
      floorBase: [0.145, 0.135, 0.20],
      door: 0x5d452c, doorTrim: 0x3f2e1c,
      cloak: '#2b3352', hood: '#8494c9', head: '#20263f',
      eyes: 0xbaffe8, enemyEyes: 0xff5a5a,
      trail: 0x4da6ff, arc: 0xcfe6ff,
      gold: 0xffd94a
    };

    /* ---- preallocated temps (zero per-frame allocation) ---- */
    var _v2 = new THREE.Vector2();
    var _v3 = new THREE.Vector3();
    var _pv = R._pv = new THREE.Vector3();
    var _look = new THREE.Vector3();
    var _ray = new THREE.Raycaster();
    var _swRes = { x: 0, y: 0 };
    var _wsRes = { x: 0, y: 0 };

    /* camera rig: ~55 degrees from vertical top-down */
    var CAM = { fov: 52, dist: 15, pitch: 35 * Math.PI / 180, look: 1.5 };
    CAM.h = CAM.dist * Math.sin(CAM.pitch);
    CAM.back = CAM.dist * Math.cos(CAM.pitch);

    var _renderer, _scene, _camera, _canvas;
    var _floorGroup, _floorGeos = [], _floorMats = [], _floorRef = null;
    var _ambient, _hemi, _torch, _stairsLight, _bossLight;
    var _ptUniformScale = 1;
    var _weaponId = null, _weaponIsMelee = true, _weaponMat, _weaponMesh, _weaponHolder;
    var _playerGroup, _playerBody, _playerBodyMat, _playerEyes, _arcMesh, _arcMat, _torchGlowMat, _torchGlow;
    var _trailPool = [], _enemySlots = [], _projSlots = [], _pickupSlots = [], _chestSlots = [];
    var _ghostPool = [], _puffPool = [];
    var _enemyGeoCache = {}, _eyesTexCache = {};
    var _steps = { x: 0, y: 0, t: 0 };
    var _camTarget = { x: 0, z: 0 };
    var _bossLightI = 0;

    /* ================= textures ================= */
    var _discTexCache = {};
    function softDiscTexture(hex, inner) {
      var key = hex + '|' + inner;
      if (_discTexCache[key]) return _discTexCache[key];
      var c = document.createElement('canvas');
      c.width = c.height = 64;
      var g = c.getContext('2d');
      var col = R.hexToRGB(hex);
      var grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grd.addColorStop(0, 'rgba(' + Math.round(col.r * 255) + ',' + Math.round(col.g * 255) + ',' + Math.round(col.b * 255) + ',1)');
      grd.addColorStop(inner || 0.35, 'rgba(' + Math.round(col.r * 255) + ',' + Math.round(col.g * 255) + ',' + Math.round(col.b * 255) + ',0.45)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      var tex = new THREE.CanvasTexture(c);
      _discTexCache[key] = tex;
      return tex;
    }

    function eyesTexture(hex) {
      if (_eyesTexCache[hex]) return _eyesTexCache[hex];
      var c = document.createElement('canvas');
      c.width = 64; c.height = 32;
      var g = c.getContext('2d');
      g.shadowColor = hex; g.shadowBlur = 7;
      g.fillStyle = hex;
      g.fillRect(14, 11, 8, 8);
      g.fillRect(42, 11, 8, 8);
      var tex = new THREE.CanvasTexture(c);
      _eyesTexCache[hex] = tex;
      return tex;
    }

    /* ================= geometry helpers ================= */
    function applyVertColors(geo, hex, gradMin, brightness) {
      var c = R.hexToRGB(hex);
      var b = brightness === undefined ? 1 : brightness;
      var pos = geo.attributes.position;
      var arr = new Float32Array(pos.count * 3);
      var minY = Infinity, maxY = -Infinity, i, y;
      if (gradMin !== undefined) {
        for (i = 0; i < pos.count; i++) {
          y = pos.getY(i);
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      var span = (maxY > minY) ? (maxY - minY) : 1;
      for (i = 0; i < pos.count; i++) {
        var f = b;
        if (gradMin !== undefined) f = b * (gradMin + (1 - gradMin) * ((pos.getY(i) - minY) / span));
        arr[i * 3] = c.r * f; arr[i * 3 + 1] = c.g * f; arr[i * 3 + 2] = c.b * f;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }

    function mergeGeos(list) {
      var pos = [], nrm = [], col = [], idx = [], off = 0, i, j;
      for (i = 0; i < list.length; i++) {
        var g = list[i];
        var p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
        for (j = 0; j < p.count; j++) {
          pos.push(p.getX(j), p.getY(j), p.getZ(j));
          nrm.push(n.getX(j), n.getY(j), n.getZ(j));
          col.push(c.getX(j), c.getY(j), c.getZ(j));
        }
        if (g.index) { for (j = 0; j < g.index.count; j++) idx.push(g.index.getX(j) + off); }
        else { for (j = 0; j < p.count; j++) idx.push(j + off); }
        off += p.count;
        g.dispose();
      }
      var out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      out.setIndex(idx);
      return out;
    }

    /* push an axis-aligned box (5 faces, no bottom) into raw arrays */
    function pushBox(P, N, C, I, cx, cz, hw, hh, hd, top, bot) {
      var base = P.length / 3, x0 = cx - hw, x1 = cx + hw, z0 = cz - hd, z1 = cz + hd, y0 = 0, y1 = hh;
      function quad(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx2, dy2, dz2, nx, ny, nz, cA, cB) {
        var s = P.length / 3;
        P.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx2, dy2, dz2);
        var k;
        for (k = 0; k < 4; k++) { N.push(nx, ny, nz); C.push(0, 0, 0); }
        C[s * 3] = cA[0]; C[s * 3 + 1] = cA[1]; C[s * 3 + 2] = cA[2];
        C[(s + 1) * 3] = cB[0]; C[(s + 1) * 3 + 1] = cB[1]; C[(s + 1) * 3 + 2] = cB[2];
        C[(s + 2) * 3] = cB[0]; C[(s + 2) * 3 + 1] = cB[1]; C[(s + 2) * 3 + 2] = cB[2];
        C[(s + 3) * 3] = cA[0]; C[(s + 3) * 3 + 1] = cA[1]; C[(s + 3) * 3 + 2] = cA[2];
        I.push(s, s + 1, s + 2, s, s + 2, s + 3);
      }
      quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, bot, top);   /* +Z */
      quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, bot, top);  /* -Z */
      quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, bot, top);   /* +X */
      quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, bot, top);  /* -X */
      quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0, top, top);   /* top (CCW from above) */
      return base;
    }

    function pushQuadY(P, N, C, I, cx, cz, hw, hd, y, col) {
      var s = P.length / 3;
      P.push(cx - hw, y, cz - hd, cx + hw, y, cz - hd, cx + hw, y, cz + hd, cx - hw, y, cz + hd);
      var k;
      for (k = 0; k < 4; k++) { N.push(0, 1, 0); C.push(col[0], col[1], col[2]); }
      I.push(s, s + 2, s + 1, s, s + 3, s + 2);
    }

    /* ================= static floor build ================= */
    function disposeFloor() {
      var i;
      for (i = 0; i < _floorGeos.length; i++) _floorGeos[i].dispose();
      _floorGeos.length = 0;
      for (i = 0; i < _floorMats.length; i++) _floorMats[i].dispose();
      _floorMats.length = 0;
      while (_floorGroup.children.length) _floorGroup.remove(_floorGroup.children[0]);
      _floorRef = null;
    }

    R.buildFloor = function (d) {
      if (!_scene) return;
      disposeFloor();
      var W = d.width, H = d.height, Ti = d.tiles;
      var walls = R.collectWallTiles(d);
      var wallSet = {};
      var i, k;
      for (i = 0; i < walls.length; i++) wallSet[walls[i].y * W + walls[i].x] = 1;

      var fP = [], fN = [], fC = [], fI = [];
      var wP = [], wN = [], wC = [], wI = [];
      var dP = [], dN = [], dC = [], dI = [];
      var x, y, t, v, m, col, nearWalls;

      for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
          t = Ti[y * W + x];
          if (t === 0) {
            if (!wallSet[y * W + x]) continue;
            v = R.floorTone(x * 3 + 11, y * 7 + 5);
            m = 0.82 + 0.36 * v;
            pushBox(wP, wN, wC, wI, x + 0.5, y + 0.5, 0.5, 1.0, 0.5,
              [PAL.wallTop[0] * m, PAL.wallTop[1] * m, PAL.wallTop[2] * m],
              [PAL.wallTop[0] * m * PAL.wallBot, PAL.wallTop[1] * m * PAL.wallBot, PAL.wallTop[2] * m * PAL.wallBot]);
          } else {
            nearWalls = 0;
            if (x > 0 && Ti[y * W + x - 1] === 0) nearWalls++;
            if (x < W - 1 && Ti[y * W + x + 1] === 0) nearWalls++;
            if (y > 0 && Ti[(y - 1) * W + x] === 0) nearWalls++;
            if (y < H - 1 && Ti[(y + 1) * W + x] === 0) nearWalls++;
            v = R.floorTone(x, y);
            m = (0.9 + 0.2 * v) * R.aoWalls(nearWalls);
            col = [PAL.floorBase[0] * m, PAL.floorBase[1] * m, PAL.floorBase[2] * m * (0.9 + 0.35 * v)];
            pushQuadY(fP, fN, fC, fI, x + 0.5, y + 0.5, 0.5, 0.5, 0, col);
            if (t === 2) {
              var dm = 0.85 + 0.3 * R.floorTone(x + 7, y + 3);
              var dw = R.hexToRGB('#5d452c');
              pushBox(dP, dN, dC, dI, x + 0.5, y + 0.5, 0.48, 0.055, 0.2,
                [dw.r * dm, dw.g * dm, dw.b * dm], [dw.r * dm * 0.6, dw.g * dm * 0.6, dw.b * dm * 0.6]);
            }
          }
        }
      }

      function mesh(P, N, C, I, mat) {
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
        g.setIndex(I);
        _floorGeos.push(g);
        var m2 = new THREE.Mesh(g, mat);
        _floorGroup.add(m2);
        return m2;
      }

      var wallMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      var floorMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      var doorMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      _floorMats.push(wallMat, floorMat, doorMat);
      mesh(wP, wN, wC, wI, wallMat);
      mesh(fP, fN, fC, fI, floorMat);
      if (dI.length) mesh(dP, dN, dC, dI, doorMat);

      /* stairs: emissive platform + light column at the exit */
      var ex = (d.exit.x + 0.5) * 1, ez = (d.exit.y + 0.5) * 1;
      _stairsMesh.position.set(ex, 0.035, ez);
      _columnMesh.position.set(ex, 1.6, ez);
      _stairsLight.position.set(ex, 1.0, ez);
      _floorRef = d;
      R._floorRef = d;   /* introspection mirror */
      R._snap = true;
    };

    /* ================= entity geometries ================= */
    function makeArcGeo(arc, range) {
      var g = new THREE.RingGeometry(0.22, range, 22, 1, -arc / 2, arc);
      g.rotateX(-Math.PI / 2);
      return g;
    }

    function getEnemyGeo(def) {
      if (_enemyGeoCache[def.id]) return _enemyGeoCache[def.id];
      var sphere = new THREE.SphereGeometry(1, 14, 11);
      applyVertColors(sphere, def.color, 0.55);
      var rim = new THREE.TorusGeometry(1.02, 0.05, 6, 22);
      rim.rotateX(Math.PI / 2);
      applyVertColors(rim, def.accent, undefined, 1.15);
      var geo = mergeGeos([sphere, rim]);
      _enemyGeoCache[def.id] = geo;
      return geo;
    }

    function buildPlayerGeo() {
      var cone = new THREE.ConeGeometry(0.30, 0.60, 10, 1, true);
      cone.translate(0, 0.30, 0);
      applyVertColors(cone, PAL.cloak, 0.6);
      var rim = new THREE.TorusGeometry(0.16, 0.032, 6, 14);
      rim.rotateX(Math.PI / 2);
      rim.translate(0, 0.545, 0);
      applyVertColors(rim, PAL.hood, undefined, 1.1);
      var head = new THREE.SphereGeometry(0.135, 10, 8);
      head.translate(0, 0.575, 0);
      applyVertColors(head, PAL.head);
      return mergeGeos([cone, rim, head]);
    }

    function buildWeaponGeo(w) {
      var parts = [];
      if (w.projectile) {
        var shaft = new THREE.BoxGeometry(0.05, 0.05, 0.42);
        shaft.translate(0.21, 0, 0);
        applyVertColors(shaft, w.color || '#cfd6e4');
        parts.push(shaft);
        if (w.projectile.color) {
          var tip = new THREE.SphereGeometry(0.045, 8, 6);
          tip.translate(0.44, 0, 0);
          applyVertColors(tip, w.projectile.color, undefined, 1.6);
          parts.push(tip);
        }
      } else {
        var len = Math.min(0.42, (w.range || 52) * S * 0.55);
        var blade = new THREE.BoxGeometry(len, 0.028, 0.07);
        blade.translate(0.09 + len / 2, 0, 0);
        applyVertColors(blade, w.color || '#cfd6e4', undefined, 1.25);
        parts.push(blade);
        var grip = new THREE.BoxGeometry(0.1, 0.05, 0.05);
        grip.translate(0.05, 0, 0);
        applyVertColors(grip, '#6b5a3f');
        parts.push(grip);
      }
      return mergeGeos(parts);
    }

    /* ================= pooled slots ================= */
    function makeTrailSlot() {
      var geo = new THREE.ConeGeometry(0.27, 0.56, 8, 1, true);
      geo.translate(0, 0.28, 0);
      var mat = new THREE.MeshBasicMaterial({
        color: PAL.trail, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending
      });
      var m = new THREE.Mesh(geo, mat);
      m.visible = false;
      _scene.add(m);
      return { mesh: m, mat: mat };
    }

    function makeWindupRing() {
      var geo = new THREE.RingGeometry(0.78, 1, 26);
      geo.rotateX(-Math.PI / 2);
      var mat = new THREE.MeshBasicMaterial({
        color: 0xff3a3a, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      });
      var m = new THREE.Mesh(geo, mat);
      m.position.y = 0.03;
      m.visible = false;
      return m;
    }

    var _crownGeo = null, _crownMat = null;

    function makeEnemySlot() {
      var g = new THREE.Group();
      var bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true });
      var body = new THREE.Mesh(getEnemyGeo(CF.ENEMIES.rat), bodyMat);
      var eyes = new THREE.Sprite(new THREE.SpriteMaterial({
        map: eyesTexture('#ff5a5a'), transparent: true, depthWrite: false
      }));
      var ring = makeWindupRing();
      var hpBg = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softDiscTexture('#101018', 0.9), transparent: true, depthWrite: false, opacity: 0.75
      }));
      hpBg.center.set(0.5, 0.5);
      var hpFg = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softDiscTexture('#ff5a5a', 0.9), transparent: true, depthWrite: false
      }));
      hpFg.center.set(0, 0.5);
      var crown = new THREE.Group();
      if (!_crownGeo) {
        _crownGeo = new THREE.ConeGeometry(0.09, 0.32, 5);
        _crownMat = new THREE.MeshLambertMaterial({ color: PAL.gold, emissive: 0x4a3a08 });
      }
      for (var s = 0; s < 5; s++) {
        var spike = new THREE.Mesh(_crownGeo, _crownMat);
        var a = (s - 2) * 0.5;
        spike.position.set(Math.sin(a) * 0.5, 0.13, Math.cos(a) * 0.5);
        spike.rotation.z = -a * 0.5;
        crown.add(spike);
      }
      crown.visible = false;
      /* body rig rotates to face the player; hp sprites live in world space
       * so the bar never swings around the enemy as it turns */
      g.add(body, eyes, ring, crown);
      _scene.add(g, hpBg, hpFg);
      hpBg.visible = false; hpFg.visible = false;
      return {
        group: g, body: body, bodyMat: bodyMat, eyes: eyes, ring: ring,
        hpBg: hpBg, hpFg: hpFg, crown: crown,
        defId: null, accent: { r: 1, g: 0.2, b: 0.2 }, wraith: false,
        phase: Math.random() * 6, moving: 0,
        lastX: 0, lastY: 0, lastX2: 0, lastY2: 0, lastR: 0, lastHex: '#ffffff',
        lastEnemy: null
      };
    }

    function configureEnemySlot(slot, def) {
      slot.defId = def.id;
      slot.body.geometry = getEnemyGeo(def);
      slot.bodyMat.opacity = 1;
      slot.wraith = (def.id === 'wraith');
      var acc = R.hexToRGB(def.accent || '#ff5a5a');
      slot.accent = acc;
    }

    function makeProjSlot() {
      var mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      var m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), mat);
      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softDiscTexture('#ffffff', 0.3), transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55
      }));
      var g = new THREE.Group();
      g.add(m, glow);
      g.visible = false;
      _scene.add(g);
      return { group: g, core: m, mat: mat, glow: glow, last: null };
    }

    function makePickupSlot() {
      var g = new THREE.Group();
      var core = new THREE.Group();
      /* coin */
      var coinMat = new THREE.MeshLambertMaterial({ color: PAL.gold, emissive: 0x6a4a08 });
      var coin = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.024, 12), coinMat);
      coin.rotation.z = Math.PI / 2;
      /* potion flask */
      var flask = new THREE.Group();
      var flaskMat = new THREE.MeshLambertMaterial({ color: 0x4a90d9, emissive: 0x1a3050 });
      var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), flaskMat);
      bulb.scale.y = 1.15;
      var neckM = new THREE.MeshLambertMaterial({ color: 0xcfe6ff, emissive: 0x223344 });
      var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.06, 8), neckM);
      neck.position.y = 0.11;
      var cork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 6),
        new THREE.MeshLambertMaterial({ color: 0x6b4f2e }));
      cork.position.y = 0.15;
      flask.add(bulb, neck, cork);
      /* gear: sword */
      var gear = new THREE.Group();
      var gearMat = new THREE.MeshLambertMaterial({ color: 0xcfd6e4 });
      var blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.3, 0.08), gearMat);
      blade.position.y = 0.1;
      var guard = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.03, 0.045),
        new THREE.MeshLambertMaterial({ color: 0x6b5a3f }));
      var pommel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.04),
        new THREE.MeshLambertMaterial({ color: 0x3a2d1c }));
      pommel.position.y = -0.08;
      gear.add(blade, guard, pommel);
      /* heart */
      var heart = new THREE.Mesh(new THREE.OctahedronGeometry(0.09),
        new THREE.MeshLambertMaterial({ color: 0xff5a7a, emissive: 0x661022 }));
      core.add(coin, flask, gear, heart);
      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softDiscTexture('#ffd94a', 0.3), transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3
      }));
      glow.scale.set(0.5, 0.5, 1);
      g.add(core, glow);
      g.visible = false;
      _scene.add(g);
      return { group: g, core: core, coin: coin, flask: flask, flaskMat: flaskMat, gear: gear, gearMat: gearMat, heart: heart, glow: glow, last: null, spawnT: 0 };
    }

    function makeChestSlot() {
      var g = new THREE.Group();
      var bodyMat = new THREE.MeshLambertMaterial({ color: 0x6b4f2e });
      var body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.3, 0.42), bodyMat);
      body.position.y = 0.15;
      var trimMat = new THREE.MeshLambertMaterial({ color: 0x3a2d1c });
      var trim = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.05, 0.44), trimMat);
      trim.position.y = 0.02;
      var lidPivot = new THREE.Group();
      lidPivot.position.set(0, 0.3, -0.21);
      var lidMat = new THREE.MeshLambertMaterial({ color: 0x8a6a3f });
      var lid = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.42), lidMat);
      lid.position.set(0, 0.06, 0.21);
      var lock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.04),
        new THREE.MeshLambertMaterial({ color: PAL.gold, emissive: 0x332200 }));
      lock.position.set(0, 0.02, 0.42);
      lidPivot.add(lid);
      g.add(body, trim, lidPivot, lock);
      g.visible = false;
      _scene.add(g);
      return { group: g, lidPivot: lidPivot, bodyMat: bodyMat, lidMat: lidMat, lock: lock, last: null, openT: 0 };
    }

    function makeGhostSlot() {
      var mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending
      });
      var m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), mat);
      m.visible = false;
      _scene.add(m);
      return { mesh: m, mat: mat, life: -1, x: 0, z: 0, r: 0.3 };
    }

    function makePuffSlot() {
      var mat = new THREE.MeshBasicMaterial({
        map: softDiscTexture('#8a7a66', 0.25), color: 0x8a7a66, transparent: true, opacity: 0,
        depthWrite: false
      });
      var m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.035;
      m.visible = false;
      _scene.add(m);
      return { mesh: m, mat: mat, life: -1, x: 0, z: 0 };
    }

    /* ================= particle Points system ================= */
    var PARTICLE_VERT =
      'attribute float aSize;\n' +
      'attribute vec3 aColor;\n' +
      'attribute float aAlpha;\n' +
      'varying vec3 vColor;\n' +
      'varying float vAlpha;\n' +
      'void main() {\n' +
      '  vColor = aColor; vAlpha = aAlpha;\n' +
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
      '  gl_PointSize = aSize * (uScale / -mv.z);\n' +
      '  gl_Position = projectionMatrix * mv;\n' +
      '}';
    var PARTICLE_FRAG =
      'varying vec3 vColor;\n' +
      'varying float vAlpha;\n' +
      'void main() {\n' +
      '  float d = length(gl_PointCoord - vec2(0.5));\n' +
      '  if (d > 0.5) discard;\n' +
      '  float a = vAlpha * smoothstep(0.5, 0.1, d);\n' +
      '  gl_FragColor = vec4(vColor * a, a);\n' +
      '}';

    function makePointsSystem(count) {
      var geo = new THREE.BufferGeometry();
      var pos = new Float32Array(count * 3);
      var col = new Float32Array(count * 3);
      var siz = new Float32Array(count);
      var alp = new Float32Array(count);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1).setUsage(THREE.DynamicDrawUsage));
      geo.setDrawRange(0, 0);
      var mat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: 300 } },
        vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
      });
      var points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      return { geo: geo, points: points, mat: mat, pos: pos, col: col, siz: siz, alp: alp, count: count };
    }

    var _particles, _motes, _moteSeed = [];

    /* ================= camera patches ================= */
    R._screenToWorld = function (sx, sy) {
      _v2.x = (sx / CF.Engine.W) * 2 - 1;
      _v2.y = -(sy / CF.Engine.H) * 2 + 1;
      _ray.setFromCamera(_v2, _camera);
      var o = _ray.ray.origin, dir = _ray.ray.direction;
      if (Math.abs(dir.y) < 1e-6) { _swRes.x = o.x * T; _swRes.y = o.z * T; return _swRes; }
      var t = -o.y / dir.y;
      _swRes.x = (o.x + dir.x * t) * T;
      _swRes.y = (o.z + dir.z * t) * T;
      return _swRes;
    };
    R._worldToScreen = function (wx, wy) {
      _v3.set(wx * S, 1.0, wy * S).project(_camera);
      _wsRes.x = (_v3.x * 0.5 + 0.5) * CF.Engine.W;
      _wsRes.y = (-_v3.y * 0.5 + 0.5) * CF.Engine.H;
      return _wsRes;
    };

    /* ================= stairs meshes (static geometry, moved per floor) ================= */
    var _stairsMesh, _columnMesh;

    R.init = function (canvasEl) {
      if (!canvasEl) throw new Error('no 3D canvas');
      _canvas = canvasEl;
      _renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      _renderer.setClearColor(PAL.bg, 1);

      _scene = new THREE.Scene();
      _scene.fog = new THREE.Fog(PAL.bg, PAL.fogNear, PAL.fogFar);
      R._scene = _scene;

      _camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.1, 80);
      R._camera = _camera;

      _ambient = new THREE.AmbientLight(PAL.ambient, 1.15);
      _hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 0.55);
      _torch = new THREE.PointLight(PAL.torch, 2.0, 7.5, 2);
      _stairsLight = new THREE.PointLight(PAL.stairs, 1.6, 7, 2);
      _bossLight = new THREE.PointLight(PAL.boss, 0, 9, 2);
      _scene.add(_ambient, _hemi, _torch, _stairsLight, _bossLight);

      _floorGroup = new THREE.Group();
      _scene.add(_floorGroup);
      R._floorGroup = _floorGroup;

      _stairsMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.84, 0.07, 0.84),
        new THREE.MeshBasicMaterial({ color: 0x175a66 })
      );
      _columnMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.42, 3.2, 14, 1, true),
        new THREE.MeshBasicMaterial({
          color: PAL.stairs, transparent: true, opacity: 0.12,
          depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
        })
      );
      _scene.add(_stairsMesh, _columnMesh);

      /* player rig */
      _playerGroup = new THREE.Group();
      _playerBodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true });
      _playerBody = new THREE.Mesh(buildPlayerGeo(), _playerBodyMat);
      _playerEyes = new THREE.Sprite(new THREE.SpriteMaterial({
        map: eyesTexture('#baffe8'), transparent: true, depthWrite: false
      }));
      _playerEyes.position.set(0.105, 0.575, 0);
      _playerEyes.scale.set(0.17, 0.085, 1);
      _playerBody.add(_playerEyes);
      _weaponHolder = new THREE.Group();
      _weaponHolder.position.set(0, 0.32, 0);
      _playerBody.add(_weaponHolder);
      _arcMat = new THREE.MeshBasicMaterial({
        color: PAL.arc, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      });
      _arcMesh = new THREE.Mesh(makeArcGeo(1.2, 0.9), _arcMat);
      _arcMesh.position.y = 0.055;
      _arcMesh.visible = false;
      _playerGroup.add(_playerBody, _arcMesh);
      _torchGlowMat = new THREE.SpriteMaterial({
        map: softDiscTexture('#ffa050', 0.25), transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.12
      });
      _torchGlow = new THREE.Sprite(_torchGlowMat);
      _torchGlow.scale.set(2.4, 2.4, 1);
      _playerGroup.add(_torchGlow);
      _scene.add(_playerGroup);

      var i;
      for (i = 0; i < R.MAX_TRAILS; i++) _trailPool.push(makeTrailSlot());
      for (i = 0; i < 8; i++) _ghostPool.push(makeGhostSlot());
      for (i = 0; i < 8; i++) _puffPool.push(makePuffSlot());

      _particles = makePointsSystem(R.MAX_PARTICLES);
      _motes = makePointsSystem(44);
      _scene.add(_particles.points, _motes.points);
      for (i = 0; i < 44; i++) {
        _moteSeed.push({ x: Math.random() * 6 - 3, y: 0.2 + Math.random() * 1.8, z: Math.random() * 6 - 3, v: 0.1 + Math.random() * 0.25, p: Math.random() * 6 });
      }

      this.resize();
      window.addEventListener('resize', function () { try { R.resize(); } catch (e) {} });

      /* render one empty frame so the canvas isn't stale */
      _renderer.render(_scene, _camera);
    };

    R.resize = function () {
      if (!_renderer) return;
      var w = window.innerWidth, h = window.innerHeight;
      _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      _renderer.setSize(w, h, false);
      _canvas.style.width = w + 'px';
      _canvas.style.height = h + 'px';
      _camera.aspect = w / h;
      _camera.updateProjectionMatrix();
      /* pixel-accurate point sprites: screenH / (2*tan(fov/2)) */
      _ptUniformScale = (_renderer.domElement.height) / (2 * Math.tan(CAM.fov * Math.PI / 360));
      _particles.mat.uniforms.uScale.value = _ptUniformScale;
      _motes.mat.uniforms.uScale.value = _ptUniformScale;
    };

    /* ================= weapon swap ================= */
    function syncWeapon(p) {
      var w = p.weapon;
      var id = w ? w.id : null;
      if (id === _weaponId) return;
      _weaponId = id;
      if (_weaponMesh) {
        _weaponHolder.remove(_weaponMesh);
        _weaponMesh.geometry.dispose();
        _weaponMesh = null;
      }
      if (!w) { _weaponIsMelee = true; return; }
      _weaponIsMelee = !w.projectile;
      if (_weaponMat) _weaponMat.dispose();
      _weaponMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true });
      if (w.projectile && w.projectile.color) {
        var wc = R.hexToRGB(w.projectile.color);
        _weaponMat.emissive.setRGB(wc.r * 0.7, wc.g * 0.7, wc.b * 0.7);
      }
      _weaponMesh = new THREE.Mesh(buildWeaponGeo(w), _weaponMat);
      _weaponHolder.add(_weaponMesh);
      if (_weaponIsMelee && _arcMesh) {
        _arcMesh.geometry.dispose();
        _arcMesh.geometry = makeArcGeo(w.arc || 1.1, Math.min(0.9, (w.range || 52) * S));
      }
    }

    /* ================= effect spawners (render-local juice) ================= */
    function spawnGhost(x, z, r, hex) {
      for (var i = 0; i < _ghostPool.length; i++) {
        var g = _ghostPool[i];
        if (g.life >= 0) continue;
        g.life = 0; g.x = x; g.z = z; g.r = r;
        var c = R.hexToRGB(hex);
        g.mat.color.setRGB(c.r, c.g, c.b);
        g.mesh.visible = true;
        return;
      }
    }

    function spawnPuff(x, z) {
      for (var i = 0; i < _puffPool.length; i++) {
        var p = _puffPool[i];
        if (p.life >= 0) continue;
        p.life = 0; p.x = x; p.z = z;
        p.mesh.visible = true;
        return;
      }
    }

    /* ================= per-frame sync ================= */
    function syncPlayer(game, dt) {
      var p = game.player, t = CF.Engine.time;
      syncWeapon(p);
      var bob = Math.sin(p.bob) * 0.045;
      _playerGroup.position.set(p.x * S, 0, p.y * S);
      _playerGroup.rotation.y = -p.aim;
      _playerBody.position.y = bob;
      _torchGlow.position.set(0, 0.95 + bob, 0);

      var blink = (p.iframes > 0 && Math.floor(t * 18) % 2 === 0) ? 0.4 : 1;
      _playerBodyMat.opacity = blink;
      if (_weaponMat) _weaponMat.opacity = blink;
      if (p.hurtFlash > 0) {
        var hf = CF.clamp(p.hurtFlash, 0, 1);
        _playerBodyMat.emissive.setRGB(0.55 * hf, 0.05 * hf, 0.05 * hf);
      } else _playerBodyMat.emissive.setRGB(0, 0, 0);

      /* swing animation + arc trail */
      var at = p.attackT;
      if (_weaponIsMelee) {
        var sw = CF.clamp(at / 0.2, 0, 1);
        _weaponHolder.rotation.y = -Math.sin(sw * Math.PI) * 1.15;
        var showArc = at > 0 && at < 0.16;
        _arcMesh.visible = showArc;
        if (showArc) _arcMat.opacity = 0.4 * (at / 0.16);
      } else {
        _weaponHolder.rotation.y = 0;
        _arcMesh.visible = false;
      }

      /* dash trail ghosts */
      var tr = p.trail;
      for (var i = 0; i < _trailPool.length; i++) {
        var slot = _trailPool[i];
        var j = tr.length - 1 - i;
        if (j >= 0) {
          var e = tr[j];
          slot.mesh.visible = true;
          slot.mesh.position.set(e.x * S, 0, e.y * S);
          slot.mat.opacity = CF.clamp(e.life * 2.2, 0, 0.5);
        } else slot.mesh.visible = false;
      }

      /* torch light + glow flicker */
      var fl = R.flicker(t);
      _torch.position.set(p.x * S, 1.5, p.y * S);
      _torch.intensity = 1.55 + fl * 0.9;
      _torchGlowMat.opacity = 0.09 + fl * 0.07;

      /* footstep dust puffs */
      var dx = p.x - _steps.x, dy = p.y - _steps.y;
      var spd = Math.hypot(dx, dy) / Math.max(dt, 1e-4);
      _steps.x = p.x; _steps.y = p.y;
      _steps.t -= dt;
      if (spd > 80 && p.dashT <= 0 && _steps.t <= 0) {
        _steps.t = 0.27;
        spawnPuff(p.x * S, p.y * S);
      }
    }

    function syncEnemies(game, dt) {
      var t = CF.Engine.time, list = game.enemies, n = list.length;
      while (_enemySlots.length < n && _enemySlots.length < R.MAX_ENEMIES) _enemySlots.push(makeEnemySlot());
      var player = game.player;
      for (var i = 0; i < _enemySlots.length; i++) {
        var slot = _enemySlots[i];
        if (i >= n) {
          if (slot.lastEnemy) {
            spawnGhost(slot.lastX * S, slot.lastY * S, slot.lastR || 0.3, slot.lastHex || '#ffffff');
            slot.lastEnemy = null;
          }
          slot.group.visible = false;
          slot.hpBg.visible = false; slot.hpFg.visible = false;
          continue;
        }
        var en = list[i];
        var r = en.radius * S;
        if (slot.defId !== en.def.id) configureEnemySlot(slot, en.def);
        slot.group.visible = true;
        slot.lastEnemy = en; slot.lastX = en.x; slot.lastY = en.y; slot.lastR = r; slot.lastHex = en.def.color;

        /* hop bob driven by movement */
        var mdx = en.x - slot.lastX2 || 0, mdy = en.y - slot.lastY2 || 0;
        var moved = (mdx * mdx + mdy * mdy) > 0.0004;
        slot.moving = CF.clamp(slot.moving + (moved ? 5 : -7) * dt, 0, 1);
        slot.lastX2 = en.x; slot.lastY2 = en.y;
        slot.phase += dt * (5 + slot.moving * 9);
        var hop = Math.abs(Math.sin(slot.phase)) * 0.13 * slot.moving;

        var face = CF.angleTo(en.x, en.y, player.x, player.y);
        slot.group.position.set(en.x * S, 0, en.y * S);
        slot.group.rotation.y = -face;
        slot.body.position.y = r + hop;

        /* eyes track the player via group rotation; sit near the crown of the body */
        slot.eyes.position.set(r * 0.6, r * 1.35 + hop, 0);
        slot.eyes.scale.set(r * 0.6, r * 0.3, 1);

        /* hit flash / dash tint */
        if (en.flashT > 0) slot.bodyMat.emissive.setScalar(0.85);
        else if (en.dashT > 0) slot.bodyMat.emissive.setRGB(slot.accent.r * 0.45, slot.accent.g * 0.45, slot.accent.b * 0.45);
        else slot.bodyMat.emissive.setScalar(0);
        slot.bodyMat.opacity = slot.wraith ? 0.55 + Math.sin(t * 3 + slot.phase) * 0.15 : 1;

        /* windup telegraph ring */
        var w = en.windup > 0;
        slot.ring.visible = w;
        if (w) {
          var s = r * (1.3 + 0.07 * Math.sin(t * 26));
          slot.ring.scale.set(s, 1, s);
          slot.ring.material.opacity = (Math.floor(t * 20) % 2 === 0) ? 0.5 : 0.16;
        }

        /* hp bar (camera-facing sprites, world space: no swing on turn) */
        var show = en.hp < en.maxHp && !en.isBoss && en.hp > 0;
        slot.hpBg.visible = show; slot.hpFg.visible = show;
        if (show) {
          var bw = en.radius * 2.4 * S, by = r * 2 + 0.22 + hop;
          var frac = CF.clamp(en.hp / en.maxHp, 0, 1);
          slot.hpBg.scale.set(bw + 0.02, 0.075, 1);
          slot.hpBg.position.set(en.x * S, by, en.y * S);
          slot.hpFg.scale.set(bw * frac, 0.05, 1);
          slot.hpFg.position.set(en.x * S - bw / 2, by, en.y * S);
        }

        /* boss crown + light */
        slot.crown.visible = !!en.isBoss;
        if (en.isBoss) {
          slot.crown.scale.setScalar(r);
          slot.crown.position.y = r * 1.9 + hop;
        }
      }
      /* boss purple light tracks the boss, fades in with aggro */
      var boss = game.boss;
      var want = (boss && boss.hp > 0) ? 1 : 0;
      _bossLightI = CF.lerp(_bossLightI, want, R.lerpRate(dt, 0.001));
      if (_bossLightI > 0.01 && boss) {
        _bossLight.position.set(boss.x * S, 1.6, boss.y * S);
        _bossLight.intensity = 1.6 * _bossLightI;
      } else _bossLight.intensity = 0;
    }

    function syncProjectiles(game) {
      var list = game.projectiles, n = list.length;
      while (_projSlots.length < n && _projSlots.length < R.MAX_PROJECTILES) _projSlots.push(makeProjSlot());
      for (var i = 0; i < _projSlots.length; i++) {
        var slot = _projSlots[i];
        if (i >= n) { slot.group.visible = false; slot.last = null; continue; }
        var pr = list[i];
        slot.group.visible = true;
        if (slot.last !== pr) {
          var c = R.hexToRGB(pr.color || '#ffffff');
          slot.mat.color.setRGB(c.r, c.g, c.b);
          slot.glow.material.color.setRGB(c.r, c.g, c.b);
          slot.last = pr;
        }
        var r = pr.radius * S;
        slot.core.scale.setScalar(r);
        slot.glow.scale.set(r * 7, r * 7, 1);
        slot.group.position.set(pr.x * S, 0.5, pr.y * S);
      }
    }

    function syncPickups(game, dt) {
      var t = CF.Engine.time, list = game.pickups, n = list.length;
      while (_pickupSlots.length < n && _pickupSlots.length < R.MAX_PICKUPS) _pickupSlots.push(makePickupSlot());
      for (var i = 0; i < _pickupSlots.length; i++) {
        var slot = _pickupSlots[i];
        if (i >= n) { slot.group.visible = false; slot.last = null; continue; }
        var pk = list[i];
        slot.group.visible = true;
        if (slot.last !== pk) {
          slot.last = pk; slot.spawnT = 0;
          var isGear = pk.kind === 'gear' && pk.data && pk.data.item;
          var hex = '#ffd94a';
          if (pk.kind === 'potion' && pk.data && pk.data.id && CF.ITEMS[pk.data.id]) hex = CF.ITEMS[pk.data.id].color;
          else if (isGear) hex = (pk.data.item.color || '#cfd6e4');
          var c = R.hexToRGB(hex);
          if (pk.kind === 'potion') slot.flaskMat.color.setRGB(c.r, c.g, c.b);
          if (pk.kind === 'gear') slot.gearMat.color.setRGB(c.r, c.g, c.b);
          slot.glow.material.color.setRGB(c.r, c.g, c.b);
          slot.glow.material.opacity = pk.kind === 'gold' ? 0.4 : 0.25;
        }
        slot.spawnT += dt;
        var kind = pk.kind;
        slot.coin.visible = (kind === 'gold');
        slot.flask.visible = (kind === 'potion');
        slot.gear.visible = (kind === 'gear');
        slot.heart.visible = (kind === 'heart');
        var pop = Math.min(1, slot.spawnT / 0.3);
        var scale = R.easeOutBack(pop);
        var bobH = Math.sin(pk.bob) * 0.05;
        var flip = (slot.spawnT < 0.4) ? Math.sin(slot.spawnT * 26) * (1 - slot.spawnT / 0.4) : 0;
        var yBase = 0.34 + bobH + (slot.spawnT < 0.4 ? Math.sin(pop * Math.PI) * 0.22 : 0);
        slot.group.position.set(pk.x * S, 0, pk.y * S);
        slot.core.position.y = yBase;
        slot.core.scale.setScalar(scale);
        if (kind === 'gold') {
          slot.coin.rotation.y = t * 3.4 + pk.bob;
          slot.coin.rotation.x = flip * 1.2;
        } else if (kind === 'gear') {
          slot.gear.rotation.y = t * 1.6;
        }
      }
    }

    function syncChests(game, dt) {
      var list = game.chests, n = list.length;
      while (_chestSlots.length < n && _chestSlots.length < R.MAX_CHESTS) _chestSlots.push(makeChestSlot());
      for (var i = 0; i < _chestSlots.length; i++) {
        var slot = _chestSlots[i];
        if (i >= n) { slot.group.visible = false; slot.last = null; continue; }
        var c = list[i];
        slot.group.visible = true;
        if (slot.last !== c) { slot.last = c; slot.openT = c.opened ? 1 : 0; }
        var target = c.opened ? 1 : 0;
        if (slot.openT !== target) slot.openT = CF.clamp(slot.openT + (target ? dt * 3.4 : -dt * 6), 0, 1);
        var eased = R.easeOutBack(slot.openT);
        slot.lidPivot.rotation.x = eased * 1.9;
        slot.bodyMat.color.setHex(c.opened ? 0x4a3b28 : 0x6b4f2e);
        slot.lidMat.color.setHex(c.opened ? 0x2e2417 : 0x8a6a3f);
        slot.lock.visible = !c.opened;
        slot.group.position.set(c.x * S, 0, c.y * S);
      }
    }

    function syncParticles(game) {
      var L = CF.Particles.list, n = Math.min(L.length, _particles.count);
      var pos = _particles.pos, col = _particles.col, siz = _particles.siz, alp = _particles.alp;
      for (var i = 0; i < n; i++) {
        var p = L[i];
        var k = 1 - p.life / p.maxLife;
        pos[i * 3] = p.x * S;
        pos[i * 3 + 1] = 0.22 + Math.min(0.5, p.size * 0.02);
        pos[i * 3 + 2] = p.y * S;
        var c = R.hexToRGB(p.color);
        var boost = p.glow ? 1.35 : 0.9;
        col[i * 3] = c.r * boost; col[i * 3 + 1] = c.g * boost; col[i * 3 + 2] = c.b * boost;
        siz[i] = (p.shrink ? Math.max(0.4, p.size * k) : p.size) * S * 2.6;
        alp[i] = (p.fade ? k : 1) * (p.glow ? 0.85 : 0.55);
      }
      _particles.geo.attributes.position.needsUpdate = true;
      _particles.geo.attributes.aColor.needsUpdate = true;
      _particles.geo.attributes.aSize.needsUpdate = true;
      _particles.geo.attributes.aAlpha.needsUpdate = true;
      _particles.geo.setDrawRange(0, n);
    }

    function syncMotes(game, dt) {
      var px = game.player.x * S, pz = game.player.y * S;
      var t = CF.Engine.time;
      var pos = _motes.pos, col = _motes.col, siz = _motes.siz, alp = _motes.alp;
      var n = _moteSeed.length;
      var fl = R.flicker(t * 0.7);
      for (var i = 0; i < n; i++) {
        var m = _moteSeed[i];
        m.y += m.v * dt * 0.4;
        if (m.y > 2.1) m.y = 0.15;
        pos[i * 3] = px + m.x + Math.sin(t * 0.6 + m.p) * 0.3;
        pos[i * 3 + 1] = m.y;
        pos[i * 3 + 2] = pz + m.z + Math.cos(t * 0.5 + m.p) * 0.3;
        col[i * 3] = 1.0; col[i * 3 + 1] = 0.72; col[i * 3 + 2] = 0.4;
        siz[i] = 0.035 + 0.02 * Math.sin(t * 2 + m.p);
        alp[i] = (0.05 + 0.06 * fl) * (0.6 + 0.4 * Math.sin(t * 1.7 + m.p));
      }
      _motes.geo.attributes.position.needsUpdate = true;
      _motes.geo.attributes.aColor.needsUpdate = true;
      _motes.geo.attributes.aSize.needsUpdate = true;
      _motes.geo.attributes.aAlpha.needsUpdate = true;
      _motes.geo.setDrawRange(0, n);
    }

    function syncEffects(dt) {
      var t = CF.Engine.time, i, e;
      for (i = 0; i < _ghostPool.length; i++) {
        e = _ghostPool[i];
        if (e.life < 0) continue;
        e.life += dt;
        var k = e.life / 0.38;
        if (k >= 1) { e.life = -1; e.mesh.visible = false; continue; }
        var s = e.r * (1 + k * 1.6);
        e.mesh.position.set(e.x, e.r + k * 0.4, e.z);
        e.mesh.scale.setScalar(Math.max(0.01, s * (1 - k)));
        e.mesh.rotation.y += dt * 9;
        e.mat.opacity = 0.55 * (1 - k);
      }
      for (i = 0; i < _puffPool.length; i++) {
        e = _puffPool[i];
        if (e.life < 0) continue;
        e.life += dt;
        var k2 = e.life / 0.5;
        if (k2 >= 1) { e.life = -1; e.mesh.visible = false; continue; }
        e.mesh.position.x = e.x; e.mesh.position.z = e.z;
        var sc = 0.22 + k2 * 0.55;
        e.mesh.scale.set(sc, sc, sc);
        e.mat.opacity = 0.3 * (1 - k2);
      }
    }

    function syncCamera(game, dt) {
      var p = game.player;
      var goal = R.cameraGoal(p.x, p.y, p.aim, CAM.look);
      var k = R.lerpRate(dt, 0.0008);
      _camTarget.x = CF.lerp(_camTarget.x, goal.x, k);
      _camTarget.z = CF.lerp(_camTarget.z, goal.z, k);
      var shX = (CF.Camera.shakeX || 0) * S * 1.6;
      var shY = (CF.Camera.shakeY || 0) * S * 1.6;
      _camera.position.set(_camTarget.x + shX, CAM.h, _camTarget.z + CAM.back + shY);
      _look.set(_camTarget.x, 0.4, _camTarget.z);
      _camera.lookAt(_look);
    }

    /* ================= frame ================= */
    R.frame = function (game, dt) {
      if (!_renderer || !game.dungeon || !game.player) return;
      try {
        if (_floorRef !== game.dungeon) R.buildFloor(game.dungeon);
        if (R._snap) {
          /* new floor: camera starts on the player, no cross-map slide */
          R._snap = false;
          _camTarget.x = game.player.x * S;
          _camTarget.z = game.player.y * S;
        }
        var t = CF.Engine.time;
        /* stairs pulse + light column */
        var pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
        _stairsMesh.material.color.setRGB(0.06 + pulse * 0.09, 0.22 + pulse * 0.16, 0.28 + pulse * 0.2);
        _columnMesh.material.opacity = 0.07 + pulse * 0.09;
        _stairsLight.intensity = 1.1 + pulse * 0.9;

        syncPlayer(game, dt);
        syncEnemies(game, dt);
        syncProjectiles(game);
        syncPickups(game, dt);
        syncChests(game, dt);
        syncParticles(game);
        syncMotes(game, dt);
        syncEffects(dt);
        syncCamera(game, dt);
        _renderer.render(_scene, _camera);
      } catch (err) {
        console.error('Render3D frame failed, falling back to 2D:', err);
        R.disable();
      }
    };

    /* ================= fallback / disable ================= */
    R._origScreenToWorld = CF.Camera.screenToWorld;
    R._origWorldToScreen = CF.Camera.worldToScreen;

    R.disable = function () {
      this.active = false;
      this.available = false;
      try { CF.Camera.screenToWorld = R._origScreenToWorld; } catch (e) {}
      try { CF.Camera.worldToScreen = R._origWorldToScreen; } catch (e) {}
      try {
        if (CF.Game && CF.Game.dungeon && !CF.Game.floorCanvas) CF.Game.buildFloorCanvas(CF.Game.dungeon);
      } catch (e) {}
    };

    /* ================= boot the 3D path ================= */
    try {
      R.init(document.getElementById('game3d'));
      /* exact desktop aim: raycast the mouse onto the ground plane */
      CF.Camera.screenToWorld = function (sx, sy) { return R._screenToWorld(sx, sy); };
      CF.Camera.worldToScreen = function (wx, wy) { return R._worldToScreen(wx, wy); };
      R.available = true;
      R.active = true;
    } catch (err) {
      console.warn('Render3D unavailable, using 2D renderer:', err && err.message);
      R.available = false;
      R.active = false;
    }
  })();
}

/* standalone self-test: node js/render3d.js */
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('render3d.js')) {
  CF.Render3D._selfTest();
  process.exit(0);
}
