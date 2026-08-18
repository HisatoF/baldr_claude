import * as THREE from 'three';
import { ParticleSystem } from './Particles.js';
import { BeamPool } from './Beams.js';
import { Fragments } from './Fragments.js';
import { PALETTE } from '../render/Palette.js';

/**
 * VFX module (order 40).
 *
 * Two draw calls carry every effect in the game: one additive particle system and
 * one beam pool. Effects are requested through `ctx.vfx` or by listening to the
 * contract bus events, so gameplay code never touches a mesh.
 *
 * Emission counts scale with an intensity budget: when the screen is already full,
 * new bursts emit fewer particles rather than pushing older ones out. Readability of
 * the action beats fidelity of any single explosion.
 */
export function createVfxModule() {
  let sparks = null; // additive, hot, stretched
  let smoke = null; // normal-blended, soft, dark
  let beams = null;
  let fragments = null;
  let attached = false;
  let rng = null;

  // A cheap running measure of how busy the screen is, used to throttle emission.
  let load = 0;

  const c = new THREE.Color();
  function rgb(hex) {
    c.set(hex);
    return c;
  }

  /** Scale a requested particle count by current load. */
  function budget(n) {
    const f = load > 0.85 ? 0.35 : load > 0.6 ? 0.65 : 1;
    return Math.max(1, Math.round(n * f));
  }

  const api = {
    /**
     * @param {'spark'|'debris'|'smoke'|'muzzle'|'impact'|'explosion'|'dust'} kind
     */
    burst(kind, x, y, opts = {}) {
      if (!sparks) return;
      const amount = opts.amount ?? 1;
      const dirX = opts.dirX ?? 0;
      const dirY = opts.dirY ?? 0;
      const R = rng;

      switch (kind) {
        case 'spark': {
          const n = budget(16 + 22 * amount);
          for (let i = 0; i < n; i++) {
            const a = R.range(0, Math.PI * 2);
            const sp = R.range(8, 34) * (0.5 + amount);
            sparks.emit({
              x, y, z: R.range(-0.4, 0.4),
              vx: Math.cos(a) * sp + dirX * 10,
              vy: Math.sin(a) * sp + dirY * 10,
              vz: R.range(-3, 3),
              life: R.range(0.14, 0.42),
              size0: R.range(0.10, 0.24), size1: 0.01,
              drag: 3.2, grav: -26, stretch: 1.5,
              r0: 1.0, g0: 0.93, b0: 0.72,
              r1: 1.0, g1: 0.34, b1: 0.08,
              alpha: 1,
            });
          }
          break;
        }

        case 'impact': {
          // A flat ring of sparks plus a bright flash core.
          const n = budget(22 + 30 * amount);
          for (let i = 0; i < n; i++) {
            const a = R.range(0, Math.PI * 2);
            const sp = R.range(12, 46) * (0.6 + amount * 0.7);
            sparks.emit({
              x, y, z: R.range(-0.3, 0.3),
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: R.range(-4, 4),
              life: R.range(0.1, 0.34),
              size0: R.range(0.12, 0.3), size1: 0.01,
              drag: 4.5, grav: -18, stretch: 2.0,
              r0: 1.0, g0: 0.96, b0: 0.86, r1: 0.92, g1: 0.36, b1: 0.10,
              alpha: 0.95,
            });
          }
          sparks.emit({
            x, y, z: 0.2, vx: 0, vy: 0,
            life: 0.10, size0: 1.05 + amount * 0.75, size1: 0.14,
            r0: 0.95, g0: 0.9, b0: 0.76, r1: 0.9, g1: 0.46, b1: 0.15, alpha: 0.72,
          });
          break;
        }

        case 'muzzle': {
          const n = budget(10);
          sparks.emit({
            x, y, z: 0.15, vx: dirX * 3, vy: dirY * 3,
            life: 0.11, size0: 1.15, size1: 0.2,
            r0: 0.95, g0: 0.88, b0: 0.68, r1: 0.9, g1: 0.46, b1: 0.16, alpha: 0.75,
          });
          for (let i = 0; i < n; i++) {
            const spread = R.range(-0.32, 0.32);
            const dx = dirX * Math.cos(spread) - dirY * Math.sin(spread);
            const dy = dirX * Math.sin(spread) + dirY * Math.cos(spread);
            const sp = R.range(16, 40);
            sparks.emit({
              x, y, z: R.range(-0.2, 0.2),
              vx: dx * sp, vy: dy * sp,
              life: R.range(0.05, 0.14),
              size0: R.range(0.08, 0.18), size1: 0.01,
              drag: 7, stretch: 2.4,
              r0: 1, g0: 0.9, b0: 0.65, r1: 1, g1: 0.4, b1: 0.1,
            });
          }
          break;
        }

        case 'explosion': {
          const rad = opts.radius ?? 2.4;
          const nf = budget(26 + 32 * amount);
          // Fireball core
          for (let i = 0; i < nf; i++) {
            const a = R.range(0, Math.PI * 2);
            const sp = R.range(3, 16) * (0.6 + amount);
            sparks.emit({
              x: x + R.range(-0.6, 0.6), y: y + R.range(-0.6, 0.6), z: R.range(-0.8, 0.8),
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 4, vz: R.range(-4, 4),
              life: R.range(0.22, 0.6),
              size0: R.range(0.5, 1.2) * rad * 0.24, size1: R.range(0.08, 0.3),
              drag: 3.4, grav: 5,
              r0: 0.85, g0: 0.62, b0: 0.30,
              r1: 0.55, g1: 0.10, b1: 0.02,
              alpha: 0.42,
            });
          }
          // Outward spark shell
          const ns = budget(24 + 26 * amount);
          for (let i = 0; i < ns; i++) {
            const a = R.range(0, Math.PI * 2);
            const sp = R.range(20, 62) * (0.6 + amount);
            sparks.emit({
              x, y, z: R.range(-0.5, 0.5),
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: R.range(-6, 6),
              life: R.range(0.18, 0.5),
              size0: R.range(0.1, 0.26), size1: 0.01,
              drag: 2.2, grav: -22, stretch: 1.9,
              r0: 0.85, g0: 0.78, b0: 0.62, r1: 0.8, g1: 0.28, b1: 0.05, alpha: 0.7,
            });
          }
          // Smoke afterwards, drifting up and cooling
          if (smoke) {
            const nsm = budget(5 + 6 * amount);
            for (let i = 0; i < nsm; i++) {
              smoke.emit({
                x: x + R.range(-1.1, 1.1), y: y + R.range(-0.6, 1.2), z: R.range(-1, 1),
                vx: R.range(-4, 4), vy: R.range(1.5, 7), vz: R.range(-2, 2),
                life: R.range(0.45, 1.0),
                size0: R.range(0.8, 1.6) * rad * 0.28, size1: R.range(1.8, 3.2) * rad * 0.28,
                drag: 1.5, grav: 1.2,
                spin: R.range(0, 6.28), spinVel: R.range(-1.4, 1.4),
                // Smoke at night is DARKER than the scene, not lighter. Mid-grey
                // puffs read as fog and wash the whole frame milky once a few
                // overlap, which is exactly what a night city cannot afford.
                r0: 0.10, g0: 0.10, b0: 0.12,
                r1: 0.02, g1: 0.02, b1: 0.035,
                alpha: 0.30,
              });
            }
          }
          break;
        }

        case 'smoke':
        case 'dust': {
          if (!smoke) break;
          const n = budget(4 + 7 * amount);
          for (let i = 0; i < n; i++) {
            const a = R.range(0, Math.PI * 2);
            smoke.emit({
              x: x + R.range(-1.0, 1.0), y: y + R.range(0, 0.5), z: R.range(-0.9, 0.9),
              // Ground dust travels outward and low, not upward like a smoke plume.
              vx: Math.cos(a) * R.range(2, 11) * (0.4 + amount),
              vy: R.range(0.4, 3.2),
              vz: R.range(-2.5, 2.5),
              life: R.range(0.35, 0.8),
              size0: R.range(0.4, 0.9), size1: R.range(1.2, 2.4),
              drag: 2.6, grav: 0.4,
              spin: R.range(0, 6.28), spinVel: R.range(-1.1, 1.1),
              r0: 0.13, g0: 0.13, b0: 0.15,
              r1: 0.03, g1: 0.035, b1: 0.05,
              alpha: 0.26 * (0.5 + amount * 0.5),
            });
          }
          break;
        }

        case 'debris': {
          const n = budget(10 + 14 * amount);
          for (let i = 0; i < n; i++) {
            const a = R.range(0, Math.PI * 2);
            const sp = R.range(6, 26) * (0.5 + amount);
            sparks.emit({
              x, y, z: R.range(-0.6, 0.6),
              vx: Math.cos(a) * sp, vy: Math.abs(Math.sin(a)) * sp * 0.9 + 6, vz: R.range(-5, 5),
              life: R.range(0.5, 1.3),
              size0: R.range(0.1, 0.26), size1: R.range(0.06, 0.18),
              drag: 0.5, grav: -34, bounce: true,
              spin: R.range(0, 6.28), spinVel: R.range(-9, 9),
              r0: 0.5, g0: 0.52, b0: 0.58, r1: 0.16, g1: 0.17, b1: 0.2,
              alpha: 1,
            });
          }
          break;
        }
      }
    },

    beam(x0, y0, x1, y1, opts = {}) {
      beams?.spawn(x0, y0, x1, y1, opts);
    },

    /** A short burst of afterimage sparks along a dashing entity. */
    trailBurst(entity) {
      if (!sparks || !entity) return;
      const R = rng;
      const n = budget(10);
      for (let i = 0; i < n; i++) {
        sparks.emit({
          x: entity.pos.x + R.range(-0.5, 0.5),
          y: entity.pos.y + R.range(-1.6, 1.6),
          z: R.range(-0.5, 0.5),
          vx: -entity.vel.x * R.range(0.05, 0.2),
          vy: R.range(-2, 2),
          life: R.range(0.12, 0.3),
          size0: R.range(0.3, 0.7), size1: 0.02,
          drag: 3, stretch: 1.1,
          r0: 0.55, g0: 0.88, b0: 1.0, r1: 0.12, g1: 0.35, b1: 0.7,
          alpha: 0.75,
        });
      }
    },

    /** Live rigid-fragment pool, so the capture harness can find a frame with debris in flight. */
    get fragments() { return fragments; },

    damageNumber() {
      // Damage readouts belong to the HUD layer, which owns all text.
    },

    get load() {
      return load;
    },
  };

  return {
    name: 'vfx',
    order: 40,

    init(ctx) {
      rng = ctx.rng.fork();

      sparks = new ParticleSystem(2600, { name: 'vfx.sparks', renderOrder: 14 });
      smoke = new ParticleSystem(420, {
        name: 'vfx.smoke',
        renderOrder: 11,
        blending: THREE.NormalBlending,
      });
      beams = new BeamPool(96);
      fragments = new Fragments();

      ctx.bus.on('fx:explosion', (p) => {
        api.burst('explosion', p.point.x, p.point.y, {
          radius: p.radius ?? 2.4,
          amount: p.kind === 'dust' ? 0.4 : 1,
        });
      });

      ctx.bus.on('hit:landed', (p) => {
        const amt = Math.min(1.4, (p.damage ?? 20) / 60);
        api.burst('impact', p.point.x, p.point.y, {
          amount: amt,
          dirX: p.normal?.x ?? 0,
          dirY: p.normal?.y ?? 0,
        });
        // A heavy hit is a physical event, not just a light. Kick debris off the
        // target and dust at its feet so the weight of the blow is visible.
        if (amt > 0.55) {
          api.burst('debris', p.point.x, p.point.y, { amount: amt * 0.7 });
          // Rigid chunks alongside the billboard debris. The billboards are the dust
          // and grit; these are the pieces of armour, and they are what a still frame
          // needs in order to say that something just got hit hard.
          fragments.burst(p.point.x, p.point.y, {
            amount: amt,
            dirX: p.normal?.x ?? 0,
            dirY: p.normal?.y ?? 0,
            rng: () => rng.range(0, 1),
          });
          const t = p.target;
          if (t && t.grounded) {
            api.burst('dust', t.pos.x, t.pos.y - (t.size?.y ?? 1), { amount: amt * 0.8 });
          }
        }
      });

      ctx.bus.on('weapon:fired', (p) => {
        api.burst('muzzle', p.origin.x, p.origin.y, { dirX: p.dir.x, dirY: p.dir.y });
      });

      ctx.bus.on('entity:died', (p) => {
        const e = p.entity;
        if (!e || e.kind === 'projectile') return;
        api.burst('explosion', e.pos.x, e.pos.y, { radius: 1.6 + (e.size?.x ?? 1), amount: 1.1 });
        api.burst('debris', e.pos.x, e.pos.y, { amount: 1 });
        fragments.burst(e.pos.x, e.pos.y, { amount: 1.4, rng: () => rng.range(0, 1) });
      });

      ctx.vfx = api;
    },

    frame(ctx, dt) {
      if (!attached && ctx.scene) {
        ctx.scene.add(smoke.mesh);
        ctx.scene.add(sparks.mesh);
        ctx.scene.add(beams.mesh);
        ctx.scene.add(fragments.mesh);
        ctx.scene.add(fragments.shadows);
        attached = true;
      }

      const gy = ctx.world?.groundHeightAt?.(ctx.combat?.player?.pos?.x ?? 0) ?? 0;
      sparks.groundY = gy;
      smoke.groundY = gy;

      // Visual systems advance on wall time so they keep their look at any
      // framerate, but hitstop must actually freeze them or impacts lose their snap.
      const scaled = dt * (ctx.time.scale > 0 ? 1 : 0);
      sparks.update(scaled);
      smoke.update(scaled);
      beams.update(scaled);
      // Fragments sample the terrain per fragment rather than sharing the player's
      // ground height the way the particle systems do: they travel far enough across
      // x that a single sample lands them inside a mound or floating over a crater.
      fragments.update(scaled, ctx.world?.groundHeightAt);

      load = sparks.count / sparks.capacity;
    },

    dispose() {
      if (fragments?.mesh?.parent) fragments.mesh.parent.remove(fragments.mesh);
      if (fragments?.shadows?.parent) fragments.shadows.parent.remove(fragments.shadows);
      fragments?.dispose();
      sparks?.dispose();
      smoke?.dispose();
      beams?.dispose();
    },
  };
}
