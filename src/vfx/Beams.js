import * as THREE from 'three';

/**
 * Pooled beam / tracer renderer.
 *
 * Hitscan weapons and energy beams need a quad stretched between two points that
 * fades over a short life. These are instanced into a single draw call, with the
 * per-instance matrix doing the positioning, orientation and stretch.
 *
 * A tracer is not just a line: it needs a hot core that decays faster than its
 * halo, otherwise it reads as a coloured stick rather than as something energetic.
 * That is handled by drawing each beam twice — a thin bright core and a wider,
 * dimmer sheath — which is still only two instances.
 */
function makeBeamTexture(w = 128, h = 32) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  // Across the beam: hot centre falling to nothing at the edges.
  const across = g.createLinearGradient(0, 0, 0, h);
  across.addColorStop(0.0, 'rgba(255,255,255,0)');
  across.addColorStop(0.5, 'rgba(255,255,255,1)');
  across.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = across;
  g.fillRect(0, 0, w, h);
  // Along the beam: taper both ends so it does not start and stop abruptly.
  const along = g.createLinearGradient(0, 0, w, 0);
  along.addColorStop(0.0, 'rgba(0,0,0,1)');
  along.addColorStop(0.12, 'rgba(0,0,0,0)');
  along.addColorStop(0.88, 'rgba(0,0,0,0)');
  along.addColorStop(1.0, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = along;
  g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class BeamPool {
  constructor(capacity = 96) {
    this.capacity = capacity;
    this.count = 0;

    this.x0 = new Float32Array(capacity);
    this.y0 = new Float32Array(capacity);
    this.x1 = new Float32Array(capacity);
    this.y1 = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.width = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
    this.g = new Float32Array(capacity);
    this.b = new Float32Array(capacity);

    this.texture = makeBeamTexture();
    const geo = new THREE.PlaneGeometry(1, 1);

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    // Two instances per beam: index 2i is the sheath, 2i+1 the core.
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity * 2);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'vfx.beams';
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 2 * 3),
      3
    );
    this.mesh.count = 0;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._geo = geo;
  }

  spawn(x0, y0, x1, y1, opts = {}) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.x0[i] = x0;
    this.y0[i] = y0;
    this.x1[i] = x1;
    this.y1[i] = y1;
    this.z[i] = opts.z ?? 0;
    this.maxLife[i] = opts.life ?? 0.09;
    this.life[i] = this.maxLife[i];
    this.width[i] = opts.width ?? 0.34;
    const c = opts.color ?? 0x9fe8ff;
    this.r[i] = ((c >> 16) & 255) / 255;
    this.g[i] = ((c >> 8) & 255) / 255;
    this.b[i] = (c & 255) / 255;
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      const l = this.life[i] - dt;
      if (l <= 0) {
        n--;
        if (i !== n) this._copy(n, i);
        i--;
        continue;
      }
      this.life[i] = l;
    }
    this.count = n;

    const col = this.mesh.instanceColor;
    let inst = 0;
    for (let i = 0; i < n; i++) {
      const t = this.life[i] / this.maxLife[i]; // 1 -> 0
      const dx = this.x1[i] - this.x0[i];
      const dy = this.y1[i] - this.y0[i];
      const len = Math.hypot(dx, dy);
      if (len < 1e-5) continue;
      const ang = Math.atan2(dy, dx);

      this._p.set((this.x0[i] + this.x1[i]) * 0.5, (this.y0[i] + this.y1[i]) * 0.5, this.z[i]);
      this._q.setFromAxisAngle(AXIS_Z, ang);

      for (let pass = 0; pass < 2; pass++) {
        const core = pass === 1;
        // The core collapses faster than the sheath, so the beam appears to burn
        // out from the inside rather than simply dimming.
        const wScale = core ? 0.34 * t : 1.0 * (0.35 + t * 0.65);
        const bright = core ? 2.6 * t * t : 0.85 * t;
        this._s.set(len, Math.max(0.001, this.width[i] * wScale), 1);
        this._m.compose(this._p, this._q, this._s);
        this.mesh.setMatrixAt(inst, this._m);
        col.array[inst * 3] = this.r[i] * bright;
        col.array[inst * 3 + 1] = this.g[i] * bright;
        col.array[inst * 3 + 2] = this.b[i] * bright;
        inst++;
      }
    }

    this.mesh.count = inst;
    if (inst > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  _copy(from, to) {
    this.x0[to] = this.x0[from]; this.y0[to] = this.y0[from];
    this.x1[to] = this.x1[from]; this.y1[to] = this.y1[from];
    this.z[to] = this.z[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.width[to] = this.width[from];
    this.r[to] = this.r[from]; this.g[to] = this.g[from]; this.b[to] = this.b[from];
  }

  dispose() {
    this._geo.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

const AXIS_Z = new THREE.Vector3(0, 0, 1);
