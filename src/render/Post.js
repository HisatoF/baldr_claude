import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';

import { BloomPass } from './post/BloomPass.js';
import { MotionBlurPass } from './post/MotionBlurPass.js';
import { ChromaPass } from './post/ChromaPass.js';
import { GradePass } from './post/GradePass.js';
import { makeGradeLut } from './post/Lut.js';
import { makeNoiseTexture, hash01 } from './post/Noise.js';
import { PALETTE } from './Palette.js';
import { clamp01, damp } from '../core/MathUtil.js';

/**
 * The post-processing stack.
 *
 * Pass order (each stage feeds the next; the space each operates in matters):
 *
 *   0. RenderPass   — scene → half-float HDR target, linear, un-tone-mapped
 *   1. Bloom        — HDR. Multi-mip threshold bloom; the neon look lives here.
 *   2. Motion blur  — HDR. Camera-velocity + dash driven directional/radial streak.
 *   3. Chromatic ab.— HDR. Radial, r²-weighted, punched up on impacts.
 *   4. Grade        — HDR → display. ACES tone map, procedural 3-D LUT, vignette,
 *                     scanline, film grain, ordered dither.
 *   5. FXAA         — display space, last, where luma-based AA actually belongs.
 *
 * Everything a gameplay module might want to drive is exposed through the small
 * API at the bottom rather than by reaching into uniforms.
 */

const QUALITY = {
  high: {
    bloomMips: 6,
    bloomStrength: 0.52,
    bloomRadius: 1.15,
    bloomStretch: 1.15,
    bloomThreshold: 1.35,
    motionBlur: true,
    motionTaps: 12,
    motionAmount: 0.20,
    chroma: true,
    chromaSpectral: true,
    chromaAmount: 0.0007,
    grain: 0.036,
    scanline: 0.030,
    fxaa: true,
    shadowMapSize: 2048,
    maxPixelRatio: 2,
  },
  medium: {
    bloomMips: 5,
    bloomStrength: 0.50,
    bloomRadius: 1.05,
    bloomStretch: 1.35,
    bloomThreshold: 1.35,
    motionBlur: true,
    motionTaps: 8,
    motionAmount: 0.18,
    chroma: true,
    chromaSpectral: false,
    chromaAmount: 0.0006,
    grain: 0.030,
    scanline: 0.026,
    fxaa: true,
    shadowMapSize: 1024,
    maxPixelRatio: 1.5,
  },
  low: {
    bloomMips: 4,
    bloomStrength: 0.78,
    bloomRadius: 1.0,
    bloomStretch: 1.2,
    bloomThreshold: 1.0,
    motionBlur: false,
    motionTaps: 6,
    motionAmount: 0.0,
    chroma: false,
    chromaSpectral: false,
    chromaAmount: 0.0,
    grain: 0.022,
    scanline: 0.0,
    fxaa: false,
    shadowMapSize: 512,
    maxPixelRatio: 1,
  },
};

export class Post {
  constructor(renderer, scene, camera, quality = 'high') {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._width = 1;
    this._height = 1;

    // --- procedural resources (built once, zero external assets) ------------
    this.lut = makeGradeLut();
    this.noise = makeNoiseTexture(256);

    // --- composer ----------------------------------------------------------
    this.composer = new EffectComposer(renderer);
    this.composer.renderTarget1.texture.name = 'composer.rt1';
    this.composer.renderTarget2.texture.name = 'composer.rt2';

    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new BloomPass({
      mips: 6,
      threshold: 1.05,
      knee: 0.55,
      strength: 0.72,
      radius: 1.15,
      stretch: 1.42,
      tint: PALETTE.bloomTint,
      dirt: 0.4,
    });
    this.motionBlur = new MotionBlurPass(this.noise, 12);
    this.chroma = new ChromaPass(true);
    this.grade = new GradePass(this.lut, this.noise);
    this.fxaa = new FXAAPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.motionBlur);
    this.composer.addPass(this.chroma);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.fxaa);

    // --- driveable state ---------------------------------------------------
    this._quality = null;
    this._dashExt = 0;
    this._dashExtHeld = false;
    this._dashRig = 0;
    this._dash = 0;
    this._flash = 0;
    this._impact = 0;
    this._frame = 0;

    this.setQuality(quality);
  }

  // --------------------------------------------------------------------------
  // quality
  // --------------------------------------------------------------------------

  get quality() {
    return this._quality;
  }

  setQuality(q) {
    const p = QUALITY[q] ?? QUALITY.high;
    if (this._quality === q) return p;
    this._quality = QUALITY[q] ? q : 'high';

    this.bloom.mipCount = p.bloomMips;
    this.bloom.strength = p.bloomStrength;
    this.bloom.radius = p.bloomRadius;
    this.bloom.stretch = p.bloomStretch;
    this.bloom.threshold = p.bloomThreshold;

    this.motionBlur.enabled = p.motionBlur;
    this.motionBlur.taps = p.motionTaps;
    this.motionBlur.uniforms.uAmount.value = p.motionAmount;

    this.chroma.enabled = p.chroma;
    if (p.chroma) this.chroma.spectral = p.chromaSpectral;
    this.chroma.uniforms.uAmount.value = p.chromaAmount;

    this.grade.uniforms.uGrain.value = p.grain;
    this.grade.uniforms.uScanline.value = p.scanline;

    this.fxaa.enabled = p.fxaa;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.maxPixelRatio));

    if (this._width > 1) this.setSize(this._width, this._height);
    return p;
  }

  get settings() {
    return QUALITY[this._quality];
  }

  // --------------------------------------------------------------------------
  // driving uniforms
  // --------------------------------------------------------------------------

  /**
   * Sustained dash intensity, 0..1. Widens the radial motion streak and is what
   * makes a dash read as speed rather than as teleporting. Callers should set
   * this every frame while the dash lasts; it decays on its own otherwise.
   */
  setDashIntensity(v) {
    this._dashExt = Math.max(this._dashExt, clamp01(v));
    this._dashExtHeld = true;
  }

  /** Internal channel used by the camera rig so it cannot fight external callers. */
  _setRigDash(v) {
    this._dashRig = clamp01(v);
  }

  /**
   * One-shot impact impulse, 0..1+. Adds an HDR flash (which blooms), scales the
   * chromatic aberration, and decays over ~0.25s.
   */
  impactFlash(v) {
    const a = Math.max(0, v);
    // Take the strongest recent hit rather than summing hits.
    //
    // Accumulating looked fine on a single impact and blew the frame to solid white
    // the moment a combo landed several hits inside the decay window — the value
    // pinned at its ceiling and never came back down. A flash should track the
    // biggest thing that just happened, not how many things happened, which is the
    // same reason hitstop takes a max in the engine.
    this._flash = Math.max(this._flash, Math.min(a * 0.55, 0.5));
    this._impact = Math.max(this._impact, Math.min(a, 0.30));
  }

  /** Screen-space camera velocity, in uv units per frame. Called by the rig. */
  setCameraVelocityUv(x, y) {
    this.motionBlur.uniforms.uVelocity.value.set(x, y);
  }

  set exposure(v) {
    this.grade.uniforms.uExposure.value = v;
  }
  get exposure() {
    return this.grade.uniforms.uExposure.value;
  }

  set vignette(v) {
    this.grade.uniforms.uVignette.value = v;
  }
  set lutIntensity(v) {
    this.grade.uniforms.uLutIntensity.value = v;
  }

  // --------------------------------------------------------------------------
  // per-frame
  // --------------------------------------------------------------------------

  /** @param {number} dt wall seconds @param {number} elapsed sim seconds */
  update(dt, elapsed) {
    // External dash channel decays if nobody re-asserted it this frame.
    if (!this._dashExtHeld) this._dashExt = damp(this._dashExt, 0, 7, dt);
    this._dashExtHeld = false;

    // Cap how far the rig's own speed can drive the streak. Sustained combat kept
    // this near 1 permanently, smearing the entire frame at all times.
    const target = Math.min(0.55, Math.max(this._dashExt, this._dashRig));
    // Attack fast, release slow — the streak should snap on and trail off.
    this._dash = damp(this._dash, target, target > this._dash ? 26 : 7, dt);

    this._flash = damp(this._flash, 0, 18, dt);
    this._impact = damp(this._impact, 0, 16, dt);

    // Baseline radial blur is kept very low. A constant lens-streak reads as a
    // cheap trick and, at any real strength, dissolves fine background detail
    // (skyline windows, panel lines) into mush on every single frame.
    // Radial streak is GATED, not continuous.
    //
    // A baseline radial term smears every pixel on every frame, including while
    // standing still, and at any strength that reads during a dash it destroys the
    // rest of the image the other 95% of the time. So it stays at exactly zero until
    // the dash channel crosses a threshold, then ramps hard. Blur should be an event.
    const dashGate = this._dash > 0.35 ? (this._dash - 0.35) / 0.65 : 0;
    this.motionBlur.uniforms.uRadial.value = dashGate * dashGate * 0.030 + this._impact * 0.004;
    this.motionBlur.uniforms.uDash.value = dashGate;
    this.chroma.uniforms.uImpact.value = this._impact;
    this.grade.uniforms.uImpactFlash.value = this._flash;
    this.grade.uniforms.uTime.value = elapsed;

    // Re-jitter the blur/grain sample offsets from a frame-indexed hash rather
    // than Math.random so a capture at step N is byte-reproducible.
    this._frame++;
    const jx = hash01(this._frame * 7919);
    const jy = hash01(this._frame * 104729 + 17);
    this.motionBlur.uniforms.uJitter.value.set(jx, jy);
    this.grade.uniforms.uNoiseOffset.value.set(jx, jy);
  }

  render() {
    this.composer.render();
  }

  setSize(width, height) {
    this._width = width;
    this._height = height;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  setCamera(camera) {
    this.camera = camera;
    this.renderPass.camera = camera;
  }

  dispose() {
    this.composer.dispose();
    this.bloom.dispose();
    this.motionBlur.dispose();
    this.chroma.dispose();
    this.grade.dispose();
    this.fxaa.dispose();
    this.lut.dispose();
    this.noise.dispose();
  }
}

export { QUALITY };
