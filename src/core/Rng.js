/**
 * Seeded RNG (SplitMix32). Gameplay logic MUST use this rather than Math.random()
 * so that a run is reproducible from its seed — which is what makes the automated
 * visual-regression harness able to capture the same frame twice.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this._s = seed >>> 0;
  }

  /** @returns {number} uint32 */
  nextUint() {
    this._s = (this._s + 0x9e3779b9) >>> 0;
    let z = this._s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /** @returns {number} [0,1) */
  float() {
    return this.nextUint() / 4294967296;
  }

  /** @returns {number} [min,max) */
  range(min, max) {
    return min + (max - min) * this.float();
  }

  /** @returns {number} integer [min,max] inclusive */
  int(min, max) {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** @returns {number} [-1,1) */
  signed() {
    return this.float() * 2 - 1;
  }

  bool(chance = 0.5) {
    return this.float() < chance;
  }

  pick(arr) {
    return arr[Math.floor(this.float() * arr.length)];
  }

  /** Fork an independent stream, so one system's draws cannot desync another's. */
  fork() {
    return new Rng(this.nextUint());
  }

  clone() {
    const r = new Rng(0);
    r._s = this._s;
    return r;
  }
}
