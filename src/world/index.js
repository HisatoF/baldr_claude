import * as THREE from 'three';
import { buildGround, groundHeightAt, GROUND_MIN_X, GROUND_MAX_X } from './Ground.js';
import { buildLighting } from './Lighting.js';
import { buildCity } from './City.js';
import { disposeTextures } from './Textures.js';
import { COLORS } from '../render/Palette.js';

/**
 * World module (order 10 — runs before everything else).
 *
 * Owns the environment: terrain, the layered city behind it, and the lighting rig.
 * Exposes `groundHeightAt` for physics and AI, and `addProp` so other modules can
 * park scenery into the correct depth layer.
 */
export function createWorldModule() {
  let ground = null;
  let lighting = null;
  let city = null;
  let root = null;

  const layers = { fore: null, mid: null, back: null };

  const bounds = Object.freeze({ minX: -120, maxX: 120, minY: 0, maxY: 60 });

  const api = {
    bounds,
    ambientColor: COLORS.fillSky.clone(),

    /** Terrain height at a world X. Physics and AI both depend on this. */
    groundHeightAt(x) {
      return groundHeightAt(x);
    },

    addProp(object3d, layer = 'mid') {
      (layers[layer] ?? layers.mid).add(object3d);
      return object3d;
    },

    get root() { return root; },
  };

  return {
    name: 'world',
    order: 10,

    init(ctx) {
      // Render (order 90) has not run its init yet, so the scene does not exist at
      // this point. Build into a detached root and attach lazily on the first fixed
      // step, rather than reordering the module graph around a load-order detail.
      root = new THREE.Group();
      root.name = 'world';

      for (const k of Object.keys(layers)) {
        layers[k] = new THREE.Group();
        layers[k].name = `world.${k}`;
        root.add(layers[k]);
      }

      ground = buildGround();
      layers.mid.add(ground.group);

      lighting = buildLighting();
      root.add(lighting.group);
      api.ambientColor.copy(lighting.ambientColor);

      city = buildCity();
      layers.back.add(city.backGroup);
      layers.mid.add(city.midGroup);
      layers.fore.add(city.foreGroup);

      ctx.world = api;
    },

    fixed(ctx) {
      // Attach once the render module has published a scene.
      if (root.parent === null && ctx.scene) ctx.scene.add(root);
    },

    frame(ctx, dt) {
      const px = ctx.combat?.player?.pos?.x ?? 0;
      lighting.followShadow(px);
      city.update(ctx.time.elapsed, px);
    },

    dispose() {
      ground?.dispose();
      lighting?.dispose();
      city?.dispose();
      disposeTextures();
      root?.parent?.remove(root);
    },
  };
}

export { GROUND_MIN_X, GROUND_MAX_X };
