// Playwright behavioral verification for HexAtlas + ModeToggle (C-HexAtlas).
// Run after dev server is live at http://localhost:5173.
//
// Steps:
//   1. page loads and ModeToggle top-right visible
//   2. click 2D → scene background = 0xf4f4f4
//   3. click 3D → scene background = 0x0a0a12
//   4. dblclick in 3D pins a node
//   5. switch to 2D → pin visible
//   6. back to 3D → pin persists
//   7. hover nodes in 3D → tooltip visible
//   8. hover in 2D → tooltip visible
//
// Output: one result line per step, plus a summary.

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const results = [];
function record(step, ok, detail = '') {
  results.push({ step, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
   
  console.log(`[${status}] ${step}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[browser-error]', msg.text());
});

try {
  await page.goto(URL, { waitUntil: 'networkidle' });

  // Wait for the scene to initialize (debugScene exposed after Canvas mount).
  await page.waitForFunction(() => typeof window.debugScene !== 'undefined', { timeout: 15000 });

  // Step 1: ModeToggle rendered top-right.
  const toggleBox = await page.locator('button[aria-label="Switch to 2D"]').boundingBox();
  const toggleBox3d = await page.locator('button[aria-label="Switch to 3D"]').boundingBox();
  const topRight =
    toggleBox !== null &&
    toggleBox3d !== null &&
    toggleBox.y < 60 &&
    toggleBox.x > 900;
  record(
    '1. ModeToggle renders top-right',
    topRight,
    topRight
      ? `2D@(${Math.round(toggleBox.x)},${Math.round(toggleBox.y)}) 3D@(${Math.round(toggleBox3d.x)},${Math.round(toggleBox3d.y)})`
      : `2D=${JSON.stringify(toggleBox)} 3D=${JSON.stringify(toggleBox3d)}`,
  );

  // Step 2: Click 2D and confirm background swap.
  await page.locator('button[aria-label="Switch to 2D"]').click();
  await page.waitForTimeout(300);
  const bg2d = await page.evaluate(() => {
    // SceneManager.setMode writes renderer.setClearColor; scene.background is
    // also set to a THREE.Color. We read whichever one is populated.
    const bg = window.debugScene?.background;
    if (bg && typeof bg.getHexString === 'function') return bg.getHexString();
    return null;
  });
  record(
    '2. 2D click → background f4f4f4',
    bg2d === 'f4f4f4',
    `bg=${bg2d ?? 'null'}`,
  );

  // Step 3: Click 3D and confirm background back.
  await page.locator('button[aria-label="Switch to 3D"]').click();
  await page.waitForTimeout(300);
  const bg3d = await page.evaluate(() => {
    const bg = window.debugScene?.background;
    if (bg && typeof bg.getHexString === 'function') return bg.getHexString();
    return null;
  });
  record(
    '3. 3D click → background 0a0a12',
    bg3d === '0a0a12',
    `bg=${bg3d ?? 'null'}`,
  );

  // Step 4: Double-click the canvas to pin a node in 3D.
  const canvas = await page.locator('canvas').first();
  const canvasBox = await canvas.boundingBox();
  const pinX = canvasBox.x + canvasBox.width / 2;
  const pinY = canvasBox.y + canvasBox.height / 2;
  await page.mouse.dblclick(pinX, pinY);
  await page.waitForTimeout(400);
  const pinCount3d = await page.evaluate(() => {
    // viewStore pins map is not exposed; use grafema controller / sidebar
    // "Pins" panel presence as a proxy. The panel only renders when
    // pins.size > 0.
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return -1;
    const text = sidebar.textContent || '';
    return text.includes('Pins') ? 1 : 0;
  });
  record(
    '4. dblclick 3D pins a node',
    pinCount3d >= 1,
    `pin indicator=${pinCount3d}`,
  );

  // Step 5: Switch to 2D, pin still visible (Pins panel still there).
  await page.locator('button[aria-label="Switch to 2D"]').click();
  await page.waitForTimeout(300);
  const pin2d = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    return sidebar && (sidebar.textContent || '').includes('Pins') ? 1 : 0;
  });
  record(
    '5. Switch to 2D → pin panel still visible',
    pin2d >= 1,
    `pin indicator=${pin2d}`,
  );

  // Step 6: Switch to 3D, pin persists.
  await page.locator('button[aria-label="Switch to 3D"]').click();
  await page.waitForTimeout(300);
  const pin3dAgain = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    return sidebar && (sidebar.textContent || '').includes('Pins') ? 1 : 0;
  });
  record(
    '6. Switch back to 3D → pin persists',
    pin3dAgain >= 1,
    `pin indicator=${pin3dAgain}`,
  );

  // Step 7: Hover in 3D triggers tooltip. Pinned node sits near the
  // canvas centre (that's where we dblclicked), so a small reset-then-
  // approach sequence makes the mousemove fire with a new target.
  await page.mouse.move(pinX - 200, pinY - 200);
  await page.waitForTimeout(120);
  await page.mouse.move(pinX, pinY);
  await page.waitForTimeout(500);
  const tip3d = await page.locator('.node-tooltip').count();
  record('7. Hover in 3D shows tooltip', tip3d > 0, `tooltip=${tip3d}`);

  // Step 8: Hover in 2D triggers tooltip.
  await page.locator('button[aria-label="Switch to 2D"]').click();
  await page.waitForTimeout(400);
  await page.mouse.move(pinX - 200, pinY - 200);
  await page.waitForTimeout(120);
  await page.mouse.move(pinX, pinY);
  await page.waitForTimeout(500);
  const tip2d = await page.locator('.node-tooltip').count();
  record('8. Hover in 2D shows tooltip', tip2d > 0, `tooltip=${tip2d}`);
} catch (err) {
  console.log('[EXCEPTION]', err);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log('\n--- SUMMARY ---');
console.log(`${passed}/${results.length} Playwright steps passed`);
process.exit(passed === results.length ? 0 : 1);
