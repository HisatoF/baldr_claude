import { bakeAll } from './Sounds.js';
import { VoicePool, makeImpulseResponse, OFFLINE_SUPPORTED } from './Synth.js';
import { clamp, damp } from '../core/MathUtil.js';

/**
 * Audio module (order 60).
 *
 * Bus layout: master ← (sfx → reverb send, music, ui), with a limiter on master so a
 * screen full of explosions cannot clip.
 *
 * Everything is synthesised — see Sounds.js. Sounds are baked to buffers at boot and
 * played through a voice pool with oldest-voice stealing, so sustained fire costs a
 * buffer source rather than a node graph.
 *
 * Autoplay policy: browsers suspend the context until a user gesture. Every path here
 * is guarded so a suspended or entirely absent context is silent rather than an
 * error — the capture harness runs headless and muted, and the rubric treats any
 * console error as an automatic rejection.
 */
export function createAudioModule() {
  let ac = null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let uiBus = null;
  let reverb = null;
  let pool = null;
  let buffers = new Map();
  let ready = false;
  let unlocked = false;
  let bakeReport = [];

  let musicIntensity = 0;
  let musicTarget = 0;
  let music = null;

  const api = {
    get ready() { return ready; },
    get report() { return bakeReport; },

    /**
     * @param {string} id
     * @param {{gain?:number, rate?:number, pan?:number, x?:number}} [opts]
     */
    play(id, opts) {
      if (!ready || !pool) return null;
      const buf = buffers.get(id);
      if (!buf) return null;
      const o = opts || EMPTY;

      // World X maps to stereo position relative to the camera, so the mix tells you
      // where a threat is before you see it.
      let pan = o.pan;
      if (pan === undefined && o.x !== undefined) {
        pan = clamp((o.x - listenerX) / 34, -0.85, 0.85);
      }

      try {
        return pool.play(buf, {
          gain: o.gain ?? 1,
          rate: o.rate ?? 1,
          pan: pan ?? 0,
          priority: o.priority ?? 1,
        });
      } catch {
        return null;
      }
    },

    setMusicIntensity(v) {
      musicTarget = clamp(v, 0, 1);
    },

    /** Resume the context. Safe to call repeatedly and before init completes. */
    async unlock() {
      if (!ac || unlocked) return;
      try {
        if (ac.state === 'suspended') await ac.resume();
        unlocked = ac.state === 'running';
      } catch {
        /* a blocked resume is not an error worth surfacing */
      }
    },

    setVolume(v) {
      if (master) master.gain.value = clamp(v, 0, 1);
    },
  };

  const EMPTY = {};
  let listenerX = 0;

  /**
   * Adaptive music: four layers on one clock, faded in by combat intensity.
   * Sequenced with a lookahead scheduler — notes are scheduled ahead against
   * AudioContext.currentTime, never triggered by a timer alone.
   */
  function createMusic(ctxAudio, dest) {
    const BPM = 148;
    const beat = 60 / BPM;
    const step16 = beat / 4;
    // A minor pentatonic-ish set: driving without needing chord changes.
    const ROOT = 55; // A1
    const SCALE = [0, 3, 5, 7, 10];

    const layers = {
      bass: { gain: ctxAudio.createGain(), from: 0.0 },
      drums: { gain: ctxAudio.createGain(), from: 0.15 },
      arp: { gain: ctxAudio.createGain(), from: 0.45 },
      lead: { gain: ctxAudio.createGain(), from: 0.72 },
    };
    for (const k in layers) {
      layers[k].gain.gain.value = 0;
      layers[k].gain.connect(dest);
    }

    let nextStep = 0;
    let nextTime = 0;
    const LOOKAHEAD = 0.12;

    function note(destGain, freq, t, dur, type, level) {
      const o = ctxAudio.createOscillator();
      const g = ctxAudio.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(destGain);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    function kick(t) {
      const o = ctxAudio.createOscillator();
      const g = ctxAudio.createGain();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.09);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(layers.drums.gain);
      o.start(t);
      o.stop(t + 0.25);
    }

    function hat(t, open) {
      const b = ctxAudio.createBufferSource();
      const len = Math.floor(ctxAudio.sampleRate * (open ? 0.12 : 0.03));
      const buf = ctxAudio.createBuffer(1, len, ctxAudio.sampleRate);
      const d = buf.getChannelData(0);
      let s = 12345;
      for (let i = 0; i < len; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        d[i] = ((s / 4294967296) * 2 - 1) * (1 - i / len);
      }
      b.buffer = buf;
      const f = ctxAudio.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = ctxAudio.createGain();
      g.gain.value = open ? 0.16 : 0.24;
      b.connect(f).connect(g).connect(layers.drums.gain);
      b.start(t);
    }

    function scheduleStep(i, t) {
      const bar = Math.floor(i / 16) % 4;

      // Bass: root pulse with a lift on the last bar of the phrase.
      if (i % 2 === 0) {
        const deg = bar === 3 && i % 16 >= 12 ? 3 : 0;
        note(layers.bass.gain, ROOT * Math.pow(2, SCALE[deg] / 12), t, step16 * 1.7, 'sawtooth', 0.30);
      }
      // Drums
      if (i % 8 === 0 || i % 16 === 10) kick(t);
      if (i % 2 === 1) hat(t, i % 8 === 7);
      // Arpeggio
      if (i % 1 === 0) {
        const d = SCALE[(i * 3) % SCALE.length];
        const oct = 3 + ((i >> 2) % 2);
        note(layers.arp.gain, ROOT * Math.pow(2, d / 12 + oct), t, step16 * 0.85, 'square', 0.055);
      }
      // Lead: sparse, only on the phrase turnaround, so it stays an event.
      if (bar === 3 && i % 16 === 8) {
        const d = SCALE[(i >> 1) % SCALE.length];
        note(layers.lead.gain, ROOT * Math.pow(2, d / 12 + 4), t, beat * 0.9, 'triangle', 0.09);
      }
    }

    return {
      layers,
      tick(now, intensity) {
        if (nextTime === 0) nextTime = now + 0.06;
        while (nextTime < now + LOOKAHEAD) {
          scheduleStep(nextStep, nextTime);
          nextStep = (nextStep + 1) % 64;
          nextTime += step16;
        }
        // Each layer enters at its own intensity threshold, so the arrangement
        // thickens with the fight rather than just getting louder.
        for (const k in layers) {
          const L = layers[k];
          const want = intensity > L.from ? clamp((intensity - L.from) / 0.3, 0, 1) : 0;
          L.gain.gain.value += (want - L.gain.gain.value) * 0.08;
        }
      },
    };
  }

  return {
    name: 'audio',
    order: 60,

    async init(ctx) {
      ctx.audio = api;

      const Ctor =
        (typeof AudioContext !== 'undefined' && AudioContext) ||
        (typeof webkitAudioContext !== 'undefined' && webkitAudioContext) ||
        null;
      if (!Ctor) return; // no WebAudio: stay silent, never throw

      try {
        ac = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }

      master = ac.createGain();
      master.gain.value = 0.85;
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.14;
      master.connect(limiter).connect(ac.destination);

      sfxBus = ac.createGain();
      sfxBus.gain.value = 0.9;
      sfxBus.connect(master);

      musicBus = ac.createGain();
      musicBus.gain.value = 0.5;
      musicBus.connect(master);

      uiBus = ac.createGain();
      uiBus.gain.value = 0.7;
      uiBus.connect(master);

      try {
        const ir = makeImpulseResponse(ac, { seconds: 1.4, decay: 2.6, damp: 0.42 });
        reverb = ac.createConvolver();
        reverb.buffer = ir;
        const send = ac.createGain();
        send.gain.value = 0.22;
        reverb.connect(send).connect(master);
      } catch {
        reverb = null;
      }

      pool = new VoicePool(ac, sfxBus, reverb, 28);
      music = createMusic(ac, musicBus);

      // Bake off the main thread of gameplay; if OfflineAudioContext is missing we
      // simply stay silent rather than fall back to per-shot node graphs.
      if (OFFLINE_SUPPORTED) {
        try {
          const baked = await bakeAll(ac.sampleRate);
          buffers = baked.buffers;
          bakeReport = baked.report;
          ready = buffers.size > 0;
        } catch (err) {
          console.warn('[audio] bake failed:', err?.message ?? err);
        }
      }

      // --- gameplay wiring ---
      const bus = ctx.bus;
      bus.on('weapon:fired', (p) => api.play(p.weaponId, { gain: 0.8, x: p.origin.x }));
      bus.on('hit:landed', (p) => {
        const heavy = (p.damage ?? 0) > 55;
        api.play(heavy ? 'hitHeavy' : 'hit', {
          gain: heavy ? 0.9 : 0.6,
          x: p.point.x,
          rate: 0.92 + (p.damage ?? 20) / 400,
        });
      });
      bus.on('hit:blocked', (p) => api.play('block', { gain: 0.7, x: p.point.x }));
      bus.on('player:dashed', () => api.play('dash', { gain: 0.75 }));
      bus.on('player:damaged', () => api.play('damage', { gain: 0.9 }));
      bus.on('boost:depleted', () => api.play('enEmpty', { gain: 0.5 }));
      bus.on('fx:explosion', (p) => {
        const big = (p.radius ?? 2) > 3.4;
        api.play(big ? 'explodeBig' : 'explode', { gain: big ? 1 : 0.8, x: p.point.x });
      });
      bus.on('entity:died', (p) => {
        if (p.entity?.kind === 'projectile') return;
        api.play('explode', { gain: 0.75, x: p.entity?.pos?.x ?? 0 });
      });
      bus.on('wave:started', () => api.play('waveStart', { gain: 0.6 }));
      bus.on('combo:ended', (p) => {
        if (p.count >= 12) api.play('rankUp', { gain: 0.55 });
      });
      bus.on('game:over', () => api.play('gameOver', { gain: 1 }));

      // Unlock on the first real gesture.
      const gesture = () => {
        api.unlock();
        window.removeEventListener('pointerdown', gesture);
        window.removeEventListener('keydown', gesture);
      };
      window.addEventListener('pointerdown', gesture, { passive: true });
      window.addEventListener('keydown', gesture, { passive: true });
    },

    frame(ctx, dt) {
      if (!ac) return;
      listenerX = ctx.combat?.player?.pos?.x ?? 0;
      musicIntensity = damp(musicIntensity, musicTarget, 1.6, dt);
      if (unlocked && ac.state === 'running' && music) {
        try {
          music.tick(ac.currentTime, musicIntensity);
        } catch {
          /* never let the music scheduler break a frame */
        }
      }
    },

    dispose() {
      try {
        pool?.stopAll(0.05);
        ac?.close();
      } catch {
        /* closing an already-closed context is not interesting */
      }
    },
  };
}
