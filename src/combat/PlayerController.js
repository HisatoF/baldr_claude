import { clamp, damp, sign, moveToward } from '../core/MathUtil.js';
import { Flags } from '../core/Flags.js';

/**
 * Player movement.
 *
 * The feel target is a heavy machine with light feet: it takes a moment to get
 * moving, but a dash is instantaneous and total. Almost every value here is tuned
 * against that sentence rather than against physical realism.
 *
 * All timings are in fixed sim steps (120/s), so they are frame-rate independent.
 */

export const MOVE = {
  runSpeed: 23,
  runAccel: 150,
  runAccelAir: 62,
  groundFriction: 15,
  airDrag: 1.4,
  turnBoost: 2.1, // extra acceleration when reversing — kills the "ice" feel

  jumpSpeed: 19.5,
  jumpCutMult: 0.44, // release early -> shorter hop
  doubleJumpSpeed: 17,
  coyoteSteps: 8,
  jumpBufferSteps: 10,

  dashSpeed: 54,
  dashSteps: 20, // ~0.17s
  dashStartupSteps: 2, // anticipation — sells the weight
  dashRecoverySteps: 7,
  dashInvulnSteps: 12,
  dashCost: 21,
  airDashCost: 26,
  maxAirDashes: 2,

  hoverAccel: 46, // upward accel while hovering
  hoverCostPerSec: 34,
  hoverMaxSpeed: 12,

  enMax: 100,
  enRegen: 38, // per second
  enRegenDelaySteps: 62,
};

export class PlayerController {
  constructor(entity, bus) {
    this.e = entity;
    this.bus = bus;

    this.en = MOVE.enMax;
    this.enLockSteps = 0;

    this.state = 'idle'; // idle | run | jump | fall | dash | hover | land
    this.dashSteps = 0;
    this.dashDirX = 0;
    this.dashDirY = 0;
    this.dashPhase = 'none'; // startup | active | recovery
    this.airDashes = 0;
    this.jumpsUsed = 0;
    this.coyote = 0;
    this.wasGrounded = false;

    // Visual channels the animator and the post stack read.
    this.dashIntensity = 0;
    this.hoverAmount = 0;
    this.landImpact = 0;
    this.speedNorm = 0;
  }

  get isDashing() {
    return this.dashPhase === 'active';
  }

  /** @param {number} dt always SIM_DT */
  step(ctx, dt) {
    const e = this.e;
    const input = ctx.input;

    // --- energy ------------------------------------------------------------
    if (this.enLockSteps > 0) this.enLockSteps--;
    else if (this.en < MOVE.enMax) {
      this.en = Math.min(MOVE.enMax, this.en + MOVE.enRegen * dt);
    }

    // --- ground bookkeeping ------------------------------------------------
    if (e.grounded) {
      this.coyote = MOVE.coyoteSteps;
      this.airDashes = 0;
      this.jumpsUsed = 0;
      if (!this.wasGrounded) {
        // Landing: impact scales with fall speed and feeds shake + dust.
        const impact = clamp(-e.vel.y / 34, 0, 1);
        this.landImpact = impact;
        if (impact > 0.22) {
          ctx.bus.emit('camera:shake', { intensity: impact * 0.55, duration: 0.2, freq: 30 });
          ctx.vfx?.burst?.('smoke', e.pos.x, e.pos.y, { amount: impact });
          ctx.audio?.play?.('land', { gain: 0.4 + impact * 0.6, x: e.pos.x });
        }
      }
    } else if (this.coyote > 0) {
      this.coyote--;
    }
    this.wasGrounded = e.grounded;
    this.landImpact = damp(this.landImpact, 0, 9, dt);

    // --- dash --------------------------------------------------------------
    if (this.dashPhase !== 'none') {
      this._stepDash(ctx, dt);
      return;
    }

    const ax = input.axis.x;
    const ay = input.axis.y;

    if (input.buffer('dash', 6) && this._canDash(e)) {
      input.consume('dash');
      this._beginDash(ctx, ax, ay);
      return;
    }

    // --- horizontal --------------------------------------------------------
    const target = ax * MOVE.runSpeed;
    const accelBase = e.grounded ? MOVE.runAccel : MOVE.runAccelAir;
    // Reversing gets extra authority so direction changes feel crisp rather than
    // like sliding to a stop first.
    const reversing = ax !== 0 && sign(ax) !== sign(e.vel.x) && Math.abs(e.vel.x) > 1;
    const accel = accelBase * (reversing ? MOVE.turnBoost : 1);

    if (ax !== 0) {
      e.vel.x = moveToward(e.vel.x, target, accel * dt);
      e.faceDir = sign(ax);
    } else if (e.grounded) {
      e.vel.x = moveToward(e.vel.x, 0, MOVE.groundFriction * dt * 10);
    } else {
      e.vel.x = damp(e.vel.x, 0, MOVE.airDrag, dt);
    }

    // --- jump --------------------------------------------------------------
    const canGroundJump = e.grounded || this.coyote > 0;
    if (input.buffer('jump', MOVE.jumpBufferSteps)) {
      if (canGroundJump) {
        input.consume('jump');
        e.vel.y = MOVE.jumpSpeed;
        this.coyote = 0;
        this.jumpsUsed = 1;
        e.grounded = false;
        ctx.audio?.play?.('thruster', { gain: 0.5, x: e.pos.x });
      } else if (this.jumpsUsed < 2) {
        input.consume('jump');
        e.vel.y = MOVE.doubleJumpSpeed;
        this.jumpsUsed = 2;
        ctx.vfx?.burst?.('smoke', e.pos.x, e.pos.y, { amount: 0.4 });
        ctx.audio?.play?.('thruster', { gain: 0.62, x: e.pos.x });
      }
    }
    // Variable jump height: releasing early cuts the rise.
    if (input.released('jump') && e.vel.y > 0) e.vel.y *= MOVE.jumpCutMult;

    // --- hover -------------------------------------------------------------
    let hovering = false;
    if (!e.grounded && input.down('jump') && this.jumpsUsed >= 2 && this.en > 0) {
      const cost = MOVE.hoverCostPerSec * dt;
      if (this.en >= cost) {
        this.en -= cost;
        this.enLockSteps = MOVE.enRegenDelaySteps;
        if (e.vel.y < MOVE.hoverMaxSpeed) e.vel.y += MOVE.hoverAccel * dt;
        hovering = true;
        if (this.en <= 0) ctx.bus.emit('boost:depleted', {});
      }
    }
    this.hoverAmount = damp(this.hoverAmount, hovering ? 1 : 0, 12, dt);
    this.dashIntensity = damp(this.dashIntensity, 0, 8, dt);

    // --- state for the animator -------------------------------------------
    this.speedNorm = clamp(Math.abs(e.vel.x) / MOVE.runSpeed, 0, 1);
    if (!e.grounded) this.state = hovering ? 'hover' : e.vel.y > 0 ? 'jump' : 'fall';
    else this.state = Math.abs(e.vel.x) > 1.2 ? 'run' : 'idle';
  }

  _canDash(e) {
    if (e.grounded) return this.en >= MOVE.dashCost;
    return this.airDashes < MOVE.maxAirDashes && this.en >= MOVE.airDashCost;
  }

  _beginDash(ctx, ax, ay) {
    const e = this.e;
    const grounded = e.grounded;

    // With no stick input, dash the way we are facing. Ground dashes stay flat —
    // a mech should not launch itself skyward just because the stick drifted up.
    let dx = ax;
    let dy = grounded ? 0 : ay;
    if (dx === 0 && dy === 0) {
      dx = e.faceDir;
      dy = 0;
    }
    const m = Math.hypot(dx, dy) || 1;
    this.dashDirX = dx / m;
    this.dashDirY = dy / m;

    this.en -= grounded ? MOVE.dashCost : MOVE.airDashCost;
    this.enLockSteps = MOVE.enRegenDelaySteps;
    if (!grounded) this.airDashes++;
    if (this.en <= 0) ctx.bus.emit('boost:depleted', {});

    this.dashPhase = 'startup';
    this.dashSteps = MOVE.dashStartupSteps;
    if (dx !== 0) e.faceDir = sign(dx);

    this.state = 'dash';
    ctx.bus.emit('player:dashed', {
      kind: grounded ? 'ground' : 'air',
      dir: { x: this.dashDirX, y: this.dashDirY },
    });
  }

  _stepDash(ctx, dt) {
    const e = this.e;
    this.dashSteps--;

    if (this.dashPhase === 'startup') {
      // Anticipation: brake hard and crouch before the burst. Two steps of stillness
      // is what makes the launch afterwards read as violent.
      e.vel.x = damp(e.vel.x, 0, 24, dt);
      e.vel.y = damp(e.vel.y, 0, 24, dt);
      e.flags |= Flags.NO_GRAVITY;
      if (this.dashSteps <= 0) {
        this.dashPhase = 'active';
        this.dashSteps = MOVE.dashSteps;
        e.vel.x = this.dashDirX * MOVE.dashSpeed;
        e.vel.y = this.dashDirY * MOVE.dashSpeed;
        e.invuln = Math.max(e.invuln, MOVE.dashInvulnSteps);
        this.dashIntensity = 1;
        ctx.vfx?.trailBurst?.(e);
        ctx.audio?.play?.('dash', { gain: 0.8, x: e.pos.x });
        ctx.render?.setDashIntensity?.(1);
      }
      return;
    }

    if (this.dashPhase === 'active') {
      e.flags |= Flags.NO_GRAVITY;
      // Hold the dash velocity flat rather than letting drag eat it, so the dash
      // covers a predictable distance the player can build combos around.
      e.vel.x = this.dashDirX * MOVE.dashSpeed;
      e.vel.y = this.dashDirY * MOVE.dashSpeed;
      if (this.dashSteps <= 0) {
        this.dashPhase = 'recovery';
        this.dashSteps = MOVE.dashRecoverySteps;
      }
      return;
    }

    // recovery: gravity returns and the burst bleeds off
    e.flags &= ~Flags.NO_GRAVITY;
    e.vel.x = damp(e.vel.x, this.dashDirX * MOVE.runSpeed * 0.6, 9, dt);
    e.vel.y = damp(e.vel.y, 0, 5, dt);
    this.dashIntensity = damp(this.dashIntensity, 0, 6, dt);
    if (this.dashSteps <= 0) {
      this.dashPhase = 'none';
      this.state = e.grounded ? 'idle' : 'fall';
    }
  }
}
