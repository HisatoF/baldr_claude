import * as THREE from 'three';

/**
 * Procedural noise textures for the post stack. Zero external assets: everything
 * here is generated from an integer hash at boot and never touched again.
 */

/** Deterministic 32-bit hash → [0,1). Used instead of Math.random so that two runs
 *  of the capture harness produce byte-identical grain. */
function hash01(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return (n >>> 0) / 4294967296;
}

/**
 * A 4-channel noise tile.
 *  - R: white noise, used for film grain
 *  - G: a second decorrelated white channel, used for grain chroma
 *  - B: an ordered/void-and-cluster-ish low-discrepancy channel, used to dither
 *       the motion-blur tap offsets so 8 taps do not read as 8 ghosts
 *  - A: 8-bit ordered dither pattern to kill banding in the final output
 *
 * @param {number} size
 * @returns {THREE.DataTexture}
 */
export function makeNoiseTexture(size = 256) {
  const n = size * size;
  const data = new Uint8Array(n * 4);

  // Bayer 8x8 matrix, expanded procedurally via bit interleaving.
  const bayer = (x, y) => {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const bx = (x >> i) & 1;
      const by = (y >> i) & 1;
      v |= (bx ^ by) << (2 * i + 1);
      v |= by << (2 * i);
    }
    return v / 64; // 0..1 in 64 steps
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const s = y * size + x;
      data[i + 0] = (hash01(s * 2654435761) * 255) | 0;
      data[i + 1] = (hash01(s * 40503 + 977) * 255) | 0;
      // Golden-ratio jitter sequence: far more uniform than white noise, which is
      // what a blur-tap offset actually wants.
      data[i + 2] = ((((s * 0.6180339887) % 1) * 0.75 + hash01(s * 7919) * 0.25) * 255) | 0;
      data[i + 3] = (bayer(x, y) * 255) | 0;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'post.noise';
  return tex;
}

/**
 * A tiny value-noise ramp used by the camera shake to produce continuous,
 * band-limited motion instead of per-frame white jitter (which reads as a
 * broken monitor rather than as recoil).
 */
const SHAKE_TABLE_SIZE = 512;
const shakeTable = new Float32Array(SHAKE_TABLE_SIZE);
for (let i = 0; i < SHAKE_TABLE_SIZE; i++) shakeTable[i] = hash01(i * 9781 + 13) * 2 - 1;

/** Smooth 1-D value noise, allocation free. `t` may be any real number. */
export function valueNoise1(t) {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  const a = shakeTable[((i % SHAKE_TABLE_SIZE) + SHAKE_TABLE_SIZE) % SHAKE_TABLE_SIZE];
  const b = shakeTable[(((i + 1) % SHAKE_TABLE_SIZE) + SHAKE_TABLE_SIZE) % SHAKE_TABLE_SIZE];
  return a + (b - a) * s;
}

export { hash01 };
