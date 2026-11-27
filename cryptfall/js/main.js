/* CRYPTFALL — js/main.js
 * Game state machine, floor orchestration, save/load, module glue.
 * States: title, help, play, paused, inventory, levelup, shop, dead, win.
 */
var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
if (CF.TILE === undefined) CF.TILE = 40;

CF.Game = {
  SAVE_KEY: 'cryptfall_save_v1',
  FINAL_FLOOR: 12,
  state: 'boot',
  player: null, dungeon: null,
  enemies: [], projectiles: [], pickups: [], chests: [],
  floor: 1, seed: 1,
  explored: null, floorCanvas: null,
  boss: null, sealLocked: false,
  levelupChoices: [], pendingLevels: 0,
  shopItems: [],
  nearInteract: null,
  msg: null, fade: 0, muted: false,
  _musicIntensity: -1, _musicT: 0,

  /* ================= BOOT ================= */
  boot: function () {
    var missing = [];
    if (typeof CF.DungeonGen === 'undefined') missing.push('js/dungeon.js');
    if (typeof CF.SoundFX === 'undefined') missing.push('js/audio.js');
    if (typeof CF.ENEMIES === 'undefined' || typeof CF.playerBase !== 'function') missing.push('js/content.js');
    if (typeof Player === 'undefined' || typeof CF.Engine === 'undefined') missing.push('js/entities.js + js/engine.js');
    if (typeof CF.UI === 'undefined' || typeof CF.UI.drawTitle !== 'function') missing.push('js/ui.js');

    try {
      CF.Engine.init('game');
      CF.Input.init(CF.Engine.canvas);
    } catch (err) {
      console.error(err);
      return;
    }
    if (missing.length) {
      this.fatal(new Error('Missing modules:\n' + missing.join('\n') +
        '\n\nSome files are still being built or failed to load.'));
      return;
    }
    /* normalize UPGRADES to an array (registry object or array both accepted) */
    if (!Array.isArray(CF.UPGRADES)) {
      var arr = [];
      for (var k in CF.UPGRADES) if (CF.UPGRADES[k] && CF.UPGRADES[k].id) arr.push(CF.UPGRADES[k]);
      CF.UPGRADES = arr;
    }
    if (CF.SoundFX.init) { try { CF.SoundFX.init(); } catch (err) {} }
    this.muted = !!(CF.SoundFX.isMuted && CF.SoundFX.isMuted());
    this.state = 'title';
    CF.Engine.start(this._update.bind(this), this._render.bind(this));
  },

  fatal: function (err) {
    console.error('FATAL', err);
    try { if (CF.Engine && CF.Engine.running) CF.Engine.stop(); } catch (e) {}
    try {
      var ctx = CF.Engine.ctx;
      if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); CF.UI.drawFatal(ctx, err); }
    } catch (e) {}
  },

  say: function (text) { this.msg = { text: text, t: 2.4 }; },

  /* ================= UPDATE ================= */
  _update: function (dt) {
    var I = CF.Input;
    /* global: mute toggle */
    if (I.hit('KeyM') && CF.SoundFX.toggleMute) {
      try { this.muted = CF.SoundFX.toggleMute(); this.say('sound ' + (this.muted ? 'off' : 'on')); } catch (err) {}
    }
    switch (this.state) {
      case 'title':
        if (I.hit('Enter')) { if (this.hasSave()) this.continueRun(); else this.newRun(); }
        else if (I.hit('KeyN') && this.hasSave()) this.newRun();
        else if (I.hit('KeyH')) this.state = 'help';
        CF.Particles.update(dt);
        break;
      case 'help':
        if (I.hit('Enter') || I.hit('Escape') || I.hit('KeyH')) this.state = 'title';
        break;
      case 'play': this.updatePlay(dt); break;
      case 'paused':
        if (I.hit('Escape') || I.hit('Enter')) this.state = 'play';
        else if (I.hit('KeyR')) this.newRun();
        else if (I.hit('KeyT')) { this.stopMusic(); this.state = 'title'; }
        break;
      case 'inventory': this.updateInventoryState(); break;
      case 'levelup': this.updateLevelup(); break;
      case 'shop': this.updateShop(); break;
      case 'dead':
        if (I.hit('Enter')) this.newRun();
        else if (I.hit('Escape')) { this.state = 'title'; }
        break;
      case 'win':
        if (I.hit('Enter')) { this.state = 'play'; this.descend(); }
        else if (I.hit('Escape')) { this.stopMusic(); this.state = 'title'; }
        break;
    }
    I.endFrame();
  },

  updatePlay: function (dt) {
    var p = this.player;
    this.fade = Math.max(0, this.fade - dt * 1.6);
    p.update(dt, this);

    for (var i = this.enemies.length - 1; i >= 0; i--) {
      var en = this.enemies[i];
      en.update(dt, this);
      if (en.hp <= 0) this.enemies.splice(i, 1);
    }
    for (i = this.projectiles.length - 1; i >= 0; i--) {
      this.projectiles[i].update(dt, this);
      if (this.projectiles[i].dead) this.projectiles.splice(i, 1);
    }
    for (i = this.pickups.length - 1; i >= 0; i--) {
      this.pickups[i].update(dt, this);
      if (this.pickups[i].dead) this.pickups.splice(i, 1);
    }
    for (i = this.chests.length - 1; i >= 0; i--) this.chests[i].update(dt, this);

    CF.Particles.update(dt);
    CF.FloatText.update(dt);
    CF.Camera.follow(p.x, p.y, dt);
    this.revealExplored();
    this.updateNearInteract();
    this.updateMusic(dt);
    if (this.msg) { this.msg.t -= dt; if (this.msg.t <= 0) this.msg = null; }

    var I = CF.Input;
    if (I.hit('KeyI')) this.state = 'inventory';
    else if (I.hit('Escape')) this.state = 'paused';
  },

  updateInventoryState: function () {
    var I = CF.Input;
    /* number keys: drink nth owned potion */
    var owned = [];
    for (var id in this.player.consumables) {
      if ((this.player.consumables[id] || 0) > 0 && CF.ITEMS[id]) owned.push(id);
    }
    for (var n = 1; n <= 9; n++) {
      if ((I.hit('Digit' + n) || I.hit('Numpad' + n)) && owned[n - 1]) {
        var pid = owned[n - 1];
        var item = CF.ITEMS[pid];
        this.player.consumables[pid]--;
        var healAmt = CF.healValue ? CF.healValue(item, this.player) : (item.effect || 0);
        this.player.hp = CF.clamp(this.player.hp + healAmt, 0, this.player.maxHp);
        CF.sfx('pickup');
        CF.FloatText.add(this.player.x, this.player.y - 26, '+' + healAmt + ' hp', '#7dff8a', 16);
      }
    }
    if (I.hit('KeyI') || I.hit('Escape')) this.state = 'play';
  },

  updateLevelup: function () {
    var I = CF.Input;
    for (var n = 1; n <= 3; n++) {
      if (I.hit('Digit' + n) || I.hit('Numpad' + n)) {
        var u = this.levelupChoices[n - 1];
        if (!u) continue;
        this.applyUpgrade(u);
        this.pendingLevels = Math.max(0, this.pendingLevels - 1);
        if (this.pendingLevels > 0) this.rollLevelupChoices();
        else { this.state = 'play'; this.save(); }
        return;
      }
    }
  },

  updateShop: function () {
    var I = CF.Input;
    for (var n = 1; n <= 4; n++) {
      if ((I.hit('Digit' + n) || I.hit('Numpad' + n)) && this.shopItems[n - 1]) {
        this.tryBuy(this.shopItems[n - 1]);
        return;
      }
    }
    if (I.hit('Enter') || I.hit('Escape')) { this.state = 'play'; this.save(); }
  },

  tryBuy: function (entry) {
    var p = this.player, it = CF.ITEMS[entry.id];
    if (!it) return;
    if (p.gold < entry.price) { CF.sfx('click'); this.say('not enough gold'); return; }
    p.gold -= entry.price;
    CF.sfx('coin');
    if (it.type === 'consumable') {
      p.consumables[it.id] = (p.consumables[it.id] || 0) + 1;
      this.say('bought ' + it.name);
    } else if (it.type === 'weapon') {
      if (!p.weapon || it.damage > p.weapon.damage) { p.weapon = it; this.say('equipped ' + it.name); }
      else { var s = Math.max(5, Math.round((it.price || 10) * 0.5)); p.gold += s; this.say('sold for ◈' + s + ' (weaker than yours)'); }
    } else if (it.type === 'armor') {
      if (!p.armor || it.defense > p.armor.defense) { p.armor = it; this.say('equipped ' + it.name); }
      else { var s2 = Math.max(5, Math.round((it.price || 10) * 0.5)); p.gold += s2; this.say('sold for ◈' + s2 + ' (weaker than yours)'); }
    }
  },

  /* ================= RUN / FLOWS ================= */
  newRun: function () {
    this.seed = (Date.now() % 2147483646) >>> 0;
    this.player = new Player(this);
    this.floor = 1;
    this.pendingLevels = 0;
    CF.FloatText.clear();
    CF.Particles.clear();
    this.genFloor(1);
    this.state = 'play';
    CF.sfx('click');
    this.say('descend. survive. loot.');
  },

  continueRun: function () {
    var data = this.loadSave();
    if (!data) { this.newRun(); return; }
    var p = new Player(this);
    p.level = data.level || 1;
    p.xp = data.xp || 0;
    p.gold = data.gold || 0;
    p.kills = data.kills || 0;
    p.upgrades = data.upgrades || {};
    for (var lv = 2; lv <= p.level; lv++) { p.maxHp += 8; p.damage += 2; }
    for (var uid in p.upgrades) {
      var u = this.findUpgrade(uid);
      if (!u) continue;
      for (var c = 0; c < p.upgrades[uid]; c++) { try { u.apply(p); } catch (err) {} }
    }
    p.weapon = (data.weaponId && CF.ITEMS[data.weaponId]) ? CF.ITEMS[data.weaponId] : p.weapon;
    p.armor = (data.armorId && CF.ITEMS[data.armorId]) ? CF.ITEMS[data.armorId] : null;
    p.consumables = data.consumables || {};
    p.hp = CF.clamp(data.hp || 1, 1, p.maxHp);
    this.seed = data.seed;
    this.floor = data.floor || 1;
    this.pendingLevels = 0;
    this.player = p;
    CF.FloatText.clear();
    CF.Particles.clear();
    this.genFloor(this.floor);
    this.state = 'play';
    this.say('the descent continues…');
  },

  genFloor: function (f) {
    this.floor = f;
    var size = (f % 5 === 0) ? 96 : 80;
    var d;
    try {
      d = CF.DungeonGen.generate({ width: size, height: size, floor: f, seed: (this.seed + f * 7919) >>> 0 });
    } catch (err) { this.fatal(err); return; }
    this.dungeon = d;
    this.enemies = []; this.projectiles = []; this.pickups = []; this.chests = [];
    this.boss = null; this.sealLocked = false;
    this.nearInteract = null;
    var T = CF.TILE, self = this;
    this.player.x = d.spawn.x * T + T / 2;
    this.player.y = d.spawn.y * T + T / 2;
    CF.Camera.setBounds(d.width * T, d.height * T);
    CF.Camera.snapTo(this.player.x, this.player.y);
    this.explored = new Set();
    /* renderer dispatch: 3D owns the world geometry; 2D keeps its bitmap.
     * In node (no DOM) CF.Render3D is dormant, so this is a no-op there. */
    if (CF.Render3D && CF.Render3D.active) {
      this.floorCanvas = null;
      try { CF.Render3D.buildFloor(d); }
      catch (err) { CF.Render3D.disable(); this.buildFloorCanvas(d); }
    } else {
      this.buildFloorCanvas(d);
    }

    var isBossFloor = (f % 5 === 0);
    var isFinal = (f === this.FINAL_FLOOR);
    var table = (typeof CF.spawnTableFor === 'function') ? CF.spawnTableFor(f) : [];
    var spawns = d.enemySpawns || [];
    var bossSlot = null;
    if (isFinal) {
      bossSlot = { x: d.exit.x, y: d.exit.y };
      this.sealLocked = true;
    } else if (isBossFloor) {
      var cx = d.width / 2, cy = d.height / 2, bd = 1e18;
      for (var i = 0; i < spawns.length; i++) {
        var dd = (spawns[i].x - cx) * (spawns[i].x - cx) + (spawns[i].y - cy) * (spawns[i].y - cy);
        if (dd < bd) { bd = dd; bossSlot = spawns[i]; }
      }
    }
    var bossId = isFinal ? 'crypt_king' : 'bone_colossus';
    for (i = 0; i < spawns.length; i++) {
      var s = spawns[i];
      if (bossSlot && s.x === bossSlot.x && s.y === bossSlot.y) continue; /* boss replaces this slot */
      var defId = this.pickWeighted(table);
      if (!defId || !CF.ENEMIES[defId]) continue;
      this.enemies.push(new Enemy(this, CF.ENEMIES[defId], f, s.x * T + T / 2, s.y * T + T / 2));
    }
    if (bossSlot && CF.ENEMIES[bossId]) {
      this.boss = new Enemy(this, CF.ENEMIES[bossId], f, bossSlot.x * T + T / 2, bossSlot.y * T + T / 2);
      this.enemies.push(this.boss);
      this.say(isFinal ? 'the Crypt King guards the seal…' : 'something huge stirs below…');
    }
    (d.chests || []).forEach(function (c) { self.chests.push(new Chest(c.x * T + T / 2, c.y * T + T / 2)); });
    (d.potions || []).forEach(function (c) {
      var pool = f >= 6 ? ['potion_medium', 'potion_large'] : ['potion_small', 'potion_medium'];
      var id = CF.pick(pool);
      self.pickups.push(new Pickup('potion', c.x * T + T / 2, c.y * T + T / 2, { id: id }));
    });
    this.fade = 1;
    this._musicIntensity = -1;
    this.save();
  },

  descend: function () {
    if (this.floor === this.FINAL_FLOOR && this.sealLocked) {
      this.say('the seal holds — slay the Crypt King');
      CF.sfx('click');
      return;
    }
    CF.sfx('stairs');
    var next = this.floor + 1;
    this.genFloor(next);
    if (this.floor % 3 === 0 && this.floor % 5 !== 0 && this.floor !== this.FINAL_FLOOR &&
        typeof CF.shopStock === 'function') {
      this.shopItems = CF.shopStock(this.floor, Math.random);
      this.state = 'shop';
      this.say('a hooded figure opens their coat…');
    } else {
      this.state = 'play';
    }
  },

  /* ================= COMBAT / EVENTS ================= */
  forEachEnemyInArc: function (x, y, ang, arc, range, fn) {
    for (var i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      if (en.hp <= 0) continue;
      var d = CF.dist(x, y, en.x, en.y);
      if (d > range + en.radius) continue;
      var a = CF.angleTo(x, y, en.x, en.y);
      var diff = Math.abs(Math.atan2(Math.sin(a - ang), Math.cos(a - ang)));
      if (diff <= arc / 2) fn(en);
    }
  },

  autoAimAngle: function (px, py) {
    var best = null, bd = 640 * 640;   /* 640px auto-aim range */
    for (var i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      if (en.hp <= 0) continue;
      var dx = en.x - px, dy = en.y - py;
      var d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = en; }
    }
    return best ? CF.angleTo(px, py, best.x, best.y) : null;
  },

  damageEnemy: function (en, dmg, crit, fx, fy) {
    if (en.hp <= 0) return;
    en.takeDamage(dmg, crit, this, fx, fy);
  },

  spawnProjectile: function (o) {
    this.projectiles.push(new Projectile(o));
  },

  onEnemyKilled: function (en) {
    var p = this.player;
    p.kills++;
    this.gainXp(en.xp);
    var total = Math.max(1, Math.round(en.gold * (p.goldMult || 1)));
    var n = CF.randInt(1, 3);
    for (var i = 0; i < n; i++) {
      this.pickups.push(new Pickup('gold', en.x + CF.rand(-8, 8), en.y + CF.rand(-8, 8), { value: Math.ceil(total / n) }));
    }
    if (Math.random() < 0.10) {
      var pid = this.floor >= 5 ? CF.pick(['potion_small', 'potion_medium']) : 'potion_small';
      this.pickups.push(new Pickup('potion', en.x, en.y, { id: pid }));
    }
  },

  onBossKilled: function (en) {
    var self = this;
    /* guaranteed loot at boss position */
    var lootN = 3;
    for (var i = 0; i < lootN; i++) {
      var it = (typeof CF.randomItem === 'function') ? CF.randomItem(this.floor, Math.random) : null;
      if (it) this.pickups.push(new Pickup(it.type === 'weapon' || it.type === 'armor' ? 'gear' : 'potion',
        en.x + CF.rand(-20, 20), en.y + CF.rand(-20, 20),
        it.type === 'weapon' || it.type === 'armor' ? { item: it } : { id: it.id }));
    }
    var goldBounty = 60 + this.floor * 14;
    for (i = 0; i < 5; i++) {
      this.pickups.push(new Pickup('gold', en.x + CF.rand(-24, 24), en.y + CF.rand(-24, 24), { value: Math.ceil(goldBounty / 5) }));
    }
    if (en.def && en.def.id === 'crypt_king') {
      this.sealLocked = false;
      this.state = 'win';
      this.stopMusic();
      CF.sfx('win');
    } else if (this.sealLocked) {
      this.sealLocked = false;
      this.say('the seal breaks — the stairs open');
    } else {
      this.say('the tyrant falls. loot spills everywhere.');
    }
  },

  gainXp: function (x) {
    var p = this.player;
    if (!p) return;
    p.xp += x;
    var leveled = false;
    while (p.level < 99) {
      var need = (typeof CF.xpForLevel === 'function') ? CF.xpForLevel(p.level + 1) : 100;
      if (p.xp < need) break;
      p.xp -= need;
      p.level++;
      p.maxHp += 8;
      p.damage += 2;
      p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.3));
      leveled = true;
      CF.sfx('levelup');
      CF.Particles.burst(p.x, p.y, { color: '#7dff8a', count: 20, speed: 160, glow: true });
      CF.FloatText.add(p.x, p.y - 30, 'LEVEL ' + p.level + '!', '#7dff8a', 18);
    }
    if (leveled) {
      this.pendingLevels++;
      if (this.state === 'play') this.openLevelup();
    }
  },

  openLevelup: function () {
    this.rollLevelupChoices();
    if (this.levelupChoices.length > 0) this.state = 'levelup';
    else { this.pendingLevels = 0; } /* nothing eligible — auto stat gain only */
  },

  rollLevelupChoices: function () {
    var p = this.player;
    var eligible = [];
    for (var i = 0; i < CF.UPGRADES.length; i++) {
      var u = CF.UPGRADES[i];
      var cur = p.upgrades[u.id] || 0;
      if (cur < (u.max || 1)) eligible.push(u);
    }
    /* shuffle */
    for (i = eligible.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
    }
    this.levelupChoices = eligible.slice(0, 3);
  },

  applyUpgrade: function (u) {
    var p = this.player;
    p.upgrades[u.id] = (p.upgrades[u.id] || 0) + 1;
    try { u.apply(p); } catch (err) { console.error('upgrade apply failed', u.id, err); }
    CF.sfx('pickup');
    CF.Particles.burst(p.x, p.y, { color: '#d0a8ff', count: 16, speed: 140, glow: true });
    CF.FloatText.add(p.x, p.y - 34, u.name, '#d0a8ff', 16);
  },

  /* ================= INTERACT / PICKUPS ================= */
  updateNearInteract: function () {
    this.nearInteract = null;
    var p = this.player, best = null, bd = 52, d;
    for (var i = 0; i < this.chests.length; i++) {
      var c = this.chests[i];
      if (c.opened) continue;
      d = CF.dist(p.x, p.y, c.x, c.y);
      if (d < bd) { bd = d; best = { type: 'chest', x: c.x, y: c.y, obj: c }; }
    }
    var T = CF.TILE;
    var ex = this.dungeon.exit.x * T + T / 2, ey = this.dungeon.exit.y * T + T / 2;
    d = CF.dist(p.x, p.y, ex, ey);
    if (d < bd) { bd = d; best = { type: 'stairs', x: ex, y: ey, obj: null }; }
    this.nearInteract = best;
  },

  tryInteract: function () {
    var ni = this.nearInteract;
    if (!ni) return;
    var self = this;
    if (ni.type === 'chest') {
      var c = ni.obj;
      c.opened = true;
      CF.sfx('chest');
      CF.Camera.shake(3, 0.2);
      CF.Particles.burst(c.x, c.y, { color: '#ffd94a', count: 18, speed: 150, glow: true });
      var gold = 15 + this.floor * 6;
      for (var i = 0; i < 2; i++) {
        this.pickups.push(new Pickup('gold', c.x + CF.rand(-10, 10), c.y + CF.rand(-10, 10), { value: Math.ceil(gold / 2) }));
      }
      var lootN = 2 + (Math.random() < 0.4 ? 1 : 0);
      for (i = 0; i < lootN; i++) {
        var it = (typeof CF.randomItem === 'function') ? CF.randomItem(this.floor, Math.random) : null;
        if (!it) continue;
        var kind = (it.type === 'weapon' || it.type === 'armor') ? 'gear' : 'potion';
        this.pickups.push(new Pickup(kind, c.x + CF.rand(-14, 14), c.y + CF.rand(-14, 14),
          kind === 'gear' ? { item: it } : { id: it.id }));
      }
      this.say('the chest creaks open…');
    } else if (ni.type === 'stairs') {
      this.descend();
    }
  },

  collectPickup: function (pk) {
    var p = this.player;
    switch (pk.kind) {
      case 'gold':
        p.gold += pk.value;
        CF.sfx('coin');
        CF.FloatText.add(p.x, p.y - 20, '+' + pk.value + '◈', '#ffd94a', 13);
        break;
      case 'heart':
        p.hp = Math.min(p.maxHp, p.hp + 15);
        CF.sfx('pickup');
        CF.FloatText.add(p.x, p.y - 20, '+15 hp', '#ff8aa0', 13);
        break;
      case 'potion':
        var id = pk.data && pk.data.id;
        if (id && CF.ITEMS[id]) {
          p.consumables[id] = (p.consumables[id] || 0) + 1;
          CF.sfx('pickup');
          CF.FloatText.add(p.x, p.y - 20, CF.ITEMS[id].name, '#7dff8a', 13);
        }
        break;
      case 'gear':
        var it = pk.data && pk.data.item;
        if (!it) break;
        if (it.type === 'weapon') {
          if (!p.weapon || it.damage > p.weapon.damage) {
            p.weapon = it; CF.sfx('pickup');
            CF.FloatText.add(p.x, p.y - 24, it.name + '!', '#7de8ff', 15);
          } else {
            var s = Math.max(5, Math.round((it.price || 10) * 0.5));
            p.gold += s; CF.sfx('coin');
            CF.FloatText.add(p.x, p.y - 20, '+' + s + '◈ (sold)', '#ffd94a', 12);
          }
        } else if (it.type === 'armor') {
          if (!p.armor || it.defense > p.armor.defense) {
            p.armor = it; CF.sfx('pickup');
            CF.FloatText.add(p.x, p.y - 24, it.name + '!', '#a8b8d8', 15);
          } else {
            var s2 = Math.max(5, Math.round((it.price || 10) * 0.5));
            p.gold += s2; CF.sfx('coin');
            CF.FloatText.add(p.x, p.y - 20, '+' + s2 + '◈ (sold)', '#ffd94a', 12);
          }
        } else if (it.type === 'consumable' && CF.ITEMS[it.id]) {
          p.consumables[it.id] = (p.consumables[it.id] || 0) + 1;
          CF.FloatText.add(p.x, p.y - 20, it.name, '#7dff8a', 13);
        }
        break;
    }
  },

  playerDied: function () {
    this.state = 'dead';
    CF.sfx('gameover');
    this.stopMusic();
    CF.Camera.shake(10, 0.5);
    CF.Particles.burst(this.player.x, this.player.y, { color: '#ff5a5a', count: 30, speed: 200, glow: true });
    try { localStorage.removeItem(this.SAVE_KEY); } catch (err) {}
  },

  /* ================= WORLD HELPERS ================= */
  revealExplored: function () {
    var d = this.dungeon, p = this.player, T = CF.TILE;
    var ptx = Math.floor(p.x / T), pty = Math.floor(p.y / T), R = 8;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        var tx = ptx + dx, ty = pty + dy;
        if (tx < 0 || ty < 0 || tx >= d.width || ty >= d.height) continue;
        this.explored.add(ty * d.width + tx);
      }
    }
  },

  buildFloorCanvas: function (d) {
    var T = CF.TILE;
    var c = document.createElement('canvas');
    c.width = d.width * T; c.height = d.height * T;
    var g = c.getContext('2d');
    for (var y = 0; y < d.height; y++) {
      for (var x = 0; x < d.width; x++) {
        var t = d.tiles[y * d.width + x];
        var v = CF.hash2(x, y);
        if (t === 0) {
          /* wall */
          g.fillStyle = '#131019';
          g.fillRect(x * T, y * T, T, T);
          /* lit bottom edge when floor is below (fake depth) */
          if (y + 1 < d.height && d.tiles[(y + 1) * d.width + x] !== 0) {
            g.fillStyle = '#332c48';
            g.fillRect(x * T, y * T + T - 6, T, 6);
          }
          /* brick seams */
          if (v > 0.5) {
            g.fillStyle = 'rgba(255,255,255,0.025)';
            g.fillRect(x * T, y * T + (v > 0.75 ? T / 2 : T / 4), T, 1);
          }
        } else {
          /* floor variants */
          var base = 38 + Math.floor(v * 9);
          g.fillStyle = 'rgb(' + (base + 2) + ',' + (base - 2) + ',' + (base + 14) + ')';
          g.fillRect(x * T, y * T, T, T);
          /* grid seams */
          g.fillStyle = 'rgba(0,0,0,0.22)';
          g.fillRect(x * T, y * T + T - 1, T, 1);
          g.fillRect(x * T + T - 1, y * T, 1, T);
          /* speckle */
          if (v > 0.87) {
            g.fillStyle = 'rgba(0,0,0,0.25)';
            g.fillRect(x * T + Math.floor(v * 30) % 32 + 3, y * T + Math.floor(v * 60) % 32 + 3, 2, 2);
          }
          if (t === 2) {
            /* door: wooden bar */
            g.fillStyle = '#5d452c';
            g.fillRect(x * T, y * T + T / 2 - 4, T, 8);
            g.fillStyle = '#3f2e1c';
            g.fillRect(x * T, y * T + T / 2 - 4, T, 1);
            g.fillRect(x * T, y * T + T / 2 + 3, T, 1);
          } else if (t === 3) {
            /* stairs */
            g.fillStyle = '#0d2a33';
            g.fillRect(x * T + 2, y * T + 2, T - 4, T - 4);
            g.fillStyle = 'rgba(125,232,255,0.35)';
            g.fillRect(x * T + 8, y * T + 8, T - 16, T - 16);
          }
        }
      }
    }
    this.floorCanvas = c;
  },

  updateMusic: function (dt) {
    if (!CF.SoundFX.startMusic) return;
    this._musicT -= dt;
    if (this._musicT > 0) return;
    this._musicT = 1.5;
    var intensity = 0;
    if (this.boss && this.boss.hp > 0 && this.boss.aggro) intensity = 2;
    else {
      var p = this.player;
      for (var i = 0; i < this.enemies.length; i++) {
        var en = this.enemies[i];
        if (en.aggro && en.hp > 0 && CF.dist(p.x, p.y, en.x, en.y) < 420) { intensity = 1; break; }
      }
    }
    if (intensity !== this._musicIntensity) {
      this._musicIntensity = intensity;
      try { CF.SoundFX.startMusic(intensity); } catch (err) {}
    }
  },

  stopMusic: function () {
    if (CF.SoundFX.stopMusic) { try { CF.SoundFX.stopMusic(); } catch (err) {} }
    this._musicIntensity = -1;
  },

  pickWeighted: function (table) {
    if (!table || table.length === 0) return null;
    var total = 0, i;
    for (i = 0; i < table.length; i++) total += table[i].weight || 1;
    var r = Math.random() * total;
    for (i = 0; i < table.length; i++) {
      r -= (table[i].weight || 1);
      if (r <= 0) return table[i].id;
    }
    return table[table.length - 1].id;
  },

  findUpgrade: function (id) {
    var list = Array.isArray(CF.UPGRADES) ? CF.UPGRADES : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  },

  /* ================= SAVE / LOAD ================= */
  serialize: function () {
    var p = this.player;
    if (!p) return null;
    return {
      v: 1,
      seed: this.seed,
      floor: this.floor,
      level: p.level, xp: p.xp, gold: p.gold,
      hp: Math.ceil(p.hp), kills: p.kills,
      weaponId: p.weapon ? p.weapon.id : null,
      armorId: p.armor ? p.armor.id : null,
      consumables: p.consumables,
      upgrades: p.upgrades
    };
  },

  save: function () {
    try {
      var data = this.serialize();
      if (data) localStorage.setItem(this.SAVE_KEY, JSON.stringify(data));
    } catch (err) {}
  },

  loadSave: function () {
    try {
      var raw = localStorage.getItem(this.SAVE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data && data.v === 1) return data;
    } catch (err) {}
    return null;
  },

  hasSave: function () { return !!this.loadSave(); },

  /* ================= RENDER ================= */
  _render: function (ctx, dt) {
    var W = CF.Engine.W, H = CF.Engine.H;
    var r3 = (CF.Render3D && CF.Render3D.active) ? CF.Render3D : null;
    if (r3) ctx.clearRect(0, 0, W, H);   /* 2D canvas = transparent HUD overlay over #game3d */
    else { ctx.fillStyle = '#060508'; ctx.fillRect(0, 0, W, H); }

    if (this.state === 'title' || this.state === 'help' || !this.dungeon || !this.player) {
      if (this.state === 'help') CF.UI.drawHelp(ctx);
      else CF.UI.drawTitle(ctx, this);
      return;
    }

    /* ---- world ---- */
    if (r3) {
      /* renderer swap: CF.Render3D draws the world in 3D, exposes the
       * projected float-text list for this HUD canvas to draw on top */
      r3.frame(this, dt);
      r3.drawProjectedFloats(ctx, this);
    } else {
      ctx.save();
      CF.Camera.apply(ctx);
      var cam = CF.Camera;
      if (this.floorCanvas) {
        var sx = CF.clamp(cam.x + cam.shakeX, 0, Math.max(0, this.floorCanvas.width - W));
        var sy = CF.clamp(cam.y + cam.shakeY, 0, Math.max(0, this.floorCanvas.height - H));
        ctx.drawImage(this.floorCanvas, sx, sy, W, H, sx, sy, W, H);
      }
      /* stairs pulse */
      var T = CF.TILE;
      var ex = this.dungeon.exit.x * T + T / 2, ey = this.dungeon.exit.y * T + T / 2;
      var pulse = 0.25 + Math.sin(CF.Engine.time * 4) * 0.15;
      ctx.fillStyle = 'rgba(125,232,255,' + pulse + ')';
      ctx.beginPath(); ctx.arc(ex, ey, 22, 0, Math.PI * 2); ctx.fill();

      var i;
      for (i = 0; i < this.chests.length; i++) this.chests[i].render(ctx);
      for (i = 0; i < this.pickups.length; i++) this.pickups[i].render(ctx);
      for (i = 0; i < this.enemies.length; i++) this.enemies[i].render(ctx, this);
      for (i = 0; i < this.projectiles.length; i++) this.projectiles[i].render(ctx);
      this.player.render(ctx, this);
      CF.Particles.render(ctx);
      CF.FloatText.render(ctx);
      ctx.restore();

      /* ---- lighting (screen space) ---- */
      var pp = CF.Camera.worldToScreen(this.player.x, this.player.y);
      var flicker = Math.sin(CF.Engine.time * 7) * 6 + Math.sin(CF.Engine.time * 13) * 3;
      var outer = (this.state === 'dead') ? 140 : 460 + flicker;
      var vg = ctx.createRadialGradient(pp.x, pp.y, 90, pp.x, pp.y, outer);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.6, 'rgba(0,0,0,0.35)');
      vg.addColorStop(1, 'rgba(0,0,0,0.92)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }

    /* ---- HUD & overlays ---- */
    if (this.state === 'play' || this.state === 'paused' || this.state === 'inventory' ||
        this.state === 'levelup' || this.state === 'shop' || this.state === 'dead' || this.state === 'win') {
      CF.UI.drawHUD(ctx, this);
    }
    switch (this.state) {
      case 'paused': CF.UI.drawPause(ctx, this); break;
      case 'inventory': CF.UI.drawInventory(ctx, this); break;
      case 'levelup': CF.UI.drawLevelUp(ctx, this); break;
      case 'shop': CF.UI.drawShop(ctx, this); break;
      case 'dead': CF.UI.drawDead(ctx, this); break;
      case 'win': CF.UI.drawWin(ctx, this); break;
    }

    /* ---- fade ---- */
    if (this.fade > 0) {
      ctx.fillStyle = 'rgba(0,0,0,' + CF.clamp(this.fade, 0, 1) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  }
};

/* ================= NODE SELF-TEST ================= */
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('main.js')) {
  (function () {
    var G = CF.Game;
    var pass = 0, fail = 0;
    function check(name, cond) {
      if (cond) { pass++; console.log('PASS: ' + name); }
      else { fail++; console.log('FAIL: ' + name); }
    }
    /* pickWeighted */
    var table = [{ id: 'a', weight: 0 }, { id: 'b', weight: 100 }];
    check('pickWeighted picks only weighted entry', G.pickWeighted(table) === 'b');
    check('pickWeighted empty table → null', G.pickWeighted([]) === null);
    var counts = { a: 0, b: 0, c: 0 };
    for (var i = 0; i < 3000; i++) counts[G.pickWeighted([{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 2 }])]++;
    check('pickWeighted ratio approx 1:1:2', counts.a > 600 && counts.b > 600 && counts.c > 1200);
    /* serialize with mock player */
    G.player = {
      level: 3, xp: 12, gold: 45, hp: 77.6, kills: 9,
      weapon: { id: 'short_sword' }, armor: null,
      consumables: { potion_small: 2 }, upgrades: { vitality: 1 }
    };
    G.seed = 123; G.floor = 4;
    var s = G.serialize();
    check('serialize snapshot fields', s && s.level === 3 && s.floor === 4 && s.seed === 123 &&
      s.weaponId === 'short_sword' && s.hp === 78 && s.kills === 9);
    var s2 = JSON.parse(JSON.stringify(s));
    check('serialize JSON round-trip', s2.weaponId === 'short_sword' && s2.consumables.potion_small === 2);
    /* xp curve sanity if content is present (it is not in isolated node run — skip gracefully) */
    check('findUpgrade on empty list → null', G.findUpgrade('nope') === null ||
      (CF.UPGRADES && Array.isArray(CF.UPGRADES)));
    console.log(fail === 0 ? 'ALL TESTS PASSED (' + pass + ')' : 'FAILED: ' + fail);
    process.exit(fail === 0 ? 0 : 1);
  })();
}

/* ================= BOOTSTRAP ================= */
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { CF.Game.boot(); });
  } else {
    CF.Game.boot();
  }
}
