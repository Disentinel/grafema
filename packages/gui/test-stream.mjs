import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => logs.push(`[ERR] ${err.message}`));

  // Test rust=true mode (JSONL from Rust + WS SA)
  const url = 'http://localhost:5173/?rust=true&packages=packages/cli/src&maxNodes=200';
  console.log('Loading:', url);
  await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });

  // Poll for tiles to appear
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      tiles: globalThis.__grafemaTileCoords?.size ?? 0,
      status: document.querySelector('.status-bar')?.textContent ?? null,
    }));
    if (i % 5 === 0) console.log(`[${i}s]`, JSON.stringify(s));
    if (s.tiles > 0 && (s.status === null || s.status === '')) {
      console.log(`\n✓ SUCCESS: ${s.tiles} tiles, SA settled at ${i}s`);
      break;
    }
    if (s.tiles > 0 && s.status?.includes('SA:')) {
      console.log(`  SA in progress: ${s.status}`);
    }
  }

  // Relevant logs
  const relevant = logs.filter(l =>
    l.includes('liveLayout') || l.includes('loadStream') || l.includes('[SA]') || l.includes('[ERR]')
  );
  if (relevant.length) {
    console.log('\nRelevant logs:');
    for (const l of relevant.slice(0, 15)) console.log(`  ${l.slice(0, 200)}`);
  }

  try {
    await page.screenshot({ path: '/tmp/hexgraph-rust-sa.png', timeout: 5000 });
    console.log('Screenshot: /tmp/hexgraph-rust-sa.png');
  } catch { console.log('Screenshot timed out'); }

  await page.close();
  await browser.close();
})();
