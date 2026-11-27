/* ============================================================
 * ULTIMATE COOKING — js/ui.js
 * DOM UI: HUD, order ticket, meters, modals, tutorial, toasts.
 * ============================================================ */
(function () {
  'use strict';

  var UI = {};
  var UC = window.UC;

  /* ---------------- helpers ---------------- */
  function el(id) { return document.getElementById(id); }
  UI.el = el;
  function show(node) { node.classList.remove('hidden'); }
  function hide(node) { node.classList.add('hidden'); }

  /* ---------------- SVG ingredient icons ---------------- */
  function icon(id) {
    var c = '#' + UC.ING[id].color.toString(16).replace(/^((..)(..)(..))$/, function (m, a, r, g, b) {
      return '#' + r + g + b;
    });
    function svg(body) { return '<svg viewBox="0 0 24 24" width="22" height="22">' + body + '</svg>'; }
    switch (id) {
      case 'bun_bottom': case 'bun_top':
        return svg('<rect x="3" y="8" width="18" height="9" rx="4.5" fill="' + c + '"/><circle cx="9" cy="12" r="1" fill="#fff8"/><circle cx="14" cy="11" r="1" fill="#fff8"/><circle cx="12" cy="14" r="1" fill="#fff6"/>');
      case 'patty':
        return svg('<ellipse cx="12" cy="12" rx="9" ry="5" fill="' + c + '"/><ellipse cx="12" cy="10.5" rx="9" ry="4" fill="#a06a3f"/>');
      case 'lettuce':
        return svg('<path d="M3 14 Q5 8 8 11 Q10 6 13 10 Q16 6 18 11 Q20 9 21 14 Q12 18 3 14Z" fill="' + c + '"/>');
      case 'tomato':
        return svg('<circle cx="12" cy="13" r="8" fill="' + c + '"/><circle cx="12" cy="13" r="5" fill="#ff9a8c"/><circle cx="12" cy="13" r="1.5" fill="#ffd8cf"/>');
      case 'cheese': case 'cheese_p':
        return svg('<rect x="4" y="7" width="16" height="10" rx="2" transform="rotate(8 12 12)" fill="' + c + '"/><circle cx="10" cy="11" r="1.2" fill="#e8a40c"/><circle cx="15" cy="13" r="1.2" fill="#e8a40c"/>');
      case 'dough':
        return svg('<circle cx="12" cy="12" r="8.5" fill="' + c + '"/><circle cx="12" cy="12" r="8.5" fill="none" stroke="#d9a45e" stroke-width="1.6"/>');
      case 'sauce':
        return svg('<path d="M12 4 Q20 6 19 12 Q18 19 12 20 Q5 19 5 12 Q4 6 12 4Z" fill="' + c + '"/>');
      case 'pepperoni':
        return svg('<circle cx="12" cy="12" r="8" fill="' + c + '"/><circle cx="9" cy="10" r="1.1" fill="#f2a08c"/><circle cx="14" cy="9" r="1.1" fill="#f2a08c"/><circle cx="13" cy="14" r="1.1" fill="#f2a08c"/>');
      case 'mushroom':
        return svg('<path d="M4 12 Q4 5 12 5 Q20 5 20 12 Q12 14 4 12Z" fill="' + c + '"/><rect x="9.5" y="12" width="5" height="6" rx="1.5" fill="#efe3d0"/>');
      case 'pepper':
        return svg('<circle cx="12" cy="12" r="7" fill="none" stroke="' + c + '" stroke-width="3.4"/><circle cx="12" cy="12" r="2.4" fill="' + c + '"/>');
      case 'olive':
        return svg('<circle cx="8" cy="10" r="3.4" fill="' + c + '"/><circle cx="15" cy="14" r="3.4" fill="' + c + '"/><circle cx="8" cy="10" r="1.2" fill="#e8654a"/>');
      case 'nori':
        return svg('<rect x="4" y="6" width="16" height="12" rx="2" fill="' + c + '"/>');
      case 'rice':
        return svg('<path d="M12 5 Q19 7 18 13 Q16 19 12 19 Q8 19 6 13 Q5 7 12 5Z" fill="' + c + '"/><circle cx="10" cy="10" r="1" fill="#eee"/><circle cx="14" cy="12" r="1" fill="#eee"/>');
      case 'salmon':
        return svg('<path d="M4 12 Q8 6 15 7 Q20 8 21 12 Q20 16 15 17 Q8 18 4 12Z" fill="' + c + '"/><path d="M21 12 L17 9 M21 12 L17 15" stroke="' + c + '" stroke-width="1.6" fill="none"/><rect x="8" y="10.5" width="7" height="2" rx="1" fill="#ffe3d8"/>');
      case 'avocado':
        return svg('<path d="M12 4 Q19 8 17 14 Q15 20 12 20 Q9 20 7 14 Q5 8 12 4Z" fill="' + c + '"/><circle cx="12" cy="13" r="2.6" fill="#8a5a2a"/>');
      case 'cucumber':
        return svg('<circle cx="12" cy="12" r="8" fill="' + c + '"/><circle cx="12" cy="12" r="5" fill="#a8e0a0"/><circle cx="12" cy="12" r="1.6" fill="#eaffea"/>');
      case 'sponge':
        return svg('<rect x="4" y="7" width="16" height="11" rx="3" fill="' + c + '"/><rect x="4" y="13" width="16" height="5" rx="2" fill="#e8a45e"/>');
      case 'cream':
        return svg('<path d="M5 14 Q4 8 9 8 Q10 4 14 6 Q19 5 19 10 Q22 12 19 15 Q12 18 5 14Z" fill="' + c + '" stroke="#ead" stroke-width=".6"/>');
      case 'chocolate':
        return svg('<rect x="4" y="7" width="16" height="11" rx="2.5" fill="' + c + '"/><rect x="4" y="10" width="16" height="1.6" fill="#54341e"/>');
      case 'strawberry':
        return svg('<path d="M12 6 Q19 9 17 15 Q14 20 12 20 Q10 20 7 15 Q5 9 12 6Z" fill="' + c + '"/><path d="M9 5 L12 8 L15 5 Q13 3 9 5Z" fill="#7bc950"/>');
      case 'frosting':
        return svg('<path d="M12 4 Q17 5 17 9 Q21 11 18 14 Q19 18 15 18 Q13 21 10 18 Q6 19 7 15 Q4 12 8 10 Q8 5 12 4Z" fill="' + c + '"/>');
      case 'cherry':
        return svg('<path d="M13 4 Q16 6 15 9" stroke="#4a3222" stroke-width="1.6" fill="none"/><circle cx="12" cy="14" r="5" fill="' + c + '"/><circle cx="10.5" cy="12.5" r="1.3" fill="#ff9a9a"/>');
      default:
        return svg('<circle cx="12" cy="12" r="8" fill="' + c + '"/>');
    }
  }
  UI.icon = icon;

  function prepTag(prep) {
    if (prep === 'chop') return 'CHOP';
    if (prep === 'pchop') return 'SLICE';
    if (prep === 'cook') return 'COOK';
    if (prep === 'frost') return 'HOLD';
    return '';
  }

  /* ---------------- HUD ---------------- */
  UI.setHUD = function (save, rid, day) {
    el('hudCoins').textContent = save.coins;
    el('hudDay').textContent = 'Day ' + day;
    var stars = save.restaurants[rid].stars;
    el('hudStars').innerHTML = starRow(stars) ;
    el('hudRest').textContent = UC.RESTAURANTS[rid].name;
  };
  function starRow(n, hollow) {
    var s = '';
    for (var i = 0; i < 3; i++) {
      s += '<span class="star ' + (i < n ? 'on' : (hollow ? 'off' : '')) + '">★</span>';
    }
    return s;
  }
  UI.starRow = starRow;

  UI.coinBump = function (delta) {
    var pill = el('coinPill');
    pill.classList.remove('bump');
    void pill.offsetWidth;
    pill.classList.add('bump');
    if (delta) {
      var d = el('coinDelta');
      d.textContent = '+' + delta;
      d.classList.remove('show');
      void d.offsetWidth;
      d.classList.add('show');
    }
  };

  /* ---------------- order ticket ---------------- */
  var lastTicketKey = '';
  UI.syncTicket = function (st) {
    if (!st || !st.active) { hide(el('ticket')); lastTicketKey = ''; return; }
    var t = el('ticket');
    show(t);
    var cust = st.active;
    var order = cust.order;
    var key = cust.i + ':' + st.plate.expected + ':' + st.plate.mess;
    if (key === lastTicketKey) { return; }
    lastTicketKey = key;
    el('ticketName').textContent = cust.name + ' wants…';
    el('ticketOrder').textContent = orderName(st.rid, order.id);
    el('ticketPrice').textContent = '$' + order.price;
    var chips = el('ticketChips');
    chips.innerHTML = '';
    for (var i = 0; i < order.items.length; i++) {
      var id = order.items[i];
      var def = UC.ING[id];
      var chip = document.createElement('div');
      chip.className = 'chip' + (i < st.plate.expected ? ' done' : (i === st.plate.expected ? ' current' : ''));
      chip.innerHTML = icon(id) + (prepTag(def.prep) ? '<i>' + prepTag(def.prep) + '</i>' : '');
      chips.appendChild(chip);
    }
  };
  function orderName(rid, id) {
    var menu = UC.RESTAURANTS[rid].menu;
    for (var i = 0; i < menu.length; i++) if (menu[i].id === id) return menu[i].name || menu[i].id;
    return id;
  }
  UI.orderName = orderName;

  UI.ticketShake = function () {
    var t = el('ticket');
    t.classList.remove('shake');
    void t.offsetWidth;
    t.classList.add('shake');
  };

  /* ---------------- combo meter ---------------- */
  var lastComboLevel = 1;
  UI.comboSync = function (combo) {
    var wrap = el('comboWrap');
    if (combo.level <= 1 && combo.points === 0) { wrap.classList.remove('on'); lastComboLevel = 1; return; }
    wrap.classList.add('on');
    var lvl = combo.level;
    el('comboX').textContent = '×' + lvl;
    var need = lvl >= 5 ? 10 : [0, 2, 4, 6, 8][lvl];
    var prevNeed = lvl === 1 ? 0 : [0, 2, 4, 6, 8][lvl - 1];
    var frac = lvl >= 5 ? 1 : (combo.points - prevNeed) / (need - prevNeed);
    el('comboFill').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
    if (lvl !== lastComboLevel) {
      if (lvl > lastComboLevel) {
        var pill = el('comboPill');
        pill.classList.remove('pop');
        void pill.offsetWidth;
        pill.classList.add('pop');
      } else {
        pill = el('comboPill');
        pill.classList.remove('lost');
        void pill.offsetWidth;
        pill.classList.add('lost');
      }
      lastComboLevel = lvl;
    }
  };

  /* ---------------- patience bar (world-anchored) ---------------- */
  UI.patience = function (visible, frac, name, mood) {
    var p = el('patience');
    if (!visible) { hide(p); return; }
    show(p);
    var bar = el('patienceFill');
    bar.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
    bar.className = frac > 0.5 ? '' : (frac > 0.25 ? 'warn' : 'crit');
    el('patienceName').textContent = name;
  };

  /* ---------------- world-anchored meter positioning ---------------- */
  UI.place = function (id, sx, sy, visible) {
    var node = el(id);
    if (!visible) { hide(node); return null; }
    show(node);
    node.style.left = (sx * 100).toFixed(2) + '%';
    node.style.top = (sy * 100).toFixed(2) + '%';
    return node;
  };

  /* timing bar content: marker + green zone */
  UI.timingBar = function (id, pos, greenA, greenB) {
    var node = el(id);
    var zone = node.querySelector('.zone');
    var mark = node.querySelector('.mark');
    zone.style.left = (greenA * 100).toFixed(1) + '%';
    zone.style.width = ((greenB - greenA) * 100).toFixed(1) + '%';
    mark.style.left = 'calc(' + (Math.max(0, Math.min(1, pos)) * 100).toFixed(1) + '% - 7px)';
  };
  UI.progBar = function (id, frac, label) {
    var node = el(id);
    node.querySelector('.fill').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
    if (label !== undefined) {
      var lab = node.querySelector('.plabel');
      if (lab) lab.textContent = label;
    }
  };

  /* ---------------- toasts (pooled) ---------------- */
  var toasts = [], toastPtr = 0;
  UI.toast = function (text, cls, sx, sy) {
    var pool = el('toasts');
    if (toasts.length < 6) {
      for (var i = 0; i < 6; i++) {
        var d = document.createElement('div');
        d.className = 'toast';
        pool.appendChild(d);
        toasts.push(d);
      }
    }
    var t = toasts[toastPtr]; toastPtr = (toastPtr + 1) % toasts.length;
    t.textContent = text;
    t.className = 'toast ' + (cls || '') ;
    t.style.left = ((sx !== undefined ? sx : 0.5) * 100).toFixed(1) + '%';
    t.style.top = ((sy !== undefined ? sy : 0.35) * 100).toFixed(1) + '%';
    void t.offsetWidth;
    t.classList.add('go');
  };

  /* ---------------- steam fog overlay ---------------- */
  UI.steamFog = function (level) {
    var f = el('steamFog');
    f.style.opacity = Math.min(0.85, level * 0.22).toFixed(2);
  };

  /* ---------------- tutorial ---------------- */
  UI.tutShow = function (text, sx, sy, canSkip, onSkip) {
    var t = el('tutorial');
    show(t);
    el('tutText').textContent = text;
    var ring = el('tutRing');
    if (sx !== undefined && sx !== null) {
      ring.style.display = 'block';
      ring.style.left = (sx * 100).toFixed(1) + '%';
      ring.style.top = (sy * 100).toFixed(1) + '%';
    } else {
      ring.style.display = 'none';
    }
    var skip = el('tutSkip');
    skip.style.display = canSkip === false ? 'none' : 'block';
    skip.onclick = function (e) { e.stopPropagation(); if (onSkip) onSkip(); };
  };
  UI.tutHide = function () { hide(el('tutorial')); };

  /* ---------------- countdown ---------------- */
  UI.countdown = function (text, ms, cb) {
    var c = el('countdown');
    c.textContent = text;
    show(c);
    c.classList.remove('zoom');
    void c.offsetWidth;
    c.classList.add('zoom');
    setTimeout(function () { hide(c); if (cb) cb(); }, ms || 900);
  };

  /* ---------------- day end modal ---------------- */
  UI.dayEndShow = function (sum, onNext, onMap) {
    var m = el('dayEnd');
    show(m);
    m.querySelector('.de-title').textContent = 'Day ' + sum.day + ' complete!';
    el('deServed').textContent = sum.served + ' / ' + sum.total + ' served';
    el('deWalkouts').textContent = sum.walkouts === 0 ? 'no walkouts!' : sum.walkouts + ' walked out';
    /* coin count-up */
    var coinEl = el('deCoins');
    var target = sum.coins, shown = 0, t0 = Date.now();
    function step() {
      var k = Math.min(1, (Date.now() - t0) / 900);
      shown = Math.round(target * (1 - Math.pow(1 - k, 3)));
      coinEl.textContent = '$' + shown;
      if (k < 1) requestAnimationFrame(step);
    }
    step();
    /* stars spin in */
    var row = el('deStars');
    row.innerHTML = '';
    for (var i = 0; i < 3; i++) {
      (function (idx) {
        setTimeout(function () {
          var s = document.createElement('span');
          s.className = 'bigstar spin ' + (idx < sum.stars ? 'on' : 'off');
          s.textContent = '★';
          row.appendChild(s);
        }, 350 + idx * 380);
      })(i);
    }
    var btnNext = el('deNext'), btnMap = el('deMap');
    btnNext.textContent = sum.stars > 0 ? 'Next Day' : 'Retry Day';
    btnNext.onclick = function () { hide(m); onNext(); };
    btnMap.onclick = function () { hide(m); onMap(); };
  };

  /* ---------------- map screen ---------------- */
  UI.mapShow = function (save, handlers) {
    var m = el('mapScreen');
    show(m);
    el('mapTitle').textContent = 'ULTIMATE COOKING';
    el('mapCoins').textContent = save.coins;
    var total = UC.totalStars(save);
    el('mapStars').textContent = total + ' ★';
    var list = el('mapList');
    list.innerHTML = '';
    for (var r = 0; r < UC.RESTAURANTS.length; r++) {
      (function (rid) {
        var rest = UC.RESTAURANTS[rid];
        var unlocked = UC.isUnlocked(save, rid);
        var card = document.createElement('button');
        card.className = 'restCard' + (unlocked ? '' : ' locked');
        card.innerHTML =
          '<div class="rc-icon">' + restIcon(rid) + '</div>' +
          '<div class="rc-body"><b>' + rest.name + '</b><span>' + rest.tag + '</span>' +
          '<div class="rc-stars">' + starRow(save.restaurants[rid].stars % 3 || 0, true) +
          ' <i>' + save.restaurants[rid].stars + '★ total</i></div></div>' +
          (unlocked
            ? '<div class="rc-go">Day ' + save.restaurants[rid].day + '</div>'
            : '<div class="rc-lock">🔒<i>' + rest.unlockStars + '★ to unlock</i></div>');
        card.onclick = function () { if (unlocked) handlers.onPlay(rid); };
        list.appendChild(card);
      })(r);
    }
    el('mapShop').onclick = function () { handlers.onShop(); };
    el('mapMute').onclick = function () { handlers.onMute(); };
    el('mapReset').onclick = function () { handlers.onReset(); };
    UI.syncMute(save.muted);
  };
  UI.mapHide = function () { hide(el('mapScreen')); };

  function restIcon(rid) {
    var icons = ['🍔', '🍕', '🍣', '🍰'];
    return '<span>' + icons[rid] + '</span>';
  }

  UI.syncMute = function (muted) {
    el('mapMute').textContent = muted ? '🔇' : '🔊';
    el('hudMute').textContent = muted ? '🔇' : '🔊';
  };

  /* ---------------- shop ---------------- */
  var SHOP_ICONS = { knife: '🔪', burner: '🍳', shoes: '👟', cat: '🐱', goldplate: '🍽️', radio: '📻' };
  UI.shopShow = function (save, onBuy) {
    var m = el('shop');
    show(m);
    el('shopCoins').textContent = save.coins;
    var list = el('shopList');
    list.innerHTML = '';
    Object.keys(UC.UPGRADES).forEach(function (id) {
      var up = UC.UPGRADES[id];
      var level = save.upgrades[id];
      var maxed = UC.upgradeMaxed(id, level);
      var cost = UC.upgradeCost(id, level);
      var card = document.createElement('div');
      card.className = 'shopCard';
      var tierInfo = up.tiers.length > 1 ? ' <i>Lv ' + level + '/' + up.tiers.length + '</i>' : '';
      card.innerHTML =
        '<div class="sc-icon">' + SHOP_ICONS[id] + '</div>' +
        '<div class="sc-body"><b>' + up.name + tierInfo + '</b><span>' + up.desc + '</span></div>';
      var btn = document.createElement('button');
      if (maxed) { btn.className = 'sc-btn owned'; btn.textContent = 'OWNED'; btn.disabled = true; }
      else {
        btn.className = 'sc-btn' + (save.coins < cost ? ' poor' : '');
        btn.textContent = '$' + cost;
        btn.disabled = save.coins < cost;
        btn.onclick = function () { onBuy(id); };
      }
      card.appendChild(btn);
      list.appendChild(card);
    });
    el('shopClose').onclick = function () { hide(m); };
  };

  /* ---------------- confirm dialog ---------------- */
  UI.confirmShow = function (text, onYes, onNo) {
    var m = el('confirm');
    show(m);
    el('confirmText').textContent = text;
    el('confirmYes').onclick = function () { hide(m); if (onYes) onYes(); };
    el('confirmNo').onclick = function () { hide(m); if (onNo) onNo(); };
  };

  /* ---------------- pause menu ---------------- */
  UI.pauseShow = function (onMap, onResume) {
    var m = el('pause');
    show(m);
    el('pauseMap').onclick = function () { hide(m); onMap(); };
    el('pauseResume').onclick = function () { hide(m); onResume(); };
    el('pauseMute').onclick = null; /* set by game */
  };
  UI.pauseHide = function () { hide(el('pause')); };

  /* ---------------- unlock toast ---------------- */
  UI.unlockToast = function (rest) {
    var u = el('unlockToast');
    u.innerHTML = '🎉 New restaurant unlocked!<b>' + rest.name + '</b>';
    show(u);
    setTimeout(function () { hide(u); }, 2600);
  };

  window.UCUI = UI;
})();
