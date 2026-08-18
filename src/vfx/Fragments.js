import * as THREE from 'three';
import { makeContactShadowTexture } from '../combat/MechMaterials.js';

/**
 * Rigid impact fragments.
 *
 * The particle system already throws debris on a heavy hit, and a blind review still
 * reported that nothing in the frame was in flight. It was right: soft radial
 * billboards 0.2 units across read as dust, and dust does not say a mech was just
 * hit by something heavy. Chunks of armour arcing away from the impact do.
 *
 * So these are geometry — an instanced jagged chunk with real angular velocity, real
 * gravity, and a real bounce off the terrain — lit by the scene rather than emissive,
 * because a lit fragment tumbling through a magenta pool picks up the pool and an
 * emissive one does not.
 *
 * Each fragment also drops a contact decal on the ground beneath it, scaled and faded
 * by altitude. That is what actually sells flight in a still image: a viewer reads
 * height from the gap between an object and its shadow, and with no shadow a fragment
 * two metres up is indistinguishable from one lying on the road.
 *
 * Two draw calls for the whole system.
 */

const MAX = 96;

function makeChunkGeometry(seed = 7) {
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const pos = g.attributes.position;
  // A deterministic jitter, so the chunk is angular rather than a ball. Shared by
  // every instance — at this size and this speed nobody resolves the repetition.
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * (0.5 + rnd() * 1.0),
      pos.getY(i) * (0.4 + rnd() * 0.8),
      pos.getZ(i) * (0.5 + rnd() * 1.0)
    );
  }
  g.computeVertexNormals();
  return g;
}

export class Fragments {
  constructor() {
    this.geo = makeChunkGeometry();
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x6a7280,
      roughness: 0.78,
      metalness: 0.35,
      envMapIntensity: 1.0,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX);
    this.mesh.name = 'vfx.fragments';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;

    this.shadowTex = makeContactShadowTexture(64);
    this.shadowGeo = new THREE.PlaneGeometry(1, 1);
    this.shadowGeo.rotateX(-Math.PI / 2);
    this.shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: this.shadowTex,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      // PlaneGeometry faces +Z and the -90 deg rotation aims that face into the road,
      // so without DoubleSide only the culled back face is toward the camera.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
      fog: true,
    });
    this.shadows = new THREE.InstancedMesh(this.shadowGeo, this.shadowMat, MAX);
    this.shadows.name = 'vfx.fragmentShadows';
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 4;
    this.shadows.count = 0;

    // Struct of arrays, so a burst never allocates.
    this.n = 0;
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.z = new Float32Array(MAX);
    this.vx = new Float32Array(MAX);
    this.vy = new Float32Array(MAX);
    this.vz = new Float32Array(MAX);
    this.rx = new Float32Array(MAX);
    this.ry = new Float32Array(MAX);
    this.rz = new Float32Array(MAX);
    this.wx = new Float32Array(MAX);
    this.wy = new Float32Array(MAX);
    this.wz = new Float32Array(MAX);
    this.s = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.rest = new Uint8Array(MAX);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._sc = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /**
   * @param {number} x  world x of the impact
   * @param {number} y  world y of the impact
   * @param {object} o  { amount, dirX, dirY, rng }
   */
  burst(x, y, o = {}) {
    const amount = o.amount ?? 1;
    const rnd = o.rng ?? Math.random;
    const count = Math.min(MAX - this.n, Math.round(5 + 9 * amount));
    for (let k = 0; k < count; k++) {
      const i = this.n++;
      const a = rnd() * Math.PI * 2;
      // Biased upward and away from the impact normal: fragments come OFF a surface,
      // they do not spray evenly in a sphere.
      //
      // Speed is capped hard. The first version reached 43 u/s vertically on a heavy
      // hit, which against gravity of -34 apexes at 27 units — armour chips clearing
      // the rooftops and reading as dark specks against the skyline. Worse, the
      // contact decal that makes their height legible fades out above six units, so
      // the fragments that most needed the cue were the ones without it. Two to five
      // metres is what comes off a mech.
      const sp = 5 + rnd() * 9 * (0.5 + amount * 0.5);
      this.x[i] = x + (rnd() - 0.5) * 0.8;
      this.y[i] = y + (rnd() - 0.5) * 0.8;
      this.z[i] = (rnd() - 0.5) * 1.2;
      this.vx[i] = Math.cos(a) * sp * 0.7 + (o.dirX ?? 0) * sp * 0.5;
      this.vy[i] = Math.abs(Math.sin(a)) * sp * 0.8 + 4 + (o.dirY ?? 0) * sp * 0.25;
      this.vz[i] = (rnd() - 0.5) * 7;
      this._e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
      this.rx[i] = this._e.x;
      this.ry[i] = this._e.y;
      this.rz[i] = this._e.z;
      this.wx[i] = (rnd() - 0.5) * 15;
      this.wy[i] = (rnd() - 0.5) * 15;
      this.wz[i] = (rnd() - 0.5) * 15;
      this.s[i] = 0.22 + rnd() * 0.42;
      this.maxLife[i] = 1.3 + rnd() * 1.4;
      this.life[i] = this.maxLife[i];
      this.rest[i] = 0;
    }
  }

  /**
   * @param {number} dt
   * @param {(x:number)=>number} groundAt terrain height sampler
   */
  update(dt, groundAt) {
    const G = -34;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._swap(i, --this.n);
        i--;
        continue;
      }
      if (this.rest[i]) continue;

      this.vy[i] += G * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.rx[i] += this.wx[i] * dt;
      this.ry[i] += this.wy[i] * dt;
      this.rz[i] += this.wz[i] * dt;

      const gy = (groundAt ? groundAt(this.x[i]) : 0) + this.s[i] * 0.4;
      if (this.y[i] <= gy) {
        this.y[i] = gy;
        if (Math.abs(this.vy[i]) < 3.5) {
          // Settled. Fragments that come to rest keep their pose and stop costing
          // anything until they expire, which is what lets the pool stay small.
          this.rest[i] = 1;
          this.vx[i] = this.vy[i] = this.vz[i] = 0;
        } else {
          this.vy[i] = -this.vy[i] * 0.34;
          this.vx[i] *= 0.6;
          this.vz[i] *= 0.6;
          this.wx[i] *= 0.5;
          this.wy[i] *= 0.5;
          this.wz[i] *= 0.5;
        }
      }
    }
    this._write(groundAt);
  }

  _swap(to, from) {
    if (to === from) return;
    const F = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'rx', 'ry', 'rz', 'wx', 'wy', 'wz', 's', 'life', 'maxLife', 'rest'];
    for (const f of F) this[f][to] = this[f][from];
  }

  _write(groundAt) {
    for (let i = 0; i < this.n; i++) {
      const fade = Math.min(1, this.life[i] / 0.35);
      const sc = this.s[i] * fade;
      this._e.set(this.rx[i], this.ry[i], this.rz[i]);
      this._q.setFromEuler(this._e);
      this._p.set(this.x[i], this.y[i], this.z[i]);
      this._sc.setScalar(sc);
      this.mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._sc));

      // Contact decal. Height above the terrain drives both size and opacity, so a
      // fragment at the top of its arc has a wide faint smudge far below it and one
      // about to land has a tight dark one right under it.
      const gy = groundAt ? groundAt(this.x[i]) : 0;
      const h = Math.max(0, this.y[i] - gy);
      const k = Math.max(0, 1 - h / 6);
      this._p.set(this.x[i], gy + 0.035, this.z[i]);
      this._q.setFromAxisAngle(this._up, this.ry[i]);
      this._sc.set(sc * (3.2 + h * 0.6) * (0.35 + k * 0.65), 1, sc * (3.2 + h * 0.6) * (0.35 + k * 0.65));
      this.shadows.setMatrixAt(i, this._m.compose(this._p, this._q, this._sc));
    }
    this.mesh.count = this.n;
    this.shadows.count = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.shadows.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.shadowGeo.dispose();
    this.shadowMat.dispose();
    this.shadowTex.dispose();
  }
}
