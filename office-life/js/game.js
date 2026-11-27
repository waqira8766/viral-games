/* ================================================================
   TINY OFFICE — Corporate Climb 🏢 — a cute 3D idle-management game.
   PART 1  Pure logic & math — no DOM, no THREE. (Node-testable)
   PART 2  Browser bootstrap — guarded by `typeof document`.
   Self-test: node game.js   ·   Syntax check: node --check game.js
   ================================================================ */

'use strict';

/* ================================================================
 * PART 1 — PURE LOGIC (economy, progression, save format)
 * ================================================================ */

const SAVE_KEY = 'tiny_office_save_v1';
const SAVE_VERSION = 1;
const MAX_GUYS = 16;                        // office capacity
const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000;  // offline earnings cap: 8h
const OFFLINE_RATE = 0.5;                   // 50% income while away
/** The corporate ladder — 8 rungs, Intern → CEO. */
const TITLES = ['Intern', 'Junior', 'Senior', 'Lead', 'Manager', 'Director', 'VP', 'CEO'];
/** Cute name pool for the little guys. */
const NAMES = [
  'Biscuit', 'Pip', 'Noodle', 'Waffles', 'Sprout', 'Mochi', 'Bubbles', 'Tofu',
  'Pickles', 'Beans', 'Clover', 'Dumpling', 'Peanut', 'Muffin', 'Churro', 'Pudding',
  'Boba', 'Ziggy', 'Poppy', 'Crumb', 'Nugget', 'Squish', 'Marshmallow', 'Cinnamon'
];
/** Pastel shirt colours (plain hex strings — no THREE in this part). */
const SHIRT_COLORS = [
  '#ffb5c2', '#b5ead7', '#c7b8ea', '#ffdab9', '#aec6ff', '#fff3b0',
  '#ffab91', '#a8e6e6', '#f4b6c2', '#cdeac0', '#e2c2ff', '#ffd6a5'
];
/** Upgrade catalogue. Prices scale ×1.25 per owned level. */
const UPGRADE_DEFS = [
  { id: 'espresso', icon: '☕', name: 'Espresso Machine', desc: '+25% global income', base: 100 },
  { id: 'standing', icon: '🪑', name: 'Standing Desks', desc: '+20% global income', base: 150 },
  { id: 'gym', icon: '🏋️', name: 'Gym Membership', desc: 'faster walking · coffee 60s', base: 120 },
  { id: 'keyboard', icon: '⌨️', name: 'Golden Keyboard', desc: 'click bonus ×2', base: 200 }
];

/* ---------------- economy formulas ---------------- */

/** Cost of hiring the next little guy, given how many you already own. */
function hireCost(owned) { return Math.round(50 * Math.pow(1.6, owned)); }
/** XP needed to promote from `level` to `level + 1`. */
function xpNeeded(level) { return 30 * Math.pow(1.5, level); }
/** Job title for a level (clamped to CEO). */
function titleForLevel(level) { return TITLES[Math.max(0, Math.min(TITLES.length - 1, Math.floor(level)))]; }
/** level → visual hat tier: 0 none · 1 cap · 2 beret · 3 wide-brim · 4 top hat · 5 gold crown. */
const HAT_LEVELS = [0, 0, 1, 2, 3, 4, 4, 5];
function hatTierForLevel(level) { return level >= 7 ? 5 : HAT_LEVELS[Math.max(0, Math.min(7, Math.floor(level)))]; }
/** Global income multiplier from the two income upgrades. */
function globalIncomeMult(upgrades) { return Math.pow(1.25, upgrades.espresso || 0) * Math.pow(1.2, upgrades.standing || 0); }
/** Per-guy income: 1 × promotionLevel × globalUpgradeMult × (caffeinated ? 1.5 : 1). */
function guyIncomePerSec(level, upgrades, caffeinated) {
  return 1 * (Math.floor(level) + 1) * globalIncomeMult(upgrades) * (caffeinated ? 1.5 : 1);
}
/** Total office income at a given wall-clock time (ms since epoch). */
function totalIncomePerSec(guys, upgrades, nowMs) {
  let total = 0;
  for (let i = 0; i < guys.length; i++) total += guyIncomePerSec(guys[i].level, upgrades, guys[i].caffeinatedUntil > nowMs);
  return total;
}
/** "Motivate!" click bonus — scales ×2 per Golden Keyboard level. */
function clickBonusValue(totalIncome, keyboardLevel) { return Math.max(1, totalIncome) * Math.pow(2, keyboardLevel || 0); }
/** Offline earnings: elapsed × income × 50%, capped at 8h. */
function offlineEarnings(lastSeen, now, incomePerSec) {
  const elapsed = Math.min(Math.max(0, now - lastSeen), OFFLINE_CAP_MS);
  return (elapsed / 1000) * incomePerSec * OFFLINE_RATE;
}
/** Upgrade price: base × 1.25^level. */
function upgradeCost(base, level) { return Math.round(base * Math.pow(1.25, level || 0)); }
/** Coffee buff duration: 30s, or 60s once the Gym Membership is owned. */
function coffeeDurationSec(gymLevel) { return (gymLevel || 0) > 0 ? 60 : 30; }
/** Walking speed multiplier from Gym Membership levels. */
function walkSpeedMult(gymLevel) { return 1 + 0.2 * (gymLevel || 0); }

/* ---------------- touch input math (mobile pass, no THREE) ---------------- */

const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));
/** Orbit sensitivity: radians of camera rotation per pixel of drag. */
const ORBIT_AZ_PER_PX = 0.0055, ORBIT_POL_PER_PX = 0.005;
/** Polar (vertical orbit) is clamped so the camera never leaves the room. */
const POL_MIN = 0.3, POL_MAX = 1.32;
/** Orthographic zoom range shared by pinch + wheel. */
const ZOOM_MIN = 0.45, ZOOM_MAX = 2.6;

/** One-finger drag → orbit math. Mutates and returns cam {az, pol}. */
function applyOrbitDelta(cam, dx, dy) {
  cam.az -= dx * ORBIT_AZ_PER_PX;
  cam.pol = clampNum(cam.pol - dy * ORBIT_POL_PER_PX, POL_MIN, POL_MAX);
  return cam;
}

/** Two-finger pinch → zoom math. Ortho zoom: bigger number = closer. */
function applyPinchZoom(targetZoom, prevDist, newDist) {
  if (!(prevDist > 0) || !(newDist >= 0)) return targetZoom; // no-op on bad input
  return clampNum(targetZoom * (newDist / prevDist), ZOOM_MIN, ZOOM_MAX);
}

/** Tap-vs-drag classifier: a pointer that moved < 8px in < 300ms is a tap. */
const TAP_MAX_PX = 8, TAP_MAX_MS = 300;
function classifyGesture(dx, dy, dtMs) {
  const moved = Math.hypot(dx, dy);
  return (moved < TAP_MAX_PX && dtMs >= 0 && dtMs < TAP_MAX_MS) ? 'tap' : 'drag';
}

/** Picking pipeline: client px → NDC → raycast → guy id (or null).
 *  Injected deps (camera + raycaster + objects) mean this runs with the real
 *  THREE.Raycaster in the browser and plain mocks under node. */
function pickGuy(px, py, width, height, camera, raycaster, objects) {
  const ndc = {
    x: (px / width) * 2 - 1,
    y: -(py / height) * 2 + 1
  };
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(objects, true);
  for (let i = 0; i < hits.length; i++) { // hits are sorted: nearest first
    let o = hits[i] && hits[i].object;
    while (o) { // walk up the mesh graph to the tagged guy group
      if (o.userData && o.userData.guyId != null) return o.userData.guyId;
      o = o.parent;
    }
  }
  return null;
}


/* ---------------- save format ---------------- */

/** Persistent state of one little guy. */
function makeGuyState(name, color, desk) { return { name: name, color: color, level: 0, xp: 0, caffeinatedUntil: 0, desk: desk }; }
function makeState() {
  return {
    version: SAVE_VERSION, money: 0, guys: [],
    upgrades: { espresso: 0, standing: 0, gym: 0, keyboard: 0 },
    lastSeen: 0, muted: false
  };
}
function clampInt(v, min, max, dflt) {
  v = Math.floor(Number(v));
  if (!isFinite(v)) return dflt;
  return Math.max(min, Math.min(max, v));
}
function serializeGuy(g) {
  return {
    name: String(g.name), color: String(g.color), level: clampInt(g.level, 0, 99, 0),
    xp: Math.max(0, Number(g.xp) || 0), caffeinatedUntil: Math.max(0, Number(g.caffeinatedUntil) || 0),
    desk: clampInt(g.desk, 0, MAX_GUYS - 1, 0)
  };
}
/** Canonical JSON — identical states always serialize to identical strings. */
function saveSerialize(state) {
  return JSON.stringify({
    version: SAVE_VERSION,
    money: Math.max(0, Number(state.money) || 0),
    guys: state.guys.slice(0, MAX_GUYS).map(serializeGuy),
    upgrades: {
      espresso: clampInt(state.upgrades.espresso, 0, 99, 0),
      standing: clampInt(state.upgrades.standing, 0, 99, 0),
      gym: clampInt(state.upgrades.gym, 0, 99, 0),
      keyboard: clampInt(state.upgrades.keyboard, 0, 99, 0)
    },
    lastSeen: Math.max(0, Math.floor(Number(state.lastSeen) || 0)),
    muted: !!state.muted
  });
}
/** Tolerant parse — junk becomes a fresh state, bad fields get clamped. */
function saveDeserialize(json) {
  const state = makeState();
  if (!json) return state;
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return state;
    state.money = Math.max(0, Number(data.money) || 0);
    if (Array.isArray(data.guys)) {
      for (let i = 0; i < data.guys.length && state.guys.length < MAX_GUYS; i++) {
        const g = data.guys[i];
        if (!g || typeof g !== 'object') continue;
        state.guys.push({
          name: (typeof g.name === 'string' && g.name) ? g.name.slice(0, 24) : 'Biscuit',
          color: (typeof g.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(g.color)) ? g.color : SHIRT_COLORS[0],
          level: clampInt(g.level, 0, 99, 0), xp: Math.max(0, Number(g.xp) || 0),
          caffeinatedUntil: Math.max(0, Number(g.caffeinatedUntil) || 0),
          desk: clampInt(g.desk, 0, MAX_GUYS - 1, state.guys.length)
        });
      }
    }
    if (data.upgrades && typeof data.upgrades === 'object') {
      state.upgrades.espresso = clampInt(data.upgrades.espresso, 0, 99, 0);
      state.upgrades.standing = clampInt(data.upgrades.standing, 0, 99, 0);
      state.upgrades.gym = clampInt(data.upgrades.gym, 0, 99, 0);
      state.upgrades.keyboard = clampInt(data.upgrades.keyboard, 0, 99, 0);
    }
    state.lastSeen = Math.max(0, Math.floor(Number(data.lastSeen) || 0));
    state.muted = !!data.muted;
  } catch (e) {
    return makeState();
  }
  return state;
}
/** Pick a cute name (or shirt colour), avoiding duplicates when possible. */
function pickName(taken) {
  const free = NAMES.filter(n => taken.indexOf(n) === -1);
  const pool = free.length ? free : NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}
function pickColor(taken) {
  const free = SHIRT_COLORS.filter(c => taken.indexOf(c) === -1);
  const pool = free.length ? free : SHIRT_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ================================================================
 * SELF-TEST — runs under `node game.js`
 * ================================================================ */
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('game.js')) {
  (function runSelfTest() {
    let fails = 0, passes = 0;
    const eps = (a, b) => Math.abs(a - b) < 1e-9;
    const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (cond) passes++; else fails++; };

    /* 1. hire cost curve */
    check('hire cost: 2 hires = 50*1.6^2 = 128', hireCost(2) === 128);
    check('hire cost curve (0→50, 1→80, 3→205)', hireCost(0) === 50 && hireCost(1) === 80 && hireCost(3) === 205);

    /* 2. xp curve monotonic */
    let mono = true;
    for (let l = 1; l < 15; l++) if (xpNeeded(l) <= xpNeeded(l - 1)) mono = false;
    check('xp curve monotonic (levels 0-14)', mono);
    check('xp curve values (30 * 1.5^level)', xpNeeded(0) === 30 && eps(xpNeeded(1), 45) && eps(xpNeeded(4), 151.875));

    /* 3. income formula with caffeine + upgrades */
    const zero = { espresso: 0, standing: 0, gym: 0, keyboard: 0 };
    const all = { espresso: 1, standing: 1, gym: 1, keyboard: 1 };
    check('income: intern base = $1/sec', eps(guyIncomePerSec(0, zero, false), 1));
    check('income: lvl2 + espresso + standing + caffeine = 3*1.25*1.2*1.5', eps(guyIncomePerSec(2, all, true), 6.75));
    const nowT = 1700000000000;
    const twoGuys = [makeGuyState('Pip', '#ffb5c2', 0), makeGuyState('Mochi', '#b5ead7', 1)];
    twoGuys[1].level = 2; twoGuys[1].caffeinatedUntil = nowT + 1000;
    check('total income sums guys + caffeine', eps(totalIncomePerSec(twoGuys, all, nowT), 1.5 + 6.75));

    /* 4. offline cap at 8h */
    check('offline caps at 8h', offlineEarnings(nowT - 10 * 3600 * 1000, nowT, 10) === 8 * 3600 * 10 * 0.5);
    check('offline under cap is linear', offlineEarnings(nowT - 60 * 1000, nowT, 10) === 60 * 10 * 0.5);

    /* 5. save round-trip equality */
    const s = makeState();
    s.money = 123.456; s.lastSeen = 1699999999999; s.muted = true; s.upgrades.espresso = 2; s.upgrades.keyboard = 3;
    const pip = makeGuyState('Pip', '#ffb5c2', 1);
    pip.level = 2; pip.xp = 12.5; pip.caffeinatedUntil = 1699999999999;
    s.guys.push(pip);
    const j1 = saveSerialize(s), r = saveDeserialize(j1), j2 = saveSerialize(r);
    check('save round-trip string equality', j1 === j2);
    check('save round-trip field equality', r.money === 123.456 && r.guys.length === 1 && r.guys[0].name === 'Pip' && r.guys[0].level === 2 && r.guys[0].xp === 12.5 && r.guys[0].desk === 1 && r.upgrades.espresso === 2 && r.upgrades.keyboard === 3 && r.lastSeen === 1699999999999 && r.muted === true);
    check('save deserialize junk → fresh state', saveDeserialize('this is {{{ not json').version === SAVE_VERSION);

    /* 6. promotion ladder */
    check('promotion ladder length 8 (Intern → CEO)', TITLES.length === 8 && TITLES[0] === 'Intern' && TITLES[7] === 'CEO');
    check('title clamps at CEO', titleForLevel(7) === 'CEO' && titleForLevel(12) === 'CEO');

    /* extras */
    check('upgrade cost ×1.25 scaling', upgradeCost(100, 2) === 156);
    check('gym: coffee 30s → 60s, walking faster', coffeeDurationSec(0) === 30 && coffeeDurationSec(1) === 60 && eps(walkSpeedMult(2), 1.4));
    check('click bonus ×2 per golden keyboard', eps(clickBonusValue(7.75, 2), 31));
    check('hat tiers: none → cap → beret → brim → tophat → crown (CEO)', hatTierForLevel(0) === 0 && hatTierForLevel(2) === 1 && hatTierForLevel(3) === 2 && hatTierForLevel(4) === 3 && hatTierForLevel(5) === 4 && hatTierForLevel(7) === 5);

    /* 7. mobile/touch pass: orbit · pinch · tap classifier · picking */
    /* (a) orbit math: drag deltas through the camera-rotation function */
    const cam = { az: 0.55, pol: 0.95 };
    applyOrbitDelta(cam, 120, 0);
    check('orbit: dx=120px → azimuth 0.55 - 120*0.0055 = -0.11', eps(cam.az, 0.55 - 120 * 0.0055));
    applyOrbitDelta(cam, 0, 40);
    check('orbit: dy=40px → polar 0.95 - 0.2 = 0.75', eps(cam.pol, 0.75));
    const camLow = { az: 0.55, pol: 0.95 };
    applyOrbitDelta(camLow, 0, 10000);
    check('orbit: polar clamps at 0.3 (camera never below the floor)', camLow.pol === 0.3);
    const camHigh = { az: 0.55, pol: 0.95 };
    applyOrbitDelta(camHigh, 0, -10000);
    check('orbit: polar clamps at 1.32 (never fully overhead)', camHigh.pol === 1.32);

    /* (b) pinch math: two pointers 200px → 100px */
    check('pinch: 200px → 100px halves the zoom target (0.95 → 0.475)', eps(applyPinchZoom(0.95, 200, 100), 0.475));
    check('pinch: 100px → 200px doubles the zoom target (1.0 → 2.0)', eps(applyPinchZoom(1.0, 100, 200), 2.0));
    check('pinch: zoom clamps to [0.45, 2.6]', applyPinchZoom(0.9, 200, 1) === 0.45 && applyPinchZoom(2.0, 100, 1000) === 2.6);
    check('pinch: zero/garbage previous distance is a safe no-op', applyPinchZoom(0.95, 0, 100) === 0.95 && applyPinchZoom(0.95, -5, 100) === 0.95);

    /* (c) tap-vs-drag classifier (pure) */
    check('classifier: 4px in 120ms → tap', classifyGesture(4, 0, 120) === 'tap');
    check('classifier: 7.9px diagonal in 250ms → still a tap', classifyGesture(5.6, 5.6, 250) === 'tap');
    check('classifier: 40px in 100ms → drag', classifyGesture(40, 0, 100) === 'drag');
    check('classifier: 2px held 900ms (long-press) → drag', classifyGesture(2, 0, 900) === 'drag');
    check('classifier: exactly 8px / exactly 300ms → drag (strict bounds)', classifyGesture(8, 0, 300) === 'drag');

    /* (d) raycast picking with a mock camera + objects list */
    const mkHit = guyId => { // child mesh → parent group tagged with the guy id
      const group = { userData: { guyId: guyId }, parent: null };
      return { object: { userData: {}, parent: group } };
    };
    const mockRay = {
      setFromCamera (ndc, cam_) { this.ndc = ndc; this.cam = cam_; },
      intersectObjects (list, recursive) { this.objects = list; return this.hits; }
    };
    mockRay.hits = [mkHit(42)];
    check('picking: mock camera + objects → expected guy id',
      pickGuy(200, 200, 400, 400, { mock: 'camera' }, mockRay, [{}, {}]) === 42);
    check('picking: NDC computed from client px + viewport (center → 0,0)',
      eps(mockRay.ndc.x, 0) && eps(mockRay.ndc.y, 0) && mockRay.cam.mock === 'camera' && mockRay.objects.length === 2);
    pickGuy(300, 50, 400, 200, {}, mockRay, []);
    check('picking: NDC math (300,50 in 400x200 → x=0.5, y=0.5)',
      eps(mockRay.ndc.x, 0.5) && eps(mockRay.ndc.y, 0.5));
    mockRay.hits = [{ object: { userData: {}, parent: null } }, mkHit(7)];
    check('picking: untagged first hit is skipped, next guy wins',
      pickGuy(10, 10, 100, 100, {}, mockRay, []) === 7);
    mockRay.hits = [];
    check('picking: no hits → null', pickGuy(0, 0, 100, 100, {}, mockRay, []) === null);

    /* (e) mobile CSS shipped */
    const cssText = require('fs').readFileSync(require('path').join(__dirname, '..', 'css', 'style.css'), 'utf8');
    check('css: <700px media query for phones', /@media\s*\(max-width:\s*700px\)/.test(cssText));
    check('css: 44px min tap targets on mobile', /min-height:\s*44px/.test(cssText));
    check('css: body touch-action none for the fullscreen canvas', /touch-action:\s*none/.test(cssText));

    if (fails > 0) { console.log(fails + ' TEST(S) FAILED'); process.exit(1); }
    console.log('ALL TESTS PASSED (' + passes + ' checks)');
  })();
}
/* ================================================================
 * PART 2 — BROWSER BOOTSTRAP (three.js scene, guys, UI, audio)
 * ================================================================ */
if (typeof document !== 'undefined') {
  (function () {
    'use strict';
    if (typeof THREE === 'undefined') {
      document.body.innerHTML = '<div style="font:16px sans-serif;padding:40px">😢 three.js failed to load.</div>';
      return;
    }

    /* ---------------- tiny helpers ---------------- */
    const $ = id => document.getElementById(id);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const rand = (a, b) => a + Math.random() * (b - a);
    const fmtMoney = v => '$' + Math.floor(v).toLocaleString('en-US');
    const fmtIncome = v => '$' + v.toFixed(2);
    const ONE_VEC = new THREE.Vector3(1, 1, 1);
    const HAT_EMOJI = ['', '🧢', '🧢', '👒', '🎩', '👑'];
    /** position a mesh and add it to the scene (or a parent) in one step */
    const put = (mesh, x, y, z, parent) => {
      mesh.position.set(x, y, z); (parent || scene).add(mesh);
      return mesh;
    };

    /* ---------------- procedural audio (lazy, guarded) ---------------- */
    const Sfx = (() => {
      let ctx = null, noiseBuf = null;
      function ensure() {
        try {
          if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
          if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        } catch (e) { /* audio is optional */ }
      }
      function tone(freq, dur, type, vol, delay, slide) {
        try {
          if (!ctx) return;
          const t0 = ctx.currentTime + (delay || 0), osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.type = type || 'sine';
          osc.frequency.setValueAtTime(freq, t0);
          if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(vol || 0.06, t0 + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(t0); osc.stop(t0 + dur + 0.05);
        } catch (e) { /* never crash for a blip */ }
      }
      function noise(dur, f0, f1, vol) {
        try {
          if (!ctx) return;
          if (!noiseBuf) {
            const n = (ctx.sampleRate * 0.5) | 0; noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
            const d = noiseBuf.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
          }
          const src = ctx.createBufferSource(); src.buffer = noiseBuf;
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
          const g = ctx.createGain(), t0 = ctx.currentTime;
          bp.frequency.setValueAtTime(f0, t0);
          bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
          g.gain.setValueAtTime(vol, t0);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          src.connect(bp); bp.connect(g); g.connect(ctx.destination);
          src.start(t0); src.stop(t0 + dur + 0.05);
        } catch (e) { /* never crash for a slurp */ }
      }
      return {
        ensure,
        coin() { if (G.muted) return; tone(880, 0.07, 'square', 0.035); tone(1320, 0.1, 'square', 0.035, 0.06); },
        hire() { if (G.muted) return; tone(440, 0.09, 'triangle', 0.07); tone(660, 0.1, 'triangle', 0.07, 0.09); tone(880, 0.14, 'triangle', 0.07, 0.18); },
        fanfare() { if (G.muted) return; [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.18, 'square', 0.045, i * 0.09)); tone(1318.5, 0.3, 'triangle', 0.05, 0.36); },
        slurp() { if (G.muted) return; noise(0.45, 1500, 250, 0.1); tone(500, 0.4, 'sine', 0.02, 0.05, 200); },
        pop() { if (G.muted) return; tone(300, 0.08, 'sine', 0.08, 0, 150); }
      };
    })();
    document.addEventListener('pointerdown', () => Sfx.ensure(), { passive: true });

    /* ---------------- renderer / scene / camera ---------------- */
    let renderer = null;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { renderer = null; }
    if (!renderer) {
      document.body.innerHTML = '<div style="font:16px sans-serif;padding:40px">😢 This game needs WebGL.</div>';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // DPR capped for perf
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.touchAction = 'none';
    $('game').appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffe9d2, 36, 80); // subtle depth haze
    const VIEW = 9; // ortho frustum half-height
    const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 0.1, 300);
    const guysRoot = new THREE.Group();
    scene.add(guysRoot);
    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    /* warm ambient + one directional light (no shadow maps — fake blob shadows) */
    const hemi = new THREE.HemisphereLight(0xfff3e0, 0xffd9e0, 0.9);
    const dirLight = new THREE.DirectionalLight(0xfff0dd, 0.95);
    dirLight.position.set(12, 22, 10);
    scene.add(hemi, dirLight);

    /* ---------------- environment: floor, walls, door, coffee, plants ---------------- */
    const makeBox = (w, h, d, color) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: color }));
    const floorMesh = put(new THREE.Mesh(new THREE.PlaneGeometry(19, 19), new THREE.MeshLambertMaterial({ color: 0xf7eedd })), 0, 0, 0);
    floorMesh.rotation.x = -Math.PI / 2; // cream floor
    const grid = new THREE.GridHelper(19, 19, 0xe4cfb2, 0xefe3c9);
    grid.position.y = 0.02; grid.material.transparent = true; grid.material.opacity = 0.4;
    scene.add(grid);
    /* two low pastel walls (they fade out when the camera swings behind them) */
    const wallMatN = new THREE.MeshLambertMaterial({ color: 0xbcd8f0, transparent: true });
    const wallMatW = new THREE.MeshLambertMaterial({ color: 0xf7c9d8, transparent: true });
    put(new THREE.Mesh(new THREE.BoxGeometry(19.6, 2.4, 0.5), wallMatN), 0, 1.2, -9.45);
    put(new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.4, 19.6), wallMatW), -9.45, 1.2, 0);
    const frameMat = new THREE.MeshLambertMaterial({ color: 0xfff4e3, transparent: true });
    const doorMat = new THREE.MeshLambertMaterial({ color: 0xd9a06b, transparent: true });
    const knobMat = new THREE.MeshLambertMaterial({ color: 0xffd23f, transparent: true });
    const westMats = [wallMatW, frameMat, doorMat, knobMat], northMats = [wallMatN];
    /* door marker — where new hires hop in */
    put(new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.3, 1.5), frameMat), -9.12, 1.15, 3);
    put(new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.0, 1.2), doorMat), -9.06, 1.0, 3);
    put(new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), knobMat), -9.0, 0.95, 2.62);
    put(makeBox(1.15, 0.05, 1.5, 0xff8f7a), -8.45, 0.03, 3); // doormat
    const doorRing = put(new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 26),
      new THREE.MeshBasicMaterial({ color: 0xffb5c2, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide })), -7.7, 0.05, 3);
    doorRing.rotation.x = -Math.PI / 2;
    /* coffee machine against the north wall — red box, glowing button */
    const machineGroup = put(new THREE.Group(), 4.6, 0, -8.8);
    put(makeBox(0.95, 1.5, 0.75, 0xe0524a), 0, 0.75, 0, machineGroup);
    put(makeBox(1.0, 0.1, 0.8, 0xc23f38), 0, 1.54, 0, machineGroup);
    put(makeBox(0.66, 0.5, 0.05, 0xfff4e3), 0, 0.95, 0.39, machineGroup);
    put(makeBox(0.16, 0.14, 0.2, 0x3a3a3a), 0, 0.86, 0.33, machineGroup);
    put(makeBox(0.36, 0.05, 0.2, 0x3a3a3a), 0, 0.53, 0.35, machineGroup);
    put(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.15, 10), new THREE.MeshLambertMaterial({ color: 0xffffff })), 0, 0.63, 0.36, machineGroup);
    const coffeeButton = put(new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xffd76b, emissive: 0xff9d2e, emissiveIntensity: 0.8 })), 0.3, 0.95, 0.42, machineGroup);
    /* potted plants (cylinder pot + green cones) scattered around the edges */
    const potGeo = new THREE.CylinderGeometry(0.2, 0.15, 0.3, 10), potMat = new THREE.MeshLambertMaterial({ color: 0xd98a68 });
    const leafGeo = new THREE.ConeGeometry(0.3, 0.8, 9), leafMat = new THREE.MeshLambertMaterial({ color: 0x7ecb6f });
    const leaf2Geo = new THREE.ConeGeometry(0.2, 0.55, 9), leaf2Mat = new THREE.MeshLambertMaterial({ color: 0x9ad98a });
    [[-7.6, -7.6], [7.6, -7.6], [7.6, 7.6], [-7.6, 7.6], [1.6, -7.9], [-7.9, -1.2], [6.9, 1.8]].forEach(p => {
      const g = put(new THREE.Group(), p[0], 0, p[1]); g.rotation.y = Math.random() * Math.PI;
      put(new THREE.Mesh(potGeo, potMat), 0, 0.15, 0, g);
      put(new THREE.Mesh(leafGeo, leafMat), 0, 0.7, 0, g); put(new THREE.Mesh(leaf2Geo, leaf2Mat), 0, 1.15, 0, g);
    });

    /* ---------------- shared geometry & materials (created once!) ---------------- */
    const bodyGeo = new THREE.CapsuleGeometry(0.26, 0.34, 6, 14), headGeo = new THREE.SphereGeometry(0.34, 20, 16);
    const eyeGeo = new THREE.SphereGeometry(0.085, 12, 10), pupilGeo = new THREE.SphereGeometry(0.042, 10, 8);
    const smileGeo = new THREE.TorusGeometry(0.1, 0.022, 6, 16, Math.PI * 0.7), armGeo = new THREE.CapsuleGeometry(0.07, 0.2, 4, 10);
    const guyLegGeo = new THREE.BoxGeometry(0.11, 0.24, 0.11), cheekGeo = new THREE.SphereGeometry(0.05, 10, 8);
    const shadowGeo = new THREE.CircleGeometry(0.42, 18);
    const skinMats = ['#ffe3c8', '#ffd6ba', '#f0bd93'].map(c => new THREE.MeshLambertMaterial({ color: c }));
    const eyeMat = new THREE.MeshLambertMaterial({ color: 0xffffff }), pupilMat = new THREE.MeshBasicMaterial({ color: 0x2b2233 });
    const smileMat = new THREE.MeshBasicMaterial({ color: 0x4a3328 }), cheekMat = new THREE.MeshBasicMaterial({ color: 0xffadb5 });
    const pantsMat = new THREE.MeshLambertMaterial({ color: 0x5a6a85 });
    const shadowMat = new THREE.MeshBasicMaterial({ color: 0x3a2e28, transparent: true, opacity: 0.16, depthWrite: false });
    /* hats — one factory per promotion tier */
    const capMat = new THREE.MeshLambertMaterial({ color: 0x4ea6c9 }), beretMat = new THREE.MeshLambertMaterial({ color: 0xd95763 });
    const brimMat = new THREE.MeshLambertMaterial({ color: 0xb58fd8 }), darkHatMat = new THREE.MeshLambertMaterial({ color: 0x39364a });
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0x6b4f00 });
    const hatDomeGeo = new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), hatBallGeo = new THREE.SphereGeometry(0.3, 14, 10);
    const hatCylGeo = new THREE.CylinderGeometry(0.2, 0.2, 1, 12), hatBandGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.06, 12);
    const hatWideBrimGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.035, 16), hatTopBrimGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.035, 16);
    const hatCapBrimGeo = new THREE.BoxGeometry(0.34, 0.05, 0.24), hatSpikeGeo = new THREE.ConeGeometry(0.05, 0.16, 6);
    const hatFactories = [
      null,
      () => { // 1 · cap
        const h = new THREE.Group();
        put(new THREE.Mesh(hatDomeGeo, capMat), 0, 0, 0, h).scale.y = 0.62;
        put(new THREE.Mesh(hatCapBrimGeo, capMat), 0, -0.01, 0.24, h);
        return h;
      },
      () => { // 2 · beret
        const h = new THREE.Group();
        const b = put(new THREE.Mesh(hatBallGeo, beretMat), 0, 0.05, 0, h);
        b.scale.set(1.06, 0.4, 1.06); b.rotation.z = 0.16;
        put(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.07, 6), beretMat), 0, 0.2, 0, h);
        return h;
      },
      () => { // 3 · wide-brim
        const h = new THREE.Group();
        put(new THREE.Mesh(hatWideBrimGeo, brimMat), 0, 0.05, 0, h);
        put(new THREE.Mesh(hatCylGeo, brimMat), 0, 0.16, 0, h).scale.set(1, 0.2, 1);
        put(new THREE.Mesh(hatBandGeo, beretMat), 0, 0.14, 0, h);
        return h;
      },
      () => { // 4 · top hat
        const h = new THREE.Group();
        put(new THREE.Mesh(hatTopBrimGeo, darkHatMat), 0, 0.04, 0, h);
        put(new THREE.Mesh(hatCylGeo, darkHatMat), 0, 0.3, 0, h).scale.set(1, 0.5, 1);
        put(new THREE.Mesh(hatBandGeo, goldMat), 0, 0.17, 0, h);
        return h;
      },
      () => { // 5 · gold crown (CEO)
        const h = new THREE.Group();
        put(new THREE.Mesh(hatCylGeo, goldMat), 0, 0.06, 0, h).scale.set(1.05, 0.13, 1.05);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          put(new THREE.Mesh(hatSpikeGeo, goldMat), Math.cos(a) * 0.16, 0.17, Math.sin(a) * 0.16, h);
        }
        return h;
      }
    ];

    /* ---------------- desks (auto-added in a grid, up to 16) ---------------- */
    const deskTopGeo = new THREE.BoxGeometry(1.7, 0.1, 1.0), deskLegGeo = new THREE.BoxGeometry(0.09, 1, 0.09);
    const monStandGeo = new THREE.BoxGeometry(0.07, 0.2, 0.07), monGeo = new THREE.BoxGeometry(0.8, 0.55, 0.06);
    const monScreenGeo = new THREE.BoxGeometry(0.7, 0.45, 0.02), kbGeo = new THREE.BoxGeometry(0.55, 0.045, 0.24);
    const mugGeo = new THREE.CylinderGeometry(0.055, 0.05, 0.1, 8);
    const deskMat = new THREE.MeshLambertMaterial({ color: 0xf3d9b1 }), deskLegMat = new THREE.MeshLambertMaterial({ color: 0xb98d5f });
    const monMat = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
    const screenMat = new THREE.MeshLambertMaterial({ color: 0x9ff6ff, emissive: 0x2ec5d8, emissiveIntensity: 0.8 });
    const kbMat = new THREE.MeshLambertMaterial({ color: 0xfaf3e6 }), kbGoldMat = new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0x6b4f00 });
    const mugMats = SHIRT_COLORS.slice(0, 6).map(c => new THREE.MeshLambertMaterial({ color: c }));
    const desks = [];
    const deskSlot = i => ({ x: -3.9 + (i % 4) * 2.6, z: -3.5 + Math.floor(i / 4) * 2.6 });
    const deskSpot = i => { const p = deskSlot(i); return new THREE.Vector3(p.x, 0, p.z + 0.95); }; // guy stands on the near side
    function ensureDesk(i) {
      if (desks[i]) return desks[i];
      const slot = deskSlot(i);
      const d = { group: put(new THREE.Group(), slot.x, 0, slot.z), topGroup: new THREE.Group(), legs: [], kb: null };
      d.group.add(d.topGroup);
      [[-0.72, -0.38], [0.72, -0.38], [-0.72, 0.38], [0.72, 0.38]].forEach(p => {
        d.legs.push(put(new THREE.Mesh(deskLegGeo, deskLegMat), p[0], 0.5, p[1], d.group));
      });
      put(new THREE.Mesh(deskTopGeo, deskMat), 0, 1.0, 0, d.topGroup);
      put(new THREE.Mesh(monStandGeo, monMat), 0, 1.14, -0.26, d.topGroup);
      put(new THREE.Mesh(monGeo, monMat), 0, 1.44, -0.28, d.topGroup).rotation.x = -0.06;
      put(new THREE.Mesh(monScreenGeo, screenMat), 0, 1.44, -0.245, d.topGroup).rotation.x = -0.06;
      d.kb = put(new THREE.Mesh(kbGeo, kbMat), 0, 1.075, 0.28, d.topGroup);
      put(new THREE.Mesh(mugGeo, mugMats[i % mugMats.length]), 0.55, 1.13, 0.18, d.topGroup);
      desks[i] = d;
      applyDeskUpgrade(d);
      return d;
    }
    /* standing desks physically raise the tops; golden keyboards turn gold */
    function applyDeskUpgrade(d) {
      const lift = Math.min(0.75, 0.3 * G.upgrades.standing); d.topGroup.position.y = lift;
      for (const leg of d.legs) { leg.scale.y = 1 + lift; leg.position.y = 0.5 * (1 + lift); }
      d.kb.material = G.upgrades.keyboard > 0 ? kbGoldMat : kbMat;
    }
    function applyAllUpgrades() {
      for (const d of desks) if (d) applyDeskUpgrade(d);
      coffeeButton.material.emissiveIntensity = 0.8 + Math.min(1.5, 0.25 * G.upgrades.espresso);
    }

    /* ---------------- particle pools (confetti, sparkles, steam) ---------------- */
    const confGeo = new THREE.PlaneGeometry(0.14, 0.14);
    const confMats = [0xff6b8a, 0xffd23f, 0x6bd5ff, 0x9dff8a, 0xc79bff, 0xff9f6b]
      .map(c => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    const sparkMats = [0xffd23f, 0xfff3b0, 0x9dff8a].map(c => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    const confetti = [];
    for (let i = 0; i < 90; i++) {
      const m = put(new THREE.Mesh(confGeo, confMats[0]), 0, -10, 0); m.visible = false;
      confetti.push({ mesh: m, active: false, t: 0, life: 1, g: 6, size: 1, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    function burst(pos, count, mats, spread, up, g, life, size) {
      let spawned = 0;
      for (const p of confetti) {
        if (p.active) continue;
        p.active = true; p.t = 0; p.life = life; p.g = g; p.size = size;
        p.mesh.material = mats[(Math.random() * mats.length) | 0];
        p.mesh.position.set(pos.x + rand(-0.1, 0.1), pos.y + rand(-0.1, 0.1), pos.z + rand(-0.1, 0.1));
        p.vel.set(rand(-spread, spread), up * rand(0.5, 1.3), rand(-spread, spread));
        p.spin.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
        p.mesh.visible = true;
        if (++spawned >= count) break;
      }
    }
    const confettiBurst = pos => burst(pos, 30, confMats, 2.4, 3.4, 7, 1.35, 1);     // promotion!
    const sparkleBurst = pos => burst(pos, 8, sparkMats, 0.9, 2.0, -0.6, 0.7, 0.65); // IDEA!
    const cashBurst = pos => burst(pos, 10, sparkMats, 1.2, 2.2, -0.4, 0.8, 0.8);   // motivate!
    function updateConfetti(dt) {
      for (const p of confetti) {
        if (!p.active) continue;
        p.t += dt;
        const k = p.t / p.life;
        if (k >= 1) { p.active = false; p.mesh.visible = false; continue; }
        p.vel.y -= p.g * dt; // little planes with physics
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.rotation.x += p.spin.x * dt; p.mesh.rotation.y += p.spin.y * dt; p.mesh.rotation.z += p.spin.z * dt;
        p.mesh.scale.setScalar(Math.max(0.001, (1 - k) * p.size));
      }
    }
    const steamPool = [];
    for (let i = 0; i < 26; i++) {
      const m = put(new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })), 0, -10, 0);
      m.visible = false; steamPool.push({ mesh: m, active: false, t: 0, life: 1, base: 1, vel: new THREE.Vector3() });
    }
    function steamBurst(pos, n, sizeMul) {
      let spawned = 0;
      for (const p of steamPool) {
        if (p.active) continue;
        p.active = true; p.t = 0; p.life = rand(0.6, 1.0); p.base = rand(0.5, 0.9) * (sizeMul || 1);
        p.mesh.position.set(pos.x + rand(-0.08, 0.08), pos.y, pos.z + rand(-0.08, 0.08));
        p.vel.set(rand(-0.15, 0.15), rand(0.55, 0.95), rand(-0.15, 0.15));
        p.mesh.visible = true;
        if (++spawned >= n) break;
      }
    }
    function updateSteam(dt) {
      for (const p of steamPool) {
        if (!p.active) continue;
        p.t += dt;
        const k = p.t / p.life;
        if (k >= 1) { p.active = false; p.mesh.visible = false; continue; }
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.scale.setScalar(p.base * (0.6 + k * 1.7));
        p.mesh.material.opacity = 0.5 * (1 - k);
      }
    }
    /* click ripple ring on the floor */
    const ripple = put(new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 26),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })), 0, 0.06, 0);
    ripple.rotation.x = -Math.PI / 2;
    let rippleT = 1;
    const playRipple = pos => { ripple.position.set(pos.x, 0.06, pos.z); rippleT = 0; };
    function updateRipple(dt) {
      if (rippleT >= 0.7) { ripple.material.opacity = 0; return; }
      rippleT += dt;
      const k = rippleT / 0.7;
      ripple.scale.setScalar(0.5 + k * 2.2);
      ripple.material.opacity = 0.55 * (1 - k);
    }
    /* selection ring under the chosen guy */
    const selRing = put(new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })), 0, 0.05, 0);
    selRing.rotation.x = -Math.PI / 2;
    selRing.visible = false;

    /* ---------------- floating DOM labels (pooled, 3D→2D projected) ---------------- */
    const _proj = new THREE.Vector3();
    const worldToScreen = p => {
      _proj.copy(p).project(camera);
      return { x: (_proj.x * 0.5 + 0.5) * window.innerWidth, y: (-_proj.y * 0.5 + 0.5) * window.innerHeight };
    };
    const labelPool = [];
    for (let i = 0; i < 36; i++) {
      const el = document.createElement('div');
      el.className = 'flabel'; el.style.display = 'none'; $('labels').appendChild(el);
      labelPool.push({ el: el, active: false, t: 0, x: 0, y: 0 });
    }
    function spawnLabel(text, x, y, cls) {
      const l = labelPool.find(p => !p.active) || labelPool[0];
      l.active = true; l.t = 0; l.x = x; l.y = y;
      l.el.textContent = text;
      l.el.className = 'flabel ' + (cls || '');
      l.el.style.display = 'block'; l.el.style.opacity = '1';
    }
    const spawnLabelWorld = (text, wp, cls) => { const s = worldToScreen(wp); spawnLabel(text, s.x, s.y, cls); };
    function updateLabels(dt) {
      for (const l of labelPool) {
        if (!l.active) continue;
        l.t += dt;
        if (l.t >= 1) { l.active = false; l.el.style.display = 'none'; continue; } // rise + fade over 1s
        l.y -= 60 * dt;
        l.el.style.opacity = String(1 - l.t * l.t);
        l.el.style.transform = 'translate(' + l.x + 'px,' + l.y + 'px) translate(-50%, -100%)';
      }
    }

    /* ---------------- the guys ---------------- */
    const guys = [];
    const COFFEE_SPOT = new THREE.Vector3(4.6, 0, -7.45), DOOR_SPOT = new THREE.Vector3(-8.2, 0, 3);
    const DOOR_TOP = new THREE.Vector3(-8.2, 2.3, 3), STEAM_POINT = new THREE.Vector3(4.6, 0.8, -8.42);
    const GOLD_COLOR = new THREE.Color(0xffd23f), WHITE_COLOR = new THREE.Color(0xffffff);
    const _tmpColor = new THREE.Color(), _hp = new THREE.Vector3();
    const isCaf = (g, nowMs) => g.s.caffeinatedUntil > nowMs;
    const headTop = g => _hp.set(g.group.position.x, g.group.position.y + 2.05, g.group.position.z);

    function makeEye(x) {
      const eye = new THREE.Group();
      eye.position.set(x, 0.06, 0.27);
      eye.add(new THREE.Mesh(eyeGeo, eyeMat)); // big white
      const pupil = new THREE.Mesh(pupilGeo, pupilMat); // black pupil
      pupil.position.set(0, 0.008, 0.058); eye.add(pupil);
      return eye;
    }

    function buildGuyMesh(g) {
      const group = new THREE.Group(), rig = new THREE.Group();
      group.add(rig);
      /* fake blob shadow stays on the floor while the rig hops */
      g.shadow = put(new THREE.Mesh(shadowGeo, shadowMat), 0, 0.02, 0, group);
      g.shadow.rotation.x = -Math.PI / 2;
      for (const sx of [-1, 1]) put(new THREE.Mesh(guyLegGeo, pantsMat), sx * 0.1, 0.12, 0, rig); // stub legs
      g.bodyMat = new THREE.MeshLambertMaterial({ color: g.s.color }); // pastel shirt (per-guy)
      put(new THREE.Mesh(bodyGeo, g.bodyMat), 0, 0.67, 0, rig);
      /* stub arms on shoulder pivots (they oscillate while typing) */
      g.armL = new THREE.Group(); g.armL.position.set(-0.31, 0.82, 0); g.armL.rotation.z = 0.12;
      g.armR = new THREE.Group(); g.armR.position.set(0.31, 0.82, 0); g.armR.rotation.z = -0.12;
      for (const pivot of [g.armL, g.armR]) { put(new THREE.Mesh(armGeo, g.bodyMat), 0, -0.15, 0, pivot); rig.add(pivot); }
      /* BIG head (~60% of body) with eyes, cheeks and a tiny torus smile */
      g.headGrp = put(new THREE.Group(), 0, 1.38, 0, rig);
      g.headGrp.add(new THREE.Mesh(headGeo, skinMats[(Math.random() * skinMats.length) | 0]));
      g.eyeL = makeEye(-0.13); g.eyeR = makeEye(0.13);
      g.headGrp.add(g.eyeL, g.eyeR);
      for (const sx of [-1, 1]) put(new THREE.Mesh(cheekGeo, cheekMat), sx * 0.225, -0.07, 0.245, g.headGrp).scale.set(1, 0.65, 0.45);
      const smile = put(new THREE.Mesh(smileGeo, smileMat), 0, -0.13, 0.30, g.headGrp);
      smile.rotation.z = -Math.PI / 2 - Math.PI * 0.35; // bottom arc = ⌣
      g.hatHolder = put(new THREE.Group(), 0, 0.3, 0, g.headGrp);
      g.group = group; g.rig = rig;
      group.traverse(o => { o.userData.guy = g; o.userData.guyId = g.id; }); guysRoot.add(group); // tag for tap raycasts
    }

    /* shirt lerps gold at high tiers, brightens while caffeinated; hats swap per tier */
    function applyGuyLook(g) {
      const tier = hatTierForLevel(g.s.level);
      if (tier !== g.hatTier) {
        if (g.hat) g.hatHolder.remove(g.hat);
        g.hat = hatFactories[tier] ? hatFactories[tier]() : null;
        if (g.hat) g.hatHolder.add(g.hat);
        g.hatTier = tier;
      }
      _tmpColor.set(g.s.color);
      const goldT = Math.min(1, g.s.level / 9) * 0.85;
      if (goldT > 0) _tmpColor.lerp(GOLD_COLOR, goldT);
      if (g.s.caffeinatedUntil > Date.now()) _tmpColor.lerp(WHITE_COLOR, 0.22);
      g.bodyMat.color.copy(_tmpColor);
    }

    function spawnGuy(s, fromDoor) {
      const g = {
        s: s, id: G.guys.indexOf(s), mode: 'working', spawnT: 0, walkPhase: Math.random() * 6,
        ideaTimer: rand(5, 10), coffeeTimer: rand(60, 120),
        blinkTimer: rand(2, 6), blinkT: 0, jumpT: 0, drinkT: 0,
        steamTimer: rand(1, 2), facePhase: Math.random() * 10,
        target: new THREE.Vector3(), hatTier: -1, hat: null,
        cafState: s.caffeinatedUntil > Date.now()
      };
      buildGuyMesh(g);
      applyGuyLook(g);
      if (fromDoor) { // hops in at the door, walks to his desk
        g.mode = 'entering';
        g.group.position.set(DOOR_SPOT.x, 0, DOOR_SPOT.z);
        g.target.copy(deskSpot(s.desk));
        g.spawnT = 0.45;
      } else {
        const p = deskSpot(s.desk);
        g.group.position.set(p.x, 0, p.z);
        g.group.rotation.y = Math.PI;
      }
      guys.push(g);
      return g;
    }

    /* ---------------- guy behaviour ---------------- */
    function angleDelta(a, b) {
      let d = b - a;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return d;
    }
    function arrive(g) {
      if (g.mode === 'toCoffee') {
        g.mode = 'drinking'; g.drinkT = 1.0; g.group.rotation.y = Math.PI;
        Sfx.slurp(); steamBurst(STEAM_POINT, 4, 0.8); // 1s coffee pause
      } else { // entering / toDesk → back to the desk
        g.mode = 'working'; g.group.rotation.y = Math.PI;
        g.rig.position.y = 0; g.rig.scale.copy(ONE_VEC); g.shadow.scale.setScalar(1);
        g.ideaTimer = rand(4, 9); g.coffeeTimer = rand(60, 120);
      }
    }
    function walkStep(g, dt) {
      const speed = 1.8 * walkSpeedMult(G.upgrades.gym);
      const dx = g.target.x - g.group.position.x, dz = g.target.z - g.group.position.z;
      const dist = Math.hypot(dx, dz), step = speed * dt;
      if (dist <= step || dist < 0.001) {
        g.group.position.x = g.target.x; g.group.position.z = g.target.z;
        arrive(g); return;
      }
      g.group.position.x += (dx / dist) * step;
      g.group.position.z += (dz / dist) * step;
      g.group.rotation.y += angleDelta(g.group.rotation.y, Math.atan2(dx, dz)) * Math.min(1, dt * 10);
      g.walkPhase += dt * 11; // hop lerp
      const h = Math.abs(Math.sin(g.walkPhase));
      g.rig.position.y = h * 0.24; // squash-stretch on each hop
      g.rig.scale.set(1.06 - 0.14 * h, 0.9 + 0.2 * h, 1.06 - 0.14 * h);
      g.shadow.scale.setScalar(1 - 0.3 * h);
      g.armL.rotation.x = Math.sin(g.walkPhase) * 0.6;
      g.armR.rotation.x = -Math.sin(g.walkPhase) * 0.6;
    }
    function doIdea(g, nowMs) {
      const inc = guyIncomePerSec(g.s.level, G.upgrades, isCaf(g, nowMs));
      const bonus = Math.max(1, inc * 2);
      G.money += bonus; gainXp(g, 5);
      g.jumpT = 0.45; sparkleBurst(headTop(g)); // little jump + yellow sparkles
      spawnLabelWorld('+$' + Math.round(bonus), headTop(g), 'gold');
      Sfx.coin(); bumpMoney();
    }
    function workUpdate(g, dt, t, nowMs) {
      g.armL.rotation.x = -0.55 + Math.sin(t * 21 + g.facePhase) * 0.5; // fast typing
      g.armR.rotation.x = -0.55 + Math.sin(t * 21 + g.facePhase + 1.3) * 0.5;
      g.headGrp.position.y = 1.38 + Math.sin(t * 3.1 + g.facePhase) * 0.028; // head bob
      g.rig.position.y = 0;
      g.rig.scale.lerp(ONE_VEC, Math.min(1, dt * 8));
      if (g.jumpT > 0) { // idea jump override
        g.jumpT -= dt;
        const k = 1 - Math.max(0, g.jumpT) / 0.45, j = Math.sin(k * Math.PI);
        g.rig.position.y = j * 0.34;
        g.rig.scale.set(1 + 0.08 * j, 1 + 0.14 * j, 1 + 0.08 * j);
      }
      g.ideaTimer -= dt;
      if (g.ideaTimer <= 0) { g.ideaTimer = rand(7, 11); doIdea(g, nowMs); } // IDEA! every ~8s
      if (!isCaf(g, nowMs)) {
        g.coffeeTimer -= dt;
        if (g.coffeeTimer <= 0) { g.mode = 'toCoffee'; g.target.copy(COFFEE_SPOT); }
      }
      if (isCaf(g, nowMs)) { // steam puffs while caffeinated
        g.steamTimer -= dt;
        if (g.steamTimer <= 0) { g.steamTimer = rand(1.6, 2.6); steamBurst(headTop(g), 1, 0.5); }
      }
    }
    function drinkUpdate(g, dt, t) {
      g.armL.rotation.x = g.armR.rotation.x = -1.25; // hands up, holding the cup
      g.rig.position.y = Math.abs(Math.sin(t * 8)) * 0.04;
      g.steamTimer -= dt;
      if (g.steamTimer <= 0) { g.steamTimer = 0.22; steamBurst(STEAM_POINT, 1, 0.6); }
      g.drinkT -= dt;
      if (g.drinkT <= 0) { // caffeinated! ×1.5 income for a while
        g.s.caffeinatedUntil = Date.now() + coffeeDurationSec(G.upgrades.gym) * 1000;
        g.mode = 'toDesk'; g.target.copy(deskSpot(g.s.desk));
      }
    }
    function updateGuys(dt, t, nowMs) {
      for (const g of guys) {
        if (g.spawnT > 0) { // spawn pop-in (ease-out-back)
          g.spawnT -= dt;
          const k = clamp(1 - Math.max(0, g.spawnT) / 0.45, 0, 1);
          const c1 = 1.70158, c3 = c1 + 1;
          const e = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
          g.group.scale.setScalar(Math.max(0.05, 0.25 + 0.75 * e));
          if (g.spawnT <= 0) g.group.scale.setScalar(1);
        }
        g.blinkTimer -= dt; // random blink every 2-6s
        if (g.blinkTimer <= 0) { g.blinkTimer = rand(2, 6); g.blinkT = 0.13; }
        if (g.blinkT > 0) {
          g.blinkT -= dt;
          const s = g.blinkT > 0 ? 0.1 : 1; // scale Y to 0.1 briefly
          g.eyeL.scale.y = s; g.eyeR.scale.y = s;
        }
        if (g.mode === 'working') workUpdate(g, dt, t, nowMs);
        else if (g.mode === 'drinking') drinkUpdate(g, dt, t);
        else walkStep(g, dt); // entering · toCoffee · toDesk
      }
    }

    /* ---------------- XP + promotion ---------------- */
    function gainXp(g, amt) {
      g.s.xp += amt;
      let need = xpNeeded(g.s.level);
      while (g.s.xp >= need) {
        g.s.xp -= need; g.s.level++;
        promoteFx(g); need = xpNeeded(g.s.level);
      }
    }
    function promoteFx(g) {
      confettiBurst(headTop(g)); Sfx.fanfare(); // confetti + ascending arpeggio
      spawnLabelWorld('LEVEL UP! 🎉 ' + titleForLevel(g.s.level), headTop(g), 'pink');
      applyGuyLook(g); // new hat + gold-lerped shirt
      bumpMoney();
      save();
    }

    /* ---------------- custom orbit camera (no OrbitControls) ---------------- */
    const camCtl = { az: 0.55, pol: 0.95, zoom: 0.55, targetZoom: 0.95, last: performance.now() };
    function updateCamera(dt) {
      if (performance.now() - camCtl.last > 10000) camCtl.az += dt * 0.1; // idle auto-rotate
      camCtl.zoom += (camCtl.targetZoom - camCtl.zoom) * Math.min(1, dt * 6);
      const sp = Math.sin(camCtl.pol);
      camera.position.set(46 * sp * Math.sin(camCtl.az), 46 * Math.cos(camCtl.pol) + 2, 46 * sp * Math.cos(camCtl.az));
      camera.lookAt(0, 0.6, 0);
      camera.zoom = camCtl.zoom; camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', () => {
      const w = window.innerWidth, h = window.innerHeight, aspect = w / h;
      camera.left = -VIEW * aspect; camera.right = VIEW * aspect; camera.top = VIEW; camera.bottom = -VIEW;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });

    /* ---------------- input: orbit drag, pinch zoom, taps ---------------- */
    const cvs = renderer.domElement;
    const activePtrs = new Map(); // pointerId → {x, y, sx, sy, t}
    let pinchPrev = 0, multiTouch = false;
    cvs.addEventListener('pointerdown', e => {
      Sfx.ensure();
      activePtrs.set(e.pointerId, {
        x: e.clientX, y: e.clientY,          // live position (drag/pinch math)
        sx: e.clientX, sy: e.clientY,        // start position (tap classifier)
        t: performance.now()                // start time (tap classifier)
      });
      if (activePtrs.size >= 2) multiTouch = true; // a second finger kills the tap
      pinchPrev = 0;
      camCtl.last = performance.now();
    });
    window.addEventListener('pointermove', e => {
      const p = activePtrs.get(e.pointerId);
      if (!p) { hoverCursor(e); return; }
      if (activePtrs.size >= 2) { // two fingers → pinch zoom (pure math)
        p.x = e.clientX; p.y = e.clientY;
        const pts = Array.from(activePtrs.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchPrev > 0) camCtl.targetZoom = applyPinchZoom(camCtl.targetZoom, pinchPrev, d);
        pinchPrev = d;
      } else { // one finger / mouse → orbit (pure math)
        applyOrbitDelta(camCtl, e.clientX - p.x, e.clientY - p.y);
        p.x = e.clientX; p.y = e.clientY;
      }
      camCtl.last = performance.now();
    });
    window.addEventListener('pointerup', e => {
      const p = activePtrs.get(e.pointerId);
      if (!p) return;
      activePtrs.delete(e.pointerId); pinchPrev = 0;
      if (activePtrs.size === 0) { // last finger up: tap or drag? (pure classifier)
        const gesture = multiTouch ? 'drag'
          : classifyGesture(e.clientX - p.sx, e.clientY - p.sy, performance.now() - p.t);
        multiTouch = false;
        if (gesture === 'tap') handleClick(e); // select a guy / motivate the floor
      }
    });
    window.addEventListener('pointercancel', e => {
      activePtrs.delete(e.pointerId); pinchPrev = 0;
      if (activePtrs.size === 0) multiTouch = false;
    });
    cvs.addEventListener('wheel', e => { // wheel zooms the ortho camera
      e.preventDefault();
      camCtl.targetZoom = clamp(camCtl.targetZoom * Math.exp(-e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
      camCtl.last = performance.now();
    }, { passive: false });
    cvs.addEventListener('contextmenu', e => e.preventDefault());
    let hoverT = 0;
    const _ndc = new THREE.Vector2();
    function hoverCursor(e) {
      const now = performance.now();
      if (now - hoverT < 120) return;
      hoverT = now;
      _ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(_ndc, camera);
      cvs.style.cursor = raycaster.intersectObjects(guysRoot.children, true).length ? 'pointer' : 'grab';
    }
    const guyById = id => guys.find(g => g.id === id);
    function handleClick(e) {
      // 1) tap a lil guy? (pure pick: client px → NDC → raycast → guy id)
      const id = pickGuy(e.clientX, e.clientY, window.innerWidth, window.innerHeight,
        camera, raycaster, guysRoot.children);
      if (id !== null) {
        const g = guyById(id);
        if (g) { select(g); Sfx.pop(); return; }
      }
      const pt = new THREE.Vector3(); // 2) empty floor → motivate!
      if (raycaster.ray.intersectPlane(groundPlane, pt) && Math.abs(pt.x) < 9.4 && Math.abs(pt.z) < 9.4) {
        motivate(pt, e.clientX, e.clientY);
      }
    }
    let lastMotivate = 0;
    function motivate(pt, sx, sy) {
      const nowPerf = performance.now();
      if (nowPerf - lastMotivate < 500) return; // 0.5s cooldown
      lastMotivate = nowPerf;
      const val = clickBonusValue(totalIncomePerSec(G.guys, G.upgrades, Date.now()), G.upgrades.keyboard);
      G.money += val;
      cashBurst(new THREE.Vector3(pt.x, 0.4, pt.z));
      playRipple(pt); spawnLabel('+$' + Math.round(val), sx, sy, 'green');
      Sfx.pop(); bumpMoney();
    }

    /* ---------------- day ↔ night (120s cycle) ---------------- */
    const DAY_BG = new THREE.Color(0xffe9d2), NIGHT_BG = new THREE.Color(0x3a3560);
    const DAY_LIGHT = new THREE.Color(0xfff0dd), NIGHT_LIGHT = new THREE.Color(0xbfc8ff);
    const bgColor = new THREE.Color();
    scene.background = bgColor;
    function updateDayNight(t) {
      const k = 0.5 + 0.5 * Math.cos((t / 120) * Math.PI * 2); // 1 = full day
      bgColor.lerpColors(NIGHT_BG, DAY_BG, k); scene.fog.color.copy(bgColor);
      dirLight.color.lerpColors(NIGHT_LIGHT, DAY_LIGHT, k);
      dirLight.intensity = 0.5 + 0.5 * k; hemi.intensity = 0.55 + 0.35 * k;
      screenMat.emissiveIntensity = 0.7 + (1 - k) * 0.8; // monitors glow at night
    }

    /* ---------------- ambience (pulses, wall fades, selection ring) ---------------- */
    const fadeMats = (mats, target, dt) => { for (const m of mats) m.opacity += (target - m.opacity) * Math.min(1, dt * 6); };
    function updateAmbience(dt, t) {
      coffeeButton.scale.setScalar(1 + Math.sin(t * 5) * 0.12); // glowing button pulse
      doorRing.scale.setScalar(1 + Math.sin(t * 2.6) * 0.1); doorRing.material.opacity = 0.35 + Math.sin(t * 2.6) * 0.18;
      fadeMats(westMats, camera.position.x < -9.2 ? 0.12 : 1, dt);
      fadeMats(northMats, camera.position.z < -9.2 ? 0.12 : 1, dt);
      if (selected) {
        selRing.visible = true;
        selRing.position.set(selected.group.position.x, 0.05, selected.group.position.z);
        selRing.scale.setScalar(1 + Math.sin(t * 5) * 0.08);
      } else selRing.visible = false;
    }

    /* ---------------- UI ---------------- */
    const moneyEl = $('money'), incomeEl = $('income'), hireBtn = $('hire-btn');
    const hireCostEl = $('hire-cost'), panel = $('panel'), modal = $('modal'), muteBtn = $('mute-btn');
    let selected = null;
    const bumpMoney = () => {
      moneyEl.classList.remove('bump');
      void moneyEl.offsetWidth; // restart the animation
      moneyEl.classList.add('bump');
    };
    const upEls = {};
    for (const def of UPGRADE_DEFS) {
      const el = document.querySelector('[data-up="' + def.id + '"]');
      upEls[def.id] = el;
      el.addEventListener('click', () => { Sfx.ensure(); buyUpgrade(def); });
    }
    hireBtn.addEventListener('click', () => { Sfx.ensure(); hire(); });
    $('panel-close').addEventListener('click', () => deselect());
    muteBtn.addEventListener('click', () => {
      G.muted = !G.muted; muteBtn.textContent = G.muted ? '🔇' : '🔊';
      Sfx.ensure(); save();
    });
    $('reset-btn').addEventListener('click', () => {
      if (window.confirm('Fire everyone and start over? This wipes your save. 😢')) {
        try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* nothing saved */ }
        window.removeEventListener('beforeunload', save);
        window.location.reload();
      }
    });
    function updateButtons() {
      const full = G.guys.length >= MAX_GUYS, cost = hireCost(G.guys.length);
      hireBtn.classList.toggle('disabled', full || G.money < cost);
      hireBtn.querySelector('.hire-txt').textContent = full ? 'OFFICE FULL 🏢' : '+ HIRE 😊';
      hireCostEl.textContent = full ? '—' : fmtMoney(cost);
      for (const def of UPGRADE_DEFS) {
        const el = upEls[def.id], lvl = G.upgrades[def.id], c = upgradeCost(def.base, lvl);
        el.querySelector('.up-lvl').textContent = 'Lv ' + lvl;
        el.querySelector('.up-cost').textContent = fmtMoney(c); el.classList.toggle('disabled', G.money < c);
      }
    }
    const select = g => { selected = g; panel.classList.remove('hidden'); };
    const deselect = () => { selected = null; panel.classList.add('hidden'); };
    function refreshPanel() {
      if (!selected) return;
      const g = selected, nowMs = Date.now(), caf = g.s.caffeinatedUntil > nowMs;
      $('p-portrait').style.background = g.s.color;
      $('p-name').textContent = g.s.name;
      $('p-title').textContent = HAT_EMOJI[hatTierForLevel(g.s.level)] + ' ' + titleForLevel(g.s.level) + ' · Lv ' + g.s.level;
      const need = xpNeeded(g.s.level);
      $('p-xp').style.width = clamp((g.s.xp / need) * 100, 0, 100) + '%';
      $('p-xp-text').textContent = g.s.level >= TITLES.length - 1 ? 'runs the company — still grinding ✨'
        : Math.floor(g.s.xp) + ' / ' + Math.ceil(need) + ' XP → ' + titleForLevel(g.s.level + 1);
      $('p-income').textContent = fmtIncome(guyIncomePerSec(g.s.level, G.upgrades, caf)) + '/sec';
      $('p-coffee').textContent = caf ? '☕ BUZZIN\' (' + Math.ceil((g.s.caffeinatedUntil - nowMs) / 1000) + 's)' : '😴 sleepy';
    }

    /* ---------------- hiring & upgrades ---------------- */
    function hire() {
      const full = G.guys.length >= MAX_GUYS, cost = hireCost(G.guys.length);
      if (full || G.money < cost) return;
      G.money -= cost;
      const s = makeGuyState(pickName(G.guys.map(x => x.name)), pickColor(G.guys.map(x => x.color)), G.guys.length);
      G.guys.push(s);
      ensureDesk(s.desk); // desks auto-added in the grid
      spawnGuy(s, true);
      sparkleBurst(DOOR_TOP); spawnLabelWorld(s.name + ' joined! 💼', DOOR_TOP, 'blue');
      Sfx.hire(); bumpMoney();
      updateButtons(); save();
    }
    function buyUpgrade(def) {
      const lvl = G.upgrades[def.id], cost = upgradeCost(def.base, lvl);
      if (G.money < cost) return;
      G.money -= cost; G.upgrades[def.id] = lvl + 1;
      Sfx.coin(); bumpMoney();
      applyAllUpgrades(); updateButtons(); save();
    }

    /* ---------------- save / load / offline ---------------- */
    function save() {
      try {
        G.lastSeen = Date.now(); localStorage.setItem(SAVE_KEY, saveSerialize(G));
      } catch (e) { /* storage may be unavailable on file:// */ }
    }
    setInterval(save, 10000);
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    let raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { raw = null; }
    const G = saveDeserialize(raw);
    if (!G.guys.length) G.guys.push(makeGuyState(pickName([]), pickColor([]), 0)); // first guy is free!
    /* offline earnings (only if there was a previous save) */
    let offlineAmount = 0, offlineDur = 0;
    if (raw && G.lastSeen) {
      const nowMs = Date.now();
      offlineAmount = offlineEarnings(G.lastSeen, nowMs, totalIncomePerSec(G.guys, G.upgrades, nowMs));
      offlineDur = Math.min(nowMs - G.lastSeen, OFFLINE_CAP_MS);
      if (offlineAmount < 1 || offlineDur < 60000) offlineAmount = 0;
    }
    function claimOffline() {
      if (offlineAmount <= 0) return;
      G.money += offlineAmount; offlineAmount = 0;
      modal.classList.add('hidden'); confettiBurst(new THREE.Vector3(0, 1.6, 0));
      Sfx.coin(); bumpMoney(); save();
    }
    $('claim-btn').addEventListener('click', () => { Sfx.ensure(); claimOffline(); });
    modal.addEventListener('click', e => { if (e.target === modal) claimOffline(); });
    if (offlineAmount > 0) { // "WHILE YOU WERE GONE 💤"
      const mins = Math.floor(offlineDur / 60000);
      $('modal-text').textContent = 'Your lil guys kept hustling for ' +
        (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' min') + ' while you were away. They saved up:';
      $('modal-amount').textContent = '+' + fmtMoney(offlineAmount);
      setTimeout(() => modal.classList.remove('hidden'), 700);
    }
    /* build the world from state */
    for (const s of G.guys) { ensureDesk(s.desk); spawnGuy(s, false); }
    applyAllUpgrades(); muteBtn.textContent = G.muted ? '🔇' : '🔊';
    updateButtons(); save();

    /* ---------------- main loop ---------------- */
    let lastFrame = performance.now(), lastAccrue = Date.now(), uiAcc = 0, bumpAcc = 0;
    function loop() {
      requestAnimationFrame(loop);
      const nowPerf = performance.now();
      const dt = Math.min((nowPerf - lastFrame) / 1000, 0.1); // animation dt (clamped)
      lastFrame = nowPerf;
      const nowMs = Date.now();
      const elapsed = Math.min((nowMs - lastAccrue) / 1000, OFFLINE_CAP_MS / 1000); // economy dt (covers hidden tabs)
      lastAccrue = nowMs;
      const t = nowPerf / 1000;
      /* economy: income accrues for everyone; XP fills while typing */
      let inc = 0;
      for (const g of guys) {
        const caf = isCaf(g, nowMs);
        inc += guyIncomePerSec(g.s.level, G.upgrades, caf);
        if (g.mode === 'working') gainXp(g, (caf ? 1.5 : 1) * dt);
        if (g.cafState !== caf) { g.cafState = caf; applyGuyLook(g); } // shirt tint on/off
      }
      G.money += inc * elapsed;
      updateCamera(dt);
      updateGuys(dt, t, nowMs);
      updateConfetti(dt); updateSteam(dt); updateRipple(dt); updateLabels(dt);
      updateAmbience(dt, t); updateDayNight(t);
      /* HUD */
      moneyEl.textContent = fmtMoney(G.money);
      bumpAcc += dt;
      if (inc > 0 && bumpAcc > 1) { bumpAcc = 0; bumpMoney(); } // gentle 1s tick
      uiAcc += dt;
      if (uiAcc > 0.25) {
        uiAcc = 0;
        incomeEl.textContent = '+' + fmtIncome(inc) + '/sec'; updateButtons();
      }
      if (selected) refreshPanel();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  })();
}
