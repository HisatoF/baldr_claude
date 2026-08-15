/**
 * Synchronous event bus.
 *
 * Deliberately allocation-free on emit: handler arrays are iterated by index over a
 * snapshot length, so a handler that unsubscribes itself mid-emit cannot corrupt the
 * walk. Handlers added during an emit are not called until the next emit.
 */
export class Bus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._map = new Map();
    this._depth = 0;
    this._pendingRemovals = [];
  }

  on(type, fn) {
    let list = this._map.get(type);
    if (!list) this._map.set(type, (list = []));
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const wrap = (payload) => {
      this.off(type, wrap);
      fn(payload);
    };
    return this.on(type, wrap);
  }

  off(type, fn) {
    const list = this._map.get(type);
    if (!list) return;
    if (this._depth > 0) {
      // Defer structural mutation until the outermost emit unwinds.
      this._pendingRemovals.push([type, fn]);
      const i = list.indexOf(fn);
      if (i >= 0) list[i] = NOOP;
      return;
    }
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this._map.get(type);
    if (!list) return;
    const n = list.length;
    this._depth++;
    for (let i = 0; i < n; i++) {
      const fn = list[i];
      if (fn === NOOP) continue;
      try {
        fn(payload);
      } catch (err) {
        // A throwing listener must never break the frame for everyone else.
        console.error(`[bus] listener for "${type}" threw:`, err);
      }
    }
    this._depth--;
    if (this._depth === 0 && this._pendingRemovals.length) this._flushRemovals();
  }

  _flushRemovals() {
    for (const [type, fn] of this._pendingRemovals) {
      const list = this._map.get(type);
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === NOOP || list[i] === fn) list.splice(i, 1);
      }
    }
    this._pendingRemovals.length = 0;
  }

  clear() {
    this._map.clear();
    this._pendingRemovals.length = 0;
  }
}

const NOOP = () => {};
