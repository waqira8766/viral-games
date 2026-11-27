/* ============================================================
   PULL THE PIN — js/levels.js
   12 handcrafted levels. Global: PIN_LEVELS (+ PIN_VALIDATE).
   Geometry: 400 x 640 canvas, floor at y=640, hero rests at
   (heroX, 612) with r=22. Pins are horizontal bars {x,y,len}.
   Spheres rest exactly on their bar (y = bar.y - r).
   ============================================================ */
(function () {
  'use strict';

  globalThis.PIN_LEVELS = [
    // 1 — tutorial: one pin, one gold
    { name: 'First Drop', hint: 'Tap the pin to pull it. Gold falls to your knight.',
      heroX: 200,
      pins: [{ x: 140, y: 470, len: 120 }],
      spheres: [{ type: 'gold', x: 200, y: 455, r: 15 }] },

    // 2 — restraint: the top pin is a lava trap right above your gold
    { name: 'Hot Head', hint: 'Some pins are lies. That lava sits right above your gold — leave it be.',
      heroX: 175,
      pins: [{ x: 120, y: 470, len: 160 }, { x: 150, y: 360, len: 100 }],
      spheres: [
        { type: 'gold', x: 150, y: 458, r: 12 }, { type: 'gold', x: 200, y: 455, r: 15 },
        { type: 'lava', x: 200, y: 343, r: 17 }] },

    // 3 — first water: soak the lava before opening its chamber
    { name: 'Water Works', hint: 'Blue drinks red. Pull the water pin first.',
      heroX: 200,
      pins: [{ x: 150, y: 250, len: 100 }, { x: 120, y: 360, len: 160 }, { x: 140, y: 470, len: 120 }],
      spheres: [
        { type: 'water', x: 200, y: 235, r: 15 }, { type: 'lava', x: 200, y: 343, r: 17 },
        { type: 'gold', x: 200, y: 455, r: 15 }] },

    // 4 — bait gold sits beside lava on the same bar
    { name: 'Bait & Switch', hint: 'That extra gold is a bribe. Soak the fire before you take it.',
      heroX: 200,
      pins: [{ x: 150, y: 250, len: 100 }, { x: 130, y: 360, len: 140 }, { x: 130, y: 470, len: 80 }],
      spheres: [
        { type: 'water', x: 200, y: 235, r: 15 }, { type: 'lava', x: 200, y: 343, r: 17 },
        { type: 'gold', x: 233, y: 347, r: 13 }, { type: 'gold', x: 185, y: 457, r: 13 }] },

    // 5 — funnel walls; the middle pin hides a friend and a foe
    { name: 'Rain Check', hint: 'The middle pin hides gold AND lava. Water it first, then open it.',
      heroX: 200,
      pins: [{ x: 100, y: 280, len: 60 }, { x: 95, y: 380, len: 90 }, { x: 120, y: 400, len: 160 }],
      spheres: [
        { type: 'water', x: 150, y: 265, r: 15 }, { type: 'lava', x: 150, y: 363, r: 17 },
        { type: 'gold', x: 180, y: 367, r: 13 }, { type: 'gold', x: 205, y: 385, r: 15 },
        { type: 'gold', x: 245, y: 388, r: 12 }],
      walls: [{ x1: 120, y1: 480, x2: 172, y2: 575 }, { x1: 280, y1: 480, x2: 228, y2: 575 }] },

    // 6 — one pull drops two rains with very different journeys
    { name: 'Two Birds', hint: 'One pull, two rains. The right-hand rain has a long way to travel.',
      heroX: 225,
      pins: [{ x: 80, y: 240, len: 140 }, { x: 60, y: 350, len: 100 }, { x: 235, y: 350, len: 95 }, { x: 150, y: 460, len: 85 }],
      spheres: [
        { type: 'water', x: 110, y: 225, r: 15 }, { type: 'water', x: 190, y: 225, r: 15 },
        { type: 'lava', x: 110, y: 333, r: 17 }, { type: 'gold', x: 255, y: 335, r: 15 },
        { type: 'lava', x: 192, y: 443, r: 17 }, { type: 'gold', x: 224, y: 447, r: 13 }] },

    // 7 — two rains, one fire, stacked pins
    { name: 'Waterfall', hint: 'Two rains for one fire. Pull both blue pins before the red bar opens.',
      heroX: 200,
      pins: [{ x: 150, y: 230, len: 100 }, { x: 150, y: 320, len: 100 }, { x: 140, y: 410, len: 120 }, { x: 140, y: 500, len: 120 }],
      spheres: [
        { type: 'water', x: 200, y: 215, r: 15 }, { type: 'water', x: 200, y: 305, r: 15 },
        { type: 'lava', x: 200, y: 393, r: 17 }, { type: 'gold', x: 170, y: 398, r: 12 },
        { type: 'gold', x: 200, y: 485, r: 15 }] },

    // 8 — the far-left pin is pure poison; the top lava is safe only while the water pin is in
    { name: 'Killer Instinct', hint: 'Free lava is never free. And the far-left pin? Pure poison.',
      heroX: 200,
      pins: [{ x: 150, y: 150, len: 100 }, { x: 150, y: 240, len: 100 }, { x: 120, y: 200, len: 60 }, { x: 130, y: 360, len: 140 }],
      spheres: [
        { type: 'lava', x: 200, y: 133, r: 17 }, { type: 'water', x: 200, y: 225, r: 15 },
        { type: 'lava', x: 165, y: 183, r: 17 }, { type: 'gold', x: 160, y: 345, r: 15 },
        { type: 'gold', x: 240, y: 345, r: 15 }],
      walls: [{ x1: 120, y1: 480, x2: 172, y2: 575 }, { x1: 280, y1: 480, x2: 228, y2: 575 }] },

    // 9 — lateral thinking: water must land BESIDE the fire, not on it
    { name: 'Lateral', hint: 'Water falls straight. Line it up beside the fire, not above it.',
      heroX: 200,
      pins: [{ x: 40, y: 300, len: 80 }, { x: 150, y: 300, len: 100 }, { x: 40, y: 420, len: 80 }, { x: 150, y: 420, len: 100 }, { x: 150, y: 520, len: 100 }],
      spheres: [
        { type: 'water', x: 80, y: 285, r: 15 }, { type: 'water', x: 230, y: 285, r: 15 },
        { type: 'lava', x: 110, y: 403, r: 17 }, { type: 'lava', x: 200, y: 403, r: 17 },
        { type: 'gold', x: 170, y: 407, r: 13 }, { type: 'gold', x: 200, y: 505, r: 15 }] },

    // 10 — twin kill columns flanking the gold; twin rains
    { name: 'Pincer', hint: 'Rains above fires above gold. Soak both before you drop anything.',
      heroX: 200,
      pins: [{ x: 150, y: 290, len: 60 }, { x: 200, y: 330, len: 60 }, { x: 100, y: 400, len: 85 }, { x: 215, y: 400, len: 70 }, { x: 120, y: 500, len: 160 }],
      spheres: [
        { type: 'water', x: 180, y: 275, r: 15 }, { type: 'water', x: 220, y: 315, r: 15 },
        { type: 'lava', x: 180, y: 383, r: 17 }, { type: 'lava', x: 220, y: 383, r: 17 },
        { type: 'gold', x: 180, y: 485, r: 15 }, { type: 'gold', x: 220, y: 485, r: 15 }] },

    // 11 — the second rain rides the first pin down to the fire below
    { name: 'Pressure', hint: 'Soak the top fire, then let the second rain ride the pin down.',
      heroX: 200,
      pins: [{ x: 110, y: 140, len: 70 }, { x: 150, y: 160, len: 100 }, { x: 150, y: 260, len: 100 }, { x: 150, y: 340, len: 100 }, { x: 150, y: 500, len: 100 }],
      spheres: [
        { type: 'water', x: 169, y: 125, r: 15 }, { type: 'water', x: 200, y: 145, r: 15 },
        { type: 'lava', x: 200, y: 243, r: 17 }, { type: 'lava', x: 200, y: 323, r: 17 },
        { type: 'gold', x: 180, y: 485, r: 15 }, { type: 'gold', x: 220, y: 485, r: 15 }],
      walls: [{ x1: 120, y1: 480, x2: 172, y2: 575 }, { x1: 280, y1: 480, x2: 228, y2: 575 }] },

    // 12 — the melter: top-to-bottom chain, funnel, baits, riding water
    { name: 'Meltdown', hint: 'Work top to bottom: soak, drop, soak, drop... and trust the funnel.',
      heroX: 200,
      pins: [{ x: 150, y: 40, len: 100 }, { x: 120, y: 80, len: 60 }, { x: 150, y: 140, len: 100 }, { x: 110, y: 230, len: 140 }, { x: 150, y: 380, len: 100 }],
      spheres: [
        { type: 'water', x: 200, y: 25, r: 15 }, { type: 'water', x: 170, y: 65, r: 15 },
        { type: 'lava', x: 200, y: 123, r: 17 }, { type: 'gold', x: 232, y: 128, r: 12 },
        { type: 'water', x: 140, y: 215, r: 15 }, { type: 'lava', x: 180, y: 213, r: 17 },
        { type: 'lava', x: 170, y: 363, r: 17 }, { type: 'gold', x: 210, y: 365, r: 15 },
        { type: 'gold', x: 245, y: 368, r: 12 }],
      walls: [{ x1: 120, y1: 480, x2: 172, y2: 575 }, { x1: 280, y1: 480, x2: 228, y2: 575 }] },
  ];

  // ---------- shared validator (used by self-tests here AND in game.js) ----------
  function validateLevels(levels) {
    const W = 400, H = 640, HERO_R = 22, errs = [];
    const dseg = (px, py, x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1e-9;
      let t = ((px - x1) * dx + (py - y1) * dy) / l2; t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
    };
    levels.forEach((lv, li) => {
      const tag = 'level ' + (li + 1) + ' "' + (lv.name || '') + '"';
      if (!lv.name || !lv.hint) errs.push(tag + ': missing name/hint');
      if (!Array.isArray(lv.pins) || lv.pins.length < 1) errs.push(tag + ': needs >= 1 pin');
      if (!Array.isArray(lv.spheres) || lv.spheres.length < 1) errs.push(tag + ': needs >= 1 sphere');
      if (!(lv.spheres || []).some(s => s.type === 'gold')) errs.push(tag + ': needs >= 1 gold sphere');
      if (!(lv.heroX >= HERO_R + 8 && lv.heroX <= W - HERO_R - 8)) errs.push(tag + ': heroX outside canvas');
      (lv.pins || []).forEach((p, i) => {
        const len = p.len || 240;
        if (!(p.y > 10 && p.y < H - 10)) errs.push(tag + ' pin ' + (i + 1) + ': y out of bounds');
        if (!(p.x >= 0 && p.x + len <= W)) errs.push(tag + ' pin ' + (i + 1) + ': x out of bounds');
        if (!(len >= 20 && len <= W)) errs.push(tag + ' pin ' + (i + 1) + ': bad len');
      });
      (lv.walls || []).forEach((w, i) => {
        [[w.x1, w.y1], [w.x2, w.y2]].forEach((pt, k) => {
          if (!(pt[0] >= -1 && pt[0] <= W + 1 && pt[1] >= -1 && pt[1] <= H + 1))
            errs.push(tag + ' wall ' + (i + 1) + ' endpoint ' + (k + 1) + ' out of bounds');
        });
      });
      const S = lv.spheres || [];
      S.forEach((s, i) => {
        if (['gold', 'lava', 'water'].indexOf(s.type) < 0) errs.push(tag + ' sphere ' + (i + 1) + ': bad type');
        if (!(s.r >= 8 && s.r <= 24)) errs.push(tag + ' sphere ' + (i + 1) + ': bad radius');
        if (!(s.x - s.r >= 1 && s.x + s.r <= W - 1 && s.y - s.r >= 1 && s.y + s.r <= H - 1))
          errs.push(tag + ' sphere ' + (i + 1) + ': out of canvas bounds');
      });
      for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
        const a = S[i], b = S[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 0.01)
          errs.push(tag + ': spheres ' + (i + 1) + ' & ' + (j + 1) + ' start overlapping');
      }
      S.forEach((s, i) => {
        (lv.pins || []).forEach((p, pi) => {
          const len = p.len || 240;
          if (dseg(s.x, s.y, p.x, p.y, p.x + len, p.y) < s.r - 0.01)
            errs.push(tag + ': sphere ' + (i + 1) + ' overlaps pin ' + (pi + 1));
        });
        (lv.walls || []).forEach((w, wi) => {
          if (dseg(s.x, s.y, w.x1, w.y1, w.x2, w.y2) < s.r - 0.01)
            errs.push(tag + ': sphere ' + (i + 1) + ' overlaps wall ' + (wi + 1));
        });
        if (Math.hypot(s.x - lv.heroX, s.y - (H - 28)) < s.r + HERO_R - 0.01)
          errs.push(tag + ': sphere ' + (i + 1) + ' overlaps hero');
      });
      S.forEach((s, i) => { // every sphere must rest on a pin, the floor, or another sphere
        let ok = s.y + s.r >= H - 1;
        (lv.pins || []).forEach(p => {
          const len = p.len || 240;
          if (dseg(s.x, s.y, p.x, p.y, p.x + len, p.y) <= s.r + 2 && p.y >= s.y) ok = true;
        });
        S.forEach(o => {
          if (o !== s && o.y > s.y && Math.abs(o.x - s.x) < s.r &&
            (o.y - s.y) < s.r + o.r + 2) ok = true;
        });
        if (!ok) errs.push(tag + ': sphere ' + (i + 1) + ' floats with no support');
      });
    });
    return errs;
  }
  globalThis.PIN_VALIDATE = validateLevels;

  // ---------- self-test (only when run directly: node levels.js) ----------
  if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('levels.js')) {
    const errs = validateLevels(globalThis.PIN_LEVELS);
    globalThis.PIN_LEVELS.forEach((lv, i) => {
      const gold = lv.spheres.filter(s => s.type === 'gold').length;
      const bad = errs.some(e => e.startsWith('level ' + (i + 1) + ' '));
      console.log((bad ? 'FAIL' : 'PASS') + ': level ' + (i + 1) + ' "' + lv.name + '" — ' + lv.pins.length + ' pin(s), ' + gold + ' gold, heroX=' + lv.heroX);
    });
    if (errs.length) {
      errs.forEach(e => console.error('FAIL: ' + e));
      console.error(errs.length + ' CHECKS FAILED');
      process.exit(1);
    }
    console.log('ALL TESTS PASSED');
  }
})();
