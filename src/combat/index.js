import { createMech } from './MechModel.js';
import { PlayerController } from './PlayerController.js';
import { MechAnimator } from './MechAnimator.js';
import { CharacterLight } from './CharacterLight.js';
import { Team } from '../core/Flags.js';

/**
 * Combat module (order 30).
 *
 * Owns the player mech: its entity, its view, its movement, and its animation.
 * Weapons and the combo system attach here as they come online.
 */
export function createCombatModule() {
  let player = null;
  let mech = null;
  let controller = null;
  let animator = null;
let charLight = null;
  let attached = false;

  const combo = { count: 0, damage: 0, timeLeft: 0, rank: 'D' };

  const api = {
    get player() { return player; },
    get mech() { return mech; },
    get controller() { return controller; },
    combo,
    lockTarget: null,
    loadout: { ground: ['rifle', 'shotgun', 'saber', 'missile'], air: ['rifle', 'gatling', 'saber', 'missile'] },
    weapons: new Map(),

    /** Energy as a 0..1 fraction, for the HUD. */
    get enFrac() {
      return controller ? controller.en / 100 : 0;
    },
  };

  return {
    name: 'combat',
    order: 30,

    init(ctx) {
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
        hy: 2.0, // 4 units tall, per the architecture contract
        mass: 8,
        team: Team.PLAYER,
        hp: 1000,
        faceDir: 1,
      });

      mech = createMech();
      controller = new PlayerController(player, ctx.bus);
      animator = new MechAnimator(mech);
      charLight = new CharacterLight();
      player.view = mech.root;

      ctx.combat = api;
    },

    fixed(ctx, dt) {
      if (!player || !controller) return;
      controller.step(ctx, dt);
      // Sampled here so the animator can place the contact shadow without doing
      // its own terrain query on the render thread.
      controller.groundY = ctx.world?.groundHeightAt?.(player.pos.x) ?? 0;

      if (combo.timeLeft > 0) {
        combo.timeLeft -= dt;
        if (combo.timeLeft <= 0) {
          ctx.bus.emit('combo:ended', { count: combo.count, damage: combo.damage, rank: combo.rank });
          combo.count = 0;
          combo.damage = 0;
          combo.rank = 'D';
        }
      }
    },

    frame(ctx, dt, alpha) {
      if (!player || !mech) return;

      // The scene belongs to render (order 90), so attach on the first frame that
      // it exists rather than reaching across module init order.
      if (!attached && ctx.scene) {
        ctx.scene.add(mech.root);
        ctx.scene.add(charLight.group);
        mech.syncEnvironment?.(ctx.scene);
        ctx.render?.setCameraTarget?.(player);
        attached = true;
      }

      animator.update(player, controller, dt, alpha);
      charLight.update(player, dt, animator.thrust);
      ctx.render?.setDashIntensity?.(controller.dashIntensity);
    },

    dispose(ctx) {
      if (mech?.root?.parent) mech.root.parent.remove(mech.root);
      mech?.dispose?.();
    },
  };
}
