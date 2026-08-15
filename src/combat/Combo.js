import { getWeapon, weaponDuration } from './Weapons.js';
import { clamp } from '../core/MathUtil.js';

/**
 * The combo system — the part of this game that matters most.
 *
 * A weapon action runs startup -> active -> recovery. Normally you are locked until
 * recovery ends. Two things break that lock:
 *
 *   1. reaching `cancelAt` inside recovery, and
 *   2. landing a hit, which opens the window immediately (hit-cancel).
 *
 * Hit-cancel is the whole game. It means chains only flow while you are connecting,
 * so a combo is a reward for accuracy rather than a memorised button sequence. Whiff
 * and you eat the full recovery.
 *
 * Damage scales down as the chain grows so that a single looping link is never the
 * optimal strategy; variety pays more than repetition.
 */

const RANKS = [
  { at: 0, name: 'D' },
  { at: 5, name: 'C' },
  { at: 12, name: 'B' },
  { at: 22, name: 'A' },
  { at: 36, name: 'S' },
  { at: 55, name: 'SS' },
];

/** Seconds the chain survives without a new hit. */
const COMBO_WINDOW = 1.35;

export class ComboSystem {
  constructor(owner, loadout) {
    this.owner = owner;
    this.loadout = loadout;

    this.action = null; // active WeaponDef
    this.phase = 'idle'; // startup | active | recovery
    this.steps = 0; // steps left in the current phase
    this.canCancel = false;
    this.firedThisAction = false;
    this.hitThisAction = false;

    this.count = 0;
    this.damage = 0;
    this.timeLeft = 0;
    this.rank = 'D';

    /** per-weapon cooldown timers, in steps */
    this.cooldowns = new Map();
    /** consecutive uses of the same weapon, for spread/scaling */
    this.lastWeaponId = null;
    this.streak = 0;
  }

  get busy() {
    return this.action !== null;
  }

  /** Damage multiplier for the current chain length. */
  get scaling() {
    // Flat for the first few hits, then a gentle decay to a 35% floor.
    if (this.count < 4) return 1;
    return clamp(1 - (this.count - 4) * 0.028, 0.35, 1);
  }

  /** Called by combat when a hit from the current action connects. */
  onHitLanded(damage) {
    this.hitThisAction = true;
    this.count++;
    this.damage += damage;
    this.timeLeft = COMBO_WINDOW;

    let r = RANKS[0].name;
    for (const k of RANKS) if (this.count >= k.at) r = k.name;
    const changed = r !== this.rank;
    this.rank = r;

    // Landing a hit opens the cancel window immediately, whatever phase we are in.
    this.canCancel = true;
    return changed;
  }

  /** @returns {string|null} weapon id the player is asking for this step */
  _requestedWeapon(input, grounded) {
    const bank = grounded ? this.loadout.ground : this.loadout.air;
    for (let i = 0; i < 4; i++) {
      const action = `w${i + 1}`;
      if (input.buffer(action, 8)) {
        const id = bank[i];
        if (id) return { id, action };
      }
    }
    return null;
  }

  step(ctx, dt) {
    const input = ctx.input;
    const owner = this.owner;

    // --- cooldowns ---------------------------------------------------------
    for (const [k, v] of this.cooldowns) {
      if (v <= 1) this.cooldowns.delete(k);
      else this.cooldowns.set(k, v - 1);
    }

    // --- combo timer -------------------------------------------------------
    if (this.timeLeft > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.end(ctx);
    }

    // --- advance the current action ---------------------------------------
    if (this.action) {
      this.steps--;

      if (this.phase === 'startup' && this.steps <= 0) {
        this.phase = 'active';
        this.steps = this.action.active;
        this._discharge(ctx);
      } else if (this.phase === 'active' && this.steps <= 0) {
        this.phase = 'recovery';
        this.steps = this.action.recovery;
      } else if (this.phase === 'recovery') {
        if (!this.canCancel && this.action.recovery - this.steps >= this.action.cancelAt) {
          this.canCancel = true;
        }
        if (this.steps <= 0) {
          this.action = null;
          this.phase = 'idle';
          this.canCancel = false;
        }
      }
    }

    // --- start / chain a weapon -------------------------------------------
    const req = this._requestedWeapon(input, owner.grounded);
    if (!req) return;
    if (this.action && !this.canCancel) return;

    const w = getWeapon(req.id);
    if (!w) return;
    if (this.cooldowns.has(w.id)) return;

    const pc = ctx.combat.controller;
    if (w.en > 0 && pc && pc.en < w.en) return;

    input.consume(req.action);
    this._begin(ctx, w, pc);
  }

  _begin(ctx, w, pc) {
    if (pc && w.en > 0) {
      pc.en -= w.en;
      pc.enLockSteps = Math.max(pc.enLockSteps, 40);
    }

    this.action = w;
    this.phase = 'startup';
    this.steps = w.startup;
    this.canCancel = false;
    this.firedThisAction = false;
    this.hitThisAction = false;

    this.streak = w.id === this.lastWeaponId ? this.streak + 1 : 0;
    this.lastWeaponId = w.id;
    w._streak = this.streak;

    this.cooldowns.set(w.id, w.cooldown);
  }

  /** The frame the weapon actually comes out. */
  _discharge(ctx) {
    const w = this.action;
    const owner = this.owner;
    if (!w || this.firedThisAction) return;
    this.firedThisAction = true;

    // Aim at the lock target when there is one, otherwise straight ahead.
    let dx = owner.faceDir;
    let dy = 0;
    const t = ctx.combat.lockTarget;
    if (t && !w.blade) {
      const ax = t.pos.x - owner.pos.x;
      const ay = t.pos.y - owner.pos.y;
      const m = Math.hypot(ax, ay);
      if (m > 0.001) {
        dx = ax / m;
        dy = ay / m;
      }
    }

    const origin = w.fire(ctx, owner, dx, dy) || { ox: owner.pos.x, oy: owner.pos.y };

    ctx.bus.emit('weapon:fired', {
      weaponId: w.id,
      slot: w.slot,
      origin: { x: origin.ox, y: origin.oy },
      dir: { x: dx, y: dy },
    });

    ctx.combat.animator?.addRecoil?.(w.recoil ?? 0.2);
    ctx.combat.charLight?.pulse?.((w.recoil ?? 0.2) * 0.6);
    ctx.audio?.play?.(w.id, { gain: 0.8, x: owner.pos.x });

    if (w.shake) {
      ctx.bus.emit('camera:shake', { intensity: w.shake * 0.5, duration: 0.14, freq: 34 });
    }
  }

  end(ctx) {
    if (this.count > 0) {
      ctx.bus.emit('combo:ended', {
        count: this.count,
        damage: Math.round(this.damage),
        rank: this.rank,
      });
    }
    this.count = 0;
    this.damage = 0;
    this.rank = 'D';
    this.timeLeft = 0;
  }
}
