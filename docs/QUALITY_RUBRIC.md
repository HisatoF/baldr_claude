# Quality Rubric — the adversarial standard

This is the document the critic agent judges against. It is deliberately hostile.
The default verdict is **REJECT**. Work earns acceptance; it is not granted one.

## How to score

Each axis is scored 0–10. **A submission passes only if every axis is ≥ 8 and the
mean is ≥ 8.5.** One axis at 7 fails the whole submission regardless of the mean.
There is no partial credit for effort, and "it's a good start" is a REJECT.

Report format — always exactly this:

```
VERDICT: ACCEPT | REJECT
SCORES: silhouette=N lighting=N material=N motion=N composition=N cohesion=N polish=N
TOP DEFECTS:
  1. <specific, located, actionable>
  2. ...
REQUIRED FIXES: <numbered, concrete, each independently verifiable>
```

Vague criticism is itself a failure. "Needs more polish" is worthless. "The rim light
on the mech's left shoulder reads as a hard white line because the falloff is
`pow(fresnel, 1.0)` — it needs `pow(fresnel, 3.5)` and a warm tint" is useful.

## The seven axes

### 1. Silhouette
The mech and every enemy must be identifiable as a black shape at 64px. Limbs must
read separately from the torso. Boxy proportions, symmetric featureless slabs, and
"a cube with a gun taped on" are automatic 0–3. Mechanical designs need greebles,
panel breaks, and asymmetry that survives scaling down.

### 2. Lighting
- Never a single flat ambient term. Key + fill + rim, minimum.
- Emissives must actually bloom and must colour-bleed onto nearby surfaces.
- Shadows must be present and contact-grounded. A mech floating with no contact
  shadow is an automatic REJECT.
- Neon in a night city implies coloured bounce. Pure grey shadow is a failure.

### 3. Materials
- No untextured `MeshStandardMaterial` with a flat `color` on any hero object.
- Metal needs roughness variation — procedural or otherwise. Uniform roughness reads
  as plastic.
- Surfaces need normal/roughness detail at two scales: panel-level and micro-scratch.
- Emissive strips must have falloff and thickness, not be uniform full-white quads.

### 4. Motion
- Nothing moves at constant velocity. Everything eases.
- Impacts need hitstop, screen shake proportional to weight, and knockback.
- Dashes need an anticipation frame and a recovery frame, plus a trail/afterimage.
- Projectiles need muzzle flash, travel, and an impact event. A sphere translating
  linearly is a 0.
- Idle states must never be perfectly still.

### 5. Composition & camera
- The camera must lead the player's motion, not centre them rigidly.
- Framing must obey the quarter-view brief and remain readable during chaos.
- Depth must be legible: foreground, midground, background separated by value and
  atmospheric perspective.
- If the action is unreadable at peak particle load, that is a REJECT regardless of
  how pretty the particles are.

### 6. Cohesion
- One palette, one visual language. A neon-cyan HUD over an orange-brown desert with
  purple explosions is incoherent.
- Every element must look like it came from the same art direction.
- The HUD must feel diegetic to a mech cockpit, not like default browser `<div>`s.

### 7. Polish
- No z-fighting, no visible seams, no popping LODs, no particles clipping the ground.
- No aliasing crawl on high-contrast edges.
- No placeholder text, no `console.log` spam, no debug wireframes left on.
- Loading must not flash white.

## BALDR SKY visual reference language

The target look, described so it can be judged without the original to hand:

- **Palette**: cold industrial base — gunmetal, desaturated blue-grey, black — cut by
  saturated cyan / magenta / amber emissives. High contrast, low mid-tone mud.
- **Speed as a visual**: the game reads *fast*. Motion trails, afterimages, radial
  streaks, and aggressive motion blur on dashes. Stillness is the exception.
- **Density**: the screen is busy — projectiles, tracers, debris, damage numbers —
  but the player mech always reads clearly because it holds the highest local
  contrast and the strongest silhouette.
- **Weight**: mechs are heavy. Landings kick dust, impacts shove the camera, heavy
  weapons visibly recoil the frame.
- **HUD**: dense, technical, cyan-on-dark, thin strokes, lots of small readouts,
  bracket/corner motifs, scanline and chromatic fringing on the overlay.
- **Environment**: layered urban depth — near silhouetted foreground, lit midground
  playfield, hazy neon skyline behind, with strong atmospheric falloff.

## Automatic rejections

These fail on sight, no scoring needed:

1. A frame that is majority flat untextured colour.
2. Any hero object with no shadow.
3. Constant-velocity motion on anything the player looks at.
4. Default Three.js material appearance (the "grey clay" look).
5. HUD that is unstyled DOM.
6. Exceeding the draw-call or triangle budget in `docs/ARCHITECTURE.md` §9.
7. Any console error during a 30-second play capture.

## A warning about the FPS number

The capture harness renders through **SwiftShader (software WebGL)**, not a GPU. An
empty scene measures ~32fps there. **The `fps` figure the harness reports is therefore
meaningless as a performance signal and must never be used to accept or reject work.**

Judge performance only by the numbers that are hardware-independent:

- `drawCalls` and `triangles` against the §9 budget,
- `simMs` (CPU simulation cost),
- allocation behaviour (pooling, no `new` in the loop).

Never "optimise" by removing visual quality because the harness reported low fps.
