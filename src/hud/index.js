/**
 * Hud module — STUB.
 *
 * This file is a placeholder so the engine always boots. The hud agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createHudModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'hud',
    order: 50,
    init(ctx) {
      ctx.hud = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
