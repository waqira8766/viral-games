/* CRYPTFALL — js/entities.js
 * Player, Enemy (with AI behaviors), Projectile, Pickup, Chest.
 * World coordinates in pixels. CF.TILE per contracts (default 40).
 */
var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
if (CF.TILE === undefined) CF.TILE = 40;

/* ---------------- tile collision helpers ---------------- */
CF.tileAt = function (dungeon, px, py) {
  var T = CF.TILE;
  var tx = Math.floor(px / T), ty = Math.floor(py / T);
  if (tx < 0 || ty < 0 || tx >= dungeon.width || ty >= dungeon.height) return 0; /* out = wall */
  return dungeon.tiles[ty * dungeon.width + tx];
};
CF.solidAt = function (dungeon, px, py) { return CF.tileAt(dungeon, px, py) === 0; };

/* AABB circle-ish vs tiles, separate axis. Returns true if fully blocked an axis. */
CF.moveAndCollide = function (e, dx, dy, dungeon) {
  var T = CF.TILE;
  var r = e.radius * 0.78; /* forgiving corner box */
  var moved = { x: 0, y: 0 };
  /* X axis */
  var nx = e.x + dx;
  if (dx !== 0 && !CF.solidAt(dungeon, nx + (dx > 0 ? r : -r), e.y - r * 0.9) &&
      !CF.solidAt(dungeon, nx + (dx > 0 ? r : -r), e.y + r * 0.9)) {
    e.x = nx; moved.x = dx;
  }
  /* Y axis */
  var ny = e.y + dy;
  if (dy !== 0 && !CF.solidAt(dungeon, e.x - r * 0.9, ny + (dy > 0 ? r : -r)) &&
      !CF.solidAt(dungeon, e.x + r * 0.9, ny + (dy > 0 ? r : -r))) {
    e.y = ny; moved.y = dy;
  }
  return moved;
};

CF.hasLOS = function (dungeon, x0, y0, x1, y1) {
  if (typeof CF.DungeonGen === 'undefined' || !CF.DungeonGen.hasLineOfSight) return true;
  var T = CF.TILE;
  try {
    return CF.DungeonGen.hasLineOfSight(dungeon,
      Math.floor(x0 / T), Math.floor(y0 / T),
      Math.floor(x1 / T), Math.floor(y1 / T));
  } catch (err) { return true; }
};

/* ================================================================ PLAYER */
function Player(game) {
  var base = (typeof CF.playerBase === 'function') ? CF.playerBase() : { maxHp: 100 };
  for (var k in base) this[k] = base[k];
  this.x = 0; this.y = 0;
  this.vx = 0; this.vy = 0;
  this.radius = 14;
  this.aim = 0;                 /* radians toward mouse */
  this.facing = 1;

  this.weapon = CF.ITEMS ? CF.ITEMS.rusty_dagger : null;
  this.armor = null;
  this.consumables = {};        /* id -> count */
  this.gold = 0;
  this.level = 1; this.xp = 0;
  this.upgrades = {};           /* id -> times applied */
  this.damageMult = 1;
  this.kills = 0;

  this.hp = this.maxHp;
  this.iframes = 0;
  this.attackT = 0;
  this.dashT = 0; this.dashCdT = 0; this.dashVx = 0; this.dashVy = 0; this.dashHits = null;
  this.hurtFlash = 0;
  this.trail = [];              /* dash ghosts */
  this.bob = 0;
}

Player.prototype.totalDamage = function () {
  var wdmg = (this.weapon && this.weapon.damage) || 0;
  return Math.round((wdmg + this.damage) * this.damageMult);
};

Player.prototype.update = function (dt, game) {
  var I = CF.Input;
  /* aim: mouse on desktop; on touch, auto-aim at nearest enemy while attacking */
  if (I.mobile) {
    if (I.attackHeld) {
      var aa = (game.autoAimAngle ? game.autoAimAngle(this.x, this.y) : null);
      if (aa !== null) this.aim = aa;
    }
  } else {
    var m = CF.Camera.screenToWorld(I.mouse.x, I.mouse.y);
    this.aim = CF.angleTo(this.x, this.y, m.x, m.y);
  }
  if (Math.abs(Math.cos(this.aim)) > 0.25) this.facing = Math.cos(this.aim) > 0 ? 1 : -1;

  /* --- movement (keyboard + analog joystick) --- */
  var mx = 0, my = 0;
  if (I.held('KeyW') || I.held('ArrowUp')) my -= 1;
  if (I.held('KeyS') || I.held('ArrowDown')) my += 1;
  if (I.held('KeyA') || I.held('ArrowLeft')) mx -= 1;
  if (I.held('KeyD') || I.held('ArrowRight')) mx += 1;
  var ml = Math.hypot(mx, my);
  if (ml > 0) { mx /= ml; my /= ml; }
  /* joystick overrides keys when active (analog tilt 0..1) */
  var ax = (I.axes && I.axes.mx) || 0, ay = (I.axes && I.axes.my) || 0;
  var amag = Math.hypot(ax, ay);
  if (amag > 0.12) { mx = ax; my = ay; ml = 1; }

  /* --- dash --- */
  this.dashCdT = Math.max(0, this.dashCdT - dt);
  if (I.hit('Space') && this.dashCdT <= 0 && this.dashT <= 0) {
    var ddx = (amag > 0.12) ? ax / amag : mx;
    var ddy = (amag > 0.12) ? ay / amag : my;
    var dx = (ml > 0) ? ddx : Math.cos(this.aim), dy = (ml > 0) ? ddy : Math.sin(this.aim);
    this.dashT = 0.16;
    this.dashVx = dx * this.speed * 3.4;
    this.dashVy = dy * this.speed * 3.4;
    this.dashCdT = this.dashCd / 1000;
    this.dashHits = {};
    this.iframes = Math.max(this.iframes, 0.22);
    CF.sfx('dash');
    CF.Particles.burst(this.x, this.y, { color: '#8fd0ff', count: 8, speed: 90, glow: true });
  }
  if (this.dashT > 0) {
    this.dashT -= dt;
    CF.moveAndCollide(this, this.dashVx * dt, this.dashVy * dt, game.dungeon);
    this.trail.push({ x: this.x, y: this.y, life: 0.25 });
    /* momentum upgrade: dash damages enemies */
    if (this.dashDamage > 0) {
      for (var ei = 0; ei < game.enemies.length; ei++) {
        var en = game.enemies[ei];
        if (this.dashHits[en.id]) continue;
        if (CF.dist(this.x, this.y, en.x, en.y) < this.radius + en.radius + 6) {
          this.dashHits[en.id] = true;
          game.damageEnemy(en, this.dashDamage, false, this.x, this.y);
        }
      }
    }
  } else {
    CF.moveAndCollide(this, mx * this.speed * dt, my * this.speed * dt, game.dungeon);
  }
  this.bob += dt * (ml > 0 || this.dashT > 0 ? 10 : 3);

  /* dash ghost trail decay */
  for (var ti = this.trail.length - 1; ti >= 0; ti--) {
    this.trail[ti].life -= dt;
    if (this.trail[ti].life <= 0) this.trail.splice(ti, 1);
  }

  /* --- attack --- */
  this.attackT = Math.max(0, this.attackT - dt);
  var cd = this.attackCd || (this.weapon && this.weapon.attackCd) || 300;
  if ((I.mouse.down || I.attackHeld) && this.attackT <= 0 && this.weapon) {
    this.attackT = (this.weapon.attackCd || 300) / 1000;
    if (this.weapon.projectile) this.fireProjectile(game);
    else this.meleeAttack(game);
  }

  /* --- interact --- */
  if (I.hit('KeyE')) game.tryInteract();
  /* --- drink potion --- */
  if (I.hit('KeyQ')) this.drink(game);

  this.iframes = Math.max(0, this.iframes - dt);
  this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
};

Player.prototype.meleeAttack = function (game) {
  var w = this.weapon;
  var range = w.range || 52, arc = w.arc || 1.1;
  CF.sfx('swing');
  CF.Particles.slash(this.x, this.y, this.aim, arc, range, '#cfe6ff');
  var self = this;
  game.forEachEnemyInArc(this.x, this.y, this.aim, arc, range, function (en) {
    var crit = Math.random() < self.critChance;
    var dmg = self.totalDamage() * (crit ? self.critMult : 1);
    game.damageEnemy(en, dmg, crit, self.x, self.y);
    /* knockback */
    var a = CF.angleTo(self.x, self.y, en.x, en.y);
    en.kb.x += Math.cos(a) * 160; en.kb.y += Math.sin(a) * 160;
    if (self.lifeSteal > 0) {
      var heal = Math.max(0, Math.round(dmg * self.lifeSteal));
      if (heal > 0 && self.hp < self.maxHp) { self.hp = Math.min(self.maxHp, self.hp + heal); CF.FloatText.add(self.x, self.y - 18, '+' + heal, '#7dff8a', 12); }
    }
  });
};

Player.prototype.fireProjectile = function (game) {
  var w = this.weapon, p = w.projectile;
  CF.sfx('shoot');
  var self = this;
  game.spawnProjectile({
    x: this.x + Math.cos(this.aim) * 16, y: this.y + Math.sin(this.aim) * 16,
    vx: Math.cos(this.aim) * p.speed, vy: Math.sin(this.aim) * p.speed,
    damage: this.totalDamage(), friendly: true,
    radius: p.radius || 5, color: p.color || '#ffb347',
    pierce: (p.pierce || 0) + (this.pierceBonus || 0), life: 1.6
  });
};

Player.prototype.drink = function (game) {
  var order = ['potion_small', 'potion_medium', 'potion_large', 'elixir'];
  var missing = this.maxHp - this.hp;
  if (missing < 10) { CF.FloatText.add(this.x, this.y - 24, 'hp full', '#9aa', 12); return; }
  var bestId = null, bestWaste = 1e9;
  for (var i = 0; i < order.length; i++) {
    var id = order[i], cnt = this.consumables[id] || 0;
    if (cnt <= 0) continue;
    var heal = CF.healValue ? CF.healValue(CF.ITEMS[id], this) : (CF.ITEMS[id].effect || 0);
    var waste = heal - missing;
    if (waste >= 0 && waste < bestWaste) { bestWaste = waste; bestId = id; }
    else if (bestId === null && waste < bestWaste) { bestWaste = waste; bestId = id; }
  }
  if (!bestId) { CF.FloatText.add(this.x, this.y - 24, 'no potions', '#f88', 12); return; }
  this.consumables[bestId]--;
  var item = CF.ITEMS[bestId];
  var healAmt = CF.healValue ? CF.healValue(item, this) : (item.effect || 0);
  this.hp = CF.clamp(this.hp + healAmt, 0, this.maxHp);
  CF.sfx('pickup');
  CF.FloatText.add(this.x, this.y - 26, '+' + healAmt + ' hp', '#7dff8a', 16);
  CF.Particles.burst(this.x, this.y, { color: '#7dff8a', count: 12, speed: 70, glow: true });
};

Player.prototype.takeDamage = function (raw, game, fromX, fromY) {
  var self2 = this;
  if (this.iframes > 0 || this.dashT > 0) return;
  var def = (this.armor && this.armor.defense || 0) + (this.defense || 0);
  var dmg = Math.max(1, Math.round(raw - def));
  this.hp -= dmg;
  this.iframes = 0.65;
  this.hurtFlash = 1;
  CF.sfx('hurt');
  CF.Camera.shake(6, 0.25);
  CF.FloatText.add(this.x, this.y - 20, '-' + dmg, '#ff6a6a', 15);
  CF.Particles.burst(this.x, this.y, { color: '#ff5a5a', count: 10, speed: 130 });
  if (fromX !== undefined && this.thorns > 0) {
    /* reflect to enemies near the damage source */
    var ta = CF.angleTo(fromX, fromY, this.x, this.y);
    game.forEachEnemyInArc(this.x, this.y, ta, 2.4, 90, function (en) {
      game.damageEnemy(en, Math.round(self2.thorns), false, self2.x, self2.y);
    });
  }
  if (this.hp <= 0) { this.hp = 0; game.playerDied(); }
};

Player.prototype.render = function (ctx, game) {
  var t = CF.Engine.time;
  /* dash ghosts */
  for (var i = 0; i < this.trail.length; i++) {
    var g = this.trail[i];
    ctx.globalAlpha = g.life * 2.2;
    ctx.fillStyle = '#4da6ff';
    ctx.beginPath(); ctx.arc(g.x, g.y, this.radius * 0.9, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  /* iframe blink */
  if (this.iframes > 0 && Math.floor(t * 18) % 2 === 0) ctx.globalAlpha = 0.45;

  var bobY = Math.sin(this.bob) * 2;
  var px = this.x, py = this.y + bobY;

  /* shadow */
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(this.x, this.y + this.radius * 0.85, this.radius * 0.95, this.radius * 0.4, 0, 0, Math.PI * 2); ctx.fill();

  /* cloak body */
  var grd = ctx.createRadialGradient(px - 3, py - 4, 2, px, py, this.radius + 3);
  grd.addColorStop(0, '#5d6b9e'); grd.addColorStop(1, '#2b3352');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(px, py, this.radius, 0, Math.PI * 2); ctx.fill();
  /* hood rim */
  ctx.strokeStyle = '#8494c9'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(px, py, this.radius, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();

  /* eyes toward aim */
  var ex = Math.cos(this.aim) * 4, ey = Math.sin(this.aim) * 3 - 2;
  ctx.fillStyle = '#baffe8';
  ctx.fillRect(px - 5 + ex, py + ey - 1, 3, 3);
  ctx.fillRect(px + 2 + ex, py + ey - 1, 3, 3);

  /* weapon toward aim */
  if (this.weapon) {
    ctx.save();
    ctx.translate(px, py); ctx.rotate(this.aim);
    var swing = this.attackT > 0 ? (this.attackT * 8) : 0;
    ctx.rotate(-swing * 0.35);
    ctx.fillStyle = this.weapon.color || '#cfd6e4';
    if (this.weapon.projectile) { /* wand/bow */
      ctx.fillRect(8, -2, 16, 3.5);
      ctx.fillStyle = this.weapon.projectile.color || '#ffb347';
      ctx.beginPath(); ctx.arc(26, 0, 3, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillRect(9, -1.7, this.weapon.range ? Math.min(22, this.weapon.range * 0.38) : 20, 3.4);
      ctx.fillStyle = '#6b5a3f';
      ctx.fillRect(6, -2.5, 4, 5);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
};

/* ================================================================ ENEMY */
var _enemyId = 0;
function Enemy(game, def, floor, x, y) {
  this.id = ++_enemyId;
  this.def = def;
  var st = (typeof CF.ENEMY_STATS === 'function') ? CF.ENEMY_STATS(def.id, floor) : { hp: def.hp, damage: def.damage, xp: def.xp, gold: def.gold, speed: def.speed };
  this.maxHp = st.hp; this.hp = st.hp;
  this.damage = st.damage; this.xp = st.xp; this.gold = st.gold;
  this.speed = st.speed; this.radius = def.radius || 14;
  this.ai = def.ai;
  this.x = x; this.y = y;
  this.aggro = false;
  this.state = 'idle';
  this.attackT = 0; this.flashT = 0;
  this.kb = { x: 0, y: 0 };
  this.path = null; this.pathT = CF.rand(0, 0.5); this.pathIdx = 0;
  this.windup = 0; this.dashT = 0; this.dashVx = 0; this.dashVy = 0; this.recover = 0;
  this.patternT = CF.rand(0.5, 2); this.patternPhase = 0;
  this.wanderT = 0; this.wanderA = CF.rand(0, Math.PI * 2);
  this.phase = CF.rand(0, Math.PI * 2);
  this.isBoss = def.ai === 'boss';
}

Enemy.prototype.update = function (dt, game) {
  var p = game.player;
  var d = CF.dist(this.x, this.y, p.x, p.y);
  this.attackT = Math.max(0, this.attackT - dt);
  this.flashT = Math.max(0, this.flashT - dt);
  this.recover = Math.max(0, this.recover - dt);
  this.phase += dt;

  /* knockback */
  this.kb.x *= (1 - 6 * dt); this.kb.y *= (1 - 6 * dt);
  if (Math.abs(this.kb.x) + Math.abs(this.kb.y) > 4) {
    CF.moveAndCollide(this, this.kb.x * dt, this.kb.y * dt, game.dungeon);
  }

  /* aggro trigger */
  var aggroRange = this.ai === 'wander' ? 250 : (this.isBoss ? 1500 : 340);
  if (!this.aggro && d < aggroRange) this.aggro = true;
  if (this.aggro && d > 620) this.aggro = false;

  switch (this.ai) {
    case 'chase': this.aiChase(dt, game, d); break;
    case 'ranged': this.aiRanged(dt, game, d); break;
    case 'charger': this.aiCharger(dt, game, d); break;
    case 'wander': this.aiWander(dt, game, d); break;
    case 'boss': this.aiBoss(dt, game, d); break;
    default: this.aiChase(dt, game, d);
  }

  /* separation from other enemies */
  var enemies = game.enemies;
  for (var i = 0; i < enemies.length; i++) {
    var o = enemies[i];
    if (o === this || o.hp <= 0) continue;
    var od = CF.dist(this.x, this.y, o.x, o.y);
    var min = this.radius + o.radius;
    if (od < min && od > 0.01) {
      var push = (min - od) / min * 60 * dt;
      var a = CF.angleTo(o.x, o.y, this.x, this.y);
      CF.moveAndCollide(this, Math.cos(a) * push, Math.sin(a) * push, game.dungeon);
    }
  }
};

Enemy.prototype._contactHit = function (game, mult) {
  var p = game.player;
  var d = CF.dist(this.x, this.y, p.x, p.y);
  if (d < this.radius + p.radius + 4 && this.attackT <= 0) {
    this.attackT = (this.def.attackCd || 900) / 1000;
    p.takeDamage(this.damage * (mult || 1), game, this.x, this.y);
  }
};

Enemy.prototype._seek = function (dt, game, tx, ty, speedMul) {
  var a = CF.angleTo(this.x, this.y, tx, ty);
  CF.moveAndCollide(this, Math.cos(a) * this.speed * (speedMul || 1) * dt, Math.sin(a) * this.speed * (speedMul || 1) * dt, game.dungeon);
};

Enemy.prototype._pathFollow = function (dt, game) {
  var T = CF.TILE;
  var p = game.player;
  this.pathT -= dt;
  if (this.pathT <= 0 || !this.path || this.pathIdx >= this.path.length) {
    this.pathT = 0.55 + Math.random() * 0.3;
    if (typeof CF.DungeonGen !== 'undefined' && CF.DungeonGen.findPath) {
      this.path = CF.DungeonGen.findPath(game.dungeon,
        Math.floor(this.x / T), Math.floor(this.y / T),
        Math.floor(p.x / T), Math.floor(p.y / T));
      this.pathIdx = 0;
    } else this.path = null;
  }
  if (this.path && this.pathIdx < this.path.length) {
    var node = this.path[this.pathIdx];
    var nx = node.x * T + T / 2, ny = node.y * T + T / 2;
    if (CF.dist(this.x, this.y, nx, ny) < 12) { this.pathIdx++; return; }
    this._seek(dt, game, nx, ny, 0.9);
  }
};

Enemy.prototype.aiChase = function (dt, game, d) {
  if (!this.aggro) {
    this._wanderStep(dt, game, 0.35);
    return;
  }
  if (CF.hasLOS(game.dungeon, this.x, this.y, game.player.x, game.player.y)) this._seek(dt, game, game.player.x, game.player.y, 1);
  else this._pathFollow(dt, game);
  this._contactHit(game, 1);
};

Enemy.prototype.aiRanged = function (dt, game, d) {
  var p = game.player;
  if (!this.aggro) { this._wanderStep(dt, game, 0.4); return; }
  if (d > 260) {
    if (CF.hasLOS(game.dungeon, this.x, this.y, p.x, p.y)) this._seek(dt, game, p.x, p.y, 0.9);
    else this._pathFollow(dt, game);
  } else if (d < 170) {
    var away = CF.angleTo(p.x, p.y, this.x, this.y);
    CF.moveAndCollide(this, Math.cos(away) * this.speed * dt, Math.sin(away) * this.speed * dt, game.dungeon);
  }
  if (this.attackT <= 0 && d < 420 && CF.hasLOS(game.dungeon, this.x, this.y, p.x, p.y)) {
    this.attackT = (this.def.attackCd || 1600) / 1000;
    var pr = this.def.projectile;
    if (pr) {
      var a = CF.angleTo(this.x, this.y, p.x, p.y);
      CF.sfx('shoot');
      game.spawnProjectile({
        x: this.x + Math.cos(a) * (this.radius + 4), y: this.y + Math.sin(a) * (this.radius + 4),
        vx: Math.cos(a) * pr.speed, vy: Math.sin(a) * pr.speed,
        damage: pr.damage || this.damage, friendly: false,
        radius: pr.radius || 5, color: pr.color || '#ff7ad0', life: 2.2
      });
      this.flashT = 0.08;
    }
  }
  this._contactHit(game, 1);
};

Enemy.prototype.aiCharger = function (dt, game, d) {
  var p = game.player;
  if (this.dashT > 0) {
    this.dashT -= dt;
    CF.moveAndCollide(this, this.dashVx * dt, this.dashVy * dt, game.dungeon);
    CF.Particles.spawn({ x: this.x, y: this.y, vx: 0, vy: 0, life: 0.3, size: this.radius * 0.8, color: this.def.accent || '#fff', fade: true, shrink: true });
    this._contactHit(game, 1.4);
    return;
  }
  if (this.windup > 0) {
    this.windup -= dt;
    if (this.windup <= 0) {
      var a = CF.angleTo(this.x, this.y, p.x, p.y);
      this.dashVx = Math.cos(a) * this.speed * 2.6;
      this.dashVy = Math.sin(a) * this.speed * 2.6;
      this.dashT = 0.4; this.recover = 1.1;
      CF.sfx('swing');
    }
    return; /* stand still & flash while winding up */
  }
  if (!this.aggro) { this._wanderStep(dt, game, 0.4); return; }
  if (this.recover > 0) return;
  if (d < 300 && this.attackT <= 0 && CF.hasLOS(game.dungeon, this.x, this.y, p.x, p.y)) {
    this.windup = 0.45; this.attackT = 2.2; this.flashT = 0.5;
    return;
  }
  if (CF.hasLOS(game.dungeon, this.x, this.y, p.x, p.y)) this._seek(dt, game, p.x, p.y, 0.8);
  else this._pathFollow(dt, game);
  this._contactHit(game, 1);
};

Enemy.prototype.aiWander = function (dt, game, d) {
  if (this.aggro) {
    /* erratic pursuit: sine wobble around direct chase */
    var p = game.player;
    var base = CF.angleTo(this.x, this.y, p.x, p.y);
    var a = base + Math.sin(this.phase * 5) * 0.9;
    CF.moveAndCollide(this, Math.cos(a) * this.speed * dt, Math.sin(a) * this.speed * dt, game.dungeon);
    this._contactHit(game, 1);
  } else {
    this._wanderStep(dt, game, 0.5);
  }
};

Enemy.prototype.aiBoss = function (dt, game, d) {
  var p = game.player;
  var isFinal = this.def.id === 'crypt_king';
  this.patternT -= dt;
  /* dash phase (both bosses) */
  if (this.dashT > 0) {
    this.dashT -= dt;
    CF.moveAndCollide(this, this.dashVx * dt, this.dashVy * dt, game.dungeon);
    CF.Camera.shake(2, 0.05);
    this._contactHit(game, 1.5);
    return;
  }
  if (this.windup > 0) {
    this.windup -= dt;
    if (this.windup <= 0) {
      var a = CF.angleTo(this.x, this.y, p.x, p.y);
      this.dashVx = Math.cos(a) * this.speed * 2.3;
      this.dashVy = Math.sin(a) * this.speed * 2.3;
      this.dashT = 0.55;
      CF.sfx('boss'); CF.Camera.shake(8, 0.3);
    }
    return;
  }
  if (this.patternT <= 0) {
    if (isFinal) {
      /* alternate: radial burst then charge */
      if (this.patternPhase % 2 === 0) {
        /* radial burst */
        CF.sfx('shoot'); CF.Camera.shake(4, 0.15);
        var pr = this.def.projectile || { speed: 240, damage: 12, radius: 6, color: '#a06bff' };
        var N = 12, off = Math.random() * Math.PI;
        for (var i = 0; i < N; i++) {
          var aa = off + (Math.PI * 2 * i) / N;
          game.spawnProjectile({
            x: this.x + Math.cos(aa) * (this.radius + 8), y: this.y + Math.sin(aa) * (this.radius + 8),
            vx: Math.cos(aa) * pr.speed, vy: Math.sin(aa) * pr.speed,
            damage: pr.damage || this.damage * 0.6, friendly: false,
            radius: pr.radius || 6, color: pr.color || '#a06bff', life: 3
          });
        }
        this.patternT = 2.8; this.patternPhase++;
      } else {
        this.windup = 0.55; this.patternT = 3.4; this.patternPhase++;
      }
    } else {
      /* bone_colossus: 3-shot spread */
      CF.sfx('shoot');
      var pr2 = this.def.projectile || { speed: 200, damage: 10, radius: 6, color: '#cfd6e4' };
      var baseA = CF.angleTo(this.x, this.y, p.x, p.y);
      for (var k = -1; k <= 1; k++) {
        var ab = baseA + k * 0.24;
        game.spawnProjectile({
          x: this.x + Math.cos(ab) * (this.radius + 6), y: this.y + Math.sin(ab) * (this.radius + 6),
          vx: Math.cos(ab) * pr2.speed, vy: Math.sin(ab) * pr2.speed,
          damage: pr2.damage || this.damage * 0.7, friendly: false,
          radius: pr2.radius || 6, color: pr2.color || '#cfd6e4', life: 2.6
        });
      }
      this.patternT = 2.6;
    }
  }
  /* movement: keep midrange, charge when far */
  if (d > 200 || !CF.hasLOS(game.dungeon, this.x, this.y, p.x, p.y)) {
    if (CF.hasLOS(game.dungeon, this.x, this.y, p.x, p.y)) this._seek(dt, game, p.x, p.y, 1);
    else this._pathFollow(dt, game);
  }
  if (d > 340 && isFinal && this.patternT > 1.2 && this.windup <= 0) { this.windup = 0.55; }
  this._contactHit(game, 1.25);
};

Enemy.prototype._wanderStep = function (dt, game, speedMul) {
  this.wanderT -= dt;
  if (this.wanderT <= 0) { this.wanderT = CF.rand(0.7, 1.8); this.wanderA = CF.rand(0, Math.PI * 2); }
  var nx = Math.cos(this.wanderA) * this.speed * (speedMul || 0.4) * dt;
  var ny = Math.sin(this.wanderA) * this.speed * (speedMul || 0.4) * dt;
  var moved = CF.moveAndCollide(this, nx, ny, game.dungeon);
  if (!moved.x && !moved.y) this.wanderT = 0; /* bounce off wall */
};

Enemy.prototype.takeDamage = function (dmg, crit, game, fx, fy) {
  if (this.hp <= 0) return;
  this.hp -= dmg;
  this.flashT = 0.09;
  this.aggro = true;
  CF.sfx('hit');
  CF.FloatText.add(this.x, this.y - this.radius - 6, dmg + (crit ? '!' : ''), crit ? '#ffd94a' : '#fff', crit ? 17 : 13);
  CF.Particles.burst(this.x, this.y, { color: this.def.accent || '#fff', count: crit ? 12 : 6, speed: 110 });
  if (this.hp <= 0) this.die(game, fx, fy);
};

Enemy.prototype.die = function (game, fx, fy) {
  this.hp = 0;
  CF.sfx('death');
  CF.Particles.burst(this.x, this.y, { color: this.def.color, count: 16, speed: 160, glow: true, life: 0.8 });
  CF.Particles.burst(this.x, this.y, { color: '#fff', count: 6, speed: 60, life: 0.4 });
  if (this.isBoss) {
    CF.Camera.shake(14, 0.6);
    CF.sfx('explode');
    CF.Particles.burst(this.x, this.y, { color: '#a06bff', count: 40, speed: 260, glow: true, life: 1.4 });
    game.onBossKilled(this);
  }
  game.onEnemyKilled(this);
};

Enemy.prototype.render = function (ctx, game) {
  var t = CF.Engine.time;
  var alpha = 1;
  if (this.def.id === 'wraith') alpha = 0.55 + Math.sin(this.phase * 3) * 0.2;
  ctx.globalAlpha = alpha;
  /* telegraph windup flash */
  if (this.windup > 0 && Math.floor(t * 20) % 2 === 0) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(255,90,90,0.25)'; ctx.beginPath(); ctx.arc(this.x, this.y, this.radius + 6, 0, Math.PI * 2); ctx.fill(); }

  /* shadow */
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(this.x, this.y + this.radius * 0.8, this.radius * 0.9, this.radius * 0.35, 0, 0, Math.PI * 2); ctx.fill();

  /* body */
  var flash = this.flashT > 0;
  ctx.fillStyle = flash ? '#ffffff' : this.def.color;
  ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2); ctx.fill();
  /* accent: rim */
  ctx.strokeStyle = this.def.accent || '#000'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(this.x, this.y, this.radius - 1, 0, Math.PI * 2); ctx.stroke();
  /* boss crown spikes */
  if (this.isBoss) {
    ctx.fillStyle = '#ffd94a';
    for (var s = 0; s < 5; s++) {
      var sa = -Math.PI / 2 + (s - 2) * 0.5 + Math.sin(t * 2 + s) * 0.05;
      ctx.beginPath();
      ctx.moveTo(this.x + Math.cos(sa) * (this.radius - 2), this.y + Math.sin(sa) * (this.radius - 2));
      ctx.lineTo(this.x + Math.cos(sa) * (this.radius + 10), this.y + Math.sin(sa) * (this.radius + 10));
      ctx.lineTo(this.x + Math.cos(sa + 0.25) * (this.radius - 2), this.y + Math.sin(sa + 0.25) * (this.radius - 2));
      ctx.fill();
    }
  }
  /* eyes toward player */
  var ea = CF.angleTo(this.x, this.y, game.player.x, game.player.y);
  var ex = Math.cos(ea) * (this.radius * 0.35), ey = Math.sin(ea) * (this.radius * 0.35);
  ctx.fillStyle = flash ? '#c00' : '#ff5a5a';
  ctx.fillRect(this.x - this.radius * 0.4 + ex, this.y - this.radius * 0.25 + ey, 3.2, 3.2);
  ctx.fillRect(this.x + this.radius * 0.15 + ex, this.y - this.radius * 0.25 + ey, 3.2, 3.2);
  ctx.globalAlpha = 1;

  /* hp bar if damaged */
  if (this.hp < this.maxHp && !this.isBoss) {
    var w = this.radius * 2.4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(this.x - w / 2, this.y - this.radius - 9, w, 4);
    ctx.fillStyle = '#ff5a5a';
    ctx.fillRect(this.x - w / 2, this.y - this.radius - 9, w * CF.clamp(this.hp / this.maxHp, 0, 1), 4);
  }
};

/* ================================================================ PROJECTILE */
function Projectile(o) {
  for (var k in o) this[k] = o[k];
  this.dead = false;
  this.hitSet = [];
  this.trailT = 0;
}

Projectile.prototype.update = function (dt, game) {
  this.life -= dt;
  if (this.life <= 0) { this.dead = true; return; }
  this.x += this.vx * dt; this.y += this.vy * dt;
  /* wall hit */
  if (CF.solidAt(game.dungeon, this.x, this.y)) {
    this.dead = true;
    CF.Particles.burst(this.x, this.y, { color: this.color, count: 5, speed: 60, glow: true, life: 0.3 });
    return;
  }
  this.trailT -= dt;
  if (this.trailT <= 0) {
    this.trailT = 0.02;
    CF.Particles.spawn({ x: this.x, y: this.y, vx: 0, vy: 0, life: 0.18, size: this.radius * 1.2, color: this.color, fade: true, glow: true });
  }
  if (this.friendly) {
    for (var i = 0; i < game.enemies.length; i++) {
      var en = game.enemies[i];
      if (en.hp <= 0 || this.hitSet.indexOf(en.id) !== -1) continue;
      if (CF.dist(this.x, this.y, en.x, en.y) < this.radius + en.radius) {
        this.hitSet.push(en.id);
        var crit = Math.random() < game.player.critChance;
        var dmg = this.damage * (crit ? game.player.critMult : 1);
        game.damageEnemy(en, dmg, crit, this.x, this.y);
        if (this.hitSet.length > this.pierce) { this.dead = true; return; }
      }
    }
  } else {
    var p = game.player;
    if (CF.dist(this.x, this.y, p.x, p.y) < this.radius + p.radius) {
      p.takeDamage(this.damage, game, this.x, this.y);
      this.dead = true;
    }
  }
};

Projectile.prototype.render = function (ctx) {
  ctx.shadowColor = this.color; ctx.shadowBlur = 10;
  ctx.fillStyle = this.color;
  ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.arc(this.x, this.y, this.radius * 0.45, 0, Math.PI * 2); ctx.fill();
};

/* ================================================================ PICKUP */
function Pickup(kind, x, y, data) {
  this.kind = kind; /* gold | potion | gear | heart */
  this.x = x; this.y = y;
  this.radius = 6;
  this.data = data || {};
  this.value = data && data.value || 0;
  this.bob = CF.rand(0, Math.PI * 2);
  this.dead = false;
  this.vx = CF.rand(-40, 40); this.vy = CF.rand(-40, 40);
  this.magnet = false;
}

Pickup.prototype.update = function (dt, game) {
  var p = game.player;
  this.bob += dt * 4;
  /* scatter on spawn */
  if (Math.abs(this.vx) + Math.abs(this.vy) > 1) {
    var moved = CF.moveAndCollide(this, this.vx * dt, this.vy * dt, game.dungeon);
    if (!moved.x) this.vx *= -0.5;
    if (!moved.y) this.vy *= -0.5;
    this.vx *= (1 - 5 * dt); this.vy *= (1 - 5 * dt);
  }
  var d = CF.dist(this.x, this.y, p.x, p.y);
  if (d < (p.pickupRadius || 55)) this.magnet = true;
  if (this.magnet && d > 14) {
    var a = CF.angleTo(this.x, this.y, p.x, p.y);
    var sp = CF.lerp(140, 420, 1 - CF.clamp(d / (p.pickupRadius || 55), 0, 1));
    this.x += Math.cos(a) * sp * dt; this.y += Math.sin(a) * sp * dt;
  }
  if (d < 16) { this.dead = true; game.collectPickup(this); }
};

Pickup.prototype.render = function (ctx) {
  var by = Math.sin(this.bob) * 3;
  var x = this.x, y = this.y + by;
  ctx.save();
  switch (this.kind) {
    case 'gold':
      ctx.shadowColor = '#ffd94a'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffd94a';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#b8860b';
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
      break;
    case 'heart':
      ctx.shadowColor = '#ff5a7a'; ctx.shadowBlur = 8;
      ctx.fillStyle = '#ff5a7a';
      ctx.font = '12px monospace'; ctx.textAlign = 'center';
      ctx.fillText('♥', x, y + 4);
      ctx.shadowBlur = 0;
      break;
    case 'potion':
      ctx.fillStyle = '#4a90d9';
      ctx.fillRect(x - 3, y - 1, 6, 8);
      ctx.fillStyle = '#cfe6ff';
      ctx.fillRect(x - 1.5, y - 5, 3, 4);
      break;
    case 'gear':
      ctx.shadowColor = this.data.item ? (this.data.item.color || '#fff') : '#fff'; ctx.shadowBlur = 10;
      ctx.fillStyle = this.data.item ? (this.data.item.color || '#fff') : '#fff';
      ctx.translate(x, y); ctx.rotate(Math.PI / 4);
      ctx.fillRect(-8, -1.5, 16, 3);
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.shadowBlur = 0;
      break;
  }
  ctx.restore();
};

/* ================================================================ CHEST */
function Chest(x, y) {
  this.x = x; this.y = y;
  this.opened = false;
  this.radius = 16;
  this.glimmerT = CF.rand(0, 3);
}

Chest.prototype.update = function (dt, game) {
  if (this.opened) return;
  this.glimmerT += dt;
  if (this.glimmerT > 3) {
    this.glimmerT = 0;
    CF.Particles.spawn({
      x: this.x + CF.rand(-8, 8), y: this.y - 10,
      vx: 0, vy: -20, life: 0.8, size: 2.5, color: '#ffd94a', glow: true
    });
  }
};

Chest.prototype.render = function (ctx) {
  ctx.save();
  ctx.translate(this.x, this.y);
  /* body */
  ctx.fillStyle = this.opened ? '#4a3b28' : '#6b4f2e';
  ctx.fillRect(-14, -6, 28, 16);
  /* lid */
  ctx.fillStyle = this.opened ? '#2e2417' : '#8a6a3f';
  if (this.opened) {
    ctx.fillRect(-14, -18, 28, 8);
  } else {
    ctx.fillRect(-14, -14, 28, 10);
    ctx.fillStyle = '#ffd94a';
    ctx.fillRect(-3, -8, 6, 5);
  }
  /* trim */
  ctx.strokeStyle = '#3a2d1c'; ctx.lineWidth = 1.5;
  ctx.strokeRect(-14, -6, 28, 16);
  ctx.restore();
};
