/**
 * Synth.js — the DSP toolkit everything else in `src/audio` is built from.
 *
 * There are zero audio assets in this project. Every sound the game makes is
 * generated from oscillators, noise and filters. This module supplies:
 *
 *   - a seeded PRNG so generated buffers are byte-identical run to run,
 *   - noise generators (white / pink / brown) rendered into reusable AudioBuffers,
 *   - a procedural impulse-response generator for convolution reverb,
 *   - waveshaper curves for saturation/distortion,
 *   - `Patch`, a tiny builder that makes a synthesis recipe read like a recipe,
 *   - `renderOffline`, which bakes a recipe into an AudioBuffer once at init,
 *   - `VoicePool`, a fixed pool of pre-built playback chains with voice stealing.
 *
 * The architectural point of the bake step: a gatling firing 20 rounds a second
 * must not construct 20 oscillator/filter/waveshaper graphs a second. Recipes are
 * rendered *once* through an OfflineAudioContext at startup; at play time all that
 * happens is an AudioBufferSourceNode dropped into an already-wired voice slot.
 */

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * SplitMix32 — the same algorithm as `core/Rng.js`, duplicated locally on purpose.
 * Buffer generation must be reproducible *without* drawing from the gameplay RNG
 * stream, because consuming that stream would desync the simulation.
 */
export class SynthRng {
  constructor(seed = 0x9e3779b9) {
    this._s = seed >>> 0;
  }
  u32() {
    this._s = (this._s + 0x9e3779b9) >>> 0;
    let z = this._s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }
  /** [0,1) */
  f() {
    return this.u32() / 4294967296;
  }
  /** [-1,1) */
  s() {
    return this.f() * 2 - 1;
  }
  range(a, b) {
    return a + (b - a) * this.f();
  }
  int(a, b) {
    return a + Math.floor(this.f() * (b - a + 1));
  }
}

/** FNV-1a over a string — turns a sound id into a stable seed. */
export function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/**
 * Fill a Float32Array with noise of a given spectral tilt.
 *  - white: flat. Bright, for transients and air.
 *  - pink:  -3dB/oct (Paul Kellet's economy filter). The natural-sounding one;
 *           the backbone of explosions and thruster wash.
 *  - brown: -6dB/oct (leaky integrator). Rumble and body.
 */
export function fillNoise(data, kind, rng) {
  const n = data.length;
  if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.s();
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.15;
      b6 = w * 0.115926;
    }
    return data;
  }
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.022 * rng.s()) / 1.022;
      data[i] = last * 3.4;
    }
    return data;
  }
  // white
  for (let i = 0; i < n; i++) data[i] = rng.s() * 0.72;
  return data;
}

/** Per-context cache so a recipe asking for noise ten times allocates one buffer. */
const _noiseCache = new WeakMap();

export function noiseBuffer(ac, kind = 'white', seconds = 2, seed = 0x51ced00d) {
  let m = _noiseCache.get(ac);
  if (!m) _noiseCache.set(ac, (m = new Map()));
  const key = `${kind}|${seconds}|${seed}`;
  const hit = m.get(key);
  if (hit) return hit;
  const n = Math.max(1, Math.ceil(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  fillNoise(buf.getChannelData(0), kind, new SynthRng(seed));
  m.set(key, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Convolution reverb impulse response
// ---------------------------------------------------------------------------

/**
 * Build a stereo impulse response procedurally: exponentially decaying noise with
 * progressive high-frequency damping (air absorption), a handful of discrete early
 * reflections for a sense of room size, and decorrelated channels for width.
 *
 * @param {BaseAudioContext} ac
 * @param {{seconds?:number, decay?:number, damp?:number, preDelay?:number,
 *          seed?:number, early?:number, spread?:number}} o
 */
export function makeImpulseResponse(ac, o = {}) {
  const seconds = o.seconds ?? 2.1;
  const decay = o.decay ?? 3.2;
  const damp = o.damp ?? 0.55;
  const preDelay = o.preDelay ?? 0.014;
  const seed = o.seed ?? 0xbadc0de;
  const earlyCount = o.early ?? 9;
  const spread = o.spread ?? 1;

  const sr = ac.sampleRate;
  const n = Math.max(2, Math.ceil(sr * seconds));
  const pd = Math.min(n - 2, Math.floor(sr * preDelay));
  const buf = ac.createBuffer(2, n, sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Decorrelated per channel, but seeded — the room is the same every boot.
    const rng = new SynthRng(seed + ch * 0x9e37);
    let lp = 0;
    const tail = n - pd;
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / tail;
      // One-pole lowpass whose coefficient closes over time: the late tail is
      // darker than the early tail, which is what makes it sound like a space
      // rather than like a noise burst.
      const c = damp * (1 - t * 0.82) + 0.02;
      lp += (rng.s() - lp) * c;
      d[i] = lp * Math.pow(1 - t, decay);
    }
    // Discrete early reflections. Prime-ish spacing avoids a metallic comb.
    let refl = 0.021 + ch * 0.0031 * spread;
    let amp = 0.55;
    for (let k = 0; k < earlyCount; k++) {
      const idx = Math.floor((preDelay + refl) * sr);
      if (idx >= n) break;
      d[idx] += (rng.f() < 0.5 ? -1 : 1) * amp;
      refl *= 1.47 + rng.f() * 0.22;
      amp *= 0.72;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Waveshaping
// ---------------------------------------------------------------------------

const _curveCache = new Map();

/**
 * Symmetric tanh soft-clip curve, normalised so the shaper can never push a
 * signal past unity on its own. `amount` 0..1 goes from gentle warmth to
 * aggressive fuzz.
 */
export function shaperCurve(amount = 0.5, n = 4096) {
  const key = `${Math.round(amount * 1000)}|${n}`;
  const hit = _curveCache.get(key);
  if (hit) return hit;
  const k = 1 + amount * amount * 90 + amount * 6;
  const norm = Math.tanh(k);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = Math.tanh(x * k) / norm;
  }
  _curveCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------
// Buffer utilities
// ---------------------------------------------------------------------------

export function analyzeBuffer(buf) {
  let peak = 0;
  let sum = 0;
  let count = 0;
  let bad = false;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) {
        bad = true;
        continue;
      }
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
      count++;
    }
  }
  return { peak, rms: count ? Math.sqrt(sum / count) : 0, bad };
}

/**
 * Scale a buffer so its absolute peak lands on `target`. Returns the peak the
 * recipe produced before scaling, which is the number worth watching: a recipe
 * whose raw peak is 40 is fighting the waveshapers rather than using them.
 */
export function normalizeBuffer(buf, target = 0.9) {
  const { peak } = analyzeBuffer(buf);
  if (!(peak > 0)) return 0;
  const g = target / peak;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return peak;
}

/** Trim leading digital silence so short one-shots trigger tight. */
export function trimHead(ac, buf, threshold = 1e-4) {
  const d = buf.getChannelData(0);
  let start = 0;
  while (start < d.length && Math.abs(d[start]) < threshold) start++;
  if (start < 8) return buf;
  const n = buf.length - start;
  const out = ac.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buf.getChannelData(ch).subarray(start));
  }
  return out;
}

/**
 * Turn a rendered buffer into a click-free loop: render `dur + fade` seconds,
 * then equal-power crossfade the overhang back over the head and truncate to
 * `dur`. Combined with LFO frequencies that are exact integer multiples of
 * 1/dur, the wrap point becomes inaudible.
 */
export function makeSeamless(ac, buf, dur, fade = 0.12) {
  const sr = buf.sampleRate;
  const n = Math.max(2, Math.floor(dur * sr));
  const f = Math.min(Math.floor(fade * sr), n - 1, buf.length - n);
  if (f <= 0) return buf;
  const out = ac.createBuffer(buf.numberOfChannels, n, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, n));
    for (let i = 0; i < f; i++) {
      const t = i / f;
      const a = Math.cos(t * Math.PI * 0.5); // outgoing (the overhang)
      const b = Math.sin(t * Math.PI * 0.5); // incoming (the head)
      dst[i] = src[n + i] * a + src[i] * b;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Offline rendering
// ---------------------------------------------------------------------------

const OfflineCtor =
  (typeof OfflineAudioContext !== 'undefined' && OfflineAudioContext) ||
  (typeof globalThis !== 'undefined' && globalThis.webkitOfflineAudioContext) ||
  null;

export const OFFLINE_SUPPORTED = !!OfflineCtor;

/**
 * Render a synthesis recipe to an AudioBuffer.
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} seconds
 * @param {(oc:OfflineAudioContext)=>void} build
 * @returns {Promise<AudioBuffer|null>} null if offline rendering is unavailable.
 */
export async function renderOffline(sampleRate, channels, seconds, build) {
  if (!OfflineCtor) return null;
  const frames = Math.max(128, Math.ceil(seconds * sampleRate));
  const oc = new OfflineCtor(channels, frames, sampleRate);
  build(oc);
  return await oc.startRendering();
}

// ---------------------------------------------------------------------------
// Patch — the recipe builder
// ---------------------------------------------------------------------------

const MIN = 1e-4; // exponential ramps cannot touch zero

/**
 * A thin ergonomic layer over the WebAudio node constructors so a synthesis
 * recipe reads as a signal-flow description instead of forty lines of
 * `createGain()` / `connect()`.
 *
 * Every time argument is *relative to the patch's t0*, which lets the same
 * recipe be baked offline (t0 = 0) or played live (t0 = some future time).
 */
export class Patch {
  /**
   * @param {BaseAudioContext} ac
   * @param {AudioNode} dest
   * @param {number} t0
   * @param {SynthRng} rng
   */
  constructor(ac, dest, t0 = 0, rng = new SynthRng(1)) {
    this.ac = ac;
    this.dest = dest;
    this.t0 = t0;
    this.rng = rng;
    this.sr = ac.sampleRate;
    /** @type {AudioScheduledSourceNode[]} */
    this.sources = [];
  }

  /** Absolute time for an offset relative to t0. */
  t(offset = 0) {
    return this.t0 + offset;
  }

  // -- node constructors ----------------------------------------------------

  gain(v = 1) {
    const g = this.ac.createGain();
    g.gain.value = v;
    return g;
  }

  filt(type = 'lowpass', freq = 1000, q = 1, gainDb = 0) {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gainDb;
    return f;
  }

  shape(amount = 0.5, oversample = '4x') {
    const w = this.ac.createWaveShaper();
    w.curve = shaperCurve(amount);
    w.oversample = oversample;
    return w;
  }

  delay(seconds = 0.05, max = 1) {
    const d = this.ac.createDelay(max);
    d.delayTime.value = seconds;
    return d;
  }

  comp(o = {}) {
    const c = this.ac.createDynamicsCompressor();
    c.threshold.value = o.threshold ?? -18;
    c.knee.value = o.knee ?? 6;
    c.ratio.value = o.ratio ?? 8;
    c.attack.value = o.attack ?? 0.003;
    c.release.value = o.release ?? 0.12;
    return c;
  }

  /**
   * An oscillator, started and stopped for you.
   * @param {OscillatorType} type
   * @param {number} freq
   * @param {{start?:number, dur?:number, detune?:number}} o
   */
  osc(type = 'sine', freq = 440, o = {}) {
    const n = this.ac.createOscillator();
    n.type = type;
    n.frequency.value = Math.max(0.01, freq);
    if (o.detune) n.detune.value = o.detune;
    const s = this.t(o.start ?? 0);
    n.start(s);
    if (o.dur != null) n.stop(s + Math.max(0.002, o.dur));
    this.sources.push(n);
    return n;
  }

  /**
   * A noise source. Reads from a shared per-context noise buffer at a random
   * offset so repeated uses inside one recipe do not phase-align.
   * @param {'white'|'pink'|'brown'} kind
   * @param {{start?:number, dur?:number, rate?:number, offset?:number, seconds?:number}} o
   */
  noise(kind = 'white', o = {}) {
    const seconds = o.seconds ?? 2;
    const buf = noiseBuffer(this.ac, kind, seconds, 0x51ced00d ^ hashId(kind));
    const n = this.ac.createBufferSource();
    n.buffer = buf;
    n.loop = true;
    if (o.rate) n.playbackRate.value = o.rate;
    const s = this.t(o.start ?? 0);
    const off = o.offset != null ? o.offset : this.rng.range(0, seconds * 0.9);
    n.start(s, off);
    if (o.dur != null) n.stop(s + Math.max(0.002, o.dur));
    this.sources.push(n);
    return n;
  }

  /** Connect a chain of nodes left to right, returning the last one. */
  chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Terminate a chain into the patch destination through a level trim. */
  out(node, level = 1) {
    const g = this.gain(level);
    node.connect(g);
    g.connect(this.dest);
    return g;
  }

  // -- automation -----------------------------------------------------------

  /**
   * Percussive envelope: linear attack, exponential decay, hard zero.
   * The trailing linear ramp matters — `exponentialRamp` asymptotes and would
   * otherwise leave a DC-ish crumb hanging on the node forever.
   */
  perc(param, start, peak, attack, decay, floorRatio = 0.0016) {
    const t = this.t(start);
    const a = Math.max(0.0004, attack);
    const d = Math.max(0.004, decay);
    const p = Math.max(MIN, peak);
    param.setValueAtTime(MIN, t);
    param.linearRampToValueAtTime(p, t + a);
    param.exponentialRampToValueAtTime(Math.max(MIN, p * floorRatio), t + a + d);
    param.linearRampToValueAtTime(0, t + a + d + 0.006);
    return t + a + d + 0.006;
  }

  /**
   * Full ADSR with an explicit hold. Returns the time the release completes.
   * @param {AudioParam} param
   * @param {number} start
   * @param {{peak?:number, a?:number, d?:number, s?:number, hold?:number, r?:number}} o
   */
  adsr(param, start, o = {}) {
    const t = this.t(start);
    const peak = Math.max(MIN, o.peak ?? 1);
    const a = Math.max(0.0004, o.a ?? 0.01);
    const d = Math.max(0.004, o.d ?? 0.08);
    const sus = Math.max(MIN, (o.s ?? 0.6) * peak);
    const hold = Math.max(0, o.hold ?? 0.1);
    const r = Math.max(0.004, o.r ?? 0.15);
    param.setValueAtTime(MIN, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(sus, t + a + d);
    param.setValueAtTime(sus, t + a + d + hold);
    param.exponentialRampToValueAtTime(MIN, t + a + d + hold + r);
    param.linearRampToValueAtTime(0, t + a + d + hold + r + 0.006);
    return t + a + d + hold + r + 0.006;
  }

  /** Exponential glide — the right curve for anything pitch-like. */
  glide(param, start, from, to, dur) {
    const t = this.t(start);
    param.setValueAtTime(Math.max(MIN, from), t);
    param.exponentialRampToValueAtTime(Math.max(MIN, to), t + Math.max(0.002, dur));
    return param;
  }

  /** Linear ramp — for pan, Q, gain-in-dB, anything not perceptually log. */
  lin(param, start, from, to, dur) {
    const t = this.t(start);
    param.setValueAtTime(from, t);
    param.linearRampToValueAtTime(to, t + Math.max(0.002, dur));
    return param;
  }

  /** A held value with no ramp. */
  set(param, start, value) {
    param.setValueAtTime(value, this.t(start));
    return param;
  }

  // -- composite generators -------------------------------------------------

  /**
   * An LFO driving an AudioParam. `freq` in Hz, `depth` in the param's units.
   * Loop-safe when freq is an integer multiple of 1/loopDuration.
   */
  lfo(param, freq, depth, o = {}) {
    const n = this.osc(o.type || 'sine', freq, { start: o.start ?? 0, dur: o.dur });
    const g = this.gain(depth);
    n.connect(g);
    g.connect(param);
    if (o.rampTo != null) {
      this.lin(g.gain, o.start ?? 0, depth, o.rampTo, o.rampDur ?? 0.5);
    }
    return g;
  }

  /**
   * Modal (bell/plate) synthesis: a stack of inharmonic partials with individual
   * decays. This is what makes metal sound like metal rather than like a beep —
   * the ratios are deliberately non-integer so no fundamental is implied.
   *
   * @param {number} start
   * @param {number} base fundamental in Hz
   * @param {Array<[number, number, number]>} spec [ratio, gain, decaySeconds]
   * @param {{type?:OscillatorType, drop?:number, attack?:number, detune?:number,
   *          level?:number, dest?:AudioNode}} o
   */
  modal(start, base, spec, o = {}) {
    const type = o.type || 'triangle';
    const drop = o.drop ?? 0; // fractional downward pitch glide (metal "boing")
    const attack = o.attack ?? 0.0008;
    const bus = this.gain(o.level ?? 1);
    for (let i = 0; i < spec.length; i++) {
      const [ratio, g, dec] = spec[i];
      const f = base * ratio;
      if (f > this.sr * 0.45) continue;
      const detune = o.detune ? this.rng.range(-o.detune, o.detune) : 0;
      const n = this.osc(type, f, { start, dur: dec + attack + 0.02, detune });
      if (drop > 0) {
        this.glide(n.frequency, start, f * (1 + drop), f, dec * 0.45);
      }
      const vg = this.gain(0);
      this.perc(vg.gain, start, g, attack, dec);
      n.connect(vg);
      vg.connect(bus);
    }
    bus.connect(o.dest || this.dest);
    return bus;
  }

  /**
   * Band-limited noise whose centre frequency sweeps — the universal "whoosh".
   * @param {number} start
   * @param {Array<[number, number]>} sweep [freqHz, timeOffsetFromStart] points
   */
  whoosh(start, sweep, o = {}) {
    const dur = o.dur ?? sweep[sweep.length - 1][1];
    const src = this.noise(o.kind || 'pink', { start, dur: dur + 0.05 });
    const bp = this.filt('bandpass', sweep[0][0], o.q ?? 1.6);
    this.set(bp.frequency, start, sweep[0][0]);
    for (let i = 1; i < sweep.length; i++) {
      bp.frequency.exponentialRampToValueAtTime(
        Math.max(MIN, sweep[i][0]),
        this.t(start + sweep[i][1])
      );
    }
    const vg = this.gain(0);
    this.perc(vg.gain, start, o.peak ?? 1, o.attack ?? 0.012, o.decay ?? dur);
    src.connect(bp);
    bp.connect(vg);
    vg.connect(o.dest || this.dest);
    return vg;
  }

  /**
   * Pitch-swept sine sub — the "thump" under every heavy impact in this game.
   * A real sub-thump sweeps *down* fast; a static sine reads as a synth tone.
   */
  subThump(start, fromHz, toHz, o = {}) {
    const dec = o.decay ?? 0.5;
    const n = this.osc('sine', fromHz, { start, dur: dec + 0.06 });
    this.glide(n.frequency, start, fromHz, toHz, o.sweep ?? dec * 0.5);
    const g = this.gain(0);
    this.perc(g.gain, start, o.peak ?? 1, o.attack ?? 0.004, dec);
    n.connect(g);
    // A touch of saturation adds harmonics so the thump survives on speakers
    // that cannot reproduce 30Hz at all.
    if (o.drive) {
      const w = this.shape(o.drive, '2x');
      g.connect(w);
      w.connect(o.dest || this.dest);
      return w;
    }
    g.connect(o.dest || this.dest);
    return g;
  }

  /** Short bright transient click — the "crack" that gives a shot its edge. */
  crack(start, o = {}) {
    const src = this.noise('white', { start, dur: (o.decay ?? 0.03) + 0.02 });
    const hp = this.filt('highpass', o.freq ?? 3000, o.q ?? 0.8);
    const g = this.gain(0);
    this.perc(g.gain, start, o.peak ?? 1, o.attack ?? 0.0006, o.decay ?? 0.03);
    src.connect(hp);
    hp.connect(g);
    g.connect(o.dest || this.dest);
    return g;
  }

  /** Ring modulation: multiply `input` by a sine. Metallic, electrical, alien. */
  ring(input, freq, start, dur, depth = 1) {
    const vca = this.gain(1 - depth);
    const mod = this.osc('sine', freq, { start, dur });
    const md = this.gain(depth);
    mod.connect(md);
    md.connect(vca.gain);
    input.connect(vca);
    return vca;
  }
}

// ---------------------------------------------------------------------------
// Voice pool
// ---------------------------------------------------------------------------

/**
 * A fixed set of pre-wired playback chains.
 *
 *   source -> [gain] -> [lowpass] -> [panner] -> bus
 *                   \-> [send]    -> reverb
 *
 * Everything except the AudioBufferSourceNode is built once in the constructor
 * and reused forever. A source node is single-use by spec, so one allocation per
 * shot is unavoidable; three or four are not.
 *
 * When every slot is busy the oldest lowest-priority voice is stolen with a 5ms
 * fade so stealing never clicks.
 */
export class VoicePool {
  /**
   * @param {BaseAudioContext} ac
   * @param {AudioNode} busNode
   * @param {AudioNode|null} reverbNode
   * @param {number} cap
   */
  constructor(ac, busNode, reverbNode, cap = 28) {
    this.ac = ac;
    this.cap = cap;
    this.slots = [];
    this._seq = 1;

    for (let i = 0; i < cap; i++) {
      const gain = ac.createGain();
      const filt = ac.createBiquadFilter();
      const pan = ac.createStereoPanner
        ? ac.createStereoPanner()
        : ac.createGain(); // ancient-browser fallback: no pan, still audible
      const send = ac.createGain();

      gain.gain.value = 0;
      filt.type = 'lowpass';
      filt.frequency.value = 20000;
      filt.Q.value = 0.0001;
      send.gain.value = 0;

      gain.connect(filt);
      filt.connect(pan);
      pan.connect(busNode);
      if (reverbNode) {
        filt.connect(send);
        send.connect(reverbNode);
      }

      const slot = {
        gain,
        filt,
        pan,
        send,
        src: null,
        id: '',
        priority: 0,
        startedAt: -1e9,
        endsAt: -1e9,
        token: 0,
        onended: null,
      };
      // One stable closure per slot, created once — not per shot.
      slot.onended = () => {
        if (slot.src) {
          try {
            slot.src.disconnect();
          } catch (e) {
            /* already torn down */
          }
        }
        slot.src = null;
        slot.startedAt = -1e9;
        slot.endsAt = -1e9;
      };
      this.slots.push(slot);
    }
  }

  get busy() {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].src) n++;
    return n;
  }

  _acquire(now, priority) {
    // Prefer a free slot.
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.src) return s;
      // A voice whose scheduled end has passed but whose onended has not fired
      // yet (offline/suspended contexts) counts as free.
      if (s.endsAt > -1e8 && s.endsAt < now - 0.02) {
        s.onended();
        return s;
      }
    }
    // Steal: oldest voice of the lowest priority present.
    let victim = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.priority > priority) continue;
      if (!victim || s.priority < victim.priority || s.startedAt < victim.startedAt) {
        victim = s;
      }
    }
    if (!victim) return null;
    try {
      victim.gain.gain.cancelScheduledValues(now);
      victim.gain.gain.setTargetAtTime(0, now, 0.0015);
      if (victim.src) victim.src.stop(now + 0.008);
    } catch (e) {
      /* a source that already stopped throws; harmless */
    }
    victim.onended();
    return victim;
  }

  /**
   * @param {AudioBuffer} buffer
   * @param {{gain?:number, rate?:number, detune?:number, pan?:number, send?:number,
   *          lp?:number, when?:number, loop?:boolean, priority?:number, id?:string}} o
   */
  play(buffer, o = {}) {
    if (!buffer) return null;
    const ac = this.ac;
    const now = ac.currentTime;
    const when = Math.max(now, o.when ?? now);
    const priority = o.priority ?? 1;
    const slot = this._acquire(now, priority);
    if (!slot) return null;

    const src = ac.createBufferSource();
    src.buffer = buffer;
    const rate = o.rate ?? 1;
    if (rate !== 1) src.playbackRate.value = rate;
    if (o.detune && src.detune) src.detune.value = o.detune;
    if (o.loop) src.loop = true;

    const g = Math.max(0, o.gain ?? 1);
    slot.gain.gain.cancelScheduledValues(now);
    slot.gain.gain.setValueAtTime(g, when);

    if (slot.pan.pan) {
      const p = Math.max(-1, Math.min(1, o.pan ?? 0));
      slot.pan.pan.cancelScheduledValues(now);
      slot.pan.pan.setValueAtTime(p, when);
    }

    const lp = o.lp ?? 20000;
    slot.filt.frequency.cancelScheduledValues(now);
    slot.filt.frequency.setValueAtTime(Math.max(120, Math.min(20000, lp)), when);

    slot.send.gain.cancelScheduledValues(now);
    slot.send.gain.setValueAtTime(Math.max(0, o.send ?? 0), when);

    src.connect(slot.gain);
    src.onended = slot.onended;
    src.start(when);

    const dur = (buffer.duration / Math.max(0.01, rate)) + 0.02;
    if (!o.loop) src.stop(when + dur);

    slot.src = src;
    slot.id = o.id || '';
    slot.priority = priority;
    slot.startedAt = when;
    slot.endsAt = o.loop ? 1e9 : when + dur;
    slot.token = this._seq++;
    return slot;
  }

  stopAll(fade = 0.04) {
    const now = this.ac.currentTime;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.src) continue;
      try {
        s.gain.gain.cancelScheduledValues(now);
        s.gain.gain.setTargetAtTime(0, now, Math.max(0.001, fade / 3));
        s.src.stop(now + fade);
      } catch (e) {
        /* already stopped */
      }
    }
  }
}

/**
 * A single persistent looping voice (thruster wash, flamethrower, alarm).
 * Unlike pooled one-shots these are long-lived and fade rather than retrigger,
 * so they get their own chain and are never stolen.
 */
export class LoopVoice {
  constructor(ac, busNode, reverbNode, o = {}) {
    this.ac = ac;
    this.gain = ac.createGain();
    this.gain.gain.value = 0;
    this.pan = ac.createStereoPanner ? ac.createStereoPanner() : ac.createGain();
    this.filt = ac.createBiquadFilter();
    this.filt.type = 'lowpass';
    this.filt.frequency.value = o.lp ?? 20000;
    this.send = ac.createGain();
    this.send.gain.value = o.send ?? 0;

    this.gain.connect(this.filt);
    this.filt.connect(this.pan);
    this.pan.connect(busNode);
    if (reverbNode) {
      this.filt.connect(this.send);
      this.send.connect(reverbNode);
    }

    this.buffer = null;
    this.src = null;
    this.target = 0;
    this.level = o.level ?? 0.6;
    this.attack = o.attack ?? 0.08;
    this.release = o.release ?? 0.22;
  }

  setBuffer(buf) {
    this.buffer = buf;
  }

  _ensure() {
    if (this.src || !this.buffer) return;
    const src = this.ac.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.connect(this.gain);
    try {
      src.start(this.ac.currentTime);
    } catch (e) {
      return;
    }
    this.src = src;
  }

  /** @param {boolean} on */
  setActive(on, level) {
    if (level != null) this.level = level;
    const now = this.ac.currentTime;
    if (on) {
      this._ensure();
      if (!this.src) return;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(this.level, now, this.attack / 3);
      this.target = this.level;
    } else if (this.target !== 0) {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(0, now, this.release / 3);
      this.target = 0;
    }
  }

  setRate(r) {
    if (this.src) {
      try {
        this.src.playbackRate.setTargetAtTime(r, this.ac.currentTime, 0.05);
      } catch (e) {
        /* ignore */
      }
    }
  }

  setPan(p) {
    if (this.pan.pan) {
      try {
        this.pan.pan.setTargetAtTime(
          Math.max(-1, Math.min(1, p)),
          this.ac.currentTime,
          0.04
        );
      } catch (e) {
        /* ignore */
      }
    }
  }

  dispose() {
    try {
      if (this.src) this.src.stop();
    } catch (e) {
      /* ignore */
    }
    this.src = null;
  }
}
