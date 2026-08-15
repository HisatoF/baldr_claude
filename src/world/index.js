/**
 * World module — STUB.
 *
 * This file is a placeholder so the engine always boots. The world agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createWorldModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'world',
    order: 10,
    init(ctx) {
      ctx.world = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
