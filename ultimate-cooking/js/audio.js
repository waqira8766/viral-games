/* ============================================================
 * ULTIMATE COOKING — js/audio.js
 * Procedural WebAudio synth. No assets — every sound is generated.
 * Guarded: does nothing until a user gesture unlocks the context.
 * ============================================================ */
(function () {
  'use strict';

  var A = {};
  var ctx = null, master = null, noiseBuf = null;
  var sizzleGain = null, frostGain = null, muted = false;
  var radioOn = false, radioNext = 0, radioStep = 0, radioGain = null;

  A.unlock = function () {
    if (ctx) { if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} } return; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
      /* shared noise buffer (1s white noise) */
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      /* sizzle loop: bandpassed noise, gain driven by cooking state */
      var src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 4200; bp.Q.value = 0.7;
      sizzleGain = ctx.createGain(); sizzleGain.gain.value = 0;
      src.connect(bp); bp.connect(sizzleGain); sizzleGain.connect(master);
      src.start();
      /* frost whoosh: soft lowpassed noise while holding */
      var fsrc = ctx.createBufferSource();
      fsrc.buffer = noiseBuf; fsrc.loop = true;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      frostGain = ctx.createGain(); frostGain.gain.value = 0;
      fsrc.connect(lp); lp.connect(frostGain); frostGain.connect(master);
      fsrc.start();
      /* radio music-box channel */
      radioGain = ctx.createGain(); radioGain.gain.value = 0.16;
      radioGain.connect(master);
    } catch (e) { ctx = null; }
  };

  A.setMuted = function (m) {
    muted = m;
    if (master) master.gain.value = m ? 0 : 0.9;
  };
  A.isMuted = function () { return muted; };

  /* ---------- tiny helpers ---------- */
  function env(node, t0, peak, dur) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    node.connect(g);
    return g;
  }
  function tone(type, f0, f1, t0, dur, peak, dest) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.85);
    var g = env(o, t0, peak, dur);
    g.connect(dest || master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise(t0, dur, peak, filterType, freq, f1) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.playbackRate.value = 0.7 + Math.random() * 0.6;
    var f = ctx.createBiquadFilter();
    f.type = filterType || 'lowpass';
    f.frequency.setValueAtTime(freq, t0);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    s.connect(f);
    var g = env(f, t0, peak, dur);
    g.connect(master);
    s.start(t0); s.stop(t0 + dur + 0.05);
  }

  /* ---------- one-shots ---------- */
  A.chop = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    noise(t, 0.09, 0.5, 'lowpass', 1100, 300);
    tone('sine', 150, 55, t, 0.1, 0.5);
  };
  A.catChop = function () { A.chop(); if (ctx && !muted) tone('triangle', 620, 900, ctx.currentTime + 0.05, 0.12, 0.18); };
  A.flipPerfect = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('square', 660, 660, t, 0.07, 0.12);
    tone('sine', 1568, 1568, t + 0.02, 0.22, 0.22);
    tone('sine', 2093, 2093, t + 0.07, 0.25, 0.16);
  };
  A.flipOk = function () { if (ctx && !muted) tone('square', 500, 500, ctx.currentTime, 0.07, 0.1); };
  A.pslice = function (perfect) {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    noise(t, 0.06, 0.35, 'highpass', 2400);
    tone('sine', perfect ? 880 : 320, perfect ? 1320 : 240, t, 0.1, 0.3);
  };
  A.place = function () { if (ctx && !muted) tone('sine', 420, 340, ctx.currentTime, 0.09, 0.22); };
  A.wrong = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('sawtooth', 220, 130, t, 0.18, 0.16);
    noise(t, 0.12, 0.12, 'lowpass', 500, 200);
  };
  A.ding = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('triangle', 880, 880, t, 0.4, 0.3);
    tone('sine', 1760, 1760, t, 0.5, 0.12);
  };
  A.coin = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('square', 988, 988, t, 0.07, 0.12);
    tone('square', 1319, 1319, t + 0.07, 0.16, 0.12);
  };
  A.mmm = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('sine', 262, 330, t, 0.22, 0.24);
    tone('sine', 330, 294, t + 0.22, 0.3, 0.22);
  };
  A.angry = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('sawtooth', 170, 88, t, 0.4, 0.2);
    noise(t, 0.3, 0.1, 'lowpass', 400, 150);
  };
  A.comboUp = function (level) {
    if (!ctx || muted) return;
    var f = [523, 587, 659, 784, 880][Math.max(0, Math.min(4, level - 1))];
    var t = ctx.currentTime;
    tone('triangle', f, f, t, 0.14, 0.22);
    tone('triangle', f * 2, f * 2, t + 0.05, 0.18, 0.12);
  };
  A.comboLost = function () { if (ctx && !muted) tone('sine', 330, 180, ctx.currentTime, 0.18, 0.14); };
  A.trash = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    noise(t, 0.28, 0.22, 'lowpass', 1400, 160);
    tone('sine', 200, 70, t, 0.22, 0.2);
  };
  A.oven = function () { if (ctx && !muted) { noise(ctx.currentTime, 0.2, 0.2, 'lowpass', 700, 200); tone('sine', 110, 140, ctx.currentTime, 0.2, 0.15); } };
  A.star = function (n) {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    var seq = [1319, 1568, 1976, 2637];
    tone('triangle', seq[Math.min(3, n)], seq[Math.min(3, n)], t, 0.3, 0.2);
    tone('sine', seq[Math.min(3, n)] * 2, seq[Math.min(3, n)] * 2, t + 0.03, 0.3, 0.08);
  };
  A.dayJingle = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    var notes = [523, 659, 784, 1047, 784, 1047, 1319];
    for (var i = 0; i < notes.length; i++) {
      tone('triangle', notes[i], notes[i], t + i * 0.13, 0.22, 0.2);
      if (i % 2 === 0) tone('sine', notes[i] * 2, notes[i] * 2, t + i * 0.13, 0.18, 0.06);
    }
  };
  A.meow = function () {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    tone('sine', 700, 950, t, 0.12, 0.16);
    tone('sine', 950, 620, t + 0.12, 0.16, 0.13);
  };
  A.meow = A.meow; /* cat easter egg */

  /* ---------- continuous state ---------- */
  A.setSizzle = function (level) {
    if (!sizzleGain) return;
    var target = muted ? 0 : Math.min(0.16, level * 0.08);
    sizzleGain.gain.setTargetAtTime(target, ctx.currentTime, 0.12);
  };
  A.setFrost = function (on) {
    if (!frostGain) return;
    frostGain.gain.setTargetAtTime(on && !muted ? 0.07 : 0, ctx.currentTime, 0.08);
  };

  /* music-box loop for the radio upgrade */
  var RADIO_NOTES = [523.25, 659.25, 783.99, 659.25, 587.33, 659.25, 783.99, 1046.5,
    523.25, 659.25, 783.99, 659.25, 880, 783.99, 659.25, 587.33];
  A.setRadio = function (on) { radioOn = !!on; radioNext = 0; };
  A.update = function () {
    if (!ctx || muted || !radioOn) return;
    var now = ctx.currentTime;
    if (radioNext === 0) radioNext = now + 0.1;
    while (radioNext < now + 0.35) {
      var f = RADIO_NOTES[radioStep % RADIO_NOTES.length];
      tone('sine', f, f, radioNext, 0.5, 0.5, radioGain);
      tone('sine', f * 4, f * 4, radioNext, 0.12, 0.08, radioGain);
      radioStep++;
      radioNext += 0.24;
    }
  };

  window.UCAudio = A;
})();
