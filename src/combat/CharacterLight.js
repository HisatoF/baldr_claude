import * as THREE from 'three';
import { PALETTE } from '../render/Palette.js';
import { damp } from '../core/MathUtil.js';

/**
 * A lighting rig that travels with the mech.
 *
 * World lighting alone cannot do this job. The environment is a night city, so a
 * physically-correct result is a mech that reads as a black silhouette — which is
 * exactly what the rubric rejects, because the player character must hold the
 * highest local contrast in a frame full of competing neon.
 *
 * So the mech carries its own small rig, the way a shot in a film is lit for the
 * actor rather than for the room. The lights are short-range, so they read as
 * bounce off nearby surfaces rather than as a floating sun, and they spill onto the
 * ground under the mech, which helps ground it.
 *
 * Intensities look enormous because three.js uses physical light units: a point
 * light's contribution falls off as 1/r², so an intensity of ~30 at a 5-unit
 * standoff delivers barely one lux and lights nothing at all.
 */
export class CharacterLight {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'combat.characterLight';

    // Key: cool and high, from the same side as the world key so the two agree.
    this.key = new THREE.PointLight(PALETTE.keyLight, 340, 17, 2);
    // High and close to overhead. Slung low it flooded the road directly beneath
    // the mech, and since point lights here cast no shadow, that fill washed out the
    // contact shadow and undid the grounding it exists to provide.
    this.key.position.set(-2.4, 8.2, 3.4);
    this.group.add(this.key);

    // Rim: hot magenta from behind and below, opposite the key. This is the light
    // that actually separates the silhouette from the background.
    this.rim = new THREE.PointLight(PALETTE.rimLight, 330, 15, 2);
    this.rim.position.set(3.0, 3.4, -4.6);
    this.group.add(this.rim);

    // A weak cyan kicker on the opposite side keeps the dark side from going flat.
    this.kick = new THREE.PointLight(PALETTE.cyan, 120, 12, 2);
    this.kick.position.set(-3.4, 1.2, -3.0);
    this.group.add(this.kick);

    this._boost = 0;

    // --- threat light -------------------------------------------------------
    // A shadow-casting spot that rides the nearest hostile and aims at the player.
    //
    // Emissive materials are not light sources: the enemy's magenta glow lights
    // nothing and casts nothing, so a review correctly reported that the mech throws
    // no shadow despite standing next to the brightest thing on screen. This stands
    // in for that glow — one spot light, one shadow map, aimed along the axis the
    // player actually cares about, so the mech's shadow moves when the threat moves.
    //
    // It lives outside `group` because it is positioned in world space at the enemy,
    // not relative to the mech.
    this.threat = new THREE.SpotLight(PALETTE.magenta, 0, 46, 0.72, 0.55, 1.6);
    this.threat.castShadow = true;
    this.threat.shadow.mapSize.set(1024, 1024);
    this.threat.shadow.camera.near = 1.5;
    this.threat.shadow.camera.far = 52;
    this.threat.shadow.bias = -0.0016;
    this.threat.shadow.normalBias = 0.03;
    this.threatTarget = new THREE.Object3D();
    this.root = new THREE.Group();
    this.root.name = 'combat.threatLight';
    this.root.add(this.threat, this.threatTarget);
    this.threat.target = this.threatTarget;
  }

  /**
   * Aim the threat light from `source` at `player`. Pass a null source to fade it out.
   */
  updateThreat(player, source, dt) {
    const t = this.threat;
    if (!source || !player) {
      t.intensity = damp(t.intensity, 0, 6, dt);
      return;
    }
    // Sit slightly above the hostile so the shadow rakes across the ground rather
    // than shooting straight out at ankle height.
    t.position.set(source.pos.x, source.pos.y + (source.size?.y ?? 1) * 0.8 + 1.2, (source.z || 0) + 1.5);
    this.threatTarget.position.set(player.pos.x, player.pos.y - 0.5, player.z || 0);
    this.threatTarget.updateMatrixWorld();

    // Only worth paying for when the threat is close enough to matter.
    const d = Math.hypot(source.pos.x - player.pos.x, source.pos.y - player.pos.y);
    const want = d < 34 ? 620 * (1 - d / 34) : 0;
    t.intensity = damp(t.intensity, want, 8, dt);
  }

  /**
   * Flash the rig brighter — used on impacts and weapon discharge.
   *
   * Takes the max rather than summing. Adding each pulse meant that during a combo,
   * where hits land faster than the boost decays, the value pinned at its ceiling
   * and left the rim light running near 900 intensity permanently — which washed the
   * entire scene white and read as a bug, not as impact.
   */
  pulse(amount) {
    this._boost = Math.max(this._boost, Math.min(amount, 0.85));
  }

  /**
   * @param {object} e   player entity
   * @param {number} dt
   * @param {number} thrust 0..1 boost amount, tints the rig hotter
   */
  update(e, dt, thrust = 0) {
    this.group.position.set(e.pos.x, e.pos.y - e.size.y, e.z || 0);

    // Mirror the rig when the mech turns, so the key stays on the facing side and
    // the rim stays behind rather than swapping into the camera.
    const s = e.faceDir >= 0 ? 1 : -1;
    this.key.position.x = -2.4 * s;
    this.rim.position.x = 3.0 * s;
    this.kick.position.x = -3.4 * s;

    this._boost = damp(this._boost, 0, 8, dt);
    const b = 1 + this._boost + thrust * 0.5;

    this.key.intensity = 340 * b;
    this.rim.intensity = 330 * b;
    this.kick.intensity = 120 * (1 + thrust * 1.4);
  }

  dispose() {
    this.group.clear();
  }
}
