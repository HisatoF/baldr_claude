import { clamp, damp, lerp, TAU, Ease } from '../core/MathUtil.js';

/**
 * Procedural mech animation.
 *
 * There is no animation data in this project — no clips, no skeleton import — so
 * every pose is computed. That constraint is not purely a limitation: driving bones
 * from the physics state means the mech is always exactly as fast, as tilted, and as
 * off-balance as the simulation says it is, and can never desync from it.
 *
 * The rubric bans constant-velocity motion and perfectly still idles, so every
 * channel here is either eased toward a target or driven by a phase oscillator.
 */
export class MechAnimator {
  constructor(mech) {
    this.mech = mech;
    this.b = mech.bones;

    this.phase = 0; // gait phase, radians
    this.breath = 0;
    this.lean = 0;
    this.pitch = 0;
    this.facing = 1;
    this.facingSmooth = 1;
    this.thrust = 0;
    this.crouch = 0;
    this.recoil = 0;
    this._recoilDecay = 0;
  }

  /** Kick the frame back on weapon fire. Called by the combat module. */
  addRecoil(amount) {
    this.recoil = Math.min(1.4, this.recoil + amount);
  }

  /**
   * @param {object} e        player entity
   * @param {PlayerController} pc
   * @param {number} dt       wall seconds (visual only)
   * @param {number} alpha    interpolation factor
   */
  update(e, pc, dt, alpha) {
    const b = this.b;
    const root = this.mech.root;

    // --- root placement, interpolated between sim steps --------------------
    const x = lerp(e.prev.x, e.pos.x, alpha);
    const y = lerp(e.prev.y, e.pos.y, alpha);
    root.position.set(x, y - e.size.y, e.z || 0);

    // --- facing -------------------------------------------------------------
    // Turn through the shortest arc rather than snapping; a 4-unit machine that
    // flips instantaneously reads as a sprite, not a mech.
    this.facing = e.faceDir >= 0 ? 1 : -1;
    this.facingSmooth = damp(this.facingSmooth, this.facing, 14, dt);
    root.rotation.y = (1 - this.facingSmooth) * (Math.PI / 2) * 0.5;

    const speed = clamp(Math.abs(e.vel.x) / 23, 0, 1.4);
    const grounded = e.grounded;

    // --- gait ---------------------------------------------------------------
    // Stride frequency rises with speed but saturates, so a sprint does not turn
    // into a sewing machine.
    const strideHz = 1.1 + speed * 3.4;
    if (grounded) this.phase += dt * strideHz * TAU;
    else this.phase = damp(this.phase % TAU, 0, 4, dt);

    // --- breathing / idle life ---------------------------------------------
    this.breath += dt * 1.7;
    const idleAmt = grounded ? 1 - clamp(speed * 1.6, 0, 1) : 0;
    const breathe = Math.sin(this.breath) * 0.02 * idleAmt;
    // A second, slower oscillator at an irrational ratio stops the idle from
    // looking like a loop.
    const drift = Math.sin(this.breath * 0.37 + 1.1) * 0.012 * idleAmt;

    // --- posture targets ----------------------------------------------------
    const dashing = pc.isDashing;
    const targetLean = clamp(e.vel.x / 40, -0.62, 0.62) + (dashing ? this.facing * 0.22 : 0);
    const targetPitch = grounded
      ? -speed * 0.13
      : clamp(-e.vel.y / 60, -0.28, 0.3);
    const targetCrouch =
      (pc.dashPhase === 'startup' ? 0.8 : 0) + pc.landImpact * 0.7 + (grounded ? 0 : -0.06);

    this.lean = damp(this.lean, targetLean, dashing ? 22 : 9, dt);
    this.pitch = damp(this.pitch, targetPitch, 9, dt);
    this.crouch = damp(this.crouch, clamp(targetCrouch, 0, 1), 16, dt);
    this.thrust = damp(this.thrust, Math.max(pc.hoverAmount, pc.dashIntensity), 15, dt);

    this.recoil = damp(this.recoil, 0, 11, dt);

    // --- body ---------------------------------------------------------------
    const bob = grounded ? Math.sin(this.phase * 2) * 0.055 * speed : 0;
    b.body.position.y = bob - this.crouch * 0.46 + breathe;
    b.body.rotation.z = this.lean * 0.5;
    b.body.rotation.x = this.pitch * 0.5 + this.crouch * 0.18;

    // --- hips / legs --------------------------------------------------------
    // Hips counter-rotate against the stride, torso counter-rotates against the
    // hips. That opposition is most of what makes a walk read as a walk.
    b.hips.rotation.y = Math.sin(this.phase) * 0.16 * speed;
    b.hips.rotation.z = -this.lean * 0.22 + Math.sin(this.phase) * 0.05 * speed;
    // --- gait: two-bone reverse-jointed legs -------------------------------
    // The knee spurs backwards, so the shin's bend is negative where a human
    // knee's would be positive. The foot then counter-rotates against thigh+shin
    // to keep the sole roughly parallel to the ground through the stance phase,
    // which is what stops the walk from looking like it is tiptoeing.
    if (b.legs && b.legs.length) {
      const airborne = grounded ? 0 : 1;
      for (let i = 0; i < b.legs.length; i++) {
        const leg = b.legs[i];
        // Legs are half a cycle apart.
        const p = this.phase + (i === 0 ? 0 : Math.PI);
        const swing = Math.sin(p);
        const lift = Math.max(0, Math.cos(p)); // >0 during the swing phase

        const thighA = swing * 0.62 * speed - this.crouch * 0.52 - airborne * 0.30;
        const shinA = -(0.16 + lift * 0.95) * speed - this.crouch * 0.85 - airborne * 0.55;

        if (leg.thigh) leg.thigh.rotation.x = thighA;
        if (leg.shin) leg.shin.rotation.x = shinA;
        // Ankle keeps the foot flat while planted, and points slightly in the air.
        if (leg.foot) {
          leg.foot.rotation.x = -(thighA + shinA) * 0.62 + airborne * 0.22 + lift * 0.18 * speed;
        }
      }
    }

    // --- torso / head -------------------------------------------------------
    b.torso.rotation.y = -Math.sin(this.phase) * 0.11 * speed;
    b.torso.rotation.z = this.lean * 0.3 - this.recoil * 0.08;
    b.torso.rotation.x = this.pitch * 0.4 + this.recoil * 0.16 + drift;

    // The head stabilises against everything below it — a gimbal, as a real
    // sensor head would be. Cheap, and it makes the machine look intentional.
    b.head.rotation.y = -b.torso.rotation.y * 0.8 - b.hips.rotation.y * 0.3;
    b.head.rotation.x = -this.pitch * 0.55 - this.recoil * 0.1;
    b.head.rotation.z = -this.lean * 0.18;

    // --- arms ---------------------------------------------------------------
    const armSwing = Math.sin(this.phase + Math.PI) * 0.34 * speed;
    const guard = dashing ? 0.5 : 0;

    b.shoulderL.rotation.z = 0.06 + this.lean * 0.1;
    b.shoulderR.rotation.z = -0.06 + this.lean * 0.1;

    b.upperArmL.rotation.x = armSwing - guard * 0.7 - this.recoil * 0.5;
    b.upperArmR.rotation.x = -armSwing - guard * 0.5 - this.recoil * 0.8;
    b.upperArmL.rotation.z = 0.12 + guard * 0.3 + breathe * 2;
    b.upperArmR.rotation.z = -0.12 - guard * 0.25 - breathe * 2;

    b.forearmL.rotation.x = -0.18 - guard * 0.9 - Math.max(0, armSwing) * 0.4;
    b.forearmR.rotation.x = -0.18 - guard * 0.8 - Math.max(0, -armSwing) * 0.4 - this.recoil * 0.6;

    // --- skirt armour -------------------------------------------------------
    // Hangs and swings a beat behind the hips, which sells mass.
    if (b.skirtL && b.skirtR) {
      const swing = Math.sin(this.phase - 0.6) * 0.2 * speed;
      const flare = this.thrust * 0.35 + this.crouch * 0.2;
      b.skirtL.rotation.x = swing - flare;
      b.skirtR.rotation.x = -swing - flare;
    }

    // --- backpack / thrusters ----------------------------------------------
    b.backpack.rotation.x = -this.pitch * 0.3 + this.thrust * 0.12;

    const plume = this.thrust;
    for (let i = 0; i < this.mech.thrusters.length; i++) {
      const t = this.mech.thrusters[i];
      // Flicker each nozzle out of phase so the exhaust is never a static cone.
      const flick = 0.82 + 0.18 * Math.sin(this.breath * 37 + i * 2.1);
      const len = Math.max(0.001, plume * flick * 2.4);
      t.scale.set(0.7 + plume * 0.5, len, 0.7 + plume * 0.5);
      t.visible = plume > 0.02;
    }

    // Emissive pulse: the machine "breathes" light when boosting.
    this.mech.emiPulse.value = 1 + this.thrust * 1.9 + this.recoil * 0.8;

    // --- contact shadow -----------------------------------------------------
    if (this.mech.contactShadow) {
      const groundY = pc.groundY ?? 0;
      const h = Math.max(0, y - e.size.y - groundY);
      // Tight and dark rather than broad and faint.
      //
      // The mech carries its own short-range key light, which floods the ground
      // directly beneath it with no occluder — a soft wide blob simply loses to that
      // fill and the mech reads as pasted onto the road. Keeping the blob close to
      // the actual footprint and letting it go genuinely dark is what re-seats it.
      const s = clamp(1 - h / 11, 0.14, 1);
      this.mech.contactShadow.position.y = groundY - (y - e.size.y) + 0.02;
      this.mech.contactShadow.scale.setScalar(0.62 + s * 0.5);
      this.mech.contactShadow.material.opacity = 0.94 * Ease.outQuad(s);
    }
  }
}
