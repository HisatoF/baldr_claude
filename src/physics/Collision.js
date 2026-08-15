/**
 * Collision: terrain resolution, a uniform-grid broadphase, queries, raycasts, and
 * continuous (swept) collision for fast projectiles.
 *
 * ---------------------------------------------------------------------------
 * BROADPHASE DESIGN — uniform spatial hash, counting-sort layout
 * ---------------------------------------------------------------------------
 * The grid is a fixed 56x24 lattice of 6-unit cells covering x∈[-168,168],
 * y∈[-36,108]; anything beyond that clamps into an edge cell, so the structure can
 * never index out of range no matter what a stray velocity does.
 *
 * It is rebuilt from scratch every step with a two-pass counting sort into three
 * preallocated typed arrays:
 *
 *   pass 1   for each entity, compute the cell range its AABB covers and bump
 *            `_counts[cell]`; remember the range in `_cx0.._cy1` so pass 2 is free.
 *   prefix   `_starts[c+1] = _starts[c] + _counts[c]`  (exclusive prefix sum)
 *   pass 2   write the entity's *index in `entities`* into `_items` at the cell cursor.
 *
 * The result is a fully packed bucket list with no per-cell arrays, no linked lists,
 * and no allocation of any kind — the only writes are into Int32Arrays that were
 * sized once at construction.
 *
 * Cost: rebuild is O(N·c + C) where c is cells-per-entity (1 for a projectile, 1–4 for
 * a mech) and C = 1344 is the fixed prefix-sum length. For the stated load — several
 * hundred projectiles and a few dozen enemies — that is ~1k array writes plus a 1344
 * -element scan, tens of microseconds. A query is O(cells touched + candidates in
 * them), which for a weapon hitbox is 1–4 cells. Compare to the O(N²) brute force it
 * replaces: 600 entities would be 180k pair tests per step.
 *
 * Duplicate suppression (an entity registered in several of the cells a query touches)
 * uses a monotonic stamp array rather than a Set: `_stamp[i] === _stampVal` is an O(1)
 * membership test that costs nothing to reset — the counter simply increments.
 *
 * ---------------------------------------------------------------------------
 * ZERO ALLOCATION
 * ---------------------------------------------------------------------------
 * Nothing in this file allocates after construction. Query results are written into
 * caller-supplied arrays; raycast and sweep results are written into reused record
 * objects that the caller must consume before the next call.
 */
import { Flags } from '../core/Flags.js';
import { segmentAabb } from '../core/MathUtil.js';
import {
  CELL_SIZE,
  GRID_MIN_X,
  GRID_MIN_Y,
  GRID_W,
  GRID_H,
  GRID_CELLS,
  MAX_ENTITIES,
  MAX_GRID_ITEMS,
  MAX_QUERY_RESULTS,
  RECENT_HIT_SLOTS,
  COYOTE_STEPS,
  COYOTE_HEIGHT,
  GROUND_SNAP,
  SEPARATION_ACCEL,
  SEPARATION_MAX_SPEED,
  RAY_TERRAIN_STEP,
  RAY_TERRAIN_MAX_SAMPLES,
  SWEEP_TERRAIN_SAMPLES,
  SWEEP_TERRAIN_REFINE,
} from './Tuning.js';

/** Filter modes for the shared candidate walk. */
export const FILTER_ALL = 0;
export const FILTER_HOSTILE = 1;
export const FILTER_TARGETS = 2;

const MAX_SWEEP_HITS = 12;
const NEUTRAL = 2;

/** Mirrors core/Flags.isHostile, but on raw team numbers so we never touch objects. */
function hostile(entityTeam, queryTeam) {
  return entityTeam !== queryTeam && entityTeam !== NEUTRAL && queryTeam !== NEUTRAL;
}

function cellXOf(x) {
  let c = ((x - GRID_MIN_X) / CELL_SIZE) | 0;
  if (c < 0) c = 0;
  else if (c >= GRID_W) c = GRID_W - 1;
  return c;
}

function cellYOf(y) {
  let c = ((y - GRID_MIN_Y) / CELL_SIZE) | 0;
  if (c < 0) c = 0;
  else if (c >= GRID_H) c = GRID_H - 1;
  return c;
}

export class CollisionSystem {
  constructor() {
    // --- broadphase storage ---
    this._counts = new Int32Array(GRID_CELLS);
    this._starts = new Int32Array(GRID_CELLS + 1);
    this._cursor = new Int32Array(GRID_CELLS);
    this._items = new Int32Array(MAX_GRID_ITEMS);
    this._cx0 = new Int16Array(MAX_ENTITIES);
    this._cy0 = new Int16Array(MAX_ENTITIES);
    this._cx1 = new Int16Array(MAX_ENTITIES);
    this._cy1 = new Int16Array(MAX_ENTITIES);
    this._live = new Uint8Array(MAX_ENTITIES);

    this._stamp = new Int32Array(MAX_ENTITIES);
    this._stampVal = 0;

    /** Entities currently indexed. Set by rebuild(); read by every query. */
    this._entities = null;
    this._count = 0;
    this._itemCount = 0;
    this._overflowed = false;
    this._occupiedCells = 0;

    // --- world hookup ---
    this._world = null;

    // --- reusable results ---
    this._ray = { entity: null, t: 0, point: { x: 0, y: 0 }, normal: { x: 0, y: 0 }, terrain: false };
    this._hit = {
      projectile: null,
      target: null,
      t: 0,
      dist: 0,
      point: { x: 0, y: 0 },
      normal: { x: 0, y: 0 },
      terrain: false,
    };
    this._sweepEnt = new Array(MAX_SWEEP_HITS).fill(null);
    this._sweepT = new Float64Array(MAX_SWEEP_HITS);
    this._scratchOut = new Array(MAX_QUERY_RESULTS).fill(null);

    /**
     * Called synchronously for every swept impact, with the reused `_hit` record.
     * Set once at init — never a per-step closure.
     * @type {((hit:object) => void)|null}
     */
    this.onHit = null;

    this.stats = { items: 0, occupied: 0, queries: 0, candidates: 0, sweeps: 0, hits: 0 };
  }

  setWorld(world) {
    this._world = world;
  }

  /**
   * Terrain height at x. Falls back to the ground plane at y=0 while the world module
   * is still a stub, so physics is usable before world exists.
   */
  groundHeightAt(x) {
    const w = this._world;
    if (w !== null && w !== undefined && typeof w.groundHeightAt === 'function') {
      const h = w.groundHeightAt(x);
      return h === h ? h : 0; // NaN guard
    }
    return 0;
  }

  // =========================================================================
  // Broadphase
  // =========================================================================

  /**
   * Rebuild the spatial hash from the live entity array. O(N·c + C), allocation-free.
   * @param {Array<object>} entities dense live array (post-integration positions)
   */
  rebuild(entities) {
    this._entities = entities;
    const n = entities.length;
    this._count = n;

    const counts = this._counts;
    counts.fill(0);

    const cx0 = this._cx0;
    const cy0 = this._cy0;
    const cx1 = this._cx1;
    const cy1 = this._cy1;
    const live = this._live;

    let total = 0;
    this._overflowed = false;

    // --- pass 1: count ---
    for (let i = 0; i < n; i++) {
      const e = entities[i];
      if ((e.flags & Flags.DEAD) !== 0) {
        live[i] = 0;
        continue;
      }
      const ax0 = cellXOf(e.pos.x - e.size.x);
      const ay0 = cellYOf(e.pos.y - e.size.y);
      const ax1 = cellXOf(e.pos.x + e.size.x);
      const ay1 = cellYOf(e.pos.y + e.size.y);
      const span = (ax1 - ax0 + 1) * (ay1 - ay0 + 1);
      if (total + span > MAX_GRID_ITEMS) {
        // Degrade gracefully: the entity stays simulated, it just is not indexed.
        this._overflowed = true;
        live[i] = 0;
        continue;
      }
      total += span;
      live[i] = 1;
      cx0[i] = ax0;
      cy0[i] = ay0;
      cx1[i] = ax1;
      cy1[i] = ay1;
      for (let cy = ay0; cy <= ay1; cy++) {
        const row = cy * GRID_W;
        for (let cx = ax0; cx <= ax1; cx++) counts[row + cx]++;
      }
    }

    // --- prefix sum ---
    const starts = this._starts;
    const cursor = this._cursor;
    let acc = 0;
    let occupied = 0;
    for (let c = 0; c < GRID_CELLS; c++) {
      starts[c] = acc;
      cursor[c] = acc;
      const k = counts[c];
      if (k !== 0) occupied++;
      acc += k;
    }
    starts[GRID_CELLS] = acc;
    this._itemCount = acc;
    this._occupiedCells = occupied;

    // --- pass 2: scatter ---
    const items = this._items;
    for (let i = 0; i < n; i++) {
      if (live[i] === 0) continue;
      const ax0 = cx0[i];
      const ay0 = cy0[i];
      const ax1 = cx1[i];
      const ay1 = cy1[i];
      for (let cy = ay0; cy <= ay1; cy++) {
        const row = cy * GRID_W;
        for (let cx = ax0; cx <= ax1; cx++) {
          const c = row + cx;
          items[cursor[c]++] = i;
        }
      }
    }

    this.stats.items = acc;
    this.stats.occupied = occupied;
    this.stats.candidates = 0;
    this.stats.queries = 0;
    this.stats.sweeps = 0;
    this.stats.hits = 0;
  }

  /** Number of entities registered in a cell — used by the debug overlay. */
  cellOccupancy(cx, cy) {
    const c = cy * GRID_W + cx;
    return this._starts[c + 1] - this._starts[c];
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /**
   * AABB broadphase. Writes matching entities into `out` and returns the count.
   *
   * `team` is the *querier's* team, and results are the entities hostile to it, using
   * the same rule as core/Flags.isHostile (team 2 = neutral is hostile to nobody).
   * Pass `null` or a negative number to disable team filtering entirely.
   *
   * `out` should be a preallocated array; at most MAX_QUERY_RESULTS entries are
   * written and the array is never grown beyond that.
   *
   * @param {number} x centre x
   * @param {number} y centre y
   * @param {number} hx half-extent x
   * @param {number} hy half-extent y
   * @param {number|null} team querier team, or null/-1 for "everything"
   * @param {Array} out preallocated result array
   * @param {number} [mode] FILTER_* — defaults to hostile when a team is given
   * @returns {number} count written into `out`
   */
  query(x, y, hx, hy, team, out, mode) {
    const entities = this._entities;
    if (entities === null) return 0;
    const useTeam = team !== null && team !== undefined && team >= 0;
    const filter = mode !== undefined ? mode : useTeam ? FILTER_HOSTILE : FILTER_ALL;

    const ax0 = cellXOf(x - hx);
    const ay0 = cellYOf(y - hy);
    const ax1 = cellXOf(x + hx);
    const ay1 = cellYOf(y + hy);

    const stamp = this._stamp;
    const s = ++this._stampVal;
    const items = this._items;
    const starts = this._starts;

    let count = 0;
    let candidates = 0;

    for (let cy = ay0; cy <= ay1; cy++) {
      const row = cy * GRID_W;
      for (let cx = ax0; cx <= ax1; cx++) {
        const c = row + cx;
        const end = starts[c + 1];
        for (let k = starts[c]; k < end; k++) {
          const i = items[k];
          if (stamp[i] === s) continue;
          stamp[i] = s;
          candidates++;
          const e = entities[i];
          if ((e.flags & Flags.DEAD) !== 0) continue;
          if (useTeam && !hostile(e.team, team)) continue;
          if (filter === FILTER_TARGETS) {
            if (!e.targetable) continue;
            if (e.invuln > 0) continue;
          }
          // narrow phase
          if (Math.abs(e.pos.x - x) > hx + e.size.x) continue;
          if (Math.abs(e.pos.y - y) > hy + e.size.y) continue;
          out[count++] = e;
          if (count >= MAX_QUERY_RESULTS) {
            this.stats.queries++;
            this.stats.candidates += candidates;
            return count;
          }
        }
      }
    }
    this.stats.queries++;
    this.stats.candidates += candidates;
    return count;
  }

  /** Every live entity overlapping the box, ignoring teams. */
  queryAll(x, y, hx, hy, out) {
    return this.query(x, y, hx, hy, null, out, FILTER_ALL);
  }

  /** Hostile, targetable, non-invulnerable entities — what a weapon hitbox wants. */
  queryTargets(x, y, hx, hy, team, out) {
    return this.query(x, y, hx, hy, team, out, FILTER_TARGETS);
  }

  /** Everything overlapping `e`'s own AABB, excluding `e`. */
  overlapEntity(e, team, out) {
    const n = this.query(e.pos.x, e.pos.y, e.size.x, e.size.y, team, out);
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (out[i] !== e) out[w++] = out[i];
    }
    return w;
  }

  // =========================================================================
  // Raycast
  // =========================================================================

  /**
   * Cast a ray and return the nearest hit, or null.
   *
   * Traversal is Amanatides–Woo DDA over the same grid: we walk the cells the ray
   * actually crosses instead of testing its bounding box, so a long horizontal
   * line-of-sight query costs O(cells along the ray), not O(everything in between).
   * Because `segmentAabb` tests the whole segment at once, an entity only ever needs
   * testing once (stamped), and we stop as soon as the cell we are entering starts
   * beyond the best hit found so far.
   *
   * @param {number} x0
   * @param {number} y0
   * @param {number} dx direction x (need not be normalised)
   * @param {number} dy direction y
   * @param {number} maxDist
   * @param {number|null} team querier team; hostiles are hit, null/-1 hits everything
   * @param {boolean} [includeTerrain] also test terrain occlusion (default true)
   * @returns {{entity:object|null, t:number, point:{x,y}, normal:{x,y}, terrain:boolean}|null}
   *   `t` is the distance along the ray in world units. `entity === null` with
   *   `terrain === true` means the ray was blocked by the ground — which is exactly
   *   what an AI line-of-sight check wants to know. The record is reused between
   *   calls; copy anything you need to keep.
   */
  raycast(x0, y0, dx, dy, maxDist, team, includeTerrain) {
    const entities = this._entities;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 1e-9) || !(maxDist > 0)) return null;
    const nx = dx / len;
    const ny = dy / len;
    const x1 = x0 + nx * maxDist;
    const y1 = y0 + ny * maxDist;

    const useTeam = team !== null && team !== undefined && team >= 0;

    let bestT = Infinity; // in world units along the ray
    let bestEnt = null;

    if (entities !== null && this._count > 0) {
      const stamp = this._stamp;
      const s = ++this._stampVal;
      const items = this._items;
      const starts = this._starts;

      let cx = cellXOf(x0);
      let cy = cellYOf(y0);
      const ecx = cellXOf(x1);
      const ecy = cellYOf(y1);

      const stepX = nx > 0 ? 1 : nx < 0 ? -1 : 0;
      const stepY = ny > 0 ? 1 : ny < 0 ? -1 : 0;

      // Distance (in ray units) to the next cell boundary on each axis.
      let tMaxX = Infinity;
      let tDeltaX = Infinity;
      if (stepX !== 0) {
        const bx = GRID_MIN_X + (stepX > 0 ? cx + 1 : cx) * CELL_SIZE;
        tMaxX = (bx - x0) / nx;
        tDeltaX = CELL_SIZE / Math.abs(nx);
        if (tMaxX < 0) tMaxX = 0;
      }
      let tMaxY = Infinity;
      let tDeltaY = Infinity;
      if (stepY !== 0) {
        const by = GRID_MIN_Y + (stepY > 0 ? cy + 1 : cy) * CELL_SIZE;
        tMaxY = (by - y0) / ny;
        tDeltaY = CELL_SIZE / Math.abs(ny);
        if (tMaxY < 0) tMaxY = 0;
      }

      const maxIter = GRID_W + GRID_H + 2;
      let cellEntry = 0;
      for (let iter = 0; iter < maxIter; iter++) {
        if (cellEntry > bestT) break;

        const c = cy * GRID_W + cx;
        const end = starts[c + 1];
        for (let k = starts[c]; k < end; k++) {
          const i = items[k];
          if (stamp[i] === s) continue;
          stamp[i] = s;
          const e = entities[i];
          if ((e.flags & Flags.DEAD) !== 0) continue;
          if (useTeam && !hostile(e.team, team)) continue;
          if (useTeam && !e.targetable) continue;
          const t = segmentAabb(x0, y0, x1, y1, e.pos.x, e.pos.y, e.size.x, e.size.y);
          if (t < 0 || t > 1) continue;
          const d = t * maxDist;
          if (d < bestT) {
            bestT = d;
            bestEnt = e;
          }
        }

        if (cx === ecx && cy === ecy) break;
        if (tMaxX < tMaxY) {
          cellEntry = tMaxX;
          cx += stepX;
          tMaxX += tDeltaX;
          if (cx < 0 || cx >= GRID_W) break;
        } else {
          cellEntry = tMaxY;
          cy += stepY;
          tMaxY += tDeltaY;
          if (cy < 0 || cy >= GRID_H) break;
        }
        if (cellEntry > maxDist) break;
      }
    }

    // --- terrain occlusion ---
    let terrainT = Infinity;
    if (includeTerrain !== false) {
      terrainT = this._rayTerrain(x0, y0, nx, ny, maxDist);
    }

    const r = this._ray;
    if (terrainT < bestT) {
      r.entity = null;
      r.terrain = true;
      r.t = terrainT;
      r.point.x = x0 + nx * terrainT;
      r.point.y = y0 + ny * terrainT;
      r.normal.x = 0;
      r.normal.y = 1;
      return r;
    }
    if (bestEnt === null) return null;

    r.entity = bestEnt;
    r.terrain = false;
    r.t = bestT;
    const px = x0 + nx * bestT;
    const py = y0 + ny * bestT;
    r.point.x = px;
    r.point.y = py;
    faceNormal(px, py, bestEnt.pos.x, bestEnt.pos.y, bestEnt.size.x, bestEnt.size.y, r.normal);
    return r;
  }

  /** March the ray looking for the first sample below the terrain. */
  _rayTerrain(x0, y0, nx, ny, maxDist) {
    if (y0 - this.groundHeightAt(x0) < -1e-6) return 0; // started underground
    let samples = Math.ceil(maxDist / RAY_TERRAIN_STEP);
    if (samples > RAY_TERRAIN_MAX_SAMPLES) samples = RAY_TERRAIN_MAX_SAMPLES;
    if (samples < 1) samples = 1;
    const step = maxDist / samples;
    let prevD = maxDist;
    let prevAbove = y0 - this.groundHeightAt(x0);
    for (let i = 1; i <= samples; i++) {
      const d = step * i;
      const px = x0 + nx * d;
      const py = y0 + ny * d;
      const above = py - this.groundHeightAt(px);
      if (above <= 0) {
        // Bisect between the last above-ground sample and this one.
        let lo = d - step;
        let hi = d;
        for (let k = 0; k < 4; k++) {
          const mid = (lo + hi) * 0.5;
          const my = y0 + ny * mid;
          if (my - this.groundHeightAt(x0 + nx * mid) <= 0) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      prevD = d;
      prevAbove = above;
    }
    return Infinity;
  }

  // =========================================================================
  // Terrain resolution
  // =========================================================================

  /**
   * Resolve an entity against the terrain and maintain `grounded` / Flags.GROUNDED.
   *
   * Returns the impact speed (positive, u/s) when the entity made contact this step,
   * or -1 when it did not. The caller hands that to Response.onGroundContact, which
   * owns the *feel* of the contact (bounce, juggle reset, landing events).
   *
   * Coyote time: after leaving the ground an entity keeps reporting `grounded` for
   * COYOTE_STEPS provided it is still descending and still within COYOTE_HEIGHT of the
   * surface. That both gives the player the customary forgiveness window and stops
   * `grounded` from strobing while running across noisy terrain — which would
   * otherwise make combat flip between the ground and air weapon sets mid-combo.
   *
   * @param {object} e
   * @param {object} bounds world bounds (for the ceiling)
   * @returns {number} impact speed, or -1
   */
  resolveTerrain(e, bounds) {
    if ((e.flags & Flags.NO_COLLIDE_WORLD) !== 0) {
      if (e.grounded) {
        e.grounded = false;
        e.flags &= ~Flags.GROUNDED;
      }
      e.airSteps++;
      return -1;
    }

    // Ceiling
    const ceil = bounds.maxY;
    if (e.pos.y + e.size.y > ceil) {
      e.pos.y = ceil - e.size.y;
      if (e.vel.y > 0) e.vel.y = 0;
    }

    const gy = this.groundHeightAt(e.pos.x);
    const feet = e.pos.y - e.size.y;

    if (feet <= gy + GROUND_SNAP && e.vel.y <= 0) {
      e.pos.y = gy + e.size.y;
      const impact = -e.vel.y;
      e.grounded = true;
      e.flags |= Flags.GROUNDED;
      e.coyote = COYOTE_STEPS;
      e.airSteps = 0;
      return impact > 0 ? impact : 0;
    }

    e.airSteps++;
    if (e.coyote > 0) e.coyote--;
    const grounded = e.coyote > 0 && e.vel.y <= 0 && feet - gy < COYOTE_HEIGHT;
    e.grounded = grounded;
    if (grounded) e.flags |= Flags.GROUNDED;
    else e.flags &= ~Flags.GROUNDED;
    return -1;
  }

  // =========================================================================
  // Continuous collision (swept projectiles)
  // =========================================================================

  /**
   * Sweep every CCD entity's segment prev→pos against the world and against hostile
   * targets, nearest hit first.
   *
   * WHY THIS IS NOT OPTIONAL: at 1/120s a 200 u/s projectile advances 1.67 units per
   * step, and a 400 u/s one advances 3.33. A discrete overlap test only samples the
   * endpoint, so any target thinner than the per-step advance is passed straight
   * through — the classic bullet-through-paper. Sweeping the segment makes the test
   * independent of speed: correctness is bounded by geometry, not by timestep.
   *
   * Non-piercing projectiles stop at the first impact, are moved onto the contact
   * point (so the impact VFX spawns where the hit actually happened, not a step past
   * it) and are despawned. PIERCING projectiles report every target along the segment
   * in order and remember the last RECENT_HIT_SLOTS victims so a beam cannot re-hit
   * the same body every step.
   *
   * @param {Array<object>} entities
   * @param {(e:object)=>void} despawn
   */
  sweepAll(entities, despawn) {
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if ((e.flags & Flags.DEAD) !== 0) continue;
      if (!e.ccd) continue;
      this.sweepEntity(e, despawn);
    }
  }

  /** Sweep a single entity. Exposed so combat can sweep a bespoke projectile. */
  sweepEntity(e, despawn) {
    const x0 = e.prev.x;
    const y0 = e.prev.y;
    const x1 = e.pos.x;
    const y1 = e.pos.y;
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (dx === 0 && dy === 0) return false;

    this.stats.sweeps++;
    const piercing = (e.flags & Flags.PIERCING) !== 0;

    // --- terrain first: it can shorten the segment for everything else ---
    let terrainT = 2;
    if ((e.flags & Flags.NO_COLLIDE_WORLD) === 0) {
      terrainT = this._sweepTerrain(x0, y0, x1, y1, e.size.y);
    }

    // --- gather entity hits, insertion-sorted by t into a fixed buffer ---
    const entities = this._entities;
    let nHits = 0;
    if (entities !== null) {
      const sEnt = this._sweepEnt;
      const sT = this._sweepT;
      const stamp = this._stamp;
      const s = ++this._stampVal;
      const items = this._items;
      const starts = this._starts;

      const minX = (x0 < x1 ? x0 : x1) - e.size.x;
      const maxX = (x0 > x1 ? x0 : x1) + e.size.x;
      const minY = (y0 < y1 ? y0 : y1) - e.size.y;
      const maxY = (y0 > y1 ? y0 : y1) + e.size.y;

      const ax0 = cellXOf(minX);
      const ay0 = cellYOf(minY);
      const ax1 = cellXOf(maxX);
      const ay1 = cellYOf(maxY);

      const team = e.team;
      const ownerId = e.owner;

      for (let cy = ay0; cy <= ay1; cy++) {
        const row = cy * GRID_W;
        for (let cx = ax0; cx <= ax1; cx++) {
          const c = row + cx;
          const end = starts[c + 1];
          for (let k = starts[c]; k < end; k++) {
            const idx = items[k];
            if (stamp[idx] === s) continue;
            stamp[idx] = s;
            const t = entities[idx];
            if (t === e) continue;
            if ((t.flags & Flags.DEAD) !== 0) continue;
            if (!t.targetable) continue;
            if (t.invuln > 0) continue;
            if (t.id === ownerId) continue;
            if (!hostile(t.team, team)) continue;
            if (piercing && this._alreadyHit(e, t.id)) continue;

            // Minkowski expansion: sweeping the projectile's *centre* against a target
            // grown by the projectile's half-extents is exactly an AABB-vs-AABB sweep.
            const th = segmentAabb(
              x0,
              y0,
              x1,
              y1,
              t.pos.x,
              t.pos.y,
              t.size.x + e.size.x,
              t.size.y + e.size.y
            );
            if (th < 0 || th > 1) continue;
            if (th > terrainT) continue; // buried in the ground before reaching it

            // insertion sort into the small fixed buffer
            let ins = nHits < MAX_SWEEP_HITS ? nHits : MAX_SWEEP_HITS - 1;
            while (ins > 0 && sT[ins - 1] > th) {
              sT[ins] = sT[ins - 1];
              sEnt[ins] = sEnt[ins - 1];
              ins--;
            }
            sT[ins] = th;
            sEnt[ins] = t;
            if (nHits < MAX_SWEEP_HITS) nHits++;
          }
        }
      }
    }

    // --- terrain wins if it comes first ---
    if (terrainT <= 1 && (nHits === 0 || terrainT <= this._sweepT[0])) {
      const px = x0 + dx * terrainT;
      const py = y0 + dy * terrainT;
      e.pos.x = px;
      e.pos.y = py;
      this._emitHit(e, null, terrainT, px, py, 0, 1, true);
      if (!piercing) despawn(e);
      return true;
    }

    if (nHits === 0) return false;

    const sEnt = this._sweepEnt;
    const sT = this._sweepT;

    if (!piercing) {
      const t = sT[0];
      const target = sEnt[0];
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      e.pos.x = px;
      e.pos.y = py;
      this._normalFor(px, py, target, e);
      this._emitHit(e, target, t, px, py, this._nx, this._ny, false);
      despawn(e);
      return true;
    }

    for (let h = 0; h < nHits; h++) {
      const t = sT[h];
      const target = sEnt[h];
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      this._rememberHit(e, target.id);
      this._normalFor(px, py, target, e);
      this._emitHit(e, target, t, px, py, this._nx, this._ny, false);
      if ((e.flags & Flags.DEAD) !== 0) break; // a listener killed it
    }
    return true;
  }

  _normalFor(px, py, target, proj) {
    faceNormal(
      px,
      py,
      target.pos.x,
      target.pos.y,
      target.size.x + proj.size.x,
      target.size.y + proj.size.y,
      TMP_N
    );
    this._nx = TMP_N.x;
    this._ny = TMP_N.y;
  }

  _emitHit(proj, target, t, px, py, nx, ny, terrain) {
    this.stats.hits++;
    if (this.onHit === null) return;
    const h = this._hit;
    h.projectile = proj;
    h.target = target;
    h.t = t;
    h.dist = t * Math.sqrt(
      (proj.pos.x - proj.prev.x) * (proj.pos.x - proj.prev.x) +
        (proj.pos.y - proj.prev.y) * (proj.pos.y - proj.prev.y)
    );
    h.point.x = px;
    h.point.y = py;
    h.normal.x = nx;
    h.normal.y = ny;
    h.terrain = terrain;
    this.onHit(h);
  }

  _alreadyHit(e, id) {
    const r = e.recentHits;
    for (let i = 0; i < RECENT_HIT_SLOTS; i++) if (r[i] === id) return true;
    return false;
  }

  _rememberHit(e, id) {
    e.recentHits[e._recentHitIdx] = id;
    e._recentHitIdx = (e._recentHitIdx + 1) % RECENT_HIT_SLOTS;
  }

  /**
   * Find where the segment first crosses the terrain. Returns t∈[0,1] or 2 for "no
   * crossing". Sampled then bisected, because groundHeightAt() is an arbitrary
   * function the world module owns and cannot be inverted analytically.
   */
  _sweepTerrain(x0, y0, x1, y1, halfY) {
    const a0 = y0 - halfY - this.groundHeightAt(x0);
    if (a0 <= 0) return 0;
    const a1 = y1 - halfY - this.groundHeightAt(x1);
    let lo = 0;
    let hi = -1;
    if (a1 <= 0) {
      hi = 1;
    } else {
      // Both endpoints are above ground but the segment may still clip a ridge.
      const n = SWEEP_TERRAIN_SAMPLES;
      let prev = a0;
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const a = y0 + (y1 - y0) * t - halfY - this.groundHeightAt(x0 + (x1 - x0) * t);
        if (a <= 0) {
          lo = (i - 1) / n;
          hi = t;
          break;
        }
        prev = a;
      }
      if (hi < 0) return 2;
    }
    for (let k = 0; k < SWEEP_TERRAIN_REFINE; k++) {
      const mid = (lo + hi) * 0.5;
      const a = y0 + (y1 - y0) * mid - halfY - this.groundHeightAt(x0 + (x1 - x0) * mid);
      if (a <= 0) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  // =========================================================================
  // Soft separation
  // =========================================================================

  /**
   * Bodies do not resolve as rigid solids — that reads as stiff and can shove the
   * player through geometry. Instead overlapping bodies accelerate apart along the
   * axis of least penetration, weighted by `separation` and by relative mass. Enemies
   * therefore spread into a readable formation instead of stacking into one silhouette,
   * and the player is only lightly nudged.
   *
   * Uses the grid, and each pair is visited once (j > i, deduped by stamp).
   */
  separateAll(entities, dt) {
    const stampArr = this._stamp;
    const items = this._items;
    const starts = this._starts;
    const n = entities.length;

    for (let i = 0; i < n; i++) {
      const a = entities[i];
      if ((a.flags & Flags.DEAD) !== 0) continue;
      if (a.separation <= 0) continue;

      const s = ++this._stampVal;
      stampArr[i] = s;

      const ax0 = cellXOf(a.pos.x - a.size.x);
      const ay0 = cellYOf(a.pos.y - a.size.y);
      const ax1 = cellXOf(a.pos.x + a.size.x);
      const ay1 = cellYOf(a.pos.y + a.size.y);

      for (let cy = ay0; cy <= ay1; cy++) {
        const row = cy * GRID_W;
        for (let cx = ax0; cx <= ax1; cx++) {
          const c = row + cx;
          const end = starts[c + 1];
          for (let k = starts[c]; k < end; k++) {
            const j = items[k];
            if (j <= i) continue;
            if (stampArr[j] === s) continue;
            stampArr[j] = s;
            const b = entities[j];
            if ((b.flags & Flags.DEAD) !== 0) continue;
            if (b.separation <= 0) continue;

            const dx = b.pos.x - a.pos.x;
            const dy = b.pos.y - a.pos.y;
            const ox = a.size.x + b.size.x - (dx < 0 ? -dx : dx);
            if (ox <= 0) continue;
            const oy = a.size.y + b.size.y - (dy < 0 ? -dy : dy);
            if (oy <= 0) continue;

            // Axis of least penetration, biased toward X: in a side-on brawler two
            // mechs sliding apart horizontally reads correctly; popping one on top of
            // the other does not.
            let pushX = 0;
            let pushY = 0;
            if (ox <= oy * 1.6) {
              const dir = dx >= 0 ? 1 : -1;
              const depth = ox / (a.size.x + b.size.x);
              pushX = dir * depth * SEPARATION_ACCEL * dt;
            } else {
              const dir = dy >= 0 ? 1 : -1;
              const depth = oy / (a.size.y + b.size.y);
              pushY = dir * depth * SEPARATION_ACCEL * dt;
            }

            const ma = a.mass > 0 ? a.mass : 1;
            const mb = b.mass > 0 ? b.mass : 1;
            const total = ma + mb;
            const wa = (mb / total) * a.separation;
            const wb = (ma / total) * b.separation;

            a.vel.x = clampAbs(a.vel.x - pushX * wa * 2, SEPARATION_MAX_SPEED, a.vel.x);
            a.vel.y = clampAbs(a.vel.y - pushY * wa * 2, SEPARATION_MAX_SPEED, a.vel.y);
            b.vel.x = clampAbs(b.vel.x + pushX * wb * 2, SEPARATION_MAX_SPEED, b.vel.x);
            b.vel.y = clampAbs(b.vel.y + pushY * wb * 2, SEPARATION_MAX_SPEED, b.vel.y);
          }
        }
      }
    }
  }
}

/**
 * Separation may never *increase* speed past its own budget, but it must also never
 * clamp a body that was already moving fast for legitimate reasons (a dash, knockback).
 * So: keep the new value unless it pushed |v| beyond both the cap and the old speed.
 */
function clampAbs(next, cap, old) {
  const an = next < 0 ? -next : next;
  if (an <= cap) return next;
  const ao = old < 0 ? -old : old;
  if (an <= ao) return next;
  return old;
}

const TMP_N = { x: 0, y: 0 };

/** Outward face normal of the box at a contact point. */
function faceNormal(px, py, bx, by, bhx, bhy, out) {
  const rx = bhx > 0 ? (px - bx) / bhx : 0;
  const ry = bhy > 0 ? (py - by) / bhy : 0;
  if ((rx < 0 ? -rx : rx) >= (ry < 0 ? -ry : ry)) {
    out.x = rx >= 0 ? 1 : -1;
    out.y = 0;
  } else {
    out.x = 0;
    out.y = ry >= 0 ? 1 : -1;
  }
  return out;
}
