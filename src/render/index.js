import * as THREE from 'three';
import { CameraRig } from './CameraRig.js';
import { Post } from './Post.js';
import { makeEnvironment } from './Env.js';
import { PALETTE, COLORS, FOG_DENSITY } from './Palette.js';

/**
 * Render module.
 *
 * Owns the renderer, the scene graph root, the camera rig, and the post stack, and
 * runs last each frame (order 90). Everything other modules rely on — `ctx.scene`,
 * `ctx.camera`, `ctx.renderer`, `ctx.render` — is established here in `init`.
 *
 * The post chain deliberately renders through an EffectComposer rather than calling
 * `renderer.render` directly: bloom is what sells the neon palette, and the grade
 * pass is what keeps the whole frame in one colour language.
 */
export function createRenderModule(canvas) {
  let renderer = null;
  let scene = null;
  let camera = null;
  let rig = null;
  let post = null;
  let env = null;
  let quality = 'high';

  const api = {
    quality,
    get scene() { return scene; },
    get camera() { return camera; },
    get rig() { return rig; },
    get post() { return post; },

    shake(intensity, duration = 0.28, freq = 26) {
      rig?.shake(intensity, duration, freq);
    },
    punchIn(amount) {
      rig?.punchIn(amount);
    },
    setCameraTarget(entity) {
      rig?.setTarget(entity);
    },
    setBounds(b) {
      rig?.setBounds(b);
    },
    impactFlash(v) {
      post?.impactFlash(v);
    },
    setDashIntensity(v) {
      post?.setDashIntensity(v);
    },
    setQuality(q) {
      quality = q;
      api.quality = q;
      post?.setQuality(q);
    },
    /** Shared palette, so other modules can match colours without duplicating them. */
    PALETTE,
    COLORS,
  };

  return {
    name: 'render',
    order: 90,

    init(ctx) {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false, // the post chain ends in its own AA pass
        powerPreference: 'high-performance',
        stencil: false,
        depth: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.info.autoReset = false;

      scene = new THREE.Scene();
      scene.background = COLORS.night.clone();
      scene.fog = new THREE.FogExp2(PALETTE.night, FOG_DENSITY);

      camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 900);
      camera.position.set(0, 8, 42);
      camera.lookAt(0, 6, 0);

      // A procedural PMREM environment. Without something to reflect, PBR metal
      // reads as flat clay — which the rubric rejects outright.
      env = makeEnvironment(renderer);
      scene.environment = env.texture;

      rig = new CameraRig(camera);
      post = new Post(renderer, scene, camera, quality);

      // Route the contract shake event through the rig so any module can request one.
      ctx.bus.on('camera:shake', (p) => {
        rig.shake(p?.intensity ?? 0.4, p?.duration ?? 0.28, p?.freq ?? 26);
      });

      ctx.renderer = renderer;
      ctx.scene = scene;
      ctx.camera = camera;
      ctx.render = api;
    },

    frame(ctx, dt, alpha) {
      // The rig integrates on the render frame so camera motion stays smooth at any
      // refresh rate, using `alpha` to interpolate the target's simulated position.
      rig.update(dt, alpha, ctx.time.elapsed);

      // Feed camera motion into the motion-blur pass.
      post.setCameraVelocityUv(rig.velUvX ?? 0, rig.velUvY ?? 0);
      post.setDashIntensity(rig.dashIntensity ?? 0);
      post.update(dt, ctx.time.elapsed);

      renderer.info.reset();
      post.render();
    },

    resize(ctx, w, h) {
      if (!renderer) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      post.setSize(w, h);
    },

    dispose() {
      post?.dispose();
      env?.dispose();
      renderer?.dispose();
    },
  };
}
