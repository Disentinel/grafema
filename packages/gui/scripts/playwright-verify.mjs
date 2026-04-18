import { chromium } from 'playwright';

const PORT = process.env.PORT;
const URL = `http://localhost:${PORT}/ui/default`;

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleErrors = [];
const failedResources = [];
page.on('pageerror', e => consoleErrors.push(e.message));
page.on('response', r => { if (r.status() >= 400) failedResources.push(`${r.status()} ${r.url()}`); });

try {
  // TC-1: page loads, JS executes, root not empty
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
  const title = await page.title();
  log('page title', title === 'Grafema Map', `got="${title}"`);

  const rootHasContent = await page.evaluate(() => {
    const root = document.getElementById('root');
    return root && root.children.length > 0;
  });
  log('#root has React content', rootHasContent);

  log('no console pageerror', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  log('all resources loaded (no 4xx/5xx)', failedResources.length === 0, failedResources.slice(0, 3).join(' | '));

  // TC-2: ModeToggle exists
  const toggleExists = await page.locator('text=2D').count() > 0 && await page.locator('text=3D').count() > 0;
  log('ModeToggle buttons rendered', toggleExists);

  // window.grafema / window.debugScene are DEV-gated (HexAtlas.tsx + canvasBuild.ts).
  // In production bundles they are intentionally absent. Report the state only —
  // never count as failure.
  const hasMapController = await page.evaluate(() => typeof window.grafema !== 'undefined');
  log('window.grafema status (DEV=present, prod=absent)', true, hasMapController ? 'present' : 'absent (prod build)');

  const hasDebugScene = await page.evaluate(() => typeof window.debugScene !== 'undefined');
  log('window.debugScene status (DEV=present, prod=absent)', true, hasDebugScene ? 'present' : 'absent (prod build)');

  // TC-5: 2D mode toggle actually toggles
  const btn2D = page.locator('button').filter({ hasText: '2D' }).first();
  const btn3D = page.locator('button').filter({ hasText: '3D' }).first();

  const bgBefore = await page.evaluate(() => window.debugScene?.background?.getHexString?.() || null);

  await btn2D.click();
  await page.waitForTimeout(500);
  const bgAfter2D = await page.evaluate(() => window.debugScene?.background?.getHexString?.() || null);
  if (bgBefore && bgAfter2D) {
    log('2D click changes scene background', bgBefore !== bgAfter2D, `${bgBefore} -> ${bgAfter2D}`);
  } else {
    log('2D click (DEV probe)', true, 'skipped — no debugScene in prod build');
  }

  await btn3D.click();
  await page.waitForTimeout(500);
  log('3D click works (no error)', consoleErrors.length === 0);

  // TC-6: Canvas rendered (3D)
  const canvasCount = await page.locator('canvas').count();
  log('<canvas> elements present', canvasCount > 0, `count=${canvasCount}`);

  // TC-7: panels present
  const sidebarVisible = await page.locator('.sidebar, [class*="sidebar" i], [class*="Sidebar" i]').count();
  log('sidebar region present', sidebarVisible > 0);

  // Screenshot evidence
  await page.screenshot({ path: '/tmp/rfdb-smoke/screenshot-3d.png', fullPage: false });
  log('screenshot saved', true, '/tmp/rfdb-smoke/screenshot-3d.png');

  await btn2D.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/rfdb-smoke/screenshot-2d.png', fullPage: false });

} catch (e) {
  log('fatal', false, e.message);
}

await browser.close();

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`\n━━━ ${pass} passed, ${fail} failed ━━━`);
process.exit(fail > 0 ? 1 : 0);
