import * as THREE from 'three';

/**
 * Render module — MINIMAL BASELINE.
 *
 * Owns the renderer, scene, and camera rig, and is the last module to run each frame.
 * The render agent replaces this with the full deferred-quality pipeline: post stack,
 * bloom, motion blur, colour grading, TAA. Everything here that other modules depend
 * on (`ctx.scene`, `ctx.camera`, `ctx.renderer`, `ctx.render.*`) is contractual and
 * must survive that replacement.
 */
export function createRenderModule(canvas) {
  let renderer, scene, camera;

  const api = {
    /** Register a per-frame camera shake impulse. */
    shake(intensity, duration, freq = 30) {},
    /** Exposed so other modules can push objects into a dedicated layer. */
    get scene() { return scene; },
    get camera() { return camera; },
    quality: 'high',
  };

  return {
    name: 'render',
    order: 90,

    init(ctx) {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
        stencil: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05070c);
      scene.fog = new THREE.FogExp2(0x05070c, 0.0075);

      camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 600);
      camera.position.set(0, 8, 42);
      camera.lookAt(0, 6, 0);

      ctx.renderer = renderer;
      ctx.scene = scene;
      ctx.camera = camera;
      ctx.render = api;
    },

    frame(ctx) {
      renderer.render(scene, camera);
    },

    resize(ctx, w, h) {
      if (!renderer) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    dispose() {
      renderer?.dispose();
    },
  };
}
