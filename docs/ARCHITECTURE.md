# BALDR CLAUDE — Architecture Contract

**This document is the binding contract between all modules.** Every agent building a
subsystem MUST conform to it exactly. Do not change interfaces defined here without
coordinating through the orchestrator.

## 0. Design target

A high-speed quarter-view mech action game in the lineage of *BALDR SKY*:

- Gameplay is **2D on the XY plane** (X = horizontal, Y = height). Z is used **only** for
  visual depth, parallax, and camera framing — never for gameplay collision.
- Rendering is fully **3D** with a perspective camera, PBR materials, and a heavy
  post-processing stack. The look is "2D action game rendered by a 3D engine."
- Combat is **combo-chaining**: 8 weapon slots (4 ground, 4 air). Weapons stagger and
  juggle enemies; chaining before the combo timer expires extends the chain.
- Movement is **dash-centric**: ground dash, air dash, hover, jump, all drawing from a
  shared boost (EN) gauge.

## 1. Hard constraints

1. **Zero external assets.** No image files, no audio files, no model files, no CDN
   fetches. Every texture is generated procedurally at runtime (canvas2d / noise / shader),
   every mesh is built from code, every sound is synthesized with WebAudio.
   This keeps the repo self-contained and free of any licensing question.
2. **ES modules only.** `import * as THREE from 'three'`. Vite resolves it.
3. **No new npm dependencies** without orchestrator approval. `three` only.
4. **Everything must run at 60fps** at 1600x900 on a mid GPU. Budget below.
5. **Deterministic gameplay.** Fixed timestep. No `Math.random()` in gameplay logic —
   use the seeded RNG from `core/Rng.js`. Visual-only randomness may use `Math.random()`.

## 2. File ownership

Each module owns its directory exclusively. **Never edit a file outside your directory.**
If you need something from another module, it must come through the interfaces below.

| Directory | Owner module | Responsibility |
|---|---|---|
| `src/core/` | **orchestrator** | engine loop, bus, input, RNG, math. Do not edit. |
| `src/render/` | rendering | renderer, camera rig, post-processing, color grading |
| `src/physics/` | physics | 2D XY dynamics, collision, knockback, juggle |
| `src/combat/` | combat | player mech, weapons, combo system, lock-on |
| `src/ai/` | ai | enemy archetypes, behaviours, wave director, boss |
| `src/vfx/` | vfx | particles, beams, trails, explosions, impact decals |
| `src/world/` | world | environment geometry, procedural materials, parallax |
| `src/hud/` | hud | HUD, combo counter, gauges, menus |
| `src/audio/` | audio | procedural synthesis, mixing, music |

## 3. Engine loop

`core/Engine.js` runs a **fixed-timestep simulation** with interpolated rendering.

```
SIM_HZ   = 120           // simulation steps per second
SIM_DT   = 1/120         // seconds per simulation step
MAX_SUB  = 5             // max catch-up steps per frame (spiral-of-death guard)
```

Every module registers itself once and receives lifecycle callbacks:

```js
engine.register({
  name: 'vfx',
  order: 40,               // see ordering table
  init(ctx)      {},       // called once, after all modules constructed
  fixed(ctx, dt) {},       // called at SIM_HZ with dt === SIM_DT. Gameplay lives here.
  frame(ctx, dt, alpha) {},// called once per rendered frame. Visual-only.
  resize(ctx, w, h) {},    // called on viewport change
  dispose(ctx)   {},
});
```

**`fixed` is for gameplay. `frame` is for visuals.** Never mutate gameplay state in
`frame`. `alpha` is the 0..1 interpolation factor between the previous and current
simulation states — use it to smooth rendering.

### Module order

Lower `order` runs first within each phase.

| order | module |
|---|---|
| 10 | world |
| 20 | physics |
| 30 | combat |
| 35 | ai |
| 40 | vfx |
| 50 | hud |
| 60 | audio |
| 90 | render (renders last) |

## 4. The context object (`ctx`)

Every callback receives the shared context. It is created by the engine and populated
by modules during `init`.

```js
ctx = {
  engine,          // Engine instance
  bus,             // event bus (section 5)
  input,           // input state (section 6)
  rng,             // seeded RNG
  time: { elapsed, dt, frame, scale },  // scale = time dilation (hitstop/slowmo)
  scene,           // THREE.Scene           (provided by render)
  camera,          // THREE.PerspectiveCamera (provided by render)
  renderer,        // THREE.WebGLRenderer   (provided by render)
  world,           // world module public API
  physics,         // physics module public API
  combat,          // combat module public API
  ai,              // ai module public API
  vfx,             // vfx module public API
  hud,             // hud module public API
  audio,           // audio module public API
  render,          // render module public API
  debug: { enabled, draw(...) },
}
```

Each module assigns its public API onto `ctx.<name>` inside its own `init`. Because
`init` runs in `order` sequence, a module may only rely on lower-order modules being
ready at `init` time. For anything else, resolve lazily inside `fixed`/`frame`.

## 5. Event bus

`ctx.bus` is a synchronous pub/sub.

```js
bus.on('enemy:hit', handler)   // returns an unsubscribe function
bus.once('boss:dead', handler)
bus.emit('enemy:hit', payload)
bus.off('enemy:hit', handler)
```

### Canonical events

Payload shapes are contractual. `vec2` means `{x, y}`.

| event | payload | emitted by |
|---|---|---|
| `hit:landed` | `{ attacker, target, damage, point:vec2, normal:vec2, weaponId, stagger, launch }` | combat |
| `hit:blocked` | `{ attacker, target, point:vec2 }` | combat |
| `combo:changed` | `{ count, damage, timeLeft, rank }` | combat |
| `combo:ended` | `{ count, damage, rank }` | combat |
| `weapon:fired` | `{ weaponId, slot, origin:vec2, dir:vec2 }` | combat |
| `entity:spawned` | `{ entity }` | ai / combat |
| `entity:died` | `{ entity, killer, overkill }` | physics/ai |
| `player:damaged` | `{ amount, hpAfter, source }` | combat |
| `player:dashed` | `{ kind:'ground'\|'air', dir:vec2 }` | combat |
| `boost:depleted` | `{}` | combat |
| `wave:started` | `{ index, count }` | ai |
| `wave:cleared` | `{ index, timeTaken }` | ai |
| `boss:phase` | `{ phase }` | ai |
| `camera:shake` | `{ intensity, duration, freq }` | any |
| `time:hitstop` | `{ duration }` | any |
| `fx:explosion` | `{ point:vec2, radius, kind }` | any |
| `game:over` | `{ reason }` | any |

Emitting an event must never assume a listener exists.

## 6. Input

`ctx.input` exposes an abstract action map — never read raw key codes in gameplay code.

```js
input.axis            // {x, y} normalized -1..1, from WASD/arrows/stick
input.down(action)    // held this step
input.pressed(action) // rising edge this step
input.released(action)// falling edge this step
input.buffer(action, frames) // true if pressed within the last N sim steps (input buffering)
```

Actions: `'jump' | 'dash' | 'lock' | 'guard' | 'w1' | 'w2' | 'w3' | 'w4' | 'shift' | 'pause'`

Weapon slots resolve as: ground slots = `w1..w4`; air slots = the same buttons while
`entity.grounded === false`.

## 7. Entities

A single flat entity shape is shared by player, enemies, and projectiles. Physics owns
integration; other modules read and write the fields they own.

```js
{
  id,                  // integer, unique, assigned by physics.spawn()
  kind,                // 'player' | 'enemy' | 'projectile' | 'prop'
  archetype,           // string tag, e.g. 'grunt', 'sniper', 'boss'
  pos:  {x,y},         // gameplay position (XY plane)
  prev: {x,y},         // position at previous sim step (for interpolation)
  vel:  {x,y},
  acc:  {x,y},
  size: {x,y},         // AABB half-extents
  z,                   // visual depth only, never collided against
  mass,
  gravityScale,
  grounded,            // bool, set by physics each step
  faceDir,             // -1 or 1
  team,                // 0 = player, 1 = enemy, 2 = neutral
  hp, hpMax,
  poise, poiseMax,     // stagger resistance; depletion causes stagger
  hitstun,             // sim steps remaining of hitstun
  invuln,              // sim steps remaining of invulnerability
  juggleCount,         // times launched without touching ground
  flags,               // bitfield, see core/Flags.js
  view,                // THREE.Object3D owned by the module that spawned it
  userData,            // module-private scratch space
}
```

**Ownership rules**

- `physics` owns `pos/prev/vel/acc/grounded` integration and collision response.
- Whoever spawns an entity owns its `view` and must dispose of it on death.
- `hp/poise/hitstun/invuln` are written by `combat` only.
- Never hold a stale entity reference across frames — check `entity.flags & DEAD`.

## 8. Coordinate system & scale

- **1 world unit = 1 metre.** The player mech is **4 units tall**.
- Ground plane is `y = 0`. Positive Y is up. Positive X is right.
- Gravity is `-38 u/s²` (deliberately arcade-heavy, not 9.81).
- The playfield is a horizontal corridor: `x ∈ [-120, 120]`, `y ∈ [0, 60]`.
- Camera looks down the -Z axis at the XY plane from `z ≈ +42`, with a slight
  downward pitch to produce the quarter view. Owned by `render`.

## 9. Performance budget

Per frame at 1600x900:

| system | budget |
|---|---|
| draw calls | ≤ 220 |
| triangles | ≤ 1.6 M |
| CPU sim (all `fixed` steps) | ≤ 4.0 ms |
| CPU frame (all `frame`) | ≤ 3.5 ms |
| GPU | ≤ 12 ms |

Rules: instance anything appearing more than 8 times. Pool all projectiles and
particles — **zero allocation in the steady-state loop**. No `new THREE.Vector3()` inside
`fixed` or `frame`; use the scratch vectors in `core/Scratch.js`.

## 10. Quality bar

Every subsystem is reviewed by an adversarial critic agent against `docs/QUALITY_RUBRIC.md`.
"It works" is not the bar. The bar is: *a frame taken at random during play is
indistinguishable in craft from a shipped commercial action game.*
