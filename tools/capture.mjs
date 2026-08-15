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
        for (let guard = 0; guard < 60; guard++) {
          const n = await page.evaluate(() => window.__game.ctx.ai?.enemies?.length ?? 0);
          if (n >= shot.minHostiles) break;
          await page.evaluate(() => window.__game.advance(60));
        }
      }

      const simWallMs = Date.now() - t0;

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

      const outPath = resolve(ROOT, shot.out);
      mkdirSync(dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath });
      await page.close();

      const r = { ...shot, ok: errors.length === 0, errors, warnings, perf, simWallMs };
      results.push(r);
      if (!opts.quiet) {
        const status = r.ok ? 'ok ' : 'ERR';
        console.log(
          `[${status}] ${shot.name.padEnd(10)} step=${String(shot.steps).padStart(5)} ` +
            `fps=${String(perf.fps).padStart(5)} draws=${String(perf.drawCalls).padStart(4)} ` +
            `tris=${String(perf.triangles).padStart(8)} -> ${shot.out}`
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
    shots = [{ name: presetName, steps: PRESETS[presetName].steps, out: out || `shots/${label}-${presetName}.png`, seed }];
  } else {
    shots = Object.entries(PRESETS).map(([name, p]) => ({
      name,
      steps: p.steps,
      out: `shots/${label}-${name}.png`,
      seed,
    }));
  }

  const results = await capture(shots, { quiet: false });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} capture(s) reported errors.`);
    process.exit(1);
  }
  console.log(`\n${results.length} capture(s) clean.`);
}
