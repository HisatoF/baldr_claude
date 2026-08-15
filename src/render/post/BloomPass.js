import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Physically-motivated multi-mip bloom.
 *
 * This is the single most important pass for the neon look, so it is hand-written
 * rather than borrowed from UnrealBloomPass:
 *
 *  1. **Prefilter** — soft-knee threshold in *scene* units (the scene is rendered
 *     to a half-float target, so an emissive at intensity 6 really is 6.0). The
 *     knee is quadratic, so a surface sitting just under the threshold fades in
 *     instead of popping. A Karis luma-weighted average over the first 13-tap
 *     downsample kills single-pixel fireflies, which are what make cheap bloom
 *     sparkle and crawl.
 *
 *  2. **Downsample chain** — the 13-tap partial-box filter from the Call of Duty
 *     "Next Generation Post Processing" talk. Six mips at 1600×900 means the
 *     coarsest is ~25×14, i.e. the glow genuinely reaches across the screen.
 *
 *  3. **Upsample chain** — 9-tap tent filter, additively accumulated back down
 *     the pyramid. Progressive accumulation is what makes the falloff read as a
 *     smooth 1/r² haze instead of a hard halo ring: every octave contributes.
 *
 *  4. **Composite** — additive, tinted very slightly cool so that saturated
 *     magenta and cyan emissives bloom *in their own hue* rather than washing to
 *     white paper.
 *
 * The tent offsets are stretched horizontally (`stretch`), which gives the
 * subtle anamorphic widening that reads as "lens" rather than "gaussian blur".
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const PREFILTER_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;      // 1 / source resolution
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uClamp;

  float karisWeight(vec3 c) {
    // Weight by inverse luma so one blown-out pixel cannot dominate the average.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return 1.0 / (1.0 + l);
  }

  vec3 fetch(vec2 uv) {
    vec3 c = texture2D(tDiffuse, uv).rgb;
    // Guard against NaN/Inf leaking out of the HDR buffer.
    c = max(c, vec3(0.0));
    return min(c, vec3(uClamp));
  }

  void main() {
    vec2 tx = uTexel;
    // 13-tap sample pattern (COD): 4 inner, 9 outer.
    vec3 a = fetch(vUv + tx * vec2(-2.0, -2.0));
    vec3 b = fetch(vUv + tx * vec2( 0.0, -2.0));
    vec3 c = fetch(vUv + tx * vec2( 2.0, -2.0));
    vec3 d = fetch(vUv + tx * vec2(-1.0, -1.0));
    vec3 e = fetch(vUv + tx * vec2( 1.0, -1.0));
    vec3 f = fetch(vUv + tx * vec2(-2.0,  0.0));
    vec3 g = fetch(vUv);
    vec3 h = fetch(vUv + tx * vec2( 2.0,  0.0));
    vec3 i = fetch(vUv + tx * vec2(-1.0,  1.0));
    vec3 j = fetch(vUv + tx * vec2( 1.0,  1.0));
    vec3 k = fetch(vUv + tx * vec2(-2.0,  2.0));
    vec3 l = fetch(vUv + tx * vec2( 0.0,  2.0));
    vec3 m = fetch(vUv + tx * vec2( 2.0,  2.0));

    // Karis-averaged partial boxes.
    vec3 g0 = (d + e + i + j) * 0.25;
    vec3 g1 = (a + b + g + f) * 0.25;
    vec3 g2 = (b + c + h + g) * 0.25;
    vec3 g3 = (f + g + l + k) * 0.25;
    vec3 g4 = (g + h + m + l) * 0.25;
    float w0 = karisWeight(g0) * 0.5;
    float w1 = karisWeight(g1) * 0.125;
    float w2 = karisWeight(g2) * 0.125;
    float w3 = karisWeight(g3) * 0.125;
    float w4 = karisWeight(g4) * 0.125;
    float wsum = max(w0 + w1 + w2 + w3 + w4, 1e-5);
    vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / wsum;

    // Soft-knee threshold.
    float br = max(col.r, max(col.g, col.b));
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = (rq * rq) / (4.0 * uKnee + 1e-4);
    float weight = max(rq, br - uThreshold) / max(br, 1e-4);

    gl_FragColor = vec4(col * weight, 1.0);
  }
`;

const DOWN_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;

  void main() {
    vec2 tx = uTexel;
    vec3 a = texture2D(tDiffuse, vUv + tx * vec2(-2.0, -2.0)).rgb;
    vec3 b = texture2D(tDiffuse, vUv + tx * vec2( 0.0, -2.0)).rgb;
    vec3 c = texture2D(tDiffuse, vUv + tx * vec2( 2.0, -2.0)).rgb;
    vec3 d = texture2D(tDiffuse, vUv + tx * vec2(-1.0, -1.0)).rgb;
    vec3 e = texture2D(tDiffuse, vUv + tx * vec2( 1.0, -1.0)).rgb;
    vec3 f = texture2D(tDiffuse, vUv + tx * vec2(-2.0,  0.0)).rgb;
    vec3 g = texture2D(tDiffuse, vUv).rgb;
    vec3 h = texture2D(tDiffuse, vUv + tx * vec2( 2.0,  0.0)).rgb;
    vec3 i = texture2D(tDiffuse, vUv + tx * vec2(-1.0,  1.0)).rgb;
    vec3 j = texture2D(tDiffuse, vUv + tx * vec2( 1.0,  1.0)).rgb;
    vec3 k = texture2D(tDiffuse, vUv + tx * vec2(-2.0,  2.0)).rgb;
    vec3 l = texture2D(tDiffuse, vUv + tx * vec2( 0.0,  2.0)).rgb;
    vec3 m = texture2D(tDiffuse, vUv + tx * vec2( 2.0,  2.0)).rgb;

    vec3 col = (d + e + i + j) * 0.125;
    col += (a + b + g + f) * 0.03125;
    col += (b + c + h + g) * 0.03125;
    col += (f + g + l + k) * 0.03125;
    col += (g + h + m + l) * 0.03125;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const UP_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;
  uniform float uRadius;
  uniform float uStretch;   // >1 widens the tent horizontally (anamorphic feel)

  void main() {
    vec2 o = uTexel * uRadius * vec2(uStretch, 1.0);
    vec3 col  = texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb * 1.0;
    col += texture2D(tDiffuse, vUv + vec2( 0.0,  o.y)).rgb * 2.0;
    col += texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb * 1.0;
    col += texture2D(tDiffuse, vUv + vec2(-o.x,  0.0)).rgb * 2.0;
    col += texture2D(tDiffuse, vUv).rgb * 4.0;
    col += texture2D(tDiffuse, vUv + vec2( o.x,  0.0)).rgb * 2.0;
    col += texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb * 1.0;
    col += texture2D(tDiffuse, vUv + vec2( 0.0, -o.y)).rgb * 2.0;
    col += texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb * 1.0;
    gl_FragColor = vec4(col * (1.0 / 16.0), 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform float uStrength;
  uniform vec3  uTint;
  uniform float uDirt;     // subtle radial "lens" gain on the bloom, not a texture

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    vec2 d = vUv - 0.5;
    float gain = 1.0 + uDirt * dot(d, d) * 2.0;
    gl_FragColor = vec4(base + bloom * uStrength * gain * uTint, 1.0);
  }
`;

export class BloomPass extends Pass {
  constructor(opts = {}) {
    super();
    this.needsSwap = true;

    this.mipCount = opts.mips ?? 6;
    this._maxMips = 7;

    this._rts = [];
    this._sizes = [];
    for (let i = 0; i < this._maxMips; i++) {
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      rt.texture.name = `bloom.mip${i}`;
      this._rts.push(rt);
      this._sizes.push(new THREE.Vector2(1, 1));
    }

    const mk = (frag, uniforms) =>
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });

    this._matPrefilter = mk(PREFILTER_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: opts.threshold ?? 1.0 },
      uKnee: { value: opts.knee ?? 0.55 },
      uClamp: { value: opts.clamp ?? 48.0 },
    });
    this._matDown = mk(DOWN_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this._matUp = mk(UP_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: opts.radius ?? 1.0 },
      uStretch: { value: opts.stretch ?? 1.35 },
    });
    this._matUp.blending = THREE.AdditiveBlending;
    this._matUp.transparent = true;

    this._matComposite = mk(COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      uStrength: { value: opts.strength ?? 0.85 },
      uTint: { value: new THREE.Color(opts.tint ?? 0xdfeeff) },
      uDirt: { value: opts.dirt ?? 0.35 },
    });

    this._quad = new FullScreenQuad(this._matComposite);
  }

  // --- tunables --------------------------------------------------------------
  get strength() { return this._matComposite.uniforms.uStrength.value; }
  set strength(v) { this._matComposite.uniforms.uStrength.value = v; }
  get threshold() { return this._matPrefilter.uniforms.uThreshold.value; }
  set threshold(v) { this._matPrefilter.uniforms.uThreshold.value = v; }
  get radius() { return this._matUp.uniforms.uRadius.value; }
  set radius(v) { this._matUp.uniforms.uRadius.value = v; }
  get stretch() { return this._matUp.uniforms.uStretch.value; }
  set stretch(v) { this._matUp.uniforms.uStretch.value = v; }

  setSize(width, height) {
    this._width = width;
    this._height = height;
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    for (let i = 0; i < this._maxMips; i++) {
      this._rts[i].setSize(w, h);
      this._sizes[i].set(w, h);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    // Do not let the coarsest mip collapse below a few pixels — a 1×1 mip makes
    // the whole screen pulse with the average colour.
    this.activeMips = Math.min(this.mipCount, this._maxMips);
    for (let i = 0; i < this.activeMips; i++) {
      if (this._sizes[i].x < 4 || this._sizes[i].y < 4) {
        this.activeMips = Math.max(2, i);
        break;
      }
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    const oldTarget = renderer.getRenderTarget();
    renderer.autoClear = false;

    const n = this.activeMips ?? this.mipCount;

    // 1. prefilter full-res source into mip 0 (half res)
    this._matPrefilter.uniforms.tDiffuse.value = readBuffer.texture;
    this._matPrefilter.uniforms.uTexel.value.set(1 / this._width, 1 / this._height);
    this._quad.material = this._matPrefilter;
    renderer.setRenderTarget(this._rts[0]);
    this._quad.render(renderer); // full-screen write, no clear needed

    // 2. downsample chain
    this._quad.material = this._matDown;
    for (let i = 1; i < n; i++) {
      const src = this._sizes[i - 1];
      this._matDown.uniforms.tDiffuse.value = this._rts[i - 1].texture;
      this._matDown.uniforms.uTexel.value.set(1 / src.x, 1 / src.y);
      renderer.setRenderTarget(this._rts[i]);
      this._quad.render(renderer);
    }

    // 3. upsample + additive accumulate
    this._quad.material = this._matUp;
    for (let i = n - 1; i > 0; i--) {
      const src = this._sizes[i];
      this._matUp.uniforms.tDiffuse.value = this._rts[i].texture;
      this._matUp.uniforms.uTexel.value.set(1 / src.x, 1 / src.y);
      renderer.setRenderTarget(this._rts[i - 1]);
      this._quad.render(renderer); // additive, no clear
    }

    // 4. composite
    this._matComposite.uniforms.tDiffuse.value = readBuffer.texture;
    this._matComposite.uniforms.tBloom.value = this._rts[0].texture;
    this._quad.material = this._matComposite;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }
    this._quad.render(renderer);

    renderer.setRenderTarget(oldTarget);
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    for (const rt of this._rts) rt.dispose();
    this._matPrefilter.dispose();
    this._matDown.dispose();
    this._matUp.dispose();
    this._matComposite.dispose();
    this._quad.dispose();
  }
}
