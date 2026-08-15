/**
 * Vfx module — STUB.
 *
 * This file is a placeholder so the engine always boots. The vfx agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createVfxModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'vfx',
    order: 40,
    init(ctx) {
      ctx.vfx = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
