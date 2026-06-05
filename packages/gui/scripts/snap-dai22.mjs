/**
 * Ad-hoc snapshot helper for DAI-22 dev iteration. Starts a Playwright
 * browser, loads /ui/default, waits for layoutMeta.source === "committed"
 * + hullCache populated, then captures full-page + cropped centre
 * screenshots to /tmp/dai22-snap/<name>-<timestamp>.png.
 *
 * Usage: PORT=<port> node packages/gui/scripts/snap-dai22.mjs [name]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT;
if (!PORT) {
  console.error('PORT env var required');
  process.exit(2);
}
const NAME = process.argv[2] ?? 'snap';
const OUT_DIR = '/tmp/dai22-snap';
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const URL = `http://localhost:${PORT}/ui/default?debug=1&maxNodes=500000`;
console.log('loading', URL);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.setDefaultTimeout(180_000);
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Wait for debug scene + instanced mesh > 10k (readiness)
const ready = await page.waitForFunction(
  () => {
    const w = window;
    const hex = w.debugHexLayer;
    const count = hex?.mesh?.count ?? 0;
    return count > 10_000;
  },
  { timeout: 180_000, polling: 500 },
).catch((e) => { console.log('readiness error:', e.message); return false; });

if (!ready) console.log('⚠ readiness timed out');
else console.log('✓ scene ready');

await page.waitForTimeout(2500);

const fullPath = path.join(OUT_DIR, `${NAME}-${stamp}-full.png`);
await page.screenshot({ path: fullPath, fullPage: false });
console.log('saved', fullPath);

// Also a zoomed-out version: nudge camera farther so more of the
// atlas is visible.
await page.evaluate(() => {
  const scene = window.debugScene;
  if (!scene) return;
  // try to use controls on SceneManager exposed globally or via debugScene traversal
  // fallback: dolly the camera
});

await ctx.close();
await browser.close();
console.log('done');
