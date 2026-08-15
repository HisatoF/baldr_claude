import * as THREE from 'three';

/**
 * A procedurally built colour-grading LUT.
 *
 * The grade is baked into a 32³ cube stored as a horizontally tiled 2-D strip
 * (32 slices of 32×32 → a 1024×32 RGBA texture). A tiled strip rather than a
 * `Data3DTexture` keeps the shader on GLSL1 — no `sampler3D`, no version pinning
 * — and the extra tap costs nothing next to the bloom chain.
 *
 * Everything the grade does — CDL, log-space contrast, split toning, chroma-aware
 * saturation, black crush — is evaluated *once* per node here on the CPU, so the
 * fragment shader pays for two texture fetches and a lerp instead of thirty ALU
 * ops per pixel.
 *
 * Input to the LUT is display-referred sRGB (i.e. post tone-map). Output is the
 * graded sRGB value, ready for the framebuffer.
 */

export const LUT_SIZE = 32;

/** The look. Tweak here; everything downstream is derived. */
export const GRADE = {
  // ASC-CDL, applied in linear: out = (in * slope + offset)^power
  slope: [1.045, 1.0, 0.955],
  offset: [-0.006, -0.002, 0.009],
  power: [1.015, 1.0, 0.978],

  // Filmic contrast about an 18% grey pivot, applied in log2 space.
  contrast: 1.16,
  pivot: 0.18,

  // Split toning. Shadows go cold gunmetal, highlights go slightly warm.
  shadowTint: [0.80, 0.92, 1.16],
  shadowAmount: 0.55,
  highTint: [1.09, 1.015, 0.895],
  highAmount: 0.42,

  // Saturation: base lift, extra for already-chromatic pixels (keeps neon neon
  // through the ACES highlight desaturation), and a pull-down in deep shadow so
  // dark areas read as gunmetal rather than as tinted mud.
  saturation: 1.08,
  chromaBoost: 0.30,
  shadowDesat: 0.78,

  // Crushed blacks: lift the black point off zero, then subtract it back out so
  // the toe genuinely clips instead of just going dim.
  blackPoint: 0.022,
  toe: 0.55,

  // Final highlight rolloff so bloom cores do not clip to flat white paper.
  shoulder: 0.94,
};

const LUM = [0.2126, 0.7152, 0.0722];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const rgb = [0, 0, 0];

/** Evaluate the grade for one display-referred sRGB triplet, in place. */
function gradeNode(r, g, b, out) {
  const G = GRADE;

  // 1. to linear
  let lr = srgbToLinear(r);
  let lg = srgbToLinear(g);
  let lb = srgbToLinear(b);

  // 2. ASC CDL
  lr = Math.pow(Math.max(lr * G.slope[0] + G.offset[0], 0), G.power[0]);
  lg = Math.pow(Math.max(lg * G.slope[1] + G.offset[1], 0), G.power[1]);
  lb = Math.pow(Math.max(lb * G.slope[2] + G.offset[2], 0), G.power[2]);

  // 3. contrast about the grey pivot, in log space (filmic, does not clip)
  const cLog = (v) => {
    const l = Math.log2(Math.max(v, 1e-5) / G.pivot) * G.contrast;
    return G.pivot * Math.pow(2, l);
  };
  lr = cLog(lr);
  lg = cLog(lg);
  lb = cLog(lb);

  // 4. split toning
  const lum = lr * LUM[0] + lg * LUM[1] + lb * LUM[2];
  const sw = (1 - smoothstep(0.0, 0.34, lum)) * G.shadowAmount;
  const hw = smoothstep(0.30, 1.05, lum) * G.highAmount;
  lr = lr * (1 + sw * (G.shadowTint[0] - 1)) * (1 + hw * (G.highTint[0] - 1));
  lg = lg * (1 + sw * (G.shadowTint[1] - 1)) * (1 + hw * (G.highTint[1] - 1));
  lb = lb * (1 + sw * (G.shadowTint[2] - 1)) * (1 + hw * (G.highTint[2] - 1));

  // 5. chroma-aware saturation
  const lum2 = lr * LUM[0] + lg * LUM[1] + lb * LUM[2];
  const mx = Math.max(lr, lg, lb);
  const mn = Math.min(lr, lg, lb);
  const chroma = mx > 1e-4 ? (mx - mn) / mx : 0;
  let sat = G.saturation + chroma * G.chromaBoost;
  sat *= 1 - (1 - G.shadowDesat) * (1 - smoothstep(0.0, 0.16, lum2));
  lr = lum2 + (lr - lum2) * sat;
  lg = lum2 + (lg - lum2) * sat;
  lb = lum2 + (lb - lum2) * sat;

  // 6. back to display space, then crush the toe and roll the shoulder
  let dr = linearToSrgb(Math.max(lr, 0));
  let dg = linearToSrgb(Math.max(lg, 0));
  let db = linearToSrgb(Math.max(lb, 0));

  const crush = (v) => {
    const k = Math.max(v - GRADE.blackPoint, 0) / (1 - GRADE.blackPoint);
    // extra toe steepening below ~15% so blacks genuinely go black
    const t = k * (GRADE.toe + (1 - GRADE.toe) * smoothstep(0.0, 0.18, k));
    return clamp01(t * GRADE.shoulder + (1 - GRADE.shoulder) * t * t);
  };
  dr = crush(dr);
  dg = crush(dg);
  db = crush(db);

  out[0] = dr;
  out[1] = dg;
  out[2] = db;
  return out;
}

/**
 * Build the tiled LUT texture. Slice index (blue) advances along X.
 * Layout: x = sliceB * 32 + r, y = g.
 * @returns {THREE.DataTexture}
 */
export function makeGradeLut(size = LUT_SIZE) {
  const w = size * size;
  const h = size;
  const data = new Uint8Array(w * h * 4);
  const inv = 1 / (size - 1);

  for (let bz = 0; bz < size; bz++) {
    const b = bz * inv;
    for (let y = 0; y < size; y++) {
      const g = y * inv;
      for (let x = 0; x < size; x++) {
        const r = x * inv;
        gradeNode(r, g, b, rgb);
        const i = (y * w + bz * size + x) * 4;
        data[i + 0] = Math.round(clamp01(rgb[0]) * 255);
        data[i + 1] = Math.round(clamp01(rgb[1]) * 255);
        data[i + 2] = Math.round(clamp01(rgb[2]) * 255);
        data[i + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'post.gradeLut';
  return tex;
}

/**
 * GLSL for sampling the tiled LUT. Shared by any pass that wants the grade.
 * Uses explicit half-texel insets so the linear filter never bleeds between
 * adjacent blue slices — the classic tiled-LUT seam artefact.
 */
export const LUT_GLSL = /* glsl */ `
  uniform sampler2D tLut;
  uniform float uLutIntensity;
  const float LUT_N = ${LUT_SIZE.toFixed(1)};

  vec3 sampleLut(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    float bScaled = c.b * (LUT_N - 1.0);
    float b0 = floor(bScaled);
    float b1 = min(b0 + 1.0, LUT_N - 1.0);
    float bf = bScaled - b0;

    float xin = (c.r * (LUT_N - 1.0) + 0.5) / (LUT_N * LUT_N);
    float y   = (c.g * (LUT_N - 1.0) + 0.5) / LUT_N;

    vec3 s0 = texture2D(tLut, vec2(b0 / LUT_N + xin, y)).rgb;
    vec3 s1 = texture2D(tLut, vec2(b1 / LUT_N + xin, y)).rgb;
    return mix(s0, s1, bf);
  }
`;
