/* VIRAL ARCADE — shared/mobile-controls.js
 * Creative SVG analog joystick + glass touch buttons for mobile play.
 * Plain script, global `MC`. Pure math core is node-testable; DOM layer is
 * guarded so `node mobile-controls.js` runs the self-test.
 */
var MC = (typeof globalThis.MC !== 'undefined') ? globalThis.MC : (globalThis.MC = {});
MC.version = '1.0';

/* ================================================================
 * PURE MATH / LOGIC (node-testable)
 * ================================================================ */

/* Analog vector from raw pointer offset.
 * Returns {x, y, mag}: direction * tilt, tilt 0..1 (dead zone respected). */
MC.clampVec = function (dx, dy, radius, dead) {
  radius = radius || 50;
  dead = dead || 0;
  var len = Math.hypot(dx, dy);
  if (len <= dead) return { x: 0, y: 0, mag: 0 };
  var cl = Math.min(len, radius);
  var nx = dx / len, ny = dy / len;
  var t = cl / radius;
  return { x: nx * t, y: ny * t, mag: t };
};

/* Angle (radians) from (px,py) to the NEAREST target in range, else null.
 * targets: [{x, y}, ...] */
MC.autoAimAngle = function (px, py, targets, maxRange) {
  if (!targets || targets.length === 0) return null;
  var mr = (maxRange === undefined) ? Infinity : maxRange;
  var best = null, bd = mr * mr;
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    if (!t) continue;
    var dx = t.x - px, dy = t.y - py;
    var d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = t; }
  }
  return best ? Math.atan2(best.y - py, best.x - px) : null;
};

/* Touch device detection given a navigator-like object. */
MC.isTouchDevice = function (nav) {
  if (!nav) return false;
  if ((nav.maxTouchPoints || 0) > 0) return true;
  if ((nav.msMaxTouchPoints || 0) > 0) return true;
  var ua = nav.userAgent || '';
  return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(ua);
};

/* Button state machine (shared by real buttons and tests) */
MC._btns = {};
MC._btnFSM = {
  down: function (id) {
    var b = MC._btns[id];
    if (!b) return false;
    if (b.down) return true;          /* idempotent */
    b.down = true;
    return true;
  },
  up: function (id) {
    var b = MC._btns[id];
    if (!b) return false;
    b.down = false;
    return true;
  },
  isDown: function (id) { return !!(MC._btns[id] && MC._btns[id].down); },
  register: function (id) {
    if (!MC._btns[id]) MC._btns[id] = { down: false };
    return MC._btns[id];
  }
};

/* ================================================================
 * DOM LAYER (guarded)
 * ================================================================ */
MC.SVGNS = 'http://www.w3.org/2000/svg';
MC._uid = 0;

if (typeof document !== 'undefined') {

  /* ---------- SVG analog joystick ---------- */
  MC.createJoystick = function (o) {
    o = o || {};
    var host = o.container;
    if (!host) return null;
    var size = o.size || 132;
    var uid = 'mcj' + (++MC._uid);
    var svg = document.createElementNS(MC.SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.style.touchAction = 'none';
    svg.style.webkitUserSelect = 'none';
    svg.style.userSelect = 'none';
    svg.innerHTML =
      '<defs>' +
      '<radialGradient id="' + uid + 'ring" cx="50%" cy="40%" r="68%">' +
      '<stop offset="0%" stop-color="rgba(255,255,255,0.10)"/>' +
      '<stop offset="70%" stop-color="rgba(12,12,28,0.55)"/>' +
      '<stop offset="100%" stop-color="rgba(4,4,14,0.78)"/>' +
      '</radialGradient>' +
      '<linearGradient id="' + uid + 'stk" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#7de8ff" stop-opacity="0.95"/>' +
      '<stop offset="100%" stop-color="#d0a8ff" stop-opacity="0.45"/>' +
      '</linearGradient>' +
      '<radialGradient id="' + uid + 'knob" cx="38%" cy="30%" r="80%">' +
      '<stop offset="0%" stop-color="#f2f6ff"/>' +
      '<stop offset="55%" stop-color="#a4b8dc"/>' +
      '<stop offset="100%" stop-color="#4c5a86"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<circle cx="50" cy="50" r="47" fill="url(#' + uid + 'ring)" stroke="url(#' + uid + 'stk)" stroke-width="1.7"/>' +
      '<circle cx="50" cy="50" r="31" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="0.8" stroke-dasharray="2.5 3"/>' +
      '<path d="M50 7 l4 7 h-8z" fill="rgba(255,255,255,0.16)"/>' +
      '<path d="M50 93 l4 -7 h-8z" fill="rgba(255,255,255,0.16)"/>' +
      '<path d="M7 50 l7 -4 v8z" fill="rgba(255,255,255,0.16)"/>' +
      '<path d="M93 50 l-7 -4 v8z" fill="rgba(255,255,255,0.16)"/>' +
      '<circle id="' + uid + 'halo" cx="50" cy="50" r="25" fill="#7de8ff" opacity="0"/>' +
      '<g id="' + uid + 'knobg">' +
      '<circle cx="50" cy="50" r="17.5" fill="url(#' + uid + 'knob)" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>' +
      '<circle cx="50" cy="50" r="9" fill="rgba(8,10,20,0.35)"/>' +
      '<circle cx="45.4" cy="45.2" r="2.7" fill="rgba(255,255,255,0.75)"/>' +
      '<circle cx="54.6" cy="45.2" r="2.7" fill="rgba(255,255,255,0.75)"/>' +
      '<path d="M46 54 q4 3.4 8 0" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
      '</g>';
    host.appendChild(svg);
    var knob = svg.querySelector('#' + uid + 'knobg');
    var halo = svg.querySelector('#' + uid + 'halo');
    var SPRING = 'transform .22s cubic-bezier(.18,1.7,.4,1)';
    var R = 33;                 /* max knob travel, viewBox units */
    var pid = null;

    knob.style.transition = SPRING;
    knob.style.willChange = 'transform';

    function setKnob(kx, ky) {
      knob.setAttribute('transform', 'translate(' + kx.toFixed(1) + ',' + ky.toFixed(1) + ')');
      var m = Math.min(1, Math.hypot(kx, ky) / R);
      halo.setAttribute('opacity', String(m * 0.4));
    }
    function toLocal(e) {
      var r = svg.getBoundingClientRect();
      /* headless-safe: fall back to client coords if rect is 0 */
      var w = r.width || 100, h = r.height || 100;
      return {
        x: (((e.clientX || 0) - r.left) / w) * 100,
        y: (((e.clientY || 0) - r.top) / h) * 100
      };
    }
    function update(e) {
      var p = toLocal(e);
      var dx = p.x - 50, dy = p.y - 50;
      var len = Math.hypot(dx, dy);
      var kx = dx, ky = dy;
      if (len > R) { kx = dx / len * R; ky = dy / len * R; }
      setKnob(kx, ky);
      var v = MC.clampVec(dx, dy, R, 7);
      if (o.onMove) o.onMove(v);
    }
    svg.addEventListener('pointerdown', function (e) {
      if (pid !== null) return;
      pid = e.pointerId;
      try { svg.setPointerCapture(pid); } catch (err) {}
      knob.style.transition = 'none';       /* knob follows finger 1:1 */
      update(e);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', function (e) {
      if (e.pointerId !== pid) return;
      update(e);
      e.preventDefault();
    });
    function end(e) {
      if (e.pointerId !== pid) return;
      pid = null;
      knob.style.transition = SPRING;       /* spring back */
      setKnob(0, 0);
      if (o.onMove) o.onMove({ x: 0, y: 0, mag: 0 });
      if (o.onEnd) o.onEnd();
    }
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    return {
      svg: svg,
      /* test/backdoor: simulate a drag without pointer events */
      _simulate: function (dx, dy) {
        update({ clientX: 50 + dx, clientY: 50 + dy, pointerId: -1 });
      }
    };
  };

  /* ---------- glass touch button ---------- */
  MC.createButton = function (o) {
    o = o || {};
    var host = o.container;
    if (!host) return null;
    var size = o.size || 60;
    var id = o.id || ('mcb' + (++MC._uid));
    var accent = o.color || '#7de8ff';
    var label = String(o.label != null ? o.label : '');
    var fs = label.length > 2 ? 34 : 40;
    MC._btnFSM.register(id);
    var svg = document.createElementNS(MC.SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.style.touchAction = 'none';
    svg.style.webkitUserSelect = 'none';
    svg.style.userSelect = 'none';
    svg.innerHTML =
      '<defs>' +
      '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="rgba(255,255,255,0.16)"/>' +
      '<stop offset="55%" stop-color="rgba(10,10,24,0.55)"/>' +
      '<stop offset="100%" stop-color="rgba(4,4,14,0.75)"/>' +
      '</linearGradient></defs>' +
      '<g id="' + id + 'btn-g" style="transform-origin:50px 50px;transition:transform .09s ease">' +
      '<circle cx="50" cy="50" r="46" fill="url(#' + id + 'g)" stroke="' + accent + '" stroke-opacity="0.55" stroke-width="1.6"/>' +
      '<circle cx="50" cy="50" r="46" fill="none" stroke="' + accent + '" stroke-opacity="0" stroke-width="4" id="' + id + 'glow"/>' +
      '<text x="50" y="52" text-anchor="middle" dominant-baseline="central" font-size="' + fs + '" font-family="monospace">' + label + '</text>' +
      '</g>';
    host.appendChild(svg);
    var g = svg.querySelector('#' + id + 'btn-g');
    var glow = svg.querySelector('#' + id + 'glow');
    function press(ond) {
      g.style.transform = ond ? 'scale(0.9)' : 'scale(1)';
      glow.setAttribute('stroke-opacity', ond ? '0.55' : '0');
    }
    svg.addEventListener('pointerdown', function (e) {
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
      MC._btnFSM.down(id);
      press(true);
      if (o.onDown) o.onDown(e);
      e.preventDefault();
    });
    function release() {
      MC._btnFSM.up(id);
      press(false);
      if (o.onUp) o.onUp();
    }
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
    return {
      svg: svg, id: id,
      _press: function () { MC._btnFSM.down(id); press(true); if (o.onDown) o.onDown(); },
      _release: function () { release(); }
    };
  };

} /* end DOM guard */

/* ================================================================
 * SELF-TEST (node)
 * ================================================================ */
if (typeof process !== 'undefined' && process.argv[1] && /mobile-controls\.js$/.test(process.argv[1])) {
  (function () {
    var pass = 0, fail = 0;
    function check(name, cond) {
      if (cond) { pass++; console.log('PASS: ' + name); }
      else { fail++; console.log('FAIL: ' + name); }
    }
    /* clampVec */
    var c = MC.clampVec(0, 0, 50, 8);
    check('clampVec: center → zero vector', c.x === 0 && c.y === 0 && c.mag === 0);
    c = MC.clampVec(3, 3, 50, 8);
    check('clampVec: inside dead zone → zero', c.mag === 0);
    c = MC.clampVec(25, 0, 50, 8);
    check('clampVec: half tilt right', Math.abs(c.x - 0.5) < 1e-9 && c.y === 0 && Math.abs(c.mag - 0.5) < 1e-9);
    c = MC.clampVec(100, 0, 50, 8);
    check('clampVec: clamps to edge, normalized', c.x === 1 && c.y === 0 && c.mag === 1);
    c = MC.clampVec(100, 100, 50, 8);
    check('clampVec: diagonal full tilt ≈ 0.707 each', Math.abs(c.x - Math.SQRT1_2) < 1e-9 && c.mag === 1);
    c = MC.clampVec(-40, 0, 50, 8);
    check('clampVec: negative direction', Math.abs(c.x + 0.8) < 1e-9 && c.y === 0);
    /* autoAim */
    var targets = [{ x: 100, y: 0 }, { x: 10, y: 5 }, { x: -50, y: -50 }];
    var a = MC.autoAimAngle(0, 0, targets);
    check('autoAim: nearest target angle', a !== null && Math.abs(a - Math.atan2(5, 10)) < 1e-9);
    check('autoAim: empty → null', MC.autoAimAngle(0, 0, []) === null);
    check('autoAim: null targets → null', MC.autoAimAngle(0, 0, null) === null);
    a = MC.autoAimAngle(0, 0, targets, 12);
    check('autoAim: maxRange filters far targets', a !== null && Math.abs(a - Math.atan2(5, 10)) < 1e-9);
    a = MC.autoAimAngle(0, 0, targets, 5);
    check('autoAim: nothing in range → null', a === null);
    a = MC.autoAimAngle(50, 50, [{ x: 50, y: 80 }]);
    check('autoAim: pure down angle', Math.abs(a - Math.PI / 2) < 1e-9);
    /* isTouchDevice */
    check('isTouch: maxTouchPoints', MC.isTouchDevice({ maxTouchPoints: 5 }) === true);
    check('isTouch: iPhone UA', MC.isTouchDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }) === true);
    check('isTouch: Android UA', MC.isTouchDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }) === true);
    check('isTouch: desktop UA', MC.isTouchDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', maxTouchPoints: 0 }) === false);
    check('isTouch: null nav', MC.isTouchDevice(null) === false);
    /* button FSM */
    MC._btnFSM.register('atk'); MC._btnFSM.register('dash');
    check('btn: starts up', MC._btnFSM.isDown('atk') === false);
    MC._btnFSM.down('atk');
    check('btn: down → isDown', MC._btnFSM.isDown('atk') === true);
    MC._btnFSM.down('atk');
    check('btn: double down idempotent', MC._btnFSM.isDown('atk') === true);
    MC._btnFSM.up('atk');
    check('btn: up → released', MC._btnFSM.isDown('atk') === false);
    check('btn: unknown id safe', MC._btnFSM.down('nope') === false && MC._btnFSM.up('nope') === false && MC._btnFSM.isDown('nope') === false);
    check('btn: independent states', (MC._btnFSM.down('dash'), MC._btnFSM.isDown('dash') === true && MC._btnFSM.isDown('atk') === false));
    console.log(fail === 0 ? 'ALL TESTS PASSED (' + pass + ')' : fail + ' FAILURES of ' + (pass + fail));
    process.exit(fail === 0 ? 0 : 1);
  })();
}
