import * as THREE from 'three';
import { buildEnemyRenderer, ARCHETYPES } from './EnemyModels.js';
import { Flags, Team } from '../core/Flags.js';
import { clamp, damp, sign } from '../core/MathUtil.js';
import { getWeapon } from '../combat/Weapons.js';

/**
 * AI module (order 35).
 *
 * Enemy archetypes, their behaviour, and the wave director.
 *
 * Behaviour is intentionally simple and readable rather than clever: each archetype
 * runs a small state machine with telegraphed attacks. In a game this fast, an enemy
 * the player cannot predict is not challenging, only unfair — the difficulty should
 * come from how many of them there are and how they combine, which is the director's
 * job, not the individual's.
 */

const STATE = { IDLE: 0, APPROACH: 1, WINDUP: 2, ATTACK: 3, RECOVER: 4, REPOSITION: 5 };

export function createAiModule() {
  let renderer = null;
  let attached = false;
  let rng = null;
  let ctxRef = null;

  const enemies = [];
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler();

  let waveIndex = 0;
  let waveTimer = 3.0;
  let waveActive = false;
  let waveStartTime = 0;

  const director = { pressure: 0, nextWaveIn: 3.0 };

  const api = {
    enemies,
    waveIndex: 0,
    director,

    spawnEnemy(archetype, x, y) {
      const spec = ARCHETYPES[archetype];
      if (!spec || !ctxRef) return null;
      const mesh = renderer.pools[archetype];
      if (!mesh || mesh.count >= spec.max) return null;

      const e = ctxRef.physics.spawn({
        kind: 'enemy',
        archetype,
        x,
        y,
        hx: spec.hx,
        hy: spec.hy,
        mass: spec.mass,
        team: Team.ENEMY,
        hp: spec.hp,
        gravityScale: archetype === 'flyer' ? 0 : 1,
        faceDir: x > 0 ? -1 : 1,
      });
      if (!e) return null;

      e.poiseMax = spec.poise;
      e.poise = spec.poise;
      if (archetype === 'flyer') e.flags |= Flags.NO_GRAVITY;

      const u = e.userData;
      u.state = STATE.APPROACH;
      u.stateTime = 0;
      u.attackCd = rng.range(0.6, 2.2);
      u.speed = spec.speed * rng.range(0.85, 1.15);
      u.hoverPhase = rng.range(0, 6.28);
      u.preferredRange = archetype === 'sniper' ? rng.range(26, 40)
        : archetype === 'flyer' ? rng.range(9, 16)
        : archetype === 'brute' ? rng.range(3.5, 5)
        : rng.range(4, 9);
      u.flash = 0;
      u.lean = 0;
      u.slot = -1;

      enemies.push(e);
      ctxRef.bus.emit('entity:spawned', { entity: e });
      return e;
    },
  };

  /** One enemy's behaviour for one sim step. */
  function stepEnemy(ctx, e, dt, player) {
    const u = e.userData;
    const spec = ARCHETYPES[e.archetype];

    if (e.hitstun > 0) {
      e.hitstun--;
      // Staggered enemies do nothing but bleed velocity — the window the player
      // is meant to convert into a combo.
      e.vel.x = damp(e.vel.x, 0, 3, dt);
      u.flash = Math.max(u.flash, 0.75);
      return;
    }
    e.flags &= ~Flags.STAGGERED;

    // Poise regenerates slowly, so chip damage alone will not keep an enemy locked.
    if (e.poise < e.poiseMax) e.poise = Math.min(e.poiseMax, e.poise + e.poiseMax * 0.11 * dt);

    if (!player || (player.flags & Flags.DEAD)) return;

    const dx = player.pos.x - e.pos.x;
    const dy = player.pos.y - e.pos.y;
    const dist = Math.abs(dx);
    e.faceDir = sign(dx) || e.faceDir;

    u.stateTime += dt;
    if (u.attackCd > 0) u.attackCd -= dt;

    switch (u.state) {
      case STATE.APPROACH: {
        const want = u.preferredRange;
        const err = dist - want;
        // Deadband stops enemies jittering on the spot at their preferred range.
        if (Math.abs(err) > 1.4) {
          e.vel.x = damp(e.vel.x, sign(err) * sign(dx) * u.speed, 6, dt);
        } else {
          e.vel.x = damp(e.vel.x, 0, 8, dt);
        }

        if (e.archetype === 'flyer') {
          // Hover to the player's altitude with a bobbing offset.
          u.hoverPhase += dt * 2.2;
          const targetY = player.pos.y + 3.2 + Math.sin(u.hoverPhase) * 1.6;
          e.vel.y = damp(e.vel.y, (targetY - e.pos.y) * 2.2, 5, dt);
        }

        if (u.attackCd <= 0 && Math.abs(err) < 3.0 && Math.abs(dy) < 12) {
          u.state = STATE.WINDUP;
          u.stateTime = 0;
        }
        break;
      }

      case STATE.WINDUP: {
        // Telegraph: stop moving and flash before committing.
        e.vel.x = damp(e.vel.x, 0, 10, dt);
        u.flash = Math.max(u.flash, 0.25 + Math.sin(u.stateTime * 40) * 0.2);
        const windup = e.archetype === 'brute' ? 0.62 : e.archetype === 'sniper' ? 0.85 : 0.34;
        if (u.stateTime >= windup) {
          u.state = STATE.ATTACK;
          u.stateTime = 0;
          fireAt(ctx, e, player);
        }
        break;
      }

      case STATE.ATTACK: {
        if (u.stateTime > 0.18) {
          u.state = STATE.RECOVER;
          u.stateTime = 0;
        }
        break;
      }

      case STATE.RECOVER: {
        e.vel.x = damp(e.vel.x, 0, 5, dt);
        const rec = e.archetype === 'brute' ? 0.9 : 0.5;
        if (u.stateTime >= rec) {
          u.state = STATE.APPROACH;
          u.stateTime = 0;
          u.attackCd = rng.range(0.9, 2.6) / (1 + director.pressure * 0.5);
          // Occasionally reposition so a group does not converge into one column.
          u.preferredRange += rng.range(-3, 3);
          u.preferredRange = clamp(u.preferredRange, 3, 44);
        }
        break;
      }
    }

    u.flash = Math.max(0, u.flash - dt * 3.4);
  }

  /** Enemy attack: a projectile or a melee shove, depending on archetype. */
  function fireAt(ctx, e, player) {
    const dx = player.pos.x - e.pos.x;
    const dy = player.pos.y - e.pos.y;
    const m = Math.hypot(dx, dy) || 1;
    const nx = dx / m;
    const ny = dy / m;

    const ox = e.pos.x + nx * (e.size.x + 0.4);
    const oy = e.pos.y + ny * 0.5 + 0.4;

    if (e.archetype === 'brute') {
      // Melee shove — only lands if the player is actually close.
      if (m < e.size.x + 4.2) {
        ctx.combat?.dealDamage?.(e, player, 34, {
          weaponId: 'brute_slam',
          point: { x: player.pos.x, y: player.pos.y },
          normal: { x: nx, y: 0.4 },
          stagger: 0,
          hitstop: 0.05,
          shake: 0.5,
        });
      }
      ctx.vfx?.burst?.('dust', ox, e.pos.y - e.size.y, { amount: 0.9 });
      ctx.bus.emit('camera:shake', { intensity: 0.35, duration: 0.2, freq: 24 });
      return;
    }

    const speed = e.archetype === 'sniper' ? 150 : 62;
    const dmg = e.archetype === 'sniper' ? 42 : 16;
    const p = ctx.physics.spawn({
      kind: 'projectile',
      archetype: 'enemyShot',
      x: ox,
      y: oy,
      vx: nx * speed,
      vy: ny * speed,
      hx: 0.3,
      hy: 0.3,
      team: Team.ENEMY,
      mass: 0.4,
      gravityScale: 0,
      hp: 1,
    });
    if (p) {
      const u = p.userData;
      u.weaponId = 'enemyShot';
      u.ownerId = e.id;
      u.damage = dmg;
      u.stagger = 0;
      u.launch = 0;
      u.hitstop = 0.02;
      u.shake = 0.12;
      u.life = 2.4;
      u.homingDelay = Infinity;
    }

    ctx.bus.emit('weapon:fired', {
      weaponId: 'enemyShot',
      slot: 'both',
      origin: { x: ox, y: oy },
      dir: { x: nx, y: ny },
    });
    if (e.archetype === 'sniper') {
      ctx.vfx?.beam?.(ox, oy, ox + nx * 60, oy + ny * 60, {
        color: 0xff5a8a,
        width: 0.2,
        life: 0.07,
      });
    }
  }

  /** Wave composition scales with the wave index. */
  function startWave(ctx) {
    waveIndex++;
    api.waveIndex = waveIndex;
    waveActive = true;
    waveStartTime = ctx.time.elapsed;

    const n = Math.min(14, 3 + Math.floor(waveIndex * 1.4));
    const px = ctx.combat?.player?.pos?.x ?? 0;

    for (let i = 0; i < n; i++) {
      // Spawn off both sides, outside the camera, so they walk into frame.
      const side = rng.bool() ? 1 : -1;
      const x = clamp(px + side * rng.range(30, 56), -115, 115);

      let type = 'grunt';
      const r = rng.float();
      if (waveIndex >= 2 && r > 0.82) type = 'sniper';
      else if (waveIndex >= 3 && r > 0.68) type = 'flyer';
      else if (waveIndex >= 4 && r > 0.60) type = 'brute';

      const y = type === 'flyer' ? rng.range(9, 17) : 6;
      api.spawnEnemy(type, x, y);
    }

    ctx.bus.emit('wave:started', { index: waveIndex, count: n });
    ctx.hud?.notify?.(`WAVE ${waveIndex}`, 'wave');
  }

  return {
    name: 'ai',
    order: 35,

    init(ctx) {
      ctxRef = ctx;
      rng = ctx.rng.fork();
      renderer = buildEnemyRenderer();

      ctx.bus.on('entity:died', (p) => {
        const i = enemies.indexOf(p.entity);
        if (i >= 0) enemies.splice(i, 1);
      });

      ctx.ai = api;
    },

    fixed(ctx, dt) {
      const player = ctx.combat?.player;

      // Remove dead references before iterating.
      for (let i = enemies.length - 1; i >= 0; i--) {
        if (!enemies[i] || enemies[i].flags & Flags.DEAD) enemies.splice(i, 1);
      }

      for (let i = 0; i < enemies.length; i++) stepEnemy(ctx, enemies[i], dt, player);

      // --- director ---
      director.pressure = clamp(enemies.length / 12, 0, 1);
      if (waveActive && enemies.length === 0) {
        waveActive = false;
        waveTimer = 3.4;
        ctx.bus.emit('wave:cleared', {
          index: waveIndex,
          timeTaken: ctx.time.elapsed - waveStartTime,
        });
      }
      if (!waveActive) {
        waveTimer -= dt;
        director.nextWaveIn = waveTimer;
        if (waveTimer <= 0) startWave(ctx);
      }

      ctx.audio?.setMusicIntensity?.(clamp(0.25 + director.pressure * 0.75, 0, 1));
    },

    frame(ctx, dt, alpha) {
      if (!attached && ctx.scene) {
        ctx.scene.add(renderer.group);
        attached = true;
      }

      // Reset instance counts, then repack live enemies per archetype. Repacking
      // each frame keeps the instance buffer dense as enemies die in any order.
      for (const name in renderer.pools) renderer.pools[name].count = 0;

      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e || e.flags & Flags.DEAD) continue;
        const mesh = renderer.pools[e.archetype];
        if (!mesh || mesh.count >= ARCHETYPES[e.archetype].max) continue;
        const idx = mesh.count++;
        const u = e.userData;

        const x = e.prev.x + (e.pos.x - e.prev.x) * alpha;
        const y = e.prev.y + (e.pos.y - e.prev.y) * alpha;

        // Lean into horizontal motion, and bob if airborne.
        u.lean = damp(u.lean, clamp(e.vel.x / 26, -0.35, 0.35), 8, dt);
        const bob = e.archetype === 'flyer' ? Math.sin(u.hoverPhase * 1.6) * 0.12 : 0;

        pos.set(x, y - e.size.y + bob, e.z || 0);
        euler.set(
          u.lean * 0.3,
          e.faceDir >= 0 ? 0 : Math.PI,
          -u.lean,
          'YXZ'
        );
        quat.setFromEuler(euler);
        // Squash slightly while staggered so a broken enemy reads instantly.
        const sq = 1 - Math.min(0.16, u.flash * 0.18);
        scl.set(1, sq, 1);
        m4.compose(pos, quat, scl);
        mesh.setMatrixAt(idx, m4);

        // Flash toward white on hit.
        const f = u.flash;
        const c = mesh.instanceColor.array;
        c[idx * 3] = 1 + f * 2.2;
        c[idx * 3 + 1] = 1 + f * 1.9;
        c[idx * 3 + 2] = 1 + f * 1.9;
      }

      for (const name in renderer.pools) {
        const mesh = renderer.pools[name];
        if (mesh.count > 0) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.needsUpdate = true;
        }
      }
    },

    dispose() {
      renderer?.dispose();
      enemies.length = 0;
    },
  };
}
