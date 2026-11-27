/* CRYPTFALL — js/touch.js
 * Mobile controls: mounts the shared SVG analog joystick + glass buttons
 * (see ../shared/mobile-controls.js) on touch devices or narrow screens.
 * Wires everything into CF.Input:
 *   joystick → axes.mx/my (analog tilt 0..1)
 *   ⚔ ATTACK → attackHeld + auto-aim at nearest enemy
 *   💨 DASH  → synthetic Space
 *   E        → synthetic KeyE (interact: chests / stairs)
 *   🧪 POTION→ synthetic KeyQ
 *   ⏸ PAUSE  → synthetic Escape
 */
var CF = (typeof globalThis.CF !== 'undefined') ? globalThis.CF : (globalThis.CF = {});

CF.TouchUI = {
  mounted: false,

  mount: function () {
    if (this.mounted) return true;
    if (typeof document === 'undefined') return false;
    if (typeof MC === 'undefined' || !MC.createJoystick || !MC.createButton) return false;
    this.mounted = true;
    var I = CF.Input;
    I.mobile = true;
    if (!I.axes) I.axes = { mx: 0, my: 0 };

    var css = document.createElement('style');
    css.textContent =
      '#mc-joy{position:fixed;left:4vw;bottom:6vh;z-index:60;pointer-events:none;}' +
      '#mc-joy svg{pointer-events:auto;filter:drop-shadow(0 4px 14px rgba(0,0,0,0.5));}' +
      '#mc-btns{position:fixed;right:3vw;bottom:5vh;z-index:60;width:210px;height:220px;pointer-events:none;}' +
      '#mc-btns svg{position:absolute;pointer-events:auto;filter:drop-shadow(0 4px 14px rgba(0,0,0,0.5));}';
    document.head.appendChild(css);

    var joy = document.createElement('div');
    joy.id = 'mc-joy';
    var btns = document.createElement('div');
    btns.id = 'mc-btns';
    document.body.appendChild(joy);
    document.body.appendChild(btns);

    var vw = Math.min(window.innerWidth, window.innerHeight);
    var js = Math.round(CF.clamp(vw * 0.34, 110, 160));
    MC.createJoystick({
      container: joy, size: js,
      onMove: function (v) { I.axes.mx = v.x; I.axes.my = v.y; }
    });

    var B = js / 132;   /* cluster scales with the joystick */
    function place(btn, right, bottom) {
      btn.svg.style.right = right + 'px';
      btn.svg.style.bottom = bottom + 'px';
    }
    place(MC.createButton({
      container: btns, label: '⚔️', size: Math.round(78 * B), color: '#ff8a6a', id: 'cf-atk',
      onDown: function () { I.attackHeld = true; },
      onUp: function () { I.attackHeld = false; }
    }), 6, 4);
    place(MC.createButton({
      container: btns, label: '💨', size: Math.round(58 * B), color: '#8fd0ff', id: 'cf-dash',
      onDown: function () { I.pressed['Space'] = true; }
    }), 94, 0);
    place(MC.createButton({
      container: btns, label: 'E', size: Math.round(48 * B), color: '#ffd94a', id: 'cf-use',
      onDown: function () { I.pressed['KeyE'] = true; }
    }), 98, 74);
    place(MC.createButton({
      container: btns, label: '🧪', size: Math.round(48 * B), color: '#7dff8a', id: 'cf-potion',
      onDown: function () { I.pressed['KeyQ'] = true; }
    }), 30, 100);
    place(MC.createButton({
      container: btns, label: '⏸', size: Math.round(40 * B), color: '#d0a8ff', id: 'cf-pause',
      onDown: function () { I.pressed['Escape'] = true; }
    }), 8, 158);
    return true;
  }
};

/* auto-mount: touch device at load, first touch anywhere, or narrow viewport */
if (typeof window !== 'undefined') {
  function tryMount() { CF.TouchUI.mount(); }
  window.addEventListener('load', function () {
    if (typeof navigator !== 'undefined' && MC.isTouchDevice && MC.isTouchDevice(navigator)) tryMount();
  });
  window.addEventListener('touchstart', function onFirstTouch() {
    tryMount();
    window.removeEventListener('touchstart', onFirstTouch);
  }, { passive: true });
  window.addEventListener('resize', function () {
    if (window.innerWidth < 820) tryMount();
  });
}
