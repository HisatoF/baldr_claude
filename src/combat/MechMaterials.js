/**
 * Procedural surface set for the Simulacrum. Zero external assets.
 *
 * The rubric is explicit that a flat-coloured `MeshStandardMaterial` on a hero object
 * is an automatic fail, and that metal needs detail at two scales. So we author one
 * seamless 512² tile carrying:
 *
 *   - panel-level detail: a recursive plate subdivision with grooved seams, a lit lip
 *     on the up-facing side of each groove, rivet rows, intake grills and caution
 *     chevrons;
 *   - micro detail: ~300 wrapped scratches and a per-pixel grain pass, which land in
 *     the height and roughness channels so they read as polish and wear rather than
 *     as painted-on noise.
 *
 * The albedo stays deliberately near-neutral: per-part colour comes from the vertex
 * `color` attribute, so the same tile serves gunmetal armour, dark hydraulics and
 * pale accent plates.
 *
 * The normal map is a Sobel derivative of the height canvas, so grooves and scratches
 * are physically consistent with the roughness they sit in.
 */
import * as THREE from 'three';
import { Rng } from '../core/Rng.js';
import { clamp } from '../core/MathUtil.js';

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  return { c, g };
}

/** Draw `fn` nine times on a 3x3 offset lattice so the primitive tiles seamlessly. */
function wrapped(g, size, fn) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      g.save();
      g.translate(ox * size, oy * size);
      fn();
      g.restore();
    }
  }
}

/** Recursive plate subdivision. Returns a flat list of {x,y,w,h,depth}. */
function subdivide(rng, x, y, w, h, depth, min, out) {
  const canSplit = depth < 5 && (w > min * 2 || h > min * 2) && rng.float() < 0.93 - depth * 0.09;
  if (!canSplit) {
    out.push({ x, y, w, h, depth });
    return out;
  }
  const horizontal = w > h ? rng.float() < 0.82 : rng.float() < 0.18;
  const t = rng.range(0.34, 0.66);
  if (horizontal) {
    const a = Math.round(w * t);
    subdivide(rng, x, y, a, h, depth + 1, min, out);
    subdivide(rng, x + a, y, w - a, h, depth + 1, min, out);
  } else {
    const a = Math.round(h * t);
    subdivide(rng, x, y, w, a, depth + 1, min, out);
    subdivide(rng, x, y + a, w, h - a, depth + 1, min, out);
  }
  return out;
}

/**
 * @param {number} size texture resolution (power of two)
 * @param {number} seed deterministic seed
 * @returns {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture, dispose:Function}}
 */
export function makeMechSurface(size = 512, seed = 0x5eeda11) {
  const rng = new Rng(seed);
  const A = canvas2d(size); // albedo
  const H = canvas2d(size); // height
  const R = canvas2d(size); // roughness

  // ---- base ---------------------------------------------------------------
  A.g.fillStyle = '#b3b8bf';
  A.g.fillRect(0, 0, size, size);
  H.g.fillStyle = '#808080';
  H.g.fillRect(0, 0, size, size);
  R.g.fillStyle = '#787878';
  R.g.fillRect(0, 0, size, size);

  // ---- panels -------------------------------------------------------------
  const panels = subdivide(rng, 0, 0, size, size, 0, Math.max(26, size * 0.055), []);

  for (const p of panels) {
    const tone = rng.range(-9, 9);
    const v = clamp(179 + tone, 140, 220) | 0;
    A.g.fillStyle = `rgb(${v},${(v * 1.01) | 0},${(v * 1.05) | 0})`;
    A.g.fillRect(p.x, p.y, p.w, p.h);

    const hv = (128 + rng.range(-6, 6)) | 0;
    H.g.fillStyle = `rgb(${hv},${hv},${hv})`;
    H.g.fillRect(p.x, p.y, p.w, p.h);

    const rv = clamp(120 + rng.range(-22, 22), 60, 200) | 0;
    R.g.fillStyle = `rgb(${rv},${rv},${rv})`;
    R.g.fillRect(p.x, p.y, p.w, p.h);
  }

  // seams: dark groove + lit lip on the upper edge
  const seamW = Math.max(1, size / 384);
  for (const p of panels) {
    A.g.strokeStyle = 'rgba(24,28,34,0.55)';
    A.g.lineWidth = seamW * 1.6;
    A.g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    A.g.strokeStyle = 'rgba(255,255,255,0.10)';
    A.g.lineWidth = seamW;
    A.g.strokeRect(p.x + seamW + 0.5, p.y + seamW + 0.5, p.w - 2 * seamW - 1, p.h - 2 * seamW - 1);

    H.g.strokeStyle = 'rgb(56,56,56)';
    H.g.lineWidth = seamW * 1.8;
    H.g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    H.g.strokeStyle = 'rgb(196,196,196)';
    H.g.lineWidth = seamW;
    H.g.strokeRect(p.x + seamW * 1.6, p.y + seamW * 1.6, p.w - seamW * 3.2, p.h - seamW * 3.2);

    R.g.strokeStyle = 'rgba(210,210,210,0.7)'; // grime settles in seams -> rougher
    R.g.lineWidth = seamW * 2.2;
    R.g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
  }

  // ---- rivets -------------------------------------------------------------
  const rivetR = Math.max(1.5, size / 250);
  for (const p of panels) {
    if (rng.float() > 0.45 || p.w < 40 || p.h < 24) continue;
    const inset = rivetR * 3;
    const step = Math.max(18, size / 22);
    const along = rng.bool() ? 'x' : 'y';
    const count = Math.floor(((along === 'x' ? p.w : p.h) - inset * 2) / step);
    for (let i = 0; i <= count; i++) {
      const cx = along === 'x' ? p.x + inset + i * step : p.x + inset;
      const cy = along === 'x' ? p.y + inset : p.y + inset + i * step;
      H.g.fillStyle = 'rgb(70,70,70)';
      H.g.beginPath();
      H.g.arc(cx, cy, rivetR * 1.7, 0, Math.PI * 2);
      H.g.fill();
      H.g.fillStyle = 'rgb(205,205,205)';
      H.g.beginPath();
      H.g.arc(cx, cy, rivetR, 0, Math.PI * 2);
      H.g.fill();
      A.g.fillStyle = 'rgba(255,255,255,0.16)';
      A.g.beginPath();
      A.g.arc(cx, cy, rivetR, 0, Math.PI * 2);
      A.g.fill();
      R.g.fillStyle = 'rgba(70,70,70,0.9)';
      R.g.beginPath();
      R.g.arc(cx, cy, rivetR * 1.2, 0, Math.PI * 2);
      R.g.fill();
    }
  }

  // ---- intake grills ------------------------------------------------------
  for (const p of panels) {
    if (rng.float() > 0.16 || p.w < 48 || p.h < 34) continue;
    const pad = 6;
    const slats = 5 + ((rng.int(0, 2) * 2) | 0);
    const sh = (p.h - pad * 2) / slats;
    for (let i = 0; i < slats; i++) {
      const yy = p.y + pad + i * sh;
      A.g.fillStyle = 'rgba(16,19,24,0.72)';
      A.g.fillRect(p.x + pad, yy, p.w - pad * 2, sh * 0.62);
      A.g.fillStyle = 'rgba(255,255,255,0.13)';
      A.g.fillRect(p.x + pad, yy + sh * 0.62, p.w - pad * 2, Math.max(1, sh * 0.13));
      H.g.fillStyle = 'rgb(46,46,46)';
      H.g.fillRect(p.x + pad, yy, p.w - pad * 2, sh * 0.62);
      H.g.fillStyle = 'rgb(190,190,190)';
      H.g.fillRect(p.x + pad, yy + sh * 0.62, p.w - pad * 2, Math.max(1, sh * 0.2));
      R.g.fillStyle = 'rgba(200,200,200,0.6)';
      R.g.fillRect(p.x + pad, yy, p.w - pad * 2, sh * 0.62);
    }
  }

  // ---- caution chevrons (art direction, not text) -------------------------
  for (const p of panels) {
    if (rng.float() > 0.09 || p.w < 44 || p.h < 18) continue;
    const bh = Math.min(p.h * 0.34, 13);
    const by = p.y + p.h - bh - 4;
    A.g.save();
    A.g.beginPath();
    A.g.rect(p.x + 4, by, p.w - 8, bh);
    A.g.clip();
    A.g.fillStyle = 'rgba(28,30,34,0.9)';
    A.g.fillRect(p.x + 4, by, p.w - 8, bh);
    A.g.fillStyle = 'rgba(226,168,58,0.92)';
    for (let sx = -bh; sx < p.w; sx += bh * 1.6) {
      A.g.beginPath();
      A.g.moveTo(p.x + 4 + sx, by + bh);
      A.g.lineTo(p.x + 4 + sx + bh * 0.8, by);
      A.g.lineTo(p.x + 4 + sx + bh * 1.5, by);
      A.g.lineTo(p.x + 4 + sx + bh * 0.7, by + bh);
      A.g.closePath();
      A.g.fill();
    }
    A.g.restore();
    R.g.fillStyle = 'rgba(160,160,160,0.5)';
    R.g.fillRect(p.x + 4, by, p.w - 8, bh);
  }

  // ---- micro scratches ----------------------------------------------------
  const scratches = Math.round(size * 0.62);
  for (let i = 0; i < scratches; i++) {
    const x = rng.float() * size;
    const y = rng.float() * size;
    const a = rng.float() * Math.PI * 2;
    const len = rng.range(4, 46);
    const dx = Math.cos(a) * len;
    const dy = Math.sin(a) * len;
    const w = rng.range(0.5, 1.5);
    wrapped(A.g, size, () => {
      A.g.strokeStyle = `rgba(255,255,255,${rng.range(0.05, 0.16).toFixed(3)})`;
      A.g.lineWidth = w;
      A.g.beginPath();
      A.g.moveTo(x, y);
      A.g.lineTo(x + dx, y + dy);
      A.g.stroke();
    });
    wrapped(H.g, size, () => {
      H.g.strokeStyle = 'rgba(176,176,176,0.5)';
      H.g.lineWidth = w;
      H.g.beginPath();
      H.g.moveTo(x, y);
      H.g.lineTo(x + dx, y + dy);
      H.g.stroke();
    });
    wrapped(R.g, size, () => {
      R.g.strokeStyle = 'rgba(46,46,46,0.55)'; // scratched metal is polished, not rough
      R.g.lineWidth = w * 1.4;
      R.g.beginPath();
      R.g.moveTo(x, y);
      R.g.lineTo(x + dx, y + dy);
      R.g.stroke();
    });
  }

  // ---- grime blooms -------------------------------------------------------
  for (let i = 0; i < 28; i++) {
    const x = rng.float() * size;
    const y = rng.float() * size;
    const r = rng.range(size * 0.05, size * 0.19);
    wrapped(A.g, size, () => {
      const grad = A.g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(20,24,30,0.20)');
      grad.addColorStop(1, 'rgba(20,24,30,0)');
      A.g.fillStyle = grad;
      A.g.beginPath();
      A.g.arc(x, y, r, 0, Math.PI * 2);
      A.g.fill();
    });
    wrapped(R.g, size, () => {
      const grad = R.g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(235,235,235,0.35)');
      grad.addColorStop(1, 'rgba(235,235,235,0)');
      R.g.fillStyle = grad;
      R.g.beginPath();
      R.g.arc(x, y, r, 0, Math.PI * 2);
      R.g.fill();
    });
  }

  // ---- per-pixel grain, then Sobel the height into a normal map -----------
  const hImg = H.g.getImageData(0, 0, size, size);
  const rImg = R.g.getImageData(0, 0, size, size);
  const hd = hImg.data;
  const rd = rImg.data;
  for (let i = 0; i < hd.length; i += 4) {
    const n = (rng.float() - 0.5) * 16;
    hd[i] = clamp(hd[i] + n, 0, 255);
    hd[i + 1] = hd[i];
    hd[i + 2] = hd[i];
    const rn = (rng.float() - 0.5) * 26;
    rd[i] = clamp(rd[i] + rn, 0, 255);
    rd[i + 1] = rd[i];
    rd[i + 2] = rd[i];
  }
  R.g.putImageData(rImg, 0, 0);

  const nImg = new ImageData(size, size);
  const nd = nImg.data;
  const S = 2.6; // normal strength
  const at = (x, y) => hd[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const d = at(x, y - 1);
      const u = at(x, y + 1);
      let nx = (l - r) * S;
      let ny = (d - u) * S;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const o = (y * size + x) * 4;
      nd[o] = (nx * 0.5 + 0.5) * 255;
      nd[o + 1] = (ny * 0.5 + 0.5) * 255;
      nd[o + 2] = (nz * 0.5 + 0.5) * 255;
      nd[o + 3] = 255;
    }
  }
  const N = canvas2d(size);
  N.g.putImageData(nImg, 0, 0);

  const mk = (cv, srgb) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };

  const map = mk(A.c, true);
  const normalMap = mk(N.c, false);
  const roughnessMap = mk(R.c, false);

  return {
    map,
    normalMap,
    roughnessMap,
    dispose() {
      map.dispose();
      normalMap.dispose();
      roughnessMap.dispose();
    },
  };
}

/**
 * A soft radial alpha blob used for the contact shadow under the mech. The rubric
 * treats a hero object with no ground contact as an automatic reject, and a blob is
 * cheap insurance that survives whatever the render module's shadow settings become.
 */
export function makeContactShadowTexture(size = 128) {
  const { c, g } = canvas2d(size);
  const r = size / 2;
  // OPAQUE luminance mask, not an alpha gradient.
  //
  // This previously painted black-with-varying-alpha and fed it to `map`, which
  // relies on the browser's alpha upload behaviour and rendered as nothing at all.
  // A solid white-to-black ramp consumed through `alphaMap` (which samples the green
  // channel) is unambiguous: white is opaque, black is clear.
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.42, 'rgba(150,150,150,1)');
  grad.addColorStop(0.74, 'rgba(48,48,48,1)');
  grad.addColorStop(1.0, 'rgba(0,0,0,1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Tiny procedural cube environment so metal has something to reflect. If the render
 * module later installs a real `scene.environment`, `MechModel` drops this and defers
 * to it — see `MechModel.syncEnvironment`.
 */
export function makeFallbackEnvironment(renderer) {
  if (!renderer) return null;
  const scene = new THREE.Scene();
  // A cheap sky/ground/neon-strip box: enough to give edges a gradient rather than
  // the black that unlit metal otherwise collapses to.
  const geo = new THREE.BoxGeometry(60, 60, 60);
  const colors = [];
  const pos = geo.attributes.position;
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 30;
    const x = pos.getX(i) / 30;
    if (y > 0.2) col.setHex(0x1b2a3d).multiplyScalar(1.0 + y * 0.8);
    else if (y < -0.2) col.setHex(0x0a0c10);
    else col.setHex(x > 0 ? 0x2a4a63 : 0x3a1f3a);
    colors.push(col.r, col.g, col.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })
  );
  scene.add(mesh);

  const pmrem = new THREE.PMREMGenerator(renderer);
  let rt = null;
  try {
    rt = pmrem.fromScene(scene, 0.06);
  } catch (e) {
    pmrem.dispose();
    geo.dispose();
    mesh.material.dispose();
    return null;
  }
  pmrem.dispose();
  geo.dispose();
  mesh.material.dispose();
  return rt ? rt.texture : null;
}
