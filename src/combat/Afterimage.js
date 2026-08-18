import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE } from '../render/Palette.js';

/**
 * Dash afterimages.
 *
 * A still frame of this game had no way to say that anything was moving. Motion blur
 * only smears what the *camera* passes over, the tracers vanish the instant a shot
 * lands, and a review looking at a frame reading 698 DMG could not tell whether the
 * mech was mid-combo or standing still. Speed has to leave evidence in the frame.
 *
 * The obvious implementation — clone the mech and replay its pose history — costs 18
 * draw calls per ghost, which at six ghosts is more than half the frame's entire
 * budget for an effect that is on screen for a third of a second. Instead this keeps
 * one merged low-poly proxy of the mech's mass and instances it along the position
 * history: every ghost in the trail is a single draw call, total.
 *
 * The proxy does not follow the animated pose, and that is fine — at dash speed each
 * ghost is on screen for under 200 ms at 20% opacity. What reads is the silhouette
 * and the direction it came from, and both survive the approximation.
 *
 * Per-ghost fade goes through `instanceColor` rather than opacity, because opacity is
 * a material uniform and cannot vary per instance. Additive blending makes that work
 * out exactly: the result is `dst + colour`, so scaling the instance colour toward
 * black scales the ghost toward invisible.
 */

const MAX_GHOSTS = 7;
/** Ghosts are laid along this much of the recent past, in seconds. */
const TRAIL_SECONDS = 0.26;
/** Below this speed (u/s) the trail is not drawn at all — walking must not smear. */
const SPEED_ON = 26;
const SPEED_FULL = 62;

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/**
 * A merged block-out of the mech's mass, in mech-root local space. Deliberately
 * coarse: it is never seen at full opacity and never seen still.
 */
function buildProxyGeometry(M) {
  const hipY = M.hipY;
  const parts = [
    // torso + backpack
    box(1.5, 1.5, 1.0, 0, hipY + 0.75, 0),
    box(1.15, 0.7, 0.72, 0, hipY + 1.55, -0.42),
    // head
    box(0.6, 0.52, 0.62, 0, hipY + 1.72, 0.06),
    // shoulders
    box(0.66, 0.7, 0.74, -0.92, hipY + 1.16, 0),
    box(0.66, 0.7, 0.74, 0.92, hipY + 1.16, 0),
    // arms, hanging
    box(0.44, 1.3, 0.46, -1.0, hipY + 0.25, 0.1),
    box(0.44, 1.3, 0.46, 1.0, hipY + 0.25, 0.1),
    // hips
    box(1.2, 0.55, 0.86, 0, hipY - 0.1, 0),
    // legs, near rest pose
    box(0.56, M.thigh + 0.1, 0.6, -0.42, hipY - 0.62, 0.04),
    box(0.56, M.thigh + 0.1, 0.6, 0.42, hipY - 0.62, 0.04),
    box(0.5, M.shin + 0.1, 0.54, -0.42, hipY - 1.5, -0.02),
    box(0.5, M.shin + 0.1, 0.54, 0.42, hipY - 1.5, -0.02),
    // feet
    box(0.6, 0.28, 0.9, -0.42, 0.16, 0.08),
    box(0.6, 0.28, 0.9, 0.42, 0.16, 0.08),
  ];
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

export class Afterimage {
  constructor(metrics) {
    this.geo = buildProxyGeometry(metrics);
    this.mat = new THREE.MeshBasicMaterial({
      color: PALETTE.cyan,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX_GHOSTS);
    this.mesh.name = 'combat.afterimage';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.count = 0;
    // Allocating the colour attribute up front means the first dash does not stall
    // on a buffer creation in the middle of the effect it is meant to sell.
    this.mesh.setColorAt(0, new THREE.Color(0, 0, 0));

    /** Ring buffer of recent poses. */
    this._hist = [];
    this._acc = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * @param {object} e     player entity (world position in pos.x / pos.y)
   * @param {number} yaw   mech root rotation.y this frame
   * @param {number} speed metres per second
   * @param {number} dt    frame seconds
   */
  update(e, yaw, speed, dt) {
    const t = (this._t = (this._t ?? 0) + dt);
    // Sample at a fixed rate rather than per frame, so trail *length* is a property
    // of the dash and not of the machine's framerate — the same mistake motion blur
    // made before it was moved onto a fixed shutter.
    this._acc += dt;
    const STEP = TRAIL_SECONDS / MAX_GHOSTS;
    if (this._acc >= STEP) {
      this._acc = 0;
      this._hist.unshift({ x: e.pos.x, y: e.pos.y, yaw, t });
      if (this._hist.length > MAX_GHOSTS) this._hist.length = MAX_GHOSTS;
    }

    const gain = THREE.MathUtils.clamp((speed - SPEED_ON) / (SPEED_FULL - SPEED_ON), 0, 1);
    if (gain <= 0.001 || this._hist.length < 2) {
      this.mesh.count = 0;
      return;
    }

    let n = 0;
    for (let i = 1; i < this._hist.length; i++) {
      const h = this._hist[i];
      const age = t - h.t;
      const k = 1 - age / TRAIL_SECONDS;
      if (k <= 0) continue;
      // Squared falloff: the ghost nearest the mech is nearly solid and the tail
      // disappears fast, which reads as a direction rather than as a smear.
      const f = k * k * gain * 0.42;
      this._p.set(h.x, h.y, 0);
      this._q.setFromAxisAngle(this._up, h.yaw);
      // Ghosts shrink slightly with age so the trail tapers.
      this._s.setScalar(0.94 + k * 0.06);
      this.mesh.setMatrixAt(n, this._m.compose(this._p, this._q, this._s));
      this.mesh.setColorAt(n, this._c.setRGB(f, f, f));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose?.();
  }
}
