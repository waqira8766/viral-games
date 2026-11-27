/* ============================================================
 * ULTIMATE COOKING — js/scene.js
 * three.js cozy-kitchen diorama. Guarded: needs window + THREE.
 * ============================================================ */
(function () {
  'use strict';

  var S = {};
  var UC = (typeof window !== 'undefined') ? window.UC : null;

  /* stub out if THREE is missing (node safety) */
  if (typeof THREE === 'undefined' || typeof window === 'undefined') {
    S.init = function () { return false; };
    if (typeof module !== 'undefined' && module.exports) module.exports = S;
    if (typeof window !== 'undefined') window.UCScene = S;
    return;
  }

  /* ---------------- module state ---------------- */
  var renderer, scene, camera, canvas;
  var raycaster, _ndc, _v1, _v2, _v3;
  var hitList = [];
  var world = null;        /* per-restaurant dynamic group */
  var bins = {};           /* ingId -> bin record */
  var binOrder = [];
  var pans = [];           /* pan records */
  var ovenRec = null, matRec = null;
  var boardRec = null, plateRec = null, trashRec = null, jarRec = null;
  var catRec = null, radioRec = null, signRec = null;
  var customers = [];      /* pooled rigs */
  var dragMesh = null, dragId = null;
  var plateStack = [];     /* built food groups on the plate */
  var plateRev = -1, boardRev = -1, boardIng = null;
  var tweens = [];
  var heatLevel = 0;
  var camT = 0;
  var time = 0;

  /* scratch (no per-frame allocation) */
  _ndc = new THREE.Vector2();
  _v1 = new THREE.Vector3();
  _v2 = new THREE.Vector3();
  _v3 = new THREE.Vector3();
  raycaster = new THREE.Raycaster();

  /* ================================================================
   * PROCEDURAL TEXTURES
   * ================================================================ */
  function canvasTex(w, h, draw) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function woodTex(base, dark, plankH, vertical) {
    return canvasTex(256, 256, function (g, w, h) {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      var step = plankH || 32;
      for (var y = 0; y < h; y += step) {
        g.fillStyle = 'rgba(' + dark + ',' + (0.05 + Math.random() * 0.08).toFixed(2) + ')';
        if (vertical) g.fillRect(0, y, w, 2);
        else g.fillRect(y, 0, 2, h);
        g.fillStyle = 'rgba(0,0,0,0.06)';
        if (vertical) g.fillRect(0, y + step - 2, w, 2);
        else g.fillRect(y + step - 2, 0, 2, h);
      }
      /* grain strokes */
      g.strokeStyle = 'rgba(0,0,0,0.05)';
      for (var i = 0; i < 60; i++) {
        g.beginPath();
        var yy = Math.random() * h, xx = Math.random() * w;
        g.moveTo(xx, yy);
        g.bezierCurveTo(xx + 30, yy + 4, xx + 60, yy - 4, xx + 90, yy + 2);
        g.stroke();
      }
    });
  }
  function radialTex(inner, mid, size) {
    return canvasTex(size || 128, size || 128, function (g, w, h) {
      var grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, inner);
      grd.addColorStop(0.4, mid);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    });
  }
  function signTex(name, tag) {
    return canvasTex(512, 256, function (g, w, h) {
      g.fillStyle = '#6B4A2F'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#F7E3C0'; g.fillRect(14, 14, w - 28, h - 28);
      g.fillStyle = '#4A3222';
      g.textAlign = 'center';
      g.font = '900 64px "Trebuchet MS", sans-serif';
      g.fillText(name, w / 2, 108);
      g.font = 'italic 30px Georgia, serif';
      g.fillStyle = '#B0562F';
      g.fillText(tag, w / 2, 160);
      /* little doodles */
      g.fillStyle = '#E8B04B';
      g.beginPath(); g.arc(70, 200, 14, 0, 7); g.fill();
      g.fillStyle = '#FF7A59';
      g.beginPath(); g.arc(w - 70, 200, 14, 0, 7); g.fill();
      g.fillStyle = '#7BC950';
      g.fillRect(100, 194, 24, 12);
    });
  }

  var TEX = {};
  var MAT = {};

  function lambert(color, opts) {
    var m = new THREE.MeshLambertMaterial({ color: color });
    if (opts && opts.flat) m.flatShading = true;
    return m;
  }

  /* ================================================================
   * FOOD MESH FACTORY
   * ================================================================ */
  var STACK_H = {
    bun_bottom: 0.17, bun_top: 0.19, patty: 0.2, lettuce: 0.06, tomato: 0.08,
    cheese: 0.05, dough: 0.1, sauce: 0.04, cheese_p: 0.04, pepperoni: 0.05,
    mushroom: 0.05, pepper: 0.04, olive: 0.04, nori: 0.03, rice: 0.09,
    salmon: 0.07, avocado: 0.05, cucumber: 0.05, sponge: 0.2, cream: 0.1,
    chocolate: 0.1, strawberry: 0.07, frosting: 0.14, cherry: 0.12
  };

  function sph(r, col, flat) {
    var m = new THREE.Mesh(new THREE.SphereGeometry(r, flat ? 8 : 14, flat ? 6 : 10), lambert(col, { flat: !!flat }));
    return m;
  }
  function cyl(rt, rb, h, col, flat, seg) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || (flat ? 9 : 18)), lambert(col, { flat: !!flat }));
    return m;
  }
  function box(w, h, d, col, flat) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lambert(col, { flat: !!flat }));
    return m;
  }

  S.makeFood = function (id) {
    var g = new THREE.Group();
    var C = UC.ING[id].color;
    switch (id) {
      case 'bun_bottom':
        var b = sph(0.42, C, true); b.scale.set(1, 0.42, 1); g.add(b); break;
      case 'bun_top':
        var bt = sph(0.44, C, true); bt.scale.set(1, 0.5, 1); bt.position.y = 0.05; g.add(bt);
        for (var s = 0; s < 6; s++) {
          var seed = sph(0.028, 0xFDF3D8, true);
          seed.position.set(Math.sin(s * 1.3) * 0.24, 0.2, Math.cos(s * 1.3) * 0.24);
          g.add(seed);
        }
        break;
      case 'patty':
        g.add(cyl(0.42, 0.44, 0.2, C, true));
        break;
      case 'lettuce':
        var geo = new THREE.CircleGeometry(0.5, 22);
        var pos = geo.attributes.position;
        for (var v = 12; v < pos.count; v++) {
          var vx = pos.getX(v), vy = pos.getY(v);
          var len = Math.sqrt(vx * vx + vy * vy);
          if (len > 0.3) pos.setZ(v, Math.sin(v * 2.7) * 0.09 + 0.05);
        }
        geo.computeVertexNormals();
        var lm = new THREE.MeshLambertMaterial({ color: C, side: THREE.DoubleSide });
        var ldisc = new THREE.Mesh(geo, lm);
        ldisc.rotation.x = -Math.PI / 2;
        g.add(ldisc);
        break;
      case 'tomato':
        g.add(cyl(0.33, 0.33, 0.08, C, false));
        var inner = cyl(0.3, 0.3, 0.085, 0xFF9A8C, false);
        inner.position.y = 0.001; g.add(inner);
        break;
      case 'cheese':
        var ch = box(0.72, 0.05, 0.72, C); ch.rotation.y = Math.PI / 4; g.add(ch);
        break;
      case 'dough':
        g.add(cyl(0.62, 0.6, 0.1, C, false));
        var cr = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.045, 6, 18), lambert(0xD9A45E, { flat: true }));
        cr.rotation.x = Math.PI / 2; cr.position.y = 0.02; g.add(cr);
        break;
      case 'sauce':
        var sa = sph(0.5, C, true); sa.scale.set(1, 0.14, 1); g.add(sa);
        break;
      case 'cheese_p':
        var cp = cyl(0.52, 0.52, 0.04, C, false); g.add(cp);
        break;
      case 'pepperoni':
        for (var p = 0; p < 5; p++) {
          var pep = cyl(0.1, 0.1, 0.03, C, true, 10);
          pep.position.set(Math.sin(p * 2.2) * 0.3, 0.015, Math.cos(p * 2.2) * 0.3);
          g.add(pep);
        }
        break;
      case 'mushroom':
        for (var m0 = 0; m0 < 4; m0++) {
          var cap = sph(0.12, C, true);
          cap.scale.y = 0.5;
          cap.position.set(Math.sin(m0 * 1.8) * 0.3, 0.03, Math.cos(m0 * 1.8) * 0.3);
          g.add(cap);
        }
        break;
      case 'pepper':
        for (var r0 = 0; r0 < 3; r0++) {
          var ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.035, 6, 12), lambert(C, { flat: true }));
          ring.rotation.x = Math.PI / 2;
          ring.position.set(Math.sin(r0 * 2.1) * 0.28, 0.02, Math.cos(r0 * 2.1) * 0.28);
          g.add(ring);
        }
        break;
      case 'olive':
        for (var o = 0; o < 5; o++) {
          var ol = sph(0.055, C, true); ol.scale.y = 0.6;
          ol.position.set(Math.sin(o * 2.5) * 0.3, 0.02, Math.cos(o * 2.5) * 0.3);
          g.add(ol);
        }
        break;
      case 'nori':
        g.add(box(0.68, 0.024, 0.52, C));
        break;
      case 'rice':
        var rc = sph(0.34, C, true); rc.scale.set(1.15, 0.5, 0.95); rc.position.y = 0.04; g.add(rc);
        break;
      case 'salmon':
        var sl = box(0.5, 0.13, 0.32, C); g.add(sl);
        var stripe = box(0.5, 0.02, 0.1, 0xFFE3D8); stripe.position.set(0, 0.07, 0); g.add(stripe);
        break;
      case 'avocado':
        for (var av = 0; av < 3; av++) {
          var as = sph(0.13, C, true); as.scale.y = 0.45;
          as.position.set(Math.sin(av * 2.1) * 0.25, 0.025, Math.cos(av * 2.1) * 0.25);
          g.add(as);
        }
        break;
      case 'cucumber':
        for (var cu = 0; cu < 4; cu++) {
          var cc = cyl(0.1, 0.1, 0.06, C, true, 10);
          cc.position.set(Math.sin(cu * 1.7) * 0.27, 0.03, Math.cos(cu * 1.7) * 0.27);
          g.add(cc);
        }
        break;
      case 'sponge':
        g.add(cyl(0.45, 0.45, 0.2, C, false));
        break;
      case 'cream':
        var cr2 = cyl(0.47, 0.46, 0.1, C, false); g.add(cr2);
        var drizzle = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 5, 16), lambert(0xE8B04B));
        drizzle.rotation.x = Math.PI / 2; drizzle.position.y = 0.05; g.add(drizzle);
        break;
      case 'chocolate':
        g.add(cyl(0.47, 0.46, 0.1, C, false));
        break;
      case 'strawberry':
        for (var sb = 0; sb < 3; sb++) {
          var berry = sph(0.11, C, true); berry.scale.y = 1.15;
          berry.position.set(Math.sin(sb * 2.2) * 0.24, 0.07, Math.cos(sb * 2.2) * 0.24);
          g.add(berry);
          var leaf = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.05, 5), lambert(0x7BC950, { flat: true }));
          leaf.position.set(berry.position.x, 0.16, berry.position.z);
          g.add(leaf);
        }
        break;
      case 'frosting':
        var swirl = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.075, 8, 18), lambert(C, { flat: true }));
        swirl.rotation.x = Math.PI / 2; swirl.position.y = 0.05; g.add(swirl);
        var peak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.16, 8), lambert(0xFFCAD9, { flat: true }));
        peak.position.y = 0.15; g.add(peak);
        break;
      case 'cherry':
        var ck = sph(0.11, C, false); ck.position.y = 0.05; g.add(ck);
        var stem = cyl(0.012, 0.012, 0.14, 0x4A3222, false, 6);
        stem.position.y = 0.16; stem.rotation.z = 0.3; g.add(stem);
        break;
      default:
        g.add(sph(0.3, C, true));
    }
    return g;
  };

  /* ================================================================
   * INIT / SCENE SHELL
   * ================================================================ */
  S.init = function (canvasEl) {
    canvas = canvasEl;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputEncoding = THREE.sRGBEncoding;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xF7E7C6);
    scene.fog = new THREE.Fog(0xF3E0BC, 9.5, 17);
    camera = new THREE.PerspectiveCamera(55, 1, 0.1, 40);

    /* lights */
    var hemi = new THREE.HemisphereLight(0xFFF4DE, 0xA9744F, 1.0);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xFFE3B3, 0.85);
    key.position.set(2.5, 6, 3.5);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xFFD9E8, 0.25);
    fill.position.set(-3, 4, -2);
    scene.add(fill);

    /* textures */
    TEX.floor = woodTex('#C89A66', '120,74,40', 42, true);
    TEX.floor.wrapS = TEX.floor.wrapT = THREE.RepeatWrapping;
    TEX.floor.repeat.set(3, 3);
    TEX.counter = woodTex('#B98A5A', '110,70,38', 40, false);
    TEX.counter.wrapS = THREE.RepeatWrapping; TEX.counter.repeat.set(2, 1);
    TEX.board = woodTex('#E4C193', '150,100,55', 64, false);
    TEX.crate = woodTex('#A97848', '90,55,28', 52, true);
    TEX.steam = radialTex('rgba(255,255,255,0.85)', 'rgba(255,255,255,0.28)');
    TEX.glow = radialTex('rgba(255,190,90,0.9)', 'rgba(255,140,40,0.25)');
    TEX.shadow = radialTex('rgba(40,25,10,0.45)', 'rgba(40,25,10,0.18)');
    TEX.flour = radialTex('rgba(255,250,240,0.9)', 'rgba(255,250,240,0.3)');
    TEX.sparkle = radialTex('rgba(255,240,170,1)', 'rgba(255,200,80,0.4)', 64);

    /* floor */
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshLambertMaterial({ map: TEX.floor }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    /* back wall + trim + string lights */
    var wall = new THREE.Mesh(new THREE.PlaneGeometry(34, 12), lambert(0xF9E8CE));
    wall.position.set(0, 6, -6.3);
    scene.add(wall);
    var trim = box(34, 1.1, 0.18, 0xE8CBA8); trim.position.set(0, 1.45, -6.2); scene.add(trim);
    for (var li = 0; li < 10; li++) {
      var bulb = sph(0.055, 0xFFD166, false);
      bulb.material = new THREE.MeshBasicMaterial({ color: 0xFFE3A0 });
      bulb.position.set(-4.5 + li, 3.6 + Math.sin(li * 1.2) * 0.12, -6.05);
      scene.add(bulb);
    }

    /* main counter */
    var counterMat = new THREE.MeshLambertMaterial({ map: TEX.counter });
    var counter = new THREE.Mesh(new THREE.BoxGeometry(7.6, 1.02, 4.2), counterMat);
    counter.position.set(0, 0.51, -1.1);
    scene.add(counter);
    var counterTop = new THREE.Mesh(new THREE.BoxGeometry(7.8, 0.09, 4.4), lambert(0xCE9E68));
    counterTop.position.set(0, 1.055, -1.1);
    scene.add(counterTop);
    /* counter edge stripe (customer side) */
    var edge = box(7.8, 0.1, 0.08, 0xE8654A);
    edge.position.set(0, 1.03, -3.28);
    scene.add(edge);

    S.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    initParticles();
    return true;
  };

  S.resize = function (w, h) {
    if (!renderer) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    var portrait = h >= w;
    if (portrait) {
      camera.fov = 55;
      camera.position.set(0, 4.0, 7.4);
    } else {
      camera.fov = 44;
      camera.position.set(0, 3.7, 9.4);
    }
    camera.updateProjectionMatrix();
  };

  /* ================================================================
   * TWEENS
   * ================================================================ */
  var EASE = {
    out: function (k) { return 1 - (1 - k) * (1 - k); },
    inOut: function (k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; },
    back: function (k) { var c = 1.7; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
    bounce: function (k) {
      var n1 = 7.5625, d1 = 2.75;
      if (k < 1 / d1) return n1 * k * k;
      if (k < 2 / d1) return n1 * (k -= 1.5 / d1) * k + 0.75;
      if (k < 2.5 / d1) return n1 * (k -= 2.25 / d1) * k + 0.9375;
      return n1 * (k -= 2.625 / d1) * k + 0.984375;
    }
  };
  S.tween = function (dur, tick, ease, done) {
    tweens.push({ t: 0, dur: dur, tick: tick, ease: ease || EASE.out, done: done });
  };
  function updateTweens(dt) {
    for (var i = tweens.length - 1; i >= 0; i--) {
      var tw = tweens[i];
      tw.t += dt;
      var k = Math.min(1, tw.t / tw.dur);
      tw.tick(tw.ease(k), k);
      if (k >= 1) { tweens.splice(i, 1); if (tw.done) tw.done(); }
    }
  }

  /* ================================================================
   * PARTICLES (all pooled)
   * ================================================================ */
  var bits = [], steams = [], coins = [], puffs = [], sparkles = [];
  var confetti = null, confettiData = null;

  function initParticles() {
    /* chop bits */
    for (var i = 0; i < 22; i++) {
      var b = box(0.07, 0.07, 0.07, 0xffffff, true);
      b.visible = false; scene.add(b);
      bits.push({ m: b, vx: 0, vy: 0, vz: 0, life: 0, spin: 0 });
    }
    /* steam sprites */
    for (i = 0; i < 12; i++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.steam, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending
      }));
      sp.visible = false; scene.add(sp);
      steams.push({ m: sp, life: 0, dur: 1, vy: 0, s0: 1 });
    }
    /* coin meshes */
    for (i = 0; i < 6; i++) {
      var cn = cyl(0.09, 0.09, 0.025, 0xFFC93C, false, 14);
      cn.rotation.x = Math.PI / 2;
      cn.visible = false; scene.add(cn);
      coins.push({ m: cn, t: 0, dur: 0.8, from: null, to: null });
    }
    /* puffs (flour / angry smoke) */
    for (i = 0; i < 10; i++) {
      var pf = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.flour, transparent: true, opacity: 0, depthWrite: false
      }));
      pf.visible = false; scene.add(pf);
      puffs.push({ m: pf, life: 0, dur: 0.8, vy: 0, s0: 1, tint: 1 });
    }
    /* sparkles */
    for (i = 0; i < 8; i++) {
      var sk = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.sparkle, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending
      }));
      sk.visible = false; scene.add(sk);
      sparkles.push({ m: sk, life: 0, dur: 0.5 });
    }
    /* confetti points */
    var N = 90;
    var geo = new THREE.BufferGeometry();
    var posArr = new Float32Array(N * 3);
    var colArr = new Float32Array(N * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    confetti = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.09, vertexColors: true, transparent: true, opacity: 1, depthWrite: false
    }));
    confetti.visible = false;
    confettiData = { n: N, vel: new Float32Array(N * 3), life: 0, active: false };
    scene.add(confetti);
  }

  var _bitPtr = 0, _steamPtr = 0, _puffPtr = 0, _sparkPtr = 0, _coinPtr = 0;

  S.fxBits = function (pos, colorHex, n) {
    for (var i = 0; i < (n || 5); i++) {
      var b = bits[_bitPtr]; _bitPtr = (_bitPtr + 1) % bits.length;
      b.m.visible = true;
      b.m.position.set(pos.x + (Math.random() - 0.5) * 0.3, pos.y + 0.1, pos.z + (Math.random() - 0.5) * 0.3);
      b.m.material.color.setHex(colorHex);
      b.m.scale.setScalar(0.7 + Math.random() * 0.6);
      b.vx = (Math.random() - 0.5) * 2.2;
      b.vy = 1.6 + Math.random() * 1.6;
      b.vz = (Math.random() - 0.5) * 1.4 - 0.4;
      b.spin = (Math.random() - 0.5) * 12;
      b.life = 0.7 + Math.random() * 0.3;
    }
  };
  S.fxSteam = function (pos, big) {
    var s = steams[_steamPtr]; _steamPtr = (_steamPtr + 1) % steams.length;
    s.m.visible = true;
    s.m.position.set(pos.x + (Math.random() - 0.5) * 0.2, pos.y, pos.z + (Math.random() - 0.5) * 0.2);
    s.life = 0; s.dur = 1.2 + Math.random() * 0.5;
    s.vy = 0.55 + Math.random() * 0.3;
    s.s0 = (big ? 0.55 : 0.3) + Math.random() * 0.2;
  };
  S.fxPuff = function (pos, color, size) {
    var p = puffs[_puffPtr]; _puffPtr = (_puffPtr + 1) % puffs.length;
    p.m.visible = true;
    p.m.position.set(pos.x, pos.y, pos.z);
    p.m.material.color.setHex(color || 0xFFFDF6);
    p.m.material.blending = (color && color === 0x9A8F86) ? THREE.NormalBlending : THREE.NormalBlending;
    p.life = 0; p.dur = 0.9; p.vy = 0.5; p.s0 = size || 0.4;
  };
  S.fxSparkle = function (pos) {
    for (var i = 0; i < 3; i++) {
      var s = sparkles[_sparkPtr]; _sparkPtr = (_sparkPtr + 1) % sparkles.length;
      s.m.visible = true;
      s.m.position.set(pos.x + (Math.random() - 0.5) * 0.5, pos.y + 0.2 + Math.random() * 0.3, pos.z + (Math.random() - 0.5) * 0.3);
      s.m.scale.setScalar(0.14 + Math.random() * 0.12);
      s.life = 0; s.dur = 0.45 + Math.random() * 0.2;
    }
  };
  S.fxCoin = function (from, to) {
    var c = coins[_coinPtr]; _coinPtr = (_coinPtr + 1) % coins.length;
    c.m.visible = true;
    c.from = { x: from.x, y: from.y, z: from.z };
    c.to = { x: to.x, y: to.y, z: to.z };
    c.t = 0; c.dur = 0.75;
  };
  S.fxConfetti = function () {
    var posArr = confetti.geometry.attributes.position.array;
    var colArr = confetti.geometry.attributes.color.array;
    var palette = [0xFF7A59, 0xFFC93C, 0x7BC950, 0x7EC8E3, 0xE4A0C7, 0xFFFDF6];
    for (var i = 0; i < confettiData.n; i++) {
      posArr[i * 3] = (Math.random() - 0.5) * 0.6;
      posArr[i * 3 + 1] = 3.6 + Math.random() * 0.4;
      posArr[i * 3 + 2] = -2 + Math.random() * 0.6;
      confettiData.vel[i * 3] = (Math.random() - 0.5) * 2.4;
      confettiData.vel[i * 3 + 1] = 1.2 + Math.random() * 1.6;
      confettiData.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
      var col = new THREE.Color(palette[i % palette.length]);
      colArr[i * 3] = col.r; colArr[i * 3 + 1] = col.g; colArr[i * 3 + 2] = col.b;
    }
    confetti.geometry.attributes.position.needsUpdate = true;
    confetti.geometry.attributes.color.needsUpdate = true;
    confetti.visible = true;
    confettiData.life = 2.6; confettiData.active = true;
  };

  function updateParticles(dt) {
    var i, p;
    for (i = 0; i < bits.length; i++) {
      p = bits[i];
      if (!p.m.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.m.visible = false; continue; }
      p.vy -= 6.5 * dt;
      p.m.position.x += p.vx * dt;
      p.m.position.y += p.vy * dt;
      p.m.position.z += p.vz * dt;
      p.m.rotation.x += p.spin * dt;
      p.m.rotation.z += p.spin * 0.7 * dt;
      if (p.m.position.y < 1.06) { p.m.position.y = 1.06; p.vy *= -0.35; p.vx *= 0.7; }
    }
    for (i = 0; i < steams.length; i++) {
      p = steams[i];
      if (!p.m.visible) continue;
      p.life += dt;
      var k = p.life / p.dur;
      if (k >= 1) { p.m.visible = false; continue; }
      p.m.position.y += p.vy * dt;
      var s = p.s0 * (0.6 + k * 1.3);
      p.m.scale.set(s, s, 1);
      p.m.material.opacity = 0.4 * (1 - k);
    }
    for (i = 0; i < puffs.length; i++) {
      p = puffs[i];
      if (!p.m.visible) continue;
      p.life += dt;
      var k2 = p.life / p.dur;
      if (k2 >= 1) { p.m.visible = false; continue; }
      p.m.position.y += p.vy * dt;
      var s2 = p.s0 * (0.5 + k2 * 1.6);
      p.m.scale.set(s2, s2, 1);
      p.m.material.opacity = 0.75 * (1 - k2);
    }
    for (i = 0; i < sparkles.length; i++) {
      p = sparkles[i];
      if (!p.m.visible) continue;
      p.life += dt;
      var k3 = p.life / p.dur;
      if (k3 >= 1) { p.m.visible = false; continue; }
      p.m.position.y += 0.35 * dt;
      p.m.material.opacity = 1 - k3;
    }
    for (i = 0; i < coins.length; i++) {
      var c = coins[i];
      if (!c.m.visible) continue;
      c.t += dt;
      var k4 = Math.min(1, c.t / c.dur);
      var x = c.from.x + (c.to.x - c.from.x) * k4;
      var z = c.from.z + (c.to.z - c.from.z) * k4;
      var y = c.from.y + (c.to.y - c.from.y) * k4 + Math.sin(k4 * Math.PI) * 1.3;
      c.m.position.set(x, y, z);
      c.m.rotation.z += 10 * dt;
      if (k4 >= 1) {
        c.m.visible = false;
        jarWiggle();
      }
    }
    if (confettiData.active) {
      confettiData.life -= dt;
      if (confettiData.life <= 0) { confetti.visible = false; confettiData.active = false; }
      else {
        var arr = confetti.geometry.attributes.position.array;
        var vel = confettiData.vel;
        for (i = 0; i < confettiData.n; i++) {
          vel[i * 3 + 1] -= 3.2 * dt;
          arr[i * 3] += vel[i * 3] * dt;
          arr[i * 3 + 1] += vel[i * 3 + 1] * dt;
          arr[i * 3 + 2] += vel[i * 3 + 2] * dt;
          if (arr[i * 3 + 1] < 1.1) { arr[i * 3 + 1] = 1.1; vel[i * 3 + 1] = 0; vel[i * 3] *= 0.6; }
        }
        confetti.geometry.attributes.position.needsUpdate = true;
        confetti.material.opacity = Math.min(1, confettiData.life / 0.5);
      }
    }
  }

  function jarWiggle() {
    if (!jarRec) return;
    S.tween(0.3, function (k) {
      jarRec.group.scale.set(1 + Math.sin(k * Math.PI) * 0.12, 1 - Math.sin(k * Math.PI) * 0.08, 1);
    }, EASE.out);
  }

  /* ================================================================
   * HIT TARGETS
   * ================================================================ */
  function addHit(mesh, id) {
    mesh.userData.hitId = id;
    mesh.visible = false;
    scene.add(mesh);
    hitList.push(mesh);
  }
  S.raycast = function (clientX, clientY) {
    if (!renderer) return null;
    var r = canvas.getBoundingClientRect();
    _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(_ndc, camera);
    var hits = raycaster.intersectObjects(hitList, false);
    return hits.length ? hits[0].object.userData.hitId : null;
  };
  S.raycastWorld = function (clientX, clientY, out) {
    var r = canvas.getBoundingClientRect();
    _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(_ndc, camera);
    /* intersect the counter plane y=1.05 */
    var plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.05);
    if (raycaster.ray.intersectPlane(plane, out)) return out;
    out.set(0, 1.05, 0);
    return out;
  };

  /* ================================================================
   * WORLD BUILDING (per restaurant)
   * ================================================================ */
  S.build = function (rid, save) {
    /* clear previous */
    if (world) {
      scene.remove(world);
      disposeGroup(world);
    }
    hitList.length = 0;
    bins = {}; binOrder = []; pans = []; ovenRec = null; matRec = null;
    boardRec = null; plateRec = null; trashRec = null; jarRec = null;
    catRec = null; radioRec = null; signRec = null;
    plateStack = []; plateRev = -1; boardRev = -1; boardIng = null;
    dragMesh = null; dragId = null;
    for (var ci = 0; ci < customers.length; ci++) {
      if (customers[ci].group.parent) customers[ci].group.parent.remove(customers[ci].group);
    }
    customers = [];

    world = new THREE.Group();
    scene.add(world);

    var rest = UC.RESTAURANTS[rid];
    var ings = UC.restIngredients(rid);

    /* hanging sign */
    var sign = new THREE.Group();
    var boardM = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.3, 0.08), new THREE.MeshLambertMaterial({ map: signTex(rest.name, rest.tag) }));
    sign.add(boardM);
    var ropeL = cyl(0.02, 0.02, 1.2, 0x8A623F, false, 6);
    ropeL.position.set(-1.0, 1.2, 0); sign.add(ropeL);
    var ropeR = ropeL.clone(); ropeR.position.x = 1.0; sign.add(ropeR);
    sign.position.set(0, 3.6, -6.0);
    world.add(sign);
    signRec = { group: sign };

    /* ingredient bins along the front */
    var n = ings.length;
    for (var i = 0; i < n; i++) {
      var id = ings[i];
      var bx = (i - (n - 1) / 2) * 1.12;
      var bin = new THREE.Group();
      var crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.62), new THREE.MeshLambertMaterial({ map: TEX.crate }));
      crate.position.y = 0.25;
      bin.add(crate);
      var rim = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.035, 6, 14), lambert(UC.ING[id].color, { flat: true }));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.52;
      bin.add(rim);
      var mini = S.makeFood(id);
      mini.scale.setScalar(0.72);
      mini.position.y = 0.62;
      bin.add(mini);
      bin.position.set(bx, 1.1, 0.38);
      world.add(bin);
      bins[id] = { group: bin, crate: crate, mini: mini, baseY: 1.1, x: bx };
      binOrder.push(id);
      var hit = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.9, 0.9), lambert(0xffffff));
      hit.position.set(bx, 1.5, 0.38);
      addHit(hit, 'bin:' + id);
    }

    /* cutting board + knife */
    var board = new THREE.Group();
    var slab = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.08, 1.05), new THREE.MeshLambertMaterial({ map: TEX.board }));
    board.add(slab);
    var knifeG = new THREE.Group();
    var blade = box(0.9, 0.035, 0.14, 0xD8DDE2); blade.position.x = 0.35; knifeG.add(blade);
    var handle = box(0.34, 0.06, 0.1, 0x6B4A2F); handle.position.x = -0.28; knifeG.add(handle);
    knifeG.position.set(0.5, 0.12, -0.32);
    knifeG.rotation.z = 0.14;
    board.add(knifeG);
    board.position.set(-1.85, 1.1, -1.25);
    world.add(board);
    boardRec = { group: board, knife: knifeG, item: null, baseKnifeRot: knifeG.rotation.z };
    var bHit = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 1.3), lambert(0xffffff));
    bHit.position.set(-1.85, 1.3, -1.25);
    addHit(bHit, 'board');

    /* stove + pans (diner) */
    if (rest.pans > 0) {
      var stove = new THREE.Group();
      var slabS = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 1.35), lambert(0x4A4038));
      slabS.position.y = 0.05; stove.add(slabS);
      var knobF = cyl(0.06, 0.06, 0.05, 0xE8654A, true, 8);
      knobF.position.set(-0.7, 0.12, 0.55); stove.add(knobF);
      stove.position.set(1.85, 1.1, -1.25);
      world.add(stove);
      var panCount = save.upgrades.burner > 0 ? 2 : 1;
      for (var pi = 0; pi < panCount; pi++) {
        var px = panCount === 1 ? 1.85 : 1.35 + pi * 1.0;
        var pan = new THREE.Group();
        var body = cyl(0.5, 0.46, 0.13, 0x2E2A26, true);
        body.position.y = 0.13; pan.add(body);
        var inner = cyl(0.43, 0.43, 0.02, 0x4A4440, true);
        inner.position.y = 0.2; pan.add(inner);
        var handle = box(0.5, 0.05, 0.09, 0x6B4A2F);
        handle.position.set(0.62, 0.18, 0); pan.add(handle);
        var glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: TEX.glow, transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending
        }));
        glow.scale.set(1.3, 1.3, 1);
        glow.position.y = 0.28; pan.add(glow);
        var oil = new THREE.Sprite(new THREE.SpriteMaterial({
          map: TEX.glow, transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending, color: 0xFFD890
        }));
        oil.scale.set(0.7, 0.7, 1); oil.position.y = 0.23; pan.add(oil);
        var pattyHolder = new THREE.Group();
        pattyHolder.position.y = 0.22;
        pan.add(pattyHolder);
        pan.position.set(px, 1.1, -1.25);
        world.add(pan);
        pans.push({ group: pan, body: body, glow: glow, oil: oil, holder: pattyHolder, patty: null, x: px });
        var pHit = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.8, 1.15), lambert(0xffffff));
        pHit.position.set(px, 1.5, -1.25);
        addHit(pHit, 'pan:' + pi);
      }
    }

    /* oven (pizzeria) */
    if (rest.oven) {
      var ov = new THREE.Group();
      var shell = box(1.75, 1.5, 1.35, 0xB0562F); shell.position.y = 0.75; ov.add(shell);
      var mouth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.62, 0.1), lambert(0x2A1D14));
      mouth.position.set(0, 0.72, 0.69); ov.add(mouth);
      var fireGlow = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.5, 0.05), new THREE.MeshBasicMaterial({ color: 0xFF7A2E }));
      fireGlow.position.set(0, 0.72, 0.72); ov.add(fireGlow);
      var chimney = box(0.3, 0.5, 0.3, 0xB0562F); chimney.position.set(0.55, 1.7, -0.2); ov.add(chimney);
      var pizzaHolder = new THREE.Group();
      pizzaHolder.position.set(0, 0.74, 0.75);
      ov.add(pizzaHolder);
      ov.position.set(1.95, 1.1, -1.35);
      world.add(ov);
      ovenRec = { group: ov, glow: fireGlow, holder: pizzaHolder, pizza: null };
      var oHit = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.7, 1.5), lambert(0xffffff));
      oHit.position.set(1.95, 1.85, -1.35);
      addHit(oHit, 'oven');
    }

    /* plate / mat / cake stand */
    var plate = new THREE.Group();
    if (rid === 2) {
      var matslab = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 0.95), new THREE.MeshLambertMaterial({ map: TEX.board }));
      plate.add(matslab);
    } else if (rid === 3) {
      var stand = cyl(0.62, 0.52, 0.08, 0xFFF3F5, false);
      stand.position.y = 0.34; plate.add(stand);
      var stem = cyl(0.09, 0.12, 0.3, 0xFFF3F5, false);
      stem.position.y = 0.15; plate.add(stem);
    } else {
      var pl = cyl(0.72, 0.66, 0.07, 0xFFFDF6, false);
      plate.add(pl);
      var rimP = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.045, 8, 22), lambert(0xF3E9DC, { flat: true }));
      rimP.rotation.x = Math.PI / 2; rimP.position.y = 0.04; plate.add(rimP);
    }
    /* plate blob shadow */
    var shadow = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.shadow, transparent: true, opacity: 0.5, depthWrite: false }));
    shadow.scale.set(1.7, 1.7, 1);
    shadow.position.y = 0.01;
    plate.add(shadow);
    var stackHolder = new THREE.Group();
    stackHolder.position.y = 0.08;
    plate.add(stackHolder);
    plate.position.set(0, 1.09, -1.35);
    world.add(plate);
    plateRec = { group: plate, stackHolder: stackHolder, baseY: 1.09 };
    var plHit = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 1.5), lambert(0xffffff));
    plHit.position.set(0, 1.4, -1.35);
    addHit(plHit, 'plate');

    /* trash bin */
    var trash = new THREE.Group();
    var tBody = cyl(0.3, 0.26, 0.55, 0x7A8F8A, true);
    tBody.position.y = 0.28; trash.add(tBody);
    var lid = cyl(0.34, 0.34, 0.07, 0x5E7370, true);
    lid.position.y = 0.6; trash.add(lid);
    trash.position.set(3.05, 1.1, 0.3);
    world.add(trash);
    trashRec = { group: trash, lid: lid };
    var tHit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.9), lambert(0xffffff));
    tHit.position.set(3.05, 1.5, 0.3);
    addHit(tHit, 'trash');

    /* tip jar */
    var jar = new THREE.Group();
    var glass = cyl(0.22, 0.2, 0.42, 0xFFEFD0, false);
    glass.material.transparent = true; glass.material.opacity = 0.75;
    glass.position.y = 0.21; jar.add(glass);
    var coinPile = cyl(0.16, 0.16, 0.12, 0xFFC93C, false);
    coinPile.position.y = 0.1; jar.add(coinPile);
    var tag = box(0.2, 0.16, 0.02, 0xFFFDF6);
    tag.position.set(0, 0.3, 0.22); jar.add(tag);
    jar.position.set(-3.0, 1.1, -2.2);
    world.add(jar);
    jarRec = { group: jar, coinPile: coinPile };

    /* napping cat */
    var cat = new THREE.Group();
    var bodyC = sph(0.28, 0xF2B24C, true); bodyC.scale.set(1.35, 0.72, 1); bodyC.position.y = 0.18; cat.add(bodyC);
    var headC = sph(0.17, 0xF2B24C, true); headC.position.set(0.28, 0.24, 0.12); cat.add(headC);
    var earL = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.09, 4), lambert(0xF2B24C, { flat: true }));
    earL.position.set(0.22, 0.38, 0.2); cat.add(earL);
    var earR = earL.clone(); earR.position.set(0.34, 0.38, 0.16); cat.add(earR);
    var tail = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.045, 6, 10, Math.PI * 1.2), lambert(0xE89A3C, { flat: true }));
    tail.rotation.x = Math.PI / 2; tail.position.set(-0.3, 0.16, 0.05); cat.add(tail);
    var zzz = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flour, transparent: true, opacity: 0, depthWrite: false }));
    zzz.scale.set(0.3, 0.3, 1); zzz.position.set(0.45, 0.55, 0.2); cat.add(zzz);
    cat.position.set(-2.45, 1.1, -2.45);
    cat.rotation.y = 0.5;
    world.add(cat);
    catRec = { group: cat, body: bodyC, earL: earL, earR: earR, zzz: zzz, swipe: 0 };
    var catHit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.9), lambert(0xffffff));
    catHit.position.set(-2.45, 1.35, -2.45);
    addHit(catHit, 'cat');

    /* big invisible customer drop zone (drag-plate-to-serve target) */
    var cHit = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.8, 1.8), lambert(0xffffff));
    cHit.position.set(0, 2.0, -4.2);
    addHit(cHit, 'customerZone');

    /* radio */
    var radio = new THREE.Group();
    var rBox = box(0.5, 0.3, 0.2, 0xE8654A); rBox.position.y = 0.15; radio.add(rBox);
    var speaker = cyl(0.1, 0.1, 0.03, 0xF2D8C0, false, 12);
    speaker.rotation.x = Math.PI / 2; speaker.position.set(-0.12, 0.15, 0.11); radio.add(speaker);
    var antenna = cyl(0.012, 0.012, 0.4, 0xCCCCCC, false, 6);
    antenna.position.set(0.2, 0.5, 0); antenna.rotation.z = -0.4; radio.add(antenna);
    var note = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.sparkle, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    note.scale.set(0.22, 0.22, 1); note.position.set(0.28, 0.5, 0); radio.add(note);
    radio.position.set(-1.65, 1.1, -2.55);
    world.add(radio);
    radioRec = { group: radio, note: note, on: false };

    /* frost swirl indicator over plate (dessert) */
    if (rid === 3) {
      var swirl = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.flour, transparent: true, opacity: 0, depthWrite: false, color: 0xFFB7D5
      }));
      swirl.scale.set(1.1, 1.1, 1);
      swirl.position.set(0, 1.75, -1.35);
      world.add(swirl);
      plateRec.frostSwirl = swirl;
    }
    return true;
  };

  function disposeGroup(g) {
    g.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
    });
  }

  /* ================================================================
   * CUSTOMER RIGS
   * ================================================================ */
  var BODY_COLORS = [0xFF8A5C, 0xFFD166, 0x8FD694, 0x7EC8E3, 0xE4A0C7, 0xC9ADA7];
  var STOOL_X = 0, STOOL_Q = 2.5;

  function buildCustomer(cust) {
    var look = cust.look;
    var g = new THREE.Group();
    var bodyCol = BODY_COLORS[look.body % BODY_COLORS.length];
    var hatCol = new THREE.Color().setHSL(look.hue, 0.62, 0.55).getHex();

    /* stool */
    var stool = cyl(0.3, 0.34, 0.5, 0xA97848, true);
    stool.position.y = 0.25;
    g.add(stool);

    /* body */
    var body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.42, 4, 10), lambert(bodyCol, { flat: true }));
    body.position.y = 0.95;
    g.add(body);
    var apron = box(0.34, 0.3, 0.08, 0xFFFDF6);
    apron.position.set(0, 0.82, 0.27);
    g.add(apron);

    /* arms */
    var armL = sph(0.11, bodyCol, true); armL.position.set(-0.34, 0.95, 0.05); g.add(armL);
    var armR = armL.clone(); armR.position.x = 0.34; g.add(armR);

    /* head */
    var head = new THREE.Group();
    var skin = sph(0.33, 0xFFE0C2, true);
    if (look.head === 1) skin.scale.set(1.15, 0.92, 1.05);
    else if (look.head === 2) skin.scale.set(0.95, 1.12, 0.95);
    head.add(skin);

    /* eyes */
    var eyeL = sph(0.062, 0xFFFFFF, false);
    eyeL.position.set(-0.115, 0.05, 0.28);
    head.add(eyeL);
    var eyeR = eyeL.clone(); eyeR.position.x = 0.115; head.add(eyeR);
    var pupL = sph(0.028, 0x3A2A20, false);
    pupL.position.set(-0.115, 0.05, 0.335);
    head.add(pupL);
    var pupR = pupL.clone(); pupR.position.x = 0.115; head.add(pupR);

    /* mouth */
    var mouth = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.024, 6, 12, Math.PI), lambert(0x8A4A3A, { flat: true }));
    mouth.position.set(0, -0.1, 0.3);
    mouth.rotation.z = Math.PI;
    head.add(mouth);

    /* blush */
    var blushL = sph(0.04, 0xFFB08A, false); blushL.position.set(-0.2, -0.06, 0.27); head.add(blushL);
    var blushR = blushL.clone(); blushR.position.x = 0.2; head.add(blushR);

    /* hats */
    var hat = new THREE.Group();
    if (look.hat === 0) {
      var cap = sph(0.3, hatCol, true); cap.scale.y = 0.55; cap.position.y = 0.22; hat.add(cap);
      var pom = sph(0.07, 0xFFFDF6, true); pom.position.y = 0.4; hat.add(pom);
    } else if (look.hat === 1) {
      var dome = sph(0.3, hatCol, true); dome.scale.y = 0.5; dome.position.y = 0.22; hat.add(dome);
      var brim = cyl(0.24, 0.24, 0.03, hatCol, true, 12); brim.position.set(0.1, 0.13, 0.2); hat.add(brim);
    } else if (look.hat === 2) {
      var band = cyl(0.31, 0.33, 0.14, 0xFFFDF6, true, 10); band.position.y = 0.2; hat.add(band);
      var puff = sph(0.2, 0xFFFDF6, true); puff.position.y = 0.4; hat.add(puff);
    } else if (look.hat === 3) {
      var bowL = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 4), lambert(hatCol, { flat: true }));
      bowL.rotation.z = Math.PI / 2; bowL.position.set(-0.12, 0.3, 0); hat.add(bowL);
      var bowR = bowL.clone(); bowR.rotation.z = -Math.PI / 2; bowR.position.x = 0.12; hat.add(bowR);
      var knot = sph(0.05, hatCol, true); knot.position.y = 0.3; hat.add(knot);
    } else {
      var petal = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.03, 6, 10), lambert(hatCol, { flat: true }));
      petal.position.set(0.2, 0.26, 0.05); petal.rotation.y = 0.5; hat.add(petal);
      var center = sph(0.045, 0xFFC93C, true); center.position.set(0.2, 0.26, 0.11); hat.add(center);
    }
    head.add(hat);
    head.position.y = 1.62;
    g.add(head);

    /* blob shadow */
    var sh = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.shadow, transparent: true, opacity: 0.4, depthWrite: false }));
    sh.scale.set(1.1, 1.1, 1); sh.position.y = 0.02;
    g.add(sh);

    g.position.set(STOOL_X + 4.5, 0, -4.35);
    world.add(g);
    var rec = {
      group: g, head: head, body: body, mouth: mouth,
      eyeL: eyeL, eyeR: eyeR, pupL: pupL, pupR: pupR,
      armL: armL, armR: armR, cust: cust,
      bobPhase: Math.random() * 6.28, blinkT: 1 + Math.random() * 3,
      state: 'entering', moodT: 0
    };
    customers.push(rec);
    /* slide in */
    var targetX = rec.slotsTarget = 0;
    S.tween(0.55, function (k) { g.position.x = 4.5 + (targetX - 4.5) * k; }, EASE.out, function () { rec.state = 'idle'; });
    return rec;
  }

  S.setCustomerSlots = function (activeCust, nextCust) {
    /* ensure rigs match: rig[0] = active, rig[1] = next */
    if (activeCust) {
      if (!customers[0] || customers[0].cust !== activeCust) {
        if (customers[0]) removeCustomer(0);
        if (nextCust && customers[1] && customers[1].cust === activeCust) {
          /* promote queue rig */
          var rig = customers.splice(1, 1)[0];
          customers.unshift(rig);
          moveRigTo(rig, 0);
        } else {
          customers.unshift(buildCustomer(activeCust));
        }
      }
    } else if (customers[0]) {
      removeCustomer(0);
    }
    if (nextCust) {
      if (!customers[1] || customers[1].cust !== nextCust) {
        if (customers[1]) removeCustomer(1);
        var rig2 = buildCustomer(nextCust);
        customers.push(rig2);
        moveRigTo(rig2, 1);
      }
    } else if (customers[1]) {
      removeCustomer(1);
    }
  };

  function removeCustomer(idx) {
    var rec = customers[idx];
    if (!rec) return;
    customers.splice(idx, 1);
    /* slide out */
    var g = rec.group;
    var fromX = g.position.x;
    S.tween(0.5, function (k) {
      g.position.x = fromX + k * -5.5;
      g.rotation.z = k * 0.12;
    }, EASE.inOut, function () {
      world.remove(g);
      disposeGroup(g);
    });
  }
  function moveRigTo(rec, slot) {
    var tx = slot === 0 ? 0 : STOOL_Q;
    var fx = rec.group.position.x;
    S.tween(0.5, function (k) { rec.group.position.x = fx + (tx - fx) * k; }, EASE.out);
  }

  /* per-frame customer animation */
  function updateCustomers(dt, eyeTarget) {
    for (var i = 0; i < customers.length; i++) {
      var r = customers[i];
      if (!r || r.state === 'leaving') continue;
      var g = r.group;
      /* idle bob */
      r.bobPhase += dt * (2 + (r.cust.mood === 'hasty' ? 1.2 : 0));
      g.position.y = Math.sin(r.bobPhase) * 0.03;
      /* blink */
      r.blinkT -= dt;
      if (r.blinkT <= 0) {
        r.blinkT = 1.6 + Math.random() * 3;
        (function (rr) {
          S.tween(0.16, function (k) {
            var s = k < 0.5 ? 1 - k * 2 : (k - 0.5) * 2;
            rr.eyeL.scale.y = rr.eyeR.scale.y = Math.max(0.08, s);
          });
        })(r);
      }
      /* eye tracking */
      if (eyeTarget) {
        _v1.copy(eyeTarget);
        r.head.getWorldPosition(_v2);
        _v1.sub(_v2);
        var dx = _v1.x, dy = _v1.y;
        r.pupL.position.x = -0.115 + Math.max(-0.03, Math.min(0.03, dx * 0.03));
        r.pupR.position.x = 0.115 + Math.max(-0.03, Math.min(0.03, dx * 0.03));
        r.pupL.position.y = r.pupR.position.y = 0.05 + Math.max(-0.02, Math.min(0.02, dy * 0.02));
        r.head.rotation.y = Math.max(-0.25, Math.min(0.25, dx * 0.12));
      } else {
        r.head.rotation.y *= 0.92;
      }
    }
  }

  /* mood animations (event-driven) */
  S.customerHappy = function () {
    var r = customers[0];
    if (!r) return;
    r.mouth.rotation.z = Math.PI;
    r.mouth.scale.set(1.25, 1.1, 1);
    var y0 = r.group.position.y;
    S.tween(0.55, function (k) {
      r.group.position.y = y0 + Math.sin(k * Math.PI * 2) * 0.22 * (1 - k * 0.4);
    }, EASE.out);
    _v1.set(r.group.position.x, 2.2, -4.35);
    S.fxSparkle(_v1);
  };
  S.customerFrown = function () {
    var r = customers[0];
    if (!r) return;
    r.mouth.rotation.z = 0;
    r.mouth.scale.set(1, 1, 1);
    var rot0 = r.head.rotation.x;
    S.tween(0.4, function (k) {
      r.head.rotation.x = rot0 + Math.sin(k * Math.PI) * 0.22;
    });
  };
  S.customerSmile = function () {
    var r = customers[0];
    if (!r) return;
    r.mouth.rotation.z = Math.PI;
    r.mouth.scale.set(1, 1, 1);
  };
  S.customerWalkout = function () {
    var r = customers[0];
    if (!r) return;
    r.state = 'leaving';
    r.mouth.rotation.z = 0;
    _v1.set(r.group.position.x, 1.9, -4.3);
    S.fxPuff(_v1, 0x9A8F86, 0.55);
    S.fxPuff(_v1, 0xB0A69C, 0.4);
    var g = r.group;
    var fromX = g.position.x;
    S.tween(0.7, function (k) {
      g.position.x = fromX - k * 5;
      g.rotation.z = k * 0.1;
      g.position.y = -k * 0.15;
    }, EASE.inOut, function () {
      world.remove(g); disposeGroup(g);
    });
    customers.shift();
  };

  /* ================================================================
   * BIN ANIMATIONS
   * ================================================================ */
  S.binWiggle = function (id) {
    var b = bins[id];
    if (!b) return;
    S.tween(0.28, function (k) {
      var s = 1 + Math.sin(k * Math.PI) * 0.1;
      b.group.scale.set(s, 2 - s, s);
      b.mini.position.y = 0.62 + Math.sin(k * Math.PI) * 0.12;
    }, EASE.out);
  };
  S.binWrong = function (id) {
    var b = bins[id];
    if (!b) return;
    S.tween(0.4, function (k) {
      b.group.rotation.z = Math.sin(k * Math.PI * 4) * 0.09 * (1 - k);
    });
  };
  S.binBob = function (dt) {
    for (var i = 0; i < binOrder.length; i++) {
      var b = bins[binOrder[i]];
      if (!b) continue;
      b.mini.rotation.y += dt * 0.9;
      b.mini.position.y = 0.62 + Math.sin(time * 2 + i * 1.3) * 0.02;
    }
  };

  /* ================================================================
   * BOARD / CHOP ANIMATION
   * ================================================================ */
  var knifeAnim = 0;
  S.syncBoard = function (st) {
    var board = st.board;
    if (!board) {
      if (boardRec.item) {
        boardRec.group.remove(boardRec.item);
        boardRec.item = null;
      }
      boardRev = -1; boardIng = null;
      return;
    }
    if (boardIng !== board.ing) {
      boardIng = board.ing;
      if (boardRec.item) boardRec.group.remove(boardRec.item);
      var item = S.makeFood(board.ing);
      item.position.set(-0.15, 0.1, 0.05);
      item.scale.setScalar(board.kind === 'chop' ? 1 : 0.9);
      boardRec.group.add(item);
      boardRec.item = item;
      S.fxPunchIn(item);
    }
    /* progress squash + rev check */
    var rev = board.rev || 0;
    if (board.kind === 'chop' && rev !== boardRev) {
      boardRev = rev;
      S.fxChop(board.ing);
    }
  };
  S.fxChop = function (ing) {
    if (!boardRec || !boardRec.item) return;
    var item = boardRec.item;
    /* knife anticipation → slam → settle */
    var knife = boardRec.knife;
    S.tween(0.16, function (k) {
      knife.rotation.z = boardRec.baseKnifeRot + k * 0.9;
      knife.position.y = 0.12 + k * 0.4;
    }, EASE.out, function () {
      S.tween(0.09, function (k2) {
        knife.rotation.z = boardRec.baseKnifeRot + 0.9 * (1 - k2);
        knife.position.y = 0.52 - k2 * 0.4;
      }, EASE.out, function () {
        knife.rotation.z = boardRec.baseKnifeRot;
        knife.position.y = 0.12;
      });
      /* squash + bits */
      S.tween(0.22, function (k3) {
        var sq = 1 - Math.sin(k3 * Math.PI) * 0.3;
        item.scale.y = sq;
        item.scale.x = item.scale.z = 1 + (1 - sq) * 0.4;
      }, EASE.out);
      item.getWorldPosition(_v1);
      S.fxBits(_v1, UC.ING[ing].color, 6);
    });
  };
  S.fxPunchIn = function (obj) {
    obj.scale.setScalar(0.01);
    S.tween(0.24, function (k) { obj.scale.setScalar(k); }, EASE.back);
  };

  /* ================================================================
   * PAN / OVEN / PLATE SYNC
   * ================================================================ */
  var pattyCol = new THREE.Color(), rawC = new THREE.Color(0xD98A6A), doneC = new THREE.Color(0x7A4A28), burntC = new THREE.Color(0x2A1B10);

  S.syncPans = function (st) {
    for (var i = 0; i < pans.length; i++) {
      var rec = pans[i];
      var pan = st.pans[i];
      if (!pan || pan.phase === 'empty') {
        if (rec.patty) { rec.holder.remove(rec.patty); rec.patty = null; }
        rec.glow.material.opacity = 0;
        rec.oil.material.opacity = 0;
        continue;
      }
      if (!rec.patty) {
        rec.patty = S.makeFood('patty');
        rec.patty.scale.setScalar(1);
        rec.holder.add(rec.patty);
      }
      /* color lerp by cook progress */
      var k = 0;
      if (pan.phase === 'cooking') k = Math.min(1, pan.t / pan.T);
      else if (pan.phase === 'ready') k = 1;
      else k = 1.4;
      if (k > 1) pattyCol.copy(doneC).lerp(burntC, Math.min(1, (k - 1) / 0.4));
      else pattyCol.copy(rawC).lerp(doneC, k);
      rec.patty.traverse(function (o) { if (o.isMesh) o.material.color.copy(pattyCol); });
      rec.glow.material.opacity = pan.phase === 'cooking' ? 0.55 + Math.sin(time * 9) * 0.15 : 0.0;
      rec.oil.material.opacity = pan.phase === 'cooking' ? 0.35 + Math.sin(time * 5 + i) * 0.15 : 0;
      /* flip hop */
      if (pan._flipAnim) {
        pan._flipAnim = false;
        (function (pr) {
          S.tween(0.3, function (kf) {
            pr.position.y = Math.sin(kf * Math.PI) * 0.3;
            pr.rotation.x = kf * Math.PI * 2;
          }, EASE.out);
        })(rec.patty);
      }
    }
  };
  S.panFlipAnim = function (i) {
    var pan = G_state && G_state.pans && G_state.pans[i];
    if (pan) pan._flipAnim = true;
  };

  S.syncOven = function (st) {
    if (!ovenRec) return;
    var ov = st.oven;
    if (ov && ov.phase === 'baking') {
      ovenRec.glow.material.color.setHex(0xFF8A2E);
      ovenRec.glow.scale.setScalar(1 + Math.sin(time * 10) * 0.05);
      if (!ovenRec.pizza) {
        ovenRec.pizza = buildPlateSnapshot(st.plate);
        ovenRec.pizza.scale.setScalar(0.55);
        ovenRec.holder.add(ovenRec.pizza);
      }
    } else if (ov && ov.phase === 'burnt') {
      ovenRec.glow.material.color.setHex(0x553322);
      if (ovenRec.pizza) tintSnapshot(ovenRec.pizza, 0x3A2A1A, 0.8);
    } else {
      if (ovenRec.pizza) { ovenRec.holder.remove(ovenRec.pizza); ovenRec.pizza = null; }
      ovenRec.glow.material.color.setHex(0xFF7A2E);
      ovenRec.glow.scale.setScalar(1);
    }
  };

  function buildPlateSnapshot(plate) {
    var g = new THREE.Group();
    var y = 0;
    for (var i = 0; i < plate.items.length; i++) {
      var id = plate.items[i];
      var food = S.makeFood(id);
      food.position.y = y + STACK_H[id] / 2;
      y += STACK_H[id];
      g.add(food);
    }
    return g;
  }
  function tintSnapshot(g, hex, amt) {
    var c = new THREE.Color(hex);
    g.traverse(function (o) {
      if (o.isMesh) {
        o.material.color.lerp(c, amt);
        o.material.needsUpdate = true;
      }
    });
  }

  /* plate stack sync (rebuild on rev change) */
  S.syncPlate = function (st) {
    if (st.plate.rev === plateRev) return;
    plateRev = st.plate.rev;
    var holder = plateRec.stackHolder;
    while (plateStack.length) holder.remove(plateStack.pop());
    var y = 0;
    for (var i = 0; i < st.plate.items.length; i++) {
      var id = st.plate.items[i];
      var food = S.makeFood(id);
      food.position.y = y + STACK_H[id] / 2;
      y += STACK_H[id];
      holder.add(food);
      plateStack.push(food);
      if (i === st.plate.items.length - 1) S.fxPunchIn(food);
    }
    /* mess items: dark splats */
    if (st.plate.mess > 0) {
      var splat = sph(0.16 * st.plate.mess, 0x6B5340, true);
      splat.scale.y = 0.4;
      splat.position.set(0.25, y + 0.05, 0.15);
      holder.add(splat);
      plateStack.push(splat);
    }
  };

  /* plate slide animations for serve */
  S.fxServe = function (onDone) {
    var g = plateRec.group;
    var y0 = g.position.y, z0 = g.position.z;
    S.tween(0.5, function (k) {
      g.position.z = z0 + k * -1.6;
      g.position.y = y0 + Math.sin(k * Math.PI) * 0.18;
    }, EASE.inOut, function () {
      /* fade the stack out */
      S.tween(0.25, function (k2) {
        g.scale.setScalar(1 - k2 * 0.9);
      }, EASE.in, function () {
        g.position.z = z0; g.position.y = y0; g.scale.setScalar(1);
        if (onDone) onDone();
      });
    });
  };

  /* ================================================================
   * DRAG GHOST
   * ================================================================ */
  var G_state = null;
  S.setGState = function (st) { G_state = st; };
  var dragLag = new THREE.Vector3();
  var dragPrev = new THREE.Vector3();
  S.startDrag = function (ingId) {
    if (dragMesh) { scene.remove(dragMesh); }
    dragId = ingId;
    dragMesh = (ingId === '__plate__') ? buildPlateSnapshot(G_state.plate) : S.makeFood(ingId);
    if (ingId === '__plate__') dragMesh.scale.setScalar(0.9);
    dragMesh.visible = true;
    scene.add(dragMesh);
    dragLag.set(0, 1.4, 0.5);
    dragPrev.set(0, 1.4, 0.5);
  };
  S.moveDrag = function (target, speedMult) {
    if (!dragMesh) return;
    var k = Math.min(1, (0.32 * (speedMult || 1)) * 60 * 0.016);
    dragPrev.copy(dragLag);
    dragLag.lerp(target, 0.35 * (speedMult || 1));
    dragMesh.position.copy(dragLag);
    /* tilt by velocity */
    var vx = dragLag.x - dragPrev.x, vz = dragLag.z - dragPrev.z;
    dragMesh.rotation.z = Math.max(-0.5, Math.min(0.5, -vx * 6));
    dragMesh.rotation.x = Math.max(-0.5, Math.min(0.5, vz * 6));
  };
  S.endDrag = function () {
    if (dragMesh) scene.remove(dragMesh);
    dragMesh = null; dragId = null;
  };
  S.dragTarget = function () { return dragMesh ? dragLag : null; };

  /* ================================================================
   * CAT / RADIO / SIGN idle anims
   * ================================================================ */
  function updateAmbience(dt) {
    if (catRec) {
      var b = catRec.body;
      b.scale.set(1.35, 0.72 + Math.sin(time * 2.2) * 0.03, 1);
      catRec.zzz.material.opacity = 0.25 + Math.sin(time * 2.2) * 0.2;
      catRec.zzz.position.y = 0.55 + Math.sin(time * 2.2) * 0.05;
      if (catRec.swipe > 0) {
        catRec.swipe -= dt;
        catRec.group.rotation.z = Math.sin(catRec.swipe * 20) * 0.1;
      } else catRec.group.rotation.z = 0;
    }
    if (radioRec && radioRec.on) {
      radioRec.group.rotation.z = Math.sin(time * 6) * 0.02;
      radioRec.note.material.opacity = 0.4 + Math.sin(time * 3) * 0.3;
      radioRec.note.position.y = 0.5 + Math.sin(time * 3) * 0.08;
    } else if (radioRec) {
      radioRec.group.rotation.z = 0;
      radioRec.note.material.opacity = 0;
    }
    if (signRec) {
      signRec.group.rotation.z = Math.sin(time * 0.8) * 0.015;
    }
  }
  S.catSwipe = function () {
    if (!catRec) return;
    catRec.swipe = 0.5;
    catRec.zzz.material.opacity = 0.8;
    _v1.copy(catRec.group.position);
    _v1.y += 0.5;
    S.fxSparkle(_v1);
  };
  S.setRadioOn = function (on) { if (radioRec) radioRec.on = !!on; };
  S.trashAnim = function () {
    if (!trashRec) return;
    var lid = trashRec.lid;
    S.tween(0.35, function (k) {
      lid.position.y = 0.6 + Math.sin(k * Math.PI) * 0.25;
      lid.rotation.z = Math.sin(k * Math.PI) * 0.5;
    }, EASE.out);
  };
  S.jarCoins = function (coins) {
    if (!jarRec) return;
    var h = Math.min(0.34, 0.08 + coins * 0.001);
    jarRec.coinPile.scale.y = h / 0.12;
  };

  /* ================================================================
   * ANCHORS (for DOM projection)
   * ================================================================ */
  S.anchorPos = function (id, out) {
    if (id.slice(0, 4) === 'bin:') {
      var b = bins[id.slice(4)];
      if (b) { out.set(b.x, 1.95, 0.38); return out; }
    }
    switch (id) {
      case 'board': out.set(-1.85, 1.85, -1.25); break;
      case 'pan0': out.set(pans.length ? pans[0].x : 1.35, 1.9, -1.25); break;
      case 'pan1': out.set(pans.length > 1 ? pans[1].x : 2.35, 1.9, -1.25); break;
      case 'oven': out.set(1.95, 2.6, -1.35); break;
      case 'plate': out.set(0, 1.6, -1.35); break;
      case 'customer':
        if (customers[0]) customers[0].head.getWorldPosition(out);
        else out.set(0, 2.2, -4.35);
        out.y += 0.55;
        break;
      case 'customerPlate': out.set(0, 1.7, -3.4); break;
      default: out.set(0, 1.5, 0);
    }
    return out;
  };
  S.project = function (worldV, out) {
    _v3.copy(worldV);
    _v3.project(camera);
    out.x = (_v3.x * 0.5 + 0.5);
    out.y = (-_v3.y * 0.5 + 0.5);
    return out;
  };

  /* ================================================================
   * FRAME UPDATE
   * ================================================================ */
  S.update = function (dt, st) {
    time += dt;
    updateTweens(dt);
    updateParticles(dt);
    updateAmbience(dt);
    S.binBob(dt);
    /* camera micro drift */
    camT += dt;
    camera.position.x = Math.sin(camT * 0.4) * 0.05;
    camera.lookAt(0, 1.15, -1.5);

    if (st) {
      G_state = st;
      S.syncBoard(st);
      S.syncPans(st);
      S.syncOven(st);
      S.syncPlate(st);

      /* steam sources */
      heatLevel = 0;
      var steamAcc = 0;
      for (var i = 0; i < st.pans.length; i++) {
        var pan = st.pans[i];
        if (pan.phase === 'cooking' || pan.phase === 'ready') {
          heatLevel += pan.phase === 'cooking' ? 1 : 0.5;
          steamAcc += dt * (pan.phase === 'cooking' ? 1.6 : 0.8);
          if (steamAcc > 0.35) {
            steamAcc = 0;
            _v1.set(pans[i].x, 1.45, -1.25);
            S.fxSteam(_v1, false);
          }
        }
      }
      if (st.oven && st.oven.phase === 'baking') {
        heatLevel += 1;
        _v1.set(1.95, 2.4, -1.0);
        if (Math.random() < dt * 2.2) S.fxSteam(_v1, true);
      }
      if (st.plate.hot) {
        heatLevel += 0.5;
        _v1.set(0, 1.35 + Math.random() * 0.3, -1.35);
        if (Math.random() < dt * 1.5) S.fxSteam(_v1, true);
      }
      if (st.frost && !st.frost.done && plateRec && plateRec.frostSwirl) {
        plateRec.frostSwirl.material.opacity = 0.3 + Math.sin(time * 8) * 0.15;
        plateRec.frostSwirl.scale.setScalar(0.9 + st.frost.t * 0.5);
      } else if (plateRec && plateRec.frostSwirl) {
        plateRec.frostSwirl.material.opacity *= 0.9;
      }

      /* customers */
      var active = st.active, next = st.customers[st.idx + 1] || null;
      S.setCustomerSlots(active, next);
      updateCustomers(dt, S.dragTarget());
    }

    renderer.render(scene, camera);
  };

  S.heat = function () { return heatLevel; };

  /* exports */
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
  window.UCScene = S;
})();
