var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
/* CRYPTFALL — js/content.js — all game data and balance math: enemies, items,
 * run upgrades, shop stock, xp curve. Pure data + functions: no DOM, no canvas,
 * no modules, no dependencies. Base stats are floor-1 values, scaled by
 * CF.ENEMY_STATS. Self-test: node js/content.js */

if (CF.TILE === undefined) CF.TILE = 40;

/* ENEMIES — id -> def. speed px/s, distances px, cooldowns ms. Base = floor 1.
 * ai: 'chase' walks you down | 'ranged' keeps distance and fires |
 *     'charger' lunges | 'wander' drifts erratically | 'boss' bespoke script.
 * projectile: null or {speed, damage, radius, color, life ms}. knockback: shove force.
 * floorMin: first legal floor. weight: spawn frequency (0 = never in regular table).
 * boss: true -> spawned only via CF.bossPoolFor, never as trash. */
CF.ENEMIES = {
  rat: { id: 'rat', name: 'Plague Rat', hp: 20, speed: 140, damage: 8, xp: 5, gold: 3,
    radius: 12, color: '#8a7a68', accent: '#d95040', ai: 'chase', attackRange: 28,
    attackCd: 800, projectile: null, knockback: 4, floorMin: 1, weight: 30 },
  bat: { id: 'bat', name: 'Crypt Bat', hp: 10, speed: 120, damage: 5, xp: 4, gold: 2,
    radius: 11, color: '#6a5a7a', accent: '#c06060', ai: 'wander', attackRange: 26,
    attackCd: 700, projectile: null, knockback: 2, floorMin: 1, weight: 24, fly: true },
  slime: { id: 'slime', name: 'Grave Slime', hp: 45, speed: 55, damage: 10, xp: 8,
    gold: 5, radius: 17, color: '#5a8a4a', accent: '#9fe06a', ai: 'chase',
    attackRange: 34, attackCd: 950, projectile: null, knockback: 7, floorMin: 1, weight: 22 },
  skeleton: { id: 'skeleton', name: 'Restless Skeleton', hp: 30, speed: 90, damage: 12,
    xp: 10, gold: 6, radius: 13, color: '#d8d0be', accent: '#8a8272', ai: 'chase',
    attackRange: 32, attackCd: 750, projectile: null, knockback: 5, floorMin: 1, weight: 26 },
  cultist: { id: 'cultist', name: 'Deathless Cultist', hp: 24, speed: 85, damage: 7,
    xp: 14, gold: 12, radius: 13, color: '#7a3550', accent: '#e8b050', ai: 'ranged',
    attackRange: 30, attackCd: 1500,
    projectile: { speed: 190, damage: 9, radius: 5, color: '#e8b050', life: 2200 },
    knockback: 3, floorMin: 2, weight: 16, keepDist: 180, shootRange: 320 },
  spider: { id: 'spider', name: 'Tomb Spider', hp: 22, speed: 150, damage: 11, xp: 12,
    gold: 7, radius: 12, color: '#4a4038', accent: '#c04838', ai: 'charger',
    attackRange: 30, attackCd: 650, projectile: null, knockback: 3, floorMin: 3,
    weight: 18, lungeSpeed: 300 },
  brute: { id: 'brute', name: 'Crypt Brute', hp: 80, speed: 65, damage: 22, xp: 26,
    gold: 18, radius: 20, color: '#7a5a40', accent: '#c58a5a', ai: 'chase',
    attackRange: 42, attackCd: 1100, projectile: null, knockback: 12, floorMin: 4, weight: 10 },
  wraith: { id: 'wraith', name: 'Hollow Wraith', hp: 26, speed: 175, damage: 20, xp: 32,
    gold: 25, radius: 14, color: '#8aa0c0', accent: '#e8f2ff', ai: 'chase',
    attackRange: 34, attackCd: 800, projectile: null, knockback: 6, floorMin: 8,
    weight: 14, alpha: 0.55 },
  bone_colossus: { id: 'bone_colossus', name: 'Bone Colossus', hp: 100, speed: 60,
    damage: 24, xp: 120, gold: 90, radius: 30, color: '#c8c0aa', accent: '#78a898',
    ai: 'boss', attackRange: 48, attackCd: 1200, projectile: null, knockback: 16,
    floorMin: 5, weight: 0, boss: true, slamRadius: 80, slamCd: 4200 },
  crypt_king: { id: 'crypt_king', name: 'The Crypt King', hp: 230, speed: 95,
    damage: 24, xp: 400, gold: 300, radius: 34, color: '#4a3a60', accent: '#e8c060',
    ai: 'boss', attackRange: 54, attackCd: 950,
    projectile: { speed: 180, damage: 12, radius: 7, color: '#b060e0', life: 2600 },
    knockback: 18, floorMin: 12, weight: 0, boss: true,
    burstCount: 14, burstCd: 6200, chargeSpeed: 360, chargeCd: 4600 }
};

/* ENEMY_STATS(id, floor) — floor-scaled stats, rounded to ints.
 * hp +22%/floor, damage +15%, xp +10%, gold +15%. Bosses get hp x2.5 on top
 * and their scaling stops at floor 12 so the final fight stays winnable: the
 * floor-12 Crypt King lands near 1970 hp, about a minute of clean kiting
 * for a mid-geared player. Returned projectile carries scaled damage. */
CF.ENEMY_STATS = function (id, floor) {
  var def = CF.ENEMIES[id];
  if (!def) return null;
  var f = Math.max(1, Math.floor(Number(floor) || 1));
  if (def.boss && f > 12) f = 12;
  var dmgMult = 1 + 0.15 * (f - 1);
  var p = def.projectile, proj = p ? { speed: p.speed, damage: Math.round(p.damage * dmgMult),
    radius: p.radius, color: p.color, life: p.life } : null;
  return {
    hp: Math.round(def.hp * (1 + 0.22 * (f - 1)) * (def.boss ? 2.5 : 1)),
    damage: Math.round(def.damage * dmgMult),
    xp: Math.round(def.xp * (1 + 0.10 * (f - 1))),
    gold: Math.round(def.gold * (1 + 0.15 * (f - 1))),
    speed: def.speed, projectile: proj
  };
};

/* Regular spawn table: every non-boss enemy unlocked by this floor. */
CF.spawnTableFor = function (floor) {
  var f = Math.max(1, Math.floor(Number(floor) || 1));
  var table = [];
  for (var id in CF.ENEMIES) {
    var def = CF.ENEMIES[id];
    if (!def.boss && def.weight > 0 && def.floorMin <= f) table.push({ id: id, weight: def.weight });
  }
  return table;
};

/* Boss pool for boss floors: the deepest boss tier the floor has unlocked. */
CF.bossPoolFor = function (floor) {
  var f = Math.max(1, Math.floor(Number(floor) || 1)), deepest = 0, id, def;
  for (id in CF.ENEMIES) {
    def = CF.ENEMIES[id];
    if (def.boss && def.floorMin <= f && def.floorMin > deepest) deepest = def.floorMin;
  }
  var pool = [];
  for (id in CF.ENEMIES) {
    def = CF.ENEMIES[id];
    if (def.boss && def.floorMin === deepest) pool.push({ id: id, weight: 1 });
  }
  return pool;
};

/* ITEMS — id -> def. Weapons swing (range + arc radians) or fire (projectile
 * {speed, radius, color, pierce}). rarity: 0 common .. 3 legendary; tier gates
 * by depth (CF.tierForFloor); weight drives drops. Prices are floor-1 base. */
CF.ITEMS = {
  rusty_dagger: { id: 'rusty_dagger', name: 'Rusty Dagger', type: 'weapon', damage: 8,
    attackCd: 220, range: 48, arc: 1.2, rarity: 0, tier: 1, price: 25, color: '#9a8a72',
    weight: 30, desc: 'Pitted, half-forgotten, and glad of any work it can get.' },
  short_sword: { id: 'short_sword', name: 'Short Sword', type: 'weapon', damage: 12,
    attackCd: 280, range: 58, arc: 1.4, rarity: 1, tier: 1, price: 60, color: '#c0c8d0',
    weight: 26, desc: 'Militia steel from a village that stopped answering its bell.' },
  war_axe: { id: 'war_axe', name: 'War Axe', type: 'weapon', damage: 22, attackCd: 450,
    range: 66, arc: 1.9, rarity: 1, tier: 2, price: 150, color: '#b07048', weight: 22,
    desc: 'Heavy, cruel, honest. Most things need only the one swing.' },
  ember_wand: { id: 'ember_wand', name: 'Ember Wand', type: 'weapon', damage: 15,
    attackCd: 340, projectile: { speed: 330, radius: 5, color: '#ff8a3a', pierce: 1 },
    rarity: 2, tier: 2, price: 170, color: '#d07030', weight: 18,
    desc: 'A charred stick that still dreams of the pyre.' },
  hunter_bow: { id: 'hunter_bow', name: "Hunter's Bow", type: 'weapon', damage: 18,
    attackCd: 380, projectile: { speed: 440, radius: 4, color: '#e8e0c0', pierce: 0 },
    rarity: 1, tier: 2, price: 150, color: '#8a6a48', weight: 24,
    desc: 'Strung with gut from something that once hunted the same way.' },
  royal_blade: { id: 'royal_blade', name: 'Royal Blade', type: 'weapon', damage: 30,
    attackCd: 400, range: 72, arc: 1.6, rarity: 3, tier: 3, price: 420, color: '#e8c860',
    weight: 10, desc: "The king's own edge, pried from a scabbard of grave-dust." },
  cloth_robe: { id: 'cloth_robe', name: 'Cloth Robe', type: 'armor', defense: 1,
    rarity: 0, tier: 1, price: 30, color: '#8a8a9a', weight: 30,
    desc: 'Blessed once. Laundered never.' },
  leather_vest: { id: 'leather_vest', name: 'Leather Vest', type: 'armor', defense: 2,
    rarity: 1, tier: 1, price: 70, color: '#8a5f3a', weight: 26,
    desc: 'Cured hide, scarred where its last owner trusted it too much.' },
  chain_mail: { id: 'chain_mail', name: 'Chain Mail', type: 'armor', defense: 4,
    rarity: 2, tier: 2, price: 180, color: '#aab2c0', weight: 20,
    desc: 'A thousand small rings; a thousand small refusals to die.' },
  plate_armor: { id: 'plate_armor', name: 'Plate Armor', type: 'armor', defense: 7,
    rarity: 3, tier: 3, price: 400, color: '#c8ccd8', weight: 10,
    desc: "Buried with a knight who was promised he wouldn't need it. He did." },
  potion_small: { id: 'potion_small', name: 'Minor Potion', type: 'consumable',
    effect: { heal: 30 }, price: 20, color: '#e05560', weight: 34,
    desc: 'Bitter root-water. Tastes faintly of the floor it was found on.' },
  potion_medium: { id: 'potion_medium', name: 'Potion', type: 'consumable',
    effect: { heal: 60 }, price: 40, color: '#d8455a', weight: 26,
    desc: 'The blood remembers how to be blood.' },
  potion_large: { id: 'potion_large', name: 'Greater Potion', type: 'consumable',
    effect: { heal: 100 }, price: 70, color: '#c03050', weight: 16,
    desc: "A whole heart's worth of warmth in a bottle the size of a fist." },
  elixir: { id: 'elixir', name: 'Elixir of the Deep Crypt', type: 'consumable',
    effect: { heal: 'full', cleanse: true }, price: 120, color: '#f0c860', weight: 6,
    desc: 'Gold light that scours the rot from you. Save it. You will know when.' },
  bomb: { id: 'bomb', name: 'Crypt Bomb', type: 'consumable',
    effect: { aoeDamage: 60, radius: 110 }, price: 45, color: '#5a5a5a', weight: 18,
    desc: "Alchemist's fire in a burial urn. Handle it like a grudge." }
};

/* Weighted pick over a list of defs carrying .weight (>0 only). */
function weightedPick(list, rand) {
  var total = 0, i;
  for (i = 0; i < list.length; i++) if (list[i].weight > 0) total += list[i].weight;
  var r = rand() * total;
  for (i = 0; i < list.length; i++) {
    if (list[i].weight <= 0) continue;
    r -= list[i].weight;
    if (r <= 0) return list[i];
  }
  for (i = 0; i < list.length; i++) if (list[i].weight > 0) return list[i];
  return null;
}

/* Depth -> gear tier: floors 1-3 -> 1, 4-7 -> 2, 8+ -> 3. */
CF.tierForFloor = function (floor) {
  var f = Math.max(1, Math.floor(Number(floor) || 1));
  return Math.min(3, Math.ceil((f + 1) / 4));
};

var CONSUMABLE_POOL = [];
var GEAR_BY_TIER = { 1: [], 2: [], 3: [] };
(function () {
  for (var id in CF.ITEMS) {
    var it = CF.ITEMS[id];
    if (it.type === 'consumable') CONSUMABLE_POOL.push(it);
    else GEAR_BY_TIER[Math.min(3, Math.max(1, it.tier))].push(it);
  }
})();

function pickGearDef(floor, rand, tierOffset) {
  var base = CF.tierForFloor(floor);
  var tier = Math.min(3, base + (tierOffset || 0));
  var pool = (GEAR_BY_TIER[tier] && GEAR_BY_TIER[tier].length) ? GEAR_BY_TIER[tier] : GEAR_BY_TIER[base];
  return weightedPick(pool, rand);
}

/* randomItem(floor, rand) — 60% consumable / 30% gear of the floor's tier /
 * 10% gear one tier above. rand: any 0..1 function (default Math.random). */
CF.randomItem = function (floor, rand) {
  rand = rand || Math.random;
  var f = Math.max(1, Math.floor(Number(floor) || 1));
  var roll = rand();
  if (roll < 0.60) return weightedPick(CONSUMABLE_POOL, rand);
  return pickGearDef(f, rand, roll < 0.90 ? 0 : 1);
};

/* UPGRADES — run upgrades offered on level-up. apply(p) mutates the player
 * stat object (see CF.playerBase). max = times stackable. */
CF.UPGRADES = [
  { id: 'vitality', name: 'Vitality', max: 5, desc: 'Your wounds have learned to close themselves. +20 max HP.',
    apply: function (p) { p.maxHp += 20; p.hp += 20; } },
  { id: 'berserker', name: 'Berserker', max: 5, desc: 'Grief sharpens every swing. +12% damage.',
    apply: function (p) { p.damage *= 1.12; } },
  { id: 'swift', name: 'Swift Boots', max: 4, desc: 'The crypt cannot hold what will not stay. +8% move speed.',
    apply: function (p) { p.speed *= 1.08; } },
  { id: 'iron_skin', name: 'Iron Skin', max: 4, desc: 'Death knocks. You do not answer. +1 defense.',
    apply: function (p) { p.defense += 1; } },
  { id: 'dash_master', name: 'Dash Master', max: 3, desc: 'You learn the spaces between heartbeats. -20% dash cooldown.',
    apply: function (p) { p.dashCd *= 0.8; } },
  { id: 'leech', name: 'Leech', max: 4, desc: 'Every wound you give is a wound you keep. +5% life steal on hit.',
    apply: function (p) { p.lifeSteal += 0.05; } },
  { id: 'precise', name: 'Precise', max: 4, desc: 'You have studied where the living keep their secrets. +7% crit chance.',
    apply: function (p) { p.critChance += 0.07; } },
  { id: 'executioner', name: 'Executioner', max: 3, desc: 'Mercy was for the daylight world. +0.3 crit damage multiplier.',
    apply: function (p) { p.critMult += 0.3; } },
  { id: 'momentum', name: 'Momentum', max: 3, desc: 'Your dash becomes a blade of motion. Dash-through deals +15 damage.',
    apply: function (p) { p.dashDamage += 15; } },
  { id: 'thorns', name: 'Thorns', max: 3, desc: 'The crypt bites back. Reflect 8 damage when struck.',
    apply: function (p) { p.thorns += 8; } },
  { id: 'greed', name: 'Greed', max: 3, desc: 'Every coin spends the same in the dark. +25% gold from kills.',
    apply: function (p) { p.goldMult *= 1.25; } },
  { id: 'reach', name: 'Long Reach', max: 3, desc: 'The dead hoard; you collect. +30% pickup radius.',
    apply: function (p) { p.pickupRadius *= 1.3; } },
  { id: 'frenzy', name: 'Frenzy', max: 4, desc: 'Swing until the arms forget how to be tired. -10% attack cooldown.',
    apply: function (p) { p.attackCd *= 0.9; } }
];

/* Fresh player stat block — a fresh copy every call. */
CF.playerBase = function () {
  return { maxHp: 100, hp: 100, speed: 175, damage: 10, attackCd: 280, critChance: 0.05,
    critMult: 1.6, defense: 0, dashCd: 900, lifeSteal: 0, dashDamage: 0, thorns: 0,
    goldMult: 1, pickupRadius: 55 };
};

/* xp needed to advance from level-1 to level. */
CF.xpForLevel = function (level) {
  return Math.round(20 * Math.pow(Math.max(1, Number(level) || 1), 1.35));
};

/* shopStock(floor, rand) — 4 slots: depth-scaled potion, one weapon or armor of
 * the floor's tier, elixir (floor 4+, else potion_medium), bomb. Prices are
 * base * (1 + 0.1 * floor), rounded. */
CF.shopStock = function (floor, rand) {
  rand = rand || Math.random;
  var f = Math.max(1, Math.floor(Number(floor) || 1));
  var mult = 1 + 0.1 * f;
  function entry(id) { return { id: id, price: Math.round(CF.ITEMS[id].price * mult) }; }
  var potionId = f <= 3 ? 'potion_small' : (f <= 7 ? 'potion_medium' : 'potion_large');
  var gear = pickGearDef(f, rand, 0);
  return [entry(potionId), entry(gear ? gear.id : 'short_sword'),
          entry(f >= 4 ? 'elixir' : 'potion_medium'), entry('bomb')];
};

/* Also expose everything under the module's contract name, CF.Content. */
CF.Content = CF.Content || {};
['TILE', 'ENEMIES', 'ENEMY_STATS', 'spawnTableFor', 'bossPoolFor', 'ITEMS',
 'randomItem', 'UPGRADES', 'playerBase', 'xpForLevel', 'shopStock',
 'tierForFloor'].forEach(function (k) { CF.Content[k] = CF[k]; });

/* Self-test — node js/content.js */
function selfTest() {
  var log = (typeof console !== 'undefined' && typeof console.log === 'function')
    ? function (m) { console.log(m); } : function () {};
  var fails = 0, total = 0;
  function ok(name, cond) {
    total++;
    if (cond) log('PASS: ' + name); else { fails++; log('FAIL: ' + name); }
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function str(v) { return typeof v === 'string'; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  var i;

  ok('CF.TILE is 40', CF.TILE === 40);

  var ROSTER = ['rat', 'bat', 'slime', 'skeleton', 'cultist', 'spider', 'brute', 'wraith', 'bone_colossus', 'crypt_king'];
  var REQ = ['id', 'name', 'hp', 'speed', 'damage', 'xp', 'gold', 'radius', 'color', 'accent', 'ai',
             'attackRange', 'attackCd', 'projectile', 'knockback', 'floorMin', 'weight'];
  var NUMF = ['hp', 'speed', 'damage', 'xp', 'gold', 'radius', 'attackRange', 'attackCd', 'knockback', 'floorMin', 'weight'];
  var AIS = { chase: 1, ranged: 1, charger: 1, wander: 1, boss: 1 };
  var SPEEDS = { rat: 140, bat: 120, slime: 55, skeleton: 90, cultist: 85, spider: 150,
                 brute: 65, wraith: 175, bone_colossus: 60, crypt_king: 95 };
  var shapeOk = true, regulars = 0, bosses = 0;
  ROSTER.forEach(function (rid) {
    var d = CF.ENEMIES[rid];
    if (!d) { shapeOk = false; return; }
    REQ.forEach(function (k) { if (!has(d, k)) shapeOk = false; });
    NUMF.forEach(function (k) { if (!isNum(d[k])) shapeOk = false; });
    if (d.id !== rid || !AIS[d.ai] || d.speed !== SPEEDS[rid] || d.floorMin < 1 || d.weight < 0 ||
        !str(d.name) || !str(d.color) || !str(d.accent)) shapeOk = false;
    if (d.projectile !== null) {
      var pr = d.projectile;
      if (!isNum(pr.speed) || !isNum(pr.damage) || !isNum(pr.radius) || !isNum(pr.life) || !str(pr.color)) shapeOk = false;
    }
    if (d.boss) bosses++; else regulars++;
  });
  ok('enemy roster: 8 regular + 2 boss defs, all required fields present and valid',
     Object.keys(CF.ENEMIES).length >= 10 && regulars >= 8 && bosses === 2 && shapeOk);
  ok('contract speeds (px/s); spider lunges 300, wraith floor 8+, bosses flagged',
     CF.ENEMIES.spider.lungeSpeed === 300 && CF.ENEMIES.wraith.floorMin >= 8 &&
     CF.ENEMIES.bone_colossus.boss === true && CF.ENEMIES.crypt_king.boss === true);

  var monoOk = true, baseOk = true;
  Object.keys(CF.ENEMIES).forEach(function (id) {
    var d = CF.ENEMIES[id];
    var s1 = CF.ENEMY_STATS(id, 1), s5 = CF.ENEMY_STATS(id, 5), s12 = CF.ENEMY_STATS(id, 12);
    if (!s1 || !s5 || !s12 || !(s5.hp > s1.hp && s12.hp > s5.hp && s5.damage > s1.damage && s12.damage > s5.damage)) monoOk = false;
    if (!s1 || s1.speed !== d.speed || (!d.boss && (s1.hp !== d.hp || s1.damage !== d.damage))) baseOk = false;
  });
  ok('ENEMY_STATS hp/damage scale monotonically (floor 1 < 5 < 12)', monoOk);
  ok('ENEMY_STATS floor-1 equals base defs, reports speed, scales xp/gold, nulls unknown ids',
     baseOk && CF.ENEMY_STATS('rat', 5).xp > CF.ENEMY_STATS('rat', 1).xp &&
     CF.ENEMY_STATS('rat', 5).gold > CF.ENEMY_STATS('rat', 1).gold && CF.ENEMY_STATS('nobody', 3) === null);

  var rat1 = CF.ENEMY_STATS('rat', 1), pb = CF.playerBase();
  ok('balance: floor-1 rat dies in exactly 2 base hits and bites for 8',
     rat1.hp > pb.damage && rat1.hp <= pb.damage * 2 && rat1.damage === 8);
  var king12 = CF.ENEMY_STATS('crypt_king', 12);
  ok('balance: floor-12 Crypt King hp in 1800-2200 (got ' + king12.hp + '); boss scaling capped at 12',
     king12.hp >= 1800 && king12.hp <= 2200 &&
     CF.ENEMY_STATS('crypt_king', 20).hp === king12.hp && CF.ENEMY_STATS('crypt_king', 99).hp === king12.hp);

  var gateOk = true, hasWraith = false;
  for (var fl = 1; fl <= 12; fl++) {
    var table = CF.spawnTableFor(fl);
    if (!table.length) { gateOk = false; continue; }
    table.forEach(function (e) {
      var d = CF.ENEMIES[e.id];
      if (d.boss || d.floorMin > fl || e.weight <= 0) gateOk = false;
      if (fl === 8 && e.id === 'wraith') hasWraith = true;
    });
  }
  ok('spawnTableFor gates by floorMin (floor-1 excludes floorMin>1), positive weights, no bosses', gateOk && hasWraith);
  ok('bossPoolFor: floors 5/10 -> bone_colossus, floor 12 -> crypt_king',
     CF.bossPoolFor(5).length === 1 && CF.bossPoolFor(5)[0].id === 'bone_colossus' &&
     CF.bossPoolFor(10).length === 1 && CF.bossPoolFor(10)[0].id === 'bone_colossus' &&
     CF.bossPoolFor(12).length === 1 && CF.bossPoolFor(12)[0].id === 'crypt_king');

  var WEAPONS = ['rusty_dagger', 'short_sword', 'war_axe', 'ember_wand', 'hunter_bow', 'royal_blade'];
  var ARMORS = ['cloth_robe', 'leather_vest', 'chain_mail', 'plate_armor'];
  var CONS = ['potion_small', 'potion_medium', 'potion_large', 'elixir', 'bomb'];
  function itemOk(list, fn) {
    var good = true;
    list.forEach(function (iid) { if (!CF.ITEMS[iid] || !fn(CF.ITEMS[iid])) good = false; });
    return good;
  }
  var itemsOk = itemOk(WEAPONS, function (w) {
    return w.type === 'weapon' && isNum(w.damage) && isNum(w.attackCd) && isNum(w.tier) && isNum(w.rarity) &&
      isNum(w.price) && isNum(w.weight) && str(w.desc) && str(w.color) &&
      ((isNum(w.range) && isNum(w.arc)) || (w.projectile && isNum(w.projectile.speed) &&
        isNum(w.projectile.radius) && str(w.projectile.color) && isNum(w.projectile.pierce)));
  }) && itemOk(ARMORS, function (a) {
    return a.type === 'armor' && isNum(a.defense) && isNum(a.tier) && isNum(a.price) &&
      isNum(a.weight) && str(a.desc) && str(a.color);
  }) && itemOk(CONS, function (c) {
    return c.type === 'consumable' && typeof c.effect === 'object' && c.effect !== null &&
      isNum(c.price) && isNum(c.weight) && str(c.desc) && str(c.color);
  });
  ok('items registry: 6 weapons, 4 armors, 5 consumables, all fields valid',
     itemsOk && Object.keys(CF.ITEMS).length === 15);
  ok('consumable effects: heals 30/60/100, elixir full+cleanse, bomb 60 aoe',
     CF.ITEMS.potion_small.effect.heal === 30 && CF.ITEMS.potion_medium.effect.heal === 60 &&
     CF.ITEMS.potion_large.effect.heal === 100 && CF.ITEMS.elixir.effect.heal === 'full' &&
     CF.ITEMS.elixir.effect.cleanse === true && CF.ITEMS.bomb.effect.aoeDamage === 60);

  var dropOk = true, tierOk = true;
  [1, 4, 8, 12].forEach(function (df) {
    var maxTier = Math.min(3, CF.tierForFloor(df) + 1);
    for (var n = 0; n < 100; n++) {
      var drop = CF.randomItem(df, Math.random);
      if (!drop || !drop.id || CF.ITEMS[drop.id] !== drop) dropOk = false;
      else if (drop.type !== 'consumable' && drop.tier > maxTier) tierOk = false;
    }
  });
  ok('randomItem returns a valid registered item 400x (floors 1/4/8/12)', dropOk);
  ok('randomItem respects tier gates: 1-3 tier 1, 4-7 tier 2, 8+ tier 3 (+1 lucky)', tierOk);
  var seed = 42;
  function srand() { seed = (seed * 48271) % 2147483647; return seed / 2147483647; }
  var consCount = 0, DROPS = 2000;
  for (i = 0; i < DROPS; i++) if (CF.randomItem(6, srand).type === 'consumable') consCount++;
  ok('randomItem drops ~60% consumables over 2000 seeded draws (got ' + (consCount / DROPS * 100).toFixed(1) + '%)',
     consCount >= DROPS * 0.55 && consCount <= DROPS * 0.65);

  var upOk = true, upThrew = false, upChange = true, upFinite = true, upIds = {};
  CF.UPGRADES.forEach(function (u) {
    if (!u || !u.id || upIds[u.id] || !str(u.name) || !str(u.desc) || !isNum(u.max) || u.max < 1 ||
        typeof u.apply !== 'function') { upOk = false; return; }
    upIds[u.id] = true;
    var pc = CF.playerBase(), before = JSON.stringify(pc);
    try { u.apply(pc); } catch (e) { upThrew = true; upOk = false; }
    if (JSON.stringify(pc) === before) upChange = false;
    for (var st = 0; st < u.max; st++) { try { u.apply(pc); } catch (e) { upThrew = true; upOk = false; } }
    for (var key in pc) if (!isNum(pc[key])) upFinite = false;
  });
  ok('UPGRADES: ' + CF.UPGRADES.length + ' upgrades with unique ids and valid shape', upOk && CF.UPGRADES.length >= 10);
  ok('every upgrade applies to a fresh playerBase() without throwing and changes a stat', !upThrew && upChange);
  ok('upgrades stacked to max keep every stat finite', upFinite);

  var pa = CF.playerBase(), pfresh = CF.playerBase();
  pa.hp = 1; pa.goldMult = 99;
  ok('playerBase returns independent fresh copies with contract stats',
     pfresh.hp === 100 && pfresh.maxHp === 100 && pfresh.speed === 175 && pfresh.damage === 10 &&
     pfresh.attackCd === 280 && pfresh.critChance === 0.05 && pfresh.critMult === 1.6 && pfresh.defense === 0 &&
     pfresh.dashCd === 900 && pfresh.lifeSteal === 0 && pfresh.dashDamage === 0 && pfresh.thorns === 0 &&
     pfresh.goldMult === 1 && pfresh.pickupRadius === 55);

  var xpOk = true, lastXp = 0;
  for (i = 1; i <= 20; i++) {
    var need = CF.xpForLevel(i);
    if (!isNum(need) || need <= lastXp) xpOk = false;
    lastXp = need;
  }
  ok('xpForLevel strictly increases across levels 1..20 (level 1 = ' + CF.xpForLevel(1) + ' xp)',
     xpOk && CF.xpForLevel(1) === 20);

  var shopOk = true, priceOk = true, slotOk = true;
  [1, 3, 5, 8, 12].forEach(function (sf) {
    var stock = CF.shopStock(sf, Math.random), valid = !!(stock && stock.length === 4), seen = {};
    for (var k = 0; valid && k < 4; k++) if (!stock[k] || !stock[k].id || !CF.ITEMS[stock[k].id]) valid = false;
    if (!valid) { shopOk = false; return; }
    stock.forEach(function (e) {
      if (seen[e.id]) shopOk = false;
      seen[e.id] = true;
      if (!isNum(e.price) || e.price < 1 || e.price !== Math.round(CF.ITEMS[e.id].price * (1 + 0.1 * sf))) priceOk = false;
    });
    var wantPotion = sf <= 3 ? 'potion_small' : (sf <= 7 ? 'potion_medium' : 'potion_large');
    if (stock[0].id !== wantPotion || CF.ITEMS[stock[1].id].type === 'consumable' ||
        CF.ITEMS[stock[1].id].tier > CF.tierForFloor(sf) ||
        stock[2].id !== (sf >= 4 ? 'elixir' : 'potion_medium') || stock[3].id !== 'bomb') slotOk = false;
  });
  ok('shopStock offers 4 unique purchasable ids with scaled integer prices', shopOk && priceOk);
  ok('shop slots follow the contract: potion, gear, elixir-or-potion, bomb', slotOk);

  if (fails === 0) log('ALL TESTS PASSED');
  else {
    log('FAIL: ' + fails + ' of ' + total + ' checks failed');
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
  }
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('content.js')) {
  selfTest();
}
