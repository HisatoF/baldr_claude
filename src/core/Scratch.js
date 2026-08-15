/**
 * Preallocated scratch objects.
 *
 * The steady-state loop must not allocate — GC pauses show up directly as frame
 * hitches in a game this fast. Borrow a scratch object, use it within the current
 * call, and never retain it across a yield.
 *
 * Usage:
 *   import { v2, v3a, v3b } from '../core/Scratch.js';
 *   v2.x = ...; v2.y = ...;
 */
import * as THREE from 'three';

// 2D gameplay scratch
export const v2 = { x: 0, y: 0 };
export const v2b = { x: 0, y: 0 };
export const v2c = { x: 0, y: 0 };

// 3D rendering scratch
export const v3a = new THREE.Vector3();
export const v3b = new THREE.Vector3();
export const v3c = new THREE.Vector3();
export const v3d = new THREE.Vector3();

export const quatA = new THREE.Quaternion();
export const quatB = new THREE.Quaternion();
export const matA = new THREE.Matrix4();
export const matB = new THREE.Matrix4();
export const colA = new THREE.Color();
export const colB = new THREE.Color();
export const eulerA = new THREE.Euler();

/**
 * A tiny ring of vectors for cases where a call needs several temporaries and you
 * would otherwise have to name them all. Valid only for the duration of one call.
 */
const RING_SIZE = 32;
const ring3 = Array.from({ length: RING_SIZE }, () => new THREE.Vector3());
let ringIdx = 0;
export function tmp3() {
  ringIdx = (ringIdx + 1) % RING_SIZE;
  return ring3[ringIdx];
}

/**
 * Generic object pool. Every projectile / particle / damage number should come from
 * one of these rather than from `new`.
 */
export class Pool {
  /**
   * @param {() => any} factory  creates a fresh instance
   * @param {(o:any) => void} [reset]  returns an instance to a neutral state
   * @param {number} [prealloc]
   */
  constructor(factory, reset = null, prealloc = 0) {
    this._factory = factory;
    this._reset = reset;
    this._free = [];
    this._liveCount = 0;
    for (let i = 0; i < prealloc; i++) this._free.push(factory());
  }

  acquire() {
    this._liveCount++;
    const o = this._free.pop();
    return o !== undefined ? o : this._factory();
  }

  release(o) {
    if (o == null) return;
    this._liveCount--;
    if (this._reset) this._reset(o);
    this._free.push(o);
  }

  get liveCount() {
    return this._liveCount;
  }
  get freeCount() {
    return this._free.length;
  }
}
