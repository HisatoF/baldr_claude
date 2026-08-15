import { Engine } from './core/Engine.js';
import { createRenderModule } from './render/index.js';
import { createWorldModule } from './world/index.js';
import { createPhysicsModule } from './physics/index.js';
import { createCombatModule } from './combat/index.js';
import { createAiModule } from './ai/index.js';
import { createVfxModule } from './vfx/index.js';
import { createHudModule } from './hud/index.js';
import { createAudioModule } from './audio/index.js';

/**
 * Boot the game.
 *
 * `?seed=N`      fixed RNG seed (default: fixed, so runs are reproducible)
 * `?capture=1`   headless capture mode — the engine does not self-drive; the capture
 *                harness advances it deterministically via window.__game.
 */
async function boot() {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? 0x5eed1234) >>> 0;
  const captureMode = params.get('capture') === '1';

  const canvas = document.getElementById('game');
  const engine = new Engine({ seed });

  engine
    .register(createWorldModule())
    .register(createPhysicsModule())
    .register(createCombatModule())
    .register(createAiModule())
    .register(createVfxModule())
    .register(createHudModule())
    .register(createAudioModule())
    .register(createRenderModule(canvas));

  await engine.init();

  // Surface the engine for the automated capture + QA harness.
  window.__game = {
    engine,
    ctx: engine.ctx,
    ready: true,
    captureMode,
    /** Advance exactly n simulation steps and render one frame. */
    advance: (n) => engine.advanceDeterministic(n),
    stats: () => engine.stats,
  };

  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');

  if (!captureMode) engine.start();

  console.info(
    `[baldr] booted — seed=0x${seed.toString(16)} modules=${engine.modules.length}` +
      (captureMode ? ' (capture mode)' : '')
  );
}

boot().catch((err) => {
  console.error('[baldr] boot failed:', err);
  window.__game = { ready: false, error: String(err?.stack || err) };
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = 'BOOT FAILURE — see console';
});
