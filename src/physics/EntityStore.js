/**
 * Entity store — dense live array + slot free-list + generation counters.
 *
 * Three structures cooperate:
 *
 *   entities[]   dense, iteration order, no holes. This is what everyone loops over.
 *                Compacted exactly once per step, never mid-iteration.
 *   _slots[]     sparse, indexed by slot number, for O(1) `byId`.
 *   _pool[]      recycled entity objects, so spawning never calls `new`.
 *
 * Ids encode both slot and generation:
 *
 *     id = generation * SLOT_STRIDE + slot
 *
 * `generation` is bumped every time a slot is recycled, so an id captured before a
 * despawn can never resolve to the entity that later occupies the same slot. Because
 * the encoding is arithmetic rather than bitwise, ids stay exact well past 2^32 — with
 * a 2048-slot table that is over 4 billion recycles per slot before any risk of reuse.
 *
 * NOTE ON ALLOCATION: after `prealloc`, `spawn()` performs no allocation whatsoever —
 * no object literal, no array growth, no closure. `despawn()` and `compact()` likewise.
 */
import { Flags } from '../core/Flags.js';
import { KIND_DEFAULTS, MAX_ENTITIES, RECENT_HIT_SLOTS } from './Tuning.js';

/** Slots per generation. 2^20 comfortably exceeds MAX_ENTITIES. */
const SLOT_STRIDE = 1048576;

/**
 * Build one blank entity. Called only by the pool; every field of ARCHITECTURE §7 is
 * present from birth so the object's hidden class never changes and V8 keeps it
 * monomorphic for the life of the process.
 */
function createEntity() {
  return {
    // --- ARCHITECTURE §7 contract fields ---
    id: 0,
    kind: 'prop',
    archetype: '',
    pos: { x: 0, y: 0 },
    prev: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    acc: { x: 0, y: 0 },
    size: { x: 1, y: 1 },
    z: 0,
    mass: 1,
    gravityScale: 1,
    grounded: false,
    faceDir: 1,
    team: 2,
    hp: 1,
    hpMax: 1,
    poise: 1,
    poiseMax: 1,
    hitstun: 0,
    invuln: 0,
    juggleCount: 0,
    flags: 0,
    view: null,
    userData: {},

    // --- physics-owned extensions (documented in src/physics/index.js) ---
    gen: 0, // generation of the slot this entity currently occupies
    owner: 0, // id of the entity that created this one (projectile shooter)
    dragAir: 0, // exponential horizontal drag rate while airborne, /s
    dragGround: 0, // exponential horizontal drag rate while grounded, /s
    dragY: 0, // exponential vertical drag rate, /s
    stopDecel: 0, // constant ground deceleration toward rest, u/s²
    maxSpeedX: 480,
    maxSpeedY: 480,
    maxFallSpeed: 480,
    restitution: 0,
    coyote: 0, // sim steps of coyote-time credit remaining
    airSteps: 0, // sim steps since last ground contact
    bounceCount: 0, // bounces in the current launch
    ttl: -1, // sim steps to live, -1 = forever
    ccd: false, // sweep prev→pos against entities each step
    targetable: false, // may be returned by queryTargets() / hit by sweeps
    separation: 0, // 0..1 weight for soft body-to-body shouldering

    // --- private ---
    _slot: -1,
    _dk: -1, // cached drag rate for the memoised exp()
    _df: 1, // cached exp(-_dk*dt)
    _ddt: 0, // dt the cache was built for
    _dky: -1,
    _dfy: 1,
    recentHits: new Int32Array(RECENT_HIT_SLOTS),
    _recentHitIdx: 0,
  };
}

/** Wipe an object's own keys without `delete` (which would deoptimise the shape). */
function wipeUserData(o) {
  for (const k in o) o[k] = undefined;
}

export class EntityStore {
  /**
   * @param {number} prealloc entity objects to build up front
   */
  constructor(prealloc = 640) {
    /** Live entities. Dense, no holes, no DEAD entries after compaction. */
    this.entities = [];

    this._slots = new Array(MAX_ENTITIES).fill(null);
    this._slotGen = new Int32Array(MAX_ENTITIES).fill(1);
    this._freeSlots = [];
    this._nextSlot = 0;

    this._pool = [];
    /** How many entity objects have ever been constructed. Used by the self-test. */
    this.everAllocated = 0;
    /** Set to a Bus by the module so despawns can be announced. */
    this.bus = null;
    /** Reused despawn payload — listeners must not retain it. */
    this._despawnPayload = { entity: null };

    this.deadCount = 0;
    this.spawnRejects = 0;

    for (let i = 0; i < prealloc; i++) {
      this._pool.push(createEntity());
      this.everAllocated++;
    }
    // Pre-size the free-slot list's backing store so pushes never reallocate mid-step.
    for (let i = 0; i < MAX_ENTITIES; i++) this._freeSlots.push(0);
    this._freeSlots.length = 0;
  }

  get liveCount() {
    return this.entities.length;
  }

  /**
   * Create an entity from a partial descriptor. Every field of ARCHITECTURE §7 is
   * filled from the per-kind defaults in Tuning.js unless the descriptor overrides it.
   *
   * Position/velocity accept either `{pos:{x,y}}` or the flat `{x,y}` shorthand;
   * half-extents accept `{size:{x,y}}` or `{hx,hy}`.
   *
   * @param {object} desc
   * @returns {object|null} the entity, or null if the store is full
   */
  spawn(desc) {
    if (this.entities.length >= MAX_ENTITIES) {
      this.spawnRejects++;
      return null;
    }

    const d = desc || EMPTY_DESC;
    const kind = d.kind !== undefined ? d.kind : 'prop';
    const K = KIND_DEFAULTS[kind] !== undefined ? KIND_DEFAULTS[kind] : KIND_DEFAULTS.prop;

    let slot;
    if (this._freeSlots.length > 0) slot = this._freeSlots.pop();
    else slot = this._nextSlot++;

    let e;
    if (this._pool.length > 0) {
      e = this._pool.pop();
    } else {
      e = createEntity();
      this.everAllocated++;
    }

    const gen = this._slotGen[slot];
    e._slot = slot;
    e.gen = gen;
    e.id = gen * SLOT_STRIDE + slot;

    e.kind = kind;
    e.archetype = d.archetype !== undefined ? d.archetype : K.archetype;

    const px = d.x !== undefined ? d.x : d.pos !== undefined ? d.pos.x : 0;
    const py = d.y !== undefined ? d.y : d.pos !== undefined ? d.pos.y : 0;
    e.pos.x = px;
    e.pos.y = py;
    // prev must start equal to pos or the first rendered frame interpolates from
    // wherever the recycled object happened to be.
    e.prev.x = px;
    e.prev.y = py;

    e.vel.x = d.vx !== undefined ? d.vx : d.vel !== undefined ? d.vel.x : 0;
    e.vel.y = d.vy !== undefined ? d.vy : d.vel !== undefined ? d.vel.y : 0;
    e.acc.x = 0;
    e.acc.y = 0;

    e.size.x = d.hx !== undefined ? d.hx : d.size !== undefined ? d.size.x : K.sizeX;
    e.size.y = d.hy !== undefined ? d.hy : d.size !== undefined ? d.size.y : K.sizeY;

    e.z = d.z !== undefined ? d.z : K.z;
    e.mass = d.mass !== undefined ? d.mass : K.mass;
    e.gravityScale = d.gravityScale !== undefined ? d.gravityScale : K.gravityScale;
    e.grounded = false;
    e.faceDir = d.faceDir !== undefined ? d.faceDir : 1;
    e.team = d.team !== undefined ? d.team : K.team;

    e.hpMax = d.hpMax !== undefined ? d.hpMax : d.hp !== undefined ? d.hp : K.hp;
    e.hp = d.hp !== undefined ? d.hp : e.hpMax;
    e.poiseMax = d.poiseMax !== undefined ? d.poiseMax : d.poise !== undefined ? d.poise : K.poise;
    e.poise = d.poise !== undefined ? d.poise : e.poiseMax;

    e.hitstun = 0;
    e.invuln = d.invuln !== undefined ? d.invuln : 0;
    e.juggleCount = 0;
    e.flags = d.flags !== undefined ? d.flags | 0 : K.flags;
    e.flags &= ~Flags.DEAD;

    e.view = d.view !== undefined ? d.view : null;
    if (d.userData !== undefined && d.userData !== null) {
      e.userData = d.userData;
    } else {
      // Recycled objects must never leak the previous occupant's scratch data.
      wipeUserData(e.userData);
    }

    e.owner = d.owner !== undefined ? d.owner : 0;
    e.dragAir = d.dragAir !== undefined ? d.dragAir : K.dragAir;
    e.dragGround = d.dragGround !== undefined ? d.dragGround : K.dragGround;
    e.dragY = d.dragY !== undefined ? d.dragY : K.dragY;
    e.stopDecel = d.stopDecel !== undefined ? d.stopDecel : K.stopDecel;
    e.maxSpeedX = d.maxSpeedX !== undefined ? d.maxSpeedX : K.maxSpeedX;
    e.maxSpeedY = d.maxSpeedY !== undefined ? d.maxSpeedY : K.maxSpeedY;
    e.maxFallSpeed = d.maxFallSpeed !== undefined ? d.maxFallSpeed : K.maxFallSpeed;
    e.restitution = d.restitution !== undefined ? d.restitution : K.restitution;
    e.ttl = d.ttl !== undefined ? d.ttl : K.ttl;
    e.ccd = d.ccd !== undefined ? d.ccd : K.ccd;
    e.targetable = d.targetable !== undefined ? d.targetable : K.targetable;
    e.separation = d.separation !== undefined ? d.separation : K.separation;

    e.coyote = 0;
    e.airSteps = 0;
    e.bounceCount = 0;
    e._dk = -1;
    e._dky = -1;
    e._recentHitIdx = 0;
    for (let i = 0; i < RECENT_HIT_SLOTS; i++) e.recentHits[i] = 0;

    this._slots[slot] = e;
    this.entities.push(e);
    return e;
  }

  /**
   * Mark an entity dead. The object stays valid — and stays in `entities` — until the
   * next compaction, so every module gets a full step to notice `Flags.DEAD` and drop
   * its own references (views, trails, lock-on targets).
   */
  despawn(e) {
    if (e === null || e === undefined) return;
    if ((e.flags & Flags.DEAD) !== 0) return;
    e.flags |= Flags.DEAD;
    this.deadCount++;
    if (this.bus !== null) {
      this._despawnPayload.entity = e;
      this.bus.emit('entity:despawned', this._despawnPayload);
    }
  }

  /** @returns {object|undefined} */
  byId(id) {
    if (!(id > 0)) return undefined;
    const slot = id % SLOT_STRIDE;
    const e = this._slots[slot];
    if (e === null || e === undefined) return undefined;
    return e.id === id ? e : undefined;
  }

  /**
   * Remove every DEAD entity from the live array in one pass and recycle it.
   * Swap-free stable compaction: iteration order (and therefore determinism) is
   * preserved. Called exactly once per sim step, never from inside another loop.
   * @returns {number} entities removed
   */
  compact() {
    if (this.deadCount === 0) return 0;
    const arr = this.entities;
    const n = arr.length;
    let w = 0;
    for (let r = 0; r < n; r++) {
      const e = arr[r];
      if ((e.flags & Flags.DEAD) !== 0) {
        this._release(e);
        continue;
      }
      if (w !== r) arr[w] = e;
      w++;
    }
    const removed = n - w;
    arr.length = w;
    this.deadCount = 0;
    return removed;
  }

  _release(e) {
    const slot = e._slot;
    if (slot >= 0) {
      this._slots[slot] = null;
      // Bump the generation so any id captured before now is permanently stale.
      this._slotGen[slot] = (this._slotGen[slot] + 1) | 0;
      if (this._slotGen[slot] <= 0) this._slotGen[slot] = 1;
      this._freeSlots.push(slot);
    }
    e._slot = -1;
    e.id = 0;
    // The spawner owns the view and disposes it on `entity:despawned`; we only drop
    // our reference so a pooled entity can never resurrect a stale Object3D.
    e.view = null;
    this._pool.push(e);
  }

  /** Kill everything immediately (level teardown). Not for use inside a step. */
  clear() {
    const arr = this.entities;
    for (let i = 0; i < arr.length; i++) {
      arr[i].flags |= Flags.DEAD;
      this._release(arr[i]);
    }
    arr.length = 0;
    this.deadCount = 0;
  }
}

const EMPTY_DESC = Object.freeze({});
