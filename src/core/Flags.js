/** Entity flag bitfield. Test with `entity.flags & Flags.DEAD`. */
export const Flags = Object.freeze({
  NONE: 0,
  DEAD: 1 << 0, // scheduled for removal; ignore this entity
  GROUNDED: 1 << 1, // mirrors entity.grounded, kept for fast bulk queries
  STAGGERED: 1 << 2, // poise broken, in stagger animation
  LAUNCHED: 1 << 3, // airborne from a launcher, juggleable
  INVULN: 1 << 4,
  GUARDING: 1 << 5,
  NO_GRAVITY: 1 << 6,
  NO_COLLIDE_WORLD: 1 << 7, // passes through terrain (most projectiles)
  PIERCING: 1 << 8, // projectile survives its first hit
  BOSS: 1 << 9, // immune to launch/juggle, uses poise-break instead
  HOMING: 1 << 10,
  DESPAWN_OFFSCREEN: 1 << 11,
  HITSTOP_IMMUNE: 1 << 12,
});

export function hasFlag(entity, flag) {
  return (entity.flags & flag) !== 0;
}
export function setFlag(entity, flag) {
  entity.flags |= flag;
}
export function clearFlag(entity, flag) {
  entity.flags &= ~flag;
}
export function toggleFlag(entity, flag, on) {
  if (on) entity.flags |= flag;
  else entity.flags &= ~flag;
}

/** Team constants. */
export const Team = Object.freeze({ PLAYER: 0, ENEMY: 1, NEUTRAL: 2 });

export function isHostile(a, b) {
  return a.team !== b.team && a.team !== Team.NEUTRAL && b.team !== Team.NEUTRAL;
}
