import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Velocity-driven motion blur.
 *
 * A full per-pixel velocity buffer is not worth its cost for a game whose motion
 * is overwhelmingly *camera* motion plus a handful of very fast actors, so this
 * is the cheap-and-loud version: a combined **directional** streak (from camera
 * velocity projected into screen space) and **radial** streak (from the dash
 * intensity), both weighted by distance from the screen centre so the mech stays
 * sharp while the world tears past it.
 *
 * Two details do most of the work:
 *  - Taps are jittered per-pixel from the golden-ratio noise channel, so eight
 *    taps read as a continuous smear rather than eight discrete ghosts.
 *  - Tap weights follow a triangular kernel biased toward the current position,
 *    which is what a real shutter integrates to, and keeps the leading edge of a
 *    dashing object crisp instead of symmetrical mush.
 */

const MotionBlurShader = {
  name: 'MotionBlurShader',

  uniforms: {
    tDiffuse: { value: null },
    tNoise: { value: null },
    uVelocity: { value: new THREE.Vector2(0, 0) }, // screen-space, uv units
    uRadial: { value: 0.0 }, // 0..1 radial zoom-streak amount
    uDash: { value: 0.0 }, // 0..1 dash intensity
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uNoiseScale: { value: new THREE.Vector2(1, 1) },
    uJitter: { value: new THREE.Vector2(0, 0) },
    uAmount: { value: 1.0 }, // global master, 0 disables
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
    #ifndef MB_TAPS
      #define MB_TAPS 10
    #endif

    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tNoise;
    uniform vec2  uVelocity;
    uniform float uRadial;
    uniform float uDash;
    uniform vec2  uCenter;
    uniform vec2  uNoiseScale;
    uniform vec2  uJitter;
    uniform float uAmount;

    void main() {
      vec2 toCentre = vUv - uCenter;
      float r = length(toCentre);

      // The centre of the frame is where the player is; keep it readable.
      float edge = smoothstep(0.06, 0.62, r);

      // uDash is a 0..1 intensity, so its coefficient IS the streak length in uv at
      // the frame edge. At 1.15 a routine dash produced radialAmt ~0.2, smearing
      // roughly 160px and destroying the entire image; the dash channel drowned out
      // every other term. Keep it in the same order of magnitude as uRadial.
      float radialAmt = (uRadial + uDash * 0.09) * edge * uAmount;
      vec2  dirAmt    = uVelocity * (0.35 + 0.65 * edge) * uAmount;

      float mag = radialAmt * r + length(dirAmt);
      if (mag < 0.0012) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      float jitter = texture2D(tNoise, vUv * uNoiseScale + uJitter).b;

      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < MB_TAPS; i++) {
        float f = (float(i) + jitter) / float(MB_TAPS);   // 0..1
        // Triangular shutter weight, biased so the un-blurred sample dominates.
        float w = 1.0 - f * 0.82;
        w *= w;

        vec2 uv = uCenter + toCentre * (1.0 - radialAmt * f) - dirAmt * f;
        sum += texture2D(tDiffuse, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb * w;
        wsum += w;
      }

      gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
    }
  `,
};

export class MotionBlurPass extends ShaderPass {
  constructor(noiseTexture, taps = 10) {
    super(MotionBlurShader);
    this.material.toneMapped = false;
    this.material.defines = { MB_TAPS: taps };
    this.uniforms.tNoise.value = noiseTexture;
    this._noiseSize = noiseTexture?.image?.width ?? 256;
    this._taps = taps;
  }

  set taps(v) {
    if (v === this._taps) return;
    this._taps = v;
    this.material.defines.MB_TAPS = v;
    this.material.needsUpdate = true;
  }
  get taps() {
    return this._taps;
  }

  setSize(width, height) {
    this.uniforms.uNoiseScale.value.set(width / this._noiseSize, height / this._noiseSize);
  }
}
