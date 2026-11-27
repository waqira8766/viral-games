/* DOPAMINE FACTORY — js/render3d.js — DP.Render3D
 * three.js r147 scene: glowing cube board, arena, camera, hit-testing, juice.
 * Contract: init(stageEl, board, content) | frame(dt, game) | setBoard(board)
 *   | screenToCell(sx, sy) -> {idx, cell}|null | cellToScreen(idx) -> {x,y}|null
 *   | setDrag(idx, active) drag ghost visuals.
 * PURE math (cells, projection, drag state, tier visuals) runs everywhere and
 * is self-tested under node; the three.js scene is DOM+THREE guarded and
 * stays safe headless (init fails -> graceful no-ops). Zero per-frame
 * allocations: cubes/rings/bolts/dying anims are all pooled. */
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});

DP.Render3D = (function () {
  'use strict';
  /* ------------------------------ constants ------------------------------ */
  var SPACING = 1.3, PLANE_Y = 0.04, MAX_SIZE = 7, MAX_CELLS = MAX_SIZE * MAX_SIZE;
  var CUBE_BASE = 0.82, TIER_GROW = 0.06, CUBE_SOFT = 1.36;      /* size +0.06/tier */
  var EMIS_BASE = 0.34, EMIS_GROW = 0.026, EMIS_MAX = 1.05;      /* emissive ramp */
  var DPR_CAP = 1.5, CAM_ELEV = 50 * Math.PI / 180;              /* top-down ~50 deg */

  /* ---------------------------- pure: grid math -------------------------- */
  function idxToRC(idx, size) {
    if (size < 1 || idx < 0 || idx >= size * size) return null;
    var col = idx % size;
    return { row: (idx - col) / size, col: col };
  }
  function rcToIdx(row, col, size) {
    if (size < 1 || row < 0 || col < 0 || row >= size || col >= size) return -1;
    return row * size + col;
  }
  function cellToWorld(idx, size, out) { /* cell center -> board-centered xz */
    out = out || { x: 0, z: 0 };
    var col = idx % size, row = (idx - col) / size;
    out.x = (col - (size - 1) / 2) * SPACING;
    out.z = (row - (size - 1) / 2) * SPACING;
    return out;
  }
  function cellFromWorld(x, z, size) { /* world xz -> idx | -1 */
    var col = Math.floor(x / SPACING + size / 2 + 1e-6);
    var row = Math.floor(z / SPACING + size / 2 + 1e-6);
    if (col < 0 || row < 0 || col >= size || row >= size) return -1;
    return row * size + col;
  }

  /* ---------------------------- pure: tier visuals ----------------------- */
  function cubeSizeFor(tier) { /* +0.06/tier, soft-compressed past CUBE_SOFT */
    if (tier < 1) tier = 1; if (tier > 25) tier = 25;
    var s = CUBE_BASE + TIER_GROW * (tier - 1);
    if (s > CUBE_SOFT) s = CUBE_SOFT + (s - CUBE_SOFT) * 0.3;
    return s;
  }
  function tierEmissFor(tier) {
    if (tier < 1) tier = 1; if (tier > 25) tier = 25;
    var e = EMIS_BASE + EMIS_GROW * (tier - 1);
    return e > EMIS_MAX ? EMIS_MAX : e;
  }
  function normalizeColor(c) {
    if (typeof c === 'number') return '#' + ('00000' + (c | 0).toString(16)).slice(-6);
    return String(c).toLowerCase();
  }
  var FALLBACK_COLORS = [ /* rainbow->gold ladder (DP.Content owns the canon one) */
    '#ff3d5f', '#ff5f3d', '#ff8f3d', '#ffc23d', '#ffe03d', '#d8f83d', '#a4f83d',
    '#6cf03d', '#3df08f', '#3df0c8', '#3dd6f0', '#3d9bf0', '#5f6df0', '#8f3df0',
    '#bf3df0', '#f03dd6', '#f03d9b', '#f08f5f', '#ffd24a', '#ffd76b', '#ffe08a',
    '#ffe9ad', '#fff2cc', '#fff8e6', '#ffffff'];
  function tierColorHex(tier) { /* DELEGATES to DP.Content.tierColor */
    if (tier < 1) tier = 1; if (tier > 25) tier = 25;
    if (typeof DP !== 'undefined' && DP.Content && DP.Content.tierColor) {
      try { return normalizeColor(DP.Content.tierColor(tier)); } catch (e) { /* fall through */ }
    }
    return FALLBACK_COLORS[tier - 1];
  }
  function fitDistance(size, aspect) { /* camera distance that frames the board */
    var d = 8.6 + (size - 5) * 1.35;
    if (aspect < 1) d *= Math.min(1 + (1 - aspect) * 0.9, 2.3);
    return d;
  }

  /* ---------------- pure: camera math (column-major, like THREE) ---------
   * cam = {matrixWorld, matrixWorldInverse, projectionMatrix,
   *        projectionMatrixInverse} — plain 16-element arrays, so the exact
   * same math runs in the browser (live THREE arrays) and in the node test
   * (mock camera). Scratch arrays are module-scope: no allocations. */
  var _pa = [0, 0, 0, 0], _pb = [0, 0, 0, 0], _v = [0, 0, 0, 0];
  function _apply4(out, m, x, y, z, w) {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  }
  function _unproject(out, nx, ny, nz, cam) { /* ndc -> world (mirrors THREE) */
    _apply4(_v, cam.projectionMatrixInverse, nx, ny, nz, 1);
    _apply4(out, cam.matrixWorld, _v[0], _v[1], _v[2], _v[3]);
    var iw = 1 / (out[3] || 1);
    out[0] *= iw; out[1] *= iw; out[2] *= iw;
  }
  function cellToScreenCore(idx, size, cam, w, h, out) { /* idx -> screen px */
    out = out || { x: 0, y: 0 };
    if (size < 1 || idx < 0 || idx >= size * size) { out.x = -1; out.y = -1; return out; }
    var col = idx % size, row = (idx - col) / size;
    var wx = (col - (size - 1) / 2) * SPACING, wz = (row - (size - 1) / 2) * SPACING;
    _apply4(_v, cam.matrixWorldInverse, wx, 0.5, wz, 1);
    _apply4(_pa, cam.projectionMatrix, _v[0], _v[1], _v[2], _v[3]);
    var iw = 1 / (_pa[3] || 1);
    out.x = (_pa[0] * iw + 1) * 0.5 * w;
    out.y = (1 - _pa[1] * iw) * 0.5 * h;
    return out;
  }
  function screenToCellCore(sx, sy, size, cam, w, h) { /* px -> idx | -1 */
    if (size < 1 || w <= 0 || h <= 0) return -1;
    var nx = 2 * sx / w - 1, ny = 1 - 2 * sy / h;
    _unproject(_pa, nx, ny, -1, cam);
    _unproject(_pb, nx, ny, 1, cam);
    var dx = _pb[0] - _pa[0], dy = _pb[1] - _pa[1], dz = _pb[2] - _pa[2];
    var fx = -cam.matrixWorld[8], fy = -cam.matrixWorld[9], fz = -cam.matrixWorld[10];
    if (dx * fx + dy * fy + dz * fz < 0) { dx = -dx; dy = -dy; dz = -dz; }
    if (dy > -1e-7 && dy < 1e-7) return -1; /* ray parallel to the board */
    var t = (PLANE_Y - _pa[1]) / dy;
    if (t < 0) return -1;                   /* board behind the camera */
    return cellFromWorld(_pa[0] + t * dx, _pa[2] + t * dz, size);
  }
  function mockCamera(H) { /* ortho identity, H above the board, looking down */
    var I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return {
      matrixWorld: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, H, 0, 1],
      matrixWorldInverse: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -H, 1],
      projectionMatrix: I.slice(), projectionMatrixInverse: I.slice()
    };
  }

  /* ---------------------------- pure: drag state ------------------------- */
  function newDrag() { return { idx: -1, active: false, target: -1 }; }
  function dragSet(d, idx, active) { /* idle -> held(idx) -> released -> idle */
    if (active) {
      if (typeof idx === 'number' && idx >= 0) { d.idx = idx; d.active = true; }
    } else { d.active = false; d.idx = -1; d.target = -1; }
    return d;
  }
  function dragTarget(d, idx) {
    d.target = (typeof idx === 'number' && idx >= 0) ? idx : -1;
    return d;
  }

  /* ------------------------------- self-test ------------------------------
   * `node js/render3d.js` only — never in a browser, never when this file is
   * required/vm-loaded by another module or the integration bot. */
  if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
    String(process.argv[1]).slice(-'render3d.js'.length) === 'render3d.js') {
    (function () {
      var pass = 0, fail = 0, w = 800, h = 600, out = { x: 0, z: 0 }, sc = { x: 0, y: 0 };
      function check(name, cond) {
        if (cond) { pass++; console.log('PASS: ' + name); }
        else { fail++; console.log('FAIL: ' + name); }
      }
      var i, size, ok;
      /* idx <-> rc round-trip + bounds, sizes 3..7 */
      ok = true;
      for (size = 3; size <= 7; size++) {
        for (i = 0; i < size * size; i++) {
          var rc = idxToRC(i, size);
          if (!rc || rcToIdx(rc.row, rc.col, size) !== i) ok = false;
        }
        if (idxToRC(size * size, size) !== null || idxToRC(-1, size) !== null ||
          rcToIdx(size, 0, size) !== -1 || rcToIdx(0, size, size) !== -1) ok = false;
      }
      check('idx<->rc round-trip + bounds (sizes 3..7)', ok);
      /* cell <-> world round-trip + off-board + edge inclusivity */
      ok = true;
      [5, 6, 7].forEach(function (s) {
        for (var j = 0; j < s * s; j++) {
          cellToWorld(j, s, out);
          if (cellFromWorld(out.x, out.z, s) !== j) ok = false;
        }
      });
      check('cellToWorld <-> cellFromWorld round-trip (5/6/7)', ok);
      var half5 = 5 * SPACING / 2;
      check('world off-board -> -1, edges inclusive', cellFromWorld(99, 99, 5) === -1 &&
        cellFromWorld(-99, 0, 5) === -1 && cellFromWorld(-half5, -half5, 5) === 0 &&
        cellFromWorld(half5 - 0.01, half5 - 0.01, 5) === 24);
      /* screenToCell / cellToScreen inverse math with the MOCK camera */
      var cam = mockCamera(30);
      ok = true;
      [5, 7].forEach(function (s) {
        for (var j = 0; j < s * s; j++) {
          cellToScreenCore(j, s, cam, w, h, sc);
          if (screenToCellCore(sc.x, sc.y, s, cam, w, h) !== j) ok = false;
        }
      });
      check('cellToScreen -> screenToCell inverse (mock camera, 5x5+7x7)', ok);
      cellToScreenCore(12, 5, cam, w, h, sc); /* center cell sits at world (0,0) */
      var sc2 = cellToScreenCore(11, 5, cam, w, h, { x: 0, y: 0 });
      check('mock camera: center -> screen center, ortho linear scale',
        Math.abs(sc.x - w / 2) < 1e-9 && Math.abs(sc.y - h / 2) < 1e-9 &&
        Math.abs((sc.x - sc2.x) - SPACING * w / 2) < 1e-9);
      /* mock maps world->screen as sx=(wx+1)*w/2: off-board points map off it */
      var offX = (half5 + 1.5) * 0.5 * w, offY = (1 - (half5 + 0.5)) * 0.5 * h;
      check('screenToCell off-board -> -1', screenToCellCore(-offX, offY, 5, cam, w, h) === -1 &&
        screenToCellCore(offX, h / 2, 5, cam, w, h) === -1 &&
        screenToCellCore(-9999, -9999, 5, cam, w, h) === -1);
      /* tier visuals: +0.06/tier linear, monotonic size + emissive, sane max */
      var okG = true; ok = true;
      for (i = 1; i < 10; i++) {
        if (Math.abs(cubeSizeFor(i + 1) - cubeSizeFor(i) - TIER_GROW) > 1e-12) okG = false;
      }
      for (i = 1; i < 25; i++) {
        if (cubeSizeFor(i + 1) <= cubeSizeFor(i) || tierEmissFor(i + 1) <= tierEmissFor(i)) ok = false;
      }
      check('cube size = +0.06/tier (linear region)', okG);
      check('size + emissive monotonic, max sane', ok &&
        cubeSizeFor(25) <= 1.7 && tierEmissFor(25) <= EMIS_MAX);
      /* tier colors DELEGATE to DP.Content; load it for this test if absent */
      if (!(DP.Content && DP.Content.tierColor)) {
        try { require('./content.js'); } catch (e1) {
          try { require('../content.js'); } catch (e2) { /* skip gracefully */ }
        }
      }
      if (DP.Content && DP.Content.tierColor) {
        var okD = true, colors = {};
        for (i = 1; i <= 25; i++) {
          if (tierColorHex(i) !== normalizeColor(DP.Content.tierColor(i))) okD = false;
          colors[tierColorHex(i)] = true;
        }
        check('tierColorHex delegates to DP.Content, 25 unique colors', okD && Object.keys(colors).length === 25);
        check('content canon: tierValue 1..4 = 10/35/123/429, coinValue curve',
          DP.Content.tierValue(1) === 10 && DP.Content.tierValue(2) === 35 &&
          DP.Content.tierValue(3) === 123 && DP.Content.tierValue(4) === 429 &&
          (DP.Content.coinValue ? DP.Content.coinValue(7) === Math.round(10 * Math.pow(3.5, 6)) : true));
      } else {
        console.log('SKIP: DP.Content absent (content.js not built yet) — fallback ladder checked');
        var fb = {}; ok = true;
        for (i = 1; i <= 25; i++) {
          var c = tierColorHex(i);
          if (c[0] !== '#' || c.length !== 7) ok = false;
          fb[c] = true;
        }
        check('fallback tier ladder: 25 valid unique hexes', ok && Object.keys(fb).length === 25);
      }
      /* drag-state transitions */
      var d = newDrag();
      dragSet(d, 5, true); dragSet(d, 5, true); dragSet(d, -1, true);
      check('hold transitions: hold, re-hold no-op, -1 ignored',
        d.active && d.idx === 5);
      dragTarget(d, 8); dragSet(d, 5, false); dragSet(d, 5, false);
      check('release clears idx + target; double release no-op',
        !d.active && d.idx === -1 && d.target === -1);
      /* camera fit */
      check('fitDistance grows with board size, compensates portrait',
        fitDistance(7, 1) > fitDistance(6, 1) && fitDistance(6, 1) > fitDistance(5, 1) &&
        fitDistance(5, 0.5) > fitDistance(5, 1));
      if (fail > 0) { console.log(fail + ' TEST(S) FAILED'); process.exit(1); }
      console.log('ALL TESTS PASSED (' + pass + ' checks)');
    })();
  }

  /* API: pure helpers always; scene methods are stubs until the browser
   * block overrides them, so headless callers never crash. */
  var api = {
    ready: false,
    idxToRC: idxToRC, rcToIdx: rcToIdx, cellToWorld: cellToWorld, cellFromWorld: cellFromWorld,
    cubeSizeFor: cubeSizeFor, tierEmissFor: tierEmissFor, tierColorHex: tierColorHex,
    fitDistance: fitDistance, cellToScreenCore: cellToScreenCore, screenToCellCore: screenToCellCore,
    mockCamera: mockCamera, newDrag: newDrag, dragSet: dragSet, dragTarget: dragTarget,
    SPACING: SPACING, PLANE_Y: PLANE_Y, DPR_CAP: DPR_CAP,
    init: function () { return false; }, frame: function () {},
    setBoard: function (b) { api._board = b; },
    screenToCell: function () { return null; }, cellToScreen: function () { return null; },
    setDrag: function (idx, active) { dragSet(drag, idx, active); },
    setDragTarget: function (idx) { dragTarget(drag, idx); },
    resize: function () {}
  };
  var drag = newDrag();
  api._drag = drag;

  /* ======================= BROWSER SCENE (DOM + THREE) ==================== */
  if (typeof document !== 'undefined') {
    if (typeof THREE === 'undefined') {
      try {
        document.body.innerHTML = '<div style="font:16px sans-serif;padding:40px">' +
          '😢 three.js failed to load.</div>';
      } catch (e) { /* headless shim: never crash */ }
    } else {
      /* --------------------------- state --------------------------------- */
      var stage = null, renderer = null, scene = null, camera = null, camRef = null;
      var board = api._board || null;
      var vw = 640, vh = 480, time = 0, sizePoll = 0, camDist = 0;
      var comX = 0, comZ = 0, comDirty = true, lookX = 0, lookZ = 0;
      var rimPulse = 0, comboGlow = 0, starKick = 0;
      var prevSize = -1, prevSynced = false, prevCells = [];
      var cellCubes = new Array(MAX_CELLS); for (var pc = 0; pc < MAX_CELLS; pc++) cellCubes[pc] = null;
      var cubeFree = [], dying = [], dyingFree = [], rings = [], bolts = [];
      var lastRingIdx = -1, lastRingT = -1, chainIdx = -1, chainT = -9, lastHitIdx = -1, lastHitT = -9;
      var scratch = { x: 0, z: 0 }, scr2 = { x: 0, y: 0 };
      var gridHelper = null, rimMesh = null, rimGlow = null, rimColorT = null;
      var highlight = null, starA = null, starB = null;
      var IDLE = 0, SPAWN = 1, POP = 2, goldColor = 0xffd76b;
      var cubeGeo = null, sparkTex = null, sparkMat = null;

      /* rounded box: BoxGeometry + clamp-and-project vertex bevel (r147 has no
       * RoundedBoxGeometry). ONE unit geo shared by every cube — 49 cubes, one
       * geometry, pooled meshes/materials. */
      function makeRoundedBoxGeo(seg, r) {
        var g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
        var pos = g.attributes.position, inner = 0.5 - r, i, k, x, y, z, qx, qy, qz, len;
        for (i = 0; i < pos.count; i++) {
          x = pos.getX(i); y = pos.getY(i); z = pos.getZ(i);
          qx = Math.max(-inner, Math.min(inner, x)); qy = Math.max(-inner, Math.min(inner, y));
          qz = Math.max(-inner, Math.min(inner, z));
          len = Math.sqrt((x - qx) * (x - qx) + (y - qy) * (y - qy) + (z - qz) * (z - qz));
          if (len > 1e-9) { k = r / len; pos.setXYZ(i, qx + (x - qx) * k, qy + (y - qy) * k, qz + (z - qz) * k); }
        }
        g.computeVertexNormals();
        return g;
      }
      function glowTexture() { /* canvas radial glow — no asset files */
        var c = document.createElement('canvas'); c.width = c.height = 64;
        var x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 2, 32, 32, 30);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,230,150,0.85)');
        gr.addColorStop(1, 'rgba(255,200,80,0)');
        x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(c);
      }
      function makeCube() {
        var mat = new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x000000,
          emissiveIntensity: 0.4, shininess: 90, specular: 0x666666 });
        var m = new THREE.Mesh(cubeGeo, mat);
        m.visible = false;
        var sp = new THREE.Sprite(sparkMat);
        sp.visible = false; sp.scale.set(0.4, 0.4, 1); m.add(sp);
        m.userData = { idx: -1, tier: 1, lucky: false, mode: IDLE, t: 0, dur: 0.5,
          base: CUBE_BASE, baseE: 0.4, lift: 0, glow: 0, glowP: 0, sprite: sp };
        scene.add(m);
        return m;
      }
      function acquireCube() { return cubeFree.length ? cubeFree.pop() : makeCube(); }
      function makeRing() { /* merge flash ring pool */
        var m = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.58, 40),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        m.rotation.x = -Math.PI / 2; m.visible = false; m.userData = { t: 0, dur: 0.45, on: false };
        scene.add(m); return m;
      }
      function makeBolt() { /* chain lightning: jagged emissive segments */
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
        var l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xbfe9ff,
          transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
        l.visible = false; l.frustumCulled = false; l.userData = { t: 0, dur: 0.18, on: false };
        scene.add(l); return l;
      }
      function ringAt(idx, tier) {
        if (idx < 0 || (idx === lastRingIdx && time - lastRingT < 0.08)) return; /* dedupe */
        lastRingIdx = idx; lastRingT = time;
        var r = null, i;
        for (i = 0; i < rings.length; i++) if (!rings[i].userData.on) { r = rings[i]; break; }
        if (!r) r = rings[0];
        cellToWorld(idx, prevSize < 1 ? 5 : prevSize, scratch);
        r.position.set(scratch.x, 0.06, scratch.z);
        r.material.color.set(tierColorHex(tier));
        r.userData.t = 0; r.userData.on = true; r.visible = true;
      }
      function bolt(a, b) {
        if (a < 0 || b < 0 || a === b) return;
        var l = null, i;
        for (i = 0; i < bolts.length; i++) if (!bolts[i].userData.on) { l = bolts[i]; break; }
        if (!l) l = bolts[0];
        cellToWorld(a, prevSize < 1 ? 5 : prevSize, scratch);
        var ax = scratch.x, az = scratch.z;
        cellToWorld(b, prevSize < 1 ? 5 : prevSize, scratch);
        var p = l.geometry.attributes.position.array;
        for (i = 0; i < 8; i++) {
          var k = i / 7, edge = (i === 0 || i === 7);
          var jx = edge ? 0 : (Math.random() - 0.5) * 0.5;
          p[i * 3] = ax + (scratch.x - ax) * k + jx;
          p[i * 3 + 1] = 0.45 + (edge ? 0 : (Math.random() - 0.5) * 0.55);
          p[i * 3 + 2] = az + (scratch.z - az) * k + jx;
        }
        l.geometry.attributes.position.needsUpdate = true;
        l.userData.t = 0; l.userData.on = true; l.visible = true;
      }
      /* dying anims: pop = 0.1s shrink; merge source = fly into target */
      function startDying(idx, flyTo) {
        var m = cellCubes[idx]; if (!m) return;
        cellCubes[idx] = null;
        var e = dyingFree.length ? dyingFree.pop() : {};
        e.mesh = m; e.t = 0; e.dur = flyTo >= 0 ? 0.16 : 0.1; e.fly = flyTo >= 0;
        e.fx = m.position.x; e.fy = m.position.y; e.fz = m.position.z;
        e.fs = m.scale.x; e.rot = Math.random() * Math.PI * 2;
        if (e.fly) { cellToWorld(flyTo, prevSize < 1 ? 5 : prevSize, scratch); e.tx = scratch.x; e.tz = scratch.z; }
        m.userData.mode = IDLE;
        if (dying.length >= 16) { m.visible = false; cubeFree.push(m); dyingFree.push(e); return; }
        dying.push(e);
      }
      function themeCube(m, idx, cell, mode) {
        var d = m.userData, hex;
        d.idx = idx; d.tier = cell.tier; d.lucky = !!cell.lucky;
        d.base = cubeSizeFor(cell.tier);
        d.baseE = tierEmissFor(cell.tier) * (d.lucky ? 1.5 : 1);
        d.mode = mode; d.t = 0; d.glowP = 0; d.dur = mode === SPAWN ? 0.6 : 0.42;
        cellToWorld(idx, board ? board.size : 5, scratch);
        hex = d.lucky ? normalizeColor(goldColor) : tierColorHex(cell.tier);
        m.material.color.set(d.lucky ? goldColor : hex);
        m.material.emissive.set(d.lucky ? 0xffb733 : hex);
        m.material.emissiveIntensity = d.baseE;
        m.position.set(scratch.x, d.base / 2, scratch.z);
        m.rotation.set(0, 0, 0);
        var s = mode === SPAWN ? 0.01 : d.base * 0.6;
        m.scale.set(s, s, s); m.visible = true;
        d.sprite.visible = d.lucky;
        return m;
      }

      /* ------------------------------ init -------------------------------- */
      function init(stageEl, boardArg, contentArg) {
        if (api.ready) return true;
        try {
          if (boardArg) board = boardArg; /* contentArg: DP.Content is the source */
          stage = (typeof stageEl === 'string') ? document.getElementById(stageEl) : stageEl;
          if (!stage && document.getElementById) stage = document.getElementById('stage');
          if (!stage) return false;
          renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
          renderer.setPixelRatio(Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, DPR_CAP));
          scene = new THREE.Scene();
          scene.background = new THREE.Color(0x050310);
          scene.fog = new THREE.Fog(0x08061c, 16, 46);
          camera = new THREE.PerspectiveCamera(40, 1, 0.1, 140);
          camRef = { matrixWorld: camera.matrixWorld.elements,
            matrixWorldInverse: camera.matrixWorldInverse.elements,
            projectionMatrix: camera.projectionMatrix.elements,
            projectionMatrixInverse: camera.projectionMatrixInverse.elements };
          scene.add(new THREE.HemisphereLight(0x8ea2ff, 0x140f2e, 0.75));
          var key = new THREE.DirectionalLight(0xfff4e0, 0.9);
          key.position.set(6, 12, 4); scene.add(key);
          /* arena: dark glossy floor + glow pool under the board */
          var floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70),
            new THREE.MeshPhongMaterial({ color: 0x0b0a22, shininess: 110, specular: 0x1c2350 }));
          floor.rotation.x = -Math.PI / 2; scene.add(floor);
          var pool = new THREE.Mesh(new THREE.CircleGeometry(6.5, 48),
            new THREE.MeshBasicMaterial({ color: 0x2a1f66, transparent: true, opacity: 0.14,
              blending: THREE.AdditiveBlending, depthWrite: false }));
          pool.rotation.x = -Math.PI / 2; pool.position.y = 0.015; scene.add(pool);
          cubeGeo = makeRoundedBoxGeo(3, 0.13);
          sparkTex = glowTexture();
          sparkMat = new THREE.SpriteMaterial({ map: sparkTex, color: 0xffe9a0,
            transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
          /* starfield dust: two pooled point clouds */
          function stars(n, sz, color, yMax) {
            var arr = new Float32Array(n * 3), i, a, r;
            for (i = 0; i < n; i++) {
              a = Math.random() * Math.PI * 2; r = 7 + Math.random() * 22;
              arr[i * 3] = Math.cos(a) * r; arr[i * 3 + 1] = 0.2 + Math.random() * yMax;
              arr[i * 3 + 2] = Math.sin(a) * r;
            }
            var g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
            var p = new THREE.Points(g, new THREE.PointsMaterial({ color: color, size: sz,
              transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
            scene.add(p); return p;
          }
          starA = stars(130, 0.055, 0x9db8ff, 7);
          starB = stars(80, 0.08, 0xffd76b, 4.5);
          /* drag target highlight */
          highlight = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 36),
            new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0,
              blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
          highlight.rotation.x = -Math.PI / 2; highlight.visible = false; scene.add(highlight);
          for (var ri = 0; ri < 6; ri++) rings.push(makeRing());
          for (var bi = 0; bi < 5; bi++) bolts.push(makeBolt());
          stage.appendChild(renderer.domElement);
          renderer.domElement.style.touchAction = 'none';
          /* event bus (guarded — modules must never crash if it is absent) */
          if (typeof DP.Events !== 'undefined' && DP.Events && DP.Events.on) {
            DP.Events.on('pop', function (d) { /* chain lightning + combo glow */
              comboGlow = Math.min(comboGlow + 0.25, 1.2);
              if (d && d.chained && chainIdx >= 0 && time - chainT < 0.5) {
                bolt(chainIdx, d.idx); chainIdx = d.idx; chainT = time;
              } else if (d && !d.chained && d.tier >= 5) { chainIdx = d.idx; chainT = time; }
              else chainIdx = -1;
              if (d && d.lucky) rimPulse = Math.min(rimPulse + 0.5, 1.6);
            });
            DP.Events.on('merge', function (d) {
              if (!d || !api.ready) return;
              if (cellCubes[d.a]) startDying(d.a, d.b); /* source flies in */
              if (cellCubes[d.b]) {
                themeCube(cellCubes[d.b], d.b,
                  board && board.cells[d.b] ? board.cells[d.b] : { tier: d.tier, lucky: false }, POP);
                ringAt(d.b, d.tier);
              }
              rimPulse = Math.min(rimPulse + 0.7, 1.6);
              comboGlow = Math.min(comboGlow + 0.4, 1.2);
            });
            DP.Events.on('tierReached', function (d) {
              if (!d) return;
              rimColorT.set(tierColorHex(d.tier)); rimPulse = 1.6;
            });
            DP.Events.on('ascend', function () { rimColorT.set('#ffffff'); rimPulse = 2; starKick = 1; });
          }
          api.ready = true;
          resize(true);
          setBoard(board || null);
          if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('resize', function () { resize(true); });
          }
          return true;
        } catch (e) {
          api.ready = false; renderer = null;
          return false; /* headless shim / no WebGL: game continues without us */
        }
      }

      /* ------------------- layout (grid size changes) --------------------- */
      function rebuildLayout(size) {
        var i;
        if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); }
        gridHelper = new THREE.GridHelper(size * SPACING, size, 0x4d3f9e, 0x2a2358);
        gridHelper.position.y = 0.02; scene.add(gridHelper);
        if (rimMesh) { scene.remove(rimMesh); rimMesh.geometry.dispose(); rimMesh.material.dispose(); }
        if (rimGlow) { scene.remove(rimGlow); rimGlow.geometry.dispose(); rimGlow.material.dispose(); }
        var R = size * SPACING / 2 + 0.72;
        rimMesh = new THREE.Mesh(new THREE.TorusGeometry(R, 0.055, 8, 72),
          new THREE.MeshBasicMaterial({ color: 0x19e3ff }));
        rimGlow = new THREE.Mesh(new THREE.TorusGeometry(R, 0.17, 8, 72),
          new THREE.MeshBasicMaterial({ color: 0x19e3ff, transparent: true, opacity: 0.16,
            blending: THREE.AdditiveBlending, depthWrite: false }));
        rimMesh.rotation.x = rimGlow.rotation.x = Math.PI / 2;
        rimMesh.position.y = rimGlow.position.y = 0.05;
        scene.add(rimMesh); scene.add(rimGlow);
        if (!rimColorT) rimColorT = new THREE.Color(0x19e3ff);
        /* wipe the diff snapshot: survivors respawn elastically at new coords */
        for (i = 0; i < MAX_CELLS; i++) {
          if (cellCubes[i]) { cellCubes[i].visible = false; cubeFree.push(cellCubes[i]); cellCubes[i] = null; }
          if (!prevCells[i]) prevCells[i] = { id: -1, tier: -1 };
          else { prevCells[i].id = -1; prevCells[i].tier = -1; }
        }
        for (i = dying.length; i-- > 0;) {
          dying[i].mesh.visible = false; cubeFree.push(dying[i].mesh);
          dyingFree.push(dying[i]); dying.pop();
        }
        prevSize = size; prevSynced = true;
      }

      /* ---------------------- setBoard (diffing) -------------------------- */
      function setBoard(b) {
        if (b) board = b;
        var bd = board;
        if (!api.ready || !bd || !bd.cells) { prevSynced = false; return; }
        var n = bd.size * bd.size, i;
        if (!prevSynced || prevSize !== bd.size) { rebuildLayout(bd.size); camDist = 0; }
        for (i = 0; i < n; i++) {
          var c = bd.cells[i], p = prevCells[i], mesh = cellCubes[i];
          if (c) {
            if (!p || p.id !== c.id) { /* new cube: elastic scale-in */
              if (mesh) startDying(i, -1);
              cellCubes[i] = themeCube(acquireCube(), i, c, SPAWN);
            } else if (p.tier !== c.tier) { /* merge: overshoot + flash ring */
              cellCubes[i] = themeCube(mesh || acquireCube(), i, c, POP);
              ringAt(i, c.tier);
            }
            p.id = c.id; p.tier = c.tier;
          } else {
            if (p && p.id >= 0 && mesh) startDying(i, -1); /* popped: 0.1s shrink */
            p.id = -1; p.tier = -1;
          }
        }
        comDirty = true;
      }

      /* ------------------------- easing helpers --------------------------- */
      function elasticOut(t) {
        if (t <= 0) return 0; if (t >= 1) return 1;
        return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (Math.PI * 2 / 3)) + 1;
      }
      function backOut(t) {
        if (t <= 0) return 0; if (t >= 1) return 1;
        var c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      }

      /* ------------------------------ resize ------------------------------ */
      function resize(force) {
        if (!api.ready || !renderer) return;
        sizePoll = 0;
        var w = (stage && stage.clientWidth) || (typeof window !== 'undefined' && window.innerWidth) || 640;
        var h = (stage && stage.clientHeight) || (typeof window !== 'undefined' && window.innerHeight) || 480;
        if (w < 2 || h < 2) return;
        if (!force && Math.abs(w - vw) < 1 && Math.abs(h - vh) < 1) return;
        vw = w; vh = h;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camDist = fitDistance(board ? board.size : 5, camera.aspect);
        camera.updateProjectionMatrix();
      }

      /* ------------------------------- frame ------------------------------ */
      function frame(dt, game) {
        if (!api.ready || !renderer) return;
        if (dt > 0.05) dt = 0.05; if (dt < 0) dt = 0;
        time += dt;
        sizePoll -= dt; /* stage resize poll — cheap, every 0.5s */
        if (sizePoll <= 0) {
          sizePoll = 0.5;
          var sw = (stage && stage.clientWidth) || 0, sh = (stage && stage.clientHeight) || 0;
          if (sw > 2 && sh > 2 && (Math.abs(sw - vw) > 1 || Math.abs(sh - vh) > 1)) resize(true);
        }
        var size = board ? board.size : 5, n = size * size, i;
        if (comDirty) { /* board center of mass (tier-weighted) */
          comDirty = false;
          var sx = 0, sz = 0, wsum = 0, mass;
          for (i = 0; i < n; i++) {
            var cc = board && board.cells[i];
            if (cc) {
              cellToWorld(i, size, scratch);
              mass = cc.tier + 1;
              sx += scratch.x * mass; sz += scratch.z * mass; wsum += mass;
            }
          }
          if (wsum > 0) { comX = sx / wsum; comZ = sz / wsum; }
        }
        var lk = 1 - Math.exp(-3 * dt); /* camera eases toward center of mass */
        lookX += (comX * 0.28 - lookX) * lk;
        lookZ += (comZ * 0.28 - lookZ) * lk;
        if (camDist <= 0) camDist = fitDistance(size, camera.aspect);
        camera.position.set( /* top-down ~50 deg + subtle idle sway */
          lookX + Math.sin(time * 0.31) * 0.26 + Math.sin(time * 0.13) * 0.1,
          camDist * Math.sin(CAM_ELEV) + Math.sin(time * 0.41) * 0.12,
          camDist * Math.cos(CAM_ELEV) + Math.cos(time * 0.23) * 0.18);
        camera.lookAt(lookX, 0, lookZ + 0.4);
        camera.updateMatrixWorld();
        comboGlow = Math.max(0, comboGlow - dt * 1.6);
        var dActive = drag.active, dIdx = drag.idx;
        var effT = drag.target >= 0 ? drag.target :
          ((time - lastHitT < 0.25 && lastHitIdx >= 0) ? lastHitIdx : -1);
        /* live cubes */
        for (i = 0; i < n; i++) {
          var m = cellCubes[i];
          if (!m) continue;
          var d = m.userData, s = d.base, eK = 1 - Math.exp(-12 * dt);
          d.lift += (((dActive && i === dIdx) ? 0.55 : 0) - d.lift) * eK; /* drag lift */
          d.glow += (((dActive && i === dIdx) ? 1 : 0) - d.glow) * eK;
          if (d.mode === SPAWN) { /* elastic scale-in + drop */
            d.t += dt;
            var k = d.t / d.dur;
            if (k >= 1) d.mode = IDLE;
            else {
              s = Math.max(0.01, d.base * elasticOut(k));
              m.position.y = d.base / 2 + d.lift + (1 - Math.min(k * 2.2, 1)) * 0.8;
            }
          } else if (d.mode === POP) { /* merge overshoot + emissive flash */
            d.t += dt;
            var k2 = d.t / d.dur;
            if (k2 >= 1) { d.mode = IDLE; d.glowP = 0; }
            else { s = d.base * Math.max(0.05, backOut(k2)); d.glowP = 1 - k2; }
          }
          if (d.mode === IDLE) s = d.base * (1 + d.glow * 0.12);
          if (d.mode !== SPAWN) m.position.y = d.base / 2 + d.lift;
          m.scale.set(s, s, s);
          m.rotation.z = d.glow * Math.sin(time * 5) * 0.06;
          m.material.emissiveIntensity = d.baseE * (0.9 + 0.1 * Math.sin(time * 2.2 + i * 1.7)) *
            (1 + comboGlow * 0.35) * (1 + d.glow * 0.9) * (1 + (d.mode === POP ? d.glowP * 1.6 : 0));
          if (d.lucky) { /* gold + idle sparkle */
            d.sprite.position.y = 0.95 + Math.sin(time * 3 + i) * 0.08;
            var ss = 0.34 + 0.12 * Math.sin(time * 4 + i * 2);
            d.sprite.scale.set(ss, ss, 1);
            m.rotation.y = Math.sin(time * 1.3 + i) * 0.05;
          } else if (m.rotation.y !== 0) m.rotation.y = 0;
        }
        /* dying cubes: pop shrink (0.1s) or merge fly */
        for (i = dying.length; i-- > 0;) {
          var e = dying[i];
          e.t += dt;
          var q = e.t / e.dur;
          if (q >= 1) {
            e.mesh.visible = false; cubeFree.push(e.mesh);
            dyingFree.push(e); dying[i] = dying[dying.length - 1]; dying.pop();
            continue;
          }
          var sc = Math.max(0.01, e.fs * (1 - q));
          if (e.fly) {
            var fk = 1 - Math.exp(-14 * dt);
            e.mesh.position.x += (e.tx - e.mesh.position.x) * fk;
            e.mesh.position.z += (e.tz - e.mesh.position.z) * fk;
            e.mesh.position.y = e.fy + Math.sin(q * Math.PI) * 0.5;
            e.mesh.rotation.y = e.rot + q * 1.2;
          }
          e.mesh.scale.set(sc, sc, sc);
        }
        for (i = 0; i < rings.length; i++) { /* merge flash rings */
          var r = rings[i]; if (!r.userData.on) continue;
          r.userData.t += dt;
          var rq = r.userData.t / r.userData.dur;
          if (rq >= 1) { r.userData.on = false; r.visible = false; continue; }
          var rs = 0.6 + rq * 2.4;
          r.scale.set(rs, rs, rs);
          r.material.opacity = 0.85 * (1 - rq);
        }
        for (i = 0; i < bolts.length; i++) { /* lightning flicker */
          var bo = bolts[i]; if (!bo.userData.on) continue;
          bo.userData.t += dt;
          var bq = bo.userData.t / bo.userData.dur;
          if (bq >= 1) { bo.userData.on = false; bo.visible = false; continue; }
          bo.material.opacity = (1 - bq) * (bq < 0.5 ? 1 : 0.45);
        }
        if (rimMesh) { /* neon rim: breathe, pulse, ease toward best tier color */
          rimPulse = Math.max(0, rimPulse - dt * 2.2);
          rimMesh.material.color.lerp(rimColorT, 1 - Math.exp(-1.5 * dt));
          rimGlow.material.color.copy(rimMesh.material.color);
          var rb = 1 + 0.02 * Math.sin(time * 1.7) + rimPulse * 0.05;
          rimMesh.scale.set(rb, rb, 1); rimGlow.scale.set(rb, rb, 1);
          rimGlow.material.opacity = 0.16 + 0.06 * Math.sin(time * 1.7) + rimPulse * 0.3;
        }
        starKick = Math.max(0, starKick - dt * 0.5);
        starA.rotation.y = time * (0.02 + starKick * 0.1);
        starB.rotation.y = -time * 0.03;
        starA.material.opacity = 0.55 + 0.2 * Math.sin(time * 0.7);
        starB.material.opacity = 0.5 + 0.25 * Math.sin(time * 0.9 + 2);
        if (dActive && effT >= 0 && effT < n && effT !== dIdx) { /* drop highlight */
          cellToWorld(effT, size, scratch);
          highlight.position.set(scratch.x, 0.05, scratch.z);
          var dc = board && board.cells[dIdx], tc = board && board.cells[effT];
          highlight.material.color.set(
            (dc && tc && dc.tier === tc.tier) ? 0xffd24a : (tc ? 0x666a80 : 0x3dd6f0));
          highlight.material.opacity = 0.55 + 0.25 * Math.sin(time * 7);
          var hs = 1 + 0.06 * Math.sin(time * 7);
          highlight.scale.set(hs, hs, 1);
          highlight.visible = true;
        } else highlight.visible = false;
        renderer.render(scene, camera);
      }

      /* --------------------------- hit-testing ---------------------------- */
      function screenToCell(sx, sy) { /* canvas-relative px -> {idx, cell}|null */
        if (!api.ready) return null;
        var idx = screenToCellCore(sx, sy, board ? board.size : 5, camRef, vw, vh);
        if (idx < 0) { lastHitIdx = -1; return null; }
        lastHitIdx = idx; lastHitT = time; /* memo feeds the drag highlight */
        return { idx: idx, cell: board ? (board.cells[idx] || null) : null };
      }
      function cellToScreen(idx) {
        if (!api.ready) return null;
        var o = cellToScreenCore(idx, board ? board.size : 5, camRef, vw, vh, scr2);
        return (o.x < 0) ? null : { x: o.x, y: o.y };
      }
      function setDrag(idx, active) {
        dragSet(drag, idx, active);
        if (!active) lastHitIdx = -1;
      }
      api.init = init; api.frame = frame; api.setBoard = setBoard; api.resize = resize;
      api.screenToCell = screenToCell; api.cellToScreen = cellToScreen; api.setDrag = setDrag;
      api.setDragTarget = function (idx) { dragTarget(drag, idx); };
    }
  }

  return api;
})();
