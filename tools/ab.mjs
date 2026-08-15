#!/usr/bin/env node
/**
 * Blind A/B comparison harness.
 *
 * Takes two images, randomly assigns them to slots A and B, and copies them to
 * neutral filenames so a reviewing agent cannot infer which is which from the path,
 * the order, or the label. The mapping is written to a key file that the judge is
 * instructed not to open; `--reveal` prints it afterwards.
 *
 * This is what makes iteration honest. When the same agent that built something also
 * grades it, and knows which one it built, the grade is worthless. Stripping identity
 * from the comparison is the only way to get a real preference signal.
 *
 * Usage:
 *   node tools/ab.mjs --left shots/r2-combat.png --right shots/r3-combat.png --label r2v3
 *   node tools/ab.mjs --reveal r2v3
 */
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const revealLabel = arg('reveal');
if (revealLabel) {
  const keyPath = resolve(ROOT, `shots/ab/${revealLabel}/key.json`);
  if (!existsSync(keyPath)) {
    console.error(`no such comparison: ${revealLabel}`);
    process.exit(1);
  }
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  console.log(`Blind comparison "${revealLabel}" — revealed:`);
  console.log(`  A = ${key.A}`);
  console.log(`  B = ${key.B}`);
  process.exit(0);
}

const left = arg('left');
const right = arg('right');
const label = String(arg('label', `ab-${Date.now()}`));

if (!left || !right) {
  console.error('usage: node tools/ab.mjs --left <png> --right <png> --label <name>');
  process.exit(2);
}
for (const p of [left, right]) {
  if (!existsSync(resolve(ROOT, p))) {
    console.error(`missing image: ${p}`);
    process.exit(2);
  }
}

// Cryptographic coin flip — not seeded, because this specific randomness must not be
// reproducible or the assignment could be predicted from the run.
const flip = randomBytes(1)[0] & 1;
const A = flip ? left : right;
const B = flip ? right : left;

const dir = resolve(ROOT, `shots/ab/${label}`);
mkdirSync(dir, { recursive: true });
copyFileSync(resolve(ROOT, A), resolve(dir, 'A.png'));
copyFileSync(resolve(ROOT, B), resolve(dir, 'B.png'));
writeFileSync(resolve(dir, 'key.json'), JSON.stringify({ label, A, B }, null, 2));

console.log(`Blind comparison "${label}" prepared.`);
console.log(`  candidate A: shots/ab/${label}/A.png`);
console.log(`  candidate B: shots/ab/${label}/B.png`);
console.log(`\nGive the judge ONLY those two paths.`);
console.log(`Reveal afterwards with: node tools/ab.mjs --reveal ${label}`);
