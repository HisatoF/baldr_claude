import * as THREE from 'three';

/**
 * Pooled GPU particle system.
 *
 * Every particle in the game — sparks, smoke, debris, muzzle flash, dust — lives in
 * one of these and renders in a single draw call. State is kept in flat typed arrays
 * and uploaded as instanced attributes, so emitting a thousand particles during a
 * combo allocates nothing.
 *
 * Particles are drawn as camera-facing quads via a custom shader rather than
 * THREE.Points, because Points cannot be rotated, cannot be stretched along their
 * velocity, and clamp to a driver-dependent maximum size. Streaked sparks are most of
 * what makes a hit read as fast, and that needs stretching.
 */

/** Soft radial sprite, generated rather than loaded. */
function makeParticleTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // A soft core with a long tail reads far better under additive blending than a
  // hard-edged disc, which bands visibly when many overlap.
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.72)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec4 iColor;      // rgb + alpha
  attribute vec3 iParams;     // x: size, y: stretch, z: spin

  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    vColor = iColor;
    vUv = uv;

    float size = iParams.x;
    float stretch = iParams.y;
    float spin = iParams.z;

    // Build the quad in view space so it always faces the camera.
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);

    vec2 corner = position.xy;

    // Spin
    float cs = cos(spin), sn = sin(spin);
    corner = vec2(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs);

    // Stretch along the view-space velocity direction. This is what turns a dot
    // into a tracer; without it fast sparks strobe as discrete points.
    vec3 velView = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    float vlen = length(velView.xy);
    if (vlen > 0.0001 && stretch > 0.0) {
      vec2 dir = velView.xy / vlen;
      vec2 perp = vec2(-dir.y, dir.x);
      float along = 1.0 + stretch * min(vlen, 60.0) * 0.05;
      corner = dir * (corner.y * along) + perp * corner.x;
    }

    mv.xy += corner * size;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    vec4 t = texture2D(uMap, vUv);
    gl_FragColor = vec4(vColor.rgb * t.a * vColor.a, t.a * vColor.a);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

export class ParticleSystem {
  /**
   * @param {number} capacity max simultaneous particles
   * @param {object} opts
   */
  constructor(capacity = 2400, opts = {}) {
    this.capacity = capacity;
    this.count = 0;

    // --- CPU state, flat and preallocated ---
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.spinVel = new Float32Array(capacity);
    this.stretch = new Float32Array(capacity);
    this.r0 = new Float32Array(capacity);
    this.g0 = new Float32Array(capacity);
    this.b0 = new Float32Array(capacity);
    this.r1 = new Float32Array(capacity);
    this.g1 = new Float32Array(capacity);
    this.b1 = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.bounce = new Uint8Array(capacity);

    // --- GPU attributes ---
    this.aPos = new Float32Array(capacity * 3);
    this.aVel = new Float32Array(capacity * 3);
    this.aColor = new Float32Array(capacity * 4);
    this.aParams = new Float32Array(capacity * 3);

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    quad.dispose();

    this._iPos = new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage);
    this._iVel = new THREE.InstancedBufferAttribute(this.aVel, 3).setUsage(THREE.DynamicDrawUsage);
    this._iColor = new THREE.InstancedBufferAttribute(this.aColor, 4).setUsage(THREE.DynamicDrawUsage);
    this._iParams = new THREE.InstancedBufferAttribute(this.aParams, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this._iPos);
    geo.setAttribute('iVel', this._iVel);
    geo.setAttribute('iColor', this._iColor);
    geo.setAttribute('iParams', this._iParams);
    geo.instanceCount = 0;
    // The playfield is a corridor; a bounding sphere that covers it stops the whole
    // system from being culled when the emitter happens to sit off-camera.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 400);

    this.texture = opts.texture || makeParticleTexture(64);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.blending ?? THREE.AdditiveBlending,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.name = opts.name || 'vfx.particles';

    this._geo = geo;
    this.groundY = 0;
  }

  /**
   * Emit one particle. Returns false when the pool is exhausted — callers should
   * not treat that as an error; dropping particles under load is correct behaviour.
   */
  emit(p) {
    if (this.count >= this.capacity) return false;
    const i = this.count++;

    this.px[i] = p.x;
    this.py[i] = p.y;
    this.pz[i] = p.z || 0;
    this.vx[i] = p.vx || 0;
    this.vy[i] = p.vy || 0;
    this.vz[i] = p.vz || 0;
    this.maxLife[i] = p.life;
    this.life[i] = p.life;
    this.size0[i] = p.size0;
    this.size1[i] = p.size1 !== undefined ? p.size1 : p.size0;
    this.drag[i] = p.drag || 0;
    this.grav[i] = p.grav || 0;
    this.spin[i] = p.spin || 0;
    this.spinVel[i] = p.spinVel || 0;
    this.stretch[i] = p.stretch || 0;
    this.r0[i] = p.r0; this.g0[i] = p.g0; this.b0[i] = p.b0;
    this.r1[i] = p.r1 !== undefined ? p.r1 : p.r0;
    this.g1[i] = p.g1 !== undefined ? p.g1 : p.g0;
    this.b1[i] = p.b1 !== undefined ? p.b1 : p.b0;
    this.alpha0[i] = p.alpha !== undefined ? p.alpha : 1;
    this.bounce[i] = p.bounce ? 1 : 0;
    return true;
  }

  /**
   * Advance and upload. Dead particles are removed by swapping the last live one
   * into the hole, which keeps the array dense without shifting.
   */
  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      let l = this.life[i] - dt;
      if (l <= 0) {
        // swap-remove
        n--;
        if (i !== n) this._copy(n, i);
        i--;
        continue;
      }
      this.life[i] = l;

      const d = this.drag[i];
      if (d > 0) {
        const f = 1 - Math.min(1, d * dt);
        this.vx[i] *= f;
        this.vy[i] *= f;
        this.vz[i] *= f;
      }
      this.vy[i] += this.grav[i] * dt;

      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.spin[i] += this.spinVel[i] * dt;

      // Debris that hits the road should skid, not sink through it.
      if (this.bounce[i] && this.py[i] < this.groundY) {
        this.py[i] = this.groundY;
        this.vy[i] = -this.vy[i] * 0.34;
        this.vx[i] *= 0.62;
        this.vz[i] *= 0.62;
        if (Math.abs(this.vy[i]) < 0.6) this.bounce[i] = 0;
      }
    }
    this.count = n;

    // --- upload ---
    const aPos = this.aPos;
    const aVel = this.aVel;
    const aCol = this.aColor;
    const aPar = this.aParams;
    for (let i = 0; i < n; i++) {
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 at birth, 1 at death
      const i3 = i * 3;
      const i4 = i * 4;

      aPos[i3] = this.px[i];
      aPos[i3 + 1] = this.py[i];
      aPos[i3 + 2] = this.pz[i];

      aVel[i3] = this.vx[i];
      aVel[i3 + 1] = this.vy[i];
      aVel[i3 + 2] = this.vz[i];

      aCol[i4] = this.r0[i] + (this.r1[i] - this.r0[i]) * t;
      aCol[i4 + 1] = this.g0[i] + (this.g1[i] - this.g0[i]) * t;
      aCol[i4 + 2] = this.b0[i] + (this.b1[i] - this.b0[i]) * t;
      // Fade out on a curve rather than linearly; a linear fade reads as a
      // particle being switched off.
      const fade = 1 - t;
      aCol[i4 + 3] = this.alpha0[i] * fade * fade;

      aPar[i3] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      aPar[i3 + 1] = this.stretch[i];
      aPar[i3 + 2] = this.spin[i];
    }

    this._geo.instanceCount = n;
    if (n > 0) {
      this._iPos.addUpdateRange(0, n * 3);
      this._iVel.addUpdateRange(0, n * 3);
      this._iColor.addUpdateRange(0, n * 4);
      this._iParams.addUpdateRange(0, n * 3);
      this._iPos.needsUpdate = true;
      this._iVel.needsUpdate = true;
      this._iColor.needsUpdate = true;
      this._iParams.needsUpdate = true;
    }
  }

  _copy(from, to) {
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from]; this.size1[to] = this.size1[from];
    this.drag[to] = this.drag[from]; this.grav[to] = this.grav[from];
    this.spin[to] = this.spin[from]; this.spinVel[to] = this.spinVel[from];
    this.stretch[to] = this.stretch[from];
    this.r0[to] = this.r0[from]; this.g0[to] = this.g0[from]; this.b0[to] = this.b0[from];
    this.r1[to] = this.r1[from]; this.g1[to] = this.g1[from]; this.b1[to] = this.b1[from];
    this.alpha0[to] = this.alpha0[from];
    this.bounce[to] = this.bounce[from];
  }

  clear() {
    this.count = 0;
    this._geo.instanceCount = 0;
  }

  dispose() {
    this._geo.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
