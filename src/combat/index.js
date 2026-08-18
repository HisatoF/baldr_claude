import { createMech } from './MechModel.js';
import { PlayerController } from './PlayerController.js';
import { MechAnimator } from './MechAnimator.js';
import { Afterimage } from './Afterimage.js';
import { CharacterLight } from './CharacterLight.js';
import { ComboSystem } from './Combo.js';
import { DemoPilot } from './DemoPilot.js';
import { WEAPONS, WEAPON_MAP, getWeapon } from './Weapons.js';
import { Flags, Team } from '../core/Flags.js';
import { clamp } from '../core/MathUtil.js';

/**
 * Combat module (order 30).
 *
 * Owns the player mech, the weapon library, the combo state machine, damage
 * resolution, projectile behaviour, and lock-on.
 */
export function createCombatModule() {
  let player = null;
  let mech = null;
  let controller = null;
  let animator = null;
  let afterimage = null;
  let charLight = null;
  let combo = null;
  let pilot = null;
  let attached = false;
  let ctxRef = null;

  // Preallocated query buffers — nothing in the step loop allocates.
  const queryScratch = new Array(64).fill(null);
  const lockScratch = new Array(64).fill(null);

  const comboView = { count: 0, damage: 0, timeLeft: 0, rank: 'D' };

  const api = {
    get player() { return player; },
    get mech() { return mech; },
    get controller() { return controller; },
    get animator() { return animator; },
    get afterimage() { return afterimage; },
    get charLight() { return charLight; },
    get comboSystem() { return combo; },
    get pilot() { return pilot; },
    combo: comboView,
    lockTarget: null,
    weapons: WEAPON_MAP,
    loadout: {
      // Ground: rapid poke, launcher, blade, heavy finisher.
      ground: ['rifle', 'uppercut', 'saber', 'hammer'],
      // Air: chip, tracking, blade, dive.
      air: ['gatling', 'missile', 'saber', 'slam'],
    },
    _queryScratch: queryScratch,

    get enFrac() {
      return controller ? clamp(controller.en / 100, 0, 1) : 0;
    },
    get hpFrac() {
      return player ? clamp(player.hp / player.hpMax, 0, 1) : 0;
    },

    /**
     * Apply damage and all of its consequences: poise, stagger, launch, knockback,
     * hitstop, shake, and the combo chain.
     */
    dealDamage(attacker, target, amount, opts = {}) {
      if (!target || (target.flags & Flags.DEAD) || target.invuln > 0) return false;
      if (target.team === attacker.team) return false;

      const fromPlayer = attacker === player;
      const scaled = fromPlayer && combo ? amount * combo.scaling : amount;
      const dmg = Math.max(1, Math.round(scaled));

      target.hp -= dmg;

      // --- poise / stagger ---
      const stagger = opts.stagger ?? 0;
      if (stagger > 0 && target.poiseMax > 0) {
        target.poise -= stagger;
        if (target.poise <= 0) {
          target.poise = target.poiseMax;
          target.flags |= Flags.STAGGERED;
          target.hitstun = Math.max(target.hitstun, 34);
        }
      }
      target.hitstun = Math.max(target.hitstun, 10);

      // --- knockback / launch ---
      const nx = opts.normal?.x ?? 0;
      const ny = opts.normal?.y ?? 0;
      const launch = opts.launch ?? 0;
      if (launch > 0) ctxRef?.physics?.launch?.(target, launch);
      ctxRef?.physics?.applyImpulse?.(
        target,
        nx * dmg * 0.5,
        ny * dmg * 0.35 + (launch ? 0 : dmg * 0.06)
      );

      // --- feedback ---
      const point = opts.point ?? { x: target.pos.x, y: target.pos.y };
      ctxRef?.bus.emit('hit:landed', {
        attacker,
        target,
        damage: dmg,
        point,
        normal: { x: nx, y: ny },
        weaponId: opts.weaponId ?? null,
        stagger,
        launch,
      });

      if (opts.hitstop) ctxRef?.bus.emit('time:hitstop', { duration: opts.hitstop });
      if (opts.shake) {
        ctxRef?.bus.emit('camera:shake', { intensity: opts.shake, duration: 0.16, freq: 32 });
      }

      if (fromPlayer && combo) {
        combo.onHitLanded(dmg);
        ctxRef?.render?.impactFlash?.(clamp(dmg / 120, 0.05, 0.5));
        charLight?.pulse(0.35);
      }

      // --- death ---
      if (target.hp <= 0) {
        const overkill = -target.hp;
        target.hp = 0;
        ctxRef?.bus.emit('entity:died', { entity: target, killer: attacker, overkill });
        ctxRef?.physics?.despawn(target);
      }

      return true;
    },
  };

  /** Nearest hostile within a forward-biased search, for soft aim assist. */
  function updateLock(ctx) {
    if (!player) return;
    const n = ctx.physics.query(player.pos.x, player.pos.y, 46, 26, Team.PLAYER, lockScratch);
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const e = lockScratch[i];
      if (!e || e === player || (e.flags & Flags.DEAD) || e.kind === 'projectile') continue;
      if (e.team === Team.PLAYER) continue;
      const dx = e.pos.x - player.pos.x;
      const dy = e.pos.y - player.pos.y;
      const dist = Math.hypot(dx, dy);
      // Prefer targets ahead of the mech, without excluding those behind it.
      const facing = dx * player.faceDir > 0 ? 1 : 2.4;
      const score = dist * facing;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    api.lockTarget = best;
  }

  function detonate(ctx, p) {
    const u = p.userData;
    const r = u.blastRadius;
    ctx.bus.emit('fx:explosion', { point: { x: p.pos.x, y: p.pos.y }, radius: r, kind: 'blast' });
    ctx.bus.emit('camera:shake', {
      intensity: clamp(r * 0.16, 0.15, 0.8),
      duration: 0.22,
      freq: 26,
    });

    const owner = ctx.physics.byId(u.ownerId) || player;
    const team = owner ? owner.team : Team.PLAYER;
    const n = ctx.physics.query(p.pos.x, p.pos.y, r, r, team, queryScratch);
    for (let i = 0; i < n; i++) {
      const t = queryScratch[i];
      if (!t || t.kind === 'projectile' || (t.flags & Flags.DEAD)) continue;
      const dx = t.pos.x - p.pos.x;
      const dy = t.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      // Linear falloff: full damage at the centre, nothing at the rim.
      const falloff = 1 - d / r;
      const m = d || 1;
      api.dealDamage(owner || player, t, u.damage * falloff, {
        weaponId: u.weaponId,
        point: { x: t.pos.x, y: t.pos.y },
        normal: { x: dx / m, y: dy / m + 0.3 },
        stagger: u.stagger * falloff,
        launch: u.launch * falloff,
        hitstop: u.hitstop,
        shake: 0,
      });
    }
  }

  /** Projectile lifetime, homing, and off-field cleanup. */
  function stepProjectiles(ctx, dt) {
    const list = ctx.physics.entities;
    const b = ctx.physics.bounds;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.kind !== 'projectile' || (p.flags & Flags.DEAD)) continue;
      const u = p.userData;

      u.life -= dt;
      if (u.life <= 0) {
        if (u.blastRadius) detonate(ctx, p);
        ctx.physics.despawn(p);
        continue;
      }

      if (p.pos.x < b.minX - 14 || p.pos.x > b.maxX + 14 || p.pos.y > b.maxY + 20 || p.pos.y < -12) {
        ctx.physics.despawn(p);
        continue;
      }

      if (p.flags & Flags.HOMING) {
        u.homingDelay -= dt;
        if (u.homingDelay <= 0) {
          const t = api.lockTarget;
          if (t && !(t.flags & Flags.DEAD)) {
            const dx = t.pos.x - p.pos.x;
            const dy = t.pos.y - p.pos.y;
            const m = Math.hypot(dx, dy) || 1;
            const sp = u.homingSpeed ?? 80;
            const rate = Math.min(1, (u.homingRate ?? 7) * dt);
            // Steer the velocity vector rather than snapping it, so missiles arc
            // instead of turning on a dime.
            p.vel.x += ((dx / m) * sp - p.vel.x) * rate;
            p.vel.y += ((dy / m) * sp - p.vel.y) * rate;
          }
        }
      }
    }
  }

  return {
    name: 'combat',
    order: 30,

    init(ctx) {
      ctxRef = ctx;
      if (!ctx.physics) {
        console.warn('[combat] physics unavailable; player not spawned');
        return;
      }

      player = ctx.physics.spawn({
        kind: 'player',
        archetype: 'simulacrum',
        x: 0,
        y: 6,
        hx: 1.1,
        hy: 2.0,
        mass: 8,
        team: Team.PLAYER,
        hp: 1200,
        faceDir: 1,
      });

      mech = createMech();
      controller = new PlayerController(player, ctx.bus);
      animator = new MechAnimator(mech);
      afterimage = new Afterimage(mech.metrics);
      charLight = new CharacterLight();
      combo = new ComboSystem(player, api.loadout);

      // Attract mode. Also enabled during headless capture, because a screenshot of
      // a mech standing still says nothing about how the game looks in play.
      const params = new URLSearchParams(location.search);
      if (params.get('demo') === '1' || params.get('capture') === '1') {
        pilot = new DemoPilot(ctx.rng.fork());
      }

      // Projectile impacts arrive from the physics sweep rather than a per-step
      // overlap test, so fast rounds cannot tunnel through thin targets.
      ctx.physics.collision.onHit = (h) => {
        const p = h.projectile;
        const u = p.userData;
        const owner = ctx.physics.byId(u.ownerId) || player;

        if (u.blastRadius) {
          p.pos.x = h.point.x;
          p.pos.y = h.point.y;
          detonate(ctx, p);
          return;
        }

        if (h.terrain || !h.target) {
          ctx.vfx?.burst?.('spark', h.point.x, h.point.y, {
            amount: 0.35,
            dirX: h.normal.x,
            dirY: h.normal.y,
          });
          return;
        }

        api.dealDamage(owner || player, h.target, u.damage, {
          weaponId: u.weaponId,
          point: { x: h.point.x, y: h.point.y },
          normal: { x: h.normal.x, y: h.normal.y },
          stagger: u.stagger,
          launch: u.launch,
          hitstop: u.hitstop,
          shake: u.shake,
        });
      };

      player.view = mech.root;
      ctx.combat = api;
    },

    fixed(ctx, dt) {
      if (!player || !controller) return;

      if (player.hitstun > 0) player.hitstun--;
      if (player.invuln > 0) player.invuln--;

      if (pilot) pilot.step(ctx, dt);
      controller.step(ctx, dt);
      controller.groundY = ctx.world?.groundHeightAt?.(player.pos.x) ?? 0;

      updateLock(ctx);
      combo.step(ctx, dt);
      stepProjectiles(ctx, dt);

      comboView.count = combo.count;
      comboView.damage = Math.round(combo.damage);
      comboView.timeLeft = combo.timeLeft;
      comboView.rank = combo.rank;
    },

    frame(ctx, dt, alpha) {
      if (!player || !mech) return;

      if (!attached && ctx.scene) {
        ctx.scene.add(mech.root);
        ctx.scene.add(charLight.group);
        ctx.scene.add(charLight.root);
        ctx.scene.add(afterimage.mesh);
        mech.syncEnvironment?.(ctx.scene);
        ctx.render?.setCameraTarget?.(player);
        attached = true;
      }

      // The sabre is only out while a blade weapon is actually active.
      const a = combo?.action;
      if (mech.sabre) mech.sabre.visible = !!(a && a.blade);

      animator.update(player, controller, dt, alpha);
      // Speed has to leave evidence in a still frame. See Afterimage for why this is
      // a proxy silhouette rather than a replayed pose.
      afterimage.update(
        player,
        mech.root.rotation.y,
        Math.hypot(player.vel.x, player.vel.y),
        dt
      );
      charLight.update(player, dt, animator.thrust);
      // The nearest hostile doubles as a practical light so the mech casts a shadow
      // driven by the thing threatening it.
      charLight.updateThreat(player, api.lockTarget, dt);
      ctx.render?.setDashIntensity?.(controller.dashIntensity);
    },

    dispose() {
      if (mech?.root?.parent) mech.root.parent.remove(mech.root);
      if (charLight?.group?.parent) charLight.group.parent.remove(charLight.group);
      charLight?.dispose();
      if (afterimage?.mesh?.parent) afterimage.mesh.parent.remove(afterimage.mesh);
      afterimage?.dispose();
    },
  };
}

export { WEAPONS, getWeapon };
