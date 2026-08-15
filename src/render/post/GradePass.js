import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { LUT_GLSL } from './Lut.js';

/**
 * Tone map + colour grade + lens/sensor finish.
 *
 * This is where the HDR scene becomes a displayable image, so it owns every step
 * that must happen in a specific colour space:
 *
 *   HDR linear → exposure → ACES filmic → sRGB encode → 3-D LUT grade →
 *   vignette → scanline → grain → ordered dither → framebuffer
 *
 * Tone mapping is done here rather than by the renderer because the renderer only
 * applies it when drawing straight to the canvas, and everything upstream of this
 * pass renders into half-float targets. Doing it here also means bloom, motion
 * blur and chromatic aberration all operate on genuine HDR values, which is why
 * an emissive strip smears as a bright streak instead of a grey one.
 *
 * The grade itself lives in a procedurally baked LUT (see `Lut.js`) so the
 * per-pixel cost is two texture fetches, not thirty ALU ops.
 */

const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    tLut: { value: null },
    tNoise: { value: null },

    uExposure: { value: 1.0 },
    uLutIntensity: { value: 1.0 },

    uVignette: { value: 0.62 },
    uVignetteTint: { value: new THREE.Color(0x0a1420) },

    uGrain: { value: 0.035 },
    uScanline: { value: 0.030 },
    uScanCount: { value: 900.0 },

    uImpactFlash: { value: 0.0 },
    uFlashTint: { value: new THREE.Color(0xd9f2ff) },

    uNoiseScale: { value: new THREE.Vector2(1, 1) },
    uNoiseOffset: { value: new THREE.Vector2(0, 0) },
    uTime: { value: 0 },
    uAspect: { value: 16 / 9 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;

    uniform sampler2D tDiffuse;
    uniform sampler2D tNoise;
    uniform float uExposure;
    uniform float uVignette;
    uniform vec3  uVignetteTint;
    uniform float uGrain;
    uniform float uScanline;
    uniform float uScanCount;
    uniform float uImpactFlash;
    uniform vec3  uFlashTint;
    uniform vec2  uNoiseScale;
    uniform vec2  uNoiseOffset;
    uniform float uTime;
    uniform float uAspect;

    ${LUT_GLSL}

    // --- ACES filmic (Stephen Hill's RRT+ODT fit, same as three's) -----------
    const mat3 ACESInput = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 ACESOutput = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602
    );
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 acesFilmic(vec3 color) {
      color *= uExposure / 0.6;
      color = ACESInput * color;
      color = RRTAndODTFit(color);
      color = ACESOutput * color;
      return clamp(color, 0.0, 1.0);
    }

    vec3 linearToSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(0.41666)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    void main() {
      vec3 hdr = texture2D(tDiffuse, vUv).rgb;
      hdr = max(hdr, vec3(0.0));

      // Impact flash lives in HDR so it blooms through the tone curve naturally
      // rather than pasting a flat white rectangle over the frame.
      hdr += uFlashTint * uImpactFlash * (1.6 + 2.2 * uImpactFlash);

      vec3 col = acesFilmic(hdr);
      col = linearToSrgb(col);

      // --- grade --------------------------------------------------------
      vec3 graded = sampleLut(col);
      col = mix(col, graded, uLutIntensity);

      // --- vignette: cool, soft, never a black ring ----------------------
      vec2 vd = (vUv - 0.5) * vec2(uAspect * 0.62 + 0.38, 1.0);
      float vr = length(vd) * 1.32;
      float vig = smoothstep(0.42, 1.06, vr);
      col = mix(col, uVignetteTint * (0.25 + 0.75 * col), vig * uVignette);

      // --- scanline: a slow-drifting soft comb, plus one rolling band -----
      float sl = sin((vUv.y + uTime * 0.013) * uScanCount * 3.14159265);
      col *= 1.0 - uScanline * (0.5 + 0.5 * sl);
      float roll = smoothstep(0.0, 0.18, fract(vUv.y * 0.5 - uTime * 0.07));
      col *= 1.0 + uScanline * 0.35 * (1.0 - roll);

      // --- grain: modulated down in highlights, coloured very slightly ----
      vec4 n = texture2D(tNoise, vUv * uNoiseScale + uNoiseOffset);
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float grainAmt = uGrain * mix(1.0, 0.28, luma);
      col += (vec3(n.r, mix(n.r, n.g, 0.6), n.g) - 0.5) * grainAmt;

      // --- ordered dither, kills 8-bit banding in the dark gradients ------
      col += (n.a - 0.5) * (1.5 / 255.0);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export class GradePass extends ShaderPass {
  /**
   * @param {THREE.Texture} lut   tiled grading LUT
   * @param {THREE.Texture} noise 4-channel noise tile
   */
  constructor(lut, noise) {
    super(GradeShader);
    this.material.toneMapped = false;
    this.uniforms.tLut.value = lut;
    this.uniforms.tNoise.value = noise;
    this._noiseSize = noise?.image?.width ?? 256;
  }

  setSize(width, height) {
    this.uniforms.uNoiseScale.value.set(width / this._noiseSize, height / this._noiseSize);
    this.uniforms.uScanCount.value = height * 0.5;
    this.uniforms.uAspect.value = width / Math.max(height, 1);
  }
}

export { GradeShader };
