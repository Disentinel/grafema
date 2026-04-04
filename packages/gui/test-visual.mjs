import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Collect console messages
const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[ERROR] ${err.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
// Wait for rendering
await page.waitForTimeout(2000);

// Print console
console.log('=== Browser Console ===');
for (const l of logs) console.log(l);

// Check canvas
const canvas = await page.$('canvas');
console.log('\n=== Canvas ===');
console.log('Canvas found:', !!canvas);
if (canvas) {
  const box = await canvas.boundingBox();
  console.log('Canvas size:', box?.width, 'x', box?.height);
}

// Check if WebGL context is valid
const glInfo = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return 'no canvas';
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return 'no GL context';
  return `GL OK, ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
});
console.log('GL:', glInfo);

// Take screenshot
await page.screenshot({ path: '/tmp/grafema-gui-test.png', fullPage: false });
console.log('\nScreenshot saved to /tmp/grafema-gui-test.png');

// Check pixel colors on canvas to see if anything rendered
const pixelData = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  // Read pixel from center of canvas
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return null;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  // Sample several positions
  const samples = [];
  for (const [sx, sy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7], [0.4, 0.6]]) {
    const px = Math.floor(w * sx);
    const py = Math.floor(h * sy);
    const pixel = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    samples.push({ x: px, y: py, rgba: Array.from(pixel) });
  }
  return { width: w, height: h, samples };
});
console.log('\n=== Pixel Samples ===');
console.log(JSON.stringify(pixelData, null, 2));

await browser.close();
