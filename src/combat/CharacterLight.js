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
    this.key.position.set(-3.2, 5.4, 5.0);
    this.group.add(this.key);

    // Rim: hot magenta from behind and below, opposite the key. This is the light
    // that actually separates the silhouette from the background.
    this.rim = new THREE.PointLight(PALETTE.rimLight, 330, 15, 2);
    this.rim.position.set(3.0, 2.6, -4.2);
    this.group.add(this.rim);

    // A weak cyan kicker on the opposite side keeps the dark side from going flat.
    this.kick = new THREE.PointLight(PALETTE.cyan, 120, 12, 2);
    this.kick.position.set(-3.4, 1.2, -3.0);
    this.group.add(this.kick);

    this._boost = 0;
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
    this.key.position.x = -3.2 * s;
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
