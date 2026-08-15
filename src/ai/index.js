/**
 * Ai module — STUB.
 *
 * This file is a placeholder so the engine always boots. The ai agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createAiModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'ai',
    order: 35,
    init(ctx) {
      ctx.ai = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
