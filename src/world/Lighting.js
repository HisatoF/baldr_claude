import * as THREE from 'three';
import { PALETTE, COLORS } from '../render/Palette.js';

/**
 * The lighting environment.
 *
 * Deliberately three-point, per the rubric: a single ambient term is the fastest way
 * to make an expensive scene look cheap. The rig is
 *
 *   key   — cold overhead moonlight, the only shadow caster
 *   fill  — hemisphere, sky above / wet-asphalt bounce below, never neutral grey
 *   rim   — magenta backlight that separates mech silhouettes from the background
 *   neon  — a few coloured point lights standing in for signage bounce
 *
 * Shadow-casting lights are expensive, so exactly one casts. Everything else is
 * cheap directional/hemisphere/point light with no shadow map.
 */
export function buildLighting(opts = {}) {
  const group = new THREE.Group();
  group.name = 'world.lighting';
  const lights = {};

  // --- key ----------------------------------------------------------------
  // Angled so the mech's own geometry casts across itself rather than lighting flat.
  const key = new THREE.DirectionalLight(PALETTE.keyLight, 2.35);
  key.position.set(-26, 44, 26);
  key.target.position.set(0, 4, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 8;
  key.shadow.camera.far = 140;
  // The playfield is a wide, short corridor, so the shadow frustum is wide and short
  // too — a square frustum here would waste most of the map's texels on empty sky.
  key.shadow.camera.left = -70;
  key.shadow.camera.right = 70;
  key.shadow.camera.top = 34;
  key.shadow.camera.bottom = -14;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.035;
  key.shadow.radius = 2.4;
  group.add(key, key.target);
  lights.key = key;

  // --- fill ---------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(PALETTE.fillSky, PALETTE.fillGround, 1.15);
  group.add(hemi);
  lights.hemi = hemi;

  // A weak cold ambient purely to keep shadowed metal from crushing to pure black.
  const amb = new THREE.AmbientLight(PALETTE.shadowTint, 0.55);
  group.add(amb);
  lights.ambient = amb;

  // --- rim ----------------------------------------------------------------
  // Comes from behind and slightly below, opposite the key. This is the single most
  // valuable light for reading a mech against a dark city.
  const rim = new THREE.DirectionalLight(PALETTE.rimLight, 1.5);
  rim.position.set(30, 12, -34);
  rim.target.position.set(0, 5, 0);
  group.add(rim, rim.target);
  lights.rim = rim;

  // A second, cooler rim from the other side keeps the silhouette from reading as
  // one-sided when the mech turns around.
  const rim2 = new THREE.DirectionalLight(PALETTE.cyan, 0.85);
  rim2.position.set(-34, 9, -28);
  rim2.target.position.set(0, 5, 0);
  group.add(rim2, rim2.target);
  lights.rim2 = rim2;

  // --- neon bounce --------------------------------------------------------
  // Stand-ins for signage spill. Point lights, no shadows, generous distance falloff.
  const neonSpecs = [
    { c: PALETTE.magenta, x: -46, y: 11, z: -12, i: 26, d: 58 },
    { c: PALETTE.cyan,    x:  12, y:  9, z: -16, i: 30, d: 62 },
    { c: PALETTE.amber,   x:  58, y: 13, z: -10, i: 22, d: 54 },
    { c: PALETTE.cyan,    x: -96, y: 10, z: -14, i: 18, d: 48 },
  ];
  lights.neon = [];
  for (const s of neonSpecs) {
    const p = new THREE.PointLight(s.c, s.i, s.d, 2);
    p.position.set(s.x, s.y, s.z);
    group.add(p);
    lights.neon.push(p);
  }

  const ambientColor = COLORS.fillSky.clone();

  return {
    group,
    lights,
    ambientColor,

    /**
     * Keep the shadow frustum centred on the action. A fixed frustum wide enough for
     * the whole 320m corridor would have useless shadow resolution, so it tracks
     * instead, snapped to texel increments to stop the shadow edges from crawling.
     */
    followShadow(x) {
      const TEXEL = 140 / 2048; // frustum width / map size
      const snapped = Math.round(x / TEXEL) * TEXEL;
      key.position.x = snapped - 26;
      key.target.position.x = snapped;
      key.target.updateMatrixWorld();
    },

    dispose() {
      key.shadow.map?.dispose();
    },
  };
}
