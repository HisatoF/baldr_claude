import * as THREE from 'three';
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

const MAX_GHOSTS = 11;
/** Ghosts are laid along this much of the recent past, in seconds. */
const TRAIL_SECONDS = 0.34;
/** Below this speed (u/s) the trail is not drawn at all — walking must not smear. */
const SPEED_ON = 30;
const SPEED_FULL = 54;

/**
 * The ghost's shape: one soft-edged, camera-facing lozenge, not a model.
 *
 * A merged box block-out of the mech's mass was tried first and is the obvious
 * implementation — one draw call for the whole trail, roughly the right silhouette.
 * It reads as a stack of translucent cubes. Overlapping three of them 0.85 units
 * apart produces a glass slab beside the machine, and no amount of dimming fixes
 * that, because the failure is that the geometry is *legible*. An afterimage is a
 * smear; the instant a viewer can resolve it into shapes it has stopped being one.
 *
 * So the ghost is a soft mask with the machine's proportions and none of its detail.
 * The quad faces +Z, which is where the camera is in this fixed quarter view.
 */
function makeGhostTexture(size = 128) {
  const c =
    typeof document !== 'undefined'
      ? Object.assign(document.createElement('canvas'), { width: size, height: size })
      : null;
  if (!c) return null;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  // A vertical lozenge: wider at the torso, tapering at head and feet, with the
  // edges falling all the way to black so there is never a hard boundary.
  const grad = g.createRadialGradient(size * 0.5, size * 0.46, 0, size * 0.5, size * 0.46, size * 0.5);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(150,150,150,1)');
  grad.addColorStop(0.78, 'rgba(38,38,38,1)');
  grad.addColorStop(1.0, 'rgba(0,0,0,1)');
  g.save();
  g.translate(size * 0.5, size * 0.46);
  g.scale(0.84, 1.0);
  g.translate(-size * 0.5, -size * 0.46);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class Afterimage {
  constructor(metrics) {
    const h = (metrics?.hipY ?? 2.02) + 2.0;
    this.geo = new THREE.PlaneGeometry(2.9, h);
    this.geo.translate(0, h * 0.5, 0);
    this.tex = makeGhostTexture(128);
    this.mat = new THREE.MeshBasicMaterial({
      color: PALETTE.cyan,
      alphaMap: this.tex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
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
    const gain = THREE.MathUtils.clamp((speed - SPEED_ON) / (SPEED_FULL - SPEED_ON), 0, 1);

    // Sampled by DISTANCE TRAVELLED, not by elapsed time.
    //
    // A fixed sample clock is framerate-independent, which is why it was the first
    // thing tried, but it makes the trail's density depend on how long the dash has
    // been running: a dash is 0.17 s and the clock ticks every 0.037 s, so for the
    // first third of every dash there is essentially no trail at all — exactly the
    // part of the move that most needs to read as fast. Spacing ghosts every 1.6
    // units of travel is framerate-independent for the same reason (distance is not
    // a function of frame count) and gives a full trail from the first frame the
    // machine is moving quickly.
    const dx = e.pos.x - (this._lx ?? e.pos.x);
    const dy = e.pos.y - (this._ly ?? e.pos.y);
    this._lx = e.pos.x;
    this._ly = e.pos.y;
    this._acc += Math.hypot(dx, dy);
    // Close spacing. At 1.6 units the first dash frames produced a single sample,
    // and since the newest sample sits on top of the mech and was being skipped, the
    // trail was empty for most of the move it exists to describe.
    const STEP = 0.55;
    if (this._acc >= STEP) {
      this._acc = 0;
      // Strength is recorded WITH the sample, not read from the current speed.
      //
      // Reading it live meant the whole trail vanished on the frame the dash ended,
      // which is the frame a trail is most worth having: a dash is 0.17 s long and
      // the ghosts are supposed to outlive it. Each ghost now remembers how fast the
      // machine was going when it was there.
      // FEET, not centre. The proxy geometry is authored in mech-root local space,
      // where the origin is the sole of the foot (MechAnimator sets the root to
      // `pos.y - size.y`). Recording `pos.y` put every ghost a half-height above the
      // machine — a translucent slab hanging in the air beside it.
      this._hist.unshift({ x: e.pos.x, y: e.pos.y - e.size.y, yaw, t, g: gain });
      if (this._hist.length > MAX_GHOSTS) this._hist.length = MAX_GHOSTS;
    }

    if (this._hist.length < 2) {
      this.mesh.count = 0;
      return;
    }

    let n = 0;
    // Skip the newest sample: at 0.85-unit spacing it sits inside the mech's own
    // volume, and an additive ghost drawn there just makes the machine glow.
    for (let i = 1; i < this._hist.length; i++) {
      const h = this._hist[i];
      const age = t - h.t;
      const k = 1 - age / TRAIL_SECONDS;
      if (k <= 0) continue;
      // Cubed falloff at low amplitude. At 0.42 with a square falloff this was the
      // brightest thing in the frame — a solid cyan mass sitting beside the mech,
      // and since the proxy is a box block-out, a solid one reads as a stack of
      // cubes rather than as a smear of motion. An afterimage is a hint; the moment
      // it is legible as geometry it has failed.
      const f = k * k * (h.g ?? 0) * 0.34;
      if (f <= 0.002) continue;
      this._p.set(h.x, h.y, 0);
      this._q.setFromAxisAngle(this._up, h.yaw);
      // Ghosts shrink slightly with age so the trail tapers.
      this._s.set(0.86 + k * 0.2, 0.94 + k * 0.08, 1);
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
    this.tex?.dispose();
    this.mesh.dispose?.();
  }
}
