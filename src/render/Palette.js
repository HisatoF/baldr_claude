import * as THREE from 'three';

/**
 * The single source of truth for the render module's colour language.
 *
 * BALDR-SKY palette: a cold industrial base (gunmetal / desaturated blue-grey /
 * near-black) cut by saturated cyan, magenta and amber emissives. High contrast,
 * as little mid-tone mud as possible.
 *
 * Other modules are welcome to import this so the whole game shares one palette.
 * Values are given as linear-ish sRGB hex; convert with `new THREE.Color(hex)`
 * (three decodes hex as sRGB and works internally in linear).
 */
export const PALETTE = {
  // --- base / environment -------------------------------------------------
  void: 0x04060a, // deepest background, the "off" pixel
  night: 0x070b14, // sky base / clear colour
  // Atmospheric haze — DELIBERATELY lighter than the night base.
  //
  // Fog was previously tinted to `night`, so everything distant faded toward
  // near-black and the skyline lost depth instead of gaining it: near and far towers
  // resolved to the same value and separated only by overlap. Real haze over a city
  // at night is lit by the city itself, so it sits ABOVE the silhouettes it veils.
  // That inversion is the whole mechanism of aerial perspective.
  haze: 0x2a2f47,
  gunmetal: 0x2b323d, // primary hard-surface albedo
  steel: 0x545e6b, // lighter panel albedo
  shadowTint: 0x121b2b, // colour that shadows drift toward (never neutral grey)

  // --- key lighting -------------------------------------------------------
  keyLight: 0xbcd4ff, // cold moonlight/streetlight key
  fillSky: 0x22334d, // hemisphere sky
  fillGround: 0x0a0e16, // hemisphere bounce off wet asphalt
  rimLight: 0xff4f9d, // magenta backlight — separates silhouettes from the bg

  // --- emissive accents ---------------------------------------------------
  cyan: 0x5ad9ff,
  cyanHot: 0xb8f2ff,
  magenta: 0xff3d9a,
  magentaHot: 0xffa8d6,
  amber: 0xffa63d,
  amberHot: 0xffe0a8,
  danger: 0xff2b3c,

  // --- post ---------------------------------------------------------------
  bloomTint: 0xdfeeff, // very slightly cool bloom so neon does not go white
  vignetteTint: 0x0a1420, // cool, never pure black
  flashTint: 0xd9f2ff,
};

/** Preallocated THREE.Color instances so nothing allocates at frame time. */
export const COLORS = Object.fromEntries(
  Object.entries(PALETTE).map(([k, v]) => [k, new THREE.Color(v)])
);

/** World-space fog density used by the render module's default atmosphere. */
export const FOG_DENSITY = 0.0069;
