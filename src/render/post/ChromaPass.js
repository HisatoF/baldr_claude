import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Radial chromatic aberration.
 *
 * Modelled on a real lens rather than the usual "shift R left, shift B right":
 * the displacement is radial and grows with r², so the centre of the frame is
 * physically clean and the corners fringe. On impacts `uImpact` scales the whole
 * thing up, which reads as the lens being punched.
 *
 * At high quality the sampling is spectral — five taps across the visible band,
 * recombined with per-tap RGB response weights — which produces the continuous
 * cyan→magenta fringe of a real lens instead of a two-colour halo.
 */

const ChromaShader = {
  name: 'ChromaShader',

  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0.0016 }, // base fringe, in uv units at the corner
    uImpact: { value: 0.0 }, // 0..1, punched up on hits
    uImpactScale: { value: 0.0016 },
    uBarrel: { value: 0.35 }, // extra edge falloff shaping
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
    uniform float uAmount;
    uniform float uImpact;
    uniform float uImpactScale;
    uniform float uBarrel;

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // Screen-centre is fully clean and the ramp starts further out, so the
      // player mech — which the camera keeps near the middle — never carries a
      // visible colour ghost on its edges. Fringing belongs at the corners.
      float edgeMask = smoothstep(0.20, 0.85, r2);
      float amt = (uAmount + uImpact * uImpactScale) * edgeMask * (0.18 + r2 * (2.4 + uBarrel * 2.0));
      vec2 off = d * amt * 8.0;

      #if defined(CA_SPECTRAL)
        // Five spectral taps: 0 = deep red end, 1 = deep blue end.
        vec3 acc = vec3(0.0);
        vec3 wsum = vec3(0.0);
        for (int i = 0; i < 5; i++) {
          float t = float(i) / 4.0;
          vec2 uv = vUv + off * (t - 0.5) * 2.0;
          vec3 s = texture2D(tDiffuse, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
          // Approximate RGB sensitivity of each spectral slice.
          vec3 w = vec3(
            smoothstep(0.75, 0.05, t),
            1.0 - abs(t - 0.5) * 1.7,
            smoothstep(0.25, 0.95, t)
          );
          w = max(w, vec3(0.0));
          acc += s * w;
          wsum += w;
        }
        gl_FragColor = vec4(acc / max(wsum, vec3(1e-4)), 1.0);
      #else
        vec3 c;
        c.r = texture2D(tDiffuse, clamp(vUv + off, vec2(0.001), vec2(0.999))).r;
        c.g = texture2D(tDiffuse, vUv).g;
        c.b = texture2D(tDiffuse, clamp(vUv - off, vec2(0.001), vec2(0.999))).b;
        gl_FragColor = vec4(c, 1.0);
      #endif
    }
  `,
};

export class ChromaPass extends ShaderPass {
  constructor(spectral = true) {
    super(ChromaShader);
    this.material.toneMapped = false;
    this.material.defines = {};
    this.spectral = spectral;
  }

  set spectral(v) {
    this._spectral = v;
    if (v) this.material.defines.CA_SPECTRAL = '';
    else delete this.material.defines.CA_SPECTRAL;
    this.material.needsUpdate = true;
  }
  get spectral() {
    return this._spectral;
  }
}

export { ChromaShader };
