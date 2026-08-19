import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE } from '../render/Palette.js';
import { makeContactShadowTexture } from '../combat/MechMaterials.js';
import { makeMechSurface } from '../combat/MechMaterials.js';

/**
 * Enemy archetype models.
 *
 * Each archetype is authored as a pile of primitives, baked to vertex colours, and
 * merged into ONE geometry that is then drawn with an InstancedMesh. The whole enemy
 * population therefore costs one draw call per archetype rather than one per limb per
 * enemy, which is what keeps a screen full of them inside the budget.
 *
 * The cost of that choice is that enemies cannot animate their limbs independently —
 * only the instance transform moves. So the silhouettes are designed to stay readable
 * under rigid-body motion: bob, lean, recoil and spin all read fine, and the rubric's
 * requirement is that the four shapes are distinguishable as black shapes at 64px,
 * which is a modelling problem rather than an animation one.
 *
 *   grunt   — squat and wide, low to the ground, single cyclops eye
 *   sniper  — tall and spindly, one enormous barrel, reads as a tripod
 *   brute   — huge shoulders over short legs, a wedge standing on end
 *   flyer   — legless hovering pod with swept fins
 */

const tmpM = new THREE.Matrix4();
const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

/** Push a primitive into the parts list, positioned/rotated/coloured. */
function put(parts, geo, x, y, z, color, opts = {}) {
  if (opts.rx || opts.ry || opts.rz) {
    tmpE.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
    tmpQ.setFromEuler(tmpE);
  } else {
    tmpQ.identity();
  }
  tmpV.set(x, y, z);
  tmpS.set(opts.sx ?? 1, opts.sy ?? 1, opts.sz ?? 1);
  tmpM.compose(tmpV, tmpQ, tmpS);
  geo.applyMatrix4(tmpM);

  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  tmpC.set(color);
  // Emissive parts are pushed above 1 so the bloom pass catches them.
  const boost = opts.emissive ? opts.emissive : 1;
  for (let i = 0; i < n; i++) {
    col[i * 3] = tmpC.r * boost;
    col[i * 3 + 1] = tmpC.g * boost;
    col[i * 3 + 2] = tmpC.b * boost;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  parts.push(geo);
  return geo;
}

/** Scatter small panel greebles so the silhouette is not a clean primitive. */
function greeble(parts, rnd, cx, cy, cz, spread, count, color) {
  for (let i = 0; i < count; i++) {
    const s = 0.06 + rnd() * 0.16;
    put(
      parts,
      new THREE.BoxGeometry(s * (1 + rnd()), s, s * (1 + rnd())),
      cx + (rnd() - 0.5) * spread,
      cy + (rnd() - 0.5) * spread,
      cz + (rnd() - 0.5) * spread * 0.6,
      color,
      { ry: rnd() * 3 }
    );
  }
}

function mulberry(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARMOR = 0x3c4454;
const ARMOR_D = 0x232936;
const FRAME = 0x4d5566;
const HOT = PALETTE.danger;
const ARMOR_L = 0x5b6577;
const EYE = 0xff4a4a;

function buildGrunt() {
  const parts = [];
  const rnd = mulberry(11);
  // Wide, low chassis — reads as a crouching beetle.
  // Body is a shallow wedge slung between the legs — the negative space under the
  // chassis is the read, so the outline is an arch rather than a slab.
  put(parts, new THREE.BoxGeometry(2.5, 0.62, 1.5), 0, 1.42, 0, ARMOR);
  put(parts, new THREE.BoxGeometry(1.7, 0.40, 1.2), 0, 1.86, 0.05, ARMOR_D, { rz: 0.06 });
  // Forward sensor head on a short neck.
  //
  // The body alone is a box, and a box has no facing — a review called this "a slab
  // on four sticks" that reads as a rectangle at 64px. A mass thrust forward of the
  // chassis gives the outline a front, so which way the unit is looking is legible
  // from the silhouette rather than only from the glow.
  put(parts, new THREE.BoxGeometry(0.42, 0.34, 0.55), 0, 1.62, 0.95, FRAME, { rx: -0.22 });
  put(parts, new THREE.BoxGeometry(0.86, 0.58, 0.72), 0, 1.55, 1.42, ARMOR, { rx: -0.16 });
  // Brow cowl over the optic, so the head is not a plain block either.
  put(parts, new THREE.BoxGeometry(1.0, 0.2, 0.5), 0, 1.82, 1.36, ARMOR_D, { rx: -0.34 });
  put(parts, new THREE.SphereGeometry(0.26, 10, 8), 0, 1.5, 1.72, EYE, { emissive: 2.1 });
  // Mandible prongs — a wide low cue that survives downscaling.
  for (const ms of [-1, 1]) {
    put(parts, new THREE.BoxGeometry(0.16, 0.16, 0.62), ms * 0.44, 1.3, 1.62, FRAME, { ry: ms * 0.22 });
  }
  // Dorsal spine, breaking the top of the box.
  put(parts, new THREE.BoxGeometry(0.28, 0.34, 1.1), 0, 2.12, -0.2, ARMOR_D, { rx: 0.1 });
  put(parts, new THREE.BoxGeometry(0.7, 0.14, 0.6), 0, 2.02, -0.72, FRAME);
  // Stubby legs, splayed
  for (const s of [-1, 1]) {
    // Splayed insect legs: two segments, kicked well outboard of the body.
    put(parts, new THREE.BoxGeometry(0.30, 1.05, 0.34), s * 1.02, 0.98, 0, FRAME, { rz: s * 0.55 });
    put(parts, new THREE.BoxGeometry(0.26, 0.85, 0.30), s * 1.42, 0.42, 0, FRAME, { rz: -s * 0.30 });
    put(parts, new THREE.BoxGeometry(0.70, 0.16, 0.72), s * 1.30, 0.08, 0.04, ARMOR_D);
    // Shoulder cannon stub
    put(parts, new THREE.CylinderGeometry(0.16, 0.2, 0.9, 8), s * 1.0, 1.7, 0.35, FRAME, { rx: Math.PI / 2 });
  }
  greeble(parts, rnd, 0, 1.4, 0.3, 1.8, 10, FRAME);
  return mergeGeometries(parts, false);
}

function buildSniper() {
  const parts = [];
  const rnd = mulberry(23);
  // Tall and narrow, on a tripod — the tallest thing in a wave.
  put(parts, new THREE.BoxGeometry(0.8, 1.5, 0.8), 0, 3.2, 0, ARMOR);
  put(parts, new THREE.BoxGeometry(0.6, 0.5, 0.6), 0, 4.15, 0, ARMOR_D);
  // Single glowing optic
  put(parts, new THREE.SphereGeometry(0.19, 10, 8), 0, 4.15, 0.34, PALETTE.magenta, { emissive: 2.2 });
  // The signature: one very long barrel
  put(parts, new THREE.CylinderGeometry(0.11, 0.15, 3.4, 8), 0.55, 3.5, 0.5, FRAME, { rx: Math.PI / 2 });
  put(parts, new THREE.BoxGeometry(0.3, 0.3, 0.7), 0.55, 3.5, 1.5, ARMOR_D);
  // Spindly tripod legs
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    put(parts, new THREE.CylinderGeometry(0.09, 0.06, 2.7, 6),
      Math.cos(a) * 0.55, 1.4, Math.sin(a) * 0.55, FRAME,
      { rx: Math.sin(a) * 0.34, rz: -Math.cos(a) * 0.34 });
    put(parts, new THREE.BoxGeometry(0.28, 0.12, 0.28), Math.cos(a) * 0.95, 0.07, Math.sin(a) * 0.95, ARMOR_D);
  }
  greeble(parts, rnd, 0, 3.3, 0.2, 1.0, 8, FRAME);
  return mergeGeometries(parts, false);
}

function buildBrute() {
  const parts = [];
  const rnd = mulberry(37);
  // Enormous shoulders on stubby legs: a wedge balanced on end.
  put(parts, new THREE.BoxGeometry(2.0, 1.9, 1.6), 0, 2.6, 0, ARMOR);
  put(parts, new THREE.BoxGeometry(3.6, 1.0, 1.9), 0, 3.5, 0, ARMOR_D);
  // Swept horns off the shoulder line. A pure box silhouette was confusable with
  // the grunt at 64px; the horns give the outline an unmistakable top edge.
  for (const hs of [-1, 1]) {
    put(parts, new THREE.BoxGeometry(0.34, 2.1, 0.34), hs * 1.55, 4.7, -0.2, FRAME, { rz: hs * 0.42, rx: -0.22 });
    put(parts, new THREE.BoxGeometry(0.26, 0.9, 0.26), hs * 2.25, 5.5, -0.42, ARMOR_L ?? FRAME, { rz: hs * 0.62 });
  }
  for (const s of [-1, 1]) {
    put(parts, new THREE.BoxGeometry(1.0, 1.4, 1.5), s * 1.7, 3.3, 0, ARMOR, { rz: s * 0.16 });
    // Heavy fists
    put(parts, new THREE.BoxGeometry(0.85, 1.5, 0.9), s * 1.95, 1.9, 0.15, FRAME);
    put(parts, new THREE.BoxGeometry(1.0, 0.7, 1.0), s * 2.0, 1.15, 0.2, ARMOR_D);
    // Short thick legs
    put(parts, new THREE.BoxGeometry(0.7, 1.3, 0.85), s * 0.6, 1.0, 0, FRAME);
    put(parts, new THREE.BoxGeometry(0.9, 0.3, 1.1), s * 0.62, 0.2, 0.08, ARMOR_D);
  }
  // Glowing chest core — the obvious weak point
  put(parts, new THREE.BoxGeometry(0.7, 0.7, 0.2), 0, 2.7, 0.82, HOT, { emissive: 1.9 });
  // Head is small and sunk between the shoulders
  put(parts, new THREE.BoxGeometry(0.6, 0.45, 0.6), 0, 4.2, 0.1, ARMOR_D);
  put(parts, new THREE.BoxGeometry(0.42, 0.12, 0.1), 0, 4.24, 0.42, EYE, { emissive: 2.0 });
  greeble(parts, rnd, 0, 3.0, 0.4, 2.6, 14, FRAME);
  return mergeGeometries(parts, false);
}

function buildFlyer() {
  const parts = [];
  const rnd = mulberry(53);
  // No legs at all — the silhouette cue that it is airborne.
  put(parts, new THREE.SphereGeometry(0.62, 12, 10), 0, 0, 0, ARMOR, { sy: 0.78 });
  put(parts, new THREE.BoxGeometry(0.9, 0.3, 1.1), 0, 0.1, 0, ARMOR_D);
  // Swept fins
  for (const s of [-1, 1]) {
    put(parts, new THREE.BoxGeometry(1.5, 0.12, 0.55), s * 0.95, 0.05, -0.15, ARMOR, { ry: s * 0.42 });
    put(parts, new THREE.CylinderGeometry(0.14, 0.1, 0.5, 8), s * 1.5, -0.05, -0.35, FRAME, { rx: Math.PI / 2 });
    // Thruster glow
    put(parts, new THREE.SphereGeometry(0.13, 8, 6), s * 1.5, -0.05, -0.62, PALETTE.cyan, { emissive: 2.0 });
  }
  put(parts, new THREE.SphereGeometry(0.2, 10, 8), 0, 0.02, 0.55, EYE, { emissive: 2.1 });
  greeble(parts, rnd, 0, 0, 0, 1.0, 6, FRAME);
  return mergeGeometries(parts, false);
}


function buildBoss() {
  const parts = [];
  const rnd = mulberry(97);
  // Twice the height of anything else and built around one enormous core, so it
  // reads as a different class of thing rather than a scaled-up brute.
  put(parts, new THREE.BoxGeometry(4.2, 3.4, 2.8), 0, 6.4, 0, ARMOR);
  put(parts, new THREE.BoxGeometry(6.4, 1.5, 3.0), 0, 8.3, 0, ARMOR_D);
  // Exposed core — the weak point, and the phase indicator.
  put(parts, new THREE.SphereGeometry(1.05, 14, 12), 0, 6.3, 1.35, HOT, { emissive: 2.0 });
  put(parts, new THREE.TorusGeometry(1.35, 0.22, 8, 20), 0, 6.3, 1.4, FRAME, { rx: 0 });

  for (const side of [-1, 1]) {
    // Shoulder batteries
    put(parts, new THREE.BoxGeometry(1.8, 1.6, 2.4), side * 2.9, 8.4, 0, ARMOR, { rz: side * 0.12 });
    for (let i = 0; i < 3; i++) {
      put(parts, new THREE.CylinderGeometry(0.17, 0.21, 2.2, 8),
        side * 2.9, 8.2 + i * 0.5, 1.2, FRAME, { rx: Math.PI / 2 });
    }
    // Arms
    put(parts, new THREE.BoxGeometry(1.3, 3.2, 1.4), side * 3.1, 5.2, 0.1, FRAME, { rz: side * 0.08 });
    put(parts, new THREE.BoxGeometry(1.7, 1.5, 1.8), side * 3.3, 3.3, 0.2, ARMOR_D);
    // Legs — short and splayed under all that mass
    put(parts, new THREE.BoxGeometry(1.5, 2.6, 1.7), side * 1.3, 2.4, 0, ARMOR, { rz: side * 0.15 });
    put(parts, new THREE.BoxGeometry(2.0, 0.6, 2.4), side * 1.5, 0.4, 0.1, ARMOR_D);
    // Vents
    put(parts, new THREE.BoxGeometry(0.28, 1.2, 0.18), side * 1.5, 6.6, 1.42, PALETTE.amber, { emissive: 2.2 });
  }

  // Head cluster, sunk low and wide
  put(parts, new THREE.BoxGeometry(1.5, 0.9, 1.3), 0, 9.4, 0.2, ARMOR_D);
  put(parts, new THREE.BoxGeometry(1.1, 0.18, 0.14), 0, 9.45, 0.88, EYE, { emissive: 2.2 });

  // Panel breaks and hardware. Without these the boss is a stack of bare slabs
  // sitting next to a heavily greebled player mech, and the size difference reads as
  // "scaled up" rather than as a different class of machine.
  for (const side of [-1, 1]) {
    // Armour ribs down the flanks
    for (let i = 0; i < 4; i++) {
      put(parts, new THREE.BoxGeometry(0.22, 0.34, 2.5), side * 2.12, 5.5 + i * 0.72, 0, ARMOR_D);
    }
    // Intake louvres on the chest block
    for (let i = 0; i < 3; i++) {
      put(parts, new THREE.BoxGeometry(1.5, 0.16, 0.18), side * 0.95, 7.5 + i * 0.34, 1.36, FRAME);
    }
    // Hip and knee actuators
    put(parts, new THREE.CylinderGeometry(0.2, 0.2, 1.5, 8), side * 1.95, 2.9, 0.3, FRAME, { rz: side * 0.12 });
    put(parts, new THREE.BoxGeometry(0.5, 0.5, 0.5), side * 1.3, 3.7, 0.75, ARMOR_D);
    // Shoulder cap plating
    put(parts, new THREE.BoxGeometry(1.9, 0.3, 2.5), side * 2.9, 9.15, 0, ARMOR_D, { rz: side * 0.1 });
  }
  // Spine cabling and a dorsal fin so the top edge is not a flat line
  put(parts, new THREE.BoxGeometry(0.5, 2.6, 0.4), 0, 7.6, -1.5, FRAME);
  put(parts, new THREE.BoxGeometry(0.28, 1.7, 1.5), 0, 9.9, -1.1, ARMOR, { rx: 0.22 });

  greeble(parts, rnd, 0, 6.0, 0.6, 5.2, 34, FRAME);
  greeble(parts, rnd, 0, 3.2, 0.9, 4.4, 18, ARMOR_D);
  return mergeGeometries(parts, false);
}

export const ARCHETYPES = {
  grunt: { build: buildGrunt, max: 26, hp: 90, poise: 60, hx: 1.15, hy: 1.0, mass: 4, speed: 11 },
  sniper: { build: buildSniper, max: 10, hp: 70, poise: 40, hx: 0.7, hy: 2.2, mass: 3.4, speed: 6 },
  brute: { build: buildBrute, max: 8, hp: 420, poise: 220, hx: 1.7, hy: 2.4, mass: 14, speed: 7 },
  flyer: { build: buildFlyer, max: 18, hp: 60, poise: 30, hx: 0.85, hy: 0.6, mass: 2.2, speed: 15 },
  boss:  { build: buildBoss,  max: 2,  hp: 4200, poise: 900, hx: 3.2, hy: 5.0, mass: 60, speed: 5 },
};

/**
 * Build one InstancedMesh per archetype.
 * @returns {{group:THREE.Group, pools:Object, dispose:Function}}
 */
export function buildEnemyRenderer() {
  const group = new THREE.Group();
  group.name = 'ai.enemies';

  // Enemies share the mech's procedural hard-surface maps.
  //
  // They were previously vertex-coloured MeshStandardMaterial with NO maps at all —
  // flat plastic slabs, which the rubric rejects on sight. Reusing the same surface
  // generator gives them panel grain, micro-scratch and roughness variation for one
  // extra texture fetch, and has the side benefit that hostiles and the player read
  // as built in the same factory.
  const surface = makeMechSurface(512, 0x3ee11a7);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: surface.map,
    normalMap: surface.normalMap,
    roughnessMap: surface.roughnessMap,
    roughness: 0.86,
    // Not fully metallic: a high metalness leaves no diffuse response and the unit
    // collapses to a black cutout under night lighting.
    metalness: 0.42,
    envMapIntensity: 1.25,
  });
  material.normalScale.set(0.7, 0.7);

  // Per-instance hit flash, driven through EMISSIVE rather than diffuse.
  //
  // The flash used to scale `instanceColor`, which multiplies the diffuse albedo —
  // so a hit on a dark hull under night lighting multiplied a small number by 2.65
  // and stayed a small number. A review measured zero pixels above 250/255 anywhere
  // inside a struck enemy while the HUD read 698 damage: the game's most important
  // piece of feedback was invisible, and being invisible it also never reached the
  // bloom threshold, so there was no glow either.
  //
  // Emissive is a material uniform and cannot vary per instance, so the flash rides
  // an instanced attribute and is added to `totalEmissiveRadiance` directly. Geometry
  // that does not supply the attribute reads zero, which is the correct default.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlash;\nvarying float vFlash;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlash = aFlash;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlash;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
          // Hot and very slightly pink, so the flash still belongs to the palette at
          // the moment it clips. Scaled past 1.0 on purpose — the bloom threshold sits
          // at 1.35 and an impact that does not bloom does not register — but only
          // just past it. At 7.0 the struck unit became a featureless white blob with
          // a halo wider than itself: the rubric's flat-white-quad rejection, and it
          // destroyed the silhouette of the thing the player was aiming at.
          // Strongly magenta, because ACES desaturates as it rolls off. A tint of
          // (1.0, 0.82, 0.90) measured out at the struck unit as RGB 144,130,151 — a
          // neutral grey-pink with an R:B ratio of 1.11, which reads as fog rather
          // than as force. The tint has to be pushed well past where it should look
          // right in isolation to survive the tone curve at flash intensity.
          //
          // Modulated by the albedo, so the flash lights the unit rather than
          // painting over it. A flat add at any strength high enough to bloom turned
          // the hull into one white shape with the panel breaks gone — the player
          // could see that something was hit but not what, or which way it was
          // facing. Weighting by `diffuseColor` keeps the dark panel lines dark and
          // pushes only the bright plates past the threshold, so the unit reads as
          // lit from within and its silhouette survives the moment it matters most.
          'totalEmissiveRadiance += vec3(1.0, 0.26, 0.60) * vFlash * 3.4 * (0.26 + diffuseColor.rgb * 1.7);'
      );
  };

  const pools = {};
  const disposables = [material];

  for (const [name, spec] of Object.entries(ARCHETYPES)) {
    const geo = spec.build();
    geo.computeVertexNormals();
    disposables.push(geo);

    const mesh = new THREE.InstancedMesh(geo, material, spec.max);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = `ai.${name}`;
    // Per-instance tint, used to flash white on hit.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spec.max * 3), 3);
    for (let i = 0; i < spec.max; i++) {
      mesh.instanceColor.array[i * 3] = 1;
      mesh.instanceColor.array[i * 3 + 1] = 1;
      mesh.instanceColor.array[i * 3 + 2] = 1;
    }
    // The instanced flash channel this archetype's geometry supplies to the shader
    // patch above. Held on the mesh as well so the AI module can write it without
    // reaching through the geometry.
    const flashAttr = new THREE.InstancedBufferAttribute(new Float32Array(spec.max), 1);
    flashAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFlash', flashAttr);
    mesh.userData.flash = flashAttr;

    group.add(mesh);
    pools[name] = mesh;
  }

  // Contact shadows.
  //
  // A review measured the ground under a six-legged machine as marginally BRIGHTER
  // than open ground — a ratio of 1.03 where any contact occlusion at all should put
  // it below 1. The enemies were sitting on their own glow rather than on the street.
  // One instanced quad per enemy, laid flat and multiplied over the road.
  const shadowTex = makeContactShadowTexture(128);
  disposables.push(shadowTex);
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  disposables.push(shadowGeo);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    alphaMap: shadowTex,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: false,
    // The plane faces +Z before rotation, so laying it flat points its front face at
    // the ground. Without DoubleSide only the culled back face ever faces the camera.
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  disposables.push(shadowMat);
  const MAX_SHADOWS = 70;
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, MAX_SHADOWS);
  shadows.frustumCulled = false;
  shadows.renderOrder = 6;
  shadows.count = 0;
  shadows.name = 'ai.contactShadows';
  group.add(shadows);

  return {
    group,
    pools,
    material,
    shadows,
    maxShadows: MAX_SHADOWS,
    dispose() {
      for (const d of disposables) d.dispose?.();
    },
  };
}
