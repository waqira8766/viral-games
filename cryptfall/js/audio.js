var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});
// =============================================================================
// CRYPTFALL — js/audio.js — CF.SoundFX
//
// 100% procedural WebAudio engine: every effect and the whole music loop are
// synthesized live from oscillators + shaped white noise (no files, no blobs).
//
//   init()  unlock()  play(name)  startMusic(0|1|2)  stopMusic()
//   setVolume(0..1)  toggleMute()->bool  isMuted()->bool
//
// Music: detuned saw drone through a lowpass + a slow A-minor arpeggio, driven
// by a lookahead scheduler (setInterval 100 ms, notes 300 ms ahead). Higher
// intensity = faster arpeggio, noise-burst percussion, more open drone cutoff.
// Node-safe: `node js/audio.js` runs a static self-test (no audio hardware).
// =============================================================================

CF.SoundFX = (function () {
  'use strict';

  // -------------------------------------------------------------- constants --
  // The 16 one-shot effect names accepted by play().
  var NAMES = ['hit', 'hurt', 'swing', 'pickup', 'coin', 'levelup', 'dash',
    'shoot', 'explode', 'death', 'boss', 'chest', 'click', 'stairs',
    'gameover', 'win'];

  // Music is in A minor. SCALE = arpeggio pitch pool (A2 C3 E3 A3 C4 E4),
  // PATTERNS[intensity] = note indices, STEP_DUR = seconds per arpeggio step,
  // DRONE_CUTOFF = drone lowpass cutoff in Hz per intensity.
  var SCALE = [110.00, 130.81, 164.81, 220.00, 261.63, 329.63];
  var PATTERNS = [
    [0, 2, 1, 3, 2, 1],     // calm:   A2 E3 C3 A3 E3 C3
    [0, 2, 3, 1, 4, 2],     // combat: A2 E3 A3 C3 C4 E3
    [3, 5, 4, 2, 3, 5]      // boss:   A3 E4 C4 E3 A3 E4
  ];
  var STEP_DUR = [0.55, 0.30, 0.16];
  var DRONE_CUTOFF = [160, 450, 1000];

  // ------------------------------------------------------------------ state --
  var ctx = null;          // AudioContext, lazily created
  var master = null;       // master gain -> destination
  var sfxBus = null;       // effects bus -> master
  var noiseBuf = null;     // cached white-noise buffer
  var muted = false;       // current mute flag
  var masterVolume = 0.8;  // clamped 0..1
  var music = null;        // live music-loop state, null when silent

  // ---------------------------------------------------------------- helpers --
  function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Find an AudioContext constructor in a browser/node-safe way.
  function _ctxCtor() {
    try {
      var w = (typeof window !== 'undefined') ? window : null;
      if (w && (w.AudioContext || w.webkitAudioContext)) {
        return w.AudioContext || w.webkitAudioContext;
      }
      if (typeof globalThis !== 'undefined' && globalThis.AudioContext) {
        return globalThis.AudioContext;
      }
    } catch (e) { /* keep looking */ }
    return null;
  }

  // Lazily create the AudioContext + gain buses. True when ready to make
  // noise. Repeat-safe; never throws.
  function _ensureCtx() {
    try {
      if (ctx && ctx.state !== 'closed') return true;
      ctx = null; master = null; sfxBus = null;
      var AC = _ctxCtor();
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : masterVolume;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);
      return true;
    } catch (e) {
      ctx = null; master = null; sfxBus = null;
      return false;
    }
  }

  // Shared 1.5 s white-noise buffer, built once on demand.
  function _noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    var n = Math.floor(ctx.sampleRate * 1.5);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // Gain node with a quick attack / exponential decay envelope.
  function envG(dest, t, attack, dur, peak) {
    var g = ctx.createGain(), a = Math.max(0.001, attack);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, a + 0.01));
    g.connect(dest);
    return g;
  }

  // Biquad filter connected to dest, with optional exponential f0 -> f1 sweep.
  function filt(dest, type, f0, f1, q, t, dur) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 && f1 > 0 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (q) f.Q.value = q;
    f.connect(dest);
    return f;
  }

  // Oscillator tone with envelope and optional exponential pitch glide.
  function tone(dest, type, f0, f1, t, attack, dur, peak) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 && f1 > 0 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    o.connect(envG(dest, t, attack, dur, peak));
    o.start(t); o.stop(t + dur + 0.03);
    return o;
  }

  // Looping white-noise source -> swept filter -> envelope -> dest.
  function noiseBurst(dest, t, attack, dur, peak, ftype, f0, f1, q) {
    var s = ctx.createBufferSource();
    s.buffer = _noiseBuffer();
    s.loop = true;
    s.connect(filt(envG(dest, t, attack, dur, peak), ftype || 'bandpass',
      f0, f1, q, t, dur));
    s.start(t); s.stop(t + dur + 0.03);
    return s;
  }

  // -------------------------------------------------- one-shot effect specs --
  // Each spec is build(t, pv, dest): t = start time, pv = pitch-variation
  // multiplier (~+/-8%), dest = the effects bus. All last 0.05-1.2 s.
  var SPEC = {
    hit: function (t, pv, d) { // short square burst + noise, quick decay
      tone(d, 'square', 185 * pv, 130 * pv, t, 0.001, 0.09, 0.4);
      noiseBurst(d, t, 0.001, 0.06, 0.3, 'bandpass', 2400, 900, 1);
    },
    hurt: function (t, pv, d) { // lower square, slightly longer
      tone(d, 'square', 115 * pv, 65 * pv, t, 0.001, 0.2, 0.45);
      noiseBurst(d, t, 0.001, 0.12, 0.2, 'lowpass', 700, 200, 0.5);
    },
    swing: function (t, pv, d) { // filtered noise whoosh, bandpass sweeping down
      noiseBurst(d, t, 0.045, 0.18, 0.45, 'bandpass', 1700 * pv, 260 * pv, 2);
    },
    pickup: function (t, pv, d) { // two quick rising sines C5 -> E5
      tone(d, 'sine', 523.25 * pv, 0, t, 0.005, 0.09, 0.35);
      tone(d, 'sine', 659.26 * pv, 0, t + 0.07, 0.005, 0.1, 0.35);
    },
    coin: function (t, pv, d) { // bright triangle blip E6 -> B6
      tone(d, 'triangle', 1318.51 * pv, 0, t, 0.001, 0.07, 0.3);
      tone(d, 'triangle', 1975.53 * pv, 0, t + 0.07, 0.001, 0.12, 0.3);
    },
    levelup: function (t, pv, d) { // rising 4-note arpeggio C5 E5 G5 C6
      var f = [523.25, 659.26, 783.99, 1046.5];
      for (var i = 0; i < 4; i++) tone(d, 'triangle', f[i] * pv, 0, t + i * 0.09, 0.005, 0.14, 0.3);
    },
    dash: function (t, pv, d) { // noise sweep up
      noiseBurst(d, t, 0.03, 0.22, 0.4, 'bandpass', 320 * pv, 2600 * pv, 1.5);
    },
    shoot: function (t, pv, d) { // square blip with a fast pitch drop
      tone(d, 'square', 880 * pv, 180 * pv, t, 0.001, 0.13, 0.3);
    },
    explode: function (t, pv, d) { // lowpass noise burst + sub sine drop
      noiseBurst(d, t, 0.005, 0.45, 0.5, 'lowpass', 900, 80, 0.5);
      tone(d, 'sine', 130 * pv, 35 * pv, t, 0.005, 0.4, 0.55);
    },
    death: function (t, pv, d) { // descending saw wail through a closing lowpass
      tone(filt(d, 'lowpass', 1400, 180, 0.7, t, 0.6),
        'sawtooth', 240 * pv, 50 * pv, t, 0.01, 0.6, 0.4);
    },
    boss: function (t, pv, d) { // two low horn-ish saws (A1 + A2), ~0.8 s
      var lp = filt(d, 'lowpass', 520, 420, 0.8, t, 0.85);
      tone(lp, 'sawtooth', 55 * pv, 58 * pv, t, 0.06, 0.85, 0.5);
      tone(lp, 'sawtooth', 110 * pv, 113 * pv, t, 0.06, 0.85, 0.35);
    },
    chest: function (t, pv, d) { // creaky low triangle + coin blip
      tone(d, 'triangle', 72 * pv, 108 * pv, t, 0.03, 0.28, 0.3);
      tone(d, 'triangle', 1318.51 * pv, 0, t + 0.3, 0.001, 0.09, 0.25);
      tone(d, 'triangle', 1975.53 * pv, 0, t + 0.38, 0.001, 0.12, 0.25);
    },
    click: function (t, pv, d) { // tiny tick
      tone(d, 'square', 950 * pv, 750 * pv, t, 0.001, 0.05, 0.18);
    },
    stairs: function (t, pv, d) { // descending 3-note E4 C4 A3
      var f = [329.63, 261.63, 220];
      for (var i = 0; i < 3; i++) tone(d, 'triangle', f[i] * pv, 0, t + i * 0.11, 0.005, 0.13, 0.3);
    },
    gameover: function (t, pv, d) { // slow minor descending 3-note A3 F3 E3
      var lp = filt(d, 'lowpass', 900, 500, 0.7, t, 1.15);
      var f = [220, 174.61, 164.81];
      for (var i = 0; i < 3; i++) tone(lp, 'sawtooth', f[i] * pv, 0, t + i * 0.38, 0.02, 0.42, 0.3);
    },
    win: function (t, pv, d) { // major ascending arpeggio C5 E5 G5 C6 E6
      var f = [523.25, 659.26, 783.99, 1046.5, 1318.5];
      for (var i = 0; i < 5; i++) tone(d, 'triangle', f[i] * pv, 0, t + i * 0.1, 0.005, i === 4 ? 0.45 : 0.14, 0.3);
    }
  };

  // ------------------------------------------------------------------- music --
  // Lookahead scheduler tick: schedule arpeggio notes + percussion 300 ms
  // ahead of the playhead. Runs every 100 ms via setInterval.
  function _musicTick() {
    try {
      if (!music || !ctx || ctx.state === 'closed') return;
      var horizon = ctx.currentTime + 0.3;
      var it = music.intensity;
      var stepDur = STEP_DUR[it];
      var pattern = PATTERNS[it];
      while (music.next < horizon) {
        var t = music.next;
        var f = SCALE[pattern[music.step % pattern.length]]; // A-minor note
        tone(music.gain, 'triangle', f, f, t, 0.02, stepDur * 1.4, 0.1 + it * 0.02);
        // Percussion layer: downbeat thumps from intensity 1, offbeat ticks
        // added at intensity 2 (all filtered noise bursts).
        if (it >= 1 && music.step % 4 === 0) noiseBurst(music.gain, t, 0.001, 0.13, 0.35, 'lowpass', 480, 90, 0.4);
        if (it >= 2 && music.step % 2 === 1) noiseBurst(music.gain, t, 0.001, 0.045, 0.12, 'bandpass', 3200, 3200, 3);
        music.next += stepDur;
        music.step++;
      }
    } catch (e) { /* scheduler survives; the next tick retries */ }
  }

  // Start the dark-ambient loop. intensity: 0 calm, 1 combat, 2 boss.
  function startMusic(intensity) {
    try {
      if (!_ensureCtx()) return;
      stopMusic(); // crossfade away any previous loop
      var it = _clamp(Math.round(Number(intensity) || 0), 0, 2);
      var t0 = ctx.currentTime + 0.05;

      var m = { intensity: it, step: 0, next: t0, nodes: [], timer: null };
      m.gain = ctx.createGain();
      m.gain.gain.setValueAtTime(0.0001, t0);
      m.gain.gain.linearRampToValueAtTime(1, t0 + 1.2); // slow fade-in
      m.gain.connect(master);

      // Drone: detuned saws (A1 + A2) through a lowpass. A more open cutoff
      // at higher intensity makes combat feel brighter and tenser.
      var lp = filt(m.gain, 'lowpass', DRONE_CUTOFF[it], 0, 0.8, t0, 0);
      var drone = [55, 55.4, 110];
      for (var i = 0; i < drone.length; i++) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = drone[i]; g.gain.value = 0.045;
        o.connect(g); g.connect(lp); o.start(t0);
        m.nodes.push(o);
      }

      music = m;
      m.timer = setInterval(_musicTick, 100); // lookahead scheduler
    } catch (e) {
      music = null; // never throw, just stay silent
    }
  }

  // Fade the music loop out (~0.8 s), stop the drones, clear the scheduler.
  function stopMusic() {
    try {
      var m = music;
      music = null;
      if (!m) return;
      if (m.timer) clearInterval(m.timer);
      if (!ctx || !m.gain) return;
      var t = ctx.currentTime;
      m.gain.gain.cancelScheduledValues(t);
      m.gain.gain.setValueAtTime(Math.max(0.0001, m.gain.gain.value), t);
      m.gain.gain.linearRampToValueAtTime(0.0001, t + 0.8);
      for (var i = 0; i < m.nodes.length; i++) {
        try { m.nodes[i].stop(t + 0.85); } catch (e2) { /* already stopped */ }
      }
      setTimeout(function () { try { m.gain.disconnect(); } catch (e2) {} }, 1000);
    } catch (e) { /* never throws */ }
  }

  // -------------------------------------------------------------- public API --
  // Create the AudioContext on first use. Never throws; safe to re-call.
  function init() {
    try { _ensureCtx(); } catch (e) { /* never throws */ }
  }

  // Resume a suspended context; the game calls this on the first gesture.
  function unlock() {
    try {
      if (_ensureCtx() && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* never throws */ }
  }

  // Play a one-shot effect. Unknown names, missing or suspended contexts and
  // any internal error are silent no-ops. Fresh +/-8% pitch variation per play.
  function play(name) {
    try {
      if (!_ensureCtx()) return;
      if (ctx.state === 'suspended') { // nudge awake; stay silent this call
        try { if (typeof ctx.resume === 'function') ctx.resume(); } catch (e2) {}
        return;
      }
      var fn = SPEC[name];
      if (typeof fn !== 'function') return;
      fn(ctx.currentTime, 1 + (Math.random() * 2 - 1) * 0.08, sfxBus);
    } catch (e) { /* never throws */ }
  }

  // Master volume, clamped to 0..1 (NaN -> 0).
  function setVolume(v) {
    v = Number(v);
    if (!isFinite(v)) v = 0;
    masterVolume = _clamp(v, 0, 1);
    try { if (master) master.gain.value = muted ? 0 : masterVolume; } catch (e) {}
  }

  // Flip mute. Returns the new muted state.
  function toggleMute() {
    muted = !muted;
    try { if (master) master.gain.value = muted ? 0 : masterVolume; } catch (e) {}
    return muted;
  }

  function isMuted() { return !!muted; }

  var api = {
    init: init, unlock: unlock, play: play,
    startMusic: startMusic, stopMusic: stopMusic,
    setVolume: setVolume, toggleMute: toggleMute, isMuted: isMuted,
    _clamp: _clamp // exposed internal helper, exercised by the self-test
  };

  // --------------------------------------------------------------- self-test --
  // Pure-logic checks (no audio hardware). Prints PASS lines and
  // "ALL TESTS PASSED", or FAIL lines and exits with code 1.
  function selfTest() {
    var failures = 0;
    function check(cond, msg) {
      if (cond) console.log('PASS: ' + msg);
      else { failures++; console.log('FAIL: ' + msg); }
    }

    // 1. The spec table defines exactly the 16 contracted sound names.
    var missing = [], count = 0, k, i;
    for (i = 0; i < NAMES.length; i++) {
      if (typeof SPEC[NAMES[i]] !== 'function') missing.push(NAMES[i]);
    }
    for (k in SPEC) if (Object.prototype.hasOwnProperty.call(SPEC, k)) count++;
    check(NAMES.length === 16 && missing.length === 0 && count === 16,
      'spec table defines exactly the 16 sound names' +
      (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));

    // 2. Every API method is a function.
    var methods = ['init', 'play', 'startMusic', 'stopMusic', 'setVolume',
      'toggleMute', 'isMuted', 'unlock'];
    var bad = [];
    for (i = 0; i < methods.length; i++) {
      if (typeof api[methods[i]] !== 'function') bad.push(methods[i]);
    }
    check(bad.length === 0, 'all 8 API methods are functions' +
      (bad.length ? ' (bad: ' + bad.join(', ') + ')' : ''));

    // 3. Volume clamping.
    check(_clamp(-1, 0, 1) === 0 && _clamp(0.5, 0, 1) === 0.5 &&
      _clamp(5, 0, 1) === 1 && api._clamp(5, 0, 1) === 1,
      '_clamp helper clamps values into [0,1]');
    api.setVolume(5); check(masterVolume === 1, 'setVolume(5) clamps to 1');
    api.setVolume(-2); check(masterVolume === 0, 'setVolume(-2) clamps to 0');
    api.setVolume('0.75'); check(masterVolume === 0.75, 'setVolume("0.75") coerces to 0.75');
    api.setVolume('nope'); check(masterVolume === 0, 'setVolume(NaN) falls back to 0');
    api.setVolume(0.8); // restore default

    // 4. Mute toggle logic.
    check(typeof api.isMuted() === 'boolean', 'isMuted() returns a boolean');
    check(api.toggleMute() === true && api.isMuted() === true,
      'toggleMute() mutes and reports true');
    check(api.toggleMute() === false && api.isMuted() === false,
      'toggleMute() unmutes and reports false');

    // 5. All calls are silent no-ops without an AudioContext (node).
    var threw = false;
    try {
      api.init(); api.unlock(); api.play('hit');
      api.play('this-sound-does-not-exist'); // unknown -> silent no-op
      api.startMusic(2); api.stopMusic();
    } catch (e) { threw = true; }
    check(!threw, 'API never throws without an AudioContext');

    if (failures > 0) {
      console.log('FAIL: ' + failures + ' check(s) failed');
      if (typeof process !== 'undefined' && process.exit) process.exit(1);
    } else {
      console.log('ALL TESTS PASSED');
    }
  }

  // Node self-test: run only when executed directly (`node audio.js`).
  if (typeof process !== 'undefined' && process.argv[1] &&
      process.argv[1].endsWith('audio.js')) {
    selfTest();
  }

  return api;
})();
