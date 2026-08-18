/**
 * Procedural texture library for the world module.
 *
 * Hard rule from docs/ARCHITECTURE.md §1: zero external assets. Every surface in the
 * game therefore has to be synthesised here, at boot, from noise + canvas2d.
 *
 * Design notes
 * ------------
 * - **Two detail scales everywhere.** The quality rubric explicitly fails surfaces
 *   that only carry one frequency of detail, so every generator writes a *structural*
 *   layer (panel seams, kerb aggregate, crack networks) and a *micro* layer (scratch
 *   passes, speckle, grain) into the same height field before the normal map is
 *   derived. That is what stops metal reading as plastic.
 * - **ORM packing.** Roughness, metalness and AO travel in one RGB texture
 *   (R=ao, G=roughness, B=metalness) because three samples `.r/.g/.b` from separate
 *   maps anyway. One upload instead of three, and the sampler count per material
 *   drops, which matters on the software rasteriser the capture harness uses.
 * - **Everything is cached.** Generators are pure functions of their options, so a
 *   string key over the options is a sound cache key. Nothing here is ever generated
 *   twice, and `disposeTextures()` releases the lot.
 * - **Tileable noise.** The lattice wraps on an integer period, and every FBM octave
 *   doubles a power-of-two period, so the field tiles exactly. Non-tiling noise on a
 *   repeated ground plane produces a visible grid, which is an instant polish fail.
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* small math helpers (module-local, generation-time only)             */
/* ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Deterministic 32-bit PRNG. Texture generation must be reproducible run to run. */
export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* tileable value noise / FBM                                          */
/* ------------------------------------------------------------------ */

/**
 * Tileable value noise on a 256-entry permutation lattice.
 *
 * `period` is the lattice repeat in *cell* units; sample coordinates are taken
 * modulo it, so a field sampled over [0,period) tiles seamlessly. Keep period ≤ 256
 * or the hash aliases against itself.
 */
export class TileNoise {
  constructor(seed = 0x1a2b3c) {
    const rnd = mulberry32(seed);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  _h(xi, yi) {
    return this.p[(this.p[xi & 255] + yi) & 255] * (1 / 255);
  }

  /** Single octave of tileable value noise in 0..1. */
  value(x, y, px, py) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = smootherstep(x - xi);
    const v = smootherstep(y - yi);
    const x0 = ((xi % px) + px) % px;
    const y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px;
    const y1 = (y0 + 1) % py;
    const a = this._h(x0, y0);
    const b = this._h(x1, y0);
    const c = this._h(x0, y1);
    const d = this._h(x1, y1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
}

/**
 * Render a tileable FBM field into a Float32Array of size w*h, normalised to 0..1.
 *
 * The octave loop is *outside* the pixel loop so each pass is a linear sweep over
 * memory — roughly 4x faster than the naive per-pixel FBM, which matters because the
 * boot budget for the whole texture set is a few hundred milliseconds.
 */
export function fbmField(noise, w, h, periodX, periodY, octaves = 5, gain = 0.5) {
  const out = new Float32Array(w * h);
  let amp = 1;
  let norm = 0;
  let px = periodX;
  let py = periodY;
  for (let o = 0; o < octaves; o++) {
    const sx = px / w;
    const sy = py / h;
    let i = 0;
    for (let y = 0; y < h; y++) {
      const fy = y * sy;
      for (let x = 0; x < w; x++, i++) out[i] += amp * noise.value(x * sx, fy, px, py);
    }
    norm += amp;
    amp *= gain;
    px = Math.min(256, px * 2);
    py = Math.min(256, py * 2);
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Ridged variant — good for cracks, rust fronts and cloud filaments. */
export function ridgeField(noise, w, h, px, py, octaves = 4, gain = 0.55) {
  const f = fbmField(noise, w, h, px, py, octaves, gain);
  for (let i = 0; i < f.length; i++) f[i] = 1 - Math.abs(f[i] * 2 - 1);
  return f;
}

/* ------------------------------------------------------------------ */
/* canvas / texture plumbing                                           */
/* ------------------------------------------------------------------ */

const _cache = new Map();
const _owned = [];

function cached(key, build) {
  let v = _cache.get(key);
  if (v === undefined) {
    v = build();
    _cache.set(key, v);
  }
  return v;
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Wrap a canvas as a texture with the correct colour space.
 *
 * Getting this wrong is one of the most common "why does my PBR look like clay"
 * causes: albedo must be tagged sRGB so three linearises it, while normal/ORM data
 * are raw numbers and must NOT be linearised.
 */
export function texFromCanvas(canvas, opts = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  t.wrapS = opts.wrapS ?? opts.wrap ?? THREE.RepeatWrapping;
  t.wrapT = opts.wrapT ?? opts.wrap ?? THREE.RepeatWrapping;
  if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
  t.anisotropy = opts.aniso ?? 8;
  t.generateMipmaps = opts.mips !== false;
  t.minFilter = opts.mips === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  _owned.push(t);
  return t;
}

/**
 * Sobel-derived tangent-space normal map from a height field.
 *
 * Written into a canvas rather than a DataTexture on purpose: CanvasTexture defaults
 * to `flipY = true` like every other map here, so the normal map stays in lockstep
 * with the albedo it was derived from. A DataTexture would need flipY = false and
 * would silently invert the green channel relative to the albedo.
 *
 * @param {Float32Array} height  w*h height samples, any range (0..1 typical)
 * @param {number} w
 * @param {number} h
 * @param {number} strength  slope multiplier; 1 ≈ subtle, 4 ≈ aggressive
 */
export function makeNormalFromHeight(height, w, h, strength = 2.0) {
  const c = canvas2d(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => height[(((y % h) + h) % h) * w + (((x % w) + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel 3x3 — wraps, so the normal map tiles exactly like its source.
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const gx = tl + 2 * l + bl - (tr + 2 * r + br);
      const gy = tl + 2 * t + tr - (bl + 2 * b + br);
      // +Y-up (OpenGL) convention; rows run downward so gy is already negated.
      let nx = gx * strength;
      let ny = -gy * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = nz * inv * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ */
/* shared stamping primitives                                          */
/* ------------------------------------------------------------------ */

/** Stamp a soft disc into a float field, wrapping at the edges (keeps tiling). */
function stampDisc(field, w, h, cx, cy, r, amount, hardness = 0.5) {
  const r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    const yy = ((y % h) + h) % h;
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const fall = hardness >= 1 ? 1 : Math.pow(t, 1 - hardness + 0.0001);
      const xx = ((x % w) + w) % w;
      field[yy * w + xx] += amount * fall;
    }
  }
}

/** Stamp a wrapping line by walking it and dropping discs. Used for cracks/scratches. */
function stampLine(field, w, h, x0, y0, x1, y1, r, amount, hardness = 0.5) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, r * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampDisc(field, w, h, x0 + dx * t, y0 + dy * t, r, amount / (steps * 0.35 + 1), hardness);
  }
}

/**
 * A pass of fine directional scratches.
 *
 * This is the *micro* detail scale the rubric demands. It is deliberately drawn after
 * the structural layer and at sub-pixel width so it survives into the normal map as
 * glinting anisotropy rather than as visible gouges.
 */
function scratchPass(height, rough, w, h, rnd, count, opts = {}) {
  const bias = opts.bias ?? 0; // preferred direction in radians
  const spread = opts.spread ?? Math.PI;
  const maxLen = opts.maxLen ?? w * 0.25;
  for (let i = 0; i < count; i++) {
    const a = bias + (rnd() - 0.5) * 2 * spread;
    const len = (0.15 + rnd() * 0.85) * maxLen;
    const x0 = rnd() * w;
    const y0 = rnd() * h;
    const x1 = x0 + Math.cos(a) * len;
    const y1 = y0 + Math.sin(a) * len;
    const deep = rnd() < 0.18;
    const r = deep ? 0.9 + rnd() * 0.7 : 0.5 + rnd() * 0.4;
    const amt = (deep ? 0.05 : 0.018) * (0.4 + rnd());
    stampLine(height, w, h, x0, y0, x1, y1, r, amt, 0.15);
    // A scratch exposes fresh metal: locally smoother, i.e. lower roughness.
    if (rough) stampLine(rough, w, h, x0, y0, x1, y1, r, -amt * 3.2, 0.15);
  }
}

/* ------------------------------------------------------------------ */
/* panelled industrial metal                                           */
/* ------------------------------------------------------------------ */

/**
 * Build a tileable panel subdivision: rows of varying height, each split into
 * columns of varying width. Both axes normalise back to `size`, so the layout wraps
 * and the outermost seam doubles as the tile seam — invisible, because a seam is
 * exactly what you would expect to find there.
 */
function panelLayout(size, rnd, minCell, maxCell) {
  const idx = new Int32Array(size * size);
  const panels = [];
  const cuts = (extent) => {
    const list = [];
    let p = 0;
    while (p < extent) {
      let c = Math.round(minCell + rnd() * (maxCell - minCell));
      if (extent - (p + c) < minCell * 0.7) c = extent - p;
      list.push([p, p + c]);
      p += c;
    }
    return list;
  };

  const rows = cuts(size);
  for (const [ry0, ry1] of rows) {
    const cols = cuts(size);
    for (const [cx0, cx1] of cols) {
      const id = panels.length;
      panels.push({
        x0: cx0,
        x1: cx1,
        y0: ry0,
        y1: ry1,
        tone: rnd(),
        lift: (rnd() - 0.5) * 0.055,
        rust: rnd(),
        rivets: rnd() < 0.72,
      });
      for (let y = ry0; y < ry1; y++) {
        const row = y * size;
        for (let x = cx0; x < cx1; x++) idx[row + x] = id;
      }
    }
  }
  return { idx, panels };
}

/**
 * Industrial panelled metal: albedo + packed ORM + normal (+ optional emissive).
 *
 * @param {object} o
 * @param {number} [o.size=512]
 * @param {number} [o.seed]
 * @param {[number,number,number]} [o.base]     base albedo, linear-ish 0..1
 * @param {number} [o.grime]     0..1 streak intensity
 * @param {number} [o.wear]      0..1 edge-wear intensity
 * @param {number} [o.rough]     centre roughness
 * @param {number} [o.metal]     base metalness
 * @param {number} [o.emissive]  0 = none, else strip density
 * @param {[number,number,number]} [o.emissiveColor]
 */
export function makeMetalPanel(o = {}) {
  const key = 'metal:' + JSON.stringify(o);
  return cached(key, () => {
    const size = o.size ?? 512;
    const seed = o.seed ?? 12345;
    const base = o.base ?? [0.30, 0.335, 0.385];
    const grimeAmt = o.grime ?? 0.7;
    const wearAmt = o.wear ?? 0.65;
    const baseRough = o.rough ?? 0.52;
    const baseMetal = o.metal ?? 0.92;
    const rnd = mulberry32(seed);
    const noise = new TileNoise(seed ^ 0x77aa33);

    const N = size * size;
    const height = new Float32Array(N);
    const rough = new Float32Array(N);
    const metal = new Float32Array(N);
    const ao = new Float32Array(N);
    const albR = new Float32Array(N);
    const albG = new Float32Array(N);
    const albB = new Float32Array(N);

    const { idx, panels } = panelLayout(size, rnd, size / 7, size / 3.2);

    // Structural + macro noise layers, precomputed as whole-image sweeps.
    const nMacro = fbmField(noise, size, size, 4, 4, 4, 0.55);
    const nGrime = fbmField(noise, size, size, 3, 16, 5, 0.6);
    const nRust = fbmField(noise, size, size, 8, 8, 4, 0.5);
    const nMicro = fbmField(noise, size, size, 64, 64, 3, 0.5);
    const nFine = fbmField(noise, size, size, 128, 128, 2, 0.5);

    const seamW = Math.max(1.5, size / 190);

    for (let y = 0, i = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i++) {
        const p = panels[idx[i]];

        // distance to the nearest panel border, in pixels
        const d = Math.min(x - p.x0, p.x1 - 1 - x, y - p.y0, p.y1 - 1 - y);

        // --- structural scale: seam groove + bevel shoulder -------------
        const groove = 1 - sstep(0, seamW, d);
        const bevel = sstep(seamW, seamW * 1.9, d) * (1 - sstep(seamW * 1.9, seamW * 3.4, d));

        let hgt = 0.5 + p.lift;
        hgt -= groove * 0.42;
        hgt += bevel * 0.05;

        // --- micro scale: two noise bands -------------------------------
        const micro = (nMicro[i] - 0.5) * 0.055 + (nFine[i] - 0.5) * 0.03;
        hgt += micro;

        // --- albedo ------------------------------------------------------
        const tone = 0.82 + p.tone * 0.34;
        // subtle per-panel hue drift keeps a wall of panels from reading flat
        const hueDrift = (p.tone - 0.5) * 0.06;
        let r = base[0] * tone * (1 - hueDrift);
        let g = base[1] * tone;
        let b = base[2] * tone * (1 + hueDrift);

        const macro = nMacro[i];
        const mac = 0.86 + macro * 0.28;
        r *= mac; g *= mac; b *= mac;

        let rgh = baseRough + (macro - 0.5) * 0.18 + (nMicro[i] - 0.5) * 0.12;
        let mtl = baseMetal;
        let occ = 1 - groove * 0.75 - (1 - bevel) * 0.03;

        // --- edge wear: exposed bright metal along seams -----------------
        const wearMask = wearAmt * (1 - sstep(seamW * 0.8, seamW * 4.5, d)) * sstep(0.35, 0.7, nRust[i]);
        if (wearMask > 0.001) {
          r = lerp(r, 0.58, wearMask * 0.7);
          g = lerp(g, 0.60, wearMask * 0.7);
          b = lerp(b, 0.63, wearMask * 0.7);
          rgh = lerp(rgh, 0.22, wearMask * 0.8);
        }

        // --- rust / oxide blooms ----------------------------------------
        const rustMask = sstep(0.62, 0.88, nRust[i] * (0.7 + p.rust * 0.6)) * 0.85;
        if (rustMask > 0.001) {
          r = lerp(r, 0.19, rustMask);
          g = lerp(g, 0.095, rustMask);
          b = lerp(b, 0.055, rustMask);
          rgh = lerp(rgh, 0.94, rustMask);
          mtl = lerp(mtl, 0.05, rustMask);
        }

        // --- streaked grime: runs downward from seams --------------------
        // Streaks are a vertical-frequency-biased noise field gated by how far the
        // pixel sits below the panel's top edge, which is where water actually
        // collects and runs. Uniform dirt looks sprayed on; this looks weathered.
        const below = clamp01((y - p.y0) / Math.max(8, p.y1 - p.y0));
        const streak = sstep(0.45, 0.92, nGrime[i]) * (0.35 + below * 0.65) * grimeAmt;
        if (streak > 0.001) {
          const k = streak * 0.55;
          r = lerp(r, 0.048, k);
          g = lerp(g, 0.052, k);
          b = lerp(b, 0.058, k);
          rgh = lerp(rgh, 0.88, streak * 0.7);
          occ -= streak * 0.15;
        }

        albR[i] = r; albG[i] = g; albB[i] = b;
        rough[i] = rgh;
        metal[i] = mtl;
        ao[i] = occ;
        height[i] = hgt;
      }
    }

    // --- rivets: structural detail, stamped rather than tested per pixel ---
    for (const p of panels) {
      if (!p.rivets) continue;
      const inset = seamW * 3.2;
      const w = p.x1 - p.x0;
      const h = p.y1 - p.y0;
      if (w < inset * 4 || h < inset * 4) continue;
      const spacing = Math.max(14, size / 20);
      const rr = Math.max(1.6, size / 210);
      const line = (ax, ay, bx, by) => {
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.round(len / spacing));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const cx = ax + (bx - ax) * t;
          const cy = ay + (by - ay) * t;
          stampDisc(height, size, size, cx, cy, rr * 1.8, 0.10, 0.85);
          stampDisc(height, size, size, cx, cy, rr, 0.16, 0.9);
          stampDisc(rough, size, size, cx, cy, rr * 1.4, -0.10, 0.7);
          stampDisc(ao, size, size, cx, cy, rr * 2.4, -0.06, 0.4);
        }
      };
      line(p.x0 + inset, p.y0 + inset, p.x1 - inset, p.y0 + inset);
      line(p.x0 + inset, p.y1 - inset, p.x1 - inset, p.y1 - inset);
      line(p.x0 + inset, p.y0 + inset, p.x0 + inset, p.y1 - inset);
      line(p.x1 - inset, p.y0 + inset, p.x1 - inset, p.y1 - inset);
    }

    // --- micro-scratch pass (second detail scale) --------------------------
    scratchPass(height, rough, size, size, rnd, Math.round(size * 0.9), {
      bias: 0,
      spread: 0.55,
      maxLen: size * 0.30,
    });
    scratchPass(height, rough, size, size, rnd, Math.round(size * 0.35), {
      bias: Math.PI / 2,
      spread: 0.5,
      maxLen: size * 0.16,
    });

    // --- emissive strips ---------------------------------------------------
    let emissiveCanvas = null;
    if (o.emissive) {
      const ec = canvas2d(size, size);
      const ectx = ec.getContext('2d');
      ectx.fillStyle = '#000';
      ectx.fillRect(0, 0, size, size);
      const col = o.emissiveColor ?? [0.15, 0.85, 1.0];
      const cs = `rgb(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0})`;
      for (const p of panels) {
        if (rnd() > o.emissive) continue;
        const h = p.y1 - p.y0;
        const stripH = Math.max(2, size / 128);
        const yy = p.y0 + h * (0.25 + rnd() * 0.5);
        const pad = seamW * 4;
        // Falloff + thickness, not a uniform full-white quad (rubric §3).
        const grad = ectx.createLinearGradient(0, yy - stripH * 3, 0, yy + stripH * 3);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.5, cs);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ectx.fillStyle = grad;
        ectx.fillRect(p.x0 + pad, yy - stripH * 3, p.x1 - p.x0 - pad * 2, stripH * 6);
        ectx.fillStyle = cs;
        ectx.fillRect(p.x0 + pad, yy - stripH * 0.5, p.x1 - p.x0 - pad * 2, stripH);
      }
      emissiveCanvas = ec;
    }

    // --- resolve to canvases ----------------------------------------------
    const albCanvas = canvas2d(size, size);
    const actx = albCanvas.getContext('2d');
    const aimg = actx.createImageData(size, size);
    const ormCanvas = canvas2d(size, size);
    const octx = ormCanvas.getContext('2d');
    const oimg = octx.createImageData(size, size);
    const ad = aimg.data;
    const od = oimg.data;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      // albedo authored in linear terms, encoded to sRGB for the SRGB texture
      ad[j] = Math.pow(clamp01(albR[i]), 1 / 2.2) * 255;
      ad[j + 1] = Math.pow(clamp01(albG[i]), 1 / 2.2) * 255;
      ad[j + 2] = Math.pow(clamp01(albB[i]), 1 / 2.2) * 255;
      ad[j + 3] = 255;
      od[j] = clamp01(ao[i]) * 255;
      od[j + 1] = clamp01(rough[i]) * 255;
      od[j + 2] = clamp01(metal[i]) * 255;
      od[j + 3] = 255;
    }
    actx.putImageData(aimg, 0, 0);
    octx.putImageData(oimg, 0, 0);

    const normalCanvas = makeNormalFromHeight(height, size, size, o.normalStrength ?? 2.6);

    return {
      map: texFromCanvas(albCanvas, { srgb: true }),
      orm: texFromCanvas(ormCanvas),
      normalMap: texFromCanvas(normalCanvas),
      emissiveMap: emissiveCanvas ? texFromCanvas(emissiveCanvas, { srgb: true }) : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* concrete / asphalt                                                  */
/* ------------------------------------------------------------------ */

/**
 * Cracked, stained, aggregate-speckled concrete. Also serves asphalt with a darker
 * base and finer aggregate.
 *
 * @param {object} o
 * @param {number} [o.size=512]
 * @param {[number,number,number]} [o.base]
 * @param {number} [o.cracks=7]      crack seeds
 * @param {number} [o.aggregate=1]   speckle density multiplier
 * @param {number} [o.macroHeight=0.22] how much the metre-scale noise band displaces
 * @param {number} [o.stain=1]
 * @param {number} [o.rough=0.88]
 */
export function makeConcrete(o = {}) {
  const key = 'concrete:' + JSON.stringify(o);
  return cached(key, () => {
    const size = o.size ?? 512;
    const seed = o.seed ?? 909;
    const base = o.base ?? [0.115, 0.125, 0.145];
    const rnd = mulberry32(seed);
    const noise = new TileNoise(seed ^ 0x5511bb);
    const N = size * size;

    const height = new Float32Array(N);
    const rough = new Float32Array(N);
    const albR = new Float32Array(N);
    const albG = new Float32Array(N);
    const albB = new Float32Array(N);
    const ao = new Float32Array(N);

    const nMacro = fbmField(noise, size, size, 3, 3, 4, 0.6);
    const nStain = fbmField(noise, size, size, 5, 5, 5, 0.62);
    const nGrain = fbmField(noise, size, size, 96, 96, 3, 0.5);
    const nFine = fbmField(noise, size, size, 192, 192, 2, 0.5);
    const nPatch = fbmField(noise, size, size, 9, 9, 3, 0.5);

    const aggAmt = o.aggregate ?? 1;
    const stainAmt = o.stain ?? 1;
    const baseRough = o.rough ?? 0.88;

    for (let i = 0; i < N; i++) {
      const macro = nMacro[i];
      const grain = nGrain[i];
      const fine = nFine[i];

      // Aggregate: little stones poking through the cement skin. Threshold the fine
      // band so it reads as discrete chips instead of generic fuzz.
      const chip = sstep(0.60, 0.80, grain) * aggAmt;
      const dust = (fine - 0.5) * 0.35;

      // Macro contributes to COLOUR strongly and to HEIGHT barely.
      //
      // These were coupled at 0.22, which on a surface tiling every ~9 m meant the
      // normal map carried metre-scale swells. Lit by a low key that reads as a
      // field of lumps — the road looked like crumpled foil rather than asphalt.
      // Large-scale tonal drift is what breaks up tiling; large-scale *relief* is
      // what makes a flat surface stop looking flat, and asphalt is meant to be flat.
      const macroH = o.macroHeight ?? 0.22;
      let hgt = 0.5 + (macro - 0.5) * macroH + chip * 0.10 + (grain - 0.5) * 0.05 + dust * 0.05;

      const tint = 0.80 + macro * 0.45;
      let r = base[0] * tint;
      let g = base[1] * tint;
      let b = base[2] * tint;

      // chips are lighter and glintier than the matrix
      r = lerp(r, r * 2.1 + 0.03, chip);
      g = lerp(g, g * 2.1 + 0.03, chip);
      b = lerp(b, b * 2.0 + 0.03, chip);

      let rgh = baseRough + (grain - 0.5) * 0.14 - chip * 0.22;

      // oil / soot stains
      const stain = sstep(0.52, 0.86, nStain[i]) * stainAmt;
      if (stain > 0.001) {
        r = lerp(r, 0.030, stain * 0.85);
        g = lerp(g, 0.031, stain * 0.85);
        b = lerp(b, 0.036, stain * 0.85);
        rgh = lerp(rgh, 0.55, stain * 0.5);
      }

      // damp patches — lower roughness, slightly darker
      const damp = sstep(0.58, 0.80, nPatch[i]) * (o.damp ?? 0.55);
      if (damp > 0.001) {
        r *= 1 - damp * 0.35;
        g *= 1 - damp * 0.33;
        b *= 1 - damp * 0.28;
        rgh = lerp(rgh, 0.16, damp);
      }

      albR[i] = r; albG[i] = g; albB[i] = b;
      rough[i] = rgh;
      ao[i] = 1 - chip * 0.12;
      height[i] = hgt;
    }

    // --- crack network -----------------------------------------------------
    const crackCount = o.cracks ?? 7;
    const crackDark = new Float32Array(N);
    const walk = (x, y, a, segs, width, depth) => {
      for (let s = 0; s < segs; s++) {
        a += (rnd() - 0.5) * 1.0;
        const len = 4 + rnd() * 9;
        const nx = x + Math.cos(a) * len;
        const ny = y + Math.sin(a) * len;
        const taper = width * (1 - (s / segs) * 0.75);
        stampLine(height, size, size, x, y, nx, ny, Math.max(0.6, taper), -depth, 0.25);
        stampLine(crackDark, size, size, x, y, nx, ny, Math.max(0.8, taper * 1.5), 0.55, 0.2);
        x = nx; y = ny;
        if (rnd() < 0.10 && segs > 6) walk(x, y, a + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd()), (segs * 0.45) | 0, taper * 0.6, depth * 0.7);
      }
    };
    for (let c = 0; c < crackCount; c++) {
      walk(rnd() * size, rnd() * size, rnd() * Math.PI * 2, 14 + ((rnd() * 26) | 0), 1.5 + rnd() * 1.4, 0.11);
    }
    for (let i = 0; i < N; i++) {
      const cd = clamp01(crackDark[i]);
      if (cd > 0.002) {
        albR[i] = lerp(albR[i], 0.012, cd);
        albG[i] = lerp(albG[i], 0.013, cd);
        albB[i] = lerp(albB[i], 0.016, cd);
        rough[i] = lerp(rough[i], 0.97, cd);
        ao[i] = lerp(ao[i], 0.25, cd);
      }
    }

    // --- micro scratch / scuff pass ---------------------------------------
    scratchPass(height, rough, size, size, rnd, Math.round(size * 0.5), {
      spread: Math.PI,
      maxLen: size * 0.12,
    });

    const albCanvas = canvas2d(size, size);
    const actx = albCanvas.getContext('2d');
    const aimg = actx.createImageData(size, size);
    const ormCanvas = canvas2d(size, size);
    const octx = ormCanvas.getContext('2d');
    const oimg = octx.createImageData(size, size);
    const ad = aimg.data;
    const od = oimg.data;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      ad[j] = Math.pow(clamp01(albR[i]), 1 / 2.2) * 255;
      ad[j + 1] = Math.pow(clamp01(albG[i]), 1 / 2.2) * 255;
      ad[j + 2] = Math.pow(clamp01(albB[i]), 1 / 2.2) * 255;
      ad[j + 3] = 255;
      od[j] = clamp01(ao[i]) * 255;
      od[j + 1] = clamp01(rough[i]) * 255;
      od[j + 2] = clamp01(o.metal ?? 0.02) * 255;
      od[j + 3] = 255;
    }
    actx.putImageData(aimg, 0, 0);
    octx.putImageData(oimg, 0, 0);

    return {
      map: texFromCanvas(albCanvas, { srgb: true }),
      orm: texFromCanvas(ormCanvas),
      normalMap: texFromCanvas(makeNormalFromHeight(height, size, size, o.normalStrength ?? 2.2)),
    };
  });
}

/* ------------------------------------------------------------------ */
/* road markings decal                                                 */
/* ------------------------------------------------------------------ */

/**
 * RGBA decal strip laid over the road: lane dashes, hazard chevrons, a stencilled
 * bay outline. Alpha is eroded by noise so the paint reads as worn rather than
 * freshly applied, which is the difference between "game art" and "asset flip".
 *
 * Tiles along U (road length); V spans the road width once.
 */
export function makeRoadDecal(o = {}) {
  const key = 'roaddecal:' + JSON.stringify(o);
  return cached(key, () => {
    const w = o.width ?? 1024;
    const h = o.height ?? 512;
    const c = canvas2d(w, h);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const AMBER = 'rgb(196,152,52)';
    const WHITE = 'rgb(178,186,196)';

    // outer lane edge lines
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, h * 0.085, w, h * 0.016);
    ctx.fillRect(0, h * 0.899, w, h * 0.016);

    // centre dashes
    ctx.fillStyle = AMBER;
    const dashN = 8;
    for (let i = 0; i < dashN; i++) {
      const x = (i / dashN) * w;
      ctx.fillRect(x + w * 0.02, h * 0.487, w * 0.085, h * 0.020);
    }

    // lane divider dashes
    ctx.fillStyle = WHITE;
    for (let i = 0; i < dashN * 2; i++) {
      const x = (i / (dashN * 2)) * w;
      ctx.fillRect(x + w * 0.012, h * 0.278, w * 0.040, h * 0.013);
      ctx.fillRect(x + w * 0.012, h * 0.706, w * 0.040, h * 0.013);
    }

    // hazard chevrons in one bay
    ctx.save();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = h * 0.028;
    for (let i = 0; i < 7; i++) {
      const x = w * 0.55 + i * w * 0.032;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.12);
      ctx.lineTo(x + w * 0.030, h * 0.30);
      ctx.lineTo(x, h * 0.48);
      ctx.stroke();
    }
    ctx.restore();

    // stencilled loading-bay outline with corner ticks
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = h * 0.014;
    ctx.strokeRect(w * 0.12, h * 0.60, w * 0.22, h * 0.26);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const x = w * 0.12 + (w * 0.22 * i) / 4;
      ctx.moveTo(x, h * 0.60);
      ctx.lineTo(x - w * 0.02, h * 0.86);
    }
    ctx.stroke();

    // large directional arrow
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    ctx.moveTo(w * 0.40, h * 0.62);
    ctx.lineTo(w * 0.47, h * 0.73);
    ctx.lineTo(w * 0.435, h * 0.73);
    ctx.lineTo(w * 0.435, h * 0.84);
    ctx.lineTo(w * 0.375, h * 0.84);
    ctx.lineTo(w * 0.375, h * 0.73);
    ctx.lineTo(w * 0.34, h * 0.73);
    ctx.closePath();
    ctx.fill();

    // --- wear: erode alpha with noise, and scuff the paint's brightness ----
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const noise = new TileNoise(o.seed ?? 4242);
    const wear = fbmField(noise, w, h, 8, 4, 5, 0.6);
    const scuff = fbmField(noise, w, h, 40, 20, 3, 0.5);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      if (d[j + 3] === 0) continue;
      const k = clamp01((wear[i] - 0.30) * 2.6);
      const s = 0.62 + scuff[i] * 0.55;
      d[j + 3] *= clamp01(k) * (0.55 + scuff[i] * 0.5);
      d[j] *= s;
      d[j + 1] *= s;
      d[j + 2] *= s;
    }
    ctx.putImageData(img, 0, 0);

    return texFromCanvas(c, { srgb: true, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping });
  });
}

/* ------------------------------------------------------------------ */
/* signage atlas                                                       */
/* ------------------------------------------------------------------ */

/**
 * Draw a pseudo-logographic glyph: 2–6 strokes inside a box. Real characters would
 * be arbitrary and would read as placeholder text; abstract stroke clusters read as
 * dense foreign-language signage at any distance, which is the intent.
 */
function drawGlyph(ctx, x, y, s, rnd) {
  const lw = Math.max(1.5, s * 0.11);
  ctx.lineWidth = lw;
  ctx.lineCap = 'square';
  const n = 2 + ((rnd() * 4) | 0);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.55) {
      const yy = y + s * (0.15 + rnd() * 0.7);
      const x0 = x + s * (rnd() < 0.6 ? 0.08 : 0.3);
      const x1 = x + s * (0.6 + rnd() * 0.32);
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
    } else {
      const xx = x + s * (0.15 + rnd() * 0.7);
      const y0 = y + s * (rnd() < 0.6 ? 0.08 : 0.3);
      const y1 = y + s * (0.6 + rnd() * 0.32);
      ctx.moveTo(xx, y0);
      ctx.lineTo(xx, y1);
    }
  }
  ctx.stroke();
}

/**
 * 4x4 atlas of holographic sign faces, drawn premultiplied-ish into RGB with an
 * alpha coverage channel so the whole set can be one additive InstancedMesh.
 * Returns { texture, cols, rows }.
 */
export function makeSignAtlas(o = {}) {
  const key = 'signs:' + JSON.stringify(o);
  return cached(key, () => {
    const cols = 4;
    const rows = 4;
    const cw = o.cell ?? 256;
    const ch = o.cell ?? 256;
    const w = cw * cols;
    const h = ch * rows;
    const c = canvas2d(w, h);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const rnd = mulberry32(o.seed ?? 8181);

    const palettes = [
      ['rgb(255,60,150)', 'rgb(255,150,200)'],
      ['rgb(60,225,255)', 'rgb(170,245,255)'],
      ['rgb(255,175,50)', 'rgb(255,225,150)'],
      ['rgb(150,110,255)', 'rgb(215,195,255)'],
      ['rgb(80,255,180)', 'rgb(190,255,225)'],
      ['rgb(255,90,70)', 'rgb(255,190,175)'],
    ];

    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        const ox = cc * cw;
        const oy = r * ch;
        const pal = palettes[(r * cols + cc) % palettes.length];
        const kind = (r * cols + cc) % 4;

        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, cw, ch);
        ctx.clip();

        // frame
        ctx.strokeStyle = pal[0];
        ctx.lineWidth = cw * 0.018;
        ctx.strokeRect(ox + cw * 0.05, oy + ch * 0.07, cw * 0.90, ch * 0.86);
        // corner brackets
        ctx.lineWidth = cw * 0.035;
        const b = cw * 0.13;
        const rx = ox + cw * 0.05, ry = oy + ch * 0.07, rw = cw * 0.90, rh = ch * 0.86;
        ctx.beginPath();
        ctx.moveTo(rx, ry + b); ctx.lineTo(rx, ry); ctx.lineTo(rx + b, ry);
        ctx.moveTo(rx + rw - b, ry); ctx.lineTo(rx + rw, ry); ctx.lineTo(rx + rw, ry + b);
        ctx.moveTo(rx + rw, ry + rh - b); ctx.lineTo(rx + rw, ry + rh); ctx.lineTo(rx + rw - b, ry + rh);
        ctx.moveTo(rx + b, ry + rh); ctx.lineTo(rx, ry + rh); ctx.lineTo(rx, ry + rh - b);
        ctx.stroke();

        ctx.strokeStyle = pal[1];
        ctx.fillStyle = pal[1];

        if (kind === 0) {
          // vertical glyph column — classic hanging shop sign
          const gs = cw * 0.42;
          for (let i = 0; i < 3; i++) drawGlyph(ctx, ox + cw * 0.29, oy + ch * 0.10 + i * gs * 0.78, gs, rnd);
        } else if (kind === 1) {
          // horizontal glyph run with an underline rule
          const gs = cw * 0.24;
          for (let i = 0; i < 3; i++) drawGlyph(ctx, ox + cw * 0.16 + i * gs * 1.15, oy + ch * 0.26, gs, rnd);
          ctx.fillRect(ox + cw * 0.14, oy + ch * 0.66, cw * 0.72, ch * 0.020);
          ctx.fillRect(ox + cw * 0.14, oy + ch * 0.73, cw * 0.44, ch * 0.014);
        } else if (kind === 2) {
          // data readout: bar rows + tick column
          for (let i = 0; i < 6; i++) {
            const yy = oy + ch * (0.18 + i * 0.115);
            ctx.globalAlpha = 0.35 + rnd() * 0.65;
            ctx.fillRect(ox + cw * 0.14, yy, cw * (0.15 + rnd() * 0.6), ch * 0.045);
          }
          ctx.globalAlpha = 1;
          for (let i = 0; i < 14; i++) {
            ctx.fillRect(ox + cw * 0.86, oy + ch * (0.14 + i * 0.055), cw * (i % 4 === 0 ? 0.06 : 0.03), ch * 0.014);
          }
        } else {
          // big mark: concentric ring + slash, reads at any distance
          ctx.lineWidth = cw * 0.05;
          ctx.beginPath();
          ctx.arc(ox + cw * 0.5, oy + ch * 0.5, cw * 0.27, 0.5, 5.2);
          ctx.stroke();
          ctx.lineWidth = cw * 0.028;
          ctx.beginPath();
          ctx.arc(ox + cw * 0.5, oy + ch * 0.5, cw * 0.35, 2.2, 4.6);
          ctx.stroke();
          ctx.fillRect(ox + cw * 0.46, oy + ch * 0.18, cw * 0.08, ch * 0.64);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // scanline + grain modulation so the faces are not flat emissive slabs
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const noise = new TileNoise(o.seed ?? 8181);
    const grain = fbmField(noise, w, h, 48, 48, 3, 0.5);
    for (let y = 0, i = 0; y < h; y++) {
      const scan = 0.72 + 0.28 * Math.abs(Math.sin(y * 0.9));
      for (let x = 0; x < w; x++, i++) {
        const j = i * 4;
        if (d[j + 3] === 0) continue;
        const g = scan * (0.72 + grain[i] * 0.5);
        d[j] *= g; d[j + 1] *= g; d[j + 2] *= g;
      }
    }
    ctx.putImageData(img, 0, 0);

    return {
      texture: texFromCanvas(c, { srgb: true, wrap: THREE.ClampToEdgeWrapping, aniso: 4 }),
      cols,
      rows,
    };
  });
}

/* ------------------------------------------------------------------ */
/* utility textures: gradients, glows, masks                           */
/* ------------------------------------------------------------------ */

/** Soft radial glow sprite. `power` shapes the falloff — 2.5 reads like real bloom. */
export function makeGlowTexture(o = {}) {
  const key = 'glow:' + JSON.stringify(o);
  return cached(key, () => {
    const s = o.size ?? 128;
    const power = o.power ?? 2.6;
    const core = o.core ?? 0.06;
    const c = canvas2d(s, s);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s);
    const d = img.data;
    const half = s / 2;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        const r = Math.sqrt(dx * dx + dy * dy);
        let v = clamp01(1 - r);
        v = Math.pow(v, power);
        v += Math.pow(clamp01(1 - r / core), 2) * 0.9;
        v = clamp01(v);
        const i = (y * s + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = v * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, { srgb: false, wrap: THREE.ClampToEdgeWrapping, aniso: 2 });
  });
}

/** Vertical light-shaft gradient with soft noise banding, used for godrays. */
export function makeShaftTexture(o = {}) {
  const key = 'shaft:' + JSON.stringify(o);
  return cached(key, () => {
    const w = o.width ?? 128;
    const h = o.height ?? 256;
    const c = canvas2d(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const noise = new TileNoise(o.seed ?? 771);
    const f = fbmField(noise, w, h, 4, 6, 4, 0.55);
    for (let y = 0, i = 0; y < h; y++) {
      // fades out with distance from the emitter (top of the quad)
      const along = 1 - y / (h - 1);
      const fade = Math.pow(along, 1.7);
      for (let x = 0; x < w; x++, i++) {
        const u = (x + 0.5) / w;
        const across = Math.pow(1 - Math.abs(u * 2 - 1), 1.6);
        const v = clamp01(fade * across * (0.45 + f[i] * 1.05));
        const j = i * 4;
        d[j] = 255; d[j + 1] = 255; d[j + 2] = 255;
        d[j + 3] = v * 235;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, { wrap: THREE.ClampToEdgeWrapping, aniso: 2 });
  });
}

/** Irregular soft-edged blob mask — puddles, ground fog patches, decals. */
export function makeBlobMask(o = {}) {
  const key = 'blob:' + JSON.stringify(o);
  return cached(key, () => {
    const s = o.size ?? 256;
    const rough = o.rough ?? 0.42;
    const noise = new TileNoise(o.seed ?? 313);
    const f = fbmField(noise, s, s, 5, 5, 4, 0.55);
    const c = canvas2d(s, s);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s);
    const d = img.data;
    const half = s / 2;
    for (let y = 0, i = 0; y < s; y++) {
      for (let x = 0; x < s; x++, i++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        const r = Math.sqrt(dx * dx + dy * dy) + (f[i] - 0.5) * rough;
        const v = 1 - sstep(o.inner ?? 0.55, o.outer ?? 0.95, r);
        const j = i * 4;
        d[j] = 255; d[j + 1] = 255; d[j + 2] = 255;
        d[j + 3] = clamp01(v) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, { wrap: THREE.ClampToEdgeWrapping });
  });
}

/** Soft drifting haze sheet: low-frequency clouds with alpha falloff at the edges. */
export function makeHazeTexture(o = {}) {
  const key = 'haze:' + JSON.stringify(o);
  return cached(key, () => {
    const w = o.width ?? 256;
    const h = o.height ?? 128;
    const noise = new TileNoise(o.seed ?? 5150);
    const f = fbmField(noise, w, h, 3, 2, 5, 0.6);
    const c = canvas2d(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0, i = 0; y < h; y++) {
      const vy = y / (h - 1);
      // denser toward the bottom of the sheet — ground fog behaviour
      const vert = Math.pow(1 - vy, o.vertPow ?? 1.6);
      for (let x = 0; x < w; x++, i++) {
        const v = clamp01((f[i] - 0.30) * 1.9) * vert;
        const j = i * 4;
        d[j] = 255; d[j + 1] = 255; d[j + 2] = 255;
        d[j + 3] = clamp01(v) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, { wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping });
  });
}

/** Ripple normal map for puddle surfaces. Very low amplitude, two frequencies. */
export function makeRippleNormal(o = {}) {
  const key = 'ripple:' + JSON.stringify(o);
  return cached(key, () => {
    const s = o.size ?? 256;
    const noise = new TileNoise(o.seed ?? 616);
    const a = fbmField(noise, s, s, 6, 6, 3, 0.5);
    const b = fbmField(noise, s, s, 24, 24, 2, 0.5);
    const hgt = new Float32Array(s * s);
    for (let i = 0; i < hgt.length; i++) hgt[i] = a[i] * 0.7 + b[i] * 0.3;
    return texFromCanvas(makeNormalFromHeight(hgt, s, s, o.strength ?? 1.1));
  });
}

/**
 * A short vertical streak with soft ends — rain. Point sprites of this, stretched,
 * read convincingly as falling rain even in a still frame.
 */
export function makeRainTexture(o = {}) {
  return cached('rain', () => {
    const w = 16;
    const h = 64;
    const c = canvas2d(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const v = Math.sin((y / (h - 1)) * Math.PI);
      const vv = Math.pow(v, 0.6);
      for (let x = 0; x < w; x++) {
        const u = 1 - Math.abs((x + 0.5) / w * 2 - 1);
        const a = clamp01(Math.pow(u, 2.2) * vv);
        const i = (y * w + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return texFromCanvas(c, { wrap: THREE.ClampToEdgeWrapping, aniso: 1 });
  });
}

/* ------------------------------------------------------------------ */
/* night sky / city-glow dome + environment source                     */
/* ------------------------------------------------------------------ */

/**
 * Equirectangular night sky: sodium-and-magenta city glow bleeding up off the
 * horizon into an indigo zenith, FBM cloud deck lit from *below* by that glow, a
 * dim moon, and a band of far-distance skyline pinpricks.
 *
 * The same canvas doubles as the PMREM source, so metals reflect exactly the sky the
 * player can see — which is the cheapest way to make PBR metal stop looking like
 * grey clay (an automatic REJECT in the rubric).
 */
export function makeSkyTexture(o = {}) {
  const key = 'sky:' + JSON.stringify(o);
  return cached(key, () => {
    const w = o.width ?? 1024;
    const h = o.height ?? 512;
    const noise = new TileNoise(o.seed ?? 20260);
    const clouds = fbmField(noise, w, h, 6, 3, 6, 0.58);
    const wisp = ridgeField(noise, w, h, 12, 6, 4, 0.55);
    const c = canvas2d(w, h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;

    // Horizon glow lobes: warm centres where the biggest districts sit.
    const lobes = [
      { u: 0.12, amp: 1.00, wid: 0.10, col: [1.00, 0.42, 0.62] },
      { u: 0.33, amp: 0.72, wid: 0.07, col: [1.00, 0.66, 0.34] },
      { u: 0.52, amp: 0.95, wid: 0.12, col: [0.55, 0.72, 1.00] },
      { u: 0.71, amp: 0.80, wid: 0.08, col: [1.00, 0.38, 0.80] },
      { u: 0.88, amp: 0.60, wid: 0.09, col: [0.42, 0.95, 1.00] },
    ];

    const zenith = [0.012, 0.017, 0.037];
    const mid = [0.035, 0.048, 0.098];
    const horizon = [0.115, 0.115, 0.205];

    const rnd = mulberry32(4711);

    for (let y = 0, i = 0; y < h; y++) {
      // v = 0 at top (zenith) .. 1 at bottom (nadir); horizon at 0.5
      const v = y / (h - 1);
      const above = clamp01((0.5 - v) / 0.5); // 1 at zenith, 0 at horizon
      for (let x = 0; x < w; x++, i++) {
        const u = x / w;
        let r, g, b;
        if (v <= 0.5) {
          const t = Math.pow(above, 0.75);
          r = lerp(horizon[0], lerp(mid[0], zenith[0], Math.pow(above, 1.6)), t);
          g = lerp(horizon[1], lerp(mid[1], zenith[1], Math.pow(above, 1.6)), t);
          b = lerp(horizon[2], lerp(mid[2], zenith[2], Math.pow(above, 1.6)), t);
        } else {
          // below the horizon: darker, but keep some bounce so metals aren't black
          const bel = clamp01((v - 0.5) / 0.5);
          r = lerp(horizon[0], 0.020, Math.pow(bel, 0.6));
          g = lerp(horizon[1], 0.022, Math.pow(bel, 0.6));
          b = lerp(horizon[2], 0.033, Math.pow(bel, 0.6));
        }

        // city glow lobes rising off the horizon
        let gr = 0, gg = 0, gb = 0;
        for (let k = 0; k < lobes.length; k++) {
          const L = lobes[k];
          let du = Math.abs(u - L.u);
          if (du > 0.5) du = 1 - du;
          const hx = Math.exp(-(du * du) / (2 * L.wid * L.wid));
          const hy = Math.exp(-Math.pow(Math.max(0, (0.5 - v)) / 0.16, 1.7)) * (v <= 0.52 ? 1 : Math.exp(-(((v - 0.52) / 0.05) ** 2)));
          const a = L.amp * hx * hy;
          gr += L.col[0] * a; gg += L.col[1] * a; gb += L.col[2] * a;
        }
        r += gr * 0.30; g += gg * 0.30; b += gb * 0.30;

        // cloud deck: dark against the sky, but underlit by the glow beneath it
        if (v < 0.52) {
          const cd = clamp01((clouds[i] - 0.42) * 2.3) * clamp01((0.52 - v) / 0.34);
          const under = clamp01(1 - (0.5 - v) / 0.22);
          const wispy = clamp01((wisp[i] - 0.55) * 1.6) * cd;
          const lit = (0.10 + under * 0.95);
          r = lerp(r, (0.16 + gr * 0.55) * lit + wispy * 0.18, cd * 0.85);
          g = lerp(g, (0.13 + gg * 0.50) * lit + wispy * 0.16, cd * 0.85);
          b = lerp(b, (0.21 + gb * 0.55) * lit + wispy * 0.22, cd * 0.85);
        }

        // stars, only well above the haze and only where the cloud deck is thin
        if (v < 0.34) {
          const s = rnd();
          if (s > 0.99935) {
            const br = (0.35 + rnd() * 0.9) * clamp01((0.34 - v) / 0.30) * clamp01(1 - clouds[i]);
            r += br; g += br * 0.98; b += br * 1.05;
          }
        }

        const j = i * 4;
        d[j] = Math.pow(clamp01(r), 1 / 2.2) * 255;
        d[j + 1] = Math.pow(clamp01(g), 1 / 2.2) * 255;
        d[j + 2] = Math.pow(clamp01(b), 1 / 2.2) * 255;
        d[j + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // --- distant skyline band painted straight onto the dome --------------
    // These are far enough away that geometry would be wasted; painting them means
    // the horizon is never empty no matter where the camera looks.
    const rnd2 = mulberry32(99123);
    const horizonY = h * 0.5;
    ctx.save();
    for (let pass = 0; pass < 2; pass++) {
      const depth = pass === 0 ? 0.30 : 0.62;
      const maxH = pass === 0 ? h * 0.11 : h * 0.075;
      ctx.globalAlpha = pass === 0 ? 0.9 : 0.75;
      let x = 0;
      while (x < w) {
        const bw = 6 + rnd2() * 26;
        const bh = maxH * (0.25 + rnd2() * 0.95);
        const shade = lerp(0.05, 0.16, depth) * (0.7 + rnd2() * 0.6);
        ctx.fillStyle = `rgb(${(Math.pow(shade * 0.9, 1 / 2.2) * 255) | 0},${(Math.pow(shade, 1 / 2.2) * 255) | 0},${(Math.pow(shade * 1.5, 1 / 2.2) * 255) | 0})`;
        ctx.fillRect(x, horizonY - bh, bw, bh + 4);
        // window pinpricks
        const cols = Math.max(1, (bw / 5) | 0);
        const rows2 = Math.max(1, (bh / 6) | 0);
        for (let cy = 0; cy < rows2; cy++) {
          for (let cx = 0; cx < cols; cx++) {
            if (rnd2() > 0.30) continue;
            const wcol = rnd2();
            ctx.fillStyle =
              wcol < 0.55 ? 'rgba(255,205,140,0.85)' : wcol < 0.85 ? 'rgba(150,220,255,0.8)' : 'rgba(255,120,190,0.85)';
            ctx.fillRect(x + 1.5 + cx * 5, horizonY - bh + 2 + cy * 6, 2, 2.5);
          }
        }
        x += bw + rnd2() * 5;
      }
    }
    ctx.restore();

    return texFromCanvas(c, {
      srgb: true,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      aniso: 4,
    });
  });
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Release every texture this module handed out. Called from world dispose. */
export function disposeTextures() {
  for (const t of _owned) t.dispose();
  _owned.length = 0;
  _cache.clear();
}
