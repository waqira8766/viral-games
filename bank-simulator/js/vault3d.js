'use strict';
/* ============================================================
   BANK SIMULATOR — 3D VAULT STAGE (three.js r147)
   js/vault3d.js — loaded after ../shared/vendor/three.min.js.
   PART A: pure math, tuning & easing (no DOM, no THREE) — node-testable.
   PART B: three.js scene (guarded by typeof document/THREE) — the
           DOM game stays THE game; this paints the vault behind it.
   Palette law: steel blue-grey + gold. Red appears only for danger.
   ============================================================ */

var Vault3D = (function () {

  /* ==========================================================
     TUNING (pure constants shared with the self-tests)
     ========================================================== */
  var CFG = {
    DOOR_R: 2.55,           // design radius of the vault door disc
    WHEEL_R: 1.95,          // handle wheel radius (outside the DOM gold hub)
    FRAME_R: 3.0,           // outer frame ring (torus) radius
    SEAM_R: 2.62,           // coin-spray / glow seam radius
    LEDGE_TOP: -2.62,       // coin bounce plane + crew floor (local Y)
    HUB_FRACTION: 0.55,     // door radius fraction the DOM gold hub covers
    DOOR_HUB_RATIO: 1.8,    // door radius = hub radius * this (desktop look)
    COIN_MAX: 80,           // pooled live coins (hard cap)
    COIN_LIFE_S: 2.6,       // coin lifetime before scale-out
    GRAVITY: 4.6,           // coin gravity, world units / s²
    COIN_BOUNCE: 0.42,      // vertical restitution on bounce
    DPR_CAP: 1.5,           // devicePixelRatio cap (mid phones stay 60fps)
    CAM_DIST: 11.5,
    FOV_DEG: 34,
    RECOIL_MS: 320,         // door micro-recoil duration
    RECOIL_SCALE: 0.05,     // scale punch at full recoil
    RECOIL_TILT: 0.055,     // rotation punch (radians)
    WHEEL_SPIN_TAP: 2.8,    // handle-wheel spin impulse per tap
    STROBE_PERIOD_MS: 715,  // red & blue strobes share ONE period
                             // → 2 lights ≈ 2.80 flashes/s total (< 3: epilepsy-safe)
    HEAT_DANGER_START: 50,  // red emergency light + haze fade in from here
    HEAT_SHAKE_START: 60,   // camera shake fades in from here
    SHAKE_MAX: 0.035,       // max camera shake (world units)
    WOBBLE_PERIOD_MS: 4000, // idle handle-wheel wobble
    WOBBLE_AMP: 0.028,      // wobble amplitude (radians)
    CREW_FIG_MAX: 8,        // silhouettes around the vault
    DUST_COUNT: 70,         // dust motes in the vault light
    SEAM_BASE: 0.22,        // seam glow floor (income pulses add on top)
    SEAM_AMP: 0.18,
    PRESTIGE_GOLD_MAX: 0.85 // door never fully loses its steel
  };

  /* ---------- tiny utils ---------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function numOr(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function intOr(v, d) { return Math.max(0, Math.floor(numOr(v, d))); }

  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Frame-rate independent exponential smoothing (the "never linear" damp).
  function dampCurve(cur, target, lambda, dt) {
    var c = numOr(cur, 0), t = numOr(target, 0);
    var k = 1 - Math.exp(-numOr(lambda, 4) * Math.max(0, numOr(dt, 0.016)));
    return c + (t - c) * k;
  }

  // Deterministic 0..1 pseudo-random (no Math.random — pure & testable).
  function hash01(n) {
    var x = Math.sin(numOr(n, 0) * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ---------- easing (nothing linear-jarring leaves this file) ---------- */
  function easeOutBack(t) {
    var x = clamp(numOr(t, 0), 0, 1);
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }
  function easeOutCubic(t) {
    var x = clamp(numOr(t, 0), 0, 1);
    return 1 - Math.pow(1 - x, 3);
  }

  /* ---------- door micro-recoil (tap punch, easeOutBack settle) ----------
     recoilDecay(0)=1 (full punch), → 0 at/after dur, dipping slightly
     negative around 62% (the springy settle) and never exploding. */
  function recoilDecay(t, dur) {
    var d = numOr(dur, CFG.RECOIL_MS);
    if (d <= 0) return 0;
    var x = clamp(numOr(t, 0) / d, 0, 1);
    return 1 - easeOutBack(x);
  }

  /* ---------- coin spray ---------- */
  // Coins per tap: richer taps spray more, hard-capped for pooling.
  function coinSpawnCount(value) {
    var v = Math.max(1, numOr(value, 5));
    return clamp(6 + Math.floor(Math.log10(v) * 1.6), 6, 14);
  }

  // Deterministic spray velocity for coin i of `count`, seeded per tap.
  // Evenly fanned around the seam + jitter; always biased up & outward
  // (toward the camera) so the fountain reads in one frame.
  function coinVelocity(i, count, seed) {
    var n = intOr(count, 1), s = numOr(seed, 1);
    var spread = (Math.PI * 2 * i) / Math.max(1, n);
    var a = hash01(s * 7.13 + i * 2.71);
    var b = hash01(s * 3.77 + i * 5.31);
    var c = hash01(s * 9.41 + i * 1.93);
    var ang = spread + (a - 0.5) * 0.9;
    var out = 1.05 + b * 1.35;
    return {
      x: Math.cos(ang) * out,
      y: 1.15 + c * 1.5,
      z: 0.5 + a * 0.9
    };
  }

  // Squash amount on floor bounce, from impact speed. [0, 0.45].
  function bounceSquash(impact) {
    var v = clamp(numOr(impact, 0) / 3.0, 0, 1);
    return 0.45 * easeOutCubic(v);
  }

  /* ---------- strobes (epilepsy-safe by construction) ---------- */
  function strobeFlashesPerSec(periodMs) {
    return 1000 / Math.max(1, numOr(periodMs, CFG.STROBE_PERIOD_MS));
  }

  // Eased sine wave 0..1 — no hard square flash, no pure white, ever.
  function strobeIntensity(t, periodMs) {
    var p = Math.max(1, numOr(periodMs, CFG.STROBE_PERIOD_MS));
    var ph = (numOr(t, 0) % p) / p;
    var lifted = Math.sin(ph * Math.PI * 2) * 0.5 + 0.5;
    return lifted * lifted;
  }

  /* ---------- heat ---------- */
  // 0 below HEAT_DANGER_START, smoothstepped to 1 at 100.
  function heatDangerLevel(heat) {
    var h = clamp(numOr(heat, 0), 0, 100);
    if (h <= CFG.HEAT_DANGER_START) return 0;
    return smoothstep(CFG.HEAT_DANGER_START, 100, h);
  }

  // Camera shake amplitude: 0 below HEAT_SHAKE_START, easing to SHAKE_MAX.
  function heatShakeAmp(heat) {
    var h = clamp(numOr(heat, 0), 0, 100);
    if (h <= CFG.HEAT_SHAKE_START) return 0;
    return CFG.SHAKE_MAX * smoothstep(CFG.HEAT_SHAKE_START, 100, h);
  }

  // Smooth Lissajous shake offset; each axis bounded by amp.
  function shakeOffset(t, amp) {
    var a = clamp(numOr(amp, 0), 0, 10);
    var tt = numOr(t, 0) * 0.001;
    return {
      x: Math.sin(tt * 13.1) * a,
      y: Math.cos(tt * 17.7) * a * 0.8
    };
  }

  /* ---------- prestige: steel → gold ---------- */
  function prestigeGoldMix(prestige) {
    return CFG.PRESTIGE_GOLD_MAX * clamp(intOr(prestige, 0), 0, 5) / 5;
  }

  /* ---------- crew silhouettes ---------- */
  function crewFigureCount(totalCrew) {
    var t = intOr(totalCrew, 0);
    if (t <= 0) return 0;
    return Math.min(CFG.CREW_FIG_MAX, Math.ceil(t / 3));
  }

  /* ---------- drill evolution ---------- */
  var DRILL_STYLES = [
    { style: 'none',    body: 0x59636f, bit: 0x8a929c, beam: 0.00, bitGlow: 0.00, wobble: 0.0 },
    { style: 'rusty',   body: 0x6e4a2f, bit: 0x7d6a54, beam: 0.00, bitGlow: 0.15, wobble: 1.0 },
    { style: 'diamond', body: 0x9aa6b5, bit: 0xe8f4ff, beam: 0.00, bitGlow: 0.55, wobble: 0.7 },
    { style: 'laser',   body: 0xb08d3a, bit: 0xffd98a, beam: 0.70, bitGlow: 0.80, wobble: 0.0 },
    { style: 'quantum', body: 0xc9a03f, bit: 0xfff3c0, beam: 0.90, bitGlow: 0.95, wobble: 0.0 },
    { style: 'nano',    body: 0x3d4550, bit: 0xfff8e0, beam: 1.00, bitGlow: 1.00, wobble: 0.0 }
  ];
  function drillVisualTier(tier) {
    var t = clamp(intOr(tier, 0), 0, DRILL_STYLES.length - 1);
    var d = DRILL_STYLES[t];
    return {
      style: d.style, body: d.body, bit: d.bit,
      beam: d.beam, bitGlow: d.bitGlow, wobble: d.wobble,
      visible: t > 0
    };
  }

  /* ---------- presentation math ---------- */
  // Device pixel ratio: capped at 1.5, floored at 1.
  function clampDpr(dpr) {
    return clamp(numOr(dpr, 1), 1, CFG.DPR_CAP);
  }

  // Fake ambient occlusion: 1.0 at center → 0.62 at the rim.
  function aoDarken(radiusNorm) {
    return 1 - 0.38 * clamp(numOr(radiusNorm, 0), 0, 1);
  }

  // Seam glow pulses with the income tick: steady floor + heartbeat that
  // speeds up as money flows. Bounded to [0, 1].
  function seamPulse(t, cps) {
    var c = Math.max(0, numOr(cps, 0));
    var base = CFG.SEAM_BASE + Math.min(0.42, c / 6000);
    var speed = 0.8 + Math.min(3.0, Math.log10(c + 10));
    var wave = 0.5 + 0.5 * Math.sin(numOr(t, 0) * 0.004 * speed);
    return clamp(base + CFG.SEAM_AMP * wave, 0, 1);
  }

  // Idle handle-wheel wobble: ±WOBBLE_AMP radians, exact WOBBLE_PERIOD_MS.
  function wobbleAngle(t) {
    var ph = (numOr(t, 0) % CFG.WOBBLE_PERIOD_MS) / CFG.WOBBLE_PERIOD_MS;
    return Math.sin(ph * Math.PI * 2) * CFG.WOBBLE_AMP;
  }

  // Deterministic drift for dust mote i at time t — floats in the light
  // cone: z band [0.4, 3.0), x/y inside the cone radius.
  function dustDrift(i, t) {
    var n = numOr(i, 0), tt = numOr(t, 0) * 0.001;
    var a = hash01(n * 3.7) * Math.PI * 2;
    var r = 0.5 + hash01(n * 7.9) * 2.3;
    var spd = 0.03 + hash01(n * 5.3) * 0.05;
    var cyc = (tt * spd + hash01(n * 2.1)) % 1;
    var wob = Math.sin(tt * (0.4 + hash01(n * 9.2)) + n) * 0.18;
    return {
      x: Math.cos(a) * (r * (0.55 + cyc * 0.45)) + wob,
      y: Math.sin(a) * r * 0.62 - cyc * 0.5 + 0.8,
      z: 0.4 + cyc * 2.6
    };
  }

  /* ---------- public pure API ---------- */
  return {
    CFG: CFG,
    DRILL_STYLES: DRILL_STYLES,
    clamp: clamp,
    numOr: numOr,
    intOr: intOr,
    smoothstep: smoothstep,
    dampCurve: dampCurve,
    hash01: hash01,
    easeOutBack: easeOutBack,
    easeOutCubic: easeOutCubic,
    recoilDecay: recoilDecay,
    coinSpawnCount: coinSpawnCount,
    coinVelocity: coinVelocity,
    bounceSquash: bounceSquash,
    strobeFlashesPerSec: strobeFlashesPerSec,
    strobeIntensity: strobeIntensity,
    heatDangerLevel: heatDangerLevel,
    heatShakeAmp: heatShakeAmp,
    shakeOffset: shakeOffset,
    prestigeGoldMix: prestigeGoldMix,
    crewFigureCount: crewFigureCount,
    drillVisualTier: drillVisualTier,
    clampDpr: clampDpr,
    aoDarken: aoDarken,
    seamPulse: seamPulse,
    wobbleAngle: wobbleAngle,
    dustDrift: dustDrift
  };
})();

/* node: export the pure core for the self-tests (browser never sees this) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Vault3D;
}

/* ============================================================
   PART B — THREE.JS SCENE (browser only; DOM game stays intact)
   ============================================================ */
if (typeof document !== 'undefined' && typeof THREE !== 'undefined') {
  (function () {
    'use strict';
    var H = Vault3D, CFG = H.CFG;

    var canvas = document.getElementById('vault3d');
    if (!canvas) return;
    var vaultEl = document.getElementById('vault');
    var REDUCED = (typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;

    /* ---------- renderer (fail soft: DOM game never depends on this) ---------- */
    var renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, alpha: true, antialias: true,
        powerPreference: 'high-performance'
      });
    } catch (e) { renderer = null; }
    if (!renderer || !renderer.getContext) { canvas.className = 'off'; return; }
    try { if (!renderer.getContext()) { canvas.className = 'off'; return; } } catch (e2) {}

    function applySize() {
      var w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
      renderer.setPixelRatio(H.clampDpr(window.devicePixelRatio || 1));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      computeWorldExtents();
      refreshRects();
    }

    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.setClearColor(0x000000, 0); // transparent — the page gradient shows through

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(CFG.FOV_DEG, 1, 0.1, 60);
    camera.position.set(0, 0, CFG.CAM_DIST);
    camera.lookAt(0, 0, 0);

    /* ---------- half-height / half-width of the z=0 plane (registration math) ---------- */
    var halfH = 1, halfW = 1, worldPerPx = 0.009;
    function computeWorldExtents() {
      halfH = Math.tan(CFG.FOV_DEG * Math.PI / 360) * CFG.CAM_DIST;
      halfW = halfH * camera.aspect;
      worldPerPx = (2 * halfH) / Math.max(1, canvas.clientHeight);
    }

    /* ---------- procedural environment: dark vault room, warm gold band ---------- */
    function makeEnvironment() {
      var c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      var g = c.getContext('2d');
      var grad = g.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0.00, '#141b26');
      grad.addColorStop(0.42, '#2a3547');
      grad.addColorStop(0.52, '#6b5637');  // warm gold band at the horizon
      grad.addColorStop(0.60, '#10151f');
      grad.addColorStop(1.00, '#05070c');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 128);
      // cool ceiling strips + a warm key smear — steel reads as brushed
      g.fillStyle = 'rgba(150,175,205,0.55)';
      g.fillRect(18, 10, 60, 4); g.fillRect(150, 16, 70, 3);
      g.fillStyle = 'rgba(255,190,90,0.5)';
      g.fillRect(90, 56, 90, 6);
      var tex = new THREE.CanvasTexture(c);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      var pmrem = new THREE.PMREMGenerator(renderer);
      var rt = pmrem.fromEquirectangular(tex);
      tex.dispose();
      pmrem.dispose();
      return rt.texture;
    }
    try { scene.environment = makeEnvironment(); } catch (e) { /* env is polish, not life */ }

    /* ---------- procedural textures ---------- */
    // Brushed-steel streaks → bump + roughness (zero assets, no AI slop).
    function makeBrushedTexture() {
      var c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      var g = c.getContext('2d');
      g.fillStyle = '#8c8c8c';
      g.fillRect(0, 0, 256, 256);
      for (var i = 0; i < 420; i++) {
        var y = Math.random() * 256;
        var w = 40 + Math.random() * 216;
        var x = Math.random() * 256 - 60;
        var a = 0.03 + Math.random() * 0.12;
        var tone = 110 + ((Math.random() * 90) | 0);
        g.strokeStyle = 'rgba(' + tone + ',' + tone + ',' + tone + ',' + a.toFixed(3) + ')';
        g.lineWidth = 0.6 + Math.random() * 1.2;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + w, y + (Math.random() - 0.5) * 2);
        g.stroke();
      }
      var tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(3, 3);
      return tex;
    }
    var brushed = makeBrushedTexture();

    // Soft radial sprite (dust motes, haze, glints, contact glow).
    function makeGlowTexture(inner, outer) {
      var c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      var g = c.getContext('2d');
      var grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      grad.addColorStop(0, inner);
      grad.addColorStop(0.45, outer);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    }
    var softGoldTex = makeGlowTexture('rgba(255,236,180,1)', 'rgba(255,190,80,0.35)');
    var softRedTex = makeGlowTexture('rgba(255,120,90,0.9)', 'rgba(255,40,20,0.3)');
    var dustTex = makeGlowTexture('rgba(255,240,210,0.9)', 'rgba(255,220,160,0.25)');
    var shadowTex = makeGlowTexture('rgba(5,8,14,0.85)', 'rgba(6,9,16,0.4)');

    /* ---------- palette (ONE palette: steel blue-grey + gold) ---------- */
    var COL = {
      steel: new THREE.Color(0x8b98ab),
      steelDark: new THREE.Color(0x39424f),
      steelMid: new THREE.Color(0x5c6a7d),
      gold: new THREE.Color(0xd9a441),
      coinGold: new THREE.Color(0xe8b84b),
      red: new THREE.Color(0xff2a2a),
      blue: new THREE.Color(0x2a4aff)
    };

    /* ---------- materials ---------- */
    var doorMat = new THREE.MeshStandardMaterial({
      color: COL.steel.clone(), metalness: 0.78, roughness: 0.42,
      bumpMap: brushed, bumpScale: 0.012, envMapIntensity: 0.9, vertexColors: true
    });
    var frameMat = new THREE.MeshStandardMaterial({
      color: COL.steelDark.clone(), metalness: 0.85, roughness: 0.5,
      bumpMap: brushed, bumpScale: 0.008, envMapIntensity: 0.7, vertexColors: true
    });
    var wheelMat = new THREE.MeshStandardMaterial({
      color: COL.steelMid.clone(), metalness: 0.9, roughness: 0.34,
      envMapIntensity: 1.0, vertexColors: true
    });
    var goldMat = new THREE.MeshStandardMaterial({
      color: COL.gold.clone(), metalness: 1.0, roughness: 0.26, envMapIntensity: 1.1
    });
    var coinMat = new THREE.MeshStandardMaterial({
      color: COL.coinGold.clone(), metalness: 1.0, roughness: 0.24,
      envMapIntensity: 1.15, emissive: 0x402800, emissiveIntensity: 0.35
    });
    var rivetMat = new THREE.MeshStandardMaterial({
      color: 0xaab4c2, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.0
    });
    var hingeMat = new THREE.MeshStandardMaterial({
      color: 0x2c3440, metalness: 0.8, roughness: 0.55, envMapIntensity: 0.6
    });
    var silhouetteMat = new THREE.MeshStandardMaterial({
      color: 0x0c1017, metalness: 0.25, roughness: 0.9, envMapIntensity: 0.25
    });
    var drillBodyMat = new THREE.MeshStandardMaterial({
      color: 0x6e4a2f, metalness: 0.7, roughness: 0.6, envMapIntensity: 0.7
    });
    var drillBitMat = new THREE.MeshStandardMaterial({
      color: 0x7d6a54, metalness: 0.9, roughness: 0.35,
      emissive: 0x000000, envMapIntensity: 1.0
    });
    var beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var seamMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0.25,
      blending: THREE.AdditiveBlending, depthWrite: false
    });

    /* ---------- fake AO: bake a 0..1 factor into vertex colors ---------- */
    function applyVertexAO(geo, factorFn) {
      var pos = geo.attributes.position;
      if (!pos) return;
      var colors = new Float32Array(pos.count * 3);
      for (var i = 0; i < pos.count; i++) {
        var f = H.clamp(factorFn(pos.getX(i), pos.getY(i), pos.getZ(i)), 0, 1);
        colors[i * 3] = f; colors[i * 3 + 1] = f; colors[i * 3 + 2] = f;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /* ==========================================================
       THE VAULT (one group, registered behind the DOM gold circle)
       ========================================================== */
    var vault = new THREE.Group();
    scene.add(vault);

    // soft shadow disc — seats the vault into the page gradient
    var shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
    );
    shadow.scale.set(CFG.FRAME_R * 3.4, CFG.FRAME_R * 2.6, 1);
    shadow.position.set(0, -0.4, -1.5);
    vault.add(shadow);

    // ---- door disc: brushed steel, vertex-darkened toward the rim ----
    var doorGeo = new THREE.CylinderGeometry(CFG.DOOR_R, CFG.DOOR_R, 0.34, 72, 1);
    doorGeo.rotateX(Math.PI / 2); // caps face the camera
    applyVertexAO(doorGeo, function (x, y, z) {
      var r = Math.sqrt(x * x + y * y);
      if (r > CFG.DOOR_R * 0.995) return H.aoDarken(1) * 0.78; // side wall: seam shadow
      return H.aoDarken(r / CFG.DOOR_R);
    });
    var door = new THREE.Mesh(doorGeo, doorMat);
    var doorPivot = new THREE.Group(); // recoil punch acts here
    doorPivot.add(door);
    vault.add(doorPivot);

    // ---- outer frame ring + wall plate ----
    var frameGeo = new THREE.TorusGeometry(CFG.FRAME_R, 0.44, 18, 84);
    applyVertexAO(frameGeo, function (x, y, z) {
      var r = Math.sqrt(x * x + y * y);
      return 0.55 + 0.45 * H.smoothstep(CFG.FRAME_R - 0.35, CFG.FRAME_R + 0.25, r);
    });
    vault.add(new THREE.Mesh(frameGeo, frameMat));

    var wallGeo = new THREE.RingGeometry(CFG.DOOR_R + 0.12, CFG.FRAME_R + 0.7, 72, 1);
    applyVertexAO(wallGeo, function (x, y) {
      var r = Math.sqrt(x * x + y * y);
      return H.aoDarken(H.clamp((r - CFG.DOOR_R) / (CFG.FRAME_R + 0.7 - CFG.DOOR_R), 0, 1)) * 0.9;
    });
    var wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({
      color: 0x232b36, metalness: 0.6, roughness: 0.72,
      envMapIntensity: 0.4, vertexColors: true, side: THREE.DoubleSide
    }));
    wall.position.z = -0.28;
    vault.add(wall);

    // ---- rivets: instanced spheres, two rings (frame + door face) ----
    var RIV_FRAME = 26, RIV_DOOR = 14, RIV_TOTAL = RIV_FRAME + RIV_DOOR;
    var rivetGeo = new THREE.SphereGeometry(0.075, 10, 8);
    var rivets = new THREE.InstancedMesh(rivetGeo, rivetMat, RIV_TOTAL);
    vault.add(rivets);
    var dummy = new THREE.Object3D();
    (function buildRivets() {
      for (var i = 0; i < RIV_FRAME; i++) {
        var a = (i / RIV_FRAME) * Math.PI * 2 + 0.12;
        dummy.position.set(Math.cos(a) * CFG.FRAME_R, Math.sin(a) * CFG.FRAME_R, 0.34);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        rivets.setMatrixAt(i, dummy.matrix);
      }
      for (var j = 0; j < RIV_DOOR; j++) {
        var b = (j / RIV_DOOR) * Math.PI * 2 + 0.42;
        dummy.position.set(Math.cos(b) * 2.18, Math.sin(b) * 2.18, 0.19);
        dummy.scale.setScalar(0.8);
        dummy.updateMatrix();
        rivets.setMatrixAt(RIV_FRAME + j, dummy.matrix);
      }
      rivets.instanceMatrix.needsUpdate = true;
    })();

    // ---- handle wheel: torus + spokes + hub, spins & wobbles ----
    var wheelGroup = new THREE.Group();
    wheelGroup.position.z = 0.32;
    vault.add(wheelGroup);
    var wheelGeo = new THREE.TorusGeometry(CFG.WHEEL_R, 0.125, 14, 64);
    applyVertexAO(wheelGeo, function (x, y) {
      return 0.72 + 0.28 * H.smoothstep(0.6, 1, Math.sqrt(x * x + y * y) / CFG.WHEEL_R);
    });
    wheelGroup.add(new THREE.Mesh(wheelGeo, wheelMat));
    var spokeGeo = new THREE.CylinderGeometry(0.052, 0.052, CFG.WHEEL_R - 0.1, 10);
    for (var s = 0; s < 5; s++) {
      var spoke = new THREE.Mesh(spokeGeo, wheelMat);
      var sa = (s / 5) * Math.PI * 2;
      spoke.rotation.z = sa - Math.PI / 2;
      spoke.position.set(Math.cos(sa) * CFG.WHEEL_R / 2, Math.sin(sa) * CFG.WHEEL_R / 2, 0);
      wheelGroup.add(spoke);
    }
    var hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 18), goldMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.07;
    wheelGroup.add(hub);
    var hubKnob = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), goldMat);
    hubKnob.position.z = 0.16;
    wheelGroup.add(hubKnob);
    // handle grips on the wheel rim — gold accents
    var gripGeo = new THREE.SphereGeometry(0.07, 10, 8);
    for (var gpi = 0; gpi < 4; gpi++) {
      var ga = (gpi / 4) * Math.PI * 2 + Math.PI / 4;
      var grip = new THREE.Mesh(gripGeo, goldMat);
      grip.position.set(Math.cos(ga) * CFG.WHEEL_R, Math.sin(ga) * CFG.WHEEL_R, 0.09);
      wheelGroup.add(grip);
    }

    // ---- hinge details on the right edge ----
    [-1.35, 1.35].forEach(function (hy) {
      var knuckle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 10), hingeMat);
      knuckle.rotation.x = Math.PI / 2;
      knuckle.position.set(CFG.FRAME_R + 0.18, hy, 0.02);
      vault.add(knuckle);
      var plate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.34), hingeMat);
      plate.position.set(CFG.FRAME_R + 0.1, hy, 0.02);
      vault.add(plate);
    });

    // ---- seam glow ring (pulses with the income tick) ----
    var seam = new THREE.Mesh(new THREE.TorusGeometry(CFG.SEAM_R, 0.035, 10, 96), seamMat);
    seam.position.z = 0.19;
    vault.add(seam);

    // ---- base ledge: coins bounce here, crew stands here ----
    var ledge = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.34, 1.15), frameMat);
    ledge.position.set(0, CFG.LEDGE_TOP - 0.17, 0.42);
    vault.add(ledge);
    var ledgeTrim = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.05, 0.06), goldMat);
    ledgeTrim.position.set(0, CFG.LEDGE_TOP - 0.02, 0.98);
    vault.add(ledgeTrim);

    /* ---------- drill rig: evolves rusty → diamond → laser ----------
       Anchored AT the seam contact point, local +Y aiming outward. */
    var drillGroup = new THREE.Group();
    var drillAngle = -Math.PI / 5.6;                     // mounted lower-right
    drillGroup.position.set(
      Math.cos(drillAngle) * CFG.SEAM_R,
      Math.sin(drillAngle) * CFG.SEAM_R,
      0.22
    );
    drillGroup.rotation.z = drillAngle - Math.PI / 2;    // local -Y → into the seam
    vault.add(drillGroup);
    var drillBit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.028, 0.28, 10), drillBitMat);
    drillBit.position.y = 0.14;                          // tip kisses the seam
    drillGroup.add(drillBit);
    var drillBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.1, 0.3, 12), drillBodyMat);
    drillBarrel.position.y = 0.43;
    drillGroup.add(drillBarrel);
    var drillCollar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.3), goldMat);
    drillCollar.position.y = 0.6;
    drillGroup.add(drillCollar);
    var drillBody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.4), drillBodyMat);
    drillBody.position.y = 0.86;
    drillGroup.add(drillBody);
    // laser core: bright thin cylinder burning through the bit into the seam
    var beam = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.5, 8), beamMat);
    beam.position.y = -0.12;
    drillGroup.add(beam);
    var contactGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softGoldTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    contactGlow.scale.set(0.5, 0.5, 1);
    contactGlow.position.y = 0.02;
    drillGroup.add(contactGlow);
    drillGroup.visible = false;

    /* ==========================================================
       DYNAMICS — coins (pooled), crew, dust, glints, haze, strobes
       ========================================================== */

    /* ---------- lights (6 total — mid phones stay 60fps) ---------- */
    scene.add(new THREE.AmbientLight(0x28344a, 0.72));            // cool base
    var keyLight = new THREE.PointLight(0xfff1d8, 1.15, 40);     // warm key
    keyLight.position.set(2.6, 3.4, 5.8);
    scene.add(keyLight);
    var vaultLight = new THREE.PointLight(0xffc23a, 0.55, 22);    // gold work light (taps flash it)
    vaultLight.position.set(0, 0.25, 3.2);
    vault.add(vaultLight);
    var emergencyLight = new THREE.PointLight(0xff2020, 0, 26);   // heat danger only
    emergencyLight.position.set(0, 0.6, 2.4);
    vault.add(emergencyLight);

    // strobes: scene-level, anchored to the canvas edges (raid only)
    var strobeRed = new THREE.SpotLight(0xff2222, 0, 34, 0.55, 0.55, 1.2);
    var strobeBlue = new THREE.SpotLight(0x2255ff, 0, 34, 0.55, 0.55, 1.2);
    var strobeTarget = new THREE.Object3D();
    scene.add(strobeTarget);
    strobeRed.target = strobeTarget; // both sweep the same target
    strobeBlue.target = strobeTarget;
    scene.add(strobeRed);
    scene.add(strobeBlue);

    /* ---------- coin pool (InstancedMesh, hard cap COIN_MAX) ---------- */
    var coinGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.026, 14);
    coinGeo.rotateX(Math.PI / 2);
    var coinMesh = new THREE.InstancedMesh(coinGeo, coinMat, CFG.COIN_MAX);
    coinMesh.frustumCulled = false;
    vault.add(coinMesh);
    var coins = [];
    for (var ci = 0; ci < CFG.COIN_MAX; ci++) {
      coins.push({
        live: false, age: 0, bounces: 0, squashT: 9, squashAmt: 0,
        px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, spin: 1
      });
    }
    var coinSeed = 1;

    function spawnCoins(n, seed, bigSpread) {
      var spawned = 0;
      for (var i = 0; i < coins.length && spawned < n; i++) {
        var c = coins[i];
        if (c.live) continue;
        c.live = true; c.age = 0; c.bounces = 0; c.squashT = 9; c.squashAmt = 0;
        var fan = spawned; // coherent radial spray even when pool slots scatter
        var ang = (fan / Math.max(1, n)) * Math.PI * 2 + H.hash01(seed + fan) * 0.8;
        c.px = Math.cos(ang) * CFG.SEAM_R;
        c.py = Math.sin(ang) * CFG.SEAM_R;
        c.pz = 0.16;
        var v = H.coinVelocity(fan, Math.max(1, n), seed + (bigSpread ? 500 : 0));
        c.vx = v.x * (bigSpread ? 1.25 : 1);
        c.vy = v.y * (bigSpread ? 1.35 : 1);
        c.vz = v.z;
        c.rx = H.hash01(seed * 3 + fan) * Math.PI * 2;
        c.ry = H.hash01(seed * 5 + fan) * Math.PI * 2;
        c.rz = H.hash01(seed * 7 + fan) * Math.PI * 2;
        c.spin = 4 + H.hash01(seed * 11 + fan) * 9;  // slight rotation randomness
        c.sx = c.sy = c.sz = 1;
        spawned++;
      }
    }

    function updateCoins(dt) {
      var liveCount = 0;
      for (var i = 0; i < coins.length; i++) {
        var c = coins[i];
        if (!c.live) continue;
        c.age += dt;
        c.vy -= CFG.GRAVITY * dt;
        c.px += c.vx * dt;
        c.py += c.vy * dt;
        c.pz += c.vz * dt;
        // soft bounds keep coins on the ledge shelf
        if (c.pz < -0.15) { c.pz = -0.15; c.vz *= -0.3; }
        if (c.pz > 1.05) { c.pz = 1.05; c.vz *= -0.3; }
        // bounce with squash (real impact strength)
        if (c.py < CFG.LEDGE_TOP + 0.03 && c.vy < 0) {
          var impact = -c.vy;
          c.py = CFG.LEDGE_TOP + 0.03;
          c.vy = impact * CFG.COIN_BOUNCE;
          c.vx *= 0.72; c.vz *= 0.78;
          c.bounces++;
          c.squashT = 0;
          c.squashAmt = H.bounceSquash(impact);
        }
        c.squashT += dt;
        var sq = c.squashT < 0.18 ? c.squashAmt * (1 - H.easeOutCubic(c.squashT / 0.18)) : 0;
        c.rx += c.spin * dt * 0.9;
        c.ry += c.spin * dt * 1.3;
        // scale-out fade over the last 0.35s of life
        var fade = c.age > CFG.COIN_LIFE_S - 0.35
          ? Math.max(0, 1 - (c.age - (CFG.COIN_LIFE_S - 0.35)) / 0.35) : 1;
        if (c.age >= CFG.COIN_LIFE_S || c.bounces > 4) { c.live = false; fade = 0; }
        dummy.position.set(c.px, c.py, c.pz);
        dummy.rotation.set(c.rx, c.ry, c.rz);
        dummy.scale.set(c.sx * (1 + sq * 0.5) * fade, c.sy, c.sz * (1 + sq * 0.5) * fade);
        dummy.scale.y = c.sy * (1 - sq) * fade;
        dummy.updateMatrix();
        coinMesh.setMatrixAt(liveCount, dummy.matrix);
        liveCount++;
      }
      coinMesh.count = liveCount;
      coinMesh.instanceMatrix.needsUpdate = true;
    }

    /* ---------- crew silhouettes (capsules + heads, idle bob / working) ---------- */
    var CREW_SLOTS = [
      { x: -2.35, z: 0.42 }, { x: -1.6, z: 0.78 }, { x: -0.9, z: 0.35 },
      { x: -0.25, z: 0.8 }, { x: 0.4, z: 0.38 }, { x: 1.1, z: 0.8 },
      { x: 1.75, z: 0.42 }, { x: 2.4, z: 0.75 }
    ];
    var bodyGeo = new THREE.CapsuleGeometry(0.09, 0.2, 4, 8);
    var headGeo = new THREE.SphereGeometry(0.075, 10, 8);
    var crewBodies = new THREE.InstancedMesh(bodyGeo, silhouetteMat, CFG.CREW_FIG_MAX);
    var crewHeads = new THREE.InstancedMesh(headGeo, silhouetteMat, CFG.CREW_FIG_MAX);
    crewBodies.frustumCulled = false;
    crewHeads.frustumCulled = false;
    vault.add(crewBodies);
    vault.add(crewHeads);
    var crewScales = []; // per-slot pop-in scale (easeOutBack)
    for (var cs = 0; cs < CFG.CREW_FIG_MAX; cs++) crewScales.push(0);

    function updateCrew(dt, t, wantCount) {
      for (var i = 0; i < CFG.CREW_FIG_MAX; i++) {
        var target = (i < wantCount) ? 1 : 0;
        crewScales[i] = target > crewScales[i]
          ? Math.min(1, crewScales[i] + dt / 0.45)
          : Math.max(0, crewScales[i] - dt / 0.3);
        var pop = H.easeOutBack(crewScales[i]);
        var slot = CREW_SLOTS[i];
        var worker = i % 2 === 0;
        var phase = i * 1.7;
        var tt = t * 0.001; // t is ms — animations tick in seconds
        var bob = REDUCED ? 0 : Math.sin(tt * (worker ? 4.4 : 1.6) + phase) * 0.022;
        var lean = REDUCED ? 0 : (worker ? Math.sin(tt * 4.4 + phase) * 0.09 : Math.sin(tt * 0.9 + phase) * 0.02);
        var baseY = CFG.LEDGE_TOP + 0.2 * pop;
        dummy.position.set(slot.x, baseY + bob, slot.z);
        dummy.rotation.set(lean * 0.4, (worker ? 0.25 : -0.2), lean);
        dummy.scale.setScalar(Math.max(0.001, pop));
        dummy.updateMatrix();
        crewBodies.setMatrixAt(i, dummy.matrix);
        dummy.position.set(slot.x, baseY + bob + 0.24 * pop, slot.z);
        dummy.rotation.set(lean * 0.4, 0, lean * 0.5);
        dummy.updateMatrix();
        crewHeads.setMatrixAt(i, dummy.matrix);
      }
      crewBodies.instanceMatrix.needsUpdate = true;
      crewHeads.instanceMatrix.needsUpdate = true;
    }

    /* ---------- dust motes in the vault light ---------- */
    var dustPos = new Float32Array(CFG.DUST_COUNT * 3);
    var dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    var dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      map: dustTex, size: 0.055, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    }));
    dust.frustumCulled = false;
    vault.add(dust);
    function updateDust(t) {
      for (var i = 0; i < CFG.DUST_COUNT; i++) {
        var p = H.dustDrift(i, REDUCED ? 0 : t);
        dustPos[i * 3] = p.x; dustPos[i * 3 + 1] = p.y; dustPos[i * 3 + 2] = p.z;
      }
      dustGeo.attributes.position.needsUpdate = true;
    }

    /* ---------- rivet specular glints (two slow sparkles) ---------- */
    var glints = [];
    for (var gi = 0; gi < 2; gi++) {
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softGoldTex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      sprite.scale.set(0.16, 0.16, 1);
      vault.add(sprite);
      glints.push(sprite);
    }
    function updateGlints(t) {
      for (var i = 0; i < glints.length; i++) {
        var phase = t * (REDUCED ? 0 : 0.00035) + i * 0.5;
        var ang = phase % (Math.PI * 2);
        var vis = Math.max(0, Math.sin(phase % (Math.PI * 2) * 3)); // blips as they pass
        glints[i].position.set(Math.cos(ang) * 2.18, Math.sin(ang) * 2.18, 0.26);
        glints[i].material.opacity = REDUCED ? 0 : vis * 0.5;
      }
    }

    /* ---------- heat haze overlay (additive red, never a flash) ---------- */
    var haze = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softRedTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    scene.add(haze);

    /* ---------- police light bar silhouette at the edge (raid only) ---------- */
    var policeBar = new THREE.Group();
    var barBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.14, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x0a0d12, metalness: 0.4, roughness: 0.8 })
    );
    policeBar.add(barBase);
    var lampMats = [];
    [[-0.24, COL.red], [0.24, COL.blue]].forEach(function (cfg) {
      var lampMat = new THREE.MeshStandardMaterial({
        color: cfg[1], emissive: cfg[1], emissiveIntensity: 0, roughness: 0.4
      });
      lampMats.push(lampMat);
      var lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.24), lampMat);
      lamp.position.set(cfg[0], 0.09, 0);
      policeBar.add(lamp);
      var halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cfg[0] < 0 ? softRedTex : makeGlowTexture('rgba(120,150,255,0.9)', 'rgba(40,70,255,0.3)'),
        transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      halo.scale.set(1.3, 1.3, 1);
      halo.position.set(cfg[0], 0.2, 0);
      policeBar.add(halo);
      lampMats.push(halo.material); // halo shares the strobe phase
    });
    policeBar.scale.setScalar(0.001);
    policeBar.visible = false;
    scene.add(policeBar);

    /* ==========================================================
       REGISTRATION — the 3D vault locks onto the DOM gold circle
       (cached rects; refreshed on resize/scroll + twice a second)
       ========================================================== */
    var vaultRect = { left: 0, top: 0, width: 300, height: 300 };
    var canvasRect = { left: 0, top: 0, width: 800, height: 600 };
    var rectsDirty = true;
    function refreshRects() {
      rectsDirty = true;
    }
    function readRects() {
      if (!rectsDirty) return;
      rectsDirty = false;
      try {
        if (vaultEl) vaultRect = vaultEl.getBoundingClientRect();
        canvasRect = canvas.getBoundingClientRect();
      } catch (e) { rectsDirty = false; }
    }

    // NDC of the DOM vault circle center, relative to the canvas
    function vaultNDC() {
      var cx = vaultRect.left + vaultRect.width / 2;
      var cy = vaultRect.top + vaultRect.height / 2;
      return {
        x: ((cx - canvasRect.left) / Math.max(1, canvasRect.width)) * 2 - 1,
        y: -(((cy - canvasRect.top) / Math.max(1, canvasRect.height)) * 2 - 1)
      };
    }

    // Scene-level edge anchors (strobe lights, police bar, haze) follow
    // the canvas — never the vault — so sweeps stay pinned to the frame.
    function layoutEdgeAnchors() {
      var zx = halfW, zy = halfH;
      policeBar.position.set(-zx * 0.86, -zy * 0.7, 3.4);
      strobeRed.position.set(-zx * 1.18, zy * 0.6, 4.4);
      strobeBlue.position.set(zx * 1.18, zy * 0.6, 4.4);
      haze.position.set(0, 0, 4.6);
      haze.scale.set(zx * 1.9, zy * 1.9, 1);
    }

    function updateRegistration() {
      var hubPx = vaultRect.width / 2;
      var doorPx = Math.min(hubPx * CFG.DOOR_HUB_RATIO, canvasRect.width * 0.46);
      var doorR = Math.max(0.5, doorPx * worldPerPx);
      vault.scale.setScalar(doorR / CFG.DOOR_R);
      var nd = vaultNDC();
      vault.position.set(nd.x * halfW, nd.y * halfH, 0);
    }

    /* ==========================================================
       STATE SNAPSHOT (pushed by game.js — PART 1 never touched)
       ========================================================== */
    var SNAP_DEFAULTS = {
      heat: 0, crewCount: 0, drillTier: 0, prestige: 0,
      cps: 0, tapValue: 5, raidActive: false
    };
    function readSnapshot() {
      if (typeof BankSim !== 'undefined' &&
          typeof BankSim.getVault3DSnapshot === 'function') {
        return BankSim.getVault3DSnapshot() || SNAP_DEFAULTS;
      }
      return SNAP_DEFAULTS;
    }

    /* ---------- animation state ---------- */
    var tapPunchT = 9, lightPunchT = 9, wheelSpin = 0, wheelRot = 0;
    var goldMix = 0, seamBoost = 0, crewWant = 0;
    var drillTierSeen = -1, prestigeSeen = -1, raidSeen = false;
    var strobeLevel = 0, barPopT = 9;
    var clock = null, rafId = 0, running = false, frame = 0;

    /* ---------- tap: door recoil + coin spray + light flash ---------- */
    function onTap(value) {
      tapPunchT = 0;
      lightPunchT = 0;
      wheelSpin += CFG.WHEEL_SPIN_TAP * (0.8 + Math.random() * 0.5);
      coinSeed = (coinSeed + 1) % 9973;
      spawnCoins(H.coinSpawnCount(value), coinSeed * 13, false);
    }
    Vault3D.onTap = onTap; // game.js calls this from the ONE tap router

    /* ---------- per-frame update (all state-driven, all eased) ---------- */
    function update(dt, t) {
      var snap = readSnapshot();

      // --- door micro-recoil: scale + rotation punch, easeOutBack settle ---
      tapPunchT += dt * 1000;
      var punch = H.recoilDecay(tapPunchT, CFG.RECOIL_MS);
      doorPivot.scale.setScalar(1 + CFG.RECOIL_SCALE * punch);
      doorPivot.rotation.x = -CFG.RECOIL_TILT * punch;
      doorPivot.position.z = -0.06 * Math.max(0, punch);

      // --- handle wheel: idle wobble + tap spin + slow drift ---
      wheelRot += (wheelSpin + (REDUCED ? 0 : 0.12)) * dt;
      wheelSpin = H.dampCurve(wheelSpin, 0, 3.2, dt);
      wheelGroup.rotation.z = wheelRot + (REDUCED ? 0 : H.wobbleAngle(t));
      wheelGroup.position.y = Math.sin(t * 0.0011) * 0.015 * (REDUCED ? 0 : 1);

      // --- vault light flash on tap (single pulse, eased decay) ---
      lightPunchT += dt * 1000;
      var flashPunch = H.recoilDecay(lightPunchT, 360);
      vaultLight.intensity = 0.55 + 2.1 * Math.max(0, flashPunch);

      // --- seam glow pulses with the income tick ---
      seamBoost = H.dampCurve(seamBoost, 0, 2.4, dt);
      var pulse = H.seamPulse(t, snap.cps);
      seamMat.opacity = H.clamp(pulse * 0.75 + seamBoost, 0, 1);

      // --- prestige: door steel → gold, smoothly damped ---
      var goldTarget = H.prestigeGoldMix(snap.prestige);
      goldMix = H.dampCurve(goldMix, goldTarget, 3, dt);
      doorMat.color.copy(COL.steel).lerp(COL.gold, goldMix);
      wheelMat.color.copy(COL.steelMid).lerp(COL.gold, goldMix * 0.55);

      // --- prestige edge → gold sweep + coin fountain ---
      if (prestigeSeen >= 0 && snap.prestige > prestigeSeen) {
        coinSeed = (coinSeed + 1) % 9973;
        spawnCoins(26, coinSeed * 13 + 7, true);
        seamBoost = 0.9;
        lightPunchT = 0;
      }
      prestigeSeen = snap.prestige;

      // --- drill evolution: rusty → diamond-tipped → laser beam ---
      if (snap.drillTier !== drillTierSeen) {
        drillTierSeen = snap.drillTier;
        var dv = H.drillVisualTier(drillTierSeen);
        drillGroup.visible = dv.visible;
        drillBodyMat.color.setHex(dv.body);
        drillBitMat.color.setHex(dv.bit);
        drillBitMat.emissive.setHex(dv.bit);
        drillBitMat.emissiveIntensity = dv.bitGlow * 0.8;
      }
      var dvNow = H.drillVisualTier(drillTierSeen);
      var beamPulse = 0.75 + 0.25 * Math.sin(t * 0.02);
      beamMat.opacity = dvNow.beam * beamPulse;
      contactGlow.material.opacity = dvNow.beam * 0.8 * beamPulse;
      drillGroup.rotation.y = REDUCED ? 0 : Math.sin(t * 0.02) * 0.06 * dvNow.wobble;
      drillGroup.rotation.x = REDUCED ? 0 : Math.sin(t * 0.055) * 0.02 * dvNow.wobble;

      // --- crew silhouettes (count follows crew size) ---
      crewWant = H.crewFigureCount(snap.crewCount);
      updateCrew(dt, t, crewWant);

      // --- dust + glints ---
      updateDust(t);
      updateGlints(t);

      // --- heat: emergency light + haze + camera shake ---
      var danger = H.heatDangerLevel(snap.heat);
      emergencyLight.intensity = danger * 1.35;
      var shakeAmp = REDUCED ? 0 : H.heatShakeAmp(snap.heat);
      var off = H.shakeOffset(t, shakeAmp);
      camera.position.set(off.x, off.y, CFG.CAM_DIST);
      camera.lookAt(0, 0, 0);

      // --- raid: strobes sweep, police bar pops in, haze breathes ---
      var raidOn = !!snap.raidActive;
      if (raidOn !== raidSeen) {
        if (raidOn) barPopT = 0;                 // easeOutBack pop-in
        raidSeen = raidOn;
      }
      strobeLevel = H.dampCurve(strobeLevel, raidOn ? 1 : 0, raidOn ? 6 : 3, dt);
      var p = CFG.STROBE_PERIOD_MS;
      var iRed = REDUCED ? 0.55 : H.strobeIntensity(t, p);
      var iBlue = REDUCED ? 0.55 : H.strobeIntensity(t + p / 2, p);
      strobeRed.intensity = strobeLevel * iRed * 3.4;
      strobeBlue.intensity = strobeLevel * iBlue * 3.4;
      var sweep = Math.sin(t * 0.0016) * 2.2;
      strobeTarget.position.set(sweep, vault.position.y * 0.4, 0.4);
      // police bar: lamps + halos share the strobe phases
      barPopT += dt * 1000;
      var barPop = H.easeOutBack(H.clamp(barPopT / 420, 0, 1)); // pops IN with overshoot
      if (strobeLevel > 0.01) {
        policeBar.visible = true;
        policeBar.scale.setScalar(Math.max(0.001, barPop * strobeLevel));
        policeBar.rotation.z = REDUCED ? 0.1 : 0.1 + Math.sin(t * 0.011) * 0.05;
        lampMats[0].emissiveIntensity = iRed * 2.6 * strobeLevel;
        lampMats[2].emissiveIntensity = iBlue * 2.6 * strobeLevel;
        lampMats[1].opacity = iRed * 0.65 * strobeLevel;
        lampMats[3].opacity = iBlue * 0.65 * strobeLevel;
      } else {
        policeBar.visible = false;
      }
      haze.material.opacity = danger * 0.24 + strobeLevel * (iRed * 0.10 + iBlue * 0.06);

      // --- coins last (may be spawned above) ---
      updateCoins(dt);

      // --- registration: lock the 3D door behind the DOM gold circle ---
      if ((frame % 30) === 0) refreshRects();
      readRects();
      updateRegistration();
    }

    /* ==========================================================
       LOOP — pause when hidden, resume on visibilitychange
       ========================================================== */
    function frameTick() {
      if (!running) return;
      rafId = requestAnimationFrame(frameTick);
      var dt = clock.getDelta();
      if (dt > 0.05) dt = 0.05; // clock clamp (no physics explosions)
      frame++;
      update(dt, clock.elapsedTime * 1000);
      renderer.render(scene, camera);
      if (frame === 3) {
        canvas.className = 'on'; // fade in once the first frames are up
      }
    }

    function start() {
      if (running) return;
      running = true;
      clock = new THREE.Clock();
      clock.start();
      rafId = requestAnimationFrame(frameTick);
    }
    function stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else start();
    });
    window.addEventListener('resize', function () {
      applySize();
      layoutEdgeAnchors();
    }, { passive: true });
    window.addEventListener('scroll', refreshRects, { passive: true });
    window.addEventListener('orientationchange', function () {
      applySize();
      layoutEdgeAnchors();
    }, { passive: true });

    // boot
    applySize();
    layoutEdgeAnchors();
    drillTierSeen = -1; // force first-frame drill apply
    start();
  })();
}




