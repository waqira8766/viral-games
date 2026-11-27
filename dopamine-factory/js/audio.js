var DP = (typeof globalThis.DP !== 'undefined') ? globalThis.DP : (globalThis.DP = {});
// =============================================================================
// DOPAMINE FACTORY — js/audio.js — DP.Audio — 100% procedural WebAudio synth.
//
// play('pop', {combo}) is THE ADDICTION CORE: pitch climbs a major-pentatonic
// ladder one step per combo (combo 0 = 220 Hz / A3), wrapping at 12 with an
// octave-up sparkle so the climb restarts as a reward. The ladder is fully
// deterministic — NO jitter; everything else gets a fresh +/-8% pitch jitter
// per play. All entry points are try/catch-guarded; the AudioContext is lazy;
// unlock() resumes it on the first gesture. API: init() unlock() play(name,
// opts) setVolume setMuted toggleMute isMuted comboFreq. Node-safe: `node
// js/audio.js` runs a pure self-test (no audio hardware).
// =============================================================================

DP.Audio = (function () {
  'use strict';

  // The 10 contracted one-shot sounds accepted by play().
  var NAMES = ['pop', 'merge', 'coin', 'chain', 'lucky', 'wheelTick',
    'jackpot', 'quest', 'ascend', 'fail'];
  var BASE_FREQ = 220;         // combo 0 pitch (A3)
  var PENTA = [0, 2, 4, 7, 9]; // major pentatonic semitone offsets per octave
  var LADDER_LEN = 12;         // combo ladder wraps here (2+ pentatonic octaves)
  var JITTER = 0.08;           // +/-8% pitch variation on non-ladder sounds

  var ctx = null;          // AudioContext, lazily created
  var master = null;       // master gain -> destination
  var sfxBus = null;       // effects bus -> master
  var noiseBuf = null;     // cached 1.5 s white-noise buffer
  var muted = false;       // mirrors Game.state.settings.muted
  var masterVolume = 0.8;  // clamped 0..1

  // ------------------------------------------------------------- helpers ---
  function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function _jitter() { return 1 + (Math.random() * 2 - 1) * JITTER; } // [0.92,1.08]
  function _applyMaster() { try { if (master) master.gain.value = muted ? 0 : masterVolume; } catch (e) {} }

  // Find an AudioContext constructor in a browser/node-safe way.
  function _ctxCtor() {
    try {
      var g = (typeof window !== 'undefined' && window) || globalThis;
      return (g && (g.AudioContext || g.webkitAudioContext)) || null;
    } catch (e) { return null; }
  }

  // Lazily create the AudioContext + gain buses. True when ready; never throws.
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
      sfxBus.gain.value = 1; sfxBus.connect(master);
      return true;
    } catch (e) {
      ctx = null; master = null; sfxBus = null; return false;
    }
  }

  // Shared white-noise buffer, built once on demand.
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
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, a + 0.01));
    g.connect(dest); return g;
  }

  // Biquad filter into dest, with an optional exponential f0 -> f1 sweep.
  function filt(dest, type, f0, f1, q, t, dur) {
    var f = ctx.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 && f1 > 0 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (q) f.Q.value = q;
    f.connect(dest); return f;
  }

  // Oscillator tone with envelope and an optional exponential pitch glide.
  function tone(dest, type, f0, f1, t, attack, dur, peak) {
    var o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 && f1 > 0 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    o.connect(envG(dest, t, attack, dur, peak));
    o.start(t); o.stop(t + dur + 0.03); return o;
  }

  // Looping white-noise source -> swept filter -> envelope -> dest.
  function noiseBurst(dest, t, attack, dur, peak, ftype, f0, f1, q) {
    var s = ctx.createBufferSource(); s.buffer = _noiseBuffer(); s.loop = true;
    s.connect(filt(envG(dest, t, attack, dur, peak), ftype || 'bandpass',
      f0, f1, q, t, dur));
    s.start(t); s.stop(t + dur + 0.03); return s;
  }

  // ------------------------------------------- combo ladder (ADDICTION CORE)
  // Pure, deterministic, no jitter. combo 0 = A3 (220 Hz); each combo +1
  // pentatonic step; wraps at 12 back to base, flagged as a "sparkle" wrap
  // (an octave-up chime rides the pop so the restart feels like a reward).
  function comboStep(c) {
    c = Math.floor(Number(c) || 0);
    if (c < 0) c = 0; // negative/invalid input lands on the base rung
    return c % LADDER_LEN;
  }

  function comboFreq(c) {
    var s = comboStep(c);
    var semis = 12 * Math.floor(s / PENTA.length) + PENTA[s % PENTA.length];
    return BASE_FREQ * Math.pow(2, semis / 12);
  }

  function comboSparkle(c) {
    c = Math.floor(Number(c) || 0);
    return c > 0 && c % LADDER_LEN === 0; // combo 12, 24, ... wrap rewards
  }

  // ---------------------------------------------------- one-shot effect specs
  // build(t, pv, dest, opts): t = start time, pv = ~+/-8% pitch variation,
  // dest = sfx bus, opts = payload. pop ignores pv on pitched notes on
  // purpose: the combo ladder is deterministic.
  var SPEC = {
    pop: function (t, pv, d, o) { // combo ladder pop (pv unused by design)
      var raw = Math.floor(Number(o && o.combo) || 0), f = comboFreq(raw);
      tone(d, 'triangle', f * 0.82, f, t, 0.002, 0.11, 0.5); // body snaps up
      tone(d, 'sine', f * 2, 0, t, 0.001, 0.05, 0.16);       // bright overtone
      noiseBurst(d, t, 0.001, 0.035, 0.14, 'highpass', 2400, 0, 0.6); // tick
      if (comboSparkle(raw)) { // ladder wrap: octave-up sparkle reward
        tone(d, 'triangle', f * 2, 0, t + 0.02, 0.002, 0.18, 0.3);
        tone(d, 'sine', f * 4, 0, t + 0.06, 0.002, 0.14, 0.15);
      }
    },
    merge: function (t, pv, d, o) { // rising two-tone, pitch by tier
      var tier = _clamp(Math.floor(Number(o && o.tier) || 1), 1, 25);
      var f = 175 * Math.pow(2, (tier - 1) / 8) * pv; // 175 Hz .. 1400 Hz
      tone(d, 'triangle', f * 0.95, f, t, 0.004, 0.1, 0.4);
      tone(d, 'triangle', f * 1.5 * 0.95, f * 1.5, t + 0.07, 0.004, 0.15, 0.42); // fifth up
      tone(d, 'sine', f * 3, 0, t + 0.07, 0.002, 0.1, 0.1); // sparkle on top
      noiseBurst(d, t, 0.012, 0.2, 0.12, 'bandpass', 500 * pv, 2200 * pv, 1.2);
    },
    coin: function (t, pv, d) { // bright two-blip coin
      tone(d, 'square', 987.77 * pv, 0, t, 0.001, 0.05, 0.18);
      tone(d, 'square', 1318.51 * pv, 0, t + 0.055, 0.001, 0.11, 0.2);
      tone(d, 'sine', 2637 * pv, 0, t + 0.055, 0.001, 0.09, 0.08); // shimmer
    },
    chain: function (t, pv, d) { // electric crackle: rapid noise bursts
      var i;
      for (i = 0; i < 8; i++) { // staccato discharge ticks
        noiseBurst(d, t + i * 0.026 + Math.random() * 0.014, 0.001, 0.018, 0.2 + (i % 3) * 0.05,
          'highpass', 2200 + i * 500, 0, 0.9);
      }
      tone(d, 'sawtooth', 120 * pv, 45 * pv, t, 0.003, 0.28, 0.22); // sub zap
      noiseBurst(d, t + 0.2, 0.001, 0.12, 0.15, 'bandpass', 3400 * pv, 900 * pv, 2); // sizzle tail
    },
    lucky: function (t, pv, d) { // sparkle arpeggio, gold shower
      var f = [659.26, 783.99, 987.77, 1318.51, 1567.98, 2093], i; // E5..C7
      for (i = 0; i < f.length; i++) {
        tone(d, 'triangle', f[i] * pv, 0, t + i * 0.055, 0.002, 0.14, 0.28);
        tone(d, 'sine', f[i] * 2.01 * pv, 0, t + i * 0.055, 0.002, 0.08, 0.07); // bell partial
      }
    },
    wheelTick: function (t, pv, d) { // ratchet tick (rapid calls while spinning)
      tone(d, 'square', 1150 * pv, 880 * pv, t, 0.001, 0.035, 0.14);
      noiseBurst(d, t, 0.001, 0.02, 0.07, 'bandpass', 4200, 4200, 3);
    },
    jackpot: function (t, pv, d) { // winning fanfare ~1.1 s
      var f = [523.25, 659.26, 783.99, 1046.5], i; // C5 E5 G5 C6 run
      for (i = 0; i < 4; i++) tone(d, 'triangle', f[i] * pv, 0, t + i * 0.09, 0.004, 0.16, 0.3);
      var chord = [523.25, 659.26, 783.99], peak = [0.14, 0.12, 0.1]; // sustained
      for (i = 0; i < 3; i++) tone(d, 'sawtooth', chord[i] * pv, 0, t + 0.36, 0.02, 0.7, peak[i]);
      tone(d, 'triangle', 2093 * pv, 0, t + 0.36, 0.01, 0.5, 0.12); // glitter top
      noiseBurst(d, t + 0.36, 0.02, 0.55, 0.1, 'highpass', 5200, 7800, 0.7); // confetti hiss
      tone(d, 'sine', 82 * pv, 60 * pv, t, 0.01, 0.4, 0.3); // celebratory boom
    },
    quest: function (t, pv, d) { // 4-note bright jingle
      var f = [783.99, 987.77, 1174.66, 1567.98], i; // G5 B5 D6 G6
      for (i = 0; i < 4; i++) tone(d, 'triangle', f[i] * pv, 0, t + i * 0.085, 0.004, i === 3 ? 0.3 : 0.12, 0.28);
      tone(d, 'sine', f[3] * 2 * pv, 0, t + 0.255, 0.004, 0.25, 0.1); // final chime
    },
    ascend: function (t, pv, d) { // ~5 s rising swell + shimmer, then bloom
      var i, tb = t + 4.55;
      var lp = filt(d, 'lowpass', 240, 4200, 0.9, t, 4.8); // brightness opens
      tone(lp, 'sawtooth', 110 * pv, 440 * pv, t, 1.6, 4.9, 0.2);         // root rises
      tone(lp, 'sawtooth', 164.81 * pv, 659.26 * pv, t, 1.9, 4.9, 0.16); // fifth
      tone(lp, 'triangle', 220 * pv, 880 * pv, t, 2.2, 4.9, 0.15);      // octave
      for (i = 0; i < 9; i++) { // sparkle trail rides the swell
        var f = comboFreq(i) * 4 * pv; tone(d, 'sine', f, f * 1.02, t + 0.4 + i * 0.5, 0.004, 0.3, 0.1);
      }
      var bloom = [523.25, 659.26, 783.99, 1046.5]; // final chord
      for (i = 0; i < 4; i++) tone(d, 'triangle', bloom[i] * pv, 0, tb + i * 0.02, 0.02, i === 3 ? 1 : 0.8, 0.2);
      noiseBurst(d, tb, 0.01, 0.9, 0.12, 'highpass', 5000, 8000, 0.6); // bloom shimmer
    },
    fail: function (t, pv, d) { // descending buzz, closing lowpass
      var lp = filt(d, 'lowpass', 900, 160, 0.7, t, 0.5);
      tone(lp, 'sawtooth', 220 * pv, 82 * pv, t, 0.01, 0.5, 0.35);
      tone(d, 'square', 174.61 * pv, 164.81 * pv, t + 0.12, 0.005, 0.18, 0.15);
    }
  };

  // -------------------------------------------------------------- public API
  function init() { try { _ensureCtx(); } catch (e) {} } // safe to re-call

  // Resume a suspended context; game.js calls this on the first gesture.
  function unlock() {
    try {
      if (_ensureCtx() && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) {}
  }

  // Play a one-shot effect. opts carries {combo} for pop, {tier} for merge.
  // Unknown names, missing/suspended contexts, errors and mute are no-ops.
  function play(name, opts) {
    try {
      if (muted) return;
      if (!_ensureCtx()) return;
      if (ctx.state === 'suspended') { // nudge awake; stay silent this call
        try { if (typeof ctx.resume === 'function') ctx.resume(); } catch (e2) {}
        return;
      }
      if (typeof SPEC[name] !== 'function') return;
      SPEC[name](ctx.currentTime, _jitter(), sfxBus, opts || {});
    } catch (e) {}
  }

  // Master volume, clamped to 0..1 (NaN -> 0).
  function setVolume(v) {
    v = Number(v);
    if (!isFinite(v)) v = 0;
    masterVolume = _clamp(v, 0, 1);
    _applyMaster();
  }

  // setMuted syncs with Game.state.settings.muted.
  function setMuted(m) { muted = !!m; _applyMaster(); return muted; }
  function toggleMute() { muted = !muted; _applyMaster(); return muted; }
  function isMuted() { return !!muted; }

  var api = {
    init: init, unlock: unlock, play: play, setVolume: setVolume,
    setMuted: setMuted, toggleMute: toggleMute, isMuted: isMuted,
    comboFreq: comboFreq, // exposed so fx/ui can sync visuals to the ladder
    _jitter: _jitter, _comboStep: comboStep,
    _comboSparkle: comboSparkle, NAMES: NAMES
  };

  // --------------------------------------------------------------- self-test
  // Pure-logic checks (no audio hardware). Prints "ALL TESTS PASSED" or FAIL
  // lines and exits with code 1.
  function selfTest() {
    var failures = 0;
    function check(cond, msg) {
      if (cond) console.log('PASS: ' + msg);
      else { failures++; console.log('FAIL: ' + msg); }
    }
    var i, k;

    // 1. The spec table defines exactly the 10 contracted sound names.
    var missing = [], extra = [], count = 0;
    for (i = 0; i < NAMES.length; i++) if (typeof SPEC[NAMES[i]] !== 'function') missing.push(NAMES[i]);
    for (k in SPEC) if (Object.prototype.hasOwnProperty.call(SPEC, k)) {
      count++; if (NAMES.indexOf(k) === -1) extra.push(k);
    }
    check(NAMES.length === 10 && missing.length === 0 && extra.length === 0 && count === 10,
      'spec table defines exactly the 10 contracted sounds' +
      (missing.length ? ' (missing: ' + missing.join(', ') + ')' : '') +
      (extra.length ? ' (extra: ' + extra.join(', ') + ')' : ''));

    // 2. Combo pitch ladder exact for combos 0..14: 220 Hz base, +1 pentatonic
    //    step per combo, wrap at 12 back to base (sparkle flag set on wraps).
    var want = [220.00, 246.94, 277.18, 329.63, 369.99, 440.00,
      493.88, 554.37, 659.26, 739.99, 880.00, 987.77];
    var bad = [];
    for (i = 0; i <= 14; i++) {
      if (Math.abs(api.comboFreq(i) - want[i % 12]) >= 0.01) bad.push(i + '->' + api.comboFreq(i).toFixed(2));
    }
    check(bad.length === 0, 'combo ladder exact for combos 0..14' +
      (bad.length ? ' (' + bad.join(', ') + ')' : ''));
    check(api.comboFreq(0) === 220, 'combo 0 is the base 220 Hz');
    check(api.comboFreq(12) === api.comboFreq(0) && api.comboFreq(13) === api.comboFreq(1) &&
      api.comboFreq(14) === api.comboFreq(2), 'ladder wraps at 12 and resumes climbing');
    var rising = true;
    for (i = 1; i <= 11; i++) if (api.comboFreq(i) <= api.comboFreq(i - 1)) rising = false;
    check(rising, 'ladder strictly rises from combo 0 through 11');
    check(api._comboSparkle(12) && api._comboSparkle(24) && !api._comboSparkle(0) &&
      !api._comboSparkle(11) && !api._comboSparkle(13),
      'octave-up sparkle fires exactly on wrap combos (12, 24), never mid-ladder');

    // 3. Jitter stays within +/-8% and is statistically well-formed.
    var N = 4000, min = 2, max = 0, sum = 0, lo = 0, hi = 0, j;
    for (i = 0; i < N; i++) {
      j = api._jitter();
      if (j < min) min = j; else if (j > max) max = j;
      sum += j; if (j < 0.96) lo++; if (j > 1.04) hi++;
    }
    check(min >= 0.92 && max <= 1.08, 'jitter stays within +/-8% (' +
      min.toFixed(4) + ' .. ' + max.toFixed(4) + ')');
    check(sum / N > 0.99 && sum / N < 1.01, 'jitter mean ~1.0 over ' + N + ' draws (' + (sum / N).toFixed(4) + ')');
    check(lo > 100 && hi > 100, 'jitter spreads across both tails (' + lo + ' low / ' + hi + ' high draws)');

    // 4. All API methods exist and are functions.
    var methods = ['init', 'unlock', 'play', 'setVolume', 'setMuted',
      'toggleMute', 'isMuted', 'comboFreq'];
    var badM = [];
    for (i = 0; i < methods.length; i++) if (typeof api[methods[i]] !== 'function') badM.push(methods[i]);
    check(badM.length === 0, 'all ' + methods.length + ' API methods are functions' +
      (badM.length ? ' (bad: ' + badM.join(', ') + ')' : ''));

    // 5. Every call is a silent no-op without an AudioContext (node).
    var threw = false;
    try {
      api.init(); api.unlock();
      for (i = 0; i < NAMES.length; i++) api.play(NAMES[i]); // no opts
      api.play('pop', { combo: 5 }); api.play('pop', { combo: 137 }); api.play('pop', { combo: 'garbage' });
      api.play('merge', { tier: 1 }); api.play('merge', { tier: 25 }); api.play('merge', { tier: -3 });
      api.play('nope'); api.play(null); api.play('pop', null);
      api.setVolume(2); api.setVolume('nope'); api.setVolume(0.8); api.setMuted(true); api.setMuted(false);
      api.toggleMute(); api.toggleMute(); api.isMuted();
    } catch (e) { threw = true; }
    check(!threw, 'API never throws without an AudioContext');

    if (failures > 0) {
      console.log('FAIL: ' + failures + ' check(s) failed');
      if (typeof process !== 'undefined' && process.exit) process.exit(1);
    } else console.log('ALL TESTS PASSED');
  }

  // Node self-test: run only when executed directly (`node js/audio.js`).
  if (typeof process !== 'undefined' && process.argv && process.argv[1] &&
      process.argv[1].endsWith('audio.js')) {
    selfTest();
  }

  return api;
})();
