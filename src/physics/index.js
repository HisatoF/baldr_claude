/**
 * Physics module — STUB.
 *
 * This file is a placeholder so the engine always boots. The physics agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createPhysicsModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'physics',
    order: 20,
    init(ctx) {
      ctx.physics = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
