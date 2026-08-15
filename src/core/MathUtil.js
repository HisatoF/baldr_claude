/** Allocation-free math helpers. Everything here is safe to call inside fixed/frame. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const smoothstep = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Map v from [a0,a1] onto [b0,b1] without clamping. */
export const remap = (v, a0, a1, b0, b1) => b0 + ((v - a0) / (a1 - a0)) * (b1 - b0);

/**
 * Framerate-independent exponential smoothing.
 * `rate` is the fraction of the remaining distance covered per second.
 */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Shortest signed angular difference from a to b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}

/** Move a toward b by at most maxDelta. */
export function moveToward(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

export const len2 = (x, y) => Math.sqrt(x * x + y * y);
export const lenSq2 = (x, y) => x * x + y * y;
export const dist2 = (ax, ay, bx, by) => len2(bx - ax, by - ay);
export const distSq2 = (ax, ay, bx, by) => lenSq2(bx - ax, by - ay);

/** AABB overlap test on half-extents. */
export function aabbOverlap(ax, ay, ahx, ahy, bx, by, bhx, bhy) {
  return Math.abs(ax - bx) <= ahx + bhx && Math.abs(ay - by) <= ahy + bhy;
}

/** Swept-segment vs AABB, used for fast projectiles. Returns t in [0,1] or -1. */
export function segmentAabb(x0, y0, x1, y1, bx, by, bhx, bhy) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let tmin = 0;
  let tmax = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (Math.abs(x0 - bx) > bhx) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (bx - bhx - x0) * inv;
    let t2 = (bx + bhx - x0) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (Math.abs(y0 - by) > bhy) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (by - bhy - y0) * inv;
    let t2 = (by + bhy - y0) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Classic ease curves for animation and camera work.
 * All take and return t in [0,1].
 */
export const Ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = TAU / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};
