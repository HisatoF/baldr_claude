#!/usr/bin/env node
/**
 * Render the silhouette contact sheet.
 *
 * The rubric's first axis is that every unit must be identifiable as a black shape
 * at 64px. Judging that from a lit, textured, colour-graded combat frame judges
 * something else — lighting and emissives do most of the work there and will hide a
 * shape that does not actually read. This renders each unit flat-black at exactly
 * that size so the silhouette is tested on its own.
 *
 *   node tools/capture-silhouettes.mjs
 */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.BALDR_PORT || 5173);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/tools/silhouette.html`, { waitUntil: 'load' });
const ok = await page
  .waitForFunction(() => window.__sheetReady === true, null, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);

if (!ok) {
  console.error('sheet did not finish rendering', errors);
  await browser.close();
  process.exit(1);
}

await (await page.$('#sheet')).screenshot({ path: 'shots/silhouettes.png' });
console.log('wrote shots/silhouettes.png');
await browser.close();
