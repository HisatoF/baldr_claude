#!/usr/bin/env node
/**
 * QA sweep.
 *
 * Captures the full preset set, collects perf counters and console output, checks them
 * against the budgets in docs/ARCHITECTURE.md §9, and writes a machine-readable report
 * that the critic agent reads alongside the images.
 *
 * Usage:
 *   node tools/qa.mjs --label round3
 *   node tools/qa.mjs --label round3 --seed 99
 *
 * Exit code is non-zero when a hard budget is blown or the page errored, so this is
 * usable as a gate in the iteration loop.
 */
import { capture, PRESETS } from './capture.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Budgets from docs/ARCHITECTURE.md §9. Deliberately NOT including fps — see rubric. */
const BUDGET = {
  drawCalls: 220,
  triangles: 1_600_000,
  simMs: 4.0,
};

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const label = String(arg('label', 'qa'));
const seed = Number(arg('seed', 0x5eed1234));

const shots = Object.entries(PRESETS).map(([name, p]) => ({
  name,
  steps: p.steps,
  desc: p.desc,
  out: `shots/${label}-${name}.png`,
  seed,
}));

console.log(`QA sweep "${label}" — ${shots.length} presets @ seed 0x${seed.toString(16)}\n`);
const results = await capture(shots, { quiet: false });

// ---- evaluate ----
const violations = [];
for (const r of results) {
  if (!r.ok) {
    violations.push({
      preset: r.name,
      kind: 'console-error',
      detail: r.errors.slice(0, 5).join(' | ').slice(0, 500),
    });
    continue;
  }
  const p = r.perf;
  if (p.drawCalls > BUDGET.drawCalls) {
    violations.push({ preset: r.name, kind: 'draw-calls', detail: `${p.drawCalls} > ${BUDGET.drawCalls}` });
  }
  if (p.triangles > BUDGET.triangles) {
    violations.push({ preset: r.name, kind: 'triangles', detail: `${p.triangles} > ${BUDGET.triangles}` });
  }
  if (p.simMs > BUDGET.simMs) {
    violations.push({ preset: r.name, kind: 'sim-ms', detail: `${p.simMs} > ${BUDGET.simMs}` });
  }
}

const report = {
  label,
  seed,
  generatedAt: new Date().toISOString(),
  note:
    'fps is measured under SwiftShader software WebGL and is NOT a valid performance ' +
    'signal. Judge cost by drawCalls / triangles / simMs only.',
  budget: BUDGET,
  shots: results.map((r) => ({
    preset: r.name,
    desc: r.desc,
    image: r.out,
    steps: r.steps,
    ok: r.ok,
    perf: r.perf ?? null,
    errors: r.errors ?? [],
    warningCount: r.warnings?.length ?? 0,
  })),
  violations,
  pass: violations.length === 0,
};

const outPath = resolve(ROOT, `shots/${label}-report.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`\n--- QA "${label}" ---`);
if (violations.length === 0) {
  console.log('PASS — no budget violations, no console errors.');
} else {
  console.log(`FAIL — ${violations.length} violation(s):`);
  for (const v of violations) console.log(`  [${v.preset}] ${v.kind}: ${v.detail}`);
}
console.log(`report: shots/${label}-report.json`);
console.log(`images: ${results.map((r) => r.out).join(', ')}`);

process.exit(report.pass ? 0 : 1);
