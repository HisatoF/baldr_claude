/**
 * Physics tuning constants.
 *
 * Everything here is a *feel* number, not a physical one. The brief is arcade weight:
 * a mech should feel heavy on landing, snappy in the air, and should never float like a
 * rigid-body ragdoll. Numbers are in world units (1 unit = 1 metre) and seconds.
 *
 * Other modules may read from here, but must not write to it.
 */

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** ARCHITECTURE §8: deliberately arcade-heavy, not 9.81. */
export const GRAVITY = -38;

/**
 * Falling uses more gravity than rising. This is the oldest trick in the platformer
 * book: the rise reads as a committed, readable arc, the fall reads as weight.
 */
export const FALL_GRAVITY_MULT = 1.28;

/** Fallback when the world module has not published bounds yet. */
export const DEFAULT_BOUNDS = Object.freeze({ minX: -120, maxX: 120, minY: 0, maxY: 60 });

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/**
 * Coyote time — how many sim steps after leaving the ground an entity still reports
 * `grounded`. 10 steps at 120Hz = 83ms, the usual forgiving-but-not-cheaty window.
 * It also stops `grounded` from strobing when running over noisy terrain.
 */
export const COYOTE_STEPS = 10;
/** Coyote only applies while the entity is still close to the surface. */
export const COYOTE_HEIGHT = 1.25;
/** Snap distance: within this of the ground while descending, we just land. */
export const GROUND_SNAP = 0.06;

// ---------------------------------------------------------------------------
// Landing / bouncing
// ---------------------------------------------------------------------------

/** Downward speed above which a landing is "hard" (dust, shake, audio). */
export const HARD_LAND_SPEED = 22;
/** Downward speed above which a *launched* entity bounces instead of sticking. */
export const BOUNCE_MIN_SPEED = 13;
/** Below this rebound speed the bounce is swallowed and the body comes to rest. */
export const BOUNCE_STOP_SPEED = 3.2;
/** Each successive bounce keeps this fraction of the previous restitution. */
export const BOUNCE_DECAY = 0.55;
/** Horizontal speed retained through a bounce — the tumble/slide. */
export const TUMBLE_FRICTION = 0.74;
/** Ground friction applied to a launched body sliding to rest (per second, exp). */
export const TUMBLE_DRAG = 3.4;
/** Precomputed BOUNCE_DECAY^n so the hot path never calls Math.pow. */
export const BOUNCE_DECAY_POW = (() => {
  const t = new Float32Array(9);
  t[0] = 1;
  for (let i = 1; i < t.length; i++) t[i] = t[i - 1] * BOUNCE_DECAY;
  return t;
})();

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/** Impact speed into a wall above which we get a slam (rebound + shake + event). */
export const WALL_SLAM_SPEED = 17;
/** Fraction of speed returned by a wall slam. */
export const WALL_RESTITUTION = 0.42;
/** Vertical kick added on a slam so the body pops off the wall readably. */
export const WALL_SLAM_POP = 6.5;
/** Margin outside the playfield at which a projectile is culled. */
export const OFFSCREEN_MARGIN = 24;

// ---------------------------------------------------------------------------
// Juggle
// ---------------------------------------------------------------------------

/**
 * Anti-infinite measure. Each launch in an unbroken juggle chain is worth
 * JUGGLE_DECAY^n of the base launch power, floored at JUGGLE_MIN_SCALE, and gravity is
 * scaled up so the victim returns to the ground sooner. This is exactly the
 * "gravity scaling" every serious 3D action game ships.
 */
export const JUGGLE_DECAY = 0.78;
export const JUGGLE_MIN_SCALE = 0.3;
/** Extra gravity per juggle, additive on gravityScale. */
export const JUGGLE_GRAVITY_PER = 0.11;
export const JUGGLE_GRAVITY_MAX = 0.75;
/** Beyond this the launcher gives no vertical at all, only knockback. */
export const JUGGLE_HARD_CAP = 9;
/** Horizontal share of launch power. */
export const LAUNCH_LATERAL = 0.34;
/** Precomputed JUGGLE_DECAY^n. */
export const JUGGLE_DECAY_POW = (() => {
  const t = new Float32Array(JUGGLE_HARD_CAP + 2);
  t[0] = 1;
  for (let i = 1; i < t.length; i++) {
    t[i] = t[i - 1] * JUGGLE_DECAY;
    if (t[i] < JUGGLE_MIN_SCALE) t[i] = JUGGLE_MIN_SCALE;
  }
  return t;
})();

// ---------------------------------------------------------------------------
// Knockback
// ---------------------------------------------------------------------------

/** Reference mass. Knockback is scaled by REF_MASS / mass. */
export const REF_MASS = 6;
/** A body already in hitstun takes slightly less knockback, so combos stay on-screen. */
export const HITSTUN_KNOCKBACK_SCALE = 0.82;
/** Bosses and other poise-armoured bodies resist. */
export const ARMOUR_KNOCKBACK_SCALE = 0.22;
/** Hard ceiling on a single knockback so nothing gets fired out of the level. */
export const MAX_KNOCKBACK_SPEED = 78;

// ---------------------------------------------------------------------------
// Soft separation
// ---------------------------------------------------------------------------

/** Bodies do not resolve as solids, they gently shoulder each other apart. */
export const SEPARATION_ACCEL = 46;
/** Never accelerate a body apart faster than this. */
export const SEPARATION_MAX_SPEED = 9;

// ---------------------------------------------------------------------------
// Broadphase grid
// ---------------------------------------------------------------------------

/**
 * Uniform spatial hash. The playfield is x∈[-120,120], y∈[0,60]; the grid is padded
 * well past that so anything in flight still lands in a real cell.
 *
 * Cell size 6 is a little larger than a mech (4u tall, ~1.8u wide) so a typical body
 * touches 1–4 cells, and a projectile touches 1. That keeps both the rebuild cost and
 * the per-query candidate count near their theoretical minimum.
 */
export const CELL_SIZE = 6;
export const GRID_MIN_X = -168;
export const GRID_MIN_Y = -36;
export const GRID_W = 56; // covers x ∈ [-168, 168]
export const GRID_H = 24; // covers y ∈ [-36, 108]
export const GRID_CELLS = GRID_W * GRID_H;

/** Hard caps. Exceeding them degrades gracefully rather than allocating. */
export const MAX_ENTITIES = 2048;
export const MAX_GRID_ITEMS = 16384;
export const MAX_QUERY_RESULTS = 256;
/** Per-entity memory of who it already hit, for piercing projectiles. */
export const RECENT_HIT_SLOTS = 8;

/** Ray marching resolution when a raycast tests terrain occlusion. */
export const RAY_TERRAIN_STEP = 2.0;
export const RAY_TERRAIN_MAX_SAMPLES = 96;
/** Samples used to find where a projectile's swept segment crosses the terrain. */
export const SWEEP_TERRAIN_SAMPLES = 5;
export const SWEEP_TERRAIN_REFINE = 5;

// ---------------------------------------------------------------------------
// Per-kind spawn defaults
// ---------------------------------------------------------------------------

/**
 * Defaults applied by `spawn()` when the descriptor omits a field. Frozen so nobody
 * accidentally tunes the whole game by writing through an entity.
 *
 * Drag coefficients are exponential rates per second: v *= exp(-k*dt).
 *  - `dragAir`   horizontal drag while airborne. High on mechs: air movement is
 *                controlled and does not accumulate momentum across a whole arc.
 *  - `dragGround` horizontal drag while grounded (friction).
 *  - `stopDecel` additional constant deceleration on the ground when nothing is
 *                driving the body, so it comes to a crisp stop instead of oozing.
 *  - `dragY`     vertical drag. Deliberately tiny — falls should feel heavy.
 */
export const KIND_DEFAULTS = Object.freeze({
  player: Object.freeze({
    archetype: 'player',
    sizeX: 0.9,
    sizeY: 2.0, // 4 units tall, per ARCHITECTURE §8
    mass: 8,
    gravityScale: 1,
    dragAir: 1.9,
    dragGround: 6.5,
    dragY: 0.05,
    stopDecel: 34,
    maxSpeedX: 96,
    maxSpeedY: 72,
    maxFallSpeed: 76,
    restitution: 0.26,
    team: 0,
    hp: 1000,
    poise: 120,
    separation: 0.3,
    targetable: true,
    ccd: false,
    ttl: -1,
    flags: 0,
    z: 0,
  }),
  enemy: Object.freeze({
    archetype: 'grunt',
    sizeX: 0.85,
    sizeY: 1.7,
    mass: 6,
    gravityScale: 1,
    dragAir: 1.5,
    dragGround: 5.5,
    dragY: 0.05,
    stopDecel: 18,
    maxSpeedX: 78,
    maxSpeedY: 70,
    maxFallSpeed: 74,
    restitution: 0.34,
    team: 1,
    hp: 100,
    poise: 40,
    separation: 1,
    targetable: true,
    ccd: false,
    ttl: -1,
    flags: 0,
    z: 0,
  }),
  projectile: Object.freeze({
    archetype: 'bullet',
    sizeX: 0.22,
    sizeY: 0.22,
    mass: 0.4,
    gravityScale: 0,
    dragAir: 0,
    dragGround: 0,
    dragY: 0,
    stopDecel: 0,
    maxSpeedX: 480,
    maxSpeedY: 480,
    maxFallSpeed: 480,
    restitution: 0,
    team: 2,
    hp: 1,
    poise: 1,
    separation: 0,
    targetable: false,
    ccd: true, // swept every step — see Collision.sweep()
    ttl: 600, // 5s failsafe so a leaked projectile can never accumulate
    flags: 0,
    z: 0,
  }),
  prop: Object.freeze({
    archetype: 'prop',
    sizeX: 1,
    sizeY: 1,
    mass: 40,
    gravityScale: 1,
    dragAir: 0.2,
    dragGround: 7,
    dragY: 0,
    stopDecel: 40,
    maxSpeedX: 60,
    maxSpeedY: 60,
    maxFallSpeed: 74,
    restitution: 0.2,
    team: 2,
    hp: 50,
    poise: 20,
    separation: 0,
    targetable: false,
    ccd: false,
    ttl: -1,
    flags: 0,
    z: 0,
  }),
});
