# BALDR CLAUDE

A high-speed quarter-view mech action game in the lineage of *BALDR SKY*, built on
three.js. Gameplay is 2D on the XY plane; rendering is fully 3D with a heavy post
chain. Combat is combo-chaining across eight weapon slots.

**Every asset is generated at runtime.** No image files, no audio files, no models.
Textures are drawn with canvas2d and noise fields, meshes are built from primitives in
code, sound is synthesised with WebAudio. The repository has one runtime dependency:
`three`.

## Running it

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

| flag | effect |
|---|---|
| `?demo=1` | attract mode — a scripted pilot plays the game |
| `?seed=N` | fixed RNG seed (runs are reproducible) |
| `?capture=1` | headless capture mode; the engine is driven by the harness |

### Controls

| input | action |
|---|---|
| `WASD` / arrows | move |
| `Space` | jump, double jump, hold to hover |
| `Shift` | dash (8-directional in the air) |
| `J K L ;` or `1 2 3 4` | weapon slots 1–4 |
| `Q` | lock on |
| `E` | guard |

Slots resolve against two banks: the ground loadout while standing, the air loadout
while airborne. Same four buttons, eight weapons.

## How the combat works

A weapon action runs `startup → active → recovery`, all measured in fixed 1/120s
simulation steps. Normally you are locked until recovery ends. Two things break that
lock: reaching the weapon's `cancelAt` frame, or **landing a hit**, which opens the
cancel window immediately.

That hit-cancel rule is the whole design. Chains only flow while you are connecting,
so a combo is a reward for accuracy rather than a memorised button sequence — whiff,
and you eat the full recovery. Damage scales down as the chain grows, so looping one
link is never optimal and variety pays more than repetition.

Launchers (`uppercut`, `lance`, `grenade`) send enemies airborne and start a juggle.
Each successive juggle applies diminishing launch height and slightly more gravity,
the standard anti-infinite measure.

## Architecture

Eight modules, each owning one directory exclusively, communicating through a shared
context and an event bus. `docs/ARCHITECTURE.md` is the binding contract: entity
shape, event payloads, per-module public APIs, and the performance budget.

| order | module | responsibility |
|---|---|---|
| 10 | `world` | terrain, procedural textures, layered city, lighting rig |
| 20 | `physics` | XY dynamics, spatial-hash broadphase, swept collision, contact response |
| 30 | `combat` | player mech, weapons, combo system, lock-on, damage |
| 35 | `ai` | enemy archetypes, behaviour, wave director |
| 40 | `vfx` | instanced particles, beams |
| 50 | `hud` | canvas cockpit overlay |
| 60 | `audio` | procedural synthesis |
| 90 | `render` | renderer, camera rig, post-processing |

The engine runs a **fixed 120 Hz simulation with interpolated rendering**. Gameplay
lives in `fixed()`, visuals in `frame()`. Because the simulation is fixed-step and
seeded, a given seed advanced a given number of steps produces the same frame every
time — which is what makes automated visual review possible.

### Performance

Budget is in `docs/ARCHITECTURE.md` §9: ≤220 draw calls, ≤1.6M triangles, ≤4ms of
simulation. A typical combat frame runs around 75 draw calls and 90k triangles. The
whole enemy population is four draw calls (one InstancedMesh per archetype) and every
particle effect in the game is two.

## Automated visual review

```bash
node tools/capture.mjs --preset combat --label mine   # one deterministic screenshot
node tools/qa.mjs --label round3                      # full preset sweep + JSON report
node tools/ab.mjs --left a.png --right b.png --label x  # blind A/B comparison
```

`capture.mjs` boots the game in headless Chromium with a real WebGL2 context,
advances the simulation by an exact number of steps, and screenshots. It doubles as a
smoke test: any console error fails the run.

`ab.mjs` shuffles two images into neutral `A.png` / `B.png` slots with the mapping
held in a separate key file, so a reviewing agent cannot infer which candidate is
which from the path or ordering. Grades are only meaningful when identity is
stripped.

`docs/QUALITY_RUBRIC.md` is the standard reviews are scored against;
`docs/CRITIC_BRIEF.md` is the standing instruction for reviewers.

### A warning about the FPS number

The harness renders through **SwiftShader (software WebGL)**, where an empty scene
measures ~32fps. The `fps` figure it reports is therefore meaningless as a
performance signal and is deliberately excluded from the QA gate. Judge cost by draw
calls, triangle count and simulation milliseconds — all hardware-independent.

## Notes on what the screenshots caught

Several defects in this project were invisible in code review and obvious the moment
a frame was actually looked at. Two were worth the trouble on their own:

- The capture harness ran N simulation steps and then a single frame, starving every
  system that integrates on frame time. Screenshots showed the player across the
  arena from a camera that had barely moved — a bug that existed only in the harness,
  never during play. Frames are now interleaved with simulation.
- Motion blur used raw per-frame displacement rather than a fixed shutter duration,
  making streak length a function of framerate. It looked worst exactly on the
  hardware that could least afford it.

The lesson generalises: a harness that reports "clean" while producing a black frame
is worse than no harness. Reviewing the image is not optional.
