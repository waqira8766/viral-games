/* DOPAMINE FACTORY — js/input.js
 * DP.Input — gesture layer. Pointer events on the renderer canvas (unified
 * mouse+touch, pointerId-tracked, one gesture at a time). Cell resolution is
 * delegated: game.js injects a resolver (DP.Render3D.screenToCell) via
 * init(canvas, callbacks[, resolver]).
 *
 * Pure core (node-testable, no DOM): classify(down, up, moves) → 'tap'|'drag'|'hold'.
 *   tap  = excursion <12px AND <250ms
 *   drag = excursion ≥12px at ANY point — latched (hysteresis: once a drag,
 *          always a drag, even back at start)
 *   hold = stationary (<12px) AND ≥250ms; live hold ping at 350ms; the
 *          250–350ms stationary gap folds to hold so tap stays strictly <250ms.
 *   isDoubleTap(prev, cur): two taps <300ms AND <24px apart. DoubleTap.tap(x,
 *   y, now) → bool: stateful, disjoint pairs. isTouchDevice(nav).
 *
 * Live binder (DOM-guarded), all callbacks optional: resolve(sx, sy) → {idx,
 * cell}|null, onTap(cellIdx, sx, sy), onDragStart(cellIdx), onDragMove(cellIdx|
 * null, sx, sy), onDragEnd(cellIdx|null, targetIdx, sx, sy), onHold, onDoubleTap.
 * Raw client/screen coords; touch-action:none comes from css (#stage), re-set
 * defensively. cancel() aborts the active gesture; activeIdx() = drag source.
 */
var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});

DP.Input = (function () {
  'use strict';
  var TAP_PX = 12, TAP_MS = 250, DRAG_PX = 12, HOLD_MS = 350, DBL_MS = 300, DBL_PX = 24;

  function dist(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }

  /* ---------- pure ---------- */

  function classify(down, up, moves) {
    if (!down || !up) return null;
    var max = dist(down.x, down.y, up.x, up.y), i, n = moves ? moves.length : 0;
    for (i = 0; i < n; i++) { var d = dist(down.x, down.y, moves[i].x, moves[i].y); if (d > max) max = d; }
    if (max >= DRAG_PX) return 'drag';      /* latched: any excursion past threshold */
    if (up.t - down.t < TAP_MS) return 'tap';
    return 'hold';                         /* stationary but not quick (>=250ms) */
  }

  function isDoubleTap(prev, cur) {
    if (!prev || !cur) return false;
    var dt = cur.t - prev.t;
    return dt > 0 && dt < DBL_MS && dist(prev.x, prev.y, cur.x, cur.y) < DBL_PX;
  }

  var DoubleTap = {
    last: null,
    tap: function (x, y, now) {
      var hit = isDoubleTap(this.last, { x: x, y: y, t: now });
      this.last = hit ? null : { x: x, y: y, t: now };    /* disjoint pairs */
      return hit;
    },
    reset: function () { this.last = null; }
  };

  function isTouchDevice(nav) {
    nav = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav) return false;
    if ((nav.maxTouchPoints || 0) > 0 || (nav.msMaxTouchPoints || 0) > 0) return true;
    return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(nav.userAgent || '');
  }

  /* ---------- live (DOM-guarded) ---------- */

  var cb = null, canvas = null, fns = null, act = null, holdTimer = 0, mvRAF = 0, mvX = 0, mvY = 0;

  function fire(name, a, b, c) { var f = cb && cb[name]; if (typeof f === 'function') f(a, b, c); }
  function hitIdx(x, y) { var h = (cb && cb.resolve) ? cb.resolve(x, y) : null; return h ? h.idx : null; }
  function clearHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } }
  function killMove() { if (mvRAF && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(mvRAF); mvRAF = 0; }

  function flushMove() {  /* rAF-coalesced: max one resolver call per frame while dragging */
    mvRAF = 0;
    if (act && act.dragging && cb && cb.onDragMove) cb.onDragMove(hitIdx(mvX, mvY), mvX, mvY);
  }

  function onDown(e) {
    if (e.cancelable) e.preventDefault();      /* no compat mouse events */
    if (act) return;                           /* one gesture at a time */
    var h = (cb && cb.resolve) ? cb.resolve(e.clientX, e.clientY) : null;
    act = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp || Date.now(),
            idx0: h ? h.idx : null, x: e.clientX, y: e.clientY, max: 0, dragging: false, holdFired: false };
    try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (err) {}
    clearHold();
    holdTimer = setTimeout(function () {        /* live hold ping at 350ms */
      holdTimer = 0;
      if (act && !act.dragging && act.max < DRAG_PX) { act.holdFired = true; fire('onHold', act.idx0, act.x, act.y); }
    }, HOLD_MS);
  }

  function onMove(e) {
    if (!act || e.pointerId !== act.id) return;
    var d = dist(act.x0, act.y0, e.clientX, e.clientY);
    if (d > act.max) act.max = d;
    act.x = e.clientX; act.y = e.clientY;
    if (!act.dragging) {
      if (act.max < DRAG_PX) return;           /* still pending */
      act.dragging = true;                     /* threshold latched — hysteresis */
      clearHold();
      fire('onDragStart', act.idx0);
    }
    mvX = act.x; mvY = act.y;
    if (!mvRAF) mvRAF = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(flushMove) : flushMove();
  }

  function onUp(e) {
    if (!act || e.pointerId !== act.id) return;
    var g = act; act = null;
    clearHold(); killMove();
    var x = e.clientX, y = e.clientY, now = e.timeStamp || Date.now();
    var kind = g.dragging ? 'drag' : classify({ x: g.x0, y: g.y0, t: g.t0 }, { x: x, y: y, t: now }, null);
    if (kind === 'drag') fire('onDragEnd', g.idx0, hitIdx(x, y), x, y);
    else if (kind === 'tap') {
      var idx = hitIdx(x, y);
      if (idx === null) idx = g.idx0;
      fire('onTap', idx, x, y);
      if (idx !== null) { if (DoubleTap.tap(x, y, now)) fire('onDoubleTap', idx, x, y); }
      else DoubleTap.reset();
    } else if (!g.holdFired) fire('onHold', g.idx0, x, y);    /* hold */
  }

  function abort(e) {  /* pointercancel (or forced): dragged gesture ends with null target */
    if (!act || (e && e.pointerId !== act.id)) return;
    var g = act; act = null;
    clearHold(); killMove();
    if (g.dragging) fire('onDragEnd', g.idx0, null, g.x, g.y);
  }

  function onCtx(e) { e.preventDefault(); }    /* long-press hold must not open menus */
  function cancelGesture() { if (act) abort(null); }

  function detach() {
    cancelGesture();
    if (canvas && fns) {
      for (var i = 0; i < fns.length; i++) canvas.removeEventListener(fns[i][0], fns[i][1]);
      canvas.removeEventListener('contextmenu', onCtx);
    }
    fns = null; canvas = null; cb = null;
  }

  function init(el, callbacks, resolver) {
    if (typeof document === 'undefined') return false;
    if (!el || typeof el.addEventListener !== 'function') return false;
    if (canvas === el) { cb = callbacks || cb; if (cb && typeof resolver === 'function') cb.resolve = resolver; return true; }
    detach();
    canvas = el; cb = callbacks || {};
    if (typeof resolver === 'function') cb.resolve = resolver;
    if (canvas.style) canvas.style.touchAction = 'none';   /* css already sets #stage */
    fns = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', abort]];
    for (var i = 0; i < fns.length; i++) canvas.addEventListener(fns[i][0], fns[i][1]);
    canvas.addEventListener('contextmenu', onCtx);
    return true;
  }

  return {
    TAP_PX: TAP_PX, TAP_MS: TAP_MS, DRAG_PX: DRAG_PX, HOLD_MS: HOLD_MS,
    DBLTAP_MS: DBL_MS, DBLTAP_PX: DBL_PX,
    classify: classify, isDoubleTap: isDoubleTap, DoubleTap: DoubleTap, isTouchDevice: isTouchDevice,
    init: init, detach: detach, cancel: cancelGesture,
    activeIdx: function () { return (act && act.dragging) ? act.idx0 : null; }
  };
})();

/* ---------- node self-test (pure parts only) ---------- */

function DPInputSelfTest() {
  var fails = 0, total = 0;
  function log(m) { console.log(m); }
  function ok(name, cond) { total++; if (cond) log('PASS: ' + name); else { fails++; log('FAIL: ' + name); } }
  var I = DP.Input, C = I.classify, D = I.isDoubleTap, DT = I.DoubleTap, O = { x: 0, y: 0, t: 0 };

  /* classify matrix — boundaries exact */
  ok('tap: quick small / edges 249ms->tap, 250ms->hold, 11.99px->tap, 12px->drag',
     C(O, { x: 5, y: 5, t: 100 }, []) === 'tap' && C(O, { x: 0, y: 0, t: 249 }, []) === 'tap' &&
     C(O, { x: 0, y: 0, t: 250 }, []) === 'hold' &&
     C(O, { x: 11.99, y: 0, t: 100 }, []) === 'tap' && C(O, { x: 12, y: 0, t: 100 }, []) === 'drag');
  ok('hold: 351ms, 5px drift, sub-threshold wiggle; far+slow is drag',
     C(O, { x: 50, y: 0, t: 2000 }, []) === 'drag' && C(O, { x: 0, y: 0, t: 351 }, []) === 'hold' &&
     C(O, { x: 3, y: 4, t: 4000 }, []) === 'hold' &&
     C(O, { x: 1, y: 0, t: 500 }, [{ x: 8, y: 0, t: 250 }, { x: 1, y: 0, t: 400 }]) === 'hold');
  ok('classify: moves optional / null-safe', C(O, { x: 0, y: 0, t: 100 }) === 'tap' && C(null, O) === null && C(O, null) === null);

  /* drag threshold hysteresis — excursion latches; return-to-start stays drag */
  ok('hysteresis: 30px out-and-back -> drag; 80px mid-move, up near start; 12px via move',
     C(O, { x: 0, y: 0, t: 600 }, [{ x: 30, y: 0, t: 300 }, { x: 0, y: 0, t: 500 }]) === 'drag' &&
     C({ x: 100, y: 100, t: 0 }, { x: 101, y: 100, t: 200 }, [{ x: 180, y: 100, t: 100 }]) === 'drag' &&
     C(O, { x: 0, y: 0, t: 300 }, [{ x: 12, y: 0, t: 150 }]) === 'drag');
  ok('hysteresis: 11px excursion does not latch -> tap', C(O, { x: 0, y: 0, t: 100 }, [{ x: 11, y: 0, t: 50 }]) === 'tap');

  /* double-tap window: <300ms AND <24px */
  ok('dbl window: hits 200ms/5px, 299ms, 23px; edges 300ms, 24px, reversed, null',
     D(O, { x: 5, y: 0, t: 200 }) === true && D(O, { x: 0, y: 0, t: 299 }) === true &&
     D(O, { x: 23, y: 0, t: 100 }) === true && D(O, { x: 0, y: 0, t: 300 }) === false &&
     D(O, { x: 24, y: 0, t: 100 }) === false &&
     D({ x: 0, y: 0, t: 500 }, { x: 0, y: 0, t: 100 }) === false && D(null, O) === false);

  /* stateful DoubleTap detector — disjoint pairs */
  DT.reset();
  ok('DT: first tap alone false, second in window true', DT.tap(10, 10, 0) === false && DT.tap(12, 10, 150) === true);
  DT.reset();
  ok('DT: too-slow pair (400ms) false', DT.tap(0, 0, 0) === false && DT.tap(0, 0, 400) === false);
  DT.reset();
  ok('DT: too-far pair (30px) false', DT.tap(0, 0, 0) === false && DT.tap(30, 0, 100) === false);
  DT.reset();
  ok('DT: disjoint pairs — quad tap f,t,f,t',
     DT.tap(0, 0, 0) === false && DT.tap(1, 0, 100) === true &&
     DT.tap(2, 0, 200) === false && DT.tap(3, 0, 280) === true);
  DT.reset();
  ok('DT: reset clears state', DT.last === null && DT.tap(0, 0, 0) === false);

  /* isTouchDevice + DOM guards */
  ok('isTouchDevice: touchPoints / iPhone UA / desktop UA / null',
     I.isTouchDevice({ maxTouchPoints: 5 }) === true &&
     I.isTouchDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }) === true &&
     I.isTouchDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 }) === false &&
     I.isTouchDevice(null) === false);
  ok('init DOM-guarded in node; cancel + activeIdx safe',
     I.init(null, {}) === false && I.init({}, {}) === false && I.cancel() === undefined && I.activeIdx() === null);
  ok('classify stays pure after DoubleTap use', C(O, { x: 1, y: 0, t: 50 }, []) === 'tap');

  if (fails === 0) log('ALL TESTS PASSED');
  else {
    log('FAIL: ' + fails + ' of ' + total + ' checks failed');
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
  }
}

if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('input.js')) {
  DPInputSelfTest();
}
