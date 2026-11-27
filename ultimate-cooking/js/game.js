/* ============================================================
 * ULTIMATE COOKING — js/game.js
 * Entry point. Under node (`node js/game.js`) runs the self-test
 * suite; in the browser boots PART 2 (the three.js game).
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- node: self-test mode ---------------- */
  if (typeof document === 'undefined' && typeof require === 'function') {
    var tests = require('./tests.js');
    var r = tests.run();
    var i;
    if (r.failed > 0) {
      for (i = 0; i < r.failures.length; i++) console.log('FAILED: ' + r.failures[i]);
      console.log('TESTS FAILED: ' + r.failed + ' of ' + (r.passed + r.failed));
      process.exit(1);
    }
    console.log('ALL TESTS PASSED (' + r.passed + ')');
    process.exit(0);
  }

  /* ================================================================
   * PART 2 — browser bootstrap (guarded by document check above)
   * ================================================================ */
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var UC = window.UC, S = window.UCScene, UI = window.UCUI, A = window.UCAudio, MC = window.MC;
  if (!UC || !S || !UI || !A) return;

  var G = {
    save: null,
    st: null,
    playing: false,
    paused: false,
    dayEnding: false,
    frameId: 0,
    rid: 0,
    day: 1,
    lastComboLevel: 1,
    tutStep: -1,
    tutActive: false,
    mcBtns: {},
    mcMounted: false,
    drag: null, /* {mode:'patty'|'plate'} */
    _v: null, _p: { x: 0, y: 0 }
  };
  window.UCGame = { boot: boot, G: G };

  /* ---------------- save ---------------- */
  function loadSave() {
    var raw = null;
    try { raw = window.localStorage.getItem(UC.SAVE_KEY); } catch (e) {}
    G.save = UC.deserialize(raw);
  }
  function persist() {
    try { window.localStorage.setItem(UC.SAVE_KEY, UC.serialize(G.save)); } catch (e) {}
  }

  /* ---------------- boot ---------------- */
  function boot() {
    loadSave();
    var canvas = document.getElementById('gl');
    if (!S.init(canvas)) return;
    S.setGState(null);
    A.setMuted(G.save.muted);

    /* input */
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    document.getElementById('hudMute').onclick = toggleMute;
    document.getElementById('hudPause').onclick = pauseToMap;

    onResize();
    mountActionBar();
    UI.mapShow(G.save, {
      onPlay: startDay,
      onShop: openShop,
      onMute: toggleMute,
      onReset: resetSave
    });
    requestAnimationFrame(loop);
  }

  function unlockAudio() {
    A.unlock();
    if (G.save.muted) A.setMuted(true);
  }

  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    S.resize(w, h);
    /* re-evaluate MC mount on rotation */
    if (!G.mcMounted) mountActionBar();
  }

  function toggleMute() {
    G.save.muted = !G.save.muted;
    A.setMuted(G.save.muted);
    UI.syncMute(G.save.muted);
    persist();
  }

  function resetSave() {
    UI.confirmShow('Erase all progress?', function () {
      G.save = UC.defaultSave();
      persist();
      UI.mapShow(G.save, {
        onPlay: startDay,
        onShop: openShop,
        onMute: toggleMute,
        onReset: resetSave
      });
    });
  }

  function openShop() {
    var buyHandler = function (id) {
      if (UC.buyUpgrade(G.save, id)) {
        A.unlock(); A.coin();
        persist();
        UI.shopShow(G.save, buyHandler);
        var mapCoins = document.getElementById('mapCoins');
        if (mapCoins) mapCoins.textContent = G.save.coins;
      }
    };
    UI.shopShow(G.save, buyHandler);
  }

  function pauseToMap() {
    if (!G.playing) return;
    G.paused = true;
    UI.pauseShow(function () {
      /* quit to map: abandon day, no reward */
      G.playing = false;
      G.st = null;
      S.setGState(null);
      UI.pauseHide();
      UI.mapShow(G.save, {
        onPlay: startDay,
        onShop: openShop,
        onMute: toggleMute,
        onReset: resetSave
      });
    }, function () {
      G.paused = false;
    });
    var pm = document.getElementById('pauseMute');
    pm.textContent = G.save.muted ? '🔇 Sound off' : '🔊 Sound on';
    pm.onclick = function () { toggleMute(); pm.textContent = G.save.muted ? '🔇 Sound off' : '🔊 Sound on'; };
  }

  /* ================================================================
   * MC ACTION BAR (one-thumb cluster; same dispatch as 3D input)
   * ================================================================ */
  function mountActionBar() {
    if (G.mcMounted) return;
    if (typeof MC === 'undefined' || !MC || !MC.createButton) return;
    if (!UC.shouldMountActionBar(window.navigator, window.innerWidth)) return;
    var host = document.getElementById('mcCluster');
    if (!host) return;
    host.classList.add('mounted');
    G.mcBtns.chop = MC.createButton({
      container: host, id: 'uc_chop', label: '🔪', size: 56, color: '#FF7A59',
      onDown: function () { unlockAudio(); routeAction('chop'); }
    });
    G.mcBtns.flip = MC.createButton({
      container: host, id: 'uc_flip', label: '🍳', size: 56, color: '#FFC93C',
      onDown: function () { unlockAudio(); routeAction('flip'); }
    });
    G.mcBtns.serve = MC.createButton({
      container: host, id: 'uc_serve', label: '🥄', size: 56, color: '#7BC950',
      onDown: function () { unlockAudio(); routeAction('serve'); }
    });
    G.mcMounted = true;
    document.body.classList.add('mc-on');
  }

  /* the ONE dispatcher both input paths feed through */
  function routeAction(name, args) {
    if (!G.st || !G.playing || G.paused || G.dayEnding) return { code: 'idle' };
    var res = UC.dispatch(G.st, UC.MC_BINDINGS[name], G.frameId, args);
    handleResult(name, res);
    return res;
  }

  /* ---------------- day flow ---------------- */
  function startDay(rid) {
    G.rid = rid;
    G.save.current = rid;
    G.day = G.save.restaurants[rid].day;
    var seed = (Date.now() & 0xffffff) ^ (rid * 7919) ^ (G.day * 104729);
    var forceFirst = (!G.save.tutorialDone && rid === 0 && G.day === 1) ? 'classic' : null;
    G.st = UC.createDay(rid, G.day, G.save, seed, forceFirst);
    S.setGState(G.st);
    S.build(rid, G.save);
    S.setRadioOn(G.save.upgrades.radio > 0);
    S.jarCoins(G.save.coins);
    A.setRadio(G.save.upgrades.radio > 0);
    UI.mapHide();
    UI.syncMute(G.save.muted);
    UI.setHUD(G.save, rid, G.day);
    UI.comboSync(G.st.combo);
    G.playing = true;
    G.paused = false;
    G.dayEnding = false;
    G.lastComboLevel = 1;
    G.tutActive = false;
    G.tutStep = -1;
    UI.countdown('Day ' + G.day, 750, function () {
      UI.countdown('COOK!', 650, function () {
        if (forceFirst) startTutorial();
      });
    });
  }

  function endDay() {
    G.dayEnding = true;
    G.playing = false;
    var starsBefore = UC.totalStars(G.save);
    var sum = UC.finishDay(G.st);
    UC.applyDayResult(G.save, sum);
    persist();
    A.setRadio(false);
    S.setRadioOn(false);
    A.dayJingle();
    S.fxConfetti();
    UI.steamFog(0);
    UI.patience(false);
    hideMeters();
    /* star sounds staggered with the spin-in */
    var n = Math.min(3, sum.stars);
    for (var i = 0; i < n; i++) {
      (function (idx) { setTimeout(function () { A.star(idx + 1); }, 400 + idx * 380); })(i);
    }
    /* unlock toasts */
    if (UC.totalStars(G.save) >= 5 && starsBefore < 5) UI.unlockToast(UC.RESTAURANTS[1]);
    if (UC.totalStars(G.save) >= 12 && starsBefore < 12) UI.unlockToast(UC.RESTAURANTS[2]);
    if (UC.totalStars(G.save) >= 20 && starsBefore < 20) UI.unlockToast(UC.RESTAURANTS[3]);
    UI.setHUD(G.save, G.rid, G.day);
    setTimeout(function () {
      UI.dayEndShow(sum, function () { startDay(G.rid); }, function () {
        G.st = null;
        S.setGState(null);
        hideMeters();
        UI.mapShow(G.save, {
          onPlay: startDay,
          onShop: openShop,
          onMute: toggleMute,
          onReset: resetSave
        });
      });
    }, 900);
  }

  function hideMeters() {
    ['panMeter0', 'panMeter1', 'ovenMeter', 'chopMeter', 'pchopMeter', 'frostMeter'].forEach(function (id) {
      var n = UI.el(id);
      if (n) n.classList.add('hidden');
    });
    if (G.mcBtns.chop) visBtn(G.mcBtns.chop, false);
    if (G.mcBtns.flip) visBtn(G.mcBtns.flip, false);
    if (G.mcBtns.serve) visBtn(G.mcBtns.serve, false);
  }

  /* ================================================================
   * INPUT (direct 3D path — feeds the same routeAction dispatcher)
   * ================================================================ */
  function onDown(e) {
    if (!G.playing || G.paused || G.dayEnding) return;
    unlockAudio();
    /* frost hold: any press-and-hold on the scene works */
    if (G.st.frost && !G.st.frost.done) {
      UC.setFrostHolding(G.st, true);
      A.setFrost(true);
      G.drag = { mode: 'frost' };
      return;
    }
    var hit = S.raycast(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.indexOf('bin:') === 0) {
      var ingId = hit.slice(4);
      S.binWiggle(ingId);
      var exp = UC.expectedItem(G.st);
      if (exp && exp.id === ingId && exp.def.prep === 'cook' && G.st.pans.length > 0) {
        /* drag patty → pan */
        G.drag = { mode: 'patty', ing: ingId };
        S.startDrag(ingId);
        return;
      }
      actBin(ingId);
    } else if (hit === 'board') {
      routeAction('chop');
    } else if (hit.indexOf('pan:') === 0) {
      routeAction('flip', { pan: parseInt(hit.slice(4), 10) });
    } else if (hit === 'oven') {
      if (G.st.plate.phase === 'oven') {
        var r = UC.startBake(G.st);
        handleResult('bake', r);
      } else if (G.st.oven && G.st.oven.phase === 'baking') {
        var r2 = UC.pullOven(G.st);
        handleResult('ovenPull', r2);
      }
    } else if (hit === 'plate') {
      if (G.st.plate.phase === 'oven' || G.st.plate.phase === 'complete') {
        G.drag = { mode: 'plate' };
        S.startDrag('__plate__');
      }
    } else if (hit === 'trash') {
      actTrash();
    } else if (hit === 'cat') {
      A.meow();
      S.catSwipe();
    }
  }

  function onMove(e) {
    if (!G.drag || !S) return;
    if (G.drag.mode === 'frost') return;
    S.raycastWorld(e.clientX, e.clientY, G._v);
    G._v.y += 0.5;
    S.moveDrag(G._v, G.save.upgrades.shoes > 0 ? 1.6 : 1);
  }

  function onUp(e) {
    if (!G.drag) return;
    var mode = G.drag.mode;
    var ing = G.drag.ing;
    G.drag = null;
    if (mode === 'frost') {
      UC.setFrostHolding(G.st, false);
      A.setFrost(false);
      var fr = UC.releaseFrost(G.st);
      handleResult('frost', fr);
      return;
    }
    S.endDrag();
    if (!G.playing || G.paused) return;
    var hit = S.raycast(e.clientX, e.clientY);
    if (mode === 'patty') {
      if (hit && hit.indexOf('pan:') === 0) {
        actBin(ing || 'patty');
      } else {
        /* released off-pan: tap the bin anyway if it's the expected item */
        var exp = UC.expectedItem(G.st);
        if (exp && exp.def.prep === 'cook') actBin(exp.id);
      }
      return;
    }
    if (mode === 'plate') {
      if (G.st.plate.phase === 'oven' && hit === 'oven') {
        var r = UC.startBake(G.st);
        handleResult('bake', r);
      } else if (G.st.plate.phase === 'complete' && hit === 'customerZone') {
        routeAction('serve');
      }
      return;
    }
  }

  function actBin(ingId) {
    var res = UC.tapBin(G.st, ingId);
    handleResult('bin', res);
  }
  function actTrash() {
    var res = UC.trashPlate(G.st);
    handleResult('trash', res);
  }

  /* ================================================================
   * RESULT HANDLING (shared by every input path)
   * ================================================================ */
  function handleResult(src, res) {
    if (!res) return;
    if (G.tutActive) tutOnAction(src, res);
    var st = G.st;
    switch (res.code) {
      case 'placed':
        A.place();
        S.anchorPos('plate', G._v);
        S.fxPuff(G._v, 0xFFF7E4, 0.3);
        if (st.plate.expected >= st.active.order.items.length) { /* completed */ }
        break;
      case 'orderComplete':
        A.place();
        S.anchorPos('plate', G._v);
        S.fxPuff(G._v, 0xFFF7E4, 0.35);
        UI.toast('Ready!', 'good', 0.5, 0.42);
        break;
      case 'wrong':
        A.wrong();
        if (res.ing) S.binWrong(res.ing);
        UI.ticketShake();
        S.customerFrown();
        UI.toast('Mess!', 'bad', 0.5, 0.4);
        break;
      case 'toBoard':
        A.place();
        break;
      case 'toPan':
        A.place();
        break;
      case 'pansFull':
        UI.toast('Pan is busy!', 'bad', 0.72, 0.5);
        break;
      case 'chop':
        A.chop();
        haptic(8);
        break;
      case 'chopped':
        A.chop(); haptic(12);
        break;
      case 'pslice':
        A.pslice(res.result === 'perfect');
        if (res.result === 'perfect') { UI.toast('PERFECT!', 'gold', 0.5, 0.36); haptic(15); S.customerSmile(); }
        else { UI.toast('sloppy…', 'bad', 0.5, 0.38); }
        break;
      case 'flipPerfect':
        A.flipPerfect();
        S.panFlipAnim(res.pan);
        UI.toast('PERFECT FLIP!', 'gold', 0.72, 0.34);
        haptic(20);
        S.customerSmile();
        break;
      case 'flipOk':
        A.flipOk();
        S.panFlipAnim(res.pan);
        break;
      case 'tooEarly':
        UI.toast('wait for green!', 'warn', 0.72, 0.36);
        break;
      case 'notYet':
        UI.toast('not needed yet', 'warn', 0.5, 0.4);
        break;
      case 'panCleared':
        A.trash();
        break;
      case 'frostStart':
        UI.toast('HOLD to frost!', 'warn', 0.5, 0.44);
        break;
      case 'frostKeep':
        UI.toast('keep holding…', 'warn', 0.5, 0.44);
        break;
      case 'placed_frost': break;
      case 'served':
        onServed(res);
        break;
      case 'walkout':
        A.angry();
        S.customerWalkout();
        UI.toast('storms off…', 'bad', 0.5, 0.3);
        UI.ticketShake();
        break;
      case 'trashed':
        A.trash();
        S.trashAnim();
        UI.toast('trashed', 'warn', 0.5, 0.45);
        break;
      case 'baking':
        A.oven();
        UI.toast('baking!', 'warn', 0.78, 0.4);
        break;
      case 'ovenDone':
        if (res.result === 'perfect') { A.flipPerfect(); UI.toast('PERFECT BAKE!', 'gold', 0.78, 0.34); }
        else if (res.result === 'early') { A.wrong(); UI.toast('undercooked…', 'bad', 0.78, 0.38); }
        else if (res.result === 'late') { A.wrong(); UI.toast('a bit burnt…', 'bad', 0.78, 0.38); }
        else { A.place(); }
        break;
      case 'notReady':
        UI.toast('finish the order first!', 'warn', 0.5, 0.42);
        break;
      case 'nothing':
        break;
      case 'dup':
        break;
    }
    /* frost result piggybacked */
    if (res.frost === 'perfect') { UI.toast('PERFECT SWIRL!', 'gold', 0.5, 0.36); A.flipPerfect(); }
    else if (res.frost === 'over') { UI.toast('overflowed…', 'bad', 0.5, 0.38); }
    else if (res.frost === 'thin') { UI.toast('too thin…', 'bad', 0.5, 0.38); }
    if (res.cat) {
      A.catChop();
      S.catSwipe();
      UI.toast('cat chop!', 'good', 0.32, 0.5);
    }
  }

  function onServed(res) {
    A.ding();
    A.coin();
    A.mmm();
    S.customerHappy();
    S.fxServe();
    S.anchorPos('plate', G._v);
    _vJar.set(-3.0, 1.35, -2.2);
    S.fxCoin(G._v, _vJar);
    UI.coinBump(res.coins);
    UI.toast('+$' + res.coins + (res.tip > 0 ? ' (tip $' + res.tip + ')' : ''), 'gold', 0.5, 0.3);
    if (res.fast) UI.toast('SPEEDY!', 'good', 0.5, 0.24);
    /* live HUD: wallet + this day's earnings (applied to save at day end) */
    UI.el('hudCoins').textContent = G.save.coins + G.st.coins;
    S.jarCoins(G.save.coins + G.st.coins);
    haptic(25);
  }

  var _vJar = new THREE.Vector3();
  function haptic(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  /* ================================================================
   * TUTORIAL
   * ================================================================ */
  var TUT_STEPS = [
    { text: 'Tap the BUN crate to start the burger!', anchor: 'bin:bun_bottom', when: function (src, r) { return r.code === 'placed'; } },
    { text: 'Drag the PATTY crate onto the pan!', anchor: 'bin:patty', when: function (src, r) { return r.code === 'toPan' || r.code === 'pansFull'; } },
    { text: 'TAP the pan when the marker hits the GREEN zone!', anchor: 'pan:0', when: function (src, r) { return r.code === 'flipPerfect' || r.code === 'flipOk'; } },
    { text: 'Flip again on the next pass!', anchor: 'pan:0', when: function (src, r) { return r.code === 'flipPerfect' || r.code === 'flipOk'; } },
    { text: 'Tap the pan to stack the cooked patty!', anchor: 'pan:0', when: function (src, r) { return r.code === 'placed' && r.from === 'pan'; } },
    { text: 'Lettuce! Tap the crate, then tap the BOARD to chop!', anchor: 'bin:lettuce', when: function (src, r) { return r.code === 'toBoard' || r.cat; } },
    { text: 'Rapid-tap the board to chop it!', anchor: 'board', when: function (src, r) { return r.code === 'placed' || r.cat; } },
    { text: 'Tomato — crate, then chop on the board!', anchor: 'bin:tomato', when: function (src, r) { return r.code === 'toBoard' || r.cat; } },
    { text: 'Chop chop chop!', anchor: 'board', when: function (src, r) { return r.code === 'placed' || r.cat; } },
    { text: 'Top bun — tap the crate!', anchor: 'bin:bun_top', when: function (src, r) { return r.code === 'orderComplete'; } },
    { text: 'Drag the plate up to the customer to SERVE!', anchor: 'plate', when: function (src, r) { return r.code === 'served'; } }
  ];

  function startTutorial() {
    G.tutActive = true;
    G.tutStep = 0;
    showTutStep();
  }
  function showTutStep() {
    var step = TUT_STEPS[G.tutStep];
    if (!step) { endTutorial(); return; }
    UI.tutShow(step.text, null, null, true, endTutorial);
  }
  function tutOnAction(src, res) {
    var step = TUT_STEPS[G.tutStep];
    if (!step) return;
    if (step.when(src, res)) {
      G.tutStep++;
      if (G.tutStep >= TUT_STEPS.length) { endTutorial(); return; }
      showTutStep();
    }
  }
  function endTutorial() {
    G.tutActive = false;
    G.tutStep = -1;
    UI.tutHide();
    G.save.tutorialDone = true;
    persist();
  }

  /* ================================================================
   * MAIN LOOP
   * ================================================================ */
  var lastT = 0;
  var _anchor = new THREE.Vector3();

  function loop(t) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    G.frameId++;

    if (G.playing && G.st && !G.paused && !G.dayEnding) {
      UC.dayTick(G.st, dt);
      handleEvents();
      if (G.st.finished && !G.dayEnding) { endDay(); }
    }

    S.update(dt, G.playing ? G.st : null);
    if (G.playing && G.st) syncUI(dt);

    A.update();
  }

  /* dayTick events → feedback */
  function handleEvents() {
    var e = G.st.evts;
    var i;
    for (i = 0; i < G.st.pans.length; i++) {
      var code = i === 0 ? e.pan0 : e.pan1;
      if (code === 1) { /* window opened */ }
      else if (code === 2) { UI.toast('patty ready!', 'good', 0.72, 0.3); A.flipOk(); }
      else if (code === 3) { UI.toast('BURNT!', 'bad', 0.72, 0.3); A.angry(); }
      else if (code === 4) { UI.toast('flip missed!', 'bad', 0.72, 0.32); A.comboLost(); }
    }
    if (e.oven === 1) { UI.toast('PIZZA BURNT!', 'bad', 0.78, 0.3); A.angry(); }
    if (e.frostOver) { UI.toast('overflowed…', 'bad', 0.5, 0.38); A.wrong(); }
    if (e.walkout) { A.angry(); S.customerWalkout(); UI.toast('too slow…', 'bad', 0.5, 0.3); }
  }

  /* per-frame UI sync (DOM writes only on change) */
  var _lastPat = -1, _lastVis = null, _lastHeat = -1;

  function syncUI(dt) {
    var st = G.st;
    UI.syncTicket(st);

    /* patience bubble over the active customer */
    if (st.active) {
      S.anchorPos('customer', _anchor);
      S.project(_anchor, G._p);
      UI.place('patience', G._p.x, G._p.y, true);
      UI.patience(true, st.active.patience / st.active.patienceMax, st.active.name, st.active.mood);
    } else {
      UI.patience(false);
    }

    /* combo */
    UI.comboSync(st.combo);
    if (st.combo.level > G.lastComboLevel) { A.comboUp(st.combo.level); UI.toast('COMBO ×' + st.combo.level, 'gold', 0.5, 0.22); }
    else if (st.combo.level < G.lastComboLevel) { A.comboLost(); }
    G.lastComboLevel = st.combo.level;

    /* meters */
    var i, pan;
    for (i = 0; i < 2; i++) {
      var mid = i === 0 ? 'panMeter0' : 'panMeter1';
      pan = st.pans[i];
      if (pan && pan.phase === 'cooking' && pan.windowOpen) {
        S.anchorPos(i === 0 ? 'pan0' : 'pan1', _anchor);
        S.project(_anchor, G._p);
        var anchorX = G._p.x, anchorY = G._p.y;
        var node = UI.place(mid, anchorX, anchorY, true);
        if (node) UI.timingBar(mid, pan.pos, 0.5 - pan.green / 2, 0.5 + pan.green / 2);
      } else {
        UI.place(mid, 0, 0, false);
      }
    }
    /* oven meter */
    if (st.oven && st.oven.phase === 'baking') {
      S.anchorPos('oven', _anchor);
      S.project(_anchor, G._p);
      UI.place('ovenMeter', G._p.x, G._p.y, true);
      var ov = st.oven;
      var gc = (ov.greenA + ov.greenB) / 2, gh = (ov.greenB - ov.greenA) / 2 * ov.scale;
      UI.timingBar('ovenMeter', ov.t / (ov.T * 1.18), (gc - gh) / 1.18, (gc + gh) / 1.18);
    } else {
      UI.place('ovenMeter', 0, 0, false);
    }
    /* board meters */
    if (st.board && st.board.kind === 'chop') {
      S.anchorPos('board', _anchor);
      S.project(_anchor, G._p);
      UI.place('chopMeter', G._p.x, G._p.y, true);
      UI.progBar('chopMeter', Math.min(1, st.board.progress / st.board.needed),
        'CHOP ×' + Math.max(0, Math.ceil(st.board.needed - st.board.progress)));
    } else {
      UI.place('chopMeter', 0, 0, false);
    }
    if (st.board && st.board.kind === 'pchop') {
      S.anchorPos('board', _anchor);
      S.project(_anchor, G._p);
      UI.place('pchopMeter', G._p.x, G._p.y, true);
      UI.timingBar('pchopMeter', st.board.sweep, 0.5 - st.board.zoneW / 2, 0.5 + st.board.zoneW / 2);
      UI.progBar('pchopMeter', st.board.si / st.board.slices, 'SLICE ' + (st.board.si + 1) + '/' + st.board.slices);
    } else {
      UI.place('pchopMeter', 0, 0, false);
    }
    /* frost meter */
    if (st.frost && !st.frost.done) {
      S.anchorPos('plate', _anchor);
      S.project(_anchor, G._p);
      UI.place('frostMeter', G._p.x, G._p.y, true);
      UI.timingBar('frostMeter', st.frost.t, UC.FROST_BAND[0], UC.FROST_BAND[1]);
      UI.progBar('frostMeter', st.frost.t, st.frostHolding ? 'frosting…' : 'HOLD!');
    } else {
      UI.place('frostMeter', 0, 0, false);
    }

    /* MC button visibility (state machine from pure logic) */
    var vis = UC.buttonVisibility(st);
    if (_lastVis !== null) {
      if (vis.chop !== _lastVis.chop) G.mcBtns.chop && visBtn(G.mcBtns.chop, vis.chop);
      if (vis.flip !== _lastVis.flip) G.mcBtns.flip && visBtn(G.mcBtns.flip, vis.flip);
      if (vis.serve !== _lastVis.serve) G.mcBtns.serve && visBtn(G.mcBtns.serve, vis.serve);
    } else {
      G.mcBtns.chop && visBtn(G.mcBtns.chop, vis.chop);
      G.mcBtns.flip && visBtn(G.mcBtns.flip, vis.flip);
      G.mcBtns.serve && visBtn(G.mcBtns.serve, vis.serve);
    }
    _lastVis = vis;

    /* audio + fog */
    var cooking = 0;
    for (i = 0; i < st.pans.length; i++) if (st.pans[i].phase === 'cooking') cooking++;
    if (st.oven && st.oven.phase === 'baking') cooking += 0.7;
    A.setSizzle(cooking);
    var heat = S.heat();
    if (Math.abs(heat - _lastHeat) > 0.1) { UI.steamFog(heat); _lastHeat = heat; }

    /* tutorial ring position */
    if (G.tutActive && G.tutStep >= 0 && TUT_STEPS[G.tutStep]) {
      var anchorId = TUT_STEPS[G.tutStep].anchor;
      if (anchorId) {
        S.anchorPos(anchorId, _anchor);
        S.project(_anchor, G._p);
        var ring = UI.el('tutRing');
        ring.style.left = (G._p.x * 100).toFixed(1) + '%';
        ring.style.top = (G._p.y * 100).toFixed(1) + '%';
        ring.style.display = 'block';
      }
    }
  }

  function visBtn(btn, on) {
    if (!btn || !btn.svg) return;
    btn.svg.classList.toggle('btn-on', !!on);
  }

  /* auto-boot */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
