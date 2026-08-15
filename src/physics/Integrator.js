/**
 * Semi-implicit (symplectic) Euler integration at the fixed 1/120s step.
 *
 *   v += a * dt          <- velocity first
 *   v  = drag(v)
 *   v  = clamp(v)
 *   p += v * dt          <- then position, using the *new* velocity
 *
 * Velocity-first is what makes the integrator stable under the stiff drag and the
 * heavy 38 u/s² gravity this game uses; explicit Euler would visibly gain energy on
 * a long fall.
 *
 * Everything here is arcade, not physical:
 *   - falling gravity is stronger than rising gravity, so jumps read as committed
 *     arcs on the way up and as weight on the way down;
 *   - horizontal drag is exponential and *high* in the air, so a mech's air movement
 *     is controlled rather than momentum-driven;
 *   - the ground adds a constant deceleration on top of friction so a stopped mech
 *     actually stops rather than sliding to a mathematical asymptote;
 *   - a juggled body gets extra gravity per juggle, which is the standard
 *     anti-infinite measure (see Response.launch).
 *
 * ZERO ALLOCATION. No temporaries, no closures, and the `exp()` for each entity's drag
 * is memoised on the entity so a steady-state step performs no transcendental calls.
 */
import { Flags } from '../core/Flags.js';
import { GRAVITY, FALL_GRAVITY_MULT, JUGGLE_GRAVITY_PER, JUGGLE_GRAVITY_MAX } from './Tuning.js';

/**
 * Memoised exp(-k*dt) for horizontal drag. Drag rates change rarely (a dash may zero
 * them for a few steps), so the cache hits essentially always.
 */
function dragFactorX(e, k, dt) {
  if (k <= 0) return 1;
  if (e._dk === k && e._ddt === dt) return e._df;
  e._dk = k;
  e._ddt = dt;
  e._df = Math.exp(-k * dt);
  return e._df;
}

function dragFactorY(e, k, dt) {
  if (k <= 0) return 1;
  if (e._dky === k) return e._dfy;
  e._dky = k;
  e._dfy = Math.exp(-k * dt);
  return e._dfy;
}

/**
 * Effective gravity for one entity, in u/s². Accounts for gravityScale, the
 * rise/fall asymmetry, and juggle gravity scaling.
 */
export function gravityFor(e) {
  if ((e.flags & Flags.NO_GRAVITY) !== 0) return 0;
  let gs = e.gravityScale;
  if (gs === 0) return 0;
  if ((e.flags & Flags.LAUNCHED) !== 0 && e.juggleCount > 1) {
    let bonus = (e.juggleCount - 1) * JUGGLE_GRAVITY_PER;
    if (bonus > JUGGLE_GRAVITY_MAX) bonus = JUGGLE_GRAVITY_MAX;
    gs *= 1 + bonus;
  }
  if (e.vel.y < 0) gs *= FALL_GRAVITY_MULT;
  return GRAVITY * gs;
}

/**
 * Advance one entity by dt. Writes `prev` first so `frame()` can interpolate with
 * `alpha`, then integrates. `acc` is consumed and cleared: other modules write it
 * during their own `fixed`, and physics — which runs first, at order 20 — picks it up
 * on the following step. That one-step latency is constant and therefore invisible.
 */
export function integrate(e, dt) {
  const pos = e.pos;
  const vel = e.vel;
  const acc = e.acc;

  e.prev.x = pos.x;
  e.prev.y = pos.y;

  const g = gravityFor(e);

  // A staggered/hitstunned body cannot drive itself; only gravity and the knockback
  // already in `vel` act on it. Combat still owns the hitstun counter.
  const stunned = e.hitstun > 0;
  const ax = stunned ? 0 : acc.x;
  const ay = (stunned ? 0 : acc.y) + g;

  vel.x += ax * dt;
  vel.y += ay * dt;

  // --- horizontal drag: air vs ground are separate feels ---
  const grounded = e.grounded;
  const k = grounded ? e.dragGround : e.dragAir;
  if (k > 0) vel.x *= dragFactorX(e, k, dt);

  // --- crisp ground stop ---
  // Exponential friction alone never reaches zero, which reads as a mech that oozes.
  // A constant deceleration on top of it lands the body exactly on rest.
  if (grounded && e.stopDecel > 0 && ax === 0) {
    const s = e.stopDecel * dt;
    if (vel.x > s) vel.x -= s;
    else if (vel.x < -s) vel.x += s;
    else vel.x = 0;
  }

  if (e.dragY > 0) vel.y *= dragFactorY(e, e.dragY, dt);

  // --- terminal velocity ---
  const mx = e.maxSpeedX;
  if (vel.x > mx) vel.x = mx;
  else if (vel.x < -mx) vel.x = -mx;
  if (vel.y > e.maxSpeedY) vel.y = e.maxSpeedY;
  else if (vel.y < -e.maxFallSpeed) vel.y = -e.maxFallSpeed;

  // --- position ---
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;

  acc.x = 0;
  acc.y = 0;
}

/**
 * Integrate every live entity. DEAD entities are skipped but left in place — the array
 * is never mutated here.
 * @param {Array<object>} entities
 * @param {number} dt
 */
export function integrateAll(entities, dt) {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if ((e.flags & Flags.DEAD) !== 0) continue;
    integrate(e, dt);
  }
}
