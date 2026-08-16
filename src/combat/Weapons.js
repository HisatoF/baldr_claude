import { Flags, Team } from '../core/Flags.js';

/**
 * Weapon library.
 *
 * Every weapon is data plus a `fire` function. Timings are in fixed sim steps
 * (120/s), which is what makes cancel windows exact and reproducible.
 *
 * The three numbers that define how a weapon feels in a chain:
 *
 *   startup   — steps before the hit comes out. Heavy weapons telegraph.
 *   active    — steps the hitbox/projectile is live.
 *   recovery  — steps you are locked before acting again.
 *   cancelAt  — the step (from the start of recovery) at which another weapon may
 *               be chained in. Lower = links more freely. This single value is what
 *               separates a stiff weapon from one that flows.
 *
 * `stagger` drains poise; when poise breaks the target staggers. `launch` sends the
 * target airborne and starts a juggle. A loadout without a launcher cannot start an
 * air combo, which is the main reason to care about the distinction.
 */

let nextProjectileId = 1;

/** Spawn a pooled projectile carrying its damage payload in userData. */
function spawnProjectile(ctx, owner, def, x, y, dx, dy, speed, opts = {}) {
  const p = ctx.physics.spawn({
    kind: 'projectile',
    archetype: def.id,
    x,
    y,
    vx: dx * speed,
    vy: dy * speed,
    hx: opts.hx ?? 0.28,
    hy: opts.hy ?? 0.28,
    team: owner.team,
    mass: 0.4,
    gravityScale: opts.gravityScale ?? 0,
    hp: 1,
  });
  if (!p) return null;

  p.flags |= Flags.NO_COLLIDE_WORLD * 0; // projectiles DO collide with terrain
  if (opts.piercing) p.flags |= Flags.PIERCING;
  if (opts.homing) p.flags |= Flags.HOMING;
  p.flags |= Flags.DESPAWN_OFFSCREEN;

  // Draw a tracer along the round's first step. Without it a fast projectile is a
  // dot that teleports between frames and a sustained burst reads as nothing at all
  // crossing the gap between the mech and its target.
  if (opts.tracer !== false && speed > 60) {
    const len = Math.min(9.0, speed * 0.05);
    ctx.vfx?.beam?.(x, y, x + dx * len, y + dy * len, {
      color: def.color,
      width: opts.tracerWidth ?? 0.22,
      // 0.05s is under three frames at 60fps: a burst could be mid-flight and the
      // frame would still show nothing crossing the gap. Long enough to be caught.
      life: 0.13,
    });
  }

  const u = p.userData;
  u.weaponId = def.id;
  u.ownerId = owner.id;
  u.damage = def.damage;
  u.stagger = def.stagger;
  u.launch = def.launch;
  u.hitstop = def.hitstop;
  u.shake = def.shake;
  u.life = opts.life ?? 2.2;
  u.serial = nextProjectileId++;
  u.color = def.color;
  return p;
}

/** Shared hitscan: raycast, draw the beam, report the hit. */
function hitscan(ctx, owner, def, x, y, dx, dy, range) {
  const hit = ctx.physics.raycast(x, y, dx, dy, range, owner.team);
  const ex = hit ? hit.point.x : x + dx * range;
  const ey = hit ? hit.point.y : y + dy * range;

  ctx.vfx?.beam?.(x, y, ex, ey, {
    color: def.color,
    width: def.beamWidth ?? 0.3,
    life: def.beamLife ?? 0.08,
  });

  if (hit && hit.entity) {
    ctx.combat.dealDamage(owner, hit.entity, def.damage, {
      weaponId: def.id,
      point: { x: ex, y: ey },
      normal: { x: -dx, y: -dy },
      stagger: def.stagger,
      launch: def.launch,
      hitstop: def.hitstop,
      shake: def.shake,
    });
  }
  return hit;
}

/** Melee: sweep an AABB in front of the owner and hit everything inside once. */
function meleeSweep(ctx, owner, def, reach, halfH) {
  const dir = owner.faceDir;
  const cx = owner.pos.x + dir * (reach * 0.5 + 0.6);
  const cy = owner.pos.y;
  const out = ctx.combat._queryScratch;
  const n = ctx.physics.queryTargets(cx, cy, reach * 0.5, halfH, owner.team, out);

  for (let i = 0; i < n; i++) {
    const t = out[i];
    if (!t || t === owner || (t.flags & Flags.DEAD)) continue;
    ctx.combat.dealDamage(owner, t, def.damage, {
      weaponId: def.id,
      point: { x: (owner.pos.x + t.pos.x) * 0.5, y: (owner.pos.y + t.pos.y) * 0.5 },
      normal: { x: dir, y: 0.25 },
      stagger: def.stagger,
      launch: def.launch,
      hitstop: def.hitstop,
      shake: def.shake,
    });
  }
  return n;
}

/**
 * The library. Ordered roughly light -> heavy.
 * `slot` is advisory; any weapon can be assigned to any slot.
 */
export const WEAPONS = [
  // ---------------- rapid / chip ----------------
  {
    id: 'rifle', name: 'AR-92 Assault Rifle', slot: 'both', kind: 'projectile',
    damage: 14, en: 0, startup: 3, active: 1, recovery: 12, cancelAt: 4, cooldown: 9,
    stagger: 6, launch: 0, hitstop: 0.012, shake: 0.06, recoil: 0.12,
    color: 0xffd08a,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.5;
      const oy = owner.pos.y + 0.35;
      spawnProjectile(ctx, owner, this, ox, oy, dx, dy, 165, { hx: 0.3, hy: 0.14 });
      return { ox, oy };
    },
  },
  {
    id: 'gatling', name: 'GX Rotary Cannon', slot: 'both', kind: 'projectile',
    damage: 8, en: 0, startup: 2, active: 1, recovery: 6, cancelAt: 2, cooldown: 4,
    stagger: 3, launch: 0, hitstop: 0.006, shake: 0.05, recoil: 0.07,
    color: 0xffc07a,
    fire(ctx, owner, dx, dy) {
      // Spread grows the longer it is held; the combo module passes the streak in.
      const spread = 0.05 + Math.min(0.12, (this._streak ?? 0) * 0.004);
      const a = Math.atan2(dy, dx) + (ctx.rng.float() - 0.5) * spread * 2;
      const ox = owner.pos.x + dx * 1.5;
      const oy = owner.pos.y + 0.3;
      spawnProjectile(ctx, owner, this, ox, oy, Math.cos(a), Math.sin(a), 190, { hx: 0.24, hy: 0.12 });
      return { ox, oy };
    },
  },
  {
    id: 'shotgun', name: 'SB-4 Scatter Gun', slot: 'both', kind: 'projectile',
    damage: 11, en: 4, startup: 5, active: 1, recovery: 26, cancelAt: 12, cooldown: 34,
    stagger: 26, launch: 0, hitstop: 0.05, shake: 0.28, recoil: 0.55,
    color: 0xffb066,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.5;
      const oy = owner.pos.y + 0.3;
      const base = Math.atan2(dy, dx);
      for (let i = 0; i < 7; i++) {
        const a = base + (i - 3) * 0.055 + (ctx.rng.float() - 0.5) * 0.03;
        spawnProjectile(ctx, owner, this, ox, oy, Math.cos(a), Math.sin(a), 130 + ctx.rng.float() * 30, {
          hx: 0.22, hy: 0.22, life: 0.35,
        });
      }
      return { ox, oy };
    },
  },

  // ---------------- precision / hitscan ----------------
  {
    id: 'sniper', name: 'LR-7 Rail Lance', slot: 'both', kind: 'hitscan',
    damage: 96, en: 16, startup: 16, active: 1, recovery: 40, cancelAt: 22, cooldown: 64,
    stagger: 60, launch: 0, hitstop: 0.1, shake: 0.7, recoil: 1.0,
    color: 0xa8f0ff, beamWidth: 0.42, beamLife: 0.16,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.8;
      const oy = owner.pos.y + 0.4;
      hitscan(ctx, owner, this, ox, oy, dx, dy, 190);
      return { ox, oy };
    },
  },
  {
    id: 'railgun', name: 'MK-IX Railgun', slot: 'both', kind: 'hitscan',
    damage: 150, en: 30, startup: 34, active: 1, recovery: 52, cancelAt: 30, cooldown: 100,
    stagger: 120, launch: 0, hitstop: 0.16, shake: 1.1, recoil: 1.4,
    color: 0xd8f4ff, beamWidth: 0.85, beamLife: 0.26, piercing: true,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.9;
      const oy = owner.pos.y + 0.4;
      hitscan(ctx, owner, this, ox, oy, dx, dy, 260);
      ctx.bus.emit('camera:shake', { intensity: 1.1, duration: 0.35, freq: 22 });
      return { ox, oy };
    },
  },
  {
    id: 'laser', name: 'CB-3 Coil Beam', slot: 'both', kind: 'hitscan',
    damage: 30, en: 9, startup: 8, active: 1, recovery: 18, cancelAt: 9, cooldown: 22,
    stagger: 18, launch: 0, hitstop: 0.03, shake: 0.16, recoil: 0.3,
    color: 0x7cf0ff, beamWidth: 0.3, beamLife: 0.11,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.6;
      const oy = owner.pos.y + 0.35;
      hitscan(ctx, owner, this, ox, oy, dx, dy, 150);
      return { ox, oy };
    },
  },

  // ---------------- explosive ----------------
  {
    id: 'missile', name: 'HM-6 Homing Pod', slot: 'both', kind: 'projectile',
    damage: 42, en: 12, startup: 8, active: 1, recovery: 26, cancelAt: 10, cooldown: 46,
    stagger: 40, launch: 6, hitstop: 0.07, shake: 0.4, recoil: 0.4,
    color: 0xff9a5c,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x;
      const oy = owner.pos.y + 1.1;
      for (let i = 0; i < 4; i++) {
        const spreadY = 0.5 + i * 0.22;
        const p = spawnProjectile(ctx, owner, this, ox, oy, dx * 0.4, spreadY, 34, {
          hx: 0.3, hy: 0.3, homing: true, life: 2.6,
        });
        if (p) {
          p.userData.homingDelay = 0.18 + i * 0.05;
          p.userData.homingRate = 7.5;
          p.userData.homingSpeed = 78;
          p.userData.blastRadius = 3.0;
        }
      }
      return { ox, oy };
    },
  },
  {
    id: 'grenade', name: 'FG-2 Arc Launcher', slot: 'ground', kind: 'projectile',
    damage: 60, en: 14, startup: 10, active: 1, recovery: 30, cancelAt: 14, cooldown: 54,
    stagger: 55, launch: 15, hitstop: 0.08, shake: 0.5, recoil: 0.5,
    color: 0xffc46a,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.2;
      const oy = owner.pos.y + 0.6;
      const p = spawnProjectile(ctx, owner, this, ox, oy, dx, 0.55, 46, {
        hx: 0.34, hy: 0.34, gravityScale: 1, life: 3.0,
      });
      if (p) p.userData.blastRadius = 4.2;
      return { ox, oy };
    },
  },
  {
    id: 'mine', name: 'DP-1 Drop Mine', slot: 'air', kind: 'projectile',
    damage: 70, en: 16, startup: 6, active: 1, recovery: 22, cancelAt: 9, cooldown: 60,
    stagger: 70, launch: 22, hitstop: 0.09, shake: 0.55, recoil: 0.2,
    color: 0xff6a9a,
    fire(ctx, owner) {
      const ox = owner.pos.x;
      const oy = owner.pos.y - 0.4;
      const p = spawnProjectile(ctx, owner, this, ox, oy, 0, -1, 22, {
        hx: 0.4, hy: 0.4, gravityScale: 1.1, life: 4,
      });
      if (p) p.userData.blastRadius = 5.0;
      return { ox, oy };
    },
  },

  // ---------------- melee ----------------
  {
    id: 'saber', name: 'PB Plasma Sabre', slot: 'both', kind: 'melee',
    damage: 46, en: 8, startup: 6, active: 4, recovery: 16, cancelAt: 5, cooldown: 14,
    stagger: 45, launch: 0, hitstop: 0.06, shake: 0.3, recoil: 0.35,
    color: 0x8ef0ff, reach: 4.4, halfH: 1.9, blade: true,
    fire(ctx, owner) {
      meleeSweep(ctx, owner, this, this.reach, this.halfH);
      return { ox: owner.pos.x + owner.faceDir * 2.2, oy: owner.pos.y };
    },
  },
  {
    id: 'lance', name: 'VT Plasma Lance', slot: 'both', kind: 'melee',
    damage: 72, en: 18, startup: 12, active: 5, recovery: 28, cancelAt: 15, cooldown: 40,
    stagger: 85, launch: 26, hitstop: 0.1, shake: 0.6, recoil: 0.7,
    color: 0x9fd8ff, reach: 6.0, halfH: 2.2, blade: true,
    fire(ctx, owner) {
      meleeSweep(ctx, owner, this, this.reach, this.halfH);
      return { ox: owner.pos.x + owner.faceDir * 3.0, oy: owner.pos.y };
    },
  },
  {
    id: 'hammer', name: 'GH-8 Impact Hammer', slot: 'ground', kind: 'melee',
    damage: 110, en: 24, startup: 22, active: 5, recovery: 44, cancelAt: 26, cooldown: 76,
    stagger: 150, launch: 34, hitstop: 0.15, shake: 1.0, recoil: 1.2,
    color: 0xffb45c, reach: 5.2, halfH: 2.6,
    fire(ctx, owner, dx, dy, ctxRef) {
      meleeSweep(ctx, owner, this, this.reach, this.halfH);
      // The hammer shakes the ground whether or not it connects.
      ctx.bus.emit('camera:shake', { intensity: 0.9, duration: 0.3, freq: 20 });
      ctx.vfx?.burst?.('dust', owner.pos.x + owner.faceDir * 3, owner.pos.y - owner.size.y, { amount: 1.2 });
      return { ox: owner.pos.x + owner.faceDir * 2.6, oy: owner.pos.y - 1 };
    },
  },
  {
    id: 'drill', name: 'RD-5 Breach Drill', slot: 'both', kind: 'melee',
    damage: 20, en: 5, startup: 4, active: 3, recovery: 8, cancelAt: 3, cooldown: 8,
    stagger: 16, launch: 0, hitstop: 0.02, shake: 0.12, recoil: 0.18,
    color: 0xffd88a, reach: 3.4, halfH: 1.5,
    fire(ctx, owner) {
      meleeSweep(ctx, owner, this, this.reach, this.halfH);
      return { ox: owner.pos.x + owner.faceDir * 1.9, oy: owner.pos.y };
    },
  },
  {
    id: 'uppercut', name: 'AK Rising Knuckle', slot: 'ground', kind: 'melee',
    damage: 55, en: 14, startup: 8, active: 4, recovery: 30, cancelAt: 11, cooldown: 44,
    // The dedicated launcher: modest damage, huge lift. This is what opens air combos.
    stagger: 70, launch: 40, hitstop: 0.11, shake: 0.5, recoil: 0.5,
    color: 0xff8ad0, reach: 3.2, halfH: 3.0,
    fire(ctx, owner) {
      meleeSweep(ctx, owner, this, this.reach, this.halfH);
      return { ox: owner.pos.x + owner.faceDir * 1.7, oy: owner.pos.y + 1 };
    },
  },
  {
    id: 'slam', name: 'DS Dive Slam', slot: 'air', kind: 'melee',
    damage: 88, en: 20, startup: 8, active: 6, recovery: 34, cancelAt: 20, cooldown: 58,
    stagger: 110, launch: 0, hitstop: 0.13, shake: 0.9, recoil: 0.9,
    color: 0xffa06a, reach: 4.0, halfH: 2.4,
    fire(ctx, owner) {
      // Drives the owner down; the impact is the point.
      owner.vel.y = Math.min(owner.vel.y, -58);
      meleeSweep(ctx, owner, this, this.reach, this.halfH);
      return { ox: owner.pos.x, oy: owner.pos.y - 1.4 };
    },
  },

  // ---------------- support ----------------
  {
    id: 'drone', name: 'SD-2 Support Drone', slot: 'both', kind: 'projectile',
    damage: 18, en: 10, startup: 6, active: 1, recovery: 18, cancelAt: 7, cooldown: 70,
    stagger: 10, launch: 0, hitstop: 0.02, shake: 0.1, recoil: 0.15,
    color: 0x7ce0ff,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x;
      const oy = owner.pos.y + 1.6;
      for (let i = 0; i < 3; i++) {
        const p = spawnProjectile(ctx, owner, this, ox, oy, dx, 0.3 + i * 0.2, 70, {
          hx: 0.24, hy: 0.24, homing: true, life: 2.0,
        });
        if (p) {
          p.userData.homingDelay = 0.1;
          p.userData.homingRate = 9;
          p.userData.homingSpeed = 92;
        }
      }
      return { ox, oy };
    },
  },
  {
    id: 'flamer', name: 'IN-3 Incinerator', slot: 'ground', kind: 'projectile',
    damage: 7, en: 2, startup: 3, active: 1, recovery: 6, cancelAt: 2, cooldown: 3,
    stagger: 4, launch: 0, hitstop: 0.004, shake: 0.04, recoil: 0.05,
    color: 0xff8a3c,
    fire(ctx, owner, dx, dy) {
      const ox = owner.pos.x + dx * 1.4;
      const oy = owner.pos.y + 0.2;
      for (let i = 0; i < 2; i++) {
        const a = Math.atan2(dy, dx) + (ctx.rng.float() - 0.5) * 0.34;
        spawnProjectile(ctx, owner, this, ox, oy, Math.cos(a), Math.sin(a), 42 + ctx.rng.float() * 22, {
          hx: 0.5, hy: 0.5, life: 0.32, piercing: true,
        });
      }
      return { ox, oy };
    },
  },
];

/** @type {Map<string, object>} */
export const WEAPON_MAP = new Map(WEAPONS.map((w) => [w.id, w]));

export function getWeapon(id) {
  return WEAPON_MAP.get(id);
}

/** Total animation length of a weapon action, in sim steps. */
export function weaponDuration(w) {
  return w.startup + w.active + w.recovery;
}
