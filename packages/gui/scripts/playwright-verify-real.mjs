/**
 * Real-data Playwright verification against a live rfdb-server.
 *
 * Unlike `playwright-verify.mjs` (which only asserts "screenshot file
 * written"), this script:
 *   1. Waits for the NDJSON graph stream to finish populating React state.
 *   2. Measures actual pixel content of the <canvas> in both 3D and 2D.
 *   3. Fails the run if the center of the canvas is mostly background
 *      (tiles invisible — the DAI-21 class of bug).
 *
 * Usage:
 *   PORT=53618 node scripts/playwright-verify-real.mjs
 *
 * The caller is responsible for starting rfdb-server with a real database
 * and passing its HTTP port. Intended for use from `scripts/smoke.sh` or
 * ad-hoc human runs; CI wires it up via `rfdb-server --http-port 0`.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const PORT = process.env.PORT;
if (!PORT) {
  console.error('PORT env var required — e.g. PORT=53618 node scripts/playwright-verify-real.mjs');
  process.exit(2);
}
const URL = `http://localhost:${PORT}/ui/default`;
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/rfdb-smoke';
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * Sample the central 50% of a canvas and return the fraction of pixels
 * whose RGB differs from `bg` by more than `tol` (per-channel max).
 * Returns { total, hits, fraction, samples[] }. `samples` is a handful
 * of RGB triples from non-background hits for debug logging.
 */
/**
 * Measure real pixel content of the <canvas> using an element screenshot.
 * Playwright's element screenshot captures the composited frame even
 * without `preserveDrawingBuffer`. We decode the resulting PNG with a
 * minimal tokenizer (IHDR + concatenated IDAT deflate) — we only need
 * the IHDR dimensions and raw RGBA bytes.
 *
 * Returns the fraction of pixels in the central 50% box whose RGB
 * differs from `bgHex` by more than `tol` (per-channel max).
 */
async function measureCanvasContent(page, bgHex, tol = 18, screenshotPath = null) {
  const handle = await page.locator('canvas').first().elementHandle();
  const buf = await handle.screenshot({ type: 'png' });
  if (screenshotPath) fs.writeFileSync(screenshotPath, buf);
  const { width: w, height: h, data } = decodePng(buf);
  const x0 = Math.floor(w * 0.25);
  const y0 = Math.floor(h * 0.25);
  const x1 = Math.floor(w * 0.75);
  const y1 = Math.floor(h * 0.75);
  const br = (bgHex >> 16) & 0xff;
  const bg = (bgHex >> 8) & 0xff;
  const bb = bgHex & 0xff;
  let total = 0, hits = 0;
  const samples = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], gg = data[i+1], b = data[i+2];
      total++;
      if (Math.abs(r - br) > tol || Math.abs(gg - bg) > tol || Math.abs(b - bb) > tol) {
        hits++;
        if (samples.length < 6 && (hits % 5000 === 1)) samples.push([r, gg, b]);
      }
    }
  }
  return { w, h, total, hits, fraction: hits / total, samples };
}

/**
 * Minimal PNG decoder: walks chunks, concatenates IDAT, zlib-inflates,
 * then un-filters each scanline. Supports 8-bit RGBA (color type 6) and
 * 8-bit RGB (color type 2), which is what Playwright produces.
 * Returns { width, height, data } where `data` is RGBA regardless of
 * source color type (alpha defaulted to 255 for RGB PNGs).
 */
function decodePng(buf) {
  const zlib = require('node:zlib');
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a PNG');
  let p = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); p += 4;
    const type = buf.slice(p, p + 4).toString('ascii'); p += 4;
    const chunk = buf.slice(p, p + len); p += len + 4; // +4 for CRC
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth: ${bitDepth}`);
  const chans = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (chans === 0) throw new Error(`unsupported color type: ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * chans;
  const out = Buffer.alloc(width * height * 4);
  // Un-filter scanlines (filters 0..4 per PNG spec).
  const prev = Buffer.alloc(stride);
  let rpos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rpos++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const byte = raw[rpos + x];
      const a = x >= chans ? row[x - chans] : 0;
      const b = prev[x];
      const c = x >= chans ? prev[x - chans] : 0;
      let v;
      switch (filter) {
        case 0: v = byte; break;
        case 1: v = byte + a; break;
        case 2: v = byte + b; break;
        case 3: v = byte + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = byte + pred;
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
      row[x] = v & 0xff;
    }
    rpos += stride;
    // Expand into RGBA output.
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * chans;
      out[o] = row[i];
      out[o + 1] = row[i + 1];
      out[o + 2] = row[i + 2];
      out[o + 3] = chans === 4 ? row[i + 3] : 255;
    }
    row.copy(prev);
  }
  return { width, height, data: out };
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('pageerror', (e) => console.log('PAGE_ERROR:', e.message));

try {
  console.log(`Loading ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for the sidebar to report a populated graph. The stream writes
  // nodeCount into the store which renders into `.graph-stats`; in this
  // app it appears as "N,NNN nodes" text. We poll until count > 0.
  await page.waitForFunction(
    () => {
      const txt = document.body.innerText;
      const m = txt.match(/([\d,]+)\s+nodes/);
      if (!m) return false;
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      return n > 100;
    },
    { timeout: 30000 },
  );
  // Give Three.js a full frame after data settles.
  await page.waitForTimeout(1500);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const nodeMatch = bodyText.match(/([\d,]+)\s+nodes/);
  const reportedNodes = nodeMatch ? parseInt(nodeMatch[1].replace(/,/g, ''), 10) : 0;
  log('sidebar reports >100 nodes', reportedNodes > 100, `reportedNodes=${reportedNodes}`);

  // Default mode is 3D — scene.background = 0x0a0a12 (dark navy).
  await page.screenshot({ path: `${OUT_DIR}/shot-3d-loaded.png` });
  const m3d = await measureCanvasContent(page, 0x0a0a12, 24, `${OUT_DIR}/canvas-3d.png`);
  const tilePct3d = (m3d.fraction * 100).toFixed(2);
  // Threshold is 0.5% — a real graph with 4985 tiles should easily clear
  // this. It's intentionally loose to accommodate upstream layout bugs
  // (e.g. tectonic assigning many nodes to the same hex) while still
  // catching "tiles are completely invisible" regressions.
  log(
    '3D canvas has >0.5% tile pixels in center 50%',
    m3d.fraction > 0.005,
    `${tilePct3d}% (${m3d.hits}/${m3d.total}) samples=${JSON.stringify(m3d.samples)}`,
  );

  // Switch to 2D.
  const btn2D = page.locator('button').filter({ hasText: /^2D$/ }).first();
  await btn2D.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT_DIR}/shot-2d-loaded.png` });
  // 2D default bg is 0xf4f4f4.
  const m2d = await measureCanvasContent(page, 0xf4f4f4, 18, `${OUT_DIR}/canvas-2d.png`);
  const tilePct2d = (m2d.fraction * 100).toFixed(2);
  log(
    '2D canvas has >0.5% tile pixels in center 50%',
    m2d.fraction > 0.005,
    `${tilePct2d}% (${m2d.hits}/${m2d.total}) samples=${JSON.stringify(m2d.samples)}`,
  );
  // Additionally assert that the observed tile color is NOT washed-out
  // toward pure white — DAI-21 pre-fix showed [255,225,255] pale-pink
  // tiles because bloom on white background desaturated them. A real
  // tile should have at least one channel well below 200.
  if (m2d.samples.length > 0) {
    const anyVivid = m2d.samples.some(([r, g, b]) => Math.min(r, g, b) < 200);
    log(
      '2D tile colors are not washed out (min channel < 200)',
      anyVivid,
      `samples=${JSON.stringify(m2d.samples)}`,
    );
  }

  // Also verify the 2D background is actually applied (would catch the
  // "setMode never called" class of bug).
  const bg2d = await page.evaluate(() => {
    const s = window.debugScene;
    return s?.background?.getHexString?.() ?? null;
  });
  if (bg2d) log('2D scene.background === f4f4f4', bg2d === 'f4f4f4', `bg=${bg2d}`);

  // Diagnostic: inspect camera + layout extent.
  const diag = await page.evaluate(() => {
    const s = window.debugScene;
    if (!s) return null;
    // Find camera by walking scene via render loop internal? We expose
    // debugScene = scene, not the SceneManager. Poke the canvas via
    // the layer's first InstancedMesh for extents.
    const mesh = s.children.find((c) => c.type === 'InstancedMesh');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    if (mesh) {
      const m = new Float32Array(16);
      const arr = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count; i++) {
        const x = arr[i * 16 + 12];
        const z = arr[i * 16 + 14];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    return {
      instanceCount: mesh?.count ?? 0,
      bbox: { minX, maxX, minZ, maxZ, width: maxX - minX, height: maxZ - minZ },
      bg: s.background?.getHexString?.() ?? null,
    };
  });
  console.log('DIAG:', JSON.stringify(diag));
} catch (e) {
  log('fatal', false, e.message);
}

await browser.close();

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`\n━━━ ${pass} passed, ${fail} failed ━━━`);
process.exit(fail > 0 ? 1 : 0);
