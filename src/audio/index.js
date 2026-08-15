/**
 * Audio module — STUB.
 *
 * This file is a placeholder so the engine always boots. The audio agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createAudioModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'audio',
    order: 60,
    init(ctx) {
      ctx.audio = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
