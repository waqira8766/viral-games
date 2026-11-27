/* CRYPTFALL — test/render3d-smoke.js
 * Executes the REAL browser path of js/render3d.js in node:
 *   - loads the actual vendored three.js (UMD -> globalThis.THREE)
 *   - stubs only WebGLRenderer + the handful of DOM APIs the module touches
 *   - everything else (Scene, BufferGeometry, merging, Raycaster, Camera
 *     projection, Color math, CanvasTexture bookkeeping) is real three.js.
 * Drives init -> buildFloor -> frame across every entity state
 * (windup, dashT, flashT, iframes, opened chest, aggro boss, death ghosts,
 * weapon swaps, projectiles, pickups, particles, float text).
 * Run: node test/render3d-smoke.js
 */
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var base = path.join(__dirname, '..');

/* ---------- DOM shims (before render3d.js loads: it self-inits) ---------- */
function mockCtx2d() {
  return {
    fillStyle: '', strokeStyle: '', shadowColor: '', shadowBlur: 0,
    fillRect: function () {}, fillText: function () {},
    createRadialGradient: function () { return { addColorStop: function () {} }; },
    createLinearGradient: function () { return { addColorStop: function () {} }; }
  };
}
function mockCanvas() {
  var c = { width: 64, height: 64, style: {}, addEventListener: function () {} };
  c.getContext = function (kind) { return kind === '2d' ? mockCtx2d() : null; };
  return c;
}
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1.5,
  addEventListener: function () {}
};
globalThis.document = {
  createElement: function () { return mockCanvas(); },
  getElementById: function (id) { return id === 'game3d' ? mockCanvas() : mockCanvas(); },
  readyState: 'loading',
  addEventListener: function () {}
};

/* ---------- real three.js, fake renderer ---------- */
globalThis.THREE = require(path.join(base, '../shared/vendor/three.min.js'));
var renderCount = 0;
function FakeRenderer(canvas) { this.domElement = canvas; }
FakeRenderer.prototype.setPixelRatio = function () {};
FakeRenderer.prototype.setClearColor = function () {};
FakeRenderer.prototype.setSize = function (w, h) { this.domElement.width = w; this.domElement.height = h; };
FakeRenderer.prototype.render = function () { renderCount++; };
FakeRenderer.prototype.getContext = function () { return { fake: true }; };
THREE.WebGLRenderer = FakeRenderer;

/* ---------- load modules (engine+content+dungeon+entities are node-safe) ---------- */
function load(f) {
  vm.runInThisContext(fs.readFileSync(path.join(base, f), 'utf8'), { filename: f });
}
load('js/engine.js');
load('js/dungeon.js');
load('js/content.js');
load('js/entities.js');
load('js/render3d.js');

var CF = globalThis.CF;
var R = CF.Render3D;
var pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name); }
}

CF.Engine.W = 1280; CF.Engine.H = 720;
CF.Engine.time = 0;

/* ---------- the 3D path came up ---------- */
check('init: WebGL path active with stubbed renderer', R.available === true && R.active === true);
check('init: CF.Camera.screenToWorld monkey-patched to the raycast', CF.Camera.screenToWorld !== R._origScreenToWorld);
check('init: CF.Camera.worldToScreen patched for HUD anchoring', CF.Camera.worldToScreen !== R._origWorldToScreen);

/* ---------- aim raycast round-trip (real Raycaster + projection) ----------
 * worldToScreen anchors HUD elements at y=1.0, while screenToWorld raycasts
 * the ground plane (that is the aim contract) — so the exact invariant is:
 * ground-plane projection -> screen -> ray back onto y=0 must return the
 * same world point. */
function aimRoundTrip(wx, wy) {
  var v = new THREE.Vector3(wx * R.S, 0, wy * R.S).project(R._camera);
  var sx = (v.x * 0.5 + 0.5) * CF.Engine.W;
  var sy = (-v.y * 0.5 + 0.5) * CF.Engine.H;
  var w = CF.Camera.screenToWorld(sx, sy);
  return Math.abs(w.x - wx) < 2.5 && Math.abs(w.y - wy) < 2.5;   /* ~2.5px of a 40px tile */
}

/* ---------- fake game with REAL entities ---------- */
var d = CF.DungeonGen.generate({ width: 48, height: 48, floor: 1, seed: 99 });
var game = {
  dungeon: d, floor: 1,
  player: null, enemies: [], projectiles: [], pickups: [], chests: [], boss: null,
  state: 'play'
};
game.player = new Player(game);
game.player.x = d.spawn.x * CF.TILE + 20;
game.player.y = d.spawn.y * CF.TILE + 20;
game.player.aim = 0.4;

function mkEnemy(id, x, y) {
  return new Enemy(game, CF.ENEMIES[id], 1, x, y);
}
var p = game.player;
game.enemies.push(mkEnemy('rat', p.x + 60, p.y + 10));
game.enemies.push(mkEnemy('slime', p.x - 70, p.y + 40));
game.enemies.push(mkEnemy('wraith', p.x + 30, p.y - 90));   /* alpha wobble path */
game.enemies.push(mkEnemy('spider', p.x - 40, p.y - 60));   /* charger: windup + dashT */
game.boss = mkEnemy('bone_colossus', p.x + 120, p.y + 120); /* crown + purple light */
game.enemies.push(game.boss);
game.enemies[0].hp = game.enemies[0].maxHp * 0.5;           /* hp bar path */
game.chests.push(new Chest(p.x + 40, p.y + 40));
game.chests.push(new Chest(p.x - 50, p.y - 30));
game.pickups.push(new Pickup('gold', p.x + 20, p.y - 20, { value: 5 }));
game.pickups.push(new Pickup('potion', p.x - 20, p.y + 25, { id: 'potion_small' }));
game.pickups.push(new Pickup('gear', p.x + 25, p.y + 25, { item: CF.ITEMS.short_sword }));
game.projectiles.push({ x: p.x + 30, y: p.y, vx: 100, vy: 0, radius: 5, color: '#ff8a3a', friendly: true, life: 1, dead: false, hitSet: [], pierce: 0 });
CF.Particles.burst(p.x, p.y, { color: '#ffd94a', count: 40, speed: 120, glow: true });
CF.FloatText.add(p.x, p.y - 20, 'hello 3D', '#fff', 14);

/* ---------- drive frames across every visible state ---------- */
var frames = 0;
function runFrames(n, fn) {
  for (var i = 0; i < n; i++) {
    CF.Engine.time += 0.016;
    if (fn) fn(i);
    try { R.frame(game, 0.016); frames++; }
    catch (err) { console.log('   frame error at ' + frames + ':', err.message); return false; }
  }
  return true;
}

check('frame: 60 frames render without throwing (player idle)', runFrames(60));
check('frame: renderer.render actually called', renderCount >= 60);

/* ---------- merged static geometry audit (real BufferGeometry data) ---------- */
function auditWinding(mesh) {
  var g = mesh.geometry, pos = g.attributes.position, nrm = g.attributes.normal, idx = g.index;
  var bad = 0;
  for (var t = 0; t < idx.count; t += 3) {
    var a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    var ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    var e1x = pos.getX(b) - ax, e1y = pos.getY(b) - ay, e1z = pos.getZ(b) - az;
    var e2x = pos.getX(c) - ax, e2y = pos.getY(c) - ay, e2z = pos.getZ(c) - az;
    var cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    if (cx * nrm.getX(a) + cy * nrm.getY(a) + cz * nrm.getZ(a) <= 0) bad++;
  }
  return bad;
}
var floorMeshes = R._floorGroup.children.filter(function (m) { return m.isMesh; });
check('buildFloor: merged wall/floor/door meshes present', floorMeshes.length >= 2);
var badTris = 0, hasColors = true, wallMesh = null, floorMesh = null;
floorMeshes.forEach(function (m) {
  badTris += auditWinding(m);
  if (!m.geometry.attributes.color) hasColors = false;
  var pos = m.geometry.attributes.position, hasHigh = false;
  for (var i2 = 0; i2 < pos.count; i2 += 7) if (pos.getY(i2) > 0.5) { hasHigh = true; break; }
  if (hasHigh) { if (!wallMesh) wallMesh = m; }        /* wall boxes are 1 unit tall */
  else { if (!floorMesh) floorMesh = m; }              /* floor quads / door slabs lie low */
});
check('buildFloor: every static triangle CCW vs its normal (no backface holes)', badTris === 0);
check('buildFloor: vertex colors baked on all static meshes', hasColors);
if (wallMesh && floorMesh) {
  var wp = wallMesh.geometry.attributes.position, wc = wallMesh.geometry.attributes.color;
  var botB = 0, botN = 0, topB = 0, topN = 0, i2;
  for (i2 = 0; i2 < wp.count; i2++) {
    var lum = wc.getX(i2) + wc.getY(i2) + wc.getZ(i2);
    if (wp.getY(i2) < 0.1) { botB += lum; botN++; }
    else if (wp.getY(i2) > 0.9) { topB += lum; topN++; }
  }
  check('buildFloor: wall AO — base vertices darker than top vertices', botN > 0 && topN > 0 && (botB / botN) < (topB / topN));
  var fp = floorMesh.geometry.attributes.position, fc = floorMesh.geometry.attributes.color;
  var minL = 9, maxL = -9;
  for (i2 = 0; i2 < fp.count; i2 += 4) {   /* one sample per tile quad */
    var lum2 = fc.getX(i2) + fc.getY(i2) + fc.getZ(i2);
    if (lum2 < minL) minL = lum2;
    if (lum2 > maxL) maxL = lum2;
  }
  check('buildFloor: per-tile floor tone variance present', maxL - minL > 0.01);
} else {
  check('buildFloor: wall + floor meshes identified', false);
}

/* aim + move + attack cycle (melee arc, trail via dash) */
check('frame: moving + attacking + dashing frames', runFrames(90, function (i) {
  p.x += 40 * 0.016 * Math.cos(p.aim);
  p.y += 40 * 0.016 * Math.sin(p.aim);
  p.aim = 0.4 + Math.sin(i * 0.05) * 1.2;
  p.bob += 0.16;
  p.attackT = (i % 20 < 6) ? 0.12 : 0;      /* swing arc windows */
  if (i % 30 === 0) {
    p.dashT = 0.16;
    p.trail.push({ x: p.x, y: p.y, life: 0.25 });
  }
  for (var t2 = p.trail.length - 1; t2 >= 0; t2--) { p.trail[t2].life -= 0.016; if (p.trail[t2].life <= 0) p.trail.splice(t2, 1); }
}));

/* every enemy telegraph/hit/dash state */
check('frame: windup + flash + dashT + hurt states all render', runFrames(80, function (i) {
  var sp = game.enemies[3];
  sp.windup = (i % 30 < 15) ? 0.45 : 0;
  sp.dashT = (i % 30 >= 15 && i % 30 < 22) ? 0.2 : 0;
  game.enemies[0].flashT = (i % 10 < 2) ? 0.09 : 0;
  game.enemies[1].aggro = true;
  game.boss.aggro = i > 20;
  p.iframes = (i % 40 < 20) ? 0.3 : 0;
  p.hurtFlash = (i % 40 === 0) ? 1 : Math.max(0, p.hurtFlash - 0.025);
  CF.Camera.shakeX = Math.sin(i) * 5;
  CF.Camera.shakeY = Math.cos(i) * 5;
}));

/* weapon swap: melee -> ranged -> melee */
p.weapon = CF.ITEMS.ember_wand;
check('frame: weapon swap to ranged renders', runFrames(30));
p.weapon = CF.ITEMS.war_axe;
check('frame: weapon swap back to melee (arc geo rebuilt + disposed)', runFrames(30, function (i) { p.attackT = (i % 14 < 5) ? 0.1 : 0; }));

/* chest opens (lid easeOutBack), pickups magnet + collect, enemy dies (ghost) */
game.chests[0].opened = true;
game.pickups[0].magnet = true;
check('frame: chest lid animation + magnet + death ghost paths', runFrames(60, function (i) {
  game.pickups[0].x += (p.x - game.pickups[0].x) * 0.08;
  game.pickups[0].y += (p.y - game.pickups[0].y) * 0.08;
  game.pickups[0].bob += 0.06;
  if (i === 20) { game.enemies.splice(0, 1); }   /* rat dies -> ghost + hp bar removal */
  if (i === 40) { game.pickups.splice(2, 1); }   /* gear collected */
}));

/* new floor: full rebuild + dispose of old static geometry + camera snap */
var d2 = CF.DungeonGen.generate({ width: 48, height: 48, floor: 2, seed: 1234 });
var oldGeo = R._floorRef;
game.dungeon = d2;
check('frame: floor change rebuilds + disposes old geometry, camera snaps', runFrames(40) && R._floorRef === d2 && oldGeo !== d2);

/* boss dies: purple light fade-out path */
game.boss.hp = 0;
game.enemies.splice(game.enemies.indexOf(game.boss), 1);
game.boss = null;
check('frame: boss removal fades the purple light', runFrames(30));

/* float text projection through the real camera */
CF.FloatText.list.length = 0;
CF.FloatText.add(p.x, p.y - 20, '+10', '#ffd94a', 13);
R.frame(game, 0.016);
var pf = R.projectedFloats(game);
check('projectedFloats: live entries project through the 3D camera', pf.count === 1 && pf.items[0].text === '+10');
check('projectedFloats: on-screen coordinates', pf.items[0].x > 0 && pf.items[0].x < 1280 && pf.items[0].y > 0 && pf.items[0].y < 720);
var drew = 0;
var mockHud = { textAlign: '', globalAlpha: 1, font: '', fillStyle: '', fillText: function () { drew++; } };
R.drawProjectedFloats(mockHud, game);
check('drawProjectedFloats paints the projected list (2 calls: shadow + fill)', drew === 2);

/* aim accuracy: round-trip world -> screen -> world now that camera follows */
var okAim = true;
[[p.x, p.y], [p.x + 200, p.y - 100], [p.x - 180, p.y + 160]].forEach(function (pt) {
  if (!aimRoundTrip(pt[0], pt[1])) okAim = false;
});
check('mouse aim raycast: world->screen->world round-trip exact (real Raycaster)', okAim);

/* max stress: 30 enemies + 20 projectiles + 60 pickups all render */
game.enemies.length = 0;
for (var e = 0; e < 30; e++) game.enemies.push(mkEnemy('rat', p.x + (e % 6) * 50 - 100, p.y + Math.floor(e / 6) * 50 - 100));
game.projectiles.length = 0;
for (e = 0; e < 20; e++) game.projectiles.push({ x: p.x + e * 12, y: p.y + 30, vx: 0, vy: 0, radius: 4 + (e % 3), color: ['#ff8a3a', '#e8b050', '#a06bff'][e % 3], friendly: true, life: 2, dead: false, hitSet: [], pierce: 0 });
game.pickups.length = 0;
for (e = 0; e < 60; e++) game.pickups.push(new Pickup('gold', p.x + (e % 10) * 20 - 90, p.y + 80 + Math.floor(e / 10) * 20, { value: 1 }));
var t0 = Date.now();
check('frame: 30-enemy + 20-projectile + 60-pickup stress batch renders', runFrames(5) && runFrames(60));
var stressMs = Date.now() - t0;
/* warm-up created the pooled slots; steady-state frame cost is what matters */
var tSteady = Date.now();
runFrames(60);
var steadyMs = Date.now() - tSteady;
check('frame: stress batch (incl. one-time pool creation) under 700ms', stressMs < 700);
check('frame: steady-state (pooled) under 200ms for 60 frames', steadyMs < 200);
console.log('   stress: 60 frames with 30 enemies in ' + stressMs.toFixed(0) + 'ms; steady-state ' + steadyMs.toFixed(0) + 'ms (' + (steadyMs / 60).toFixed(2) + 'ms/frame)');

/* disable() restores the 2D fallback contract */
R.disable();
check('disable: restores original CF.Camera methods + deactivates', R.active === false &&
  CF.Camera.screenToWorld === R._origScreenToWorld && CF.Camera.worldToScreen === R._origWorldToScreen);

console.log(fail === 0 ? '\nALL TESTS PASSED (' + pass + ')' : '\n' + fail + ' FAILURES of ' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
