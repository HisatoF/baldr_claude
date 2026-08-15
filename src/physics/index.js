import { EntityStore } from './EntityStore.js';
import { CollisionSystem } from './Collision.js';
import { integrateAll } from './Integrator.js';
import { DEFAULT_BOUNDS } from './Tuning.js';
import { resolveLanding, resolveBounds, applyLaunch } from './Response.js';
import { Flags } from '../core/Flags.js';

/**
 * Physics module (order 20).
 *
 * The backbone every gameplay system calls into. Owns entity lifetime, integration,
 * and collision, and publishes the §11 `ctx.physics` API.
 *
 * Step order matters and is deliberate:
 *   1. compact        — retire entities that died on the PREVIOUS step
 *   2. integrate      — advance positions from velocities
 *   3. resolve        — terrain contact and playfield bounds
 *   4. rebuild        — refresh the broadphase against final positions
 *   5. sweep          — continuous projectile tests (needs the fresh grid)
 *   6. separate       — soft push-apart so bodies do not stack in one column
 *
 * Compaction leads rather than trails, so the entity array — and therefore the
 * broadphase indices built from it — stays stable for every module that runs after
 * physics this step.
 */
export function createPhysicsModule() {
  const store = new EntityStore(640);
  const collision = new CollisionSystem();
  let bounds = DEFAULT_BOUNDS;

  const api = {
    get entities() {
      return store.entities;
    },

    spawn(desc) {
      const e = store.spawn(desc);
      return e;
    },

    despawn(entity) {
      store.despawn(entity);
    },

    byId(id) {
      return store.byId(id);
    },

    query(x, y, hx, hy, team, out) {
      return collision.query(x, y, hx, hy, team, out);
    },

    queryTargets(x, y, hx, hy, team, out) {
      return collision.queryTargets(x, y, hx, hy, team, out);
    },

    raycast(x0, y0, dx, dy, maxDist, team) {
      return collision.raycast(x0, y0, dx, dy, maxDist, team, false);
    },

    groundHeightAt(x) {
      return collision.groundHeightAt(x);
    },

    /** Mass-scaled impulse. Heavier bodies move less for the same hit. */
    /** Launch a target into a juggle, with per-juggle decay. */
    launch(entity, power) {
      return applyLaunch(entity, power, null);
    },

    applyImpulse(entity, ix, iy) {
      if (!entity || entity.flags & Flags.DEAD) return;
      const inv = entity.mass > 0 ? 1 / entity.mass : 0;
      entity.vel.x += ix * inv;
      entity.vel.y += iy * inv;
    },

    get bounds() {
      return bounds;
    },
    setBounds(b) {
      bounds = b;
    },

    collision,
    store,
  };

  return {
    name: 'physics',
    order: 20,

    init(ctx) {
      // World is order 10, so its terrain sampler is already published here.
      if (ctx.world) {
        collision.setWorld(ctx.world);
        if (ctx.world.bounds) bounds = ctx.world.bounds;
      }
      ctx.physics = api;
    },

    fixed(ctx, dt) {
      // Compaction happens FIRST, not last.
      //
      // The broadphase stores indices into the entity array, so anything that
      // reorders that array invalidates the grid. Compacting at the end of the step
      // left every later module (combat's lock-on, AI's queries) reading a grid whose
      // indices no longer resolved — an undefined entity, one step later.
      //
      // Removing last step's dead first means the array is stable for the whole of
      // this step. Entities that die *during* this step keep their slot until the
      // next one, flagged DEAD, and every consumer already skips DEAD.
      store.compact();

      const entities = store.entities;

      integrateAll(entities, dt);

      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (e.flags & Flags.DEAD) continue;
        if (e.flags & Flags.NO_COLLIDE_WORLD) continue;

        // resolveTerrain corrects position and reports the contact speed but
        // deliberately leaves velocity alone; Response decides what contact means.
        const impact = collision.resolveTerrain(e, bounds);
        if (impact >= 0) {
          const severity = resolveLanding(e, impact, ctx, dt);
          if (severity > 0.35 && e.kind !== 'projectile') {
            ctx.vfx?.burst?.('smoke', e.pos.x, e.pos.y - e.size.y, { amount: severity });
          }
        }
        const slam = resolveBounds(e, bounds);
        if (slam > 0.3) {
          ctx.bus.emit('camera:shake', { intensity: slam * 0.4, duration: 0.18, freq: 28 });
        }
      }

      collision.rebuild(entities);
      collision.sweepAll(entities, api.despawn);
      collision.separateAll(entities, dt);
    },

    dispose() {
      store.clear();
    },
  };
}
