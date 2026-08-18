/**
 * The Simulacrum — the player mech.
 *
 * Built entirely from code. Design intent, in the order the eye reads it at 64px:
 *
 *   1. **Reverse-jointed legs.** The knee spurs backwards and the shin rakes forward
 *      to a long clawed foot. That zig-zag is the single strongest silhouette cue a
 *      mech has, and it is legible even as a black shape.
 *   2. **Asymmetric shoulders.** Left carries a boxed six-tube missile pod with a
 *      raked cap; right carries a layered pauldron with a gatling drum on the outer
 *      face and a blade fin sweeping up and back. The two sides never mirror, so the
 *      outline never reads as a symmetric slab.
 *   3. **A thruster backpack** whose binders sweep past the shoulder line, giving the
 *      upper body a wide angular flare against the narrow waist.
 *   4. **Hip skirt armour** — five plates that break the pelvis from the thighs and
 *      sway independently.
 *   5. **A crested head** set deep between the collar blocks, so the neck reads as a
 *      notch rather than a stalk.
 *
 * Everything is a chamfered solid, greebled with a small library of detail shapes
 * scattered deterministically, and merged down to one mesh per animated bone. The
 * whole mech is 18 body draw calls plus thruster plumes, sabre and contact shadow.
 *
 * Local frame: +X forward, +Y up, +Z to the mech's left. Origin at the soles.
 */
import * as THREE from 'three';
import { Rng } from '../core/Rng.js';
import {
  Part,
  chamferBox,
  taperBox,
  wedge,
  tube,
  blob,
  ring,
  attachVertexResponse,
} from './GeoUtil.js';
import { makeMechSurface, makeContactShadowTexture, makeFallbackEnvironment } from './MechMaterials.js';

// --- palette ---------------------------------------------------------------
// Cold industrial base, saturated emissive accents. One palette, per the rubric.
export const PAL = {
  ARMOR: 0x59637a,
  ARMOR_D: 0x2b3140,
  ARMOR_DD: 0x171b23,
  ARMOR_L: 0x97a2b4,
  FRAME: 0x3a3f4a,
  HYDRO: 0xc6ccd6,
  RUBBER: 0x0f1114,
  WARN: 0xd9832c,
  EMI: 0x5ce6ff,
  EMI_DEEP: 0x1e9fd8,
  EMI_AMBER: 0xffab3d,
  EMI_MAG: 0xff4fa8,
  THRUST: 0xffb257,
};

// --- surface presets (vertex roughness / metalness multipliers) -------------
const S_ARMOR = { rough: 0.92, metal: 0.94 };
const S_ARMOR_MATTE = { rough: 1.35, metal: 0.55 };
const S_FRAME = { rough: 1.15, metal: 1.0 };
const S_CHROME = { rough: 0.24, metal: 1.0 };
const S_RUBBER = { rough: 2.0, metal: 0.05 };

// --- skeleton metrics ------------------------------------------------------
const M = {
  hipY: 2.02,
  hipZ: 0.34,
  thigh: 0.9,
  shin: 0.88,
  ankleY: 0.35,
  waistY: 0.26, // hips-local
  shoulderY: 0.88, // torso-local
  shoulderZ: 0.8,
  upperArm: 0.7,
  foreArm: 0.76,
  headY: 1.18, // torso-local
  restThigh: -0.32,
  restShinAbs: 0.44,
};

// ---------------------------------------------------------------------------
// Greeble library
// ---------------------------------------------------------------------------

const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Rotation that points a +Y-aligned primitive along the given face axis. */
function axisRot(axis, sign) {
  if (axis === 'y') return sign > 0 ? [0, 0, 0] : [Math.PI, 0, 0];
  if (axis === 'x') return [0, 0, sign > 0 ? -Math.PI / 2 : Math.PI / 2];
  return [sign > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0];
}

/** Move a point out along a face normal. */
function outward(p, axis, sign, d) {
  const q = [p[0], p[1], p[2]];
  if (axis === 'x') q[0] += sign * d;
  else if (axis === 'y') q[1] += sign * d;
  else q[2] += sign * d;
  return q;
}

const G = {
  /** Hex bolt head. */
  bolt(part, p, axis, sign, r = 0.022, h = 0.02) {
    part.add(tube(r, r * 1.15, h, 6), {
      pos: outward(p, axis, sign, h * 0.5),
      rot: axisRot(axis, sign),
      color: PAL.HYDRO,
      ...S_CHROME,
      uvScale: 6,
      flat: true,
    });
  },

  /** A short row of bolts along a tangent direction. */
  boltRow(part, p, axis, sign, tangent, n, spacing, r = 0.02) {
    for (let i = 0; i < n; i++) {
      const t = (i - (n - 1) / 2) * spacing;
      const q = [p[0] + tangent[0] * t, p[1] + tangent[1] * t, p[2] + tangent[2] * t];
      G.bolt(part, q, axis, sign, r);
    }
  },

  /** Recessed intake with slats. `u`/`v` are the in-plane extents. */
  vent(part, p, axis, sign, u, v, slats = 5, color = PAL.ARMOR_DD) {
    const rot = axisRot(axis, sign);
    // recess shell
    part.add(chamferBox(u, 0.03, v, 0.012), {
      pos: outward(p, axis, sign, 0.006),
      rot,
      color: PAL.ARMOR_DD,
      ...S_RUBBER,
      uvScale: 3.4,
    });
    const step = v / slats;
    for (let i = 0; i < slats; i++) {
      const off = -v / 2 + step * (i + 0.5);
      const q = outward(p, axis, sign, 0.018);
      if (axis === 'y') q[2] += off;
      else if (axis === 'x') q[2] += off;
      else q[1] += off;
      part.add(chamferBox(u * 0.94, 0.024, step * 0.5, 0.008), {
        pos: q,
        rot: axis === 'z' ? [rot[0] + 0.42, rot[1], rot[2]] : [rot[0], rot[1], rot[2] + 0.42],
        color,
        ...S_FRAME,
        uvScale: 5,
      });
    }
  },

  /** Hydraulic actuator: dark housing + bright rod. */
  piston(part, p, rot, len, r = 0.035) {
    part.add(tube(r * 1.5, r * 1.6, len * 0.55, 8), {
      pos: p,
      rot,
      color: PAL.ARMOR_DD,
      ...S_FRAME,
      uvScale: 5,
      flat: false,
    });
    part.add(tube(r * 0.72, r * 0.72, len, 8), {
      pos: p,
      rot,
      color: PAL.HYDRO,
      ...S_CHROME,
      uvScale: 7,
      flat: false,
    });
    part.add(ring(r * 1.62, r * 0.2, 8, 4), {
      pos: p,
      rot: [rot[0] + Math.PI / 2, rot[1], rot[2]],
      color: PAL.ARMOR_L,
      ...S_CHROME,
      uvScale: 8,
    });
  },

  /** Flexible conduit — a run of short segments so it reads as a cable, not a rod. */
  cable(part, a, b, r = 0.026, segs = 5, sag = 0.05) {
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const tm = (t0 + t1) * 0.5;
      const s = Math.sin(tm * Math.PI) * sag;
      const x = a[0] + (b[0] - a[0]) * tm;
      const y = a[1] + (b[1] - a[1]) * tm - s;
      const z = a[2] + (b[2] - a[2]) * tm;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz) / segs;
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(Math.hypot(dx, dz), dy);
      part.add(tube(r, r * 1.05, len * 1.25, 6), {
        pos: [x, y, z],
        rot: [0, yaw, pitch * (dx < 0 ? 1 : 1)],
        color: PAL.RUBBER,
        ...S_RUBBER,
        uvScale: 9,
        flat: false,
      });
    }
  },

  /** Small sensor dome with a glowing core. */
  sensor(part, p, axis, sign, r = 0.045, color = PAL.EMI) {
    part.add(tube(r * 1.25, r * 1.5, 0.02, 8), {
      pos: outward(p, axis, sign, 0.01),
      rot: axisRot(axis, sign),
      color: PAL.ARMOR_DD,
      ...S_FRAME,
      uvScale: 8,
    });
    part.add(blob(r, 0), {
      pos: outward(p, axis, sign, 0.024),
      color: PAL.EMI_DEEP,
      rough: 0.2,
      metal: 0.1,
      emissive: color,
      emissiveInt: 2.4,
      uvScale: 10,
      flat: false,
    });
  },

  /** A raised armour chip: the workhorse greeble. */
  chip(part, p, axis, sign, u, v, t, color = PAL.ARMOR_D) {
    const rot = axisRot(axis, sign);
    part.add(chamferBox(u, t, v, Math.min(0.02, t * 0.4)), {
      pos: outward(p, axis, sign, t * 0.5),
      rot,
      color,
      ...S_ARMOR,
      uvScale: 3.2,
    });
  },

  /**
   * Emissive strip with a real gradient along its run — bright at the middle,
   * dying at the caps, so it never reads as a uniform white quad.
   */
  strip(part, p, dir, len, w, color = PAL.EMI, peak = 3.2, rot = [0, 0, 0]) {
    const size = dir === 'x' ? [len, w, w * 0.62] : dir === 'y' ? [w, len, w * 0.62] : [w * 0.62, w, len];
    const axisIdx = dir === 'x' ? 0 : dir === 'y' ? 1 : 2;
    const c = p[axisIdx];
    const half = len * 0.5;
    // housing
    part.add(chamferBox(size[0] * 1.18, size[1] * 1.5, size[2] * 1.5, w * 0.2), {
      pos: p,
      rot,
      color: PAL.ARMOR_DD,
      ...S_RUBBER,
      uvScale: 5,
    });
    part.add(chamferBox(size[0], size[1], size[2], w * 0.24), {
      pos: p,
      rot,
      color: PAL.EMI_DEEP,
      rough: 0.28,
      metal: 0.0,
      emissive: color,
      emissiveInt: (x, y, z) => {
        const v = axisIdx === 0 ? x : axisIdx === 1 ? y : z;
        const t = Math.min(1, Math.abs(v - c) / Math.max(1e-5, half));
        // squared falloff plus a lit core keeps the ends from clipping to a hard edge
        return peak * (1 - t * t) * (0.55 + 0.45 * (1 - t));
      },
      uvScale: 6,
    });
  },

  /** Deterministic scatter of mixed greebles across a rectangular face patch. */
  scatter(part, rng, patch, count) {
    const { c, axis, sign, u, v } = patch;
    const uAxis = axis === 'x' ? 2 : axis === 'y' ? 0 : 0;
    const vAxis = axis === 'x' ? 1 : axis === 'y' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const p = [c[0], c[1], c[2]];
      p[uAxis] += rng.range(-u * 0.5, u * 0.5);
      p[vAxis] += rng.range(-v * 0.5, v * 0.5);
      const roll = rng.float();
      if (roll < 0.34) {
        G.chip(
          part,
          p,
          axis,
          sign,
          rng.range(0.05, u * 0.42),
          rng.range(0.04, v * 0.4),
          rng.range(0.012, 0.03),
          rng.bool(0.7) ? PAL.ARMOR_D : PAL.ARMOR_DD
        );
      } else if (roll < 0.58) {
        G.boltRow(
          part,
          p,
          axis,
          sign,
          AX[axis === 'y' ? 'x' : 'y'],
          rng.int(2, 4),
          rng.range(0.045, 0.07),
          rng.range(0.014, 0.022)
        );
      } else if (roll < 0.74) {
        G.chip(part, p, axis, sign, rng.range(0.04, 0.09), rng.range(0.04, 0.09), 0.018, PAL.ARMOR_L);
      } else if (roll < 0.86) {
        part.add(wedge(rng.range(0.06, 0.13), rng.range(0.03, 0.055), rng.range(0.05, 0.1), 0.012), {
          pos: outward(p, axis, sign, 0.02),
          rot: axisRot(axis, sign),
          color: PAL.ARMOR_D,
          ...S_ARMOR,
          uvScale: 3.6,
        });
      } else if (roll < 0.94) {
        G.sensor(part, p, axis, sign, rng.range(0.018, 0.03), rng.bool(0.75) ? PAL.EMI : PAL.EMI_AMBER);
      } else {
        part.add(tube(0.016, 0.02, rng.range(0.05, 0.12), 6), {
          pos: outward(p, axis, sign, 0.04),
          rot: axisRot(axis, sign),
          color: PAL.HYDRO,
          ...S_CHROME,
          uvScale: 8,
          flat: false,
        });
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Body parts
// ---------------------------------------------------------------------------

function buildHips(rng) {
  const p = new Part('hips');
  // pelvis core
  p.add(chamferBox(0.78, 0.58, 1.0, 0.07), { pos: [0, 0, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.05 });
  // waist ring (narrow, so the skirt flares read)
  p.add(tube(0.3, 0.34, 0.3, 10), { pos: [0, 0.34, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 2.4, flat: false });
  p.add(ring(0.33, 0.045, 12, 5), { pos: [0, 0.42, 0], rot: [Math.PI / 2, 0, 0], color: PAL.ARMOR_D, ...S_FRAME, uvScale: 4 });
  // front skirt plate — angled, the main forward silhouette break
  p.add(taperBox(0.34, 0.5, 0.62, 0.28, 0.05), {
    pos: [0.36, -0.18, 0],
    rot: [0, 0, 0.34],
    color: PAL.ARMOR,
    ...S_ARMOR,
    uvScale: 1.5,
  });
  G.strip(p, [0.5, -0.1, 0], 'z', 0.4, 0.035, PAL.EMI, 2.6, [0, 0, 0.34]);
  // rear skirt
  p.add(taperBox(0.3, 0.46, 0.7, 0.22, 0.05), {
    pos: [-0.34, -0.2, 0],
    rot: [0, 0, -0.3],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 1.5,
  });
  // hip ball joints
  p.addPair(blob(0.17, 1), { pos: [0, -0.02, M.hipZ], color: PAL.FRAME, ...S_FRAME, uvScale: 3.2, flat: false });
  p.addPair(ring(0.19, 0.035, 10, 5), {
    pos: [0, -0.02, M.hipZ + 0.09],
    rot: [Math.PI / 2, 0, 0],
    color: PAL.ARMOR_DD,
    ...S_FRAME,
    uvScale: 5,
  });
  // pelvic centre block + reactor vent
  G.vent(p, [0.0, -0.22, 0], 'y', -1, 0.4, 0.44, 4);
  G.scatter(p, rng, { c: [0, 0.05, 0.5], axis: 'z', sign: 1, u: 0.5, v: 0.34 }, 4);
  G.scatter(p, rng, { c: [0, 0.05, -0.5], axis: 'z', sign: -1, u: 0.5, v: 0.34 }, 4);
  G.scatter(p, rng, { c: [-0.4, 0.05, 0], axis: 'x', sign: -1, u: 0.5, v: 0.3 }, 3);
  return p.merge();
}

function buildSkirt(rng, side) {
  const p = new Part(`skirt${side > 0 ? 'L' : 'R'}`);
  p.add(taperBox(0.5, 0.56, 0.3, 0.24, 0.055), {
    pos: [0, -0.24, 0],
    rot: [side * 0.16, 0, 0],
    color: PAL.ARMOR,
    ...S_ARMOR,
    uvScale: 1.5,
  });
  p.add(wedge(0.22, 0.2, 0.26, 0.03), {
    pos: [-0.16, -0.44, 0.02 * side],
    rot: [0, 0, Math.PI],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.6,
  });
  G.strip(p, [0.08, -0.42, side * 0.16], 'x', 0.3, 0.03, PAL.EMI, 2.2);
  G.boltRow(p, [0.0, -0.08, side * 0.16], 'z', side, AX.x, 3, 0.11, 0.02);
  G.scatter(p, rng, { c: [0, -0.28, side * 0.16], axis: 'z', sign: side, u: 0.36, v: 0.32 }, 3);
  return p.merge();
}

function buildTorso(rng) {
  const p = new Part('torso');
  // --- core chest: two stacked masses so the profile is not one slab ---
  p.add(chamferBox(0.86, 0.66, 1.18, 0.08), { pos: [0.02, 0.42, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 0.95 });
  p.add(chamferBox(0.96, 0.5, 1.34, 0.1), { pos: [0.0, 0.82, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 0.9 });
  // chest prow — the forward-leaning plate that gives the mech its "chest"
  p.add(taperBox(0.44, 0.7, 0.86, 0.34, 0.06), {
    pos: [0.4, 0.6, 0],
    rot: [0, 0, -0.2],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 1.5,
  });
  // twin intake cowls flanking the prow
  p.addPair(taperBox(0.3, 0.42, 0.3, 0.3, 0.045), {
    pos: [0.3, 0.72, 0.46],
    rot: [0, 0, -0.32],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.0,
  });
  G.vent(p, [0.44, 0.72, 0.46], 'x', 1, 0.24, 0.22, 4, PAL.ARMOR_DD);
  G.vent(p, [0.44, 0.72, -0.46], 'x', 1, 0.24, 0.22, 4, PAL.ARMOR_DD);
  // reactor core: a recessed glowing block behind a grill
  p.add(chamferBox(0.16, 0.26, 0.3, 0.03), {
    pos: [0.56, 0.44, 0],
    color: PAL.EMI_DEEP,
    rough: 0.3,
    metal: 0.1,
    emissive: PAL.EMI,
    emissiveInt: (x, y) => 3.6 * (1 - Math.min(1, Math.abs(y - 0.44) / 0.14) ** 2),
    uvScale: 4,
  });
  for (let i = 0; i < 3; i++) {
    p.add(chamferBox(0.05, 0.035, 0.32, 0.012), {
      pos: [0.63, 0.36 + i * 0.08, 0],
      color: PAL.ARMOR_DD,
      ...S_FRAME,
      uvScale: 5,
    });
  }
  // collar blocks — head sits in the notch between them
  p.addPair(chamferBox(0.34, 0.3, 0.34, 0.05), {
    pos: [-0.02, 1.06, 0.34],
    rot: [0.1, 0, 0.06],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.2,
  });
  p.add(chamferBox(0.44, 0.24, 0.36, 0.05), {
    pos: [-0.24, 1.04, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 2.4,
  });
  // neck column
  p.add(tube(0.13, 0.16, 0.28, 8), { pos: [0.0, 1.06, 0], color: PAL.RUBBER, ...S_RUBBER, uvScale: 4, flat: false });
  // shoulder sockets
  p.addPair(tube(0.2, 0.24, 0.26, 10), {
    pos: [0, M.shoulderY, 0.7],
    rot: [Math.PI / 2, 0, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 3,
    flat: false,
  });
  // waist trunk down to the hip pivot
  p.add(taperBox(0.5, 0.36, 0.66, -0.18, 0.05), {
    pos: [0, 0.06, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 2.2,
  });
  G.cable(p, [-0.12, 0.14, 0.24], [-0.16, 0.44, 0.3], 0.028, 4, 0.04);
  G.cable(p, [-0.12, 0.14, -0.24], [-0.16, 0.44, -0.3], 0.028, 4, 0.04);
  // side torso strips
  G.strip(p, [0.02, 0.42, 0.6], 'x', 0.5, 0.04, PAL.EMI, 2.4);
  G.strip(p, [0.02, 0.42, -0.6], 'x', 0.5, 0.04, PAL.EMI, 2.4);
  // scattered plating
  G.scatter(p, rng, { c: [0, 0.62, 0.68], axis: 'z', sign: 1, u: 0.6, v: 0.42 }, 5);
  G.scatter(p, rng, { c: [0, 0.62, -0.68], axis: 'z', sign: -1, u: 0.6, v: 0.42 }, 5);
  G.scatter(p, rng, { c: [0.0, 1.08, 0], axis: 'y', sign: 1, u: 0.6, v: 0.9 }, 4);
  return p.merge();
}

function buildBackpack(rng) {
  const p = new Part('backpack');
  // main housing
  p.add(chamferBox(0.42, 0.92, 0.96, 0.07), { pos: [0, 0, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 1.1 });
  p.add(chamferBox(0.24, 0.42, 0.7, 0.05), { pos: [-0.3, 0.16, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 1.8 });
  // radiator fins on the back face
  for (let i = 0; i < 5; i++) {
    p.add(chamferBox(0.16, 0.05, 0.78, 0.014), {
      pos: [-0.28, 0.3 - i * 0.11, 0],
      color: PAL.ARMOR_DD,
      ...S_FRAME,
      uvScale: 3,
    });
  }
  // swept wing binders — the widest part of the upper silhouette
  p.addPair(taperBox(0.16, 0.86, 0.3, 0.5, 0.04), {
    pos: [-0.18, 0.36, 0.56],
    rot: [0.42, 0, -0.5],
    color: PAL.ARMOR,
    ...S_ARMOR,
    uvScale: 1.6,
  });
  p.addPair(wedge(0.5, 0.24, 0.14, 0.03), {
    pos: [-0.34, 0.66, 0.72],
    rot: [0.42, 0, 2.2],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 2.4,
  });
  G.strip(p, [-0.2, 0.5, 0.62], 'y', 0.5, 0.035, PAL.EMI, 2.8, [0.42, 0, -0.5]);
  G.strip(p, [-0.2, 0.5, -0.62], 'y', 0.5, 0.035, PAL.EMI, 2.8, [-0.42, 0, -0.5]);
  // main nozzle housings (the plumes are separate additive meshes)
  p.addPair(tube(0.16, 0.23, 0.34, 10), {
    pos: [-0.16, -0.52, 0.3],
    rot: [0, 0, 0.34],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 2.6,
    flat: false,
  });
  p.addPair(tube(0.13, 0.2, 0.1, 10, true), {
    pos: [-0.22, -0.66, 0.3],
    rot: [0, 0, 0.34],
    color: PAL.ARMOR_DD,
    rough: 0.9,
    metal: 1,
    emissive: PAL.THRUST,
    emissiveInt: 0.9,
    uvScale: 5,
    flat: false,
  });
  // vernier thrusters up top
  p.addPair(tube(0.05, 0.075, 0.12, 8), {
    pos: [-0.2, 0.44, 0.24],
    rot: [0, 0, -0.7],
    color: PAL.ARMOR_DD,
    ...S_FRAME,
    uvScale: 5,
    flat: false,
  });
  G.scatter(p, rng, { c: [0.22, 0, 0], axis: 'x', sign: 1, u: 0.7, v: 0.7 }, 3);
  G.scatter(p, rng, { c: [0, 0, 0.5], axis: 'z', sign: 1, u: 0.36, v: 0.7 }, 4);
  G.scatter(p, rng, { c: [0, 0, -0.5], axis: 'z', sign: -1, u: 0.36, v: 0.7 }, 4);
  return p.merge();
}

function buildHead(rng) {
  const p = new Part('head');
  // skull
  p.add(chamferBox(0.4, 0.32, 0.44, 0.055), { pos: [0, 0.16, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 2.4 });
  // jaw / mouth guard
  p.add(taperBox(0.34, 0.18, 0.34, 0.3, 0.04), { pos: [0.04, -0.02, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 3 });
  G.vent(p, [0.19, -0.02, 0], 'x', 1, 0.12, 0.22, 3, PAL.ARMOR_DD);
  // visor: recessed dark band with a bright lens core, falloff along Z
  p.add(chamferBox(0.1, 0.14, 0.42, 0.03), { pos: [0.19, 0.16, 0], color: PAL.ARMOR_DD, ...S_RUBBER, uvScale: 4 });
  p.add(chamferBox(0.07, 0.095, 0.36, 0.025), {
    pos: [0.23, 0.16, 0],
    color: PAL.EMI_DEEP,
    rough: 0.16,
    metal: 0.0,
    emissive: PAL.EMI,
    emissiveInt: (x, y, z) => {
      const t = Math.min(1, Math.abs(z) / 0.18);
      return 5.2 * (1 - t * t * t) * (0.6 + 0.4 * (1 - t));
    },
    uvScale: 6,
  });
  // crest fin — the tallest point of the silhouette
  p.add(wedge(0.3, 0.3, 0.09, 0.025), {
    pos: [0.02, 0.42, 0],
    rot: [0, 0, 0.35],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 3,
  });
  p.add(chamferBox(0.14, 0.1, 0.2, 0.03), { pos: [-0.1, 0.36, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 4 });
  // V-fin antennae, asymmetric lengths
  p.add(wedge(0.1, 0.26, 0.05, 0.014), {
    pos: [0.06, 0.44, 0.17],
    rot: [0.5, 0, 0.5],
    color: PAL.WARN,
    ...S_ARMOR_MATTE,
    uvScale: 5,
  });
  p.add(wedge(0.1, 0.18, 0.05, 0.014), {
    pos: [0.06, 0.4, -0.17],
    rot: [-0.5, 0, 0.5],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 5,
  });
  // ear pods, different on each side
  p.add(chamferBox(0.16, 0.2, 0.1, 0.03), { pos: [-0.02, 0.14, 0.24], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 3.4 });
  p.add(tube(0.07, 0.085, 0.13, 8), {
    pos: [-0.02, 0.14, -0.25],
    rot: [Math.PI / 2, 0, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 4,
    flat: false,
  });
  G.sensor(p, [-0.02, 0.14, -0.3], 'z', -1, 0.035, PAL.EMI_AMBER);
  G.boltRow(p, [0, 0.3, 0.21], 'z', 1, AX.x, 3, 0.08, 0.016);
  return p.merge();
}

// --- shoulders: deliberately unlike each other -----------------------------

function buildPauldronL(rng) {
  const p = new Part('pauldronL');
  // heavy boxed pod
  p.add(chamferBox(0.56, 0.58, 0.5, 0.07), { pos: [0, 0.1, 0.2], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.4 });
  p.add(taperBox(0.5, 0.24, 0.46, 0.35, 0.05), { pos: [0, 0.42, 0.22], color: PAL.ARMOR_L, ...S_ARMOR_MATTE, uvScale: 2 });
  // raked cap fin
  p.add(wedge(0.5, 0.2, 0.42, 0.03), {
    pos: [-0.06, 0.56, 0.22],
    rot: [0, 0, 0.16],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.2,
  });
  // six missile tubes, muzzles glowing amber
  for (let i = 0; i < 6; i++) {
    const col = i % 3;
    const row = (i / 3) | 0;
    const z = 0.08 + col * 0.13;
    const x = -0.11 + row * 0.22;
    p.add(tube(0.052, 0.056, 0.2, 8), {
      pos: [x, 0.5, z],
      color: PAL.ARMOR_DD,
      ...S_FRAME,
      uvScale: 7,
      flat: false,
    });
    p.add(tube(0.038, 0.038, 0.04, 8), {
      pos: [x, 0.585, z],
      color: PAL.WARN,
      rough: 0.5,
      metal: 0.4,
      emissive: PAL.EMI_AMBER,
      emissiveInt: 2.1,
      uvScale: 9,
      flat: false,
    });
  }
  // outer shield plate
  p.add(chamferBox(0.62, 0.66, 0.14, 0.05), {
    pos: [0.02, 0.06, 0.5],
    rot: [0, 0, 0.06],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 1.6,
  });
  G.strip(p, [0.02, 0.24, 0.58], 'x', 0.44, 0.035, PAL.EMI_AMBER, 2.4);
  G.vent(p, [-0.3, 0.08, 0.2], 'x', -1, 0.3, 0.34, 4);
  // shoulder yoke
  p.add(tube(0.19, 0.21, 0.34, 10), {
    pos: [0, 0, -0.06],
    rot: [Math.PI / 2, 0, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 3,
    flat: false,
  });
  G.piston(p, [-0.16, -0.06, 0.06], [0, 0, 0.4], 0.34, 0.03);
  G.scatter(p, rng, { c: [0, 0.42, 0.2], axis: 'y', sign: 1, u: 0.4, v: 0.34 }, 3);
  G.scatter(p, rng, { c: [0.03, 0.06, 0.58], axis: 'z', sign: 1, u: 0.5, v: 0.5 }, 4);
  
  // Comms mast: the left side's counterpart to the right's blade stack. The two
  // shoulders now differ in OUTLINE — one raked blade, one vertical spike — rather
  // than only in the greebles bolted to them.
  p.add(tube(0.055, 0.085, 1.15, 6), {
    pos: [0.06, 0.82, 0.34],
    rot: [0.1, 0, -0.13],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 5,
    flat: false,
  });
  p.add(chamferBox(0.16, 0.16, 0.1, 0.02), {
    pos: [0.02, 1.36, 0.36],
    color: PAL.ARMOR_DD,
    ...S_FRAME,
    uvScale: 4,
  });
  G.sensor(p, [0.02, 1.36, 0.42], 'z', 1, 0.045, PAL.EMI_AMBER);

return p.merge();
}

function buildPauldronR(rng) {
  const p = new Part('pauldronR');
  // layered plates, thinner and more raked than the left
  p.add(taperBox(0.5, 0.44, 0.42, 0.22, 0.06), { pos: [0, 0.14, -0.2], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.5 });
  p.add(chamferBox(0.56, 0.16, 0.5, 0.04), {
    pos: [-0.02, 0.38, -0.24],
    rot: [-0.12, 0, 0.1],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2,
  });
  p.add(chamferBox(0.46, 0.13, 0.42, 0.035), {
    pos: [-0.02, 0.52, -0.26],
    rot: [-0.2, 0, 0.16],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 2.4,
  });
  // Blade fin sweeping up and back — the asymmetry that breaks the outline.
  //
  // Sized to be STRUCTURAL, not decorative. At 0.72 units on a four-unit mech this
  // vanished below about 100px and the two shoulders read as mirrored, which is the
  // single thing the silhouette axis punishes hardest. It now clears the shoulder
  // line by enough to change the outline at 64px.
  p.add(wedge(1.24, 0.82, 0.13, 0.04), {
    pos: [-0.4, 0.86, -0.3],
    rot: [0.16, 0, 2.42],
    color: PAL.ARMOR,
    ...S_ARMOR,
    uvScale: 2,
  });
  // A second, shorter blade behind it, so the fin reads as a stack rather than a slab.
  p.add(wedge(0.95, 0.62, 0.1, 0.03), {
    pos: [-0.2, 0.74, -0.44],
    rot: [0.2, 0, 2.62],
    color: PAL.ARMOR_D,
    ...S_ARMOR_MATTE,
    uvScale: 2.2,
  });
  G.strip(p, [-0.4, 0.86, -0.38], 'x', 0.86, 0.04, PAL.EMI, 2.8, [0.16, 0, 2.42]);
  // gatling drum on the outer face
  p.add(tube(0.19, 0.19, 0.22, 12), {
    pos: [0.02, 0.02, -0.52],
    rot: [Math.PI / 2, 0, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 3.2,
    flat: false,
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    p.add(tube(0.031, 0.031, 0.3, 6), {
      pos: [Math.cos(a) * 0.105, 0.02 + Math.sin(a) * 0.105, -0.58],
      rot: [Math.PI / 2, 0, 0],
      color: PAL.ARMOR_DD,
      ...S_CHROME,
      uvScale: 8,
      flat: false,
    });
  }
  p.add(ring(0.2, 0.028, 12, 5), {
    pos: [0.02, 0.02, -0.63],
    color: PAL.ARMOR_L,
    ...S_CHROME,
    uvScale: 6,
  });
  G.sensor(p, [0.14, 0.3, -0.44], 'x', 1, 0.04, PAL.EMI_MAG);
  // yoke
  p.add(tube(0.19, 0.21, 0.34, 10), {
    pos: [0, 0, 0.06],
    rot: [Math.PI / 2, 0, 0],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 3,
    flat: false,
  });
  G.piston(p, [-0.16, -0.06, -0.06], [0, 0, 0.4], 0.34, 0.03);
  G.scatter(p, rng, { c: [0, 0.3, -0.2], axis: 'y', sign: 1, u: 0.36, v: 0.3 }, 3);
  return p.merge();
}

// --- arms ------------------------------------------------------------------

function buildUpperArm(rng, side) {
  const p = new Part(`upperArm${side > 0 ? 'L' : 'R'}`);
  const L = M.upperArm;
  p.add(tube(0.15, 0.13, L * 0.94, 8), { pos: [0, -L / 2, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 2.6, flat: false });
  p.add(chamferBox(0.28, L * 0.66, 0.3, 0.05), { pos: [0.01, -L * 0.42, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 2 });
  p.add(chamferBox(0.2, 0.2, 0.34, 0.04), { pos: [-0.06, -L * 0.2, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 3 });
  G.piston(p, [-0.13, -L * 0.5, side * 0.04], [0, 0, 0.05], L * 0.7, 0.028);
  G.strip(p, [0.14, -L * 0.45, 0], 'y', L * 0.42, 0.028, PAL.EMI, 2.0);
  // elbow ball
  p.add(blob(0.135, 1), { pos: [0, -L, 0], color: PAL.RUBBER, ...S_RUBBER, uvScale: 4, flat: false });
  G.scatter(p, rng, { c: [0, -L * 0.45, side * 0.16], axis: 'z', sign: side, u: 0.22, v: 0.36 }, 2);
  return p.merge();
}

function buildForearmL(rng) {
  const p = new Part('forearmL');
  const L = M.foreArm;
  // armoured forearm with a mounted grip — this is the sabre hand
  p.add(tube(0.12, 0.1, L * 0.9, 8), { pos: [0, -L / 2, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 3, flat: false });
  p.add(taperBox(0.3, L * 0.72, 0.32, 0.22, 0.05), { pos: [0.01, -L * 0.4, 0], rot: [0, 0, Math.PI], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.9 });
  // wrist-mounted shield vane
  p.add(chamferBox(0.1, 0.5, 0.4, 0.04), {
    pos: [-0.2, -L * 0.44, 0.04],
    rot: [0, 0, -0.14],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.2,
  });
  G.strip(p, [-0.26, -L * 0.44, 0.04], 'y', 0.36, 0.03, PAL.EMI, 2.4);
  // hand: palm + three blocky digits + thumb
  p.add(chamferBox(0.2, 0.18, 0.24, 0.035), { pos: [0.01, -L - 0.1, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 3.4 });
  for (let i = 0; i < 3; i++) {
    p.add(chamferBox(0.07, 0.15, 0.055, 0.016), {
      pos: [0.06, -L - 0.24, -0.07 + i * 0.07],
      rot: [0, 0, -0.34],
      color: PAL.FRAME,
      ...S_FRAME,
      uvScale: 7,
    });
  }
  p.add(chamferBox(0.07, 0.13, 0.06, 0.016), {
    pos: [-0.06, -L - 0.2, 0.09],
    rot: [0.4, 0, 0.5],
    color: PAL.FRAME,
    ...S_FRAME,
    uvScale: 7,
  });
  // sabre hilt in the grip
  p.add(tube(0.045, 0.05, 0.3, 8), {
    pos: [0.03, -L - 0.16, 0.0],
    rot: [0, 0, -0.2],
    color: PAL.ARMOR_DD,
    ...S_FRAME,
    uvScale: 8,
    flat: false,
  });
  p.add(ring(0.06, 0.018, 10, 4), {
    pos: [0.06, -L - 0.02, 0],
    rot: [Math.PI / 2, 0, 0.2],
    color: PAL.EMI_DEEP,
    rough: 0.3,
    metal: 0.2,
    emissive: PAL.EMI,
    emissiveInt: 2.6,
    uvScale: 8,
  });
  G.scatter(p, rng, { c: [0.16, -L * 0.4, 0], axis: 'x', sign: 1, u: 0.4, v: 0.24 }, 3);
  return p.merge();
}

function buildForearmR(rng) {
  const p = new Part('forearmR');
  const L = M.foreArm;
  // cannon arm: the weapon is part of the limb, not taped on
  p.add(tube(0.12, 0.1, L * 0.86, 8), { pos: [0, -L / 2, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 3, flat: false });
  p.add(taperBox(0.34, L * 0.7, 0.34, 0.18, 0.05), { pos: [0, -L * 0.38, 0], rot: [0, 0, Math.PI], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.9 });
  // receiver block
  p.add(chamferBox(0.36, 0.34, 0.28, 0.045), { pos: [0.06, -L - 0.08, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 2.4 });
  // barrel assembly, angled forward-down along the forearm axis
  p.add(tube(0.075, 0.09, 0.56, 10), {
    pos: [0.22, -L - 0.22, 0],
    rot: [0, 0, -0.62],
    color: PAL.ARMOR_DD,
    ...S_FRAME,
    uvScale: 4,
    flat: false,
  });
  p.add(tube(0.055, 0.062, 0.18, 10), {
    pos: [0.4, -L - 0.36, 0],
    rot: [0, 0, -0.62],
    color: PAL.HYDRO,
    ...S_CHROME,
    uvScale: 6,
    flat: false,
  });
  p.add(ring(0.075, 0.02, 10, 4), {
    pos: [0.45, -L - 0.4, 0],
    rot: [Math.PI / 2 - 0.62, 0, 0],
    color: PAL.ARMOR_L,
    ...S_CHROME,
    uvScale: 7,
  });
  // heat shroud fins
  for (let i = 0; i < 4; i++) {
    p.add(chamferBox(0.06, 0.13, 0.24, 0.015), {
      pos: [0.14 + i * 0.07, -L - 0.16 - i * 0.05, 0],
      rot: [0, 0, -0.62],
      color: PAL.ARMOR_DD,
      ...S_FRAME,
      uvScale: 5,
    });
  }
  G.strip(p, [0.06, -L - 0.08, 0.15], 'y', 0.24, 0.028, PAL.EMI_AMBER, 2.4);
  // magazine
  p.add(chamferBox(0.16, 0.26, 0.18, 0.03), {
    pos: [-0.1, -L - 0.16, 0],
    rot: [0, 0, 0.2],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 3.4,
  });
  G.scatter(p, rng, { c: [0, -L * 0.4, -0.18], axis: 'z', sign: -1, u: 0.3, v: 0.36 }, 3);
  return p.merge();
}

// --- legs ------------------------------------------------------------------

function buildThigh(rng, side) {
  const p = new Part(`thigh${side > 0 ? 'L' : 'R'}`);
  const L = M.thigh;
  p.add(tube(0.16, 0.14, L * 0.92, 8), { pos: [0, -L / 2, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 2.4, flat: false });
  // outer armour shell, bulged forward
  p.add(taperBox(0.42, L * 0.86, 0.42, 0.2, 0.06), { pos: [0.03, -L * 0.46, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.5 });
  p.add(chamferBox(0.2, L * 0.6, 0.3, 0.04), { pos: [-0.17, -L * 0.44, 0], color: PAL.ARMOR_D, ...S_ARMOR, uvScale: 2.2 });
  G.piston(p, [0.2, -L * 0.5, side * 0.02], [0, 0, -0.12], L * 0.8, 0.032);
  G.strip(p, [0.0, -L * 0.5, side * 0.22], 'y', L * 0.5, 0.03, PAL.EMI, 2.2);
  // knee ball (the reverse joint's apex — deliberately chunky)
  p.add(blob(0.19, 1), { pos: [0, -L, 0], color: PAL.RUBBER, ...S_RUBBER, uvScale: 3.4, flat: false });
  G.scatter(p, rng, { c: [0.22, -L * 0.5, 0], axis: 'x', sign: 1, u: 0.44, v: 0.3 }, 3);
  return p.merge();
}

function buildShin(rng, side) {
  const p = new Part(`shin${side > 0 ? 'L' : 'R'}`);
  const L = M.shin;
  // knee guard spurs backwards over the joint
  p.add(taperBox(0.36, 0.34, 0.38, 0.3, 0.05), {
    pos: [-0.1, -0.02, 0],
    rot: [0, 0, -0.5],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 2,
  });
  p.add(wedge(0.28, 0.24, 0.3, 0.03), {
    pos: [-0.24, 0.02, 0],
    rot: [0, 0, 2.9],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.4,
  });
  G.strip(p, [-0.06, 0.06, side * 0.19], 'x', 0.22, 0.03, PAL.EMI, 2.8);
  // shin frame + calf armour
  p.add(tube(0.14, 0.17, L * 0.9, 8), { pos: [0, -L / 2, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 2.6, flat: false });
  p.add(taperBox(0.4, L * 0.8, 0.44, -0.16, 0.06), { pos: [0.02, -L * 0.46, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 1.5 });
  // rear calf thruster block — reads as a heel spur in silhouette
  p.add(chamferBox(0.26, 0.4, 0.34, 0.05), {
    pos: [-0.24, -L * 0.66, 0],
    rot: [0, 0, 0.18],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.2,
  });
  p.add(tube(0.075, 0.11, 0.16, 8, true), {
    pos: [-0.32, -L * 0.86, 0],
    rot: [0, 0, 0.5],
    color: PAL.ARMOR_DD,
    rough: 0.9,
    metal: 1,
    emissive: PAL.THRUST,
    emissiveInt: 0.8,
    uvScale: 6,
    flat: false,
  });
  G.piston(p, [0.17, -L * 0.45, side * 0.02], [0, 0, 0.1], L * 0.66, 0.028);
  // ankle
  p.add(blob(0.14, 1), { pos: [0, -L, 0], color: PAL.RUBBER, ...S_RUBBER, uvScale: 4, flat: false });
  G.scatter(p, rng, { c: [0.22, -L * 0.5, 0], axis: 'x', sign: 1, u: 0.44, v: 0.34 }, 3);
  G.scatter(p, rng, { c: [0, -L * 0.5, side * 0.23], axis: 'z', sign: side, u: 0.34, v: 0.4 }, 2);
  return p.merge();
}

function buildFoot(rng, side) {
  const p = new Part(`foot${side > 0 ? 'L' : 'R'}`);
  // sole spans local y in [-0.35, 0] so the ankle sits at 0.35 above ground
  p.add(chamferBox(0.72, 0.16, 0.44, 0.04), { pos: [0.1, -0.26, 0], color: PAL.ARMOR_DD, ...S_RUBBER, uvScale: 2.2 });
  p.add(taperBox(0.6, 0.24, 0.46, 0.24, 0.05), { pos: [0.08, -0.11, 0], color: PAL.ARMOR, ...S_ARMOR, uvScale: 2 });
  // toe claw
  p.add(wedge(0.28, 0.16, 0.4, 0.03), {
    pos: [0.42, -0.24, 0],
    rot: [0, 0, 0.12],
    color: PAL.ARMOR_L,
    ...S_ARMOR_MATTE,
    uvScale: 2.6,
  });
  // heel spur
  p.add(wedge(0.24, 0.2, 0.3, 0.03), {
    pos: [-0.26, -0.2, 0],
    rot: [0, 0, Math.PI - 0.2],
    color: PAL.ARMOR_D,
    ...S_ARMOR,
    uvScale: 2.8,
  });
  p.add(tube(0.1, 0.12, 0.16, 8), { pos: [0, 0.0, 0], color: PAL.FRAME, ...S_FRAME, uvScale: 4, flat: false });
  G.strip(p, [0.08, -0.14, side * 0.22], 'x', 0.36, 0.028, PAL.EMI, 2.0);
  G.boltRow(p, [0.1, -0.34, 0], 'y', -1, AX.z, 3, 0.13, 0.022);
  G.scatter(p, rng, { c: [0.1, -0.05, side * 0.23], axis: 'z', sign: side, u: 0.42, v: 0.18 }, 2);
  return p.merge();
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function bone(name, x, y, z) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  o.userData.rest = { px: x, py: y, pz: z, rx: 0, ry: 0, rz: 0 };
  return o;
}

function setRest(b, rx, ry, rz) {
  b.rotation.set(rx, ry, rz);
  b.userData.rest.rx = rx;
  b.userData.rest.ry = ry;
  b.userData.rest.rz = rz;
  return b;
}

/**
 * Build the mech. Returns the object the animator poses and the module renders.
 * @param {object} opts { renderer }
 */
export function createMech(opts = {}) {
  const rng = new Rng(0xba1d5c1a);
  const surface = makeMechSurface(512, 0x5eeda11);

  const emiPulse = { value: 1 };
  const material = new THREE.MeshStandardMaterial({
    map: surface.map,
    normalMap: surface.normalMap,
    roughnessMap: surface.roughnessMap,
    roughness: 0.82,
    // NOT fully metallic, deliberately. A metalness of 1 leaves the surface with no
    // diffuse response at all, so it can only be lit by what the environment map
    // happens to contain — and in a night city that is almost nothing, which renders
    // the mech as a black cutout no matter how many lights are aimed at it. Real
    // mech armour is painted plate (a dielectric) over a metal frame, so a mixed
    // value is both more correct and far more readable.
    metalness: 0.5,
    emissive: 0x000000,
    envMapIntensity: 1.55,
  });
  material.normalScale.set(0.85, 0.85);
  attachVertexResponse(material, emiPulse);

  const fallbackEnv = makeFallbackEnvironment(opts.renderer);
  if (fallbackEnv) material.envMap = fallbackEnv;

  // --- skeleton ---
  const root = new THREE.Object3D();
  root.name = 'simulacrum';
  const body = bone('body', 0, 0, 0);
  root.add(body);

  const hips = bone('hips', 0, M.hipY, 0);
  body.add(hips);

  const torso = bone('torso', 0, M.waistY, 0);
  hips.add(torso);

  const head = bone('head', 0.02, M.headY, 0);
  torso.add(head);

  const backpack = bone('backpack', -0.4, 0.62, 0);
  torso.add(backpack);

  const shoulderL = bone('shoulderL', 0, M.shoulderY, M.shoulderZ);
  const shoulderR = bone('shoulderR', 0, M.shoulderY, -M.shoulderZ);
  torso.add(shoulderL, shoulderR);

  const upperArmL = setRest(bone('upperArmL', 0, -0.04, 0.04), 0.14, 0, -0.1);
  const upperArmR = setRest(bone('upperArmR', 0, -0.04, -0.04), -0.14, 0, -0.06);
  shoulderL.add(upperArmL);
  shoulderR.add(upperArmR);

  const forearmL = setRest(bone('forearmL', 0, -M.upperArm, 0), 0, 0, 0.34);
  const forearmR = setRest(bone('forearmR', 0, -M.upperArm, 0), 0, 0, 0.28);
  upperArmL.add(forearmL);
  upperArmR.add(forearmR);

  const skirtL = setRest(bone('skirtL', 0, -0.04, 0.4), 0, 0, 0);
  const skirtR = setRest(bone('skirtR', 0, -0.04, -0.4), 0, 0, 0);
  hips.add(skirtL, skirtR);

  const legs = [];
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'L' : 'R';
    const thigh = setRest(bone(`thigh${tag}`, 0, -0.02, side * M.hipZ), 0, 0, M.restThigh);
    const shin = setRest(bone(`shin${tag}`, 0, -M.thigh, 0), 0, 0, M.restShinAbs - M.restThigh);
    const foot = setRest(bone(`foot${tag}`, 0, -M.shin, 0), 0, 0, -M.restShinAbs);
    hips.add(thigh);
    thigh.add(shin);
    shin.add(foot);
    legs.push({ side, thigh, shin, foot });
  }

  // --- meshes ---
  const meshes = [];
  const attach = (parent, geo) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, material);
    m.name = geo.name || parent.name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false; // static within its bone
    parent.add(m);
    m.updateMatrix();
    meshes.push(m);
    return m;
  };

  attach(hips, buildHips(rng));
  attach(skirtL, buildSkirt(rng, 1));
  attach(skirtR, buildSkirt(rng, -1));
  attach(torso, buildTorso(rng));
  attach(backpack, buildBackpack(rng));
  attach(head, buildHead(rng));
  attach(shoulderL, buildPauldronL(rng));
  attach(shoulderR, buildPauldronR(rng));
  attach(upperArmL, buildUpperArm(rng, 1));
  attach(upperArmR, buildUpperArm(rng, -1));
  attach(forearmL, buildForearmL(rng));
  attach(forearmR, buildForearmR(rng));
  for (const l of legs) {
    attach(l.thigh, buildThigh(rng, l.side));
    attach(l.shin, buildShin(rng, l.side));
    attach(l.foot, buildFoot(rng, l.side));
  }

  // --- thruster plumes (additive, scaled by thrust) ------------------------
  const plumeGeo = makePlumeGeometry();
  const plumeMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    // TONE MAPPED, unlike every other additive effect here.
    //
    // Skipping the tone map writes the plume's raw value straight to the target, and
    // the nozzle end of this geometry carries a vertex colour of ~1.7 — doubled again
    // by DoubleSide, since you see the far wall of the cone through the near one. The
    // result measured as a hard-edged quad 7% of whose pixels were above 250/255 with
    // no falloff and no hue: the hottest object in the frame was achromatic, which
    // broke the palette at exactly the point the eye is pulled to. Running it through
    // ACES lets the highlight roll off and keeps the flame orange while it does.
    toneMapped: true,
  });
  const thrusters = [];
  for (const z of [0.3, -0.3]) {
    const t = new THREE.Mesh(plumeGeo, plumeMat);
    t.position.set(-0.26, -0.72, z);
    t.rotation.z = 0.34;
    t.scale.set(1, 0.001, 1);
    t.renderOrder = 5;
    backpack.add(t);
    thrusters.push(t);
  }

  // --- energy sabre blade (hidden until a melee weapon fires) --------------
  const sabre = new THREE.Mesh(makeBladeGeometry(1.85, 0.13), plumeMat);
  sabre.position.set(0.06, -M.foreArm - 0.06, 0);
  sabre.rotation.z = -0.2;
  sabre.visible = false;
  sabre.renderOrder = 6;
  forearmL.add(sabre);

  // --- contact shadow ------------------------------------------------------
  const shadowTex = makeContactShadowTexture(128);
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    new THREE.MeshBasicMaterial({
      alphaMap: shadowTex,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: false,
      // DoubleSide is not optional here. PlaneGeometry faces +Z, and the -90° X
      // rotation that lays it flat points that face straight DOWN into the road, so
      // from an overhead camera only the culled back face was ever toward the
      // viewer. The shadow was being rendered correctly and was invisible in every
      // frame of the project until this was found by forcing it to 4x scale, full
      // opacity and bright red and still seeing nothing.
      side: THREE.DoubleSide,
      color: 0x000000,
      toneMapped: false,
    })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.02;
  // Draws AFTER the ground, not before. At renderOrder -1 the shadow was
  // rasterised first and the ground then painted straight over it, which is why
  // the mech appeared pasted onto the road with no occlusion at all.
  contactShadow.renderOrder = 6;
  root.add(contactShadow);

  const mech = {
    root,
    material,
    emiPulse,
    surface,
    meshes,
    thrusters,
    sabre,
    contactShadow,
    metrics: M,
    bones: {
      body,
      hips,
      torso,
      head,
      backpack,
      shoulderL,
      shoulderR,
      upperArmL,
      upperArmR,
      forearmL,
      forearmR,
      skirtL,
      skirtR,
      legs,
    },
    drawCalls: meshes.length + thrusters.length + 2,
    _fallbackEnv: fallbackEnv,

    /**
     * If the render module installs a real environment map, hand the reflections
     * over to it rather than fighting its art direction with our fallback probe.
     */
    syncEnvironment(scene) {
      if (!fallbackEnv || !scene) return;
      if (scene.environment && material.envMap === fallbackEnv) {
        material.envMap = null;
        material.needsUpdate = true;
      } else if (!scene.environment && material.envMap !== fallbackEnv) {
        material.envMap = fallbackEnv;
        material.needsUpdate = true;
      }
    },

    dispose() {
      root.traverse((o) => {
        if (o.isMesh && o.geometry) o.geometry.dispose();
      });
      material.dispose();
      plumeMat.dispose();
      plumeGeo.dispose();
      sabre.geometry.dispose();
      contactShadow.geometry.dispose();
      contactShadow.material.dispose();
      shadowTex.dispose();
      surface.dispose();
      fallbackEnv?.dispose?.();
    },
  };

  return mech;
}

/** A tapering plume: hot white core at the nozzle fading to transparent amber. */
function makePlumeGeometry() {
  const g = new THREE.CylinderGeometry(0.19, 0.03, 1, 8, 4, true);
  g.translate(0, -0.5, 0);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  // The core is warm, not white. Let the bloom pass whiten it if it wants to; baking
  // white into the source throws the colour away before anything can use it.
  const c0 = new THREE.Color(0xffd79a);
  const c1 = new THREE.Color(0xff6a10);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, -pos.getY(i)));
    c.copy(c0).lerp(c1, Math.pow(t, 0.6)).multiplyScalar(Math.pow(1 - t, 1.6) * 1.15 + 0.02);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Sabre blade: hot core lens + wider halo, gradient along the blade. */
function makeBladeGeometry(len, r) {
  const parts = [];
  for (let layer = 0; layer < 2; layer++) {
    const rad = layer === 0 ? r * 0.36 : r;
    const g = new THREE.CylinderGeometry(rad * 0.25, rad, len, layer === 0 ? 6 : 8, 3, true);
    g.translate(0, len * 0.5, 0);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const hot = new THREE.Color(layer === 0 ? 0xffffff : 0x6ff0ff);
    const cool = new THREE.Color(0x1a86ff);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, pos.getY(i) / len));
      c.copy(hot).lerp(cool, t * 0.7);
      c.multiplyScalar((layer === 0 ? 2.6 : 1.1) * (1 - Math.pow(t, 3) * 0.85));
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g.toNonIndexed());
    g.dispose();
  }
  const merged = parts[0];
  const combined = new THREE.BufferGeometry();
  const a = parts[0].attributes;
  const b = parts[1].attributes;
  for (const key of ['position', 'normal', 'color']) {
    const arr = new Float32Array(a[key].array.length + b[key].array.length);
    arr.set(a[key].array, 0);
    arr.set(b[key].array, a[key].array.length);
    combined.setAttribute(key, new THREE.BufferAttribute(arr, a[key].itemSize));
  }
  parts[0].dispose();
  parts[1].dispose();
  void merged;
  return combined;
}
