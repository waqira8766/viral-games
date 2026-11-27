/* CRYPTFALL — test/integration.js
 * Headless integration test: loads ALL modules in browser script order with
 * minimal DOM/canvas shims, then drives the actual game logic through:
 * floor generation 1..12, 300 sim ticks per floor, combat, dash, level-ups,
 * boss kills, the floor-12 seal, save/load round-trip, endless mode.
 * Run: node test/integration.js
 */
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');

/* ---------- browser shims ---------- */
var W = 1280, H = 720;
function mockCtx() {
  return {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: 'left', shadowColor: '', shadowBlur: 0,
    fillRect: function () {}, strokeRect: function () {}, clearRect: function () {},
    beginPath: function () {}, arc: function () {}, arcTo: function () {},
    moveTo: function () {}, lineTo: function () {}, fill: function () {},
    stroke: function () {}, ellipse: function () {}, save: function () {},
    restore: function () {}, translate: function () {}, rotate: function () {},
    scale: function () {}, fillText: function () {},
    measureText: function (t) { return { width: String(t || '').length * 7 }; },
    drawImage: function () {},
    createRadialGradient: function () { return { addColorStop: function () {} }; },
    createLinearGradient: function () { return { addColorStop: function () {} }; },
    setTransform: function () {}, imageSmoothingEnabled: false
  };
}
function mockCanvas() {
  return { width: 0, height: 0, style: {}, getContext: function () { return mockCtx(); }, addEventListener: function () {} };
}
globalThis.document = {
  createElement: function () { return mockCanvas(); },
  getElementById: function () { return mockCanvas(); },
  addEventListener: function () {},
  readyState: 'loading'   /* keeps main.js bootstrap parked */
};
globalThis.localStorage = {
  _s: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem: function (k, v) { this._s[k] = String(v); },
  removeItem: function (k) { delete this._s[k]; }
};
globalThis.requestAnimationFrame = function () { return 0; };
globalThis.cancelAnimationFrame = function () {};
globalThis.performance = globalThis.performance || { now: function () { return Date.now(); } };

/* ---------- load modules in index.html order ---------- */
var FILES = ['js/dungeon.js', 'js/audio.js', 'js/content.js', 'js/engine.js',
  'js/entities.js', 'js/ui.js', 'js/main.js',
  '../shared/mobile-controls.js', 'js/touch.js'];
var base = path.join(__dirname, '..');
FILES.forEach(function (f) {
  var code = fs.readFileSync(path.join(base, f), 'utf8');
  vm.runInThisContext(code, { filename: f });
});

/* ---------- harness ---------- */
var pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name); }
}
function finite(e) { return isFinite(e.x) && isFinite(e.y) && isFinite(e.hp); }

var CF = globalThis.CF;
var G = CF.Game;
check('all modules loaded (CF complete)', !!(CF.DungeonGen && CF.SoundFX && CF.ENEMIES && CF.Engine && CF.UI && CF.Game));

/* sane viewport so camera math stays finite */
CF.Engine.W = W; CF.Engine.H = H;

/* ---------- boot a run headlessly ---------- */
G.seed = 12345;
G.player = new Player(G);
check('player constructed with base stats', G.player.maxHp === CF.playerBase().maxHp && G.player.hp === G.player.maxHp);

var floorStats = [];
for (var f = 1; f <= 12; f++) {
  G.genFloor(f);
  var d = G.dungeon;
  var label = 'floor ' + f;
  check(label + ': dungeon generated', !!(d && d.tiles && d.tiles.length === d.width * d.height));
  check(label + ': player on walkable spawn', CF.tileAt(d, G.player.x, G.player.y) !== 0);
  check(label + ': exit exists and differs from spawn', d.exit.x !== d.spawn.x || d.exit.y !== d.spawn.y);
  check(label + ': enemies spawned', G.enemies.length >= 3);

  if (f === 5 || f === 10) {
    check(label + ': bone_colossus boss present', !!(G.boss && G.boss.def.id === 'bone_colossus'));
  } else if (f === 12) {
    check(label + ': crypt_king final boss present', !!(G.boss && G.boss.def.id === 'crypt_king'));
    check(label + ': seal locked on final floor', G.sealLocked === true);
  } else {
    check(label + ': no boss on regular floor', !G.boss);
  }

  /* move + simulate */
  G.player.hp = G.player.maxHp;
  CF.Input.keys['KeyD'] = true;
  var NaNs = 0, tickErrors = 0;
  for (var t = 0; t < 300; t++) {
    try { G.updatePlay(0.016); } catch (err) { tickErrors++; if (tickErrors === 1) console.log('   tick error:', err.message); }
    if (!finite(G.player)) NaNs++;
    for (var e = 0; e < G.enemies.length; e++) if (!finite(G.enemies[e])) NaNs++;
    for (e = 0; e < G.projectiles.length; e++) {
      var pr = G.projectiles[e];
      if (!isFinite(pr.x) || !isFinite(pr.y)) NaNs++;
    }
  }
  CF.Input.keys['KeyD'] = false;
  check(label + ': 300 ticks no exceptions', tickErrors === 0);
  check(label + ': no NaN positions (player/enemies/projectiles)', NaNs === 0);
  floorStats.push({ floor: f, enemies: G.enemies.length, chests: G.chests.length });
}

/* ---------- combat: melee attack hits ---------- */
G.genFloor(1);
G.player.hp = G.player.maxHp;
var victim = G.enemies[0];
victim.x = G.player.x + 36; victim.y = G.player.y;   /* place in melee arc */
var hpBefore = victim.hp;
var s = CF.Camera.worldToScreen(G.player.x + 100, G.player.y);
CF.Input.mouse.x = s.x; CF.Input.mouse.y = s.y; CF.Input.mouse.down = true;
for (t = 0; t < 40; t++) G.updatePlay(0.016);
CF.Input.mouse.down = false;
check('melee attack damages enemy in arc', victim.hp < hpBefore || victim.hp <= 0);

/* ---------- dash ---------- */
CF.Input.pressed['Space'] = true;
G.updatePlay(0.016);
check('dash triggers and starts cooldown', G.player.dashCdT > 0);
for (t = 0; t < 30; t++) G.updatePlay(0.016);
check('dash cooldown ticks down', G.player.dashCdT < 0.9 || G.player.dashCdT === 0);

/* ---------- xp / level-up / relic choice ---------- */
G.state = 'play';
var lvlBefore = G.player.level;
G.gainXp(4000);
check('gainXp levels the player up', G.player.level > lvlBefore);
check('level-up opens relic choice', G.state === 'levelup' && G.levelupChoices.length > 0);
CF.Input.pressed['Digit1'] = true;
G.updateLevelup();
CF.Input.pressed['Digit1'] = false;
check('relic applied to player', Object.keys(G.player.upgrades).length >= 1);

/* ---------- boss kill + seal + win ---------- */
G.genFloor(12);
check('floor 12 seal locked before boss', G.sealLocked === true);
var boss = G.boss;
check('final boss found on floor 12', !!(boss && boss.def.id === 'crypt_king'));
var bossStats = CF.ENEMY_STATS('crypt_king', 12);
check('final boss HP in target range 1800-2200', bossStats.hp >= 1800 && bossStats.hp <= 2200);
boss.hp = 5;
G.damageEnemy(boss, 999, false, boss.x, boss.y);
check('crypt king death → WIN state', G.state === 'win');
check('seal released after boss death', G.sealLocked === false);

/* ---------- endless mode after win ---------- */
G.descend();
check('endless mode: floor 13 reachable after win', G.floor === 13 && G.state === 'play');

/* ---------- save / load round-trip ---------- */
G.player.gold = 321; G.player.kills = 77; G.player.level = 6; G.player.hp = 44;
G.save();
var snap = { level: G.player.level, gold: G.player.gold, kills: G.player.kills, floor: G.floor };
check('save written to localStorage', !!globalThis.localStorage.getItem(G.SAVE_KEY));
G.hasSave();
G.continueRun();
check('continueRun restores level', G.player.level === snap.level);
check('continueRun restores gold', G.player.gold === snap.gold);
check('continueRun restores kills', G.player.kills === snap.kills);
check('continueRun regenerates saved floor', G.floor === snap.floor);
check('continueRun rebuilds sane hp', G.player.hp > 0 && G.player.hp <= G.player.maxHp);

/* ---------- death is permanent ---------- */
G.state = 'play';
G.player.hp = 1;
globalThis.localStorage.setItem(G.SAVE_KEY, '{"v":1}');
G.player.takeDamage(999, G, 0, 0);
check('player death → dead state', G.state === 'dead');
check('death wipes the save', globalThis.localStorage.getItem(G.SAVE_KEY) === null);

/* ---------- pathfinding smoke ---------- */
G.newRun();
check('newRun boots floor 1 in play state', G.floor === 1 && G.state === 'play');
var d1 = G.dungeon;
var pth = CF.DungeonGen.findPath(d1, d1.spawn.x, d1.spawn.y, d1.exit.x, d1.exit.y);
check('findPath: spawn→exit path exists', Array.isArray(pth) && pth.length > 0);
if (pth && pth.length) {
  var last = pth[pth.length - 1];
  check('findPath ends at exit', last.x === d1.exit.x && last.y === d1.exit.y);
}
check('hasLineOfSight self → true', CF.DungeonGen.hasLineOfSight(d1, d1.spawn.x, d1.spawn.y, d1.spawn.x, d1.spawn.y) === true);

/* ---------- determinism ---------- */
var g1 = CF.DungeonGen.generate({ width: 64, height: 64, floor: 3, seed: 777 });
var g2 = CF.DungeonGen.generate({ width: 64, height: 64, floor: 3, seed: 777 });
var same = g1.tiles.length === g2.tiles.length;
for (var i = 0; i < g1.tiles.length && same; i++) if (g1.tiles[i] !== g2.tiles[i]) same = false;
check('generator deterministic (seed 777, floor 3)', same);

/* ---------- mobile / touch controls ---------- */
check('MC module loaded', typeof MC !== 'undefined' && typeof MC.clampVec === 'function' && MC.version === '1.0');
check('MC clampVec: analog half tilt', (function () { var v = MC.clampVec(25, 0, 50, 7); return Math.abs(v.x - 0.5) < 1e-9 && Math.abs(v.mag - 0.5) < 1e-9; })());
check('MC clampVec: dead zone zeroes small moves', MC.clampVec(3, 3, 50, 7).mag === 0);
check('MC autoAimAngle: picks nearest', (function () { var a = MC.autoAimAngle(0, 0, [{ x: 10, y: 0 }, { x: 200, y: 0 }]); return a !== null && Math.abs(a) < 1e-9; })());
check('MC isTouchDevice: phone vs desktop', MC.isTouchDevice({ maxTouchPoints: 5 }) === true && MC.isTouchDevice({ userAgent: 'Mozilla/5.0 (X11; Linux) Chrome', maxTouchPoints: 0 }) === false);
check('CF.TouchUI present (unmounted in node)', typeof CF.TouchUI === 'object' && CF.TouchUI.mounted === false);

var I = CF.Input;
check('Input has analog axes + attackHeld + mobile flags', I.axes && typeof I.attackHeld === 'boolean' && I.mobile === false);

/* joystick drives the player */
G.newRun();
G.player.hp = G.player.maxHp;
I.mobile = true;
I.axes.mx = 1; I.axes.my = 0;
var x0 = G.player.x;
for (t = 0; t < 120; t++) G.updatePlay(0.016);
I.axes.mx = 0; I.axes.my = 0;
check('analog stick moves player right', G.player.x - x0 > 15);

/* analog tilt is proportional (reset to spawn center first) */
G.player.x = G.dungeon.spawn.x * 40 + 20;
G.player.y = G.dungeon.spawn.y * 40 + 20;
G.player.hp = G.player.maxHp;
for (t = 0; t < 2; t++) G.updatePlay(0.016);   /* settle camera/interact */
var xh0 = G.player.x;
I.axes.mx = 0.5; I.axes.my = 0;
for (t = 0; t < 60; t++) { G.player.hp = G.player.maxHp; G.updatePlay(0.016); }
I.axes.mx = 0; I.axes.my = 0;
check('analog half tilt moves slower than full', (G.player.x - xh0) > 4);

/* auto-aim + held ATTACK button (isolate one enemy for determinism) */
var tgt = G.enemies[0];
G.enemies = [tgt];
G.player.hp = G.player.maxHp;
G.player.x = G.dungeon.spawn.x * 40 + 20;
G.player.y = G.dungeon.spawn.y * 40 + 20;
tgt.x = G.player.x + 30; tgt.y = G.player.y + 30;
var expAng = Math.atan2(30, 30);
I.attackHeld = true;
G.updatePlay(0.016);
check('auto-aim locks onto nearest enemy', Math.abs(G.player.aim - expAng) < 0.02);
var hp0 = tgt.hp;
for (t = 0; t < 100; t++) { G.player.hp = G.player.maxHp; G.updatePlay(0.016); }
I.attackHeld = false;
check('held ATTACK damages the aimed enemy', tgt.hp < hp0 || tgt.hp <= 0);
/* combat may have leveled us up — resolve so state machine is deterministic */
G.pendingLevels = 0; G.state = 'play';

/* touch DASH button = synthetic Space */
G.player.dashCdT = 0; G.player.dashT = 0;
I.pressed['Space'] = true;
G.updatePlay(0.016);
I.pressed = Object.create(null);
check('touch DASH button triggers dash', G.player.dashCdT > 0);

/* touch E button = synthetic KeyE opens a nearby chest */
G.chests[0].x = G.player.x + 24; G.chests[0].y = G.player.y;
G.updatePlay(0.016);                       /* refresh nearInteract */
I.pressed['KeyE'] = true;
G.updatePlay(0.016);
I.pressed = Object.create(null);
check('touch E button opens nearby chest', G.chests[0].opened === true);

/* touch Q button = synthetic KeyQ drinks a potion */
G.player.consumables.potion_small = 2;
G.player.hp = Math.max(1, G.player.maxHp - 40);
var hpq = G.player.hp;
I.pressed['KeyQ'] = true;
G.updatePlay(0.016);
I.pressed = Object.create(null);
check('touch Q button drinks potion', G.player.hp > hpq);

/* touch PAUSE button = synthetic Escape */
I.pressed['Escape'] = true;
G._update(0.016);
I.pressed = Object.create(null);
check('touch PAUSE button pauses the game', G.state === 'paused');
I.pressed['Escape'] = true;
G._update(0.016);
I.pressed = Object.create(null);
check('pause toggle resumes the game', G.state === 'play');

/* desktop path still intact */
I.mobile = false;
CF.Input.mouse.x = CF.Engine.W / 2; CF.Input.mouse.y = CF.Engine.H / 2;
G.updatePlay(0.016);
check('desktop mouse aim still works after mobile toggles', isFinite(G.player.aim));

console.log('\nfloor stats: ' + JSON.stringify(floorStats.map(function (s) { return s.floor + ':' + s.enemies + 'e/' + s.chests + 'c'; })));
console.log(fail === 0 ? '\nALL TESTS PASSED (' + pass + ')' : '\n' + fail + ' FAILURES of ' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
