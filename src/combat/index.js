/**
 * Combat module — STUB.
 *
 * This file is a placeholder so the engine always boots. The combat agent replaces
 * it with the real implementation. See docs/ARCHITECTURE.md for the contract.
 */
export function createCombatModule() {
  const api = {
    /** replaced by the real implementation */
    stub: true,
  };
  return {
    name: 'combat',
    order: 30,
    init(ctx) {
      ctx.combat = api;
    },
    fixed(ctx, dt) {},
    frame(ctx, dt, alpha) {},
    resize(ctx, w, h) {},
    dispose(ctx) {},
  };
}
