import { Bus } from './Bus.js';
import { Input } from './Input.js';
import { Rng } from './Rng.js';
import { clamp } from './MathUtil.js';

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;
const MAX_SUB = 5;

/**
 * Fixed-timestep engine with interpolated rendering.
 *
 * Gameplay advances in exact 1/120s steps so that combo timings, hitstun counts and
 * juggle windows are frame-rate independent and reproducible from a seed. Rendering
 * happens once per animation frame with an `alpha` factor so motion stays smooth at
 * any refresh rate.
 *
 * Time dilation (hitstop, slow-motion) scales how much *wall* time is fed into the
 * accumulator — it never changes SIM_DT, so the simulation stays deterministic.
 */
export class Engine {
  constructor(opts = {}) {
    this.modules = [];
    this._byName = new Map();
    this.running = false;
    this.stepIndex = 0;

    this._accumulator = 0;
    this._lastTime = 0;
    this._rafId = 0;

    this._hitstopSteps = 0;
    this._slowmo = { scale: 1, steps: 0 };

    this.ctx = {
      engine: this,
      bus: new Bus(),
      input: new Input(opts.inputTarget || window),
      rng: new Rng(opts.seed ?? 0x5eed1234),
      time: { elapsed: 0, dt: 0, frame: 0, scale: 1, alpha: 0, present: true },
      debug: { enabled: false },
    };

    this.stats = {
      fps: 0,
      simMs: 0,
      frameMs: 0,
      steps: 0,
      _fpsAccum: 0,
      _fpsFrames: 0,
    };

    this._wireTimeEvents();
  }

  _wireTimeEvents() {
    this.ctx.bus.on('time:hitstop', (p) => {
      // Hitstop is expressed in seconds by callers; convert to whole sim steps and
      // take the longest request rather than summing, so a multi-hit frame does not
      // stack into a visible freeze.
      const steps = Math.round((p?.duration ?? 0.05) * SIM_HZ);
      this._hitstopSteps = Math.max(this._hitstopSteps, steps);
    });
    this.ctx.bus.on('time:slowmo', (p) => {
      this._slowmo.scale = clamp(p?.scale ?? 0.3, 0.05, 1);
      this._slowmo.steps = Math.round((p?.duration ?? 0.5) * SIM_HZ);
    });
  }

  /**
   * @param {{name:string, order?:number, init?:Function, fixed?:Function,
   *          frame?:Function, resize?:Function, dispose?:Function}} mod
   */
  register(mod) {
    if (this._byName.has(mod.name)) {
      throw new Error(`[engine] duplicate module "${mod.name}"`);
    }
    mod.order = mod.order ?? 50;
    this.modules.push(mod);
    this._byName.set(mod.name, mod);
    this.modules.sort((a, b) => a.order - b.order);
    return this;
  }

  get(name) {
    return this._byName.get(name);
  }

  async init() {
    for (const m of this.modules) {
      if (m.init) await m.init(this.ctx);
    }
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const m of this.modules) {
      if (m.resize) m.resize(this.ctx, w, h);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._rafId = requestAnimationFrame(loop);
      this.tick(now);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /** One wall-clock tick: catch up the simulation, then render once. */
  tick(now) {
    const t0 = performance.now();

    // Clamp the wall delta so a background tab or a breakpoint does not cause the
    // simulation to try to catch up across many seconds at once.
    let wall = (now - this._lastTime) / 1000;
    this._lastTime = now;
    if (!(wall > 0)) wall = 0;
    wall = Math.min(wall, 0.25);

    // Time dilation
    let scale = 1;
    if (this._hitstopSteps > 0) {
      scale = 0;
    } else if (this._slowmo.steps > 0) {
      scale = this._slowmo.scale;
    }
    this.ctx.time.scale = scale;

    this._accumulator += wall * scale;

    // Hitstop and slow-motion still need to burn down in real time, otherwise a
    // scale of 0 would freeze the game forever.
    if (this._hitstopSteps > 0) {
      this._hitstopSteps -= Math.max(1, Math.round(wall * SIM_HZ));
      if (this._hitstopSteps < 0) this._hitstopSteps = 0;
    } else if (this._slowmo.steps > 0) {
      this._slowmo.steps -= Math.max(1, Math.round(wall * SIM_HZ));
      if (this._slowmo.steps < 0) this._slowmo.steps = 0;
    }

    let steps = 0;
    const simStart = performance.now();
    while (this._accumulator >= SIM_DT && steps < MAX_SUB) {
      this._accumulator -= SIM_DT;
      this.fixedStep();
      steps++;
    }
    // If we blew the sub-step budget we are running behind; drop the backlog rather
    // than entering a death spiral where each frame owes more than the last.
    if (steps >= MAX_SUB) this._accumulator = 0;

    const simMs = performance.now() - simStart;

    this.ctx.time.alpha = this._accumulator / SIM_DT;
    this.ctx.time.dt = wall;
    this.ctx.time.frame++;

    for (const m of this.modules) {
      if (m.frame) m.frame(this.ctx, wall, this.ctx.time.alpha);
    }

    const frameMs = performance.now() - t0;
    const s = this.stats;
    s.steps = steps;
    s.simMs += (simMs - s.simMs) * 0.1;
    s.frameMs += (frameMs - s.frameMs) * 0.1;
    s._fpsAccum += wall;
    s._fpsFrames++;
    if (s._fpsAccum >= 0.25) {
      s.fps = s._fpsFrames / s._fpsAccum;
      s._fpsAccum = 0;
      s._fpsFrames = 0;
    }
  }

  /** Advance the simulation by exactly one SIM_DT. */
  fixedStep() {
    this.stepIndex++;
    this.ctx.time.elapsed += SIM_DT;
    this.ctx.input.sample(this.stepIndex);
    for (const m of this.modules) {
      if (m.fixed) m.fixed(this.ctx, SIM_DT);
    }
  }

  /**
   * Deterministically advance `n` simulation steps and render one frame, ignoring
   * wall-clock time entirely. This is what the automated capture harness drives, so
   * that a screenshot taken at step N is byte-reproducible across runs.
   *
   * `present = false` runs the whole thing without ever compositing. The harness
   * needs it to SEARCH the timeline — finding the frame in which the player is
   * mid-dash means testing every few steps, and under software WebGL a full post
   * chain per test wedges the page long enough for the screenshot to time out. The
   * simulation and every frame-integrated system still run; only the draw is skipped.
   */
  advanceDeterministic(n, stepsPerFrame = 2, present = true) {
    // Frames are interleaved with simulation steps rather than run once at the end.
    //
    // Running N steps and then a single frame starves every system that integrates
    // on frame time — camera follow, procedural animation, particles, motion-blur
    // velocity. The result was captures where the player had crossed the arena while
    // the camera had barely moved, which made every screenshot a picture of a bug
    // that does not exist during real play.
    //
    // Intermediate frames update state but do not present: `ctx.time.present` tells
    // the render module to skip the actual composite, so catching up costs module
    // logic rather than a full post chain per step.
    let remaining = n;
    while (remaining > 0) {
      const k = Math.min(stepsPerFrame, remaining);
      for (let i = 0; i < k; i++) this.fixedStep();
      remaining -= k;

      const dt = k * SIM_DT;
      this.ctx.time.alpha = 0;
      this.ctx.time.dt = dt;
      this.ctx.time.frame++;
      this.ctx.time.present = present && remaining <= 0;
      for (const m of this.modules) {
        if (m.frame) m.frame(this.ctx, dt, 0);
      }
    }
    this.ctx.time.present = true;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (let i = this.modules.length - 1; i >= 0; i--) {
      const m = this.modules[i];
      if (m.dispose) m.dispose(this.ctx);
    }
    this.ctx.input.dispose();
    this.ctx.bus.clear();
    this.modules.length = 0;
    this._byName.clear();
  }
}
