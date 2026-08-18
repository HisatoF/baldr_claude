#!/usr/bin/env node
/**
 * Deterministic screenshot harness.
 *
 * Boots the game in a headless Chromium with a real WebGL2 context (SwiftShader),
 * advances the simulation by an exact number of fixed steps, and captures a PNG.
 * Because the engine is fixed-timestep and seeded, step N always produces the same
 * frame — which is what lets the critic agent compare iterations meaningfully.
 *
 * Usage:
 *   node tools/capture.mjs                            # default shot set
 *   node tools/capture.mjs --steps 600 --out shots/x.png
 *   node tools/capture.mjs --preset combat --seed 7
 *   node tools/capture.mjs --list
 *
 * Exit code is non-zero if the page reported a console error or failed to boot,
 * so this doubles as a smoke test in the iteration loop.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.BALDR_PORT || 5173);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Named capture presets. `steps` is in 1/120s simulation steps.
 * 120 steps = 1 second of game time.
 */
export const PRESETS = {
  boot:    { steps: 30,   desc: 'first moments after boot' },
  idle:    { steps: 240,  desc: 'player idle, 2s in' },
  combat:  { steps: 900,  desc: 'mid-combat, 7.5s in' },
  // Offset off the round wave boundaries: at exactly 1800 the arena had just been
  // cleared, so the "peak load" shot was byte-identical in cost to the idle shot
  // and proved nothing about readability under pressure.
  heavy:   { steps: 2040, desc: 'mid-wave, heavy load', minHostiles: 5 },
  late:    { steps: 3480, desc: '29s in — wave escalation', minHostiles: 4 },
  // The grounding shot. Nothing else about it is special; it exists so that the
  // one axis that keeps failing has a frame it can honestly be judged in.
  grounded: { steps: 1500, desc: 'feet on the road, under load', minHostiles: 3, requireGrounded: true },
  // The motion shot, for the same reason. A dash lasts 0.17 s out of a 30 s run, so
  // the odds of a fixed step count landing inside one are poor — and "motion" has
  // been the lowest-scoring axis in every review while every frame reviewed showed a
  // machine standing still.
  dash:    { steps: 1980, desc: 'mid-dash, afterimage trail live', requireDashing: true },
  // The impact shot. Same reasoning as `dash`: a review asked for debris in flight and
  // measured that every fragment in the frame was resting on the ground, which is what
  // a fixed step count will find almost every time — armour is airborne for under a
  // second out of every exchange.
  impact:  { steps: 1500, desc: 'debris in flight off a heavy hit', minHostiles: 3, requireAirborneDebris: 6 },
  // The hit-feedback shot. A struck enemy is lit for about a fifth of a second, and a
  // review measured zero pixels above 250 inside one while the HUD read 698 damage —
  // so the axis this frame is for needs a frame where a hit is actually landing.
  hitflash: { steps: 1400, desc: 'enemy lit by a hit, flash at peak', minHostiles: 3, requireEnemyFlash: 0.5 },
};

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** Start the vite dev server unless one is already listening. */
async function ensureServer() {
  const alive = await fetch(BASE, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (alive) return null;

  const proc = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await fetch(BASE, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return proc;
  }
  proc.kill();
  throw new Error('vite dev server did not come up within 30s');
}

/**
 * Capture one or more shots in a single browser session.
 * @param {Array<{name:string, steps:number, out:string, seed?:number}>} shots
 * @param {{width?:number, height?:number, quiet?:boolean}} opts
 */
export async function capture(shots, opts = {}) {
  const width = opts.width ?? 1600;
  const height = opts.height ?? 900;
  const server = await ensureServer();

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const results = [];
  try {
    for (const shot of shots) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });

      const errors = [];
      const warnings = [];
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error') errors.push(t);
        else if (m.type() === 'warning') warnings.push(t);
      });
      page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

      const seed = shot.seed ?? 0x5eed1234;
      await page.goto(`${BASE}/?capture=1&seed=${seed}`, {
        waitUntil: 'load',
        timeout: 45000,
      });

      // Wait for the module graph to boot rather than guessing with a sleep.
      const booted = await page
        .waitForFunction(() => window.__game && window.__game.ready === true, null, {
          timeout: 30000,
        })
        .then(() => true)
        .catch(() => false);

      if (!booted) {
        const err = await page.evaluate(() => window.__game?.error || 'no __game object');
        results.push({ ...shot, ok: false, errors: [`boot failed: ${err}`, ...errors] });
        await page.close();
        continue;
      }

      // Drive the simulation deterministically, in chunks so a long capture does not
      // block the page's event loop long enough to trip the watchdog.
      const CHUNK = 120;
      let remaining = shot.steps;
      const t0 = Date.now();
      while (remaining > 0) {
        const n = Math.min(CHUNK, remaining);
        await page.evaluate((k) => window.__game.advance(k), n);
        remaining -= n;
      }
      // Some shots are only meaningful under load. Stepping to a fixed count kept
      // landing on the gap between waves, producing a "peak load" frame that was
      // byte-identical in cost to the idle frame and proved nothing. Advance until
      // the arena is actually populated, with a hard cap so this cannot hang.
      if (shot.minHostiles) {
        // Without compositing, and chunked.
        //
        // Sixty round trips each presenting a full post chain is slow enough that the
        // screenshot after it times out; running all of it inside one `evaluate`
        // instead is worse, because thousands of simulation steps in a single
        // synchronous block trips the browser's watchdog and the context goes away.
        // Small non-presenting batches with an await between them are the only shape
        // that survives both.
        let got = false;
        for (let guard = 0; guard < 30 && !got; guard++) {
          got = await page.evaluate((want) => {
            const g = window.__game;
            for (let i = 0; i < 4; i++) {
              if ((g.ctx.ai?.enemies?.length ?? 0) >= want) return true;
              g.advance(60, 30, false);
            }
            return false;
          }, shot.minHostiles);
        }
        if (!got) console.warn(`[warn] ${shot.name}: arena never reached ${shot.minHostiles} hostiles`);
        if (opts.verbose) console.log(`  minHostiles satisfied=${got}`);
      }

      // Ground contact is the rubric's most-cited axis and, until this existed, no
      // preset guaranteed a frame in which it could be judged at all. Three separate
      // rounds argued about a missing contact shadow using screenshots of an
      // AIRBORNE mech — the shadow was correct, fading with altitude exactly as it
      // should, and every measurement taken of "the ground under the feet" was
      // measuring open road. A claim about grounding needs a frame where the machine
      // is actually on the ground.
      if (shot.requireDashing) {
        // The search runs INSIDE the page. A dash is 20 simulation steps long, so
        // finding one means stepping two at a time and checking — several hundred
        // round trips through the CDP bridge, which times out long before the
        // simulation would have found anything.
        // Searching costs frames, and frames are the expensive part under
        // SwiftShader — a naive 2-steps-at-a-time scan renders ~900 composites and
        // wedges the page long enough for the screenshot to time out. The scan runs
        // with a coarse frame interval; once a dash is found, a short fine pass with
        // the normal interval lets every frame-integrated system (camera lead, the
        // afterimage history, motion blur) catch up before the shot is taken.
        const ok = await page.evaluate(() => {
          const g = window.__game;
          const dashing = () => {
            const p = g.ctx.combat?.player;
            return !!(p && Math.hypot(p.vel.x, p.vel.y) > 38);
          };
          const ghosts = () => g.ctx.combat?.afterimage?.mesh?.count ?? 0;
          // Searching costs frames, and frames are the expensive part under
          // SwiftShader — a naive scan renders hundreds of full post chains and
          // wedges the page long enough for the screenshot to time out. The scan
          // therefore runs without compositing; the caller presents one frame at the
          // end regardless of the outcome.
          for (let i = 0; i < 400; i++) {
            if (dashing()) {
              // Finding a dash is not the same as capturing one. The scan always
              // lands on its first frame, where the trail this shot exists to show
              // does not exist yet, and advancing a fixed count instead ran past the
              // end of the dash and certified a frame at spd=18.3 as mid-dash.
              //
              // Advance until the trail is actually there — and if this particular
              // dash ends first, go back to searching rather than shooting whatever
              // the machine happens to be doing. A short dash at one seed is why the
              // QA sweep produced a "dash" frame of a mech standing still.
              for (let k = 0; k < 40; k++) {
                if (ghosts() >= 3) return true;
                if (!dashing()) break;
                g.advance(2, 2, false);
              }
            }
            g.advance(2, 2, false);
          }
          return false;
        });
        if (!ok) console.warn(`[warn] ${shot.name}: player never reached dash speed within the guard window`);
      }

      if (shot.requireEnemyFlash) {
        const ok = await page.evaluate((want) => {
          const g = window.__game;
          const lit = () =>
            (g.ctx.ai?.enemies ?? []).some((e) => (e.userData?.flash ?? 0) >= want);
          for (let i = 0; i < 600; i++) {
            if (lit()) return true;
            g.advance(2, 2, false);
          }
          return false;
        }, shot.requireEnemyFlash);
        if (!ok) console.warn(`[warn] ${shot.name}: no enemy reached flash ${shot.requireEnemyFlash}`);
      }

      if (shot.requireAirborneDebris) {
        const ok = await page.evaluate((want) => {
          const g = window.__game;
          const airborne = () => {
            const f = g.ctx.vfx?.fragments;
            if (!f) return 0;
            const gh = g.ctx.world?.groundHeightAt;
            let n = 0;
            for (let i = 0; i < f.n; i++) {
              const gy = gh ? gh(f.x[i]) : 0;
              // Clearly off the deck, not merely un-settled.
              if (f.y[i] - gy > 1.4) n++;
            }
            return n;
          };
          for (let i = 0; i < 500; i++) {
            if (airborne() >= want) return true;
            g.advance(2, 2, false);
          }
          return false;
        }, shot.requireAirborneDebris);
        if (!ok) console.warn(`[warn] ${shot.name}: never saw ${shot.requireAirborneDebris} fragments in flight`);
      }

      if (shot.requireGrounded) {
        const ok = await page.evaluate(() => {
          const g = window.__game;
          for (let i = 0; i < 240; i++) {
            if (g.ctx.combat?.player?.grounded) return true;
            g.advance(6, 6, false);
          }
          return false;
        });
        if (!ok) console.warn(`[warn] ${shot.name}: player never grounded within the guard window`);
      }

      const simWallMs = Date.now() - t0;

      // SCREENSHOT FIRST, then measure.
      //
      // The perf block below runs the engine live for 1.2 s of wall clock. It used to
      // run before the screenshot, which meant every "deterministic" frame this
      // project has ever reviewed was actually taken 1.2 seconds of real play past
      // the step count it was labelled with. That is why a capture that searched for
      // a dash produced a picture of a mech standing still, and why the grounded
      // preset was not reliably grounded: the harness found the state it was asked
      // for and then played on past it.
      // Always leave the page with a freshly composited frame.
      //
      // The timeline searches above run with `present = false`, which is what makes
      // them affordable under software WebGL — but it also means the last thing the
      // page did was not draw. `page.screenshot` then waits for a frame commit that
      // never arrives and times out at 30 s. One presented step costs 1/120 s of
      // simulation and makes the capture reliable.
      await page.evaluate(() => window.__game.advance(1, 1, true));

      // What was actually true at the instant of the shot.
      //
      // Reviews of this project have repeatedly argued about a frame's content
      // without knowing what the simulation was doing when it was taken — a contact
      // shadow judged missing on an airborne mech, a motion trail judged missing on
      // a stationary one. The report now records the state, so a claim about the
      // image can be checked against it.
      const state = await page.evaluate(() => {
        const g = window.__game;
        const p = g.ctx.combat?.player;
        const ai = g.ctx.ai?.enemies?.length ?? -1;
        return {
          speed: p ? Math.round(Math.hypot(p.vel.x, p.vel.y) * 10) / 10 : -1,
          grounded: p ? !!p.grounded : null,
          y: p ? Math.round(p.pos.y * 100) / 100 : -1,
          hostiles: ai,
          combo: g.ctx.combat?.combo?.count ?? -1,
          flash: Math.round(Math.max(0, ...(g.ctx.ai?.enemies ?? []).map((e) => e.userData?.flash ?? 0)) * 100) / 100,
          fragsAir: (() => {
            const f = g.ctx.vfx?.fragments;
            if (!f) return -1;
            const gh = g.ctx.world?.groundHeightAt;
            let n = 0;
            for (let i = 0; i < f.n; i++) if (f.y[i] - (gh ? gh(f.x[i]) : 0) > 1.4) n++;
            return n;
          })(),
          ghosts: g.ctx.combat?.afterimage?.mesh?.count ?? -1,
          ghostsInScene: !!g.ctx.combat?.afterimage?.mesh?.parent,
          _hist: g.ctx.combat?.afterimage?._hist?.length ?? -1,
          _acc: Math.round((g.ctx.combat?.afterimage?._acc ?? -1) * 100) / 100,
          _t: Math.round((g.ctx.combat?.afterimage?._t ?? -1) * 100) / 100,
          _histAges: (g.ctx.combat?.afterimage?._hist ?? []).map((h) => Math.round((g.ctx.combat.afterimage._t - h.t) * 1000) / 1000 + ':' + h.g),
        };
      });

      const outPath = resolve(ROOT, shot.out);
      mkdirSync(dirname(outPath), { recursive: true });
      // A generous timeout, because the composite is done by SwiftShader on a CPU.
      // The default 30 s is enough for most presets and not for the heaviest, which
      // is the worst possible place for the limit to sit: the sweep would fail on
      // exactly the frame that matters most and report it as a harness error.
      await page.screenshot({ path: outPath, timeout: 180000 });

      // Measure a few real animation frames for an honest FPS reading.
      const perf = await page.evaluate(async () => {
        const g = window.__game;
        g.engine.start();
        await new Promise((r) => setTimeout(r, 1200));
        const s = { ...g.engine.stats };
        const info = g.ctx.renderer?.info;
        g.engine.stop();
        return {
          fps: Math.round(s.fps * 10) / 10,
          simMs: Math.round(s.simMs * 100) / 100,
          frameMs: Math.round(s.frameMs * 100) / 100,
          drawCalls: info?.render?.calls ?? -1,
          triangles: info?.render?.triangles ?? -1,
          hostiles: g.ctx.ai?.enemies?.length ?? -1,
          programs: info?.programs?.length ?? -1,
          geometries: info?.memory?.geometries ?? -1,
          textures: info?.memory?.textures ?? -1,
        };
      });

      await page.close();

      const r = { ...shot, ok: errors.length === 0, errors, warnings, perf, state, simWallMs };
      if (opts.verbose) console.log('  state ' + JSON.stringify(state));
      results.push(r);
      if (!opts.quiet) {
        const status = r.ok ? 'ok ' : 'ERR';
        console.log(
          `[${status}] ${shot.name.padEnd(10)} step=${String(shot.steps).padStart(5)} ` +
            `fps=${String(perf.fps).padStart(5)} draws=${String(perf.drawCalls).padStart(4)} ` +
            `tris=${String(perf.triangles).padStart(8)} ` +
            `spd=${String(state.speed).padStart(5)} gnd=${state.grounded ? 'y' : 'n'} ` +
            `host=${String(state.hostiles).padStart(2)} ghosts=${state.ghosts} air=${state.fragsAir} flash=${state.flash} -> ${shot.out}`
        );
        for (const e of errors.slice(0, 6)) console.log(`        ! ${e.slice(0, 200)}`);
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  return results;
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  if (arg('list')) {
    console.log('presets:');
    for (const [k, v] of Object.entries(PRESETS)) {
      console.log(`  ${k.padEnd(8)} ${String(v.steps).padStart(5)} steps  — ${v.desc}`);
    }
    process.exit(0);
  }

  const seed = Number(arg('seed', 0x5eed1234));
  const presetName = arg('preset');
  const steps = arg('steps');
  const out = arg('out');
  const label = arg('label', 'latest');

  let shots;
  if (steps) {
    shots = [{ name: presetName || 'custom', steps: Number(steps), out: out || `shots/${label}.png`, seed }];
  } else if (presetName && PRESETS[presetName]) {
    // Spread the preset. Listing fields by hand here silently dropped every
    // condition a preset carries — `minHostiles`, `requireGrounded`,
    // `requireDashing` — so the "advance until the arena is populated" logic that
    // this file documents at length had never once executed, on either path. The
    // heavy preset was a plain step count all along.
    shots = [{ ...PRESETS[presetName], name: presetName, out: out || `shots/${label}-${presetName}.png`, seed }];
  } else {
    shots = Object.entries(PRESETS).map(([name, p]) => ({
      ...p,
      name,
      out: `shots/${label}-${name}.png`,
      seed,
    }));
  }

  const results = await capture(shots, { quiet: false, verbose: process.argv.includes('--verbose') });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} capture(s) reported errors.`);
    process.exit(1);
  }
  console.log(`\n${results.length} capture(s) clean.`);
}
