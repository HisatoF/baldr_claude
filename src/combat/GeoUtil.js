/**
 * Hard-surface geometry kit for the player mech.
 *
 * Everything the Simulacrum is made of is generated here from primitives. Two ideas
 * carry the whole model:
 *
 *  1. **Chamfered solids.** A raw `BoxGeometry` reads as a toy because its edges are
 *     infinitely sharp and catch no light. Every plate here is extruded from an
 *     octagonal profile with a bevelled cap, so every silhouette edge picks up a
 *     highlight sliver. That single change is most of the difference between "cube
 *     with a gun taped on" and a machined panel.
 *
 *  2. **One material, per-vertex variation.** Draw calls are the scarce resource, so
 *     the mech ships as a handful of merged meshes sharing ONE material. Colour,
 *     roughness, metalness and emissive are baked into vertex attributes
 *     (`color`, `aRM`, `aEmi`) and injected into the standard shader. That buys
 *     unlimited material variety at zero extra draw calls, and lets emissive strips
 *     have a real gradient along their length instead of being flat white quads.
 *
 * All of this runs once at init. Nothing in this file is called from `fixed`/`frame`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// Primitive solids
// ---------------------------------------------------------------------------

/**
 * A box with all four long edges chamfered and both caps bevelled.
 * @param {number} w  size on X
 * @param {number} h  size on Y
 * @param {number} d  size on Z
 * @param {number} c  chamfer width
 */
export function chamferBox(w, h, d, c = 0.035) {
  c = Math.min(c, w * 0.42, h * 0.42, d * 0.42);
  const hw = w / 2;
  const hh = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + c, -hh);
  s.lineTo(hw - c, -hh);
  s.lineTo(hw, -hh + c);
  s.lineTo(hw, hh - c);
  s.lineTo(hw - c, hh);
  s.lineTo(-hw + c, hh);
  s.lineTo(-hw, hh - c);
  s.lineTo(-hw, -hh + c);
  s.closePath();

  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.002, d - 2 * c),
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: 0,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  return fitTo(g, w, h, d);
}

/**
 * A tapered plate: like `chamferBox` but the +Y face is inset, so the piece reads as
 * a wedge of armour rather than a slab. `taper` 0..1 shrinks the top on X and Z.
 */
export function taperBox(w, h, d, taper = 0.3, c = 0.03) {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 4, 1, false, Math.PI * 0.25);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = y > 0 ? 1 - taper : 1;
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  // 4-sided cylinder inscribes a square of side sqrt(2)*r; normalise to exact extents.
  return fitTo(g, w, h, d, false, taper);
}

/** Right-triangle prism. The slope runs from -X/-Y up to +X/+Y. */
export function wedge(w, h, d, c = 0.02) {
  const hw = w / 2;
  const hh = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + c, -hh);
  s.lineTo(hw, -hh);
  s.lineTo(hw, hh - c);
  s.lineTo(hw - c * 1.4, hh);
  s.lineTo(-hw + c, -hh + c * 0.4);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.002, d - 2 * c),
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: 0,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  return fitTo(g, w, h, d);
}

/** Cylinder / cone frustum along +Y. `sides` low = faceted mechanical look. */
export function tube(rTop, rBot, h, sides = 10, open = false) {
  return new THREE.CylinderGeometry(rTop, rBot, h, sides, 1, open);
}

/** Faceted blob, for sensor domes and joint balls. */
export function blob(r, detail = 1) {
  return new THREE.IcosahedronGeometry(r, detail);
}

/** Thin ring (torus) — collars, muzzle rings, nozzle lips. */
export function ring(r, t, seg = 12, tubeSeg = 6) {
  return new THREE.TorusGeometry(r, t, tubeSeg, seg);
}

/** Rescale a geometry so its bounding box is exactly w x h x d, centred on origin. */
function fitTo(g, w, h, d, center = true, _taper = 0) {
  if (center) g.center();
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const sx = w / Math.max(1e-6, bb.max.x - bb.min.x);
  const sy = h / Math.max(1e-6, bb.max.y - bb.min.y);
  const sz = d / Math.max(1e-6, bb.max.z - bb.min.z);
  g.scale(sx, sy, sz);
  if (!center) g.center();
  return g;
}

// ---------------------------------------------------------------------------
// Part builder
// ---------------------------------------------------------------------------

/**
 * Accumulates transformed, painted primitives and merges them into one geometry.
 * One `Part` == one draw call on the finished mech.
 */
export class Part {
  constructor(name) {
    this.name = name;
    this._geos = [];
    this.tris = 0;
  }

  /**
   * @param {THREE.BufferGeometry} geo
   * @param {object} o
   *   pos:[x,y,z] rot:[rx,ry,rz] scale:number|[x,y,z]
   *   color:hex  rough:number  metal:number
   *   emissive:hex  emissiveInt:number|(x,y,z)=>number
   *   uvScale:number  uvOffset:[u,v]  flat:boolean
   */
  add(geo, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    // Strip anything the merge would choke on.
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (o.flat !== false) g.computeVertexNormals();

    const p = o.pos || ZERO3;
    const r = o.rot || ZERO3;
    const s = o.scale ?? 1;
    _pos.set(p[0], p[1], p[2]);
    _eul.set(r[0], r[1], r[2], 'ZYX');
    _quat.setFromEuler(_eul);
    if (typeof s === 'number') _scl.set(s, s, s);
    else _scl.set(s[0], s[1], s[2]);
    _mat.compose(_pos, _quat, _scl);
    g.applyMatrix4(_mat);

    boxProjectUv(g, o.uvScale ?? 1.0, o.uvOffset);
    paint(g, o);

    this.tris += g.attributes.position.count / 3;
    this._geos.push(g);
    return this;
  }

  /** Convenience: same primitive mirrored across Z (for paired greebles). */
  addPair(geo, o = {}) {
    const p = o.pos || ZERO3;
    const r = o.rot || ZERO3;
    this.add(geo, o);
    this.add(geo, {
      ...o,
      pos: [p[0], p[1], -p[2]],
      rot: [-r[0], -r[1], r[2]],
    });
    return this;
  }

  merge() {
    if (this._geos.length === 0) return null;
    const g = mergeGeometries(this._geos, false);
    if (!g) {
      console.warn(`[combat] merge failed for part "${this.name}"`);
      return this._geos[0];
    }
    for (const old of this._geos) old.dispose();
    this._geos.length = 0;
    g.computeBoundingSphere();
    g.name = this.name;
    return g;
  }
}

const ZERO3 = [0, 0, 0];

// ---------------------------------------------------------------------------
// UV + attribute painting
// ---------------------------------------------------------------------------

/**
 * Triplanar-ish box projection in *model* space.
 *
 * Because the projection happens after the piece has been placed, panel lines run
 * continuously across neighbouring plates as if the armour were cut from one sheet
 * of stock. `scale` is per-piece, which is how a hydraulic piston can carry the same
 * texture as a chest plate and still read as a different, finer material.
 */
export function boxProjectUv(g, scale = 1, offset) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  const ou = offset ? offset[0] : 0;
  const ov = offset ? offset[1] : 0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u;
    let v;
    if (nx >= ny && nx >= nz) {
      u = z;
      v = y;
    } else if (ny >= nz) {
      u = x;
      v = z;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u * scale + ou;
    uv[i * 2 + 1] = v * scale + ov;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Bake surface response into vertex attributes.
 *
 * `color` multiplies the albedo map, `aRM` multiplies roughness/metalness, `aEmi`
 * is added to emissive radiance. `emissiveInt` may be a function of local position,
 * which is what gives emissive strips a real falloff along their run.
 */
export function paint(g, o) {
  const pos = g.attributes.position;
  const n = pos.count;

  const col = new Float32Array(n * 3);
  _col.setHex(o.color ?? 0xffffff);
  const cr = _col.r;
  const cg = _col.g;
  const cb = _col.b;
  const rough = o.rough ?? 1;
  const metal = o.metal ?? 1;
  const rm = new Float32Array(n * 2);

  const emi = new Float32Array(n * 3);
  let er = 0;
  let eg = 0;
  let eb = 0;
  if (o.emissive !== undefined) {
    _col.setHex(o.emissive);
    er = _col.r;
    eg = _col.g;
    eb = _col.b;
  }
  const ei = o.emissiveInt ?? 0;
  const eiFn = typeof ei === 'function' ? ei : null;
  const eiK = typeof ei === 'number' ? ei : 0;

  for (let i = 0; i < n; i++) {
    col[i * 3] = cr;
    col[i * 3 + 1] = cg;
    col[i * 3 + 2] = cb;
    rm[i * 2] = rough;
    rm[i * 2 + 1] = metal;
    if (o.emissive !== undefined) {
      const k = eiFn ? eiFn(pos.getX(i), pos.getY(i), pos.getZ(i)) : eiK;
      emi[i * 3] = er * k;
      emi[i * 3 + 1] = eg * k;
      emi[i * 3 + 2] = eb * k;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aRM', new THREE.BufferAttribute(rm, 2));
  g.setAttribute('aEmi', new THREE.BufferAttribute(emi, 3));
  return g;
}

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

/**
 * Teach a `MeshStandardMaterial` to read the per-vertex roughness/metalness/emissive
 * attributes, and to modulate emissives by a shared pulse uniform (heat shimmer,
 * overheat flash, thruster spool).
 */
export function attachVertexResponse(material, pulseUniform) {
  material.vertexColors = true;
  material.userData.uEmiPulse = pulseUniform;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEmiPulse = pulseUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aRM;
attribute vec3 aEmi;
varying vec2 vRM;
varying vec3 vEmi;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRM = aRM;
vEmi = aEmi;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uEmiPulse;
varying vec2 vRM;
varying vec3 vEmi;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * vRM.x, 0.035, 1.0);`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = clamp(metalnessFactor * vRM.y, 0.0, 1.0);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vEmi * uEmiPulse;`
      );
  };
  material.customProgramCacheKey = () => 'baldr-mech-vtxresponse';
  return material;
}
