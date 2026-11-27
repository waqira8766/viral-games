/* DOPAMINE FACTORY — js/ui.js — DP.UI (DOM panels)
 * Builds ALL panels via JS into existing mounts (#hud-top, #quests,
 * #modal-root). NEVER edits index.html. Every tween / arc / wheel-angle /
 * queue / clamp lives in DP.UI.PURE (top) so `node js/ui.js` can test it
 * with no DOM. DOM code is fully guarded: missing mounts, shim documents,
 * absent DP.Content/Core/Wheel/Events never crash this file.
 *
 * ── API for game.js ──────────────────────────────────────────────────
 * DP.UI.init(handlers?)     build panels. handlers (all optional):
 *   { buy(id), spin(), claimQuest(i), ascend(), claimOffline(),
 *     toggleMute(), getQuests() }
 * DP.UI.attach(game)        store game ref (auto-attaches DP.Game too)
 * DP.UI.frame(dt)            optional; UI also self-animates via rAF
 * DP.UI.sync()               full refresh from attached game state
 * DP.UI.setCoins(total[,delta])       coin counter target (bump on gain)
 * DP.UI.setIncome(perSec)             "/sec" line
 * DP.UI.setQuests([{name,goal,progress,done,claimed}])
 * DP.UI.setDiscovered({tier:true}|[bool])
 * DP.UI.setWheelCooldown(remainMs[,totalMs])   HUD ring
 * DP.UI.wheelSpin({sector,revealMs,nearMiss})  animate DP.Wheel result
 * DP.UI.showOffline(gain)   DP.UI.setMuted(m)   DP.UI.toast(msg[,cls])
 * DP.UI.openShop/Wheel/Collection/Ascend()      DP.UI.closeAll()
 * Events consumed (bus optional): coins combo quest spend wheel discover
 * ascend load. UI only ever plays 'wheelTick' audio (one per crossing).
 */
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
DP.UI = {};

/* ================= PURE (no DOM; node-testable) ================= */
var PURE = DP.UI.PURE = {};
PURE.clamp01 = function (x) { return x < 0 ? 0 : (x > 1 ? 1 : x); };
PURE.pct = function (frac) { return (PURE.clamp01(frac) * 100).toFixed(1).replace(/\.0$/, '') + '%'; };

/* Count-up tween: exponential chase with a minimum linear crawl + snap.
 * Monotonic toward target, never overshoots, converges in finite frames. */
PURE.countUp = function (cur, target, dt, rate, minSpeed) {
  rate = rate || 9; if (minSpeed === undefined) minSpeed = 25;
  var d = target - cur;
  if (d === 0) return cur;
  var step = Math.abs(d) * Math.min(1, dt * rate);
  if (step < minSpeed * dt) step = minSpeed * dt;
  if (step >= Math.abs(d)) return target;
  return cur + (d > 0 ? step : -step);
};
PURE.easeOutQuart = function (t) { t = PURE.clamp01(t); return 1 - Math.pow(1 - t, 4); };

/* Combo meter math: mult x1.0->x3.0 maps to fill 0->1, hue cyan->magenta. */
PURE.comboFill = function (mult) { return PURE.clamp01((mult - 1) / 2); };
PURE.comboHue = function (mult) { return Math.round(185 + 145 * PURE.comboFill(mult)); };

/* SVG arc path for the cooldown ring: starts at 12 o'clock, sweeps
 * clockwise by frac of the circle. Returns {d, full}; frac is clamped. */
PURE.arcPath = function (cx, cy, r, frac) {
  var f = PURE.clamp01(frac);
  function P(x, y) { return (Math.round(x * 100) / 100) + ' ' + (Math.round(y * 100) / 100); }
  if (f <= 0.0005) return { d: '', full: false };
  var sx = cx, sy = cy - r;
  if (f >= 0.9995) return { d: 'M ' + P(sx, sy) + ' A ' + r + ' ' + r + ' 0 0 1 ' + P(cx, cy + r) +
    ' A ' + r + ' ' + r + ' 0 0 1 ' + P(sx, sy), full: true };
  var a = (-90 + f * 360) * Math.PI / 180;
  var la = f > 0.5 ? 1 : 0;
  return { d: 'M ' + P(sx, sy) + ' A ' + r + ' ' + r + ' 0 ' + la + ' 1 ' +
    P(cx + r * Math.cos(a), cy + r * Math.sin(a)), full: false };
};

/* Wheel math. Sector i of n spans [i*step,(i+1)*step) clockwise from the
 * top pointer; its center is (i+0.5)*step. To land it under the pointer
 * the wheel must rotate (360 - center) mod 360, plus whole turns, plus a
 * jitter safely inside the sector (max = step/2 - 6 deg). */
PURE.wheelCenter = function (i, n) { return (i + 0.5) * 360 / n; };
PURE.wheelTargetAngle = function (i, n, spins, jitterDeg) {
  var step = 360 / n;
  var maxJ = Math.max(0, step / 2 - 6);
  var j = (jitterDeg === undefined || jitterDeg === null) ? 0 :
    Math.max(-maxJ, Math.min(maxJ, jitterDeg));
  var norm = ((360 - PURE.wheelCenter(i, n)) % 360 + 360) % 360;
  return (spins || 0) * 360 + norm + j;
};
/* How many sector boundaries the pointer crosses from->to (forward only). */
PURE.ticksCrossed = function (fromDeg, toDeg, n) {
  var step = 360 / n;
  if (toDeg <= fromDeg) return 0;
  return Math.floor(toDeg / step) - Math.floor(fromDeg / step);
};

/* Toast queue: FIFO, hard cap (default 3), oldest dropped. Pure. */
PURE.TOAST_MAX = 3;
PURE.toastPush = function (queue, msg, max) {
  max = Math.max(1, (max | 0) || PURE.TOAST_MAX);
  var q = (queue || []).slice();
  q.push(String(msg));
  var dropped = 0;
  while (q.length > max) { q.shift(); dropped++; }
  return { queue: q, dropped: dropped };
};

/* fmt: prefer DP.Core.fmt (contract), else identical-shape fallback. */
var fmtFallback = function (n) {
  n = Math.floor(Number(n) || 0);
  if (n < 0) return '-' + fmtFallback(-n);
  if (n < 1000) return String(n);
  var u = ['K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx'], i = -1, v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  var s = (v >= 100) ? String(Math.floor(v)) : String(Math.round(v * 10) / 10);
  return s + u[i];
};
var fmt = function (n) {
  if (DP.Core && typeof DP.Core.fmt === 'function') { try { return DP.Core.fmt(n); } catch (e) {} }
  return fmtFallback(n);
};
PURE.fmt = fmt;

/* ============ canon fallbacks (used only if siblings are absent) ============ */
var FB_TIERS = 25;
var FB_NAMES = ['PEBBLE', 'STONE', 'GRANITE', 'GEODE', 'CRYSTAL', 'AMETHYST', 'EMERALD', 'RUBY',
  'SAPPHIRE', 'DIAMOND', 'STAR SHARD', 'NOVA', 'PULSAR', 'QUASAR', 'MAGNETAR', 'NEBULA',
  'SUPERNOVA', 'WHITE DWARF', 'NEUTRON STAR', 'BLACK HOLE', 'WORMHOLE', 'GALAXY', 'COSMOS',
  'ETERNITY', 'SINGULARITY'];
function tierNameOf(t) {
  if (DP.Content && typeof DP.Content.tierName === 'function') { try { return DP.Content.tierName(t); } catch (e) {} }
  return FB_NAMES[(t - 1 + FB_TIERS) % FB_TIERS] || FB_NAMES[0];
}
function tierColorOf(t) {
  if (DP.Content && typeof DP.Content.tierColor === 'function') { try { return DP.Content.tierColor(t); } catch (e) {} }
  var h = Math.round(280 - ((t - 1) % FB_TIERS) * 230 / (FB_TIERS - 1));
  return 'hsl(' + h + ',90%,62%)';
}
function coinValueOf(t) {
  if (DP.Content && typeof DP.Content.coinValue === 'function') { try { return DP.Content.coinValue(t); } catch (e) {} }
  return Math.round(10 * Math.pow(3.5, t - 1));
}
function upgradesList() {
  if (DP.Content && DP.Content.UPGRADES && DP.Content.UPGRADES.length) return DP.Content.UPGRADES;
  return [
    { id: 'tapPower', name: 'TAP POWER', desc: '+15% coin value / lvl', max: 999, base: 50 },
    { id: 'spawnRate', name: 'SPAWN RATE', desc: '-8% spawn interval / lvl', max: 25, base: 100 },
    { id: 'incomeMult', name: 'INCOME', desc: '+10% idle income / lvl', max: 999, base: 250 },
    { id: 'gridSize', name: 'GRID SIZE', desc: '5x5 -> 6x6 -> 7x7 board', max: 3, base: 2000 },
    { id: 'luckyChance', name: 'LUCKY CUBES', desc: '+1.5% lucky chance / lvl', max: 20, base: 750 },
    { id: 'chainPower', name: 'CHAIN POWER', desc: '+1 chain cube / lvl', max: 10, base: 1500 }
  ];
}
function costOf(u, lvl) {
  if (DP.Content && typeof DP.Content.upgradeCost === 'function') { try { return DP.Content.upgradeCost(u.id, lvl); } catch (e) {} }
  if (typeof u.cost === 'function') { try { return u.cost(lvl); } catch (e) {} }
  return Math.round((u.base || 10) * Math.pow(1.35, lvl));
}
function prestigeMultOf(n) {
  if (DP.Content && typeof DP.Content.prestigeMult === 'function') { try { return DP.Content.prestigeMult(n); } catch (e) {} }
  return 1 + 0.5 * (n || 0);
}
function discoverBonusOf(count) {
  if (DP.Content && typeof DP.Content.discoverBonus === 'function') { try { return DP.Content.discoverBonus(count); } catch (e) {} }
  return Math.pow(1.02, count || 0);
}
/* Wheel sector order: DP.Wheel.SECTORS when present, else canon-shaped
 * fallback — weights sum 100, dud adjacent to jackpot (near-miss by design). */
function wheelSectors() {
  if (DP.Wheel && DP.Wheel.SECTORS && DP.Wheel.SECTORS.length) return DP.Wheel.SECTORS;
  return [
    { id: 'coins', label: 'COINS +', weight: 25, color: '#ffd166' },
    { id: 'income', label: 'INCOME x2', weight: 15, color: '#22d3ee' },
    { id: 'lucky', label: 'LUCKY RAIN', weight: 12, color: '#f472d0' },
    { id: 'dud', label: 'SO CLOSE!', weight: 10, color: '#454a63' },
    { id: 'jackpot', label: 'JACKPOT', weight: 5, color: '#ffe14a' },
    { id: 'merge', label: 'MERGE UP', weight: 10, color: '#7dff8a' },
    { id: 'coins2', label: 'COINS ++', weight: 15, color: '#ffc24a' },
    { id: 'reroll', label: 'REROLL', weight: 8, color: '#a78bfa' }
  ];
}

/* ================= DOM (guarded; no-ops headless) ================= */
var S = { built: false, shown: 0, target: 0, lastCoinTxt: '', lastBump: 0,
  comboFillShown: 0, comboMultShown: 1, comboIdle: 99, lastComboCount: 0,
  wheelRemain: 0, wheelTotal: 60000, lastRingFrac: -1, lastSubTxt: '',
  wheelAngle: 0, wheelTurns: 0, lastWheelDeg: -1e9, anim: null, spinning: false,
  muted: false, lifetime: 0, ascensions: 0, canAscend: false,
  discovered: {}, quests: null, toastQ: [], upLevels: {},
  game: null, handlers: {}, modal: null, questEls: [], shopRefs: [], colRefs: [],
  hudRefs: {}, wheelRefs: {}, ascRefs: {}, toastHost: null };

function hasDOM() { return typeof document !== 'undefined' && document && typeof document.getElementById === 'function'; }
function $id(id) { try { return document.getElementById(id); } catch (e) { return null; } }
function el(tag, cls, parent) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent && parent.appendChild) parent.appendChild(n);
  return n;
}
function retrigger(node, cls) { /* restart a CSS animation class */
  if (!node || !node.classList) return;
  node.classList.remove(cls);
  try { void node.offsetWidth; } catch (e) {}
  node.classList.add(cls);
}
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
function onEvt(name, fn) { if (typeof DP.Events !== 'undefined' && DP.Events && typeof DP.Events.on === 'function') DP.Events.on(name, fn); }
function txt(node, s) { if (node && node.textContent !== s) node.textContent = s; }

var CSS = ''
+ '.dp-hud{display:flex;flex-direction:column;gap:7px;padding:10px 10px 0;max-width:600px;margin:0 auto;font-family:\'Courier New\',monospace}'
+ '.dp-hud-row{display:flex;gap:8px;align-items:stretch;justify-content:center;flex-wrap:wrap}'
+ '.dp-coin-box{display:flex;align-items:center;gap:10px;padding:6px 14px 6px 10px;border-radius:14px;background:rgba(13,10,34,.88);border:1px solid rgba(255,255,255,.1);box-shadow:0 6px 24px rgba(0,0,0,.35)}.dp-bump{animation:dp-bump .28s cubic-bezier(.34,1.56,.64,1)}'
+ '.dp-coin-ico{width:30px;height:30px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#fff2c4 0%,#ffd166 42%,#c98a1b 100%);box-shadow:0 0 14px rgba(255,209,102,.55),inset 0 -3px 6px rgba(120,70,0,.4);animation:dp-coin-pulse 2.4s ease-in-out infinite;flex:none}'
+ '.dp-coins{font-size:22px;font-weight:bold;color:#ffd166;text-shadow:0 0 16px rgba(255,209,102,.45);line-height:1;letter-spacing:.02em}.dp-income{font-size:11px;color:#9aa0c8;margin-top:3px}'
+ '.dp-combo{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:14px;background:rgba(13,10,34,.88);border:1px solid rgba(255,255,255,.1);min-width:132px}.dp-combo.dp-max{border-color:rgba(232,121,249,.6);box-shadow:0 0 18px rgba(232,121,249,.35)}'
+ '.dp-combo-bar{flex:1;height:10px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}.dp-combo-fill{height:100%;width:0%;border-radius:999px;background:#22d3ee;box-shadow:0 0 10px rgba(34,211,238,.7);transition:width .25s cubic-bezier(.25,1,.4,1)}'
+ '.dp-combo-mult{font-size:13px;font-weight:bold;color:#e8e8f0;min-width:38px;text-align:right}.dp-pulse{animation:dp-pulse .3s cubic-bezier(.34,1.56,.64,1)}'
+ '.dp-btn{position:relative;min-height:48px;min-width:48px;padding:0 14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:linear-gradient(180deg,rgba(44,34,88,.95),rgba(20,14,50,.95));color:#e8e8f0;font:bold 12px \'Courier New\',monospace;letter-spacing:.08em;cursor:pointer;transition:transform .16s cubic-bezier(.34,1.56,.64,1),box-shadow .25s,border-color .25s,opacity .25s;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}'
+ '.dp-btn:active{transform:translateY(2px) scale(.95)}.dp-btn:disabled{opacity:.45;cursor:default}.dp-btn-sub{font-size:9px;font-weight:normal;color:#9aa0c8;letter-spacing:.04em}.dp-btn-shop{color:#ffd166;border-color:rgba(255,209,102,.35)}'
+ '.dp-btn-wheel{min-width:64px;overflow:visible}.dp-ring{position:absolute;inset:1px;pointer-events:none}.dp-ring path{fill:none;stroke:#ffd166;stroke-width:3.4;stroke-linecap:round;filter:drop-shadow(0 0 4px rgba(255,209,102,.7))}'
+ '.dp-btn-wheel.dp-ready{border-color:#ffd166;box-shadow:0 0 16px rgba(255,209,102,.35);animation:dp-ready 1.6s ease-in-out infinite}.dp-btn-ascend{color:#e879f9;border-color:rgba(232,121,249,.3)}.dp-btn-ascend.dp-glow{border-color:#e879f9;animation:dp-glow 1.4s ease-in-out infinite}.dp-btn-muted .dp-btn-label{text-decoration:line-through;opacity:.5}'
+ '.dp-quests{display:flex;gap:8px;padding:10px 10px calc(12px + env(safe-area-inset-bottom,0px));max-width:600px;margin:0 auto;left:0;right:0}'
+ '.dp-quest{flex:1;min-width:0;min-height:56px;position:relative;overflow:hidden;border-radius:12px;background:rgba(13,10,34,.92);border:1px solid rgba(255,255,255,.08);cursor:pointer;text-align:left;padding:7px 9px;color:#e8e8f0;font-family:\'Courier New\',monospace;transition:transform .18s cubic-bezier(.34,1.56,.64,1),border-color .25s}.dp-quest:active{transform:translateY(2px) scale(.97)}'
+ '.dp-quest-fill{position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,rgba(34,211,238,.14),rgba(167,139,250,.22));transition:width .35s cubic-bezier(.25,1,.4,1)}'
+ '.dp-quest-top{position:relative;display:flex;justify-content:space-between;gap:6px;align-items:baseline}.dp-quest-name{font-size:10px;font-weight:bold;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dp-quest-count{font-size:10px;color:#9aa0c8;flex:none}'
+ '.dp-quest-bar{position:relative;margin-top:6px;height:5px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}.dp-quest-barfill{height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#22d3ee,#a78bfa);transition:width .35s cubic-bezier(.25,1,.4,1)}'
+ '.dp-quest-shine{position:absolute;top:0;bottom:0;width:34%;left:0;transform:translateX(-160%) skewX(-18deg);background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);display:none}'
+ '.dp-quest.dp-done{border-color:rgba(255,209,102,.65);box-shadow:0 0 16px rgba(255,209,102,.22)}.dp-quest.dp-done .dp-quest-shine{display:block;animation:dp-shine 1.5s ease-in-out infinite}.dp-quest.dp-done .dp-quest-count{color:#ffd166;font-weight:bold}'
+ '.dp-toasts{position:fixed;top:112px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;align-items:center;z-index:70;pointer-events:none;width:max-content;max-width:88vw}'
+ '.dp-toast{padding:10px 18px;border-radius:999px;background:rgba(13,10,34,.95);border:1px solid rgba(255,255,255,.16);color:#e8e8f0;font:bold 12px \'Courier New\',monospace;letter-spacing:.05em;box-shadow:0 10px 30px rgba(0,0,0,.5);animation:dp-toast-in .34s cubic-bezier(.34,1.56,.64,1);transition:opacity .26s ease,transform .26s ease;max-width:88vw;text-align:center}.dp-toast.dp-out{opacity:0;transform:translateY(-14px) scale(.92)}'
+ '.dp-toast.gold{border-color:#ffd166;color:#ffd166;box-shadow:0 0 26px rgba(255,209,102,.3)}.dp-toast.cyan{border-color:#22d3ee;color:#8ee9fb}.dp-toast.green{border-color:#7dff8a;color:#a5f5ae}.dp-toast.red{border-color:#ff5a7a;color:#ff9aab}'
+ '.dp-backdrop{position:fixed;inset:0;z-index:55;background:rgba(5,3,16,.6);backdrop-filter:blur(10px) saturate(1.2);-webkit-backdrop-filter:blur(10px) saturate(1.2);display:flex;align-items:center;justify-content:center;padding:18px;animation:dp-fade-in .22s ease-out}.dp-backdrop.dp-out{animation:dp-fade-out .19s ease-in forwards;pointer-events:none}'
+ '.dp-modal{position:relative;width:min(92vw,440px);max-height:min(82vh,720px);overflow:hidden auto;border-radius:18px;background:linear-gradient(180deg,rgba(22,15,50,.97),rgba(9,6,26,.97));border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 80px rgba(0,0,0,.6),0 0 60px rgba(90,60,220,.12);animation:dp-spring-in .42s cubic-bezier(.34,1.56,.64,1);display:flex;flex-direction:column;font-family:\'Courier New\',monospace}.dp-backdrop.dp-out .dp-modal{animation:dp-spring-out .19s ease-in forwards}'
+ '.dp-x{position:absolute;top:8px;right:8px;width:48px;height:48px;border-radius:12px;background:transparent;border:none;color:#8890aa;font-size:17px;cursor:pointer;transition:transform .18s,color .18s;z-index:2}.dp-x:active{transform:scale(.85)}'
+ '.dp-title{text-align:center;padding:18px 56px 4px;font-size:16px;font-weight:bold;letter-spacing:.2em;color:#e8e8f0;text-shadow:0 0 18px rgba(140,120,255,.55)}.dp-title::after{content:"";display:block;width:56px;height:2px;margin:7px auto 0;border-radius:2px;background:linear-gradient(90deg,transparent,#ffd166,transparent)}'
+ '.dp-modal-body{overflow-y:auto;padding-bottom:6px}'
+ '.dp-shop-bal{text-align:center;font-size:12px;color:#9aa0c8;padding:6px 12px 2px}.dp-shop-bal b{color:#ffd166}'
+ '.dp-shop-row{display:flex;align-items:center;gap:12px;margin:8px 12px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}.dp-shop-info{flex:1;min-width:0}'
+ '.dp-shop-name{font-size:13px;font-weight:bold;color:#e8e8f0;letter-spacing:.04em}.dp-shop-name small{color:#a78bfa;font-size:10px;margin-left:6px}.dp-shop-desc{font-size:10.5px;color:#9aa0c8;margin-top:3px;line-height:1.35}.dp-shop-eff{font-size:10.5px;color:#ffd166;margin-top:2px}'
+ '.dp-buy{flex:none;min-width:96px;min-height:48px;border-radius:12px;border:none;background:linear-gradient(180deg,#ffe08a,#ffb84a);color:#241a00;font:bold 13px \'Courier New\',monospace;cursor:pointer;box-shadow:0 4px 18px rgba(255,190,70,.35);transition:transform .14s cubic-bezier(.34,1.56,.64,1),box-shadow .2s,filter .2s}'
+ '.dp-buy:active{transform:translateY(3px) scale(.95);box-shadow:0 1px 6px rgba(255,190,70,.2)}.dp-buy.dp-broke{background:rgba(255,255,255,.06);color:#6d7290;border:1px solid rgba(255,255,255,.08);box-shadow:none;cursor:default;filter:none}.dp-buy.dp-broke:active{transform:none}'
+ '.dp-wheel-wrap{position:relative;width:min(74vw,300px);height:min(74vw,300px);margin:10px auto 6px;flex:none}'
+ '.dp-wheel{position:absolute;inset:0;border-radius:50%;border:4px solid #2a2050;box-shadow:0 0 44px rgba(120,90,255,.28),inset 0 0 34px rgba(0,0,0,.45);will-change:transform}.dp-wheel-label{position:absolute;left:50%;top:50%;font:bold 10px \'Courier New\',monospace;letter-spacing:.04em;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.85)}'
+ '.dp-wheel-hub{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:radial-gradient(circle at 38% 32%,#3b2f78,#0b0820 70%);border:2px solid #4a3f8f;box-shadow:0 0 14px rgba(120,90,255,.5)}'
+ '.dp-wheel-pointer{position:absolute;top:-13px;left:50%;width:0;height:0;margin-left:-11px;border-left:11px solid transparent;border-right:11px solid transparent;border-top:18px solid #ffd166;transform-origin:50% 18px;filter:drop-shadow(0 0 6px rgba(255,209,102,.8));z-index:2}.dp-wheel-pointer.dp-wobble{animation:dp-wobble .7s cubic-bezier(.34,1.56,.64,1)}'
+ '.dp-wheel-banner{min-height:30px;text-align:center;font:bold 14px \'Courier New\',monospace;letter-spacing:.08em;color:#e8e8f0;padding:2px 12px 0}.dp-wheel-banner.dp-hit{color:#ffd166;text-shadow:0 0 14px rgba(255,209,102,.6);animation:dp-banner-pop .4s cubic-bezier(.34,1.56,.64,1)}.dp-wheel-banner.dp-miss{color:#ff5a7a;animation:dp-shake .45s ease-in-out}.dp-wheel-cd{text-align:center;font-size:11px;color:#9aa0c8;padding:2px 0 2px}'
+ '.dp-spin-btn{display:block;margin:8px auto 12px;min-width:180px;min-height:52px;border-radius:14px;border:none;background:linear-gradient(180deg,#ffe08a,#ffb84a);color:#241a00;font:bold 15px \'Courier New\',monospace;letter-spacing:.14em;cursor:pointer;box-shadow:0 6px 24px rgba(255,190,70,.4);transition:transform .15s cubic-bezier(.34,1.56,.64,1),opacity .2s,filter .2s}'
+ '.dp-spin-btn:active{transform:translateY(3px) scale(.96)}.dp-spin-btn:disabled{opacity:.45;cursor:default;filter:grayscale(.6)}'
+ '.dp-col-stats{text-align:center;font-size:11.5px;color:#9aa0c8;padding:4px 12px 0}.dp-col-stats b{color:#7dff8a}#dp-colgrid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:12px}'
+ '.dp-cell{position:relative;min-height:88px;border-radius:10px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;cursor:pointer;transition:transform .16s cubic-bezier(.34,1.56,.64,1),border-color .2s}.dp-cell:active{transform:scale(.92)}.dp-cube{width:26px;height:26px;border-radius:7px;flex:none}'
+ '.dp-cell.dp-found{border-color:rgba(255,255,255,.18)}.dp-cell.dp-found .dp-cube{box-shadow:0 0 12px rgba(255,255,255,.25),inset 0 -4px 8px rgba(0,0,0,.35)}'
+ '.dp-cell-name{font-size:8.5px;font-weight:bold;color:#e8e8f0;text-align:center;letter-spacing:.02em;line-height:1.15;padding:0 2px}.dp-cell-val{font-size:8.5px;color:#ffd166}'
+ '.dp-cell.dp-locked .dp-cube{background:#14102c;border:1px dashed #2c2650}.dp-cell.dp-locked .dp-cell-name{color:#444a66}.dp-cell.dp-locked .dp-cell-val{color:#33385a}'
+ '.dp-asc-big{text-align:center;font:bold 30px \'Courier New\',monospace;color:#ffd166;text-shadow:0 0 22px rgba(255,209,102,.55);padding:14px 12px 2px}.dp-asc-note{text-align:center;font-size:11px;color:#9aa0c8;padding:2px 12px;line-height:1.5}'
+ '.dp-asc-warn{margin:10px 14px 4px;padding:9px 12px;border-radius:10px;border:1px solid rgba(255,90,122,.4);background:rgba(255,90,122,.08);color:#ff9aab;font-size:10.5px;line-height:1.5;text-align:center}'
+ '.dp-asc-bar{margin:10px 16px 2px;height:8px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}.dp-asc-barfill{height:100%;width:0%;background:linear-gradient(90deg,#e879f9,#ffd166);border-radius:999px;transition:width .4s cubic-bezier(.25,1,.4,1)}'
+ '.dp-modal-actions{display:flex;gap:10px;padding:12px 14px 16px}.dp-modal-actions .dp-btn{flex:1;min-height:52px;font-size:13px}.dp-btn-confirm{border:none;background:linear-gradient(180deg,#ffe08a,#ffb84a);color:#241a00;box-shadow:0 4px 18px rgba(255,190,70,.35)}'
+ '.dp-off-big{text-align:center;font:bold 26px \'Courier New\',monospace;color:#ffd166;text-shadow:0 0 20px rgba(255,209,102,.5);padding:16px 12px 4px}'
+ '@keyframes dp-bump{0%{transform:scale(1)}35%{transform:scale(1.16)}100%{transform:scale(1)}}@keyframes dp-pulse{0%{transform:scale(1)}40%{transform:scale(1.1)}100%{transform:scale(1)}}'
+ '@keyframes dp-glow{0%,100%{box-shadow:0 0 8px rgba(232,121,249,.3)}50%{box-shadow:0 0 22px rgba(232,121,249,.8)}}@keyframes dp-ready{0%,100%{box-shadow:0 0 8px rgba(255,209,102,.25)}50%{box-shadow:0 0 20px rgba(255,209,102,.6)}}'
+ '@keyframes dp-coin-pulse{0%,100%{box-shadow:0 0 10px rgba(255,209,102,.4),inset 0 -3px 6px rgba(120,70,0,.4)}50%{box-shadow:0 0 18px rgba(255,209,102,.75),inset 0 -3px 6px rgba(120,70,0,.4)}}@keyframes dp-shine{0%{transform:translateX(-160%) skewX(-18deg)}100%{transform:translateX(420%) skewX(-18deg)}}'
+ '@keyframes dp-spring-in{0%{opacity:0;transform:translateY(28px) scale(.85)}55%{opacity:1;transform:translateY(-4px) scale(1.03)}100%{transform:translateY(0) scale(1)}}@keyframes dp-spring-out{to{opacity:0;transform:translateY(14px) scale(.94)}}'
+ '@keyframes dp-fade-in{from{opacity:0}to{opacity:1}}@keyframes dp-fade-out{to{opacity:0}}@keyframes dp-toast-in{0%{opacity:0;transform:translateY(-18px) scale(.88)}60%{opacity:1;transform:translateY(3px) scale(1.03)}100%{transform:translateY(0) scale(1)}}'
+ '@keyframes dp-wobble{0%{transform:rotate(0)}25%{transform:rotate(-10deg)}50%{transform:rotate(7deg)}75%{transform:rotate(-3deg)}100%{transform:rotate(0)}}@keyframes dp-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}'
+ '@keyframes dp-banner-pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.07);opacity:1}100%{transform:scale(1)}}'
+ '@media (max-width:430px){.dp-hud{padding:8px 8px 0;gap:6px}.dp-coins{font-size:19px}.dp-combo{min-width:112px;padding:7px 10px}.dp-btn{padding:0 10px}.dp-quest-name{font-size:9px}}'
+ '@media (max-height:520px){.dp-hud{padding:6px 8px 0;gap:5px}.dp-coin-ico{width:24px;height:24px}.dp-quests{padding-top:7px;padding-bottom:9px}.dp-quest{min-height:50px}}';

function injectStyle() {
  if ($id('dp-ui-css')) return;
  var st = document.createElement('style');
  st.id = 'dp-ui-css';
  st.textContent = CSS;
  (document.head || document.documentElement || document.body).appendChild(st);
}

/* ---------- build: top HUD ---------- */
function buildHud() {
  var mount = $id('hud-top'); if (!mount) return;
  var hud = el('div', 'dp-hud', mount);
  var row1 = el('div', 'dp-hud-row', hud);
  S.hudRefs.coinBox = el('div', 'dp-coin-box dp-bumpable', row1);
  el('div', 'dp-coin-ico', S.hudRefs.coinBox);
  var cw = el('div', '', S.hudRefs.coinBox);
  S.hudRefs.coinEl = el('div', 'dp-coins', cw); txt(S.hudRefs.coinEl, '0');
  S.hudRefs.incomeEl = el('div', 'dp-income', cw); txt(S.hudRefs.incomeEl, '+0/sec');
  var combo = el('div', 'dp-combo', row1);
  S.hudRefs.combo = combo;
  S.hudRefs.comboFillEl = el('div', 'dp-combo-fill', el('div', 'dp-combo-bar', combo));
  S.hudRefs.comboMultEl = el('div', 'dp-combo-mult', combo); txt(S.hudRefs.comboMultEl, 'x1.0');
  var row2 = el('div', 'dp-hud-row', hud);
  mkBtn(row2, 'dp-btn dp-btn-shop', 'SHOP', null, function () { DP.UI.openShop(); });
  var wb = mkBtn(row2, 'dp-btn dp-btn-wheel', 'WHEEL', 'FREE', function () { DP.UI.openWheel(); });
  S.hudRefs.wheelBtn = wb;
  try {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'dp-ring'); svg.setAttribute('viewBox', '0 0 52 52');
    S.hudRefs.ringPath = document.createElementNS(ns, 'path');
    svg.appendChild(S.hudRefs.ringPath); wb.appendChild(svg);
  } catch (e) { S.hudRefs.ringPath = null; }
  mkBtn(row2, 'dp-btn', 'DEX', 'COLLECTION', function () { DP.UI.openCollection(); });
  var ab = mkBtn(row2, 'dp-btn dp-btn-ascend', 'ASCEND', 'LOCKED', function () { DP.UI.openAscend(); });
  ab.disabled = true; S.hudRefs.ascendBtn = ab;
  var mb = mkBtn(row2, 'dp-btn dp-btn-mute', 'SOUND', 'ON', function () {
    if (typeof S.handlers.toggleMute === 'function') S.handlers.toggleMute();
    else DP.UI.setMuted(!S.muted);
  });
  S.hudRefs.muteBtn = mb;
}
function mkBtn(parent, cls, label, sub, onClick) {
  var b = el('button', cls, parent);
  el('span', 'dp-btn-label', b).textContent = label;
  var s = el('span', 'dp-btn-sub', b);
  if (sub) s.textContent = sub;
  b.addEventListener('click', function () { try { onClick(); } catch (e) {} });
  b._sub = s;
  return b;
}

/* ---------- build: quest strip ---------- */
function buildQuests() {
  var mount = $id('quests'); if (!mount) return;
  var row = el('div', 'dp-quests', mount);
  for (var i = 0; i < 3; i++) {
    (function (idx) {
      var chip = el('button', 'dp-quest', row);
      var f = el('div', 'dp-quest-fill', chip), top = el('div', 'dp-quest-top', chip);
      var nm = el('span', 'dp-quest-name', top); txt(nm, 'LOADING...');
      var ct = el('span', 'dp-quest-count', top);
      var bf = el('div', 'dp-quest-barfill', el('div', 'dp-quest-bar', chip));
      el('div', 'dp-quest-shine', chip);
      chip.addEventListener('click', function () {
        var q = S.quests && S.quests[idx];
        if (q && (q.done || (q.progress || 0) >= (q.goal || 1)) && typeof S.handlers.claimQuest === 'function') {
          try { S.handlers.claimQuest(idx); } catch (e) {}
        }
      });
      S.questEls.push({ chip: chip, fill: f, name: nm, count: ct, barfill: bf, lastFill: -1 });
    })(i);
  }
}
function renderQuests() {
  var list = S.quests || [];
  for (var i = 0; i < S.questEls.length; i++) {
    var r = S.questEls[i], q = list[i];
    if (!q) { r.chip.style.display = 'none'; continue; }
    r.chip.style.display = '';
    var goal = Math.max(1, q.goal || q.target || 1), prog = Math.max(0, q.progress || 0);
    var done = !!(q.done || q.claimed || prog >= goal), f = PURE.clamp01(prog / goal);
    txt(r.name, q.name || q.label || 'QUEST');
    txt(r.count, done ? 'CLAIM!' : Math.min(Math.ceil(prog), goal) + '/' + goal);
    r.fill.style.width = PURE.pct(f); r.barfill.style.width = PURE.pct(f);
    if (r.chip.classList) { if (done) r.chip.classList.add('dp-done'); else r.chip.classList.remove('dp-done'); }
    if (f > r.lastFill + 0.0001 && r.lastFill >= 0) retrigger(r.chip, 'dp-pulse');
    r.lastFill = f;
  }
}

/* ---------- build: toast stack ---------- */
function buildToasts() {
  var mount = $id('modal-root'); if (!mount) return;
  S.toastHost = el('div', 'dp-toasts', mount);
}
DP.UI.toast = function (msg, cls) {
  var out = PURE.toastPush(S.toastQ, msg, PURE.TOAST_MAX);
  S.toastQ = out.queue;
  if (!S.toastHost) return;
  var dropped = out.dropped;
  while (dropped-- > 0 && S.toastHost.firstChild) S.toastHost.removeChild(S.toastHost.firstChild);
  var t = el('div', 'dp-toast' + (cls ? ' ' + cls : ''), S.toastHost);
  txt(t, msg);
  if (typeof setTimeout !== 'function') return;
  setTimeout(function () {
    if (t.classList) t.classList.add('dp-out');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 280);
  }, 2700);
};

/* ---------- modal framework ---------- */
function openModal(kind, title, builder) {
  if (!hasDOM()) return null;
  closeAll(true);
  var root = $id('modal-root'); if (!root) return null;
  var bd = el('div', 'dp-backdrop', root);
  var m = el('div', 'dp-modal', bd);
  var x = el('button', 'dp-x', m); x.textContent = '\u2715';
  x.addEventListener('click', function () { closeAll(); });
  var h = el('div', 'dp-title', m); txt(h, title);
  var body = el('div', 'dp-modal-body', m);
  bd.addEventListener('click', function (e) { if (e.target === bd) closeAll(); });
  S.modal = { bd: bd, kind: kind };
  if (builder) { try { builder(body); } catch (e) { if (typeof console !== 'undefined') console.warn('[DP.UI]', e); } }
  return body;
}
function closeAll(instant) {
  var mo = S.modal; S.modal = null;
  if (!mo || !mo.bd || !mo.bd.parentNode) return;
  if (instant) { mo.bd.parentNode.removeChild(mo.bd); return; }
  if (mo.bd.classList) mo.bd.classList.add('dp-out');
  setTimeout(function () { if (mo.bd && mo.bd.parentNode) mo.bd.parentNode.removeChild(mo.bd); }, 200);
}

/* ---------- HUD writers (cached; zero alloc per frame when idle) ---------- */
function writeCoins() {
  var s = fmt(S.shown);
  if (s !== S.lastCoinTxt) { S.lastCoinTxt = s; txt(S.hudRefs.coinEl, s); }
}
function bumpCoins() {
  var t = nowMs();
  if (t - S.lastBump < 90 || !S.hudRefs.coinBox) return;
  S.lastBump = t;
  retrigger(S.hudRefs.coinBox, 'dp-bump');
}
function writeCombo() {
  var f = PURE.clamp01(S.comboFillShown);
  var fill = S.hudRefs.comboFillEl;
  if (fill) {
    fill.style.width = PURE.pct(f);
    fill.style.background = 'hsl(' + PURE.comboHue(1 + 2 * f) + ',95%,60%)';
  }
  txt(S.hudRefs.comboMultEl, 'x' + (1 + 2 * f).toFixed(1));
  if (S.hudRefs.combo && S.hudRefs.combo.classList) {
    if (f >= 1) S.hudRefs.combo.classList.add('dp-max'); else S.hudRefs.combo.classList.remove('dp-max');
  }
}
function writeRing() {
  var frac = S.wheelTotal > 0 ? PURE.clamp01(S.wheelRemain / S.wheelTotal) : 0;
  var r = Math.round(frac * 100) / 100;
  if (r !== S.lastRingFrac && S.hudRefs.ringPath) {
    S.lastRingFrac = r;
    try { S.hudRefs.ringPath.setAttribute('d', PURE.arcPath(26, 26, 23, frac).d); } catch (e) {}
  }
  var sub = S.wheelRemain > 0 ? Math.ceil(S.wheelRemain / 1000) + 's' : 'FREE';
  if (sub !== S.lastSubTxt) {
    S.lastSubTxt = sub;
    if (S.hudRefs.wheelBtn && S.hudRefs.wheelBtn._sub) txt(S.hudRefs.wheelBtn._sub, sub);
    if (S.hudRefs.wheelBtn && S.hudRefs.wheelBtn.classList) {
      if (S.wheelRemain > 0) S.hudRefs.wheelBtn.classList.remove('dp-ready');
      else S.hudRefs.wheelBtn.classList.add('dp-ready');
    }
  }
}
function refreshAscendBtn() {
  var b = S.hudRefs.ascendBtn; if (!b) return;
  b.disabled = !S.canAscend;
  if (b.classList) { if (S.canAscend) b.classList.add('dp-glow'); else b.classList.remove('dp-glow'); }
  if (b._sub) txt(b._sub, S.canAscend ? 'x' + Math.round(prestigeMultOf(S.ascensions + 1) * 100) / 100 : Math.min(100, Math.floor(S.lifetime / 10000)) + '%');
}

/* ---------- SHOP ---------- */
function shopLevel(id) {
  var st = S.game && S.game.state;
  if (st && st.upgrades && st.upgrades[id] !== undefined) return st.upgrades[id] || 0;
  return S.upLevels[id] || 0;
}
function refreshShop() {
  var bal = S.modal && S.modal.kind === 'shop' && S.shopRefs.length;
  if (S.hudRefs.balEl) txt(S.hudRefs.balEl, fmt(S.target));
  if (!bal) return;
  for (var i = 0; i < S.shopRefs.length; i++) {
    var r = S.shopRefs[i], u = r.u;
    var lvl = shopLevel(u.id);
    var maxed = u.max !== undefined && lvl >= u.max;
    var cost = costOf(u, lvl);
    txt(r.lvlEl, 'LVL ' + lvl);
    var e = null;
    if (typeof u.effect === 'function') { try { e = u.effect(lvl); } catch (er) {} }
    if (typeof e === 'number') e = 'now: ' + (Math.round(e * 100) / 100);
    txt(r.effEl, e ? String(e) : '');
    if (maxed) {
      txt(r.btn, 'MAX');
      if (r.btn.classList) r.btn.classList.add('dp-broke');
      r.btn.disabled = true;
    } else {
      txt(r.btn, '\u25C8 ' + fmt(cost));
      var afford = S.target >= cost;
      if (r.btn.classList) { if (afford) r.btn.classList.remove('dp-broke'); else r.btn.classList.add('dp-broke'); }
      r.btn.disabled = false;
    }
  }
}
function buildShop(body) {
  var balWrap = el('div', 'dp-shop-bal', body);
  var lbl = el('span', '', balWrap); lbl.textContent = 'YOUR COINS: \u25C8 ';
  S.hudRefs.balEl = el('b', '', balWrap); txt(S.hudRefs.balEl, '0');
  S.shopRefs = [];
  var ups = upgradesList();
  for (var i = 0; i < ups.length; i++) {
    (function (u) {
      var row = el('div', 'dp-shop-row', body);
      var info = el('div', 'dp-shop-info', row);
      var nm = el('div', 'dp-shop-name', info); nm.textContent = u.name || u.id;
      var lvlEl = el('small', '', nm);
      el('div', 'dp-shop-desc', info).textContent = u.desc || '';
      var effEl = el('div', 'dp-shop-eff', info);
      var btn = el('button', 'dp-buy', row);
      btn.addEventListener('click', function () {
        if (typeof S.handlers.buy === 'function') { try { S.handlers.buy(u.id); } catch (e) {} }
        refreshShop();
      });
      S.shopRefs.push({ u: u, btn: btn, lvlEl: lvlEl, effEl: effEl });
    })(ups[i]);
  }
  refreshShop();
}

/* ---------- WHEEL ---------- */
function setWheelAngle(deg) {
  S.wheelAngle = deg;
  var elw = S.wheelRefs.wheelEl;
  if (!elw || Math.abs(deg - S.lastWheelDeg) < 0.12) return;
  S.lastWheelDeg = deg;
  elw.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
}
function buildWheelDisc() {
  var wrap = S.wheelRefs.wrap, disc = S.wheelRefs.wheelEl;
  var secs = wheelSectors(), n = secs.length, step = 360 / n;
  var stops = [];
  for (var i = 0; i < n; i++) {
    var c = secs[i].color || tierColorOf(i + 1);
    stops.push(c + ' ' + (i * step) + 'deg ' + ((i + 1) * step) + 'deg');
  }
  disc.style.background = 'conic-gradient(' + stops.join(',') + ')';
  var R = wrap.offsetWidth ? Math.max(58, wrap.offsetWidth * 0.36) : 100;
  while (disc.firstChild) disc.removeChild(disc.firstChild);
  for (var k = 0; k < n; k++) {
    var lb = el('div', 'dp-wheel-label', disc);
    var a = (k + 0.5) * step;
    lb.textContent = secs[k].label || secs[k].name || secs[k].id || '?';
    if (lb.style) lb.style.color = '#0b0820';
    lb.style.transform = 'translate(-50%,-50%) rotate(' + a + 'deg) translateY(-' + R.toFixed(0) + 'px)';
  }
  S.lastWheelDeg = -1e9;
  setWheelAngle(S.wheelAngle);
}
function refreshWheelModal() {
  if (!S.modal || S.modal.kind !== 'wheel' || !S.wheelRefs.spinBtn) return;
  var b = S.wheelRefs.spinBtn;
  if (S.spinning) { b.disabled = true; txt(b, 'SPINNING...'); }
  else if (S.wheelRemain > 0) { b.disabled = true; txt(b, 'READY IN ' + Math.ceil(S.wheelRemain / 1000) + 's'); }
  else { b.disabled = false; txt(b, 'SPIN'); }
  if (S.wheelRefs.cdEl) txt(S.wheelRefs.cdEl, S.wheelRemain > 0 ? 'next free spin in ' + Math.ceil(S.wheelRemain / 1000) + 's' : 'free spin ready!');
}
function buildWheel(body) {
  var wrap = el('div', 'dp-wheel-wrap', body);
  var pointer = el('div', 'dp-wheel-pointer', wrap);
  var disc = el('div', 'dp-wheel', wrap);
  var hub = el('div', 'dp-wheel-hub', wrap);
  S.wheelRefs = { wrap: wrap, wheelEl: disc, pointer: pointer };
  buildWheelDisc();
  var banner = el('div', 'dp-wheel-banner', body); txt(banner, ' ');
  S.wheelRefs.banner = banner;
  var cd = el('div', 'dp-wheel-cd', body); txt(cd, ' ');
  S.wheelRefs.cdEl = cd;
  var sb = el('button', 'dp-spin-btn', body); txt(sb, 'SPIN');
  sb.addEventListener('click', function () {
    if (S.spinning) return;
    if (S.wheelRemain > 0) { DP.UI.toast('wheel recharging \u2014 ' + Math.ceil(S.wheelRemain / 1000) + 's', 'red'); return; }
    if (typeof S.handlers.spin !== 'function') { DP.UI.toast('wheel not ready yet', 'red'); return; }
    try { S.handlers.spin(); } catch (e) {}
    refreshWheelModal();
  });
  S.wheelRefs.spinBtn = sb;
  refreshWheelModal();
}
function tickSound() {
  if (typeof DP.Audio !== 'undefined' && DP.Audio && typeof DP.Audio.play === 'function') {
    try { DP.Audio.play('wheelTick'); } catch (e) {}
  }
}
function settleSpin(a) {
  S.anim = null; S.spinning = false;
  setWheelAngle(a.to);
  retrigger(S.wheelRefs.pointer, 'dp-wobble');
  var secs = wheelSectors();
  var s = secs[a.sector] || {};
  var b = S.wheelRefs.banner;
  if (b) {
    b.className = 'dp-wheel-banner';
    if (a.nearMiss) { txt(b, 'SO CLOSE!'); b.className = 'dp-wheel-banner dp-miss'; }
    else {
      txt(b, (s.label || s.name || s.id || '?') + '!');
      b.className = 'dp-wheel-banner dp-hit' + (s.id === 'jackpot' ? ' dp-jackpot' : '');
      if (s.id === 'jackpot' && b.classList) retrigger(b, 'dp-pulse');
    }
  }
  DP.UI.toast('WHEEL: ' + (a.nearMiss ? 'SO CLOSE!' : (s.label || s.id || '?')), s.id === 'jackpot' ? 'gold' : (a.nearMiss ? 'red' : 'cyan'));
  refreshWheelModal();
}
DP.UI.wheelSpin = function (result) {
  if (!result || typeof result.sector !== 'number' || S.spinning) return;
  var secs = wheelSectors(), n = secs.length;
  var step = 360 / n;
  S.spinning = true;
  S.wheelTurns += 4 + Math.floor(Math.random() * 2);       /* always forward */
  var j = (Math.random() * 2 - 1) * (step / 2 - 6);        /* stay inside sector */
  var to = PURE.wheelTargetAngle(result.sector, n, S.wheelTurns, j);
  S.anim = { elapsed: 0, dur: Math.max(1200, result.revealMs || 3400) / 1000,   /* ms -> sec */
    from: S.wheelAngle, to: to, n: n, lastFloor: Math.floor(S.wheelAngle / step),
    sector: Math.max(0, Math.min(n - 1, result.sector)), nearMiss: !!result.nearMiss };
  if (S.wheelRefs.banner) { S.wheelRefs.banner.className = 'dp-wheel-banner'; txt(S.wheelRefs.banner, ' '); }
  refreshWheelModal();
};

/* ---------- COLLECTION ---------- */
function discoveredArr() {
  var out = [], d = S.discovered || {};
  if (Array.isArray(d)) { for (var i = 0; i < FB_TIERS; i++) out[i] = !!d[i]; return out; }
  for (var t = 1; t <= FB_TIERS; t++) out[t - 1] = !!(d[t] || d[String(t)]);
  return out;
}
function refreshCollection() {
  var arr = discoveredArr(), count = 0;
  for (var i = 0; i < FB_TIERS; i++) if (arr[i]) count++;
  if (S.colRefs.statsEl) {
    var b = discoverBonusOf(count);
    txt(S.colRefs.statsEl, 'DISCOVERED ' + count + '/' + FB_TIERS + ' \u2014 income bonus x' + (Math.round(b * 100) / 100));
  }
  for (var k = 0; k < S.colRefs.cells.length; k++) {
    var r = S.colRefs.cells[k], found = arr[k];
    if (r.cell.classList) {
      if (found) { r.cell.classList.add('dp-found'); r.cell.classList.remove('dp-locked'); }
      else { r.cell.classList.add('dp-locked'); r.cell.classList.remove('dp-found'); }
    }
    if (found) {
      r.swatch.style.background = tierColorOf(k + 1);
      txt(r.name, tierNameOf(k + 1));
      txt(r.val, '\u25C8 ' + fmt(coinValueOf(k + 1)));
    } else {
      r.swatch.style.background = '';
      txt(r.name, '???');
      txt(r.val, 'locked');
    }
  }
}
function buildCollection(body) {
  var stats = el('div', 'dp-col-stats', body);
  S.colRefs = { statsEl: stats, cells: [] };
  var grid = el('div', '', body); grid.id = 'dp-colgrid';
  for (var i = 1; i <= FB_TIERS; i++) {
    (function (t) {
      var cell = el('button', 'dp-cell', grid);
      var sw = el('div', 'dp-cube', cell);
      var nm = el('div', 'dp-cell-name', cell);
      var vl = el('div', 'dp-cell-val', cell);
      cell.addEventListener('click', function () {
        if (discoveredArr()[t - 1]) DP.UI.toast(tierNameOf(t) + ' \u2014 \u25C8 ' + fmt(coinValueOf(t)), 'cyan');
        else DP.UI.toast('undiscovered \u2014 merge to tier ' + t, 'red');
      });
      S.colRefs.cells.push({ cell: cell, swatch: sw, name: nm, val: vl });
    })(i);
  }
  refreshCollection();
}

/* ---------- ASCEND ---------- */
function refreshAscendModal() {
  if (!S.modal || S.modal.kind !== 'ascend' || !S.ascRefs.bigEl) return;
  var cur = prestigeMultOf(S.ascensions), nxt = prestigeMultOf(S.ascensions + 1);
  txt(S.ascRefs.bigEl, 'x' + (Math.round(nxt * 100) / 100));
  txt(S.ascRefs.noteEl, 'current permanent multiplier x' + (Math.round(cur * 100) / 100) +
    '  \u2192  next x' + (Math.round(nxt * 100) / 100) + ' (+' + Math.round((nxt / cur - 1) * 100) + '%)');
  if (S.ascRefs.barEl) S.ascRefs.barEl.style.width = PURE.pct(S.lifetime / 1e6);
  txt(S.ascRefs.progEl, 'lifetime earnings: \u25C8 ' + fmt(S.lifetime) + ' / 1.0M');
  if (S.ascRefs.confirmBtn) S.ascRefs.confirmBtn.disabled = !S.canAscend;
}
function buildAscend(body) {
  S.ascRefs = {};
  var big = el('div', 'dp-asc-big', body); txt(big, 'x1.5');
  S.ascRefs.bigEl = big;
  var note = el('div', 'dp-asc-note', body); S.ascRefs.noteEl = note;
  var bar = el('div', 'dp-asc-bar', body);
  S.ascRefs.barEl = el('div', 'dp-asc-barfill', bar);
  var prog = el('div', 'dp-asc-note', body); S.ascRefs.progEl = prog;
  var warn = el('div', 'dp-asc-warn', body);
  warn.textContent = 'WARNING: ascending resets your board, coins and ALL upgrades. The multiplier is forever. Everything else is dust.';
  var actions = el('div', 'dp-modal-actions', body);
  var cancel = el('button', 'dp-btn', actions); cancel.textContent = 'NOT YET';
  cancel.addEventListener('click', function () { closeAll(); });
  var go = el('button', 'dp-btn dp-btn-confirm', actions); go.textContent = 'ASCEND';
  go.addEventListener('click', function () {
    if (!S.canAscend) return;
    if (typeof S.handlers.ascend === 'function') { try { S.handlers.ascend(); } catch (e) {} }
    closeAll();
  });
  S.ascRefs.confirmBtn = go;
  refreshAscendModal();
}

/* ---------- OFFLINE ---------- */
DP.UI.showOffline = function (gain) {
  gain = Math.max(0, Number(gain) || 0);
  openModal('offline', 'WELCOME BACK', function (body) {
    var big = el('div', 'dp-off-big', body); txt(big, '\u25C8 ' + fmt(gain));
    var note = el('div', 'dp-asc-note', body);
    note.textContent = 'your factory kept producing while you were away.';
    var actions = el('div', 'dp-modal-actions', body);
    var btn = el('button', 'dp-btn dp-btn-confirm', actions); btn.textContent = 'CLAIM';
    btn.addEventListener('click', function () {
      if (typeof S.handlers.claimOffline === 'function') { try { S.handlers.claimOffline(gain); } catch (e) {} }
      closeAll();
      DP.UI.toast('+' + fmt(gain) + ' coins \u2014 welcome back!', 'gold');
    });
  });
};

/* ---------- frame loop ---------- */
function frame(dt) {
  if (dt > 0.1) dt = 0.1;
  if (S.target !== S.shown) { S.shown = PURE.countUp(S.shown, S.target, dt); writeCoins(); }
  S.comboIdle += dt;
  if (S.comboFillShown > 0 && S.comboIdle > 0.7) {          /* 2s window w/ grace */
    S.comboFillShown = Math.max(0, S.comboFillShown - dt / 1.3);
    if (S.comboFillShown === 0) S.comboMultShown = 1;
    writeCombo();
  }
  if (S.wheelRemain > 0) {
    S.wheelRemain = Math.max(0, S.wheelRemain - dt * 1000);
    writeRing();
    if (S.wheelRemain === 0) { refreshWheelModal(); if (S.modal && S.modal.kind !== 'wheel') DP.UI.toast('free spin ready!', 'gold'); }
  }
  var a = S.anim;
  if (a) {
    a.elapsed += dt;                                        /* dt-driven: works headless + fixed-dt loops */
    var t = PURE.clamp01(a.elapsed / a.dur);
    setWheelAngle(a.from + (a.to - a.from) * PURE.easeOutQuart(t));
    var step = 360 / a.n;
    var fl = Math.floor(S.wheelAngle / step);
    while (a.lastFloor < fl) { a.lastFloor++; tickSound(); }
    if (t >= 1) settleSpin(a);
  }
}
DP.UI.frame = frame;
DP.UI._S = S;   /* exposed for integration debugging (read-only use) */
function startRaf() {
  if (S.rafOn) return; S.rafOn = true;
  var last = 0;
  if (typeof requestAnimationFrame === 'function') {
    var loop = function (ts) {
      var dt = last ? (ts - last) / 1000 : 0.016;
      last = ts;
      try { frame(dt); } catch (e) {}
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else if (typeof setInterval === 'function') {
    setInterval(function () { try { frame(0.05); } catch (e) {} }, 50);
  }
}

/* ---------- event wiring (bus optional) ---------- */
function wireEvents() {
  onEvt('coins', function (d) {
    if (!d || typeof d.total !== 'number') return;
    var delta = d.amount || 0;
    DP.UI.setCoins(d.total, delta);
  });
  onEvt('combo', function (d) {
    if (!d) return;
    var mult = d.mult || 1, count = d.count || 0;
    var f = PURE.comboFill(mult);
    if (f > S.comboFillShown + 0.0001 || count > (S.lastComboCount || 0)) retrigger(S.hudRefs.combo, 'dp-pulse');
    S.lastComboCount = count;
    S.comboFillShown = f; S.comboMultShown = mult; S.comboIdle = 0;
    writeCombo();
  });
  onEvt('quest', function (d) {
    if (typeof S.handlers.getQuests === 'function') { try { var l = S.handlers.getQuests(); if (l) S.quests = l; } catch (e) {} }
    renderQuests();
    if (d && d.done) DP.UI.toast('QUEST COMPLETE \u2014 tap to claim!', 'green');
  });
  onEvt('spend', function (d) {
    if (d && d.id && typeof d.level === 'number') S.upLevels[d.id] = d.level;
    refreshShop(); refreshAscendModal();
  });
  onEvt('wheel', function (d) {
    var r = d ? (d.result && typeof d.result === 'object' ? d.result : (typeof d.result === 'number' ? { sector: d.result } : d)) : null;
    if (r && typeof r.sector === 'number') DP.UI.wheelSpin(r);
  });
  onEvt('discover', function (d) {
    if (d && d.tier) { S.discovered[d.tier] = true; }
    if (S.modal && S.modal.kind === 'collection') refreshCollection();
    if (d && d.tier) DP.UI.toast('NEW SPECIES: ' + tierNameOf(d.tier), 'cyan');
  });
  onEvt('ascend', function (d) {
    S.ascensions = (d && typeof d.n === 'number') ? d.n : S.ascensions + 1;
    closeAll();
    DP.UI.toast('REALITY RESET \u2014 permanent x' + (Math.round(prestigeMultOf(S.ascensions) * 100) / 100), 'gold');
    setTimeout(function () { DP.UI.sync(); }, 60);
  });
  onEvt('load', function () { DP.UI.sync(); });
  if (hasDOM() && typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', function (e) { if (e && e.key === 'Escape') closeAll(); });
  }
}

/* ---------- sync + setters ---------- */
function autoAttach() {
  if (!S.game && typeof DP.Game !== 'undefined' && DP.Game && DP.Game.state) S.game = DP.Game;
  return S.game;
}
DP.UI.sync = function () {
  autoAttach();
  var g = S.game, st = g && g.state;
  if (st) {
    if (typeof st.coins === 'number') { S.target = Math.max(0, st.coins); }
    if (typeof st.lifetime === 'number') S.lifetime = st.lifetime;
    if (typeof st.ascensions === 'number') S.ascensions = st.ascensions;
    if (st.discovered) S.discovered = st.discovered;
    if (st.settings && typeof st.settings.muted === 'boolean') DP.UI.setMuted(st.settings.muted);
    var ca = null;
    if (DP.Core && typeof DP.Core.canAscend === 'function') { try { ca = DP.Core.canAscend(st); } catch (e) {} }
    S.canAscend = (ca === null) ? S.lifetime >= 1e6 : !!ca;
    /* canon idle income: sum(coinValue) x 0.05 x incomeMult — all guarded */
    if (g.board && DP.Board && typeof DP.Board.totalValue === 'function' && DP.Content && typeof DP.Content.incomeMult === 'function') {
      try { DP.UI.setIncome(DP.Board.totalValue(g.board) * 0.05 * DP.Content.incomeMult(st)); } catch (e) {}
    }
  }
  writeCoins(); writeCombo(); writeRing(); refreshAscendBtn(); renderQuests();
  if (S.modal && S.modal.kind === 'shop') refreshShop();
  if (S.modal && S.modal.kind === 'collection') refreshCollection();
  if (S.modal && S.modal.kind === 'ascend') refreshAscendModal();
  refreshWheelModal();
  return DP.UI;
};
DP.UI.attach = function (game) { if (game && game.state) S.game = game; return DP.UI.sync(); };
DP.UI.setCoins = function (total, delta) {
  S.target = Math.max(0, Number(total) || 0);
  if ((delta || 0) > 0) bumpCoins();
  if (!S.canAscend && S.lifetime >= 1e6) { S.canAscend = true; refreshAscendBtn(); }
  if (S.modal && S.modal.kind === 'shop') refreshShop();
};
DP.UI.setIncome = function (perSec) {
  var v = Math.max(0, Number(perSec) || 0);
  txt(S.hudRefs.incomeEl, '+' + fmt(v) + '/sec');
};
DP.UI.setQuests = function (list) { S.quests = (list || []).slice(0, 3); renderQuests(); return DP.UI; };
DP.UI.setDiscovered = function (d) { S.discovered = d || {}; if (S.modal && S.modal.kind === 'collection') refreshCollection(); return DP.UI; };
DP.UI.setWheelCooldown = function (remainMs, totalMs) {
  S.wheelRemain = Math.max(0, Number(remainMs) || 0);
  if (totalMs) S.wheelTotal = Math.max(1, Number(totalMs) || 60000);
  writeRing(); refreshWheelModal();
};
DP.UI.setMuted = function (m) {
  S.muted = !!m;
  var b = S.hudRefs.muteBtn;
  if (b) { if (b.classList) { if (S.muted) b.classList.add('dp-btn-muted'); else b.classList.remove('dp-btn-muted'); } if (b._sub) txt(b._sub, S.muted ? 'OFF' : 'ON'); }
};

/* ---------- modal openers ---------- */
DP.UI.openShop = function () { openModal('shop', 'UPGRADES', buildShop); };
DP.UI.openWheel = function () { openModal('wheel', 'BONUS WHEEL', function (b) { buildWheel(b); }); };
DP.UI.openCollection = function () { openModal('collection', 'CUBE DEX', buildCollection); };
DP.UI.openAscend = function () {
  if (!S.canAscend) { DP.UI.toast('ascension unlocks at \u25C8 1.0M lifetime', 'red'); return; }
  openModal('ascend', 'ASCEND', buildAscend);
};
DP.UI.closeAll = function () { closeAll(); };

/* ---------- init ---------- */
DP.UI.init = function (handlers) {
  if (handlers) { for (var k in handlers) { if (handlers.hasOwnProperty(k)) S.handlers[k] = handlers[k]; } }
  if (!hasDOM()) { autoAttach(); return DP.UI; }
  /* (re)wire events whenever the bus shows up — game.js loads AFTER ui.js */
  var bus = (typeof DP.Events !== 'undefined') ? DP.Events : null;
  if (bus && S.wiredBus !== bus) { S.wiredBus = bus; try { wireEvents(); } catch (e) {} }
  if (!S.built) {
    S.built = true;
    try {
      injectStyle();
      buildHud();
      buildQuests();
      buildToasts();
      startRaf();
      autoAttach();
      DP.UI.sync();
    } catch (e) {
      S.built = false;
      if (typeof console !== 'undefined' && console.warn) console.warn('[DP.UI.init]', e);
    }
  }
  return DP.UI;
};
if (hasDOM()) { try { DP.UI.init(); } catch (e) {} }   /* panels even if game.js forgets init */

/* ================= SELF-TEST (node js/ui.js — PURE only) ================= */
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('ui.js')) {
  var P = DP.UI.PURE, fails = 0, checks = 0;
  function T(name, cond) { checks++; if (!cond) fails++; console.log((cond ? 'PASS: ' : 'FAIL: ') + name); }
  function eq(a, b) { return Math.abs(a - b) < 1e-9; }

  /* count-up tween: converges + monotonic */
  var v = 0, mono = true, fr = 0;
  for (; fr < 2000; fr++) { var nv = P.countUp(v, 12345, 1 / 60); if (nv < v - 1e-9) mono = false; v = nv; if (v === 12345) break; }
  T('count-up converges to target', v === 12345);
  T('count-up is monotonic', mono);
  T('count-up converges fast (' + fr + ' frames < 240)', fr > 0 && fr < 240);
  var d0 = 5000, dm = true;
  for (var i2 = 0; i2 < 2000; i2++) { var nd = P.countUp(d0, 40, 1 / 60); if (nd > d0 + 1e-9) dm = false; d0 = nd; if (d0 === 40) break; }
  T('count-down converges + monotonic', d0 === 40 && dm);
  T('count-up snaps on huge dt', P.countUp(0, 100, 5) === 100);
  var tv = 0, tf = 0;
  for (; tf < 200; tf++) { tv = P.countUp(tv, 3, 1 / 60); if (tv === 3) break; }
  T('count-up tiny target converges', tv === 3 && tf < 60);
  var m = 0, mm = true;
  for (var i3 = 0; i3 < 300; i3++) { var tgt = i3 < 100 ? 50 : 120; var nmv = P.countUp(m, tgt, 1 / 60); if (nmv < m - 1e-9) mm = false; m = nmv; }
  T('count-up survives retarget (mono, lands)', mm && m === 120);

  /* cooldown ring arc math */
  T('arc f=0.25 quarter path', P.arcPath(26, 26, 23, 0.25).d === 'M 26 3 A 23 23 0 0 1 49 26');
  T('arc f=0.5 half path', P.arcPath(26, 26, 23, 0.5).d === 'M 26 3 A 23 23 0 0 1 26 49');
  T('arc f=0.75 large-arc', P.arcPath(26, 26, 23, 0.75).d === 'M 26 3 A 23 23 0 1 1 3 26');
  var AF = P.arcPath(26, 26, 23, 1);
  T('arc full circle = two 180 arcs', AF.full && AF.d === 'M 26 3 A 23 23 0 0 1 26 49 A 23 23 0 0 1 26 3');
  T('arc clamps (-0.2 empty, 1.3 full)', P.arcPath(26, 26, 23, -0.2).d === '' && P.arcPath(26, 26, 23, 1.3).full === true);

  /* wheel target angle per sector index: sector i of 8 -> degrees */
  var okA = true, okL = true, okF = true;
  for (var i8 = 0; i8 < 8; i8++) {
    if (!eq(P.wheelTargetAngle(i8, 8, 0, 0) % 360, (360 - (i8 + 0.5) * 45) % 360)) okA = false;
    var jmax = 45 / 2 - 6;
    for (var ji = 0; ji <= 6; ji++) {
      var ang = P.wheelTargetAngle(i8, 8, 3, -jmax + (2 * jmax) * ji / 6);
      var rel = ((360 - (ang % 360)) % 360 + 360) % 360;
      if (Math.floor(rel / 45 + 1e-9) !== i8) okL = false;
      if (ang < 3 * 360) okF = false;
    }
  }
  T('wheel angle: sector i of 8 -> 360-(i+0.5)*45 deg', okA);
  T('wheel jitter always lands inside sector i', okL);
  T('wheel angle >= spins*360 (forward only)', okF);
  T('ticksCrossed counts sector crossings', P.ticksCrossed(0, 360, 8) === 8 && P.ticksCrossed(10, 100, 8) === 2 && P.ticksCrossed(0, 44.9, 8) === 0 && P.ticksCrossed(337.5, 337.6, 8) === 0);

  /* progress bar clamping */
  T('clamp01 clamps progress', P.clamp01(-0.5) === 0 && P.clamp01(1.7) === 1 && P.clamp01(0.5) === 0.5);
  T('pct strings for bars', P.pct(-0.2) === '0%' && P.pct(1.7) === '100%' && P.pct(0.5) === '50%');

  /* toast queue max length behavior */
  var q = [], dropped = 0, res;
  for (var ti = 0; ti < 5; ti++) { res = P.toastPush(q, 'm' + ti, 3); q = res.queue; dropped += res.dropped; }
  T('toast queue caps at max 3', q.length === 3);
  T('toast queue keeps newest (FIFO drop)', q[0] === 'm2' && q[1] === 'm3' && q[2] === 'm4');
  T('toast queue reports drops', dropped === 2);
  T('toast queue max>=1 enforced', P.toastPush([], 'solo', 0).queue.length === 1);

  /* combo meter math */
  T('combo fill x1.0->x3.0 maps 0->1', P.comboFill(1) === 0 && P.comboFill(2) === 0.5 && P.comboFill(3) === 1 && P.comboFill(9) === 1);
  T('combo hue shifts with mult', P.comboHue(1) === 185 && P.comboHue(3) === 330);

  /* fmt (DP.Core.fmt if loaded, else identical fallback) */
  T('fmt 0/999/1.2K/3.4M/5.6B/2T', P.fmt(0) === '0' && P.fmt(999) === '999' && P.fmt(1234) === '1.2K' && P.fmt(3400000) === '3.4M' && P.fmt(5600000000) === '5.6B' && P.fmt(2000000000000) === '2T');

  /* fallback wheel table sanity (used only when DP.Wheel absent) */
  var secs = wheelSectors(), wsum = 0, jk = -1, dd = -1;
  for (var si = 0; si < secs.length; si++) { wsum += (secs[si].weight || 0); if (secs[si].id === 'jackpot') jk = si; if (secs[si].id === 'dud') dd = si; }
  T('wheel fallback: 8 sectors, weights sum 100', secs.length === 8 && wsum === 100);
  T('wheel fallback: dud adjacent to jackpot (near-miss)', jk >= 0 && dd >= 0 && Math.abs(jk - dd) === 1);

  if (fails) { console.error(fails + ' CHECKS FAILED'); process.exit(1); }
  console.log('ALL TESTS PASSED (' + (checks - fails) + '/' + checks + ')');
}
