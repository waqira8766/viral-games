/* CRYPTFALL — js/ui.js
 * All canvas-drawn UI: HUD, minimap, and overlay screens (title, help,
 * pause, inventory, level-up, shop, death, win). Pure drawing — input is
 * handled in main.js state logic.
 */
var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});

CF.UI = {};

/* ---------------- helpers ---------------- */
CF.UI.panel = function (ctx, x, y, w, h, border) {
  ctx.fillStyle = 'rgba(10,12,20,0.86)';
  ctx.beginPath();
  var r = 8;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
  if (border !== false) {
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
};

CF.UI.bar = function (ctx, x, y, w, h, frac, fg, bg) {
  ctx.fillStyle = bg || 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fg;
  ctx.fillRect(x, y, w * CF.clamp(frac, 0, 1), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
};

CF.UI.centerText = function (ctx, text, y, size, color, weight, cx) {
  var c = (cx !== undefined) ? cx : CF.Engine.W / 2;
  ctx.font = (weight || 'bold') + ' ' + size + 'px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000';
  ctx.fillText(text, c + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, c, y);
  ctx.textAlign = 'left';
};

/* ---------------- HUD ---------------- */
CF.UI.drawHUD = function (ctx, game) {
  var p = game.player;
  if (!p) return;
  var s = CF.clamp(CF.Engine.W / 950, 0.62, 1);   /* shrink HUD on phones */
  var W = CF.Engine.W / s;                         /* effective width in scaled space */
  var H = CF.Engine.H / s;
  ctx.save();
  ctx.scale(s, s);

  /* --- top-left status panel --- */
  CF.UI.panel(ctx, 10, 10, 250, 86);
  /* HP */
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#ff8a8a';
  ctx.fillText('HP', 20, 26);
  CF.UI.bar(ctx, 42, 17, 200, 10, p.hp / p.maxHp, p.hp / p.maxHp < 0.3 ? '#ff3a3a' : '#e04848');
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(Math.ceil(p.hp) + ' / ' + p.maxHp, 44, 26);
  /* XP */
  var nextXp = (typeof CF.xpForLevel === 'function') ? CF.xpForLevel(p.level + 1) : 100;
  ctx.fillStyle = '#7de8ff';
  ctx.fillText('LVL ' + p.level, 20, 43);
  CF.UI.bar(ctx, 62, 34, 180, 8, p.xp / nextXp, '#3ab0c9', 'rgba(0,0,0,0.5)');
  /* gold + floor */
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#ffd94a';
  ctx.fillText('◈ ' + p.gold, 20, 62);
  ctx.fillStyle = '#b8c0d8';
  ctx.fillText('FLOOR ' + game.floor, 130, 62);
  /* weapon + defense */
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = '#9aa3c0';
  ctx.fillText((p.weapon ? p.weapon.name : 'fists') + ' · dmg ' + p.totalDamage() +
    ' · def ' + ((p.armor && p.armor.defense || 0) + (p.defense || 0)), 20, 82);

  /* --- potions + dash --- */
  var potionCount = 0;
  for (var k in p.consumables) potionCount += p.consumables[k];
  CF.UI.panel(ctx, 10, 102, 250, 30);
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#7dff8a';
  ctx.fillText('[Q] potions: ' + potionCount, 20, 121);
  ctx.fillStyle = p.dashCdT <= 0 ? '#8fd0ff' : '#44506a';
  ctx.fillText('[SPACE] dash ' + (p.dashCdT <= 0 ? 'ready' : Math.ceil(p.dashCdT * 10) / 10 + 's'), 140, 121);

  /* --- minimap top-right --- */
  CF.UI.drawMinimap(ctx, game);

  /* --- boss bar --- */
  if (game.boss && game.boss.hp > 0 && game.boss.aggro) {
    var bw = Math.min(460, W - 80);
    var bx = (W - bw) / 2, by = H - 74;
    CF.UI.panel(ctx, bx - 10, by - 18, bw + 20, 34);
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#ff8ad0';
    ctx.textAlign = 'center';
    ctx.fillText(game.boss.def.name.toUpperCase(), W / 2, by - 5);
    ctx.textAlign = 'left';
    CF.UI.bar(ctx, bx, by, bw, 9, game.boss.hp / game.boss.maxHp, '#b03ad0', 'rgba(0,0,0,0.6)');
  }

  /* --- bottom hint bar --- */
  ctx.font = '11px monospace';
  ctx.fillStyle = 'rgba(180,190,220,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText(CF.Input.mobile
    ? 'stick move · ⚔ auto-aim attack · 💨 dash · E interact · 🧪 potion · ⏸ pause'
    : 'WASD move · mouse attack · SPACE dash · E interact · Q potion · I inventory · M mute · ESC pause',
    W / 2, H - 14);
  ctx.textAlign = 'left';

  /* --- transient message --- */
  if (game.msg && game.msg.t > 0) {
    var a = Math.min(1, game.msg.t / 0.5);
    ctx.globalAlpha = a;
    CF.UI.centerText(ctx, game.msg.text, 120, 22, '#ffd94a', 'bold', W / 2);
    ctx.globalAlpha = 1;
  }

  /* --- interact prompt --- */
  if (game.nearInteract) {
    var pt = CF.Camera.worldToScreen(game.nearInteract.x, game.nearInteract.y - 34);
    pt.x /= s; pt.y /= s;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText('[E]', pt.x + 1, pt.y + 1);
    ctx.fillStyle = game.nearInteract.type === 'stairs' ? '#7de8ff' : '#ffd94a';
    ctx.fillText('[E]', pt.x, pt.y);
    ctx.textAlign = 'left';
  }

  /* --- low hp vignette --- */
  if (p.hp / p.maxHp < 0.3) {
    var pulse = 0.25 + Math.sin(CF.Engine.time * 5) * 0.12;
    var vg = ctx.createRadialGradient(W / 2, CF.Engine.H / 2, CF.Engine.H * 0.35, W / 2, CF.Engine.H / 2, CF.Engine.H * 0.75);
    vg.addColorStop(0, 'rgba(255,0,0,0)');
    vg.addColorStop(1, 'rgba(255,0,0,' + pulse + ')');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
};

CF.UI.drawMinimap = function (ctx, game) {
  var d = game.dungeon;
  if (!d) return;
  var scale = 3;
  var mw = d.width * scale, mh = d.height * scale;
  var ms = CF.clamp(CF.Engine.W / 950, 0.62, 1);
  var mx = CF.Engine.W / ms - mw - 10, my = 10;
  CF.UI.panel(ctx, mx - 4, my - 4, mw + 8, mh + 8, true);
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(mx, my, mw, mh);

  /* explored tiles */
  ctx.fillStyle = '#3a3f55';
  var T = CF.TILE;
  var idxs = game.explored;
  idxs.forEach(function (idx) {
    var tx = idx % d.width, ty = Math.floor(idx / d.width);
    var t = d.tiles[idx];
    if (t === 0) return;
    ctx.fillStyle = t === 3 ? '#7de8ff' : (t === 2 ? '#8a6a3f' : '#3a3f55');
    ctx.fillRect(mx + tx * scale, my + ty * scale, scale, scale);
  });

  /* enemies on explored tiles */
  ctx.fillStyle = '#ff5a5a';
  for (var i = 0; i < game.enemies.length; i++) {
    var en = game.enemies[i];
    if (en.hp <= 0) continue;
    var etx = Math.floor(en.x / T), ety = Math.floor(en.y / T);
    if (idxs.has(ety * d.width + etx)) {
      ctx.fillRect(mx + etx * scale - 1, my + ety * scale - 1, scale + 1, scale + 1);
    }
  }

  /* player */
  ctx.fillStyle = '#baffe8';
  var ptx = Math.floor(game.player.x / T), pty = Math.floor(game.player.y / T);
  ctx.fillRect(mx + ptx * scale - 1, my + pty * scale - 1, scale + 1, scale + 1);
};

/* ---------------- TITLE ---------------- */
CF.UI.drawTitle = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  var t = CF.Engine.time;

  ctx.fillStyle = '#060508';
  ctx.fillRect(0, 0, W, H);
  /* subtle ember particles on title */
  if (Math.random() < 0.3) {
    CF.Particles.spawn({
      x: CF.rand(0, W), y: H + 10, vx: CF.rand(-10, 10), vy: CF.rand(-60, -30),
      life: CF.rand(2, 4), size: CF.rand(1, 3), color: '#ffb347', glow: true, grav: -6
    });
  }
  CF.Particles.update(1 / 60);
  CF.Particles.render(ctx);

  var y0 = H * 0.28;
  ctx.save();
  ctx.translate(0, Math.sin(t * 1.4) * 4);
  ctx.font = 'bold 72px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000';
  ctx.fillText('CRYPTFALL', W / 2 + 4, y0 + 4);
  var grd = ctx.createLinearGradient(0, y0 - 60, 0, y0 + 10);
  grd.addColorStop(0, '#e8e8ff'); grd.addColorStop(1, '#7de8ff');
  ctx.fillStyle = grd;
  ctx.fillText('CRYPTFALL', W / 2, y0);
  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = '#9aa3c0';
  ctx.fillText('— a roguelike descent —', W / 2, y0 + 30);
  ctx.restore();
  ctx.textAlign = 'left';

  var hasSave = game.hasSave && game.hasSave();
  var yy = H * 0.55;
  if (hasSave) {
    ctx.globalAlpha = Math.sin(t * 3) * 0.25 + 0.75;
    CF.UI.centerText(ctx, '[ENTER]  CONTINUE DESCENT', yy, 20, '#ffd94a');
    ctx.globalAlpha = 1;
    CF.UI.centerText(ctx, '[N]  new run (deletes save)', yy + 34, 14, '#b8c0d8');
  } else {
    ctx.globalAlpha = Math.sin(t * 3) * 0.25 + 0.75;
    CF.UI.centerText(ctx, '[ENTER]  BEGIN THE DESCENT', yy, 20, '#ffd94a');
    ctx.globalAlpha = 1;
  }
  CF.UI.centerText(ctx, '[H] how to play   [M] sound: ' + (game.muted ? 'off' : 'on'), yy + 70, 14, '#8890aa');
  CF.UI.centerText(ctx, '12 floors · every 5th a boss guards the way · death is permanent', yy + 106, 13, '#667');
};

/* ---------------- HELP ---------------- */
CF.UI.drawHelp = function (ctx) {
  var W = CF.Engine.W, H = CF.Engine.H;
  ctx.fillStyle = 'rgba(4,3,8,0.92)';
  ctx.fillRect(0, 0, W, H);
  var lines = [
    ['CRYPTFALL — HOW TO PLAY', 22, '#e8e8ff'],
    ['', 10, '#fff'],
    ['WASD / arrows — move        mouse — aim', 15, '#b8c0d8'],
    ['left click — attack (hold to swing)   SPACE — dash (dodge through attacks)', 15, '#b8c0d8'],
    ['E — open chests / take stairs down     Q — drink a potion', 15, '#b8c0d8'],
    ['I — inventory & stats     M — mute     ESC — pause', 15, '#b8c0d8'],
    ['', 10, '#fff'],
    ['Kill enemies for XP and gold. Level up → +HP, +damage, pick a relic.', 15, '#b8c0d8'],
    ['Chests drop weapons, armor and potions. Better gear = deeper survival.', 15, '#b8c0d8'],
    ['Every 3rd floor has a black market. Every 5th floor, a boss.', 15, '#b8c0d8'],
    ['Floor 12: the Crypt King. Slay him to win. Death deletes your run.', 15, '#b8c0d8'],
    ['', 16, '#fff'],
    ['[any key] back', 16, '#ffd94a']
  ];
  var y = H * 0.2;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i][0]) CF.UI.centerText(ctx, lines[i][0], y, lines[i][1], lines[i][2]);
    y += lines[i][1] + 14;
  }
};

/* ---------------- PAUSE ---------------- */
CF.UI.drawPause = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  ctx.fillStyle = 'rgba(4,3,8,0.7)';
  ctx.fillRect(0, 0, W, H);
  CF.UI.centerText(ctx, 'PAUSED', H * 0.3, 34, '#e8e8ff');
  CF.UI.centerText(ctx, '[ESC] resume    [M] sound: ' + (game.muted ? 'off' : 'on'), H * 0.45, 16, '#b8c0d8');
  CF.UI.centerText(ctx, '[R] restart run    [T] abandon to title', H * 0.5, 16, '#b8c0d8');
};

/* ---------------- INVENTORY ---------------- */
CF.UI.drawInventory = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  var p = game.player;
  ctx.fillStyle = 'rgba(4,3,8,0.8)';
  ctx.fillRect(0, 0, W, H);
  var pw = Math.min(560, W - 60), ph = Math.min(420, H - 60);
  var px = (W - pw) / 2, py = (H - ph) / 2;
  CF.UI.panel(ctx, px, py, pw, ph);
  ctx.font = 'bold 20px monospace';
  ctx.fillStyle = '#e8e8ff';
  ctx.fillText('INVENTORY', px + 24, py + 36);
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ffd94a';
  ctx.fillText('◈ ' + p.gold, px + pw - 100, py + 36);

  var y = py + 70;
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#7de8ff';
  ctx.fillText('WEAPON  ' + (p.weapon ? p.weapon.name : '—') +
    (p.weapon ? '  (dmg ' + p.weapon.damage + (p.weapon.projectile ? ', ranged' : '') + ')' : ''), px + 24, y); y += 22;
  ctx.fillStyle = '#a8b8d8';
  ctx.fillText('ARMOR   ' + (p.armor ? p.armor.name + '  (def ' + p.armor.defense + ')' : 'none'), px + 24, y); y += 26;

  ctx.fillStyle = '#8890aa';
  ctx.fillText('STATS', px + 24, y); y += 20;
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#b8c0d8';
  var statLines = [
    'total damage ' + p.totalDamage() + '    crit ' + Math.round(p.critChance * 100) + '% (x' + p.critMult + ')',
    'defense ' + ((p.armor && p.armor.defense || 0) + (p.defense || 0)) + '    speed ' + p.speed,
    'life steal ' + Math.round((p.lifeSteal || 0) * 100) + '%    dash dmg ' + (p.dashDamage || 0) + '    thorns ' + (p.thorns || 0)
  ];
  for (var i = 0; i < statLines.length; i++) { ctx.fillText(statLines[i], px + 34, y); y += 19; }
  y += 12;

  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#8890aa';
  ctx.fillText('POTIONS (press number to drink)', px + 24, y); y += 22;
  var n = 1, any = false;
  for (var id in p.consumables) {
    var cnt = p.consumables[id];
    if (!cnt || !CF.ITEMS[id]) continue;
    any = true;
    ctx.fillStyle = '#7dff8a';
    var it = CF.ITEMS[id];
    var hv = (it.effect && typeof it.effect === 'object') ? it.effect.heal : it.effect;
    ctx.fillText('[' + n + '] ' + it.name + ' x' + cnt + '  (heals ' + hv + ')', px + 34, y); y += 19; n++;
  }
  if (!any) { ctx.fillStyle = '#667'; ctx.fillText('none — enemies and chests drop them', px + 34, y); y += 19; }

  /* relics */
  y += 12;
  ctx.fillStyle = '#8890aa';
  ctx.fillText('RELICS', px + 24, y); y += 20;
  var anyRelic = false;
  for (var uid in p.upgrades) {
    if (!p.upgrades[uid]) continue;
    var u = null;
    for (var ci = 0; ci < CF.UPGRADES.length; ci++) if (CF.UPGRADES[ci].id === uid) u = CF.UPGRADES[ci];
    if (!u) continue;
    anyRelic = true;
    ctx.fillStyle = '#d0a8ff';
    ctx.fillText(u.name + (p.upgrades[uid] > 1 ? ' x' + p.upgrades[uid] : '') + ' — ' + u.desc, px + 34, y); y += 19;
  }
  if (!anyRelic) { ctx.fillStyle = '#667'; ctx.fillText('none yet — level up to choose relics', px + 34, y); }

  CF.UI.centerText(ctx, '[I] or [ESC] close', py + ph - 18, 14, '#ffd94a');
};

/* ---------------- LEVEL UP (relic choice) ---------------- */
CF.UI.drawLevelUp = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  ctx.fillStyle = 'rgba(4,3,8,0.82)';
  ctx.fillRect(0, 0, W, H);
  CF.UI.centerText(ctx, 'LEVEL ' + game.player.level + '!', H * 0.2, 30, '#7dff8a');
  CF.UI.centerText(ctx, 'choose a relic', H * 0.2 + 36, 16, '#8890aa');

  var ch = game.levelupChoices;
  var cw = Math.min(220, (W - 80) / 3 - 10), chh = 200;
  var startX = (W - (cw * 3 + 20)) / 2, y = H * 0.3;
  for (var i = 0; i < ch.length; i++) {
    var x = startX + i * (cw + 10);
    CF.UI.panel(ctx, x, y, cw, chh);
    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = '#d0a8ff';
    ctx.textAlign = 'center';
    ctx.fillText('[' + (i + 1) + ']', x + cw / 2, y + 30);
    var nameLines = CF.UI.wrapText(ctx, ch[i].name, cw - 24);
    for (var l = 0; l < nameLines.length; l++) {
      ctx.fillText(nameLines[l], x + cw / 2, y + 56 + l * 18);
    }
    ctx.font = '12px monospace';
    ctx.fillStyle = '#b8c0d8';
    var dLines = CF.UI.wrapText(ctx, ch[i].desc, cw - 24);
    for (var m = 0; m < dLines.length; m++) {
      ctx.fillText(dLines[m], x + cw / 2, y + 100 + m * 16);
    }
    ctx.textAlign = 'left';
  }
};

CF.UI.wrapText = function (ctx, text, maxW) {
  var words = String(text).split(' ');
  var lines = [], cur = '';
  for (var i = 0; i < words.length; i++) {
    var test = cur ? cur + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = words[i]; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
};

/* ---------------- SHOP ---------------- */
CF.UI.drawShop = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  ctx.fillStyle = 'rgba(4,3,8,0.88)';
  ctx.fillRect(0, 0, W, H);
  CF.UI.centerText(ctx, '🕳 THE BLACK MARKET', H * 0.16, 28, '#ffd94a');
  CF.UI.centerText(ctx, 'floor ' + game.floor + ' — gold: ◈ ' + game.player.gold, H * 0.16 + 34, 15, '#b8c0d8');

  var items = game.shopItems;
  var cw = Math.min(190, (W - 80) / 4 - 8), chh = 170;
  var startX = (W - (cw * 4 + 24)) / 4 + 20, y = H * 0.28;
  startX = (W - (cw * items.length + 8 * (items.length - 1))) / 2;
  for (var i = 0; i < items.length; i++) {
    var it = CF.ITEMS[items[i].id];
    if (!it) continue;
    var x = startX + i * (cw + 8);
    var afford = game.player.gold >= items[i].price;
    CF.UI.panel(ctx, x, y, cw, chh);
    ctx.textAlign = 'center';
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = it.type === 'weapon' ? '#7de8ff' : (it.type === 'armor' ? '#a8b8d8' : '#7dff8a');
    ctx.fillText('[' + (i + 1) + ']', x + cw / 2, y + 26);
    var nl = CF.UI.wrapText(ctx, it.name, cw - 20);
    for (var l = 0; l < nl.length; l++) ctx.fillText(nl[l], x + cw / 2, y + 50 + l * 17);
    ctx.font = '11px monospace';
    ctx.fillStyle = '#8890aa';
    var dl = CF.UI.wrapText(ctx, it.desc || '', cw - 20);
    for (var m = 0; m < Math.min(dl.length, 4); m++) ctx.fillText(dl[m], x + cw / 2, y + 78 + m * 15);
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = afford ? '#ffd94a' : '#667';
    ctx.fillText('◈ ' + items[i].price, x + cw / 2, y + chh - 22);
    ctx.textAlign = 'left';
  }
  CF.UI.centerText(ctx, '[1-4] buy    [ENTER] descend', H * 0.28 + chh + 46, 15, '#ffd94a');
};

/* ---------------- DEATH / WIN ---------------- */
CF.UI.drawDead = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  ctx.fillStyle = 'rgba(20,0,0,0.78)';
  ctx.fillRect(0, 0, W, H);
  CF.UI.centerText(ctx, 'YOU DIED', H * 0.32, 46, '#ff5a5a');
  CF.UI.centerText(ctx, 'the crypt keeps what it takes.', H * 0.32 + 40, 15, '#966');
  CF.UI.centerText(ctx, 'floor ' + game.floor + '   ·   ' + game.player.kills + ' kills   ·   ◈ ' + game.player.gold, H * 0.32 + 86, 17, '#b8c0d8');
  ctx.globalAlpha = Math.sin(CF.Engine.time * 3) * 0.25 + 0.75;
  CF.UI.centerText(ctx, '[ENTER] descend again', H * 0.32 + 150, 19, '#ffd94a');
  ctx.globalAlpha = 1;
  CF.UI.centerText(ctx, '[ESC] title', H * 0.32 + 186, 14, '#8890aa');
};

CF.UI.drawWin = function (ctx, game) {
  var W = CF.Engine.W, H = CF.Engine.H;
  var t = CF.Engine.time;
  ctx.fillStyle = 'rgba(4,3,8,0.85)';
  ctx.fillRect(0, 0, W, H);
  /* golden confetti */
  if (Math.random() < 0.5) {
    CF.Particles.spawn({
      x: CF.rand(0, W), y: -10, vx: CF.rand(-20, 20), vy: CF.rand(40, 120),
      life: CF.rand(2, 4), size: CF.rand(2, 4), color: CF.pick(['#ffd94a', '#7de8ff', '#d0a8ff']), glow: true, grav: 30
    });
  }
  CF.Particles.update(1 / 60);
  CF.Particles.render(ctx);
  CF.UI.centerText(ctx, 'THE CRYPT KING FALLS', H * 0.3, 40, '#ffd94a');
  CF.UI.centerText(ctx, 'you have beaten CRYPTFALL.', H * 0.3 + 44, 16, '#b8c0d8');
  CF.UI.centerText(ctx, game.player.kills + ' kills   ·   ◈ ' + game.player.gold + '   ·   level ' + game.player.level, H * 0.3 + 84, 17, '#e8e8ff');
  ctx.globalAlpha = Math.sin(t * 3) * 0.25 + 0.75;
  CF.UI.centerText(ctx, '[ENTER] keep descending — endless mode', H * 0.3 + 150, 19, '#7dff8a');
  ctx.globalAlpha = 1;
  CF.UI.centerText(ctx, '[ESC] title', H * 0.3 + 186, 14, '#8890aa');
};

/* ---------------- FATAL ERROR ---------------- */
CF.UI.drawFatal = function (ctx, err) {
  var W = CF.Engine.W || 800, H = CF.Engine.H || 600;
  ctx.fillStyle = '#100';
  ctx.fillRect(0, 0, W, H);
  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = '#ff5a5a';
  ctx.textAlign = 'center';
  ctx.fillText('CRYPTFALL crashed', W / 2, H / 2 - 40);
  ctx.font = '13px monospace';
  ctx.fillStyle = '#faa';
  var msg = String(err && err.message ? err.message : err).split('\n');
  for (var i = 0; i < msg.length; i++) ctx.fillText(msg[i], W / 2, H / 2 + i * 18);
  ctx.textAlign = 'left';
};
