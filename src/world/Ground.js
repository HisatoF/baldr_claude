/**
 * The playfield: a battle-scarred elevated roadway cutting through the city.
 *
 * `groundHeightAt(x)` is the contract physics and AI sample against, so it is a pure,
 * allocation-free, branch-light function of x alone — a few sines plus a small table
 * of gaussian features. The *mesh* then displaces to exactly that function along the
 * gameplay line (z = 0) and only adds lateral variation as |z| grows, so what the
 * player sees under the mech's feet is byte-for-byte what the collider uses.
 *
 * Layout across z:
 *
 *      z = -78 .......... -30 ........ -14 |  road  | +14 ....... +34
 *      raised terrace      kerb       carriageway     kerb   near verge
 *
 * The kerbs matter more than they sound: two hard horizontal lines running the length
 * of frame are what make a quarter view read as a *road* instead of a grey plane.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  makeConcrete,
  makeMetalPanel,
  makeRoadDecal,
  makeBlobMask,
  makeRippleNormal,
  mulberry32,
} from './Textures.js';
import { makeContactShadowTexture } from '../combat/MechMaterials.js';

export const ROAD_HALF = 13.0;
export const GROUND_MIN_X = -160;
export const GROUND_MAX_X = 160;
export const GROUND_MIN_Z = -78;
export const GROUND_MAX_Z = 34;

const sstep = (e0, e1, x) => {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
};

/**
 * Localised terrain features. Positive = rubble mound / buckled slab,
 * negative = shell crater. Kept shallow (|h| ≤ 1.4) and wide so the mech never
 * catches on geometry at dash speed — this is an action game, not a platformer.
 */
const FEATURES = [
  { x: -104, w: 13, h: 0.95 },
  { x: -78, w: 10, h: -0.55 },
  { x: -46, w: 15, h: 1.25 },
  { x: -21, w: 9, h: -0.50 },
  { x: 6, w: 12, h: 0.62 },
  { x: 34, w: 8, h: -0.45 },
  { x: 62, w: 16, h: 1.30 },
  { x: 96, w: 11, h: -0.60 },
  { x: 124, w: 12, h: 0.85 },
];

/**
 * Terrain height at gameplay position x. Contractual (ARCHITECTURE §11) — physics
 * landing checks, AI pathing and VFX ground snapping all call this every step, so it
 * must stay cheap and must never allocate.
 * @param {number} x
 * @returns {number} height in world units above y = 0
 */
export function groundHeightAt(x) {
  let h =
    0.26 * Math.sin(x * 0.0417 + 1.7) +
    0.15 * Math.sin(x * 0.1130 - 0.6) +
    0.07 * Math.sin(x * 0.2810 + 2.4);
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    const t = (x - f.x) / f.w;
    if (t > -3 && t < 3) h += f.h * Math.exp(-t * t);
  }
  return h;
}

/** Cross-road profile: kerbs and the raised rear terrace. Zero on the gameplay line. */
function crossSection(z) {
  const az = Math.abs(z);
  let y = 0.90 * sstep(ROAD_HALF, ROAD_HALF + 1.3, az);
  // rear terrace steps up again so the midground buildings sit on a plinth
  if (z < -26) y += 2.4 * sstep(26, 36, -z);
  if (z < -52) y += 1.8 * sstep(52, 66, -z);
  return y;
}

/** Lateral detail that fades to exactly zero at the gameplay line. */
function lateral(x, z) {
  const m = sstep(0.0, 7.0, Math.abs(z));
  if (m <= 0) return 0;
  return (
    m *
    (0.11 * Math.sin(x * 0.071 + z * 0.113) +
      0.075 * Math.sin(x * 0.191 - z * 0.087 + 1.3) +
      0.045 * Math.sin(x * 0.41 + z * 0.33))
  );
}

/** Full surface height including cross-section — used to seat props on the road. */
export function surfaceHeightAt(x, z) {
  return groundHeightAt(x) + crossSection(z) + lateral(x, z);
}

/* ------------------------------------------------------------------ */

/**
 * Z row positions for the playfield mesh.
 *
 * A uniform grid is the wrong tool here. The kerb is a 1.3-unit ramp, and at the old
 * uniform spacing (112 units over 60 rows = 1.87 units per row) the entire ramp fell
 * between two adjacent vertex rows — so the smooth `crossSection` profile was sampled
 * at essentially two points and rasterised as a single hard crease whose position
 * jittered with the grid rather than with the road. That crease is the seam a review
 * flagged as "berm meets pavement with no transition".
 *
 * The fix is not more rows everywhere; it is rows where the profile actually bends.
 * This clusters them at both kerbs and at the two terrace steps and leaves the flat
 * carriageway and the far terrace coarse, which costs a few thousand vertices instead
 * of the ~35k a uniform refinement would.
 */
function playfieldZRows(z0, z1) {
  // Places the profile bends. Each entry is [centre, half-width, rows across it].
  const BENDS = [
    [ROAD_HALF, 2.2, 9],
    [-ROAD_HALF, 2.2, 9],
    [-31, 6.0, 7],
    [-59, 8.0, 5],
  ];
  const rows = new Set();
  const COARSE = 56;
  for (let i = 0; i <= COARSE; i++) rows.add(z0 + ((z1 - z0) * i) / COARSE);
  for (const [c, hw, n] of BENDS) {
    for (let i = 0; i <= n; i++) {
      const z = c - hw + (2 * hw * i) / n;
      if (z > z0 && z < z1) rows.add(z);
    }
  }
  return Array.from(rows).sort((a, b) => a - b);
}

/**
 * Build a displaced surface from an explicit list of z rows and a uniform x division.
 * Vertices are placed at exactly `surfaceHeightAt`, so what is drawn under the mech's
 * feet is what the collider samples.
 */
function buildSurfaceGeometryRows(x0, x1, rows, segX, lift) {
  const nz = rows.length;
  const nx = segX + 1;
  const count = nx * nz;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const idx = new Uint32Array(segX * (nz - 1) * 6);

  for (let j = 0; j < nz; j++) {
    const z = rows[j];
    const v = (z - rows[0]) / (rows[nz - 1] - rows[0]);
    for (let i = 0; i < nx; i++) {
      const u = i / segX;
      const x = x0 + (x1 - x0) * u;
      const o = (j * nx + i) * 3;
      pos[o] = x;
      pos[o + 1] = surfaceHeightAt(x, z) + lift;
      pos[o + 2] = z;
      uv[(j * nx + i) * 2] = u;
      uv[(j * nx + i) * 2 + 1] = 1 - v;
    }
  }
  let k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Rewrite a BoxGeometry's UVs so its texel density matches the world, not the box.
 *
 * `BoxGeometry` gives every face UV 0..1 regardless of how large that face is, so a
 * shared tiling material applies the SAME number of tile repetitions to a 0.6 m kerb
 * block and to a 5 m buckled slab. At the road's repeat that packed dozens of tiles
 * onto a single slab face, which at gameplay distance averages out to a flat uniform
 * grey — the "untextured plate" a review found under the hero. Densities must be
 * expressed in metres per tile, once, and every surface must obey the same one.
 *
 * Assumes a 1-segment box: 6 faces of 4 vertices in three.js's px,nx,py,ny,pz,nz order.
 */
function retileBoxUV(geo, w, h, d, unitsPerTile) {
  const uv = geo.attributes.uv;
  if (!uv || uv.count !== 24) return geo;
  const k = 1 / unitsPerTile;
  // per face pair: [u extent, v extent] in world units
  const spans = [
    [d, h], [d, h], // +x, -x
    [w, d], [w, d], // +y, -y
    [w, h], [w, h], // +z, -z
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * su * k, uv.getY(i) * sv * k);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

function buildSurfaceGeometry(x0, x1, z0, z1, segX, segZ, lift) {
  const rows = [];
  for (let i = 0; i <= segZ; i++) rows.push(z0 + ((z1 - z0) * i) / segZ);
  return buildSurfaceGeometryRows(x0, x1, rows, segX, lift);
}

/**
 * Build the whole playfield.
 * @returns {{group:THREE.Group, dispose:Function, shadowCasters:THREE.Object3D[]}}
 */
export function buildGround(opts = {}) {
  const group = new THREE.Group();
  group.name = 'world.ground';
  const disposables = [];
  const rnd = mulberry32(0xa5f00d);

  /* ---------------- main surface ---------------- */

  const asphalt = makeConcrete({
    size: 512,
    seed: 4404,
    base: [0.052, 0.056, 0.068],
    cracks: 11,
    aggregate: 1.15,
    stain: 1.1,
    rough: 0.90,
    damp: 0.75,
    // Asphalt is a flat surface with fine relief, so its normal map must carry the
    // aggregate and nothing larger. See makeConcrete for what the coupled macro
    // band was doing to the road.
    macroHeight: 0.045,
    normalStrength: 1.1,
  });

  const SEG_X = 320;
  const geo = buildSurfaceGeometryRows(
    GROUND_MIN_X,
    GROUND_MAX_X,
    playfieldZRows(GROUND_MIN_Z, GROUND_MAX_Z),
    SEG_X,
    0
  );

  // Macro colour variation baked per-vertex. Tiling a 10 m texture over a 320 m road
  // would otherwise read as wallpaper; large slow-moving tonal drift breaks that up
  // far more cheaply than a second texture fetch would.
  {
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const az = Math.abs(z);
      // carriageway is darker and oilier; kerb/terrace concrete is lighter and cooler
      const onRoad = 1 - sstep(ROAD_HALF - 0.5, ROAD_HALF + 1.6, az);
      const drift =
        0.5 +
        0.28 * Math.sin(x * 0.031 + 0.7) * Math.sin(z * 0.047 - 1.2) +
        0.16 * Math.sin(x * 0.0091 + z * 0.019 + 2.1);
      const tyre = Math.exp(-Math.pow((az - 4.6) / 2.4, 2)) * onRoad;
      // Grime wedge at the foot of each kerb. Water, grit and exhaust soot collect
      // where a vertical face meets a horizontal one, so the darkest line on a real
      // street is not the kerb edge itself but the 2-3 m of road up against it.
      // Without it the kerb reads as two flat tones butted together — a seam rather
      // than a junction — however smooth the geometry underneath is.
      const kerbFoot = Math.exp(-Math.pow((az - (ROAD_HALF - 1.1)) / 1.9, 2));
      // and a matching pale wash of dust on the raised side, which catches light
      // instead of losing it
      const kerbTop = Math.exp(-Math.pow((az - (ROAD_HALF + 2.4)) / 2.6, 2));
      let v = 0.62 + drift * 0.55;
      v *= 1 - onRoad * 0.22;
      v *= 1 - tyre * 0.20;
      v *= 1 - kerbFoot * 0.34;
      v *= 1 + kerbTop * 0.16;
      // scorch pooling in the crater features
      const gh = groundHeightAt(x);
      v *= 1 - Math.max(0, -gh) * 0.30;
      c.setRGB(v * 0.94, v * 0.97, v * 1.10);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv1', geo.attributes.uv);
  }

  for (const t of [asphalt.map, asphalt.orm, asphalt.normalMap]) t.repeat.set(36, 12.6);

  const groundMat = new THREE.MeshStandardMaterial({
    map: asphalt.map,
    normalMap: asphalt.normalMap,
    roughnessMap: asphalt.orm,
    metalnessMap: asphalt.orm,
    aoMap: asphalt.orm,
    aoMapIntensity: 0.85,
    roughness: 1.0,
    metalness: 1.0,
    vertexColors: true,
    // Halved alongside the texture's own strength. Two multipliers on the same
    // effect is how it reached the amplitude it did.
    normalScale: new THREE.Vector2(0.55, 0.55),
    envMapIntensity: 0.55,
    dithering: true,
  });
  disposables.push(geo, groundMat);

  const ground = new THREE.Mesh(geo, groundMat);
  ground.receiveShadow = true;
  ground.name = 'ground.surface';
  group.add(ground);

  /* ---------------- painted road markings ---------------- */

  const decalTex = makeRoadDecal({ seed: 771 });
  decalTex.repeat.set(16, 1);
  const decalGeo = buildSurfaceGeometry(GROUND_MIN_X, GROUND_MAX_X, -ROAD_HALF, ROAD_HALF, 300, 6, 0.012);
  const decalMat = new THREE.MeshStandardMaterial({
    map: decalTex,
    // Road paint is set dressing and must lose the contrast contest to the mech.
    // At full opacity the yellow crosswalk was the most saturated, highest-value
    // object in frame and the eye went to it instead of to the player.
    color: 0x8e9099,
    transparent: true,
    opacity: 0.62,
    roughness: 0.62,
    metalness: 0.0,
    envMapIntensity: 0.4,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  disposables.push(decalGeo, decalMat);
  const decal = new THREE.Mesh(decalGeo, decalMat);
  decal.renderOrder = 1;
  decal.name = 'ground.markings';
  group.add(decal);

  /* ---------------- scorch / oil decals ---------------- */

  const scorchTex = makeBlobMask({ size: 256, seed: 8899, rough: 0.55, inner: 0.10, outer: 0.92 });
  const scorchGeo = new THREE.PlaneGeometry(1, 1);
  scorchGeo.rotateX(-Math.PI / 2);
  const scorchMat = new THREE.MeshBasicMaterial({
    // Scorch is a stain, not a hole.
    //
    // At 0.78 alpha over near-black these punched the road down to luminance ~10 in
    // hard-edged irregular patches several metres across, and read as gaps in the
    // surface rather than as burn marks. Soot on wet asphalt is dark but it is not
    // darker than the shadows around it, and it never has a clean edge.
    color: 0x0d1018,
    alphaMap: scorchTex,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    fog: true,
  });
  const SCORCH_N = 26;
  const scorch = new THREE.InstancedMesh(scorchGeo, scorchMat, SCORCH_N);
  scorch.renderOrder = 2;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < SCORCH_N; i++) {
      const x = -150 + rnd() * 300;
      const z = -20 + rnd() * 34;
      const r = 2.5 + rnd() * 7;
      p.set(x, surfaceHeightAt(x, z) + 0.02, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      s.set(r, 1, r * (0.6 + rnd() * 0.7));
      scorch.setMatrixAt(i, m.compose(p, q, s));
    }
    scorch.instanceMatrix.needsUpdate = true;
  }
  disposables.push(scorchGeo, scorchMat);
  group.add(scorch);

  /* ---------------- puddles ---------------- */

  // Wet asphalt is the single highest-value material in a rain-lit night scene: it is
  // the only surface that shows the neon *as reflection* rather than as direct light.
  const puddleMask = makeBlobMask({ size: 256, seed: 1717, rough: 0.5, inner: 0.34, outer: 0.92 });
  const puddleNormal = makeRippleNormal({ size: 256, seed: 616, strength: 0.9 });
  puddleNormal.repeat.set(2, 2);
  const puddleGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
  puddleGeo.rotateX(-Math.PI / 2);
  // Wet asphalt is a DIELECTRIC, not a metal.
  //
  // At metalness 0.86 and roughness 0.045 these were mirrors, and a mirror in a
  // night scene with a dark environment map reflects almost nothing — every puddle
  // rendered as a hard-edged pure black hole punched through the road. Dropping
  // metalness restores the diffuse term underneath, so the puddle keeps the road's
  // value and gains a wet specular sheen from the neon on top of it, which is what
  // wet ground actually does.
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0x1b2430,
    roughness: 0.16,
    metalness: 0.04,
    normalMap: puddleNormal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    alphaMap: puddleMask,
    transparent: true,
    opacity: 0.72,
    envMapIntensity: 1.4,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const PUDDLE_N = 30;
  const puddles = new THREE.InstancedMesh(puddleGeo, puddleMat, PUDDLE_N);
  puddles.renderOrder = 3;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < PUDDLE_N; i++) {
      const x = -155 + rnd() * 310;
      const z = -24 + rnd() * 40;
      // water pools in the dips — bias placement toward low ground
      const y = surfaceHeightAt(x, z);
      const r = 2.2 + rnd() * 5.5;
      p.set(x, y + 0.055, z);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      s.set(r, 1, r * (0.45 + rnd() * 0.8));
      puddles.setMatrixAt(i, m.compose(p, q, s));
    }
    puddles.instanceMatrix.needsUpdate = true;
  }
  disposables.push(puddleGeo, puddleMat);
  group.add(puddles);

  /* ---------------- debris field ---------------- */

  // Every static prop placed below records the footprint it should darken. The key
  // light's shadow map does draw these, but a 0.6 m chunk covers ~9 texels of a
  // 2048 map spread over a 140 m frustum, and `normalBias` then pushes that handful
  // of texels off the contact point entirely — so small props render a shadow that
  // is real, correct, and detached from the object making it. They read as floating.
  // A decal under each one is the same fix that seated the enemies, applied to the
  // set dressing.
  const propShadows = [];

  // Broken concrete: dark, rough, and NOT metallic.
  //
  // A white albedo at full metalness made these slabs the brightest surfaces in the
  // frame — brighter than any emissive — so the eye went to the rubbish rather than
  // to the mech, inverting the whole contrast hierarchy. Value is dropped well below
  // the hero and metalness returned to something a dielectric would actually have.
  //
  // These get their OWN texture instances at repeat 1. The road's maps carry
  // repeat (36, 12.6) tuned for a 320 x 112 m plane; reusing them on props means
  // every prop face is tiled 36 times over a metre or two, which averages to flat
  // grey. Rubble UVs are authored in world units instead (see retileBoxUV), so the
  // maps they sample must be left un-tiled.
  const rubbleMaps = {
    map: asphalt.map.clone(),
    normalMap: asphalt.normalMap.clone(),
    orm: asphalt.orm.clone(),
  };
  for (const t of Object.values(rubbleMaps)) {
    t.repeat.set(1, 1);
    t.needsUpdate = true;
    disposables.push(t);
  }
  const rubbleMat = new THREE.MeshStandardMaterial({
    color: 0x525a66,
    map: rubbleMaps.map,
    normalMap: rubbleMaps.normalMap,
    roughnessMap: rubbleMaps.orm,
    metalnessMap: rubbleMaps.orm,
    roughness: 1.0,
    metalness: 0.12,
    envMapIntensity: 0.5,
  });
  disposables.push(rubbleMat);

  /** Metres of world per texture tile. One number, obeyed by every rubble surface. */
  const RUBBLE_TILE = 2.4;

  // one irregular chunk, reused at many scales/orientations
  const chunkGeo = new THREE.IcosahedronGeometry(0.5, 0);
  {
    const p = chunkGeo.attributes.position;
    const jr = mulberry32(77);
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(
        i,
        p.getX(i) * (0.55 + jr() * 0.9),
        p.getY(i) * (0.4 + jr() * 0.7),
        p.getZ(i) * (0.55 + jr() * 0.9)
      );
    }
    chunkGeo.computeVertexNormals();
    // Same world-units-per-tile rule as the boxes. An icosahedron's UVs span roughly
    // 0..1 over the whole shell, so at the road's density a 1 m chunk would carry an
    // entire texture — detail far finer than a pixel, which resolves to flat noise.
    const cuv = chunkGeo.attributes.uv;
    if (cuv) {
      for (let i = 0; i < cuv.count; i++) cuv.setXY(i, cuv.getX(i) * 0.45, cuv.getY(i) * 0.45);
      cuv.needsUpdate = true;
    }
  }
  const DEBRIS_N = 190;
  const debris = new THREE.InstancedMesh(chunkGeo, rubbleMat, DEBRIS_N);
  debris.castShadow = true;
  debris.receiveShadow = true;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < DEBRIS_N; i++) {
      // cluster debris around the crater/mound features — rubble does not fall evenly
      const f = FEATURES[(rnd() * FEATURES.length) | 0];
      const near = rnd() < 0.55;
      const x = near ? f.x + (rnd() - 0.5) * f.w * 3.2 : -158 + rnd() * 316;
      const z = -34 + rnd() * 52;
      const sc = 0.35 + rnd() * (near ? 1.9 : 1.0);
      p.set(x, surfaceHeightAt(x, z) + sc * 0.16, z);
      e.set(rnd() * 3, rnd() * 6.3, rnd() * 3);
      q.setFromEuler(e);
      s.set(sc * (0.7 + rnd() * 0.8), sc * (0.5 + rnd() * 0.6), sc * (0.7 + rnd() * 0.8));
      debris.setMatrixAt(i, m.compose(p, q, s));
      propShadows.push({ x, z, rx: sc * 1.5, rz: sc * 1.45, rot: e.y, o: 0.62 });
    }
    debris.instanceMatrix.needsUpdate = true;
  }
  disposables.push(chunkGeo);
  group.add(debris);

  /* ---------------- twisted rebar / conduit scraps ---------------- */

  const rebarSrc = makeMetalPanel({
    size: 256,
    seed: 3131,
    base: [0.20, 0.17, 0.15],
    grime: 0.9,
    wear: 0.5,
    rough: 0.72,
    metal: 0.85,
  });
  const rebarMat = new THREE.MeshStandardMaterial({
    map: rebarSrc.map,
    normalMap: rebarSrc.normalMap,
    roughnessMap: rebarSrc.orm,
    metalnessMap: rebarSrc.orm,
    roughness: 1.0,
    // Steel, but not a mirror — at full metalness these went black against the night
    // sky and then aliased as hard dark specks against the lit road.
    metalness: 0.62,
    envMapIntensity: 1.0,
  });
  // Thickened from 0.055. At distance a 0.11-unit rod covers barely a pixel, and a
  // sub-pixel high-contrast edge cannot be anti-aliased by a post pass — it just
  // crawls. Geometry thin enough to alias has to be made thicker or removed.
  const rebarGeo = new THREE.CylinderGeometry(0.095, 0.095, 1, 6, 1);
  const REBAR_N = 70;
  const rebar = new THREE.InstancedMesh(rebarGeo, rebarMat, REBAR_N);
  rebar.castShadow = true;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < REBAR_N; i++) {
      const f = FEATURES[(rnd() * FEATURES.length) | 0];
      const x = f.x + (rnd() - 0.5) * f.w * 3.5;
      const z = -28 + rnd() * 44;
      const len = 1.2 + rnd() * 3.6;
      const lean = rnd() < 0.35;
      p.set(x, surfaceHeightAt(x, z) + (lean ? len * 0.35 : 0.06), z);
      e.set(lean ? (rnd() - 0.5) * 1.1 : Math.PI / 2 + (rnd() - 0.5) * 0.3, rnd() * 6.3, (rnd() - 0.5) * 0.9);
      q.setFromEuler(e);
      s.set(1, len, 1);
      rebar.setMatrixAt(i, m.compose(p, q, s));
      // A leaning rod touches the ground at one end; a fallen one lies along its
      // whole length, so its shadow is a streak rather than a dot.
      propShadows.push(
        lean
          ? { x, z, rx: 0.75, rz: 0.75, rot: e.y, o: 0.34 }
          : { x, z, rx: len * 0.62, rz: 0.5, rot: e.y, o: 0.42 }
      );
    }
    rebar.instanceMatrix.needsUpdate = true;
  }
  disposables.push(rebarGeo, rebarMat);
  group.add(rebar);

  /* ---------------- broken kerb blocks + slab heaves ---------------- */

  {
    const parts = [];
    const tmp = new THREE.Matrix4();
    const e = new THREE.Euler();
    for (let i = 0; i < 34; i++) {
      const x = -155 + rnd() * 310;
      const side = rnd() < 0.5 ? -1 : 1;
      const z = side * (ROAD_HALF + 0.4 + rnd() * 1.6);
      const w = 1.2 + rnd() * 2.6;
      const bh = 0.55 + rnd() * 0.5;
      const bd = 1.0 + rnd() * 0.9;
      const g = new THREE.BoxGeometry(w, bh, bd);
      retileBoxUV(g, w, bh, bd, RUBBLE_TILE);
      e.set((rnd() - 0.5) * 0.18, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.22);
      tmp.makeRotationFromEuler(e);
      tmp.setPosition(x, surfaceHeightAt(x, z) + 0.12, z);
      g.applyMatrix4(tmp);
      parts.push(g);
      propShadows.push({ x, z, rx: w * 0.72, rz: bd * 0.85, rot: e.y, o: 0.55 });
    }
    // buckled slabs lifted out of the carriageway by the crater features
    for (const f of FEATURES) {
      if (f.h < 0) continue;
      for (let k = 0; k < 3; k++) {
        const x = f.x + (rnd() - 0.5) * f.w * 1.6;
        const z = (rnd() - 0.5) * 18;
        const sw = 2.4 + rnd() * 3.2;
        const sd = 2.0 + rnd() * 3.0;
        const g = new THREE.BoxGeometry(sw, 0.32, sd);
        retileBoxUV(g, sw, 0.32, sd, RUBBLE_TILE);
        e.set((rnd() - 0.5) * 0.7, rnd() * 6.3, (rnd() - 0.5) * 0.7);
        tmp.makeRotationFromEuler(e);
        tmp.setPosition(x, surfaceHeightAt(x, z) + 0.22, z);
        g.applyMatrix4(tmp);
        parts.push(g);
        propShadows.push({ x, z, rx: sw * 0.66, rz: sd * 0.66, rot: e.y, o: 0.5 });
      }
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (merged) {
      const m = new THREE.Mesh(merged, rubbleMat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = 'ground.kerbrubble';
      group.add(m);
      disposables.push(merged);
    }
  }

  /* ---------------- static prop contact shadows ---------------- */

  {
    const tex = makeContactShadowTexture(128);
    disposables.push(tex);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    disposables.push(geo);

    // Two strength tiers, not per-instance opacity.
    //
    // Alpha is a material uniform; `instanceColor` multiplies the base colour, and
    // multiplying black by grey is still black, so the obvious per-instance approach
    // silently does nothing. Rather than write a custom shader for set dressing, the
    // props quantise into "sitting on the road" and "barely touching it" and each
    // tier is one instanced draw.
    const TIERS = [
      { max: 0.45, opacity: 0.38 },
      { max: 1.01, opacity: 0.66 },
    ];
    for (const tier of TIERS) {
      const items = propShadows.filter(
        (d) => d.o <= tier.max && d.o > (TIERS[TIERS.indexOf(tier) - 1]?.max ?? -1)
      );
      if (!items.length) continue;
      const mat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: tex,
        transparent: true,
        opacity: tier.opacity,
        depthWrite: false,
        // Unlike the mech's and the enemies' blobs these keep depth TESTING. There
        // are hundreds lying across the whole corridor, and with the test off they
        // would paint over anything standing in front of them, the player included.
        // Polygon offset keeps them off the road surface instead of z-fighting it.
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        // PlaneGeometry faces +Z; the -90 deg rotation that lays it flat aims that
        // face into the road, so without DoubleSide only the culled back face is
        // ever toward the camera. This has cost this project two rounds already.
        side: THREE.DoubleSide,
        toneMapped: false,
        // Ground contact recedes with the same haze as the road it sits on. An
        // un-fogged black decal at 120 m is darker than everything around it and
        // reads as a hole punched in the street.
        fog: true,
      });
      disposables.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, items.length);
      mesh.name = `ground.propShadows.${tier.opacity}`;
      mesh.renderOrder = 3;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const pv = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < items.length; i++) {
        const d = items[i];
        // Offset along the key light's throw so the decal lands where the shadow
        // actually falls rather than sitting symmetrically under the object.
        const ox = d.x + 0.22 * d.rx;
        const oz = d.z + 0.16 * d.rz;
        pv.set(ox, surfaceHeightAt(ox, oz) + 0.03, oz);
        q.setFromAxisAngle(up, d.rot || 0);
        sc.set(d.rx * 2, 1, d.rz * 2);
        mesh.setMatrixAt(i, m.compose(pv, q, sc));
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
  }

  return {
    group,
    puddleMaterial: puddleMat,
    dispose() {
      for (const d of disposables) d.dispose?.();
    },
  };
}
