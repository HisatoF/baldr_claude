import * as THREE from 'three';
import { mulberry32, texFromCanvas, makeConcrete, makeSkyTexture } from './Textures.js';
import { PALETTE } from '../render/Palette.js';

/**
 * The layered city.
 *
 * The rubric requires legible depth — foreground, midground and background separated
 * by value and atmospheric perspective. That separation is built here as three
 * explicit bands:
 *
 *   back — distant skyline, near-silhouette, lit only by its own windows. Deep in the
 *          fog so it reads as value, not detail.
 *   mid  — the buildings flanking the playable corridor. This band carries the neon.
 *   fore — near slabs that frame the action and parallax past the camera. Almost
 *          black; they exist to occlude and to give the eye a nearest reference.
 *
 * Everything is instanced. The whole city is a handful of draw calls, because the
 * budget for the entire game is 220 and the mech and VFX need most of them.
 */

/**
 * A tileable facade: the emissive that makes a black box read as a tower.
 *
 * The first version scattered independently-random coloured cells, which resolves to
 * television static at any real viewing distance — the eye reads noise, not a
 * building. What makes a facade legible is *structure*, so this builds one:
 *
 *   - continuous floor bands with dark spandrel between them, so horizontals read;
 *   - vertical mullions at a fixed column pitch, so verticals read;
 *   - a consistent window aspect ratio (wider than tall, as glazing actually is);
 *   - occupancy in CLUSTERS — lit offices sit next to lit offices, whole floors go
 *     dark — because random per-cell occupancy has no visual grammar;
 *   - a hue range restricted to the scene palette, with warm interior light as the
 *     minority accent rather than free-for-all RGB.
 */
function makeWindowGrid(seed = 1234, cols = 12, rows = 20) {
  const cw = 24; // column pitch
  const ch = 22; // floor pitch
  const w = cols * cw;
  const h = rows * ch;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);

  // Base: the unlit building skin, not pure black, so facades keep some form.
  g.fillStyle = '#05070d';
  g.fillRect(0, 0, w, h);

  // Structural grid: spandrel bands and mullions drawn first, windows sit between.
  g.fillStyle = '#0a0e17';
  for (let ry = 0; ry < rows; ry++) g.fillRect(0, ry * ch, w, 5); // floor slab edge
  for (let rx = 0; rx < cols; rx++) g.fillRect(rx * cw, 0, 4, h); // mullion

  // Palette-restricted interior light. Cold office white dominates; warm sodium is
  // the accent. No saturated primaries.
  const COLD = [172, 206, 240];
  const COLDER = [140, 180, 226];
  const WARM = [255, 198, 140];

  // Per-column and per-floor occupancy biases produce clustering for free.
  const colBias = new Array(cols);
  for (let i = 0; i < cols; i++) colBias[i] = rnd();
  const floorBias = new Array(rows);
  for (let i = 0; i < rows; i++) floorBias[i] = rnd();

  const winW = cw - 9;
  const winH = ch - 11;

  for (let ry = 0; ry < rows; ry++) {
    // Whole floors go dark — mechanical levels, vacant storeys.
    const floorDark = floorBias[ry] < 0.20;
    // Floors share a colour temperature: one tenant, one lighting spec.
    const floorWarm = rnd() < 0.22;

    for (let rx = 0; rx < cols; rx++) {
      const p = floorDark ? 0.06 : 0.30 + colBias[rx] * 0.5 + (1 - floorBias[ry]) * 0.22;
      if (rnd() > p) continue;

      const base = floorWarm && rnd() < 0.7 ? WARM : rnd() < 0.4 ? COLDER : COLD;
      // Brightness varies per window but stays in a narrow band, so the facade
      // has tonal life without individual cells screaming.
      const b = 0.45 + rnd() * 0.5;

      const x = rx * cw + 6;
      const y = ry * ch + 8;

      g.fillStyle = `rgb(${(base[0] * b) | 0},${(base[1] * b) | 0},${(base[2] * b) | 0})`;
      g.fillRect(x, y, winW, winH);

      // Sill glow: a dim bleed below each pane, which is what gives a night facade
      // its soft vertical smear rather than a grid of hard rectangles.
      g.globalAlpha = 0.20 * b;
      g.fillRect(x - 2, y - 2, winW + 4, winH + 6);
      g.globalAlpha = 1;
    }
  }

  return texFromCanvas(c, {
    srgb: true,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
  });
}

/** Emissive holographic signage panels. */
function makeSignTexture(seed = 77) {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);

  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);

  const hues = ['#5ad9ff', '#ff3d9a', '#ffa63d'];
  const col = hues[(rnd() * hues.length) | 0];

  // Abstract glyph bars — deliberately not readable text. Legible words would pull
  // the eye and date the art; rhythmic bars read as signage at any distance.
  g.fillStyle = col;
  g.shadowColor = col;
  g.shadowBlur = 18;
  const rowsN = 4 + ((rnd() * 3) | 0);
  for (let i = 0; i < rowsN; i++) {
    const y = 24 + i * (h - 48) / rowsN;
    let x = 20 + rnd() * 30;
    const bars = 3 + ((rnd() * 5) | 0);
    for (let b = 0; b < bars; b++) {
      const bw = 12 + rnd() * 46;
      const bh = 10 + rnd() * 14;
      g.globalAlpha = 0.55 + rnd() * 0.45;
      g.fillRect(x, y, bw, bh);
      x += bw + 8 + rnd() * 14;
      if (x > w - 30) break;
    }
  }
  g.globalAlpha = 1;

  // Border frame
  g.strokeStyle = col;
  g.lineWidth = 3;
  g.globalAlpha = 0.8;
  g.strokeRect(8, 8, w - 16, h - 16);

  return texFromCanvas(c, { srgb: true });
}

export function buildCity(opts = {}) {
  const backGroup = new THREE.Group();
  const midGroup = new THREE.Group();
  const foreGroup = new THREE.Group();
  backGroup.name = 'city.back';
  midGroup.name = 'city.mid';
  foreGroup.name = 'city.fore';

  const disposables = [];
  const rnd = mulberry32(opts.seed ?? 0xc17ea5);

  const box = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(box);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tmpE2 = new THREE.Euler();

  /* ---------------- sky dome ---------------- */
  // The skyline needs something to be a silhouette *against*. A flat clear-colour
  // background gives the towers nothing to separate from, so the whole upper frame
  // collapses into one value.
  const skyTex = makeSkyTexture({ width: 1024, height: 512, seed: 20260 });
  disposables.push(skyTex);
  const skyGeo = new THREE.SphereGeometry(700, 32, 20);
  disposables.push(skyGeo);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    toneMapped: true,
  });
  disposables.push(skyMat);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'city.sky';
  sky.renderOrder = -1000;
  backGroup.add(sky);

  /* ---------------- background skyline ---------------- */
  // Two ranks so the skyline has internal depth. The far rank is dimmer and bluer;
  // the fog does most of that work, but the emissive intensity helps it along.
  const backRanks = [
    { z: -300, count: 40, wMin: 16, wMax: 38, hMin: 18, hMax: 78,  emis: 0.20, tint: 0x070b12 },
    { z: -205, count: 30, wMin: 14, wMax: 32, hMin: 14, hMax: 52,  emis: 0.34, tint: 0x0a0f18 },
  ];

  for (let r = 0; r < backRanks.length; r++) {
    const spec = backRanks[r];
    const winTex = makeWindowGrid(1000 + r * 37, 16, 32);
    winTex.repeat.set(1, 2);
    disposables.push(winTex);

    const mat = new THREE.MeshStandardMaterial({
      color: spec.tint,
      roughness: 0.95,
      metalness: 0.0,
      emissive: 0xffffff,
      emissiveMap: winTex,
      emissiveIntensity: spec.emis,
      fog: true,
    });
    disposables.push(mat);

    const inst = new THREE.InstancedMesh(box, mat, spec.count);
    inst.frustumCulled = false;
    for (let i = 0; i < spec.count; i++) {
      const w = spec.wMin + rnd() * (spec.wMax - spec.wMin);
      const h = spec.hMin + rnd() * (spec.hMax - spec.hMin);
      const d = 12 + rnd() * 20;
      const x = -420 + (840 / spec.count) * i + (rnd() - 0.5) * 14;
      pos.set(x, h * 0.5, spec.z + (rnd() - 0.5) * 40);
      scl.set(w, h, d);
      q.identity();
      m4.compose(pos, q, scl);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    backGroup.add(inst);
  }

  /* ---------------- midground: corridor flanks ---------------- */
  const concrete = makeConcrete({
    size: 512,
    seed: 8812,
    base: [0.07, 0.075, 0.09],
    cracks: 7,
    aggregate: 0.8,
    stain: 1.0,
    rough: 0.88,
    normalStrength: 1.8,
  });

  const midWin = makeWindowGrid(4242, 16, 32);
  midWin.repeat.set(2, 2);
  disposables.push(midWin);

  const midMat = new THREE.MeshStandardMaterial({
    map: concrete.map,
    normalMap: concrete.normalMap,
    roughnessMap: concrete.orm,
    metalnessMap: concrete.orm,
    roughness: 0.9,
    metalness: 0.05,
    emissive: 0xffffff,
    emissiveMap: midWin,
    emissiveIntensity: 0.34,
  });
  disposables.push(midMat);

  const MID_N = 22;
  const midInst = new THREE.InstancedMesh(box, midMat, MID_N);
  midInst.castShadow = true;
  midInst.receiveShadow = true;
  midInst.frustumCulled = false;
  for (let i = 0; i < MID_N; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const w = 13 + rnd() * 16;
    // Height follows a cubic curve rather than a flat random range: mostly low
    // blocks with the occasional tower. A uniform range gives every building a
    // similar height, which is exactly what turns a skyline into a barricade.
    const t = rnd();
    const h = 9 + t * t * t * 54;
    const d = 16 + rnd() * 18;
    // Sit them off the carriageway, staggered in depth so the flank is not a wall.
    const x = -175 + (350 / MID_N) * i + (rnd() - 0.5) * 9;
    const z = side < 0 ? -44 - rnd() * 30 : -38 - rnd() * 26;
    pos.set(x, h * 0.5, z);
    scl.set(w, h, d);
    q.identity();
    m4.compose(pos, q, scl);
    midInst.setMatrixAt(i, m4);
  }
  midInst.instanceMatrix.needsUpdate = true;
  midGroup.add(midInst);

  /* ---------------- holographic signage ---------------- */
  const signGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(signGeo);
  const signs = [];
  const SIGN_N = 10;
  for (let i = 0; i < SIGN_N; i++) {
    const tex = makeSignTexture(500 + i * 13);
    disposables.push(tex);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false, // signage should be allowed to blow out into the bloom
      opacity: 0.9,
    });
    disposables.push(mat);
    const mesh = new THREE.Mesh(signGeo, mat);
    const w = 7 + rnd() * 11;
    const h = w * (0.5 + rnd() * 0.7);
    mesh.scale.set(w, h, 1);
    mesh.position.set(-150 + rnd() * 300, 8 + rnd() * 26, -20 - rnd() * 22);
    mesh.rotation.y = (rnd() - 0.5) * 0.5;
    midGroup.add(mesh);
    signs.push({ mesh, mat, phase: rnd() * 100, flickerRate: 0.4 + rnd() * 3.0 });
  }

  /* ---------------- foreground framing ---------------- */
  // LOW, not tall.
  //
  // Tall near-black pillars were tried first and consistently read as an unlit
  // monolith dropped into the middle of the shot rather than as depth — at a 24-unit
  // camera distance anything with real height simply occludes the fight. Keeping the
  // band low puts silhouette along the bottom edge, which frames the action and gives
  // the eye a nearest reference without ever covering it.
  const foreMat = new THREE.MeshBasicMaterial({ color: 0x02030b, fog: false });
  disposables.push(foreMat);
  const FORE_N = 26;
  const FORE_Z = 11;
  const foreInst = new THREE.InstancedMesh(box, foreMat, FORE_N);
  foreInst.frustumCulled = false;
  for (let i = 0; i < FORE_N; i++) {
    const w = 3.5 + rnd() * 7;
    const h = 1.6 + rnd() * 2.4;
    const d = 2 + rnd() * 3;
    const x = -200 + (400 / FORE_N) * i + (rnd() - 0.5) * 12;
    // Sunk below the road line so only the top edge intrudes into frame.
    pos.set(x, -2.6 + h * 0.5, FORE_Z + (rnd() - 0.5) * 4);
    tmpE2.set(0, rnd() * 0.6 - 0.3, (rnd() - 0.5) * 0.16);
    q.setFromEuler(tmpE2);
    scl.set(w, h, d);
    m4.compose(pos, q, scl);
    foreInst.setMatrixAt(i, m4);
  }
  foreInst.instanceMatrix.needsUpdate = true;
  foreGroup.add(foreInst);

  /* ---------------- atmosphere: haze bands ---------------- */
  // Cheap depth cueing: a few large additive planes at increasing depth. Combined
  // with exponential fog this is what separates the three bands tonally.
  const hazeGeo = new THREE.PlaneGeometry(900, 160);
  disposables.push(hazeGeo);
  const hazeSpecs = [
    { z: -170, c: PALETTE.cyan, o: 0.035, y: 40 },
    { z: -110, c: PALETTE.magenta, o: 0.028, y: 26 },
    { z: -60, c: PALETTE.night, o: 0.05, y: 18 },
  ];
  const hazes = [];
  for (const s of hazeSpecs) {
    const mat = new THREE.MeshBasicMaterial({
      color: s.c,
      transparent: true,
      opacity: s.o,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    disposables.push(mat);
    const m = new THREE.Mesh(hazeGeo, mat);
    m.position.set(0, s.y, s.z);
    backGroup.add(m);
    hazes.push(m);
  }

  return {
    backGroup,
    midGroup,
    foreGroup,

    /**
     * Sign flicker and a slow parallax drift on the far skyline.
     * Visual only — never called from `fixed`.
     */
    update(elapsed, playerX) {
      for (let i = 0; i < signs.length; i++) {
        const s = signs[i];
        // Two desynced sines plus a rare hard dropout reads as failing neon far
        // better than a single sine, which reads as a pulsing loop.
        const a = Math.sin(elapsed * s.flickerRate + s.phase);
        const b = Math.sin(elapsed * (s.flickerRate * 3.7) + s.phase * 1.7);
        const drop = a * b > 0.86 ? 0.25 : 1;
        s.mat.opacity = (0.62 + 0.3 * a * 0.5 + 0.08 * b) * drop;
      }
      // The far skyline creeps opposite the player, exaggerating its distance.
      backGroup.position.x = -playerX * 0.06;
      foreGroup.position.x = -playerX * -0.14;
    },

    dispose() {
      for (const d of disposables) d.dispose?.();
    },
  };
}
