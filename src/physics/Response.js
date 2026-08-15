import { Flags } from '../core/Flags.js';
import { clamp } from '../core/MathUtil.js';
import {
  HARD_LAND_SPEED,
  BOUNCE_MIN_SPEED,
  BOUNCE_STOP_SPEED,
  BOUNCE_DECAY,
  TUMBLE_FRICTION,
  TUMBLE_DRAG,
  WALL_SLAM_SPEED,
} from './Tuning.js';

/**
 * Contact response.
 *
 * `CollisionSystem.resolveTerrain` deliberately only corrects *position* and reports
 * the impact speed; it does not touch velocity. That split exists because what should
 * happen to velocity on contact is a gameplay decision, not a geometric one — a
 * running mech stops dead, a juggled enemy bounces, a corpse tumbles.
 *
 * This module is the other half of that contract. Skipping it leaves grounded bodies
 * accumulating gravity forever, which silently corrupts everything downstream that
 * reads velocity: camera lead, motion blur, animation speed, AI aim.
 */

/**
 * @param {object} e       entity that just contacted the ground
 * @param {number} impact  downward speed at contact, >= 0
 * @param {object} ctx     engine context (for events)
 * @param {number} dt
 * @returns {number} landing severity 0..1, for VFX/audio
 */
export function resolveLanding(e, impact, ctx, dt) {
  const launched = (e.flags & Flags.LAUNCHED) !== 0;

  // --- bounce: only launched bodies, and only above a threshold -------------
  if (launched && impact > BOUNCE_MIN_SPEED) {
    const restitution = BOUNCE_DECAY / (1 + e.juggleCount * 0.35);
    const up = impact * restitution;

    if (up > BOUNCE_STOP_SPEED) {
      e.vel.y = up;
      // Bleed horizontal speed on each bounce so bodies do not skate forever.
      e.vel.x *= TUMBLE_FRICTION;
      e.grounded = false;
      e.flags &= ~Flags.GROUNDED;
      if (ctx?.bus) {
        ctx.bus.emit('fx:explosion', {
          point: { x: e.pos.x, y: e.pos.y },
          radius: 0.6,
          kind: 'dust',
        });
      }
      return clamp(impact / 40, 0, 1);
    }
  }

  // --- settle ---------------------------------------------------------------
  if (e.vel.y < 0) e.vel.y = 0;

  if (launched) {
    // Landing ends a juggle. Resetting the counter here (rather than on a timer)
    // is what makes "touch the ground to reset scaling" a readable rule.
    e.flags &= ~Flags.LAUNCHED;
    e.juggleCount = 0;
    // Tumble to rest rather than stopping instantly — an enemy that slams into the
    // road and freezes reads as a bug.
    e.vel.x -= e.vel.x * Math.min(1, TUMBLE_DRAG * dt);
  }

  return impact > 0 ? clamp(impact / HARD_LAND_SPEED, 0, 1) : 0;
}

/**
 * Keep bodies inside the playfield and convert a hard wall contact into a slam.
 * @returns {number} slam severity 0..1
 */
export function resolveBounds(e, bounds) {
  let slam = 0;

  const minX = bounds.minX + e.size.x;
  const maxX = bounds.maxX - e.size.x;

  if (e.pos.x < minX) {
    const speed = -e.vel.x;
    e.pos.x = minX;
    if (e.vel.x < 0) {
      if (speed > WALL_SLAM_SPEED) {
        slam = clamp(speed / 45, 0, 1);
        e.vel.x = speed * 0.28; // rebound
      } else {
        e.vel.x = 0;
      }
    }
  } else if (e.pos.x > maxX) {
    const speed = e.vel.x;
    e.pos.x = maxX;
    if (e.vel.x > 0) {
      if (speed > WALL_SLAM_SPEED) {
        slam = clamp(speed / 45, 0, 1);
        e.vel.x = -speed * 0.28;
      } else {
        e.vel.x = 0;
      }
    }
  }

  return slam;
}

/**
 * Launch a target upward, applying juggle decay.
 *
 * Each successive launch without touching the ground gets less height and slightly
 * more gravity. This is the standard anti-infinite measure in action games: combos
 * stay expressive, but a single launcher looped forever stops paying.
 */
export function applyLaunch(e, power, ctx) {
  if (e.flags & Flags.BOSS) {
    // Bosses do not leave the ground; poise break is their stagger instead.
    return 0;
  }
  const decay = 1 / (1 + e.juggleCount * 0.55);
  const vy = power * decay;
  e.vel.y = Math.max(e.vel.y, vy);
  e.juggleCount++;
  e.flags |= Flags.LAUNCHED;
  e.grounded = false;
  e.flags &= ~Flags.GROUNDED;
  e.gravityScale = 1 + e.juggleCount * 0.06;
  return vy;
}
