/**
 * Action-mapped input with edge detection and a rolling press-buffer.
 *
 * A combo action game lives or dies on input feel, so this layer does three things
 * that raw key polling does not:
 *   1. samples on the FIXED step, not the render frame, so buffering is deterministic;
 *   2. records the sim-step index of each press, enabling `buffer(action, n)` — the
 *      "I pressed it slightly too early" forgiveness window every action game needs;
 *   3. normalises keyboard + gamepad into one axis/action model.
 */

const KEY_MAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyJ: 'w1', KeyK: 'w2', KeyL: 'w3', Semicolon: 'w4',
  Digit1: 'w1', Digit2: 'w2', Digit3: 'w3', Digit4: 'w4',
  KeyQ: 'lock',
  KeyE: 'guard',
  KeyF: 'shift',
  Escape: 'pause', KeyP: 'pause',
};

export const ACTIONS = [
  'up', 'down', 'left', 'right',
  'jump', 'dash', 'lock', 'guard', 'shift', 'pause',
  'w1', 'w2', 'w3', 'w4',
];

// Gamepad button index -> action (standard mapping)
const PAD_BUTTON_MAP = {
  0: 'jump',    // A
  1: 'w2',      // B
  2: 'w1',      // X
  3: 'w3',      // Y
  4: 'guard',   // LB
  5: 'w4',      // RB
  6: 'lock',    // LT
  7: 'dash',    // RT
  9: 'pause',   // start
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

export class Input {
  constructor(target = window) {
    this.axis = { x: 0, y: 0 };
    this.step = 0;

    /** raw physical state, written by DOM events, read at fixed-step sample time */
    this._raw = Object.create(null);
    /** state as of the current fixed step */
    this._cur = Object.create(null);
    /** state as of the previous fixed step */
    this._prev = Object.create(null);
    /** sim-step index of the most recent rising edge per action */
    this._pressStep = Object.create(null);

    for (const a of ACTIONS) {
      this._raw[a] = false;
      this._cur[a] = false;
      this._prev[a] = false;
      this._pressStep[a] = -99999;
    }

    this._padIndex = null;
    this.enabled = true;
    this._bind(target);
  }

  _bind(target) {
    this._onKeyDown = (e) => {
      const a = KEY_MAP[e.code];
      if (a) {
        this._raw[a] = true;
        // Stop the browser scrolling / activating buttons underneath the canvas.
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      const a = KEY_MAP[e.code];
      if (a) this._raw[a] = false;
    };
    this._onBlur = () => {
      // Never leave a key stuck down when the window loses focus.
      for (const a of ACTIONS) this._raw[a] = false;
    };
    this._onPadConnect = (e) => { this._padIndex = e.gamepad.index; };
    this._onPadDisconnect = () => { this._padIndex = null; };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    target.addEventListener('gamepadconnected', this._onPadConnect);
    target.addEventListener('gamepaddisconnected', this._onPadDisconnect);
    this._target = target;
  }

  /** Called by the engine once per FIXED step, before any module's `fixed`. */
  sample(step) {
    this.step = step;

    const prev = this._prev;
    const cur = this._cur;
    // swap so we keep two buffers rather than allocating
    this._prev = cur;
    this._cur = prev;
    const next = this._cur;

    let padAxisX = 0;
    let padAxisY = 0;
    const padDown = this._pollGamepad();

    for (const a of ACTIONS) {
      const v = this.enabled && (this._raw[a] || (padDown !== null && padDown[a] === true));
      next[a] = v;
      if (v && !this._prev[a]) this._pressStep[a] = step;
    }

    if (padDown !== null) {
      padAxisX = padDown._ax;
      padAxisY = padDown._ay;
    }

    // Keyboard axis, with gamepad stick taking over when meaningfully deflected.
    let ax = (next.right ? 1 : 0) - (next.left ? 1 : 0);
    let ay = (next.up ? 1 : 0) - (next.down ? 1 : 0);
    if (Math.abs(padAxisX) > 0.2) ax = padAxisX;
    if (Math.abs(padAxisY) > 0.2) ay = padAxisY;

    // Normalise so diagonals are not faster than cardinals.
    const m = Math.hypot(ax, ay);
    if (m > 1) { ax /= m; ay /= m; }
    this.axis.x = ax;
    this.axis.y = ay;
  }

  _pollGamepad() {
    if (this._padIndex === null || typeof navigator === 'undefined' || !navigator.getGamepads) {
      return null;
    }
    const pad = navigator.getGamepads()[this._padIndex];
    if (!pad) return null;

    const out = this._padScratch || (this._padScratch = Object.create(null));
    for (const a of ACTIONS) out[a] = false;

    for (let i = 0; i < pad.buttons.length; i++) {
      const act = PAD_BUTTON_MAP[i];
      if (act && pad.buttons[i].pressed) out[act] = true;
    }
    const dz = 0.18;
    const rawX = pad.axes[0] || 0;
    const rawY = -(pad.axes[1] || 0);
    out._ax = Math.abs(rawX) < dz ? 0 : rawX;
    out._ay = Math.abs(rawY) < dz ? 0 : rawY;
    return out;
  }

  down(action) {
    return this._cur[action] === true;
  }

  pressed(action) {
    return this._cur[action] === true && this._prev[action] !== true;
  }

  released(action) {
    return this._cur[action] !== true && this._prev[action] === true;
  }

  /** True if `action` had a rising edge within the last `steps` fixed steps. */
  buffer(action, steps = 8) {
    return this.step - this._pressStep[action] <= steps;
  }

  /** Consume a buffered press so it cannot trigger twice. */
  consume(action) {
    this._pressStep[action] = -99999;
  }

  dispose() {
    const t = this._target;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    t.removeEventListener('gamepadconnected', this._onPadConnect);
    t.removeEventListener('gamepaddisconnected', this._onPadDisconnect);
  }
}
