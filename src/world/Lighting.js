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
  const key = new THREE.DirectionalLight(PALETTE.keyLight, 4.6);
  // BEHIND the play plane, not in front of it.
  //
  // This previously sat at z = +26, which is essentially where the camera is
  // (z ≈ +24). A key co-located with the viewer throws every shadow directly away
  // from the viewer, where the object casting it hides it completely — so the scene
  // rendered a full shadow map that could never be seen, and every mech read as
  // pasted onto the road. Moving the key behind and to the side throws shadows back
  // toward camera, which is the whole point of having one.
  key.position.set(-30, 40, -22);
  key.target.position.set(0, 2, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 8;
  key.shadow.camera.far = 190;
  // The playfield is a wide, short corridor, so the shadow frustum is wide and short
  // too — a square frustum here would waste most of the map's texels on empty sky.
  key.shadow.camera.left = -70;
  key.shadow.camera.right = 70;
  key.shadow.camera.top = 46;
  key.shadow.camera.bottom = -26;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.022;
  key.shadow.radius = 1.6;
  group.add(key, key.target);
  lights.key = key;

  // --- fill ---------------------------------------------------------------
  // Raised from 2.25 with the ambient below it.
  //
  // A crush mask — every pixel under luminance 8 painted magenta — showed the black
  // was not one object but the shadow floor of the whole scene: the wall between
  // every lit window, every debris prop, the terrace, and most of the player's own
  // body. Three separate structural hypotheses were tested and discarded before the
  // mask made it obvious. A hemisphere is the right place to spend the lift because
  // it is directional top-to-bottom, so it fills upward-facing surfaces more than
  // vertical ones and leaves the key's shadow shapes intact.
  const hemi = new THREE.HemisphereLight(PALETTE.fillSky, PALETTE.fillGround, 3.5);
  group.add(hemi);
  lights.hemi = hemi;

  // A weak cold ambient purely to keep shadowed metal from crushing to pure black.
  // Lifts the deep shadows with a COOL bounce rather than a neutral grey, so the
  // darkest quarter of the frame carries information instead of being crushed to
  // black. Roughly a quarter of every frame was previously below luminance 12.
  // Deliberately lower than the mid-tone lift alone would want. Ambient fills
  // shadow and lit surfaces equally, so raising it to rescue crushed blacks also
  // flattens the very shadow contrast that seats objects on the ground. The lift now
  // comes mostly from the hemisphere (which is directional top-to-bottom) and the key
  // carries proportionally more, so shadows stay readable.
  // Pulled back once the haze took over the job. Ambient lifts lit and shadowed
  // surfaces equally, so using it to rescue crushed blacks costs foreground contrast
  // everywhere; fog lifts by distance, which is what the crush actually correlated
  // with. With the haze carrying the background the ambient can go back down and the
  // near plane can keep its darks.
  const amb = new THREE.AmbientLight(PALETTE.shadowTint, 0.92);
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

  // --- street bounce ------------------------------------------------------
  // The corridor flanks measured at luminance 10-13 against a road at 48, and
  // nearly a third of the frame sat below luminance 8. The cause is geometric, not
  // a missing ambient term: the key is behind the play plane (which is what makes
  // shadows visible at all), so every wall facing the camera is a back face and
  // receives nothing. Raising ambient to fix that would lift the shadows the key
  // exists to create.
  //
  // A night city solves this for itself — the street below is the light source, and
  // facades are lit from underneath. This is that: a dim directional travelling up
  // and away from the viewer, so it lands on camera-facing walls and on nothing
  // that is already lit. It deliberately misses the road: the road's normal points
  // straight up and this light travels upward, so the ground receives zero from it.
  const bounce = new THREE.DirectionalLight(PALETTE.fillSky, 7.0);
  bounce.position.set(10, -8, 62);
  bounce.target.position.set(0, 16, -34);
  group.add(bounce, bounce.target);
  lights.bounce = bounce;

  // --- neon bounce --------------------------------------------------------
  // Stand-ins for signage spill — ACCENTS, not floodlights.
  //
  // At their previous intensity a single neon tinted the whole carriageway, so
  // frames swung uniformly magenta or uniformly cyan and the cold industrial base
  // the palette is built on disappeared entirely. The cold key and hemisphere now
  // carry the scene and neon colours the edges of it.
  // Intensities are in physical units and fall off as 1/r², so lighting a street
  // from 15-20 units up takes values in the thousands, not the tens.
  const neonSpecs = [
    // Pulled back and tightened: at 430/58 this washed a third of the playfield to
    // uniform magenta and the ground texture inside the pool was lost entirely.
    { c: PALETTE.magenta, x: -46, y: 14, z: -12, i: 300, d: 44 },
    { c: PALETTE.cyan,    x:  12, y:  9, z: -16, i: 520, d: 62 },
    { c: PALETTE.amber,   x:  58, y: 13, z: -10, i: 380, d: 54 },
    { c: PALETTE.cyan,    x: -96, y: 10, z: -14, i: 320, d: 48 },
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
      key.position.x = snapped - 30;
      key.target.position.x = snapped;
      key.target.updateMatrixWorld();
    },

    dispose() {
      key.shadow.map?.dispose();
    },
  };
}
