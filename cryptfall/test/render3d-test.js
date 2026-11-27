/* CRYPTFALL — test/render3d-test.js
 * Node-safe tests for CF.Render3D's PURE helpers (tile classification,
 * camera/easing math, pooling invariants, disposal logic, projection glue).
 * The 3D implementation itself is DOM/THREE-guarded and stays dormant here —
 * these tests also pin down that dormancy so js/render3d.js can never affect
 * the headless game. Run: node test/render3d-test.js
 */
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var base = path.join(__dirname, '..');
function load(f) {
  vm.runInThisContext(fs.readFileSync(path.join(base, f), 'utf8'), { filename: f });
}

/* engine.js provides CF.Camera/Particles/FloatText + math helpers (node-safe);
 * render3d.js must stay dormant without DOM/THREE */
load('js/engine.js');
load('js/render3d.js');

var R = globalThis.CF.Render3D;
var pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name); }
}

/* ---------- dormancy / fallback contract ---------- */
check('render3d loads in node without DOM/THREE (dormant)', R.available === false && R.active === false);
check('DOM-guarded internals absent in node', R.init === undefined && R.buildFloor === undefined && R.frame === undefined);
check('CF.Camera.screenToWorld NOT monkey-patched while dormant (2D fallback intact)',
  CF.Camera.screenToWorld.toString().indexOf('return { x: sx') !== -1);
CF.Camera.x = 0; CF.Camera.y = 0; CF.Camera.shakeX = 0; CF.Camera.shakeY = 0;
var sw = CF.Camera.screenToWorld(10, 20);
check('engine screenToWorld still works untouched', sw.x === 10 && sw.y === 20);
check('pure glue exposed in node', typeof R.projectedFloats === 'function' && typeof R.drawProjectedFloats === 'function');

/* ---------- tile classification ---------- */
check('tileKind: wall/floor/door/stairs', R.tileKind(0) === 'wall' && R.tileKind(1) === 'floor' &&
  R.tileKind(2) === 'door' && R.tileKind(3) === 'stairs');
check('isWallTile / isWalkableTile', R.isWallTile(0) === true && R.isWallTile(3) === false &&
  R.isWalkableTile(1) === true && R.isWalkableTile(0) === false);

var D = {
  width: 7, height: 7,
  tiles: new Uint8Array([
    0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
    0, 0, 1, 1, 1, 0, 0,
    0, 0, 1, 2, 1, 0, 0,
    0, 0, 1, 1, 3, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0
  ]),
  exit: { x: 4, y: 4 }
};
var walls = R.collectWallTiles(D);
check('collectWallTiles: only walls touching walkable tiles (8-dir)', walls.length === 16);
var dup = {}, unique = true;
walls.forEach(function (w) { if (dup[w.x + ',' + w.y]) unique = false; dup[w.x + ',' + w.y] = 1; });
check('collectWallTiles: no duplicates', unique);
check('collectWallTiles: corner wall included via diagonal adjacency', dup['1,1'] === 1 && dup['5,5'] === 1);
check('collectWallTiles: far wall excluded', dup['0,0'] === undefined && dup['6,6'] === undefined);
var D2 = { width: 3, height: 3, tiles: new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]), exit: { x: 0, y: 0 } };
check('collectWallTiles: lone interior wall surrounded by floor is meshed', R.collectWallTiles(D2).length === 1);

/* ---------- coordinate mapping ---------- */
var ws = R.worldToScene(120, 200);
check('worldToScene: 1 tile = 1 unit, (x,y) -> (x, z=y)', ws.x === 3 && ws.z === 5 && R.S === 1 / 40);

/* ---------- camera / easing math ---------- */
check('lerpRate(0) = 0 (no jitter on paused frames)', R.lerpRate(0, 0.0008) === 0);
var k1 = R.lerpRate(0.016, 0.0008), k2 = R.lerpRate(0.032, 0.0008);
check('lerpRate dt-normalized: two half-frames == one full frame', Math.abs(1 - Math.pow(1 - k1, 2) - k2) < 1e-9);
check('lerpRate monotonic in dt', R.lerpRate(0.01, 0.0008) < R.lerpRate(0.02, 0.0008) && R.lerpRate(0.02, 0.0008) < R.lerpRate(0.04, 0.0008));
check('lerpRate bounded <= 1', R.lerpRate(10, 0.0008) <= 1);
check('angleLerp wraps the shortest way (3.0 -> -3.0 through pi)', Math.abs(R.angleLerp(3.0, -3.0, 0.5) - Math.PI) < 1e-9);
check('angleLerp interpolates within the same wrap', Math.abs(R.angleLerp(0.2, 0.4, 0.5) - 0.3) < 1e-9);
check('easeOutBack endpoints exact', Math.abs(R.easeOutBack(0)) < 1e-6 && Math.abs(R.easeOutBack(1) - 1) < 1e-6);
check('easeOutBack overshoots mid-swing (the pop)', R.easeOutBack(0.5) > 1.05 && R.easeOutBack(0.5) < 1.2);
check('easeOutBack clamps outside [0,1]', Math.abs(R.easeOutBack(-0.5)) < 1e-9 && Math.abs(R.easeOutBack(1.5) - 1) < 1e-9);

var goal = R.cameraGoal(2000, 1600, 0, 1.5);
check('cameraGoal: aim=0 lookahead shifts +x only', Math.abs(goal.x - 51.5) < 1e-9 && Math.abs(goal.z - 40) < 1e-9);
var goal2 = R.cameraGoal(2000, 1600, Math.PI / 2, 1.5);
check('cameraGoal: aim=pi/2 lookahead shifts +z only', Math.abs(goal2.x - 50) < 1e-9 && Math.abs(goal2.z - 41.5) < 1e-9);

/* ---------- deterministic tone/flicker ---------- */
check('flicker deterministic', R.flicker(3.7) === R.flicker(3.7));
check('flicker bounded [0,1]', R.flicker(0) >= 0 && R.flicker(100) <= 1 && R.flicker(0.5) >= 0 && R.flicker(0.5) <= 1);
var fsum = 0, fdistinct = {}, fi;
for (fi = 0; fi < 2000; fi += 0.05) { var fv = R.flicker(fi); fsum += fv; fdistinct[String(fv)] = 1; }
check('flicker averages ~0.5 and varies over time', Math.abs(fsum / 40000 - 0.5) < 0.06 && Object.keys(fdistinct).length > 100);
check('floorTone deterministic + in [0,1)', R.floorTone(3, 4) === R.floorTone(3, 4) && R.floorTone(3, 4) >= 0 && R.floorTone(3, 4) < 1);
var tones = {}, tx, ty;
for (tx = 0; tx < 20; tx++) for (ty = 0; ty < 20; ty++) tones[String(R.floorTone(tx, ty))] = 1;
check('floorTone varies across tiles (per-tile tone variance)', Object.keys(tones).length > 100);
check('aoWalls: darker with more wall neighbors, clamped at 4',
  R.aoWalls(0) === 1 && R.aoWalls(1) < R.aoWalls(0) && R.aoWalls(3) < R.aoWalls(2) && R.aoWalls(9) === R.aoWalls(4));

/* ---------- color parsing ---------- */
var g = R.hexToRGB('#ffd94a');
check('hexToRGB parses #rrggbb', Math.abs(g.r - 1) < 1e-9 && Math.abs(g.g - 217 / 255) < 1e-9 && Math.abs(g.b - 74 / 255) < 1e-9);
var w3 = R.hexToRGB('#fff');
check('hexToRGB expands #rgb shorthand', Math.abs(w3.r - 1) < 1e-9 && Math.abs(w3.g - 1) < 1e-9 && Math.abs(w3.b - 1) < 1e-9);
check('hexToRGB caches (identity)', R.hexToRGB('#ffd94a') === g);
check('hexToRGB garbage -> white', (function () { var c = R.hexToRGB('zzz'); return c.r === 1 && c.g === 1 && c.b === 1; })());

/* ---------- pooling invariants ---------- */
var made = 0;
var pool = R.makePool(6, function () { return { id: ++made }; });
var objs = [], i;
for (i = 0; i < 10; i++) { var o = pool.acquire(); if (o) objs.push(o); }
check('pool stops growing at cap', pool.live === 6 && objs.length === 6);
check('pool returns null past cap, not garbage', (function () { var z = pool.acquire(); return z === null; })());
for (i = 0; i < objs.length; i++) pool.release(objs[i]);
check('pool inUse tracks releases', pool.inUse() === 0);
check('pool reuses released objects (zero allocation at steady state)',
  pool.acquire() === objs[5] && pool.acquire() === objs[4] && pool.live === 6 && made === 6);

/* simulate churn: inUse never exceeds cap, live never grows past cap, no leaks */
var simPool = R.makePool(8, function () { return { n: 0 }; });
var held = [], okSim = true, rseed = 42;
function srand() { rseed = (rseed * 48271) % 2147483647; return rseed / 2147483647; }
for (i = 0; i < 20000; i++) {
  if (srand() < 0.55) {
    var a2 = simPool.acquire();
    if (a2 === null) { if (simPool.inUse() < 8) okSim = false; }
    else { if (simPool.inUse() > 8) okSim = false; held.push(a2); }
  } else if (held.length) {
    simPool.release(held.pop());
  }
  if (simPool.live > 8) { okSim = false; break; }
}
while (held.length) simPool.release(held.pop());
check('pool invariants hold across 20k-op churn (cap never exceeded, steady reuse)', okSim && simPool.live === 8);

/* ---------- disposal logic ---------- */
function fakeRes(name, bag) {
  return { name: name, dispose: function () { bag.push(name); } };
}
var bag = [];
var matA = fakeRes('matA', bag), matB = fakeRes('matB', bag);
var geoA = fakeRes('geoA', bag), geoB = fakeRes('geoB', bag), geoC = fakeRes('geoC', bag);
var tree = {
  children: [
    { geometry: geoA, material: matA, children: [] },
    { geometry: geoB, material: matA, children: [ /* matA shared */ ] },
    { geometry: geoC, material: [matA, matB], children: [] },
    { children: [ { geometry: geoA, material: matB, children: [] } ] }
  ]
};
var count = R.disposeObject3D(tree);
check('disposeObject3D disposes every geometry + material exactly once (shared deduped)',
  count === 5 && bag.indexOf('geoA') !== -1 && bag.indexOf('geoB') !== -1 && bag.indexOf('geoC') !== -1 &&
  bag.indexOf('matA') !== -1 && bag.indexOf('matB') !== -1 && bag.length === 5);
check('disposeObject3D tolerates empty/missing nodes', R.disposeObject3D(null) === 0 && R.disposeObject3D({}) === 0 &&
  R.disposeObject3D({ children: [{}] }) === 0);

/* ---------- float-text projection glue (dormant path) ---------- */
var pf = R.projectedFloats({ player: null });
check('projectedFloats dormant -> count 0, preallocated slot list', pf.count === 0 && Array.isArray(pf.items) && pf.items.length === 64);
CF.FloatText.add(100, 100, 'hello', '#fff', 14);
var pf2 = R.projectedFloats({ player: null });
check('projectedFloats dormant even with live float texts', pf2.count === 0);
var drew = 0;
var mockCtx = {
  globalAlpha: 1, font: '', textAlign: 'left', fillStyle: '',
  fillText: function () { drew++; }
};
R.drawProjectedFloats(mockCtx, {});
check('drawProjectedFloats dormant -> no draws, no throw', drew === 0);
CF.FloatText.clear();

/* ---------- perf/pool budget constants ---------- */
check('mesh budgets: >=30 enemies, >=256 particles, >=64 floats',
  R.MAX_ENEMIES >= 30 && R.MAX_PARTICLES >= 256 && R.MAX_FLOATS >= 64);

console.log(fail === 0 ? '\nALL TESTS PASSED (' + pass + ')' : '\n' + fail + ' FAILURES of ' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
