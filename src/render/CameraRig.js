import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtil.js';
import { valueNoise1 } from './post/Noise.js';

/**
 * Quarter-view camera rig.
 *
 * The camera sits on +Z looking down the -Z axis at the XY playfield with a slight
 * downward pitch, per ARCHITECTURE §8. On top of that it does four jobs:
 *
 *  **Lead.** It never centres the player. The focus point is pushed ahead along the
 *  player's velocity (with a longer horizontal lead than vertical, because the
 *  playfield is a corridor) so that during a dash the player sits in the trailing
 *  third of the frame and you can see what you are dashing *into*. The lead itself
 *  is smoothed separately from the follow, so reversing direction swings the frame
 *  rather than snapping it.
 *
 *  **Framerate-independent damping.** Everything uses `damp()`; the follow rate
 *  rises with tracking error so the camera is lazy for small movements and
 *  aggressive when the player is about to leave the frame.
 *
 *  **Breathing FOV.** Dashes punch the FOV out (the world widens, speed reads);
 *  heavy hits punch it in (the frame lurches toward the impact). Both are damped
 *  and additive.
 *
 *  **Additive trauma shake.** `shake()` pushes an event into a fixed-size pool.
 *  Each event's contribution is `amp * (1 - t/dur)²` — quadratic decay, so shake
 *  dies out smoothly instead of stopping dead — driven through band-limited value
 *  noise at the event's own frequency. Contributions sum, so a hit landing during
 *  an explosion genuinely adds. Shake drives roll and position, never the focus
 *  point, so the shake cannot fight the follow.
 *
 * The rig owns no allocation at frame time.
 */

const MAX_SHAKES = 12;

const DEFAULT_BOUNDS = { minX: -120, maxX: 120, minY: 0, maxY: 60 };

export class CameraRig {
  constructor(camera, opts = {}) {
    this.camera = camera;

    // --- framing -----------------------------------------------------------
    this.baseFov = opts.fov ?? 46;
    this.baseDist = opts.dist ?? 42; // camera z
    this.height = opts.height ?? 6.2; // how far above the focus the camera sits
    this.focusYOffset = opts.focusYOffset ?? 2.6; // aim a little above the mech's feet

    // --- follow / lead -----------------------------------------------------
    this.leadTime = opts.leadTime ?? 0.34; // seconds of velocity to look ahead
    this.maxLeadX = opts.maxLeadX ?? 16;
    this.maxLeadY = opts.maxLeadY ?? 7;
    this.followRate = opts.followRate ?? 6.5;
    this.leadRate = opts.leadRate ?? 3.2;

    // --- state -------------------------------------------------------------
    this.target = null;
    this.focusX = 0;
    this.focusY = 8;
    this.leadX = 0;
    this.leadY = 0;
    this.camX = 0;
    this.camY = 8;
    this.camZ = this.baseDist;
    this.prevCamX = 0;
    this.prevCamY = 8;

    this.fov = this.baseFov;
    this.fovDash = 0;
    this.fovPunch = 0;
    this.roll = 0;

    this.dashIntensity = 0;
    this._speed = 0;

    this.bounds = DEFAULT_BOUNDS;
    this.boundsMarginX = opts.boundsMarginX ?? 0;
    this.floorSlack = opts.floorSlack ?? 11; // how far below minY we may show
    this.ceilSlack = opts.ceilSlack ?? 18;

    // --- shake pool (fixed size, never allocates) --------------------------
    this._shakes = new Array(MAX_SHAKES);
    for (let i = 0; i < MAX_SHAKES; i++) {
      this._shakes[i] = { active: false, amp: 0, t: 0, dur: 0, freq: 0, seed: 0 };
    }
    this._shakeCursor = 0;
    this._shakeSeed = 1;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeRoll = 0;

    // --- derived per-frame values other systems read -----------------------
    this.viewHalfW = 30;
    this.viewHalfH = 17;
    this.velUvX = 0;
    this.velUvY = 0;

    this._lookTarget = new THREE.Vector3();
    this._firstFrame = true;
  }

  /** @param {object|null} entity gameplay entity with pos/prev/vel, or null */
  setTarget(entity) {
    this.target = entity || null;
    if (entity) {
      this._firstFrame = true;
    }
  }

  /** Optional world bounds; falls back to the corridor from ARCHITECTURE §8. */
  setBounds(b) {
    if (!b) return;
    this.bounds = {
      minX: b.minX ?? DEFAULT_BOUNDS.minX,
      maxX: b.maxX ?? DEFAULT_BOUNDS.maxX,
      minY: b.minY ?? DEFAULT_BOUNDS.minY,
      maxY: b.maxY ?? DEFAULT_BOUNDS.maxY,
    };
  }

  /**
   * Additive trauma shake.
   * @param {number} intensity 0..1-ish. 0.2 = light tap, 1.0 = boss landing.
   * @param {number} duration  seconds
   * @param {number} freq      Hz of the underlying noise; high = sharp/metallic,
   *                           low = heavy/lumbering.
   */
  shake(intensity, duration = 0.28, freq = 26) {
    if (!(intensity > 0)) return;
    // Reuse the weakest slot if the pool is saturated, so a burst of small hits
    // can never drown out a big one.
    let slot = -1;
    let weakest = Infinity;
    for (let i = 0; i < MAX_SHAKES; i++) {
      const s = this._shakes[i];
      if (!s.active) {
        slot = i;
        break;
      }
      const remaining = s.amp * (1 - s.t / s.dur);
      if (remaining < weakest) {
        weakest = remaining;
        slot = i;
      }
    }
    if (slot < 0) return;
    const s = this._shakes[slot];
    if (s.active && weakest > intensity) return; // everything active is stronger
    s.active = true;
    s.amp = clamp(intensity, 0, 2.5);
    s.t = 0;
    s.dur = Math.max(0.05, duration);
    s.freq = Math.max(1, freq);
    s.seed = (this._shakeSeed = (this._shakeSeed * 1103515245 + 12345) & 0x7fffffff) % 4096;
  }

  /** Punch the FOV inward — used for heavy landed hits. */
  punchIn(amount) {
    this.fovPunch = Math.min(this.fovPunch + amount, 6);
  }

  // ---------------------------------------------------------------------------

  /**
   * @param {number} dt      wall seconds
   * @param {number} alpha   0..1 interpolation between prev and current sim state
   * @param {number} elapsed sim seconds (deterministic; drives the shake noise)
   */
  update(dt, alpha, elapsed) {
    const cam = this.camera;
    const t = this.target;

    // ---- 1. resolve the focus point ---------------------------------------
    let px = this.focusX;
    let py = this.focusY - this.focusYOffset;
    let vx = 0;
    let vy = 0;
    if (t && t.pos) {
      const prev = t.prev || t.pos;
      px = lerp(prev.x, t.pos.x, alpha);
      py = lerp(prev.y, t.pos.y, alpha);
      if (t.vel) {
        vx = t.vel.x;
        vy = t.vel.y;
      }
    }

    this._speed = Math.sqrt(vx * vx + vy * vy);

    // ---- 2. lead the velocity ---------------------------------------------
    const wantLeadX = clamp(vx * this.leadTime, -this.maxLeadX, this.maxLeadX);
    // Vertical lead is deliberately weaker and asymmetric: falling should reveal
    // the ground, rising should not immediately dump the ground off-screen.
    const wantLeadY = clamp(vy * this.leadTime * (vy < 0 ? 0.55 : 0.4), -this.maxLeadY, this.maxLeadY);
    this.leadX = damp(this.leadX, wantLeadX, this.leadRate, dt);
    this.leadY = damp(this.leadY, wantLeadY, this.leadRate, dt);

    const wantX = px + this.leadX;
    const wantY = py + this.focusYOffset + this.leadY;

    if (this._firstFrame) {
      this.focusX = wantX;
      this.focusY = wantY;
      this.leadX = wantLeadX;
      this.leadY = wantLeadY;
      this._firstFrame = false;
    }

    // ---- 3. error-proportional follow -------------------------------------
    // A constant damping rate either feels sluggish during a dash or twitchy at
    // walking pace. Scaling the rate by tracking error gives both.
    const errX = Math.abs(wantX - this.focusX);
    const errY = Math.abs(wantY - this.focusY);
    const rateX = this.followRate * (1 + smoothstep(errX / 14) * 2.4);
    const rateY = this.followRate * 0.85 * (1 + smoothstep(errY / 10) * 2.6);
    this.focusX = damp(this.focusX, wantX, rateX, dt);
    this.focusY = damp(this.focusY, wantY, rateY, dt);

    // ---- 4. dash intensity + breathing FOV --------------------------------
    // Speed alone is not a dash, but it is a good continuous proxy; the discrete
    // dash pulse is added on top by the module listening to `player:dashed`.
    const speedNorm = clamp01((this._speed - 26) / 44);
    this.dashIntensity = damp(this.dashIntensity, speedNorm, this.dashIntensity < speedNorm ? 18 : 5, dt);

    this.fovDash = damp(this.fovDash, this.dashIntensity * 5.5, 9, dt);
    this.fovPunch = damp(this.fovPunch, 0, 7, dt);
    this.fov = this.baseFov + this.fovDash - this.fovPunch;

    // ---- 5. camera placement ----------------------------------------------
    const wantCamZ = this.baseDist + this.dashIntensity * 1.6;
    this.camZ = damp(this.camZ, wantCamZ, 6, dt);

    let cx = this.focusX;
    let cy = this.focusY + this.height;

    // ---- 6. clamp so we never see past the playfield -----------------------
    const fovRad = this.fov * (Math.PI / 180);
    this.viewHalfH = Math.tan(fovRad * 0.5) * this.camZ;
    this.viewHalfW = this.viewHalfH * cam.aspect;

    const b = this.bounds;
    const spanX = b.maxX - b.minX;
    const halfW = this.viewHalfW + this.boundsMarginX;
    if (spanX > halfW * 2) {
      cx = clamp(cx, b.minX + halfW, b.maxX - halfW);
    } else {
      cx = (b.minX + b.maxX) * 0.5;
    }

    const minCamY = b.minY - this.floorSlack + this.viewHalfH;
    const maxCamY = b.maxY + this.ceilSlack - this.viewHalfH;
    cy = maxCamY > minCamY ? clamp(cy, minCamY, maxCamY) : (minCamY + maxCamY) * 0.5;

    // ---- 7. shake ----------------------------------------------------------
    this._updateShake(dt, elapsed);

    // ---- 8. screen-space camera velocity for the motion-blur pass ----------
    // Converted to uv units so the shader does not need to know world scale.
    // Convert to a velocity, then multiply by a fixed shutter time.
    //
    // Using the raw per-frame displacement made the blur a function of FRAMERATE:
    // at 10fps the camera travels ten times as far between frames as at 100fps, so
    // the whole image smeared into a wash exactly when the machine could least
    // afford to look bad. A real shutter is a duration, so express it as one and the
    // streak length becomes identical at any framerate.
    const SHUTTER_SECONDS = 1 / 110;
    const invDt = dt > 1e-5 ? 1 / dt : 0;
    const dxWorld = (cx - this.prevCamX) * invDt * SHUTTER_SECONDS;
    const dyWorld = (cy - this.prevCamY) * invDt * SHUTTER_SECONDS;
    this.velUvX = clamp(dxWorld / (this.viewHalfW * 2), -0.05, 0.05);
    this.velUvY = clamp(-dyWorld / (this.viewHalfH * 2), -0.05, 0.05);
    this.prevCamX = cx;
    this.prevCamY = cy;

    // ---- 9. commit ---------------------------------------------------------
    this.camX = cx;
    this.camY = cy;

    cam.position.set(cx + this.shakeX, cy + this.shakeY, this.camZ);
    this._lookTarget.set(this.focusX + this.shakeX * 0.35, this.focusY + this.shakeY * 0.35, 0);
    cam.lookAt(this._lookTarget);
    cam.rotation.z += this.roll + this.shakeRoll;

    if (Math.abs(cam.fov - this.fov) > 1e-4) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  _updateShake(dt, elapsed) {
    let ox = 0;
    let oy = 0;
    let or = 0;
    for (let i = 0; i < MAX_SHAKES; i++) {
      const s = this._shakes[i];
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.dur) {
        s.active = false;
        continue;
      }
      // Quadratic trauma decay.
      const k = 1 - s.t / s.dur;
      const trauma = s.amp * k * k;
      const phase = elapsed * s.freq;
      ox += valueNoise1(phase + s.seed) * trauma;
      oy += valueNoise1(phase + s.seed + 137.7) * trauma;
      or += valueNoise1(phase * 0.8 + s.seed + 311.3) * trauma;
    }
    // Amplitudes are in world units at the focal plane; roll in radians.
    this.shakeX = ox * 1.35;
    this.shakeY = oy * 1.05;
    this.shakeRoll = or * 0.016;
  }

  /** True while any shake is still contributing. */
  get shaking() {
    for (let i = 0; i < MAX_SHAKES; i++) if (this._shakes[i].active) return true;
    return false;
  }
}
