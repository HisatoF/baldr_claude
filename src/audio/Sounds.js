import { Patch, SynthRng, renderOffline, normalizeBuffer, analyzeBuffer } from './Synth.js';

/**
 * The sound library.
 *
 * Every sound is a synthesis recipe, baked once to an AudioBuffer at boot via
 * OfflineAudioContext. Nothing here loads a sample, because the project ships no
 * asset files at all.
 *
 * Baking matters as much as the recipes do: a gatling firing twenty rounds a second
 * would otherwise construct twenty node graphs per second, and the audio thread
 * cannot afford that. Build the graph once, play the buffer many times.
 *
 * Each recipe is `(p: Patch) => void`, where `p.t(x)` is x seconds from the start.
 */

const SR = 44100;

/** Weapon report: a transient crack, a body, and a tail. */
function gunshot(p, o = {}) {
  const {
    crackFreq = 2600,
    bodyFrom = 320,
    bodyTo = 60,
    dur = 0.22,
    drive = 0.55,
    level = 0.9,
  } = o;

  // Crack — the click that gives a shot its edge and makes it read at low volume.
  const n = p.noise('white');
  const hp = p.filt('highpass', crackFreq, 0.8);
  const crackGain = p.gain(0);
  p.perc(crackGain.gain, p.t(0), level * 0.85, 0.0006, 0.028);
  p.chain(n, hp, p.shape(drive), crackGain);
  p.out(crackGain, 1);

  // Body — a pitch-swept tone giving the weapon its calibre.
  const osc = p.osc('sawtooth', bodyFrom);
  p.glide(osc.frequency, p.t(0), bodyFrom, bodyTo, dur * 0.7);
  const bodyGain = p.gain(0);
  p.perc(bodyGain.gain, p.t(0), level * 0.7, 0.001, dur * 0.55);
  p.chain(osc, p.filt('lowpass', 2200, 1.2), bodyGain);
  p.out(bodyGain, 1);

  // Tail — filtered noise, the room answering back.
  const tail = p.noise('pink');
  const tailGain = p.gain(0);
  p.perc(tailGain.gain, p.t(0.004), level * 0.3, 0.006, dur);
  p.chain(tail, p.filt('bandpass', 900, 0.7), tailGain);
  p.out(tailGain, 0.7);
}

/** Energy weapon: harmonic sweep rather than a noise burst. */
function beamShot(p, o = {}) {
  const { from = 1800, to = 420, dur = 0.3, level = 0.8, detune = 1.005 } = o;
  for (let i = 0; i < 3; i++) {
    const osc = p.osc(i === 0 ? 'sine' : 'triangle', from * Math.pow(detune, i));
    p.glide(osc.frequency, p.t(0), from * Math.pow(detune, i), to, dur);
    const g = p.gain(0);
    p.perc(g.gain, p.t(0), (level * 0.5) / (i + 1), 0.002, dur * (0.7 + i * 0.1));
    p.chain(osc, p.filt('bandpass', 1400, 2.2), g);
    p.out(g, 1);
  }
  // A whisper of noise keeps it from sounding like a test tone.
  const n = p.noise('white');
  const ng = p.gain(0);
  p.perc(ng.gain, p.t(0), level * 0.18, 0.001, dur * 0.5);
  p.chain(n, p.filt('bandpass', 3200, 3), ng);
  p.out(ng, 0.8);
}

/** Impact: metal struck. Modal ringing over a transient. */
function metalHit(p, o = {}) {
  const { base = 380, level = 0.85, dur = 0.34, bright = 1 } = o;
  // Inharmonic partials are what separate "metal" from "drum".
  // Partials are [ratio, gain, decay] tuples. The ratios are deliberately
  // inharmonic — that is what separates "struck metal" from "drum".
  p.modal(p.t(0), base, [
    [1.0, 0.9, dur],
    [2.41, 0.55, dur * 0.7],
    [3.83, 0.35, dur * 0.5],
    [5.19, 0.22, dur * 0.34],
    [7.11, 0.14, dur * 0.24],
  ], { level: level * 0.8, drop: 0.04, detune: 4 });

  const n = p.noise('white');
  const g = p.gain(0);
  p.perc(g.gain, p.t(0), level * 0.5, 0.0004, 0.02);
  p.chain(n, p.filt('highpass', 1800 * bright, 0.7), g);
  p.out(g, 1);
}

/** Explosion: sub thump + filtered roar + debris crackle. */
function explosion(p, o = {}) {
  const { size = 1, level = 0.95 } = o;
  const dur = 0.7 * size;

  p.subThump(p.t(0), 120 * (1 / size), 28, { level: level * 0.9, dur: dur * 0.8 });

  const roar = p.noise('brown');
  const rg = p.gain(0);
  p.perc(rg.gain, p.t(0), level, 0.004, dur);
  const lp = p.filt('lowpass', 1800, 0.9);
  p.glide(lp.frequency, p.t(0), 2600, 180, dur);
  p.chain(roar, lp, p.shape(0.45), rg);
  p.out(rg, 1);

  // Crackle — sparse high transients so the tail is not a smooth fade.
  const crack = p.noise('white');
  const cg = p.gain(0);
  p.perc(cg.gain, p.t(0.03), level * 0.3, 0.002, dur * 0.6);
  p.chain(crack, p.filt('highpass', 2600, 0.8), cg);
  p.out(cg, 0.6);
}

/** Thruster / dash burst — a whoosh with a hot core. */
function thruster(p, o = {}) {
  const { dur = 0.34, level = 0.8 } = o;
  p.whoosh(p.t(0), [[260, 0], [2400, dur * 0.45], [500, dur]], { dur, peak: level * 0.8 });
  const osc = p.osc('sawtooth', 90);
  p.glide(osc.frequency, p.t(0), 70, 190, dur * 0.6);
  const g = p.gain(0);
  p.perc(g.gain, p.t(0), level * 0.35, 0.008, dur * 0.7);
  p.chain(osc, p.filt('lowpass', 900, 1.4), g);
  p.out(g, 1);
}

/** UI blip — short, tonal, unambiguous. */
function blip(p, o = {}) {
  const { freq = 880, dur = 0.12, level = 0.5, type = 'square', up = true } = o;
  const osc = p.osc(type, freq);
  p.glide(osc.frequency, p.t(0), up ? freq : freq * 1.5, up ? freq * 1.5 : freq, dur);
  const g = p.gain(0);
  p.perc(g.gain, p.t(0), level, 0.002, dur);
  p.chain(osc, p.filt('lowpass', 4200, 1), g);
  p.out(g, 0.8);
}

/**
 * Recipes, keyed by the id gameplay uses. Weapon ids match `combat/Weapons.js`
 * so `audio.play(weapon.id)` resolves without a lookup table.
 */
export const RECIPES = {
  // --- weapons ---
  rifle:   { dur: 0.30, build: (p) => gunshot(p, { crackFreq: 2800, bodyFrom: 340, bodyTo: 70, dur: 0.2 }) },
  gatling: { dur: 0.20, build: (p) => gunshot(p, { crackFreq: 3200, bodyFrom: 300, bodyTo: 90, dur: 0.13, level: 0.7 }) },
  shotgun: { dur: 0.50, build: (p) => gunshot(p, { crackFreq: 1700, bodyFrom: 260, bodyTo: 40, dur: 0.4, drive: 0.8, level: 1 }) },
  sniper:  { dur: 0.70, build: (p) => { gunshot(p, { crackFreq: 3400, bodyFrom: 420, bodyTo: 48, dur: 0.5, drive: 0.7 }); beamShot(p, { from: 2600, to: 300, dur: 0.4, level: 0.4 }); } },
  railgun: { dur: 1.10, build: (p) => { beamShot(p, { from: 220, to: 3000, dur: 0.45, level: 0.5 }); explosion(p, { size: 0.8, level: 0.7 }); } },
  laser:   { dur: 0.36, build: (p) => beamShot(p, { from: 2100, to: 520, dur: 0.3 }) },
  missile: { dur: 0.55, build: (p) => { thruster(p, { dur: 0.45, level: 0.6 }); gunshot(p, { crackFreq: 1500, bodyFrom: 200, bodyTo: 60, dur: 0.2, level: 0.5 }); } },
  grenade: { dur: 0.30, build: (p) => gunshot(p, { crackFreq: 1200, bodyFrom: 180, bodyTo: 50, dur: 0.24, level: 0.75 }) },
  mine:    { dur: 0.24, build: (p) => blip(p, { freq: 320, dur: 0.2, level: 0.5, type: 'triangle', up: false }) },
  saber:   { dur: 0.34, build: (p) => { p.whoosh(p.t(0), [[700, 0], [3400, 0.12], [900, 0.26]], { dur: 0.26, peak: 0.6 }); beamShot(p, { from: 1400, to: 900, dur: 0.22, level: 0.35 }); } },
  lance:   { dur: 0.50, build: (p) => { p.whoosh(p.t(0), [[420, 0], [2600, 0.18], [600, 0.4]], { dur: 0.4, peak: 0.75 }); beamShot(p, { from: 900, to: 380, dur: 0.34, level: 0.45 }); } },
  hammer:  { dur: 0.80, build: (p) => { p.whoosh(p.t(0), [[260, 0], [1200, 0.13], [300, 0.3]], { dur: 0.3, peak: 0.7 }); explosion(p, { size: 0.7, level: 0.8 }); } },
  drill:   { dur: 0.20, build: (p) => metalHit(p, { base: 620, dur: 0.14, level: 0.6, bright: 1.3 }) },
  uppercut:{ dur: 0.40, build: (p) => { p.whoosh(p.t(0), [[320, 0], [1800, 0.13], [500, 0.3]], { dur: 0.3, peak: 0.7 }); metalHit(p, { base: 300, dur: 0.3, level: 0.6 }); } },
  slam:    { dur: 0.75, build: (p) => explosion(p, { size: 0.85, level: 0.9 }) },
  drone:   { dur: 0.30, build: (p) => blip(p, { freq: 1200, dur: 0.24, level: 0.4, type: 'sine' }) },
  flamer:  { dur: 0.24, build: (p) => { const n = p.noise('brown'); const g = p.gain(0); p.perc(g.gain, p.t(0), 0.55, 0.01, 0.2); p.chain(n, p.filt('bandpass', 700, 1.1), p.shape(0.6), g); p.out(g, 1); } },
  enemyShot: { dur: 0.26, build: (p) => beamShot(p, { from: 900, to: 260, dur: 0.2, level: 0.45 }) },

  // --- impacts ---
  hit:      { dur: 0.40, build: (p) => metalHit(p, { base: 360, dur: 0.3 }) },
  hitHeavy: { dur: 0.70, build: (p) => { metalHit(p, { base: 210, dur: 0.55, level: 1 }); p.subThump(p.t(0), 90, 34, { level: 0.6, dur: 0.4 }); } },
  block:    { dur: 0.35, build: (p) => metalHit(p, { base: 740, dur: 0.25, level: 0.7, bright: 1.6 }) },
  explode:  { dur: 0.90, build: (p) => explosion(p, { size: 1 }) },
  explodeBig: { dur: 1.30, build: (p) => explosion(p, { size: 1.6 }) },

  // --- mech ---
  land:     { dur: 0.55, build: (p) => { p.subThump(p.t(0), 110, 30, { level: 0.8, dur: 0.35 }); metalHit(p, { base: 240, dur: 0.3, level: 0.5 }); } },
  dash:     { dur: 0.40, build: (p) => thruster(p, { dur: 0.34, level: 0.85 }) },
  thruster: { dur: 0.45, build: (p) => thruster(p, { dur: 0.4, level: 0.7 }) },
  step:     { dur: 0.30, build: (p) => { p.subThump(p.t(0), 90, 40, { level: 0.4, dur: 0.16 }); metalHit(p, { base: 520, dur: 0.14, level: 0.28, bright: 0.8 }); } },

  // --- systems ---
  lock:     { dur: 0.22, build: (p) => blip(p, { freq: 1500, dur: 0.16, level: 0.35, type: 'sine' }) },
  warn:     { dur: 0.45, build: (p) => { blip(p, { freq: 620, dur: 0.18, level: 0.45, type: 'square', up: false }); } },
  enEmpty:  { dur: 0.40, build: (p) => blip(p, { freq: 300, dur: 0.32, level: 0.45, type: 'sawtooth', up: false }) },
  rankUp:   { dur: 0.60, build: (p) => { blip(p, { freq: 880, dur: 0.2, level: 0.4, type: 'triangle' }); blip(p, { freq: 1320, dur: 0.3, level: 0.35, type: 'sine' }); } },
  damage:   { dur: 0.50, build: (p) => { metalHit(p, { base: 180, dur: 0.35, level: 0.9 }); blip(p, { freq: 220, dur: 0.3, level: 0.3, type: 'sawtooth', up: false }); } },
  gameOver: { dur: 1.40, build: (p) => { explosion(p, { size: 1.4 }); blip(p, { freq: 400, dur: 1.0, level: 0.4, type: 'sine', up: false }); } },
  waveStart:{ dur: 0.70, build: (p) => { blip(p, { freq: 520, dur: 0.25, level: 0.4, type: 'square' }); blip(p, { freq: 780, dur: 0.4, level: 0.35, type: 'triangle' }); } },
};

/**
 * Bake every recipe. Returns a Map<id, AudioBuffer> plus a diagnostic table so the
 * self-test can assert nothing is silent and nothing clips.
 */
export async function bakeAll(sampleRate = SR, seed = 0x51ced00d) {
  const buffers = new Map();
  const report = [];

  for (const [id, spec] of Object.entries(RECIPES)) {
    try {
      const buf = await renderOffline(sampleRate, 1, spec.dur, (oc) => {
        const rng = new SynthRng(seed ^ hash(id));
        const master = oc.createGain();
        master.gain.value = 1;
        master.connect(oc.destination);
        const p = new Patch(oc, master, 0, rng);
        spec.build(p);
        for (const s of p.sources) {
          try { s.start(0); } catch { /* already started */ }
        }
      });
      if (!buf) continue;
      // Normalise so no recipe is wildly louder than its neighbours; per-sound
      // balance is then a mixer decision rather than a synthesis accident.
      normalizeBuffer(buf, 0.86);
      buffers.set(id, buf);
      report.push({ id, ...analyzeBuffer(buf) });
    } catch (err) {
      console.warn(`[audio] recipe "${id}" failed to bake:`, err?.message ?? err);
    }
  }

  return { buffers, report };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
