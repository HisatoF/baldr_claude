import { clamp } from '../core/MathUtil.js';
import { Flags } from '../core/Flags.js';

/**
 * Scripted pilot — attract mode, and the thing that makes automated capture honest.
 *
 * Without this, every headless screenshot shows a mech standing perfectly still,
 * because nobody is pressing keys. Reviewing those frames tells you nothing about
 * how the game looks while it is being *played*, which is the only state that
 * matters. So the pilot synthesises input: it closes distance, chains weapons,
 * dashes, and takes fights to the air.
 *
 * It writes into the raw input layer rather than bypassing it, so it exercises
 * exactly the same buffering, cancel windows and energy costs a human would. A bot
 * that called `combo.fire()` directly could produce frames no player could ever
 * reach.
 */
export class DemoPilot {
  constructor(rng) {
    this.rng = rng;
    this.enabled = true;

    this.tick = 0;
    this.holdUntil = 0;
    this.plan = 'approach';
    this.planUntil = 0;
    this.lastWeapon = 0;
    this.airTime = 0;
  }

  /** Clear every synthetic key so a released action does not stick down. */
  _clear(raw) {
    raw.left = false;
    raw.right = false;
    raw.up = false;
    raw.down = false;
    raw.jump = false;
    raw.dash = false;
    raw.w1 = false;
    raw.w2 = false;
    raw.w3 = false;
    raw.w4 = false;
  }

  step(ctx, dt) {
    if (!this.enabled) return;
    const player = ctx.combat?.player;
    if (!player || player.flags & Flags.DEAD) return;

    const raw = ctx.input._raw;
    this._clear(raw);
    this.tick++;

    const target = ctx.combat.lockTarget;
    const grounded = player.grounded;
    if (!grounded) this.airTime += dt;
    else this.airTime = 0;

    // --- pick a plan every so often ---------------------------------------
    if (this.tick > this.planUntil) {
      const r = this.rng.float();
      if (!target) this.plan = 'approach';
      else if (r < 0.40) this.plan = 'engage';
      else if (r < 0.62) this.plan = 'aerial';
      else if (r < 0.80) this.plan = 'strafe';
      else this.plan = 'burst';
      this.planUntil = this.tick + this.rng.int(90, 260);
    }

    if (!target) {
      // Nothing to fight: patrol slowly so the frame is never static.
      if (Math.sin(this.tick * 0.006) > 0) raw.right = true;
      else raw.left = true;
      return;
    }

    const dx = target.pos.x - player.pos.x;
    const dy = target.pos.y - player.pos.y;
    const dist = Math.abs(dx);
    const toward = dx > 0 ? 'right' : 'left';
    const away = dx > 0 ? 'left' : 'right';

    // --- movement ----------------------------------------------------------
    switch (this.plan) {
      case 'approach':
      case 'engage': {
        // Close to melee range, then hold it.
        if (dist > 5.5) raw[toward] = true;
        else if (dist < 2.6) raw[away] = true;
        // Dash to close large gaps rather than jogging the whole way.
        if (dist > 16 && this.tick % 34 === 0) raw.dash = true;
        break;
      }
      case 'strafe': {
        if (dist > 12) raw[toward] = true;
        else if (dist < 7) raw[away] = true;
        if (this.tick % 48 === 0) raw.dash = true;
        break;
      }
      case 'aerial': {
        // Get airborne and stay there — the air loadout is the showier one.
        if (dist > 6) raw[toward] = true;
        if (grounded || (this.airTime > 0.1 && player.vel.y < -4)) raw.jump = true;
        if (dy > 2) raw.up = true;
        break;
      }
      case 'burst': {
        if (dist > 9) raw[toward] = true;
        if (this.tick % 26 === 0) raw.dash = true;
        break;
      }
    }

    // --- weapons -----------------------------------------------------------
    // Fire on a cadence rather than every step, so chains read as deliberate
    // rather than as a held trigger.
    const combo = ctx.combat.comboSystem;
    const canAct = !combo || !combo.busy || combo.canCancel;
    if (canAct && this.tick - this.lastWeapon > 9) {
      const inMelee = dist < 5.0;
      let slot;
      if (!grounded) {
        // air: gatling / missile / saber / slam
        slot = inMelee ? (this.rng.bool(0.55) ? 'w3' : 'w4') : this.rng.bool(0.6) ? 'w1' : 'w2';
      } else {
        // ground: rifle / uppercut / saber / hammer
        if (inMelee) {
          const r = this.rng.float();
          // Favour the launcher, then convert in the air — the intended loop.
          slot = r < 0.34 ? 'w2' : r < 0.72 ? 'w3' : 'w4';
        } else {
          slot = 'w1';
        }
      }
      raw[slot] = true;
      this.lastWeapon = this.tick;
    }
  }
}
