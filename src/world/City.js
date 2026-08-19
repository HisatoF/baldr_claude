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
    { z: -300, count: 40, wMin: 16, wMax: 38, hMin: 18, hMax: 78,  emis: 0.20, tint: 0x11182a },
    { z: -205, count: 30, wMin: 14, wMax: 32, hMin: 14, hMax: 52,  emis: 0.34, tint: 0x161d30 },
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
    base: [0.115, 0.122, 0.145],
    cracks: 7,
    aggregate: 0.8,
    stain: 1.0,
    rough: 0.88,
    normalStrength: 1.8,
  });

  // Three districts, not one wall.
  //
  // One material across all 22 blocks meant one window texture at one repeat, so the
  // whole midground shared a single pitch, a single lit-window density and a single
  // colour temperature — a facade band that reads as wallpaper however much
  // silhouette variation the parapets and roof plant add above it. The variation a
  // skyline needs most is not in its outline, it is in how differently its buildings
  // are occupied at night. Three materials is three draw calls, which this frame can
  // afford several times over.
  //
  // `emissiveIntensity` and texture repeat are material uniforms, so per-instance
  // variation is not available without a custom shader; splitting the population is
  // the cheap way to get the same effect.
  const DISTRICTS = [
    { seed: 4242, cols: 16, rows: 32, repeat: [2, 2], emis: 0.40, tint: 0xffffff },
    { seed: 7717, cols: 10, rows: 22, repeat: [3, 3], emis: 0.22, tint: 0xc8d4e6 },
    { seed: 9091, cols: 22, rows: 44, repeat: [1.4, 1.6], emis: 0.38, tint: 0xffdcb4 },
  ];

  const midMats = DISTRICTS.map((d) => {
    const win = makeWindowGrid(d.seed, d.cols, d.rows);
    win.repeat.set(d.repeat[0], d.repeat[1]);
    disposables.push(win);
    const m = new THREE.MeshStandardMaterial({
      map: concrete.map,
      normalMap: concrete.normalMap,
      roughnessMap: concrete.orm,
      metalnessMap: concrete.orm,
      roughness: 0.9,
      metalness: 0.05,
      emissive: d.tint,
      emissiveMap: win,
      emissiveIntensity: d.emis,
      // The corridor flanks are the largest dark mass in frame and they were reading
      // as cut paper. A rough dielectric at night still gathers the sky and the glow
      // of the city around it; that is what the PMREM environment is for, and leaving
      // this at the default meant the biggest surfaces in the shot were the ones
      // least able to pick up any of it.
      envMapIntensity: 1.8,
    });
    disposables.push(m);
    return m;
  });
  // Parapets, cornices and roof plant all take the first district's material. They
  // are small, high, and mostly silhouette against the sky, so which facade they
  // carry matters far less than keeping them to one draw call each.
  const midMat = midMats[0];

  const MID_N = 22;
  // Which district each block belongs to. Neighbours differ, so the eye never gets
  // two identical facades side by side, but the assignment is not strictly cyclic
  // either — a repeating A-B-C is its own kind of wallpaper.
  const DISTRICT_OF = [0, 2, 1, 0, 1, 2, 0, 0, 1, 2, 1, 0, 2, 0, 1, 1, 2, 0, 1, 2, 0, 1];
  const midInsts = midMats.map((m) => {
    const inst = new THREE.InstancedMesh(box, m, MID_N);
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    inst.count = 0;
    return inst;
  });
  const midCounts = [0, 0, 0];
  // The flanks do NOT cast (set on each district mesh above).
  //
  // They did, and it was the single largest black region in every frame. The key
  // sits at a 44-degree elevation — which is what makes the mech's own shadow rake
  // toward the viewer instead of hiding behind it — so a 40 m tower at z = -30 lays
  // a 42 m shadow straight across the carriageway and past the play plane. The
  // result is physically correct and compositionally fatal: a third of the shot is
  // an unlit band, and the one shadow that carries gameplay information (the
  // player's) is invisible inside it. Set dressing does not get to delete the
  // playfield.

  // Rooftop plant, parapets and cornices.
  //
  // A building whose entire silhouette is one extruded box reads as a placeholder
  // no matter how good its facade texture is — the top edge is a dead straight line
  // across the sky, which nothing in a real city has. Each tower gets a parapet cap,
  // a cornice band breaking the wall, and a scatter of roof boxes and masts. Three
  // instanced meshes for the whole skyline.
  const capInst = new THREE.InstancedMesh(box, midMat, MID_N * 2);
  const plantInst = new THREE.InstancedMesh(box, midMat, MID_N * 4);
  for (const m of [capInst, plantInst]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.count = 0;
  }
  let capN = 0;
  let plantN = 0;

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
    const dIdx = DISTRICT_OF[i % DISTRICT_OF.length];
    midInsts[dIdx].setMatrixAt(midCounts[dIdx]++, m4);

    // Parapet: slightly wider than the shaft, capping the top edge.
    pos.set(x, h + 0.6, z);
    scl.set(w * 1.06, 1.2, d * 1.06);
    m4.compose(pos, q, scl);
    capInst.setMatrixAt(capN++, m4);

    // Cornice: a band about two thirds up, breaking the flat wall.
    const cy2 = h * (0.58 + rnd() * 0.16);
    pos.set(x, cy2, z);
    scl.set(w * 1.045, 0.7, d * 1.045);
    m4.compose(pos, q, scl);
    capInst.setMatrixAt(capN++, m4);

    // Roof plant: tanks, housings and a mast. Only on taller blocks, where the
    // roofline is actually visible against the sky.
    if (h > 22) {
      const nPlant = 2 + ((rnd() * 3) | 0);
      for (let k = 0; k < nPlant && plantN < MID_N * 4; k++) {
        const pw = 1.6 + rnd() * 4.2;
        const ph = 1.4 + rnd() * 5.5;
        const pd = 1.6 + rnd() * 3.4;
        pos.set(
          x + (rnd() - 0.5) * (w - pw - 1.5),
          h + 1.2 + ph * 0.5,
          z + (rnd() - 0.5) * (d - pd - 1.5)
        );
        scl.set(pw, ph, pd);
        m4.compose(pos, q, scl);
        plantInst.setMatrixAt(plantN++, m4);
      }
    }
  }

  for (let d = 0; d < midInsts.length; d++) {
    midInsts[d].count = midCounts[d];
    midInsts[d].instanceMatrix.needsUpdate = true;
  }
  capInst.count = capN;
  plantInst.count = plantN;
  capInst.instanceMatrix.needsUpdate = true;
  plantInst.instanceMatrix.needsUpdate = true;
  midGroup.add(...midInsts, capInst, plantInst);

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
  // Dark, but not a hole.
  //
  // At 0x02030b with fog off this sat at luminance 3 against a road at 60, and a
  // near-black shape with a hard edge across the bottom corners of the frame does not
  // read as framing — it reads as a region where the renderer gave up. Foreground
  // silhouette wants to be the darkest thing present while still being a thing: dark
  // enough to sit in front of everything, light enough to have an edge rather than
  // being one. Fog stays on so it belongs to the same atmosphere as the road it
  // overlaps, even though at this distance fog barely touches it.
  const foreMat = new THREE.MeshBasicMaterial({ color: 0x161b2c, fog: true });
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
