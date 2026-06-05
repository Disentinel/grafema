import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  const buf = [];
  const orig = { warn: console.warn, log: console.log, error: console.error };
  for (const k of ['warn', 'log', 'error']) {
    console[k] = (...args) => {
      try { buf.push(`[${k}] ` + args.map(String).join(' ')); } catch {}
      orig[k].apply(console, args);
    };
  }
  Object.defineProperty(window, '__logs', { get: () => buf });
});
await page.goto('http://localhost:51833/ui/default', { waitUntil: 'load', timeout: 60_000 });
for (let i = 0; i < 30; i++) await page.waitForTimeout(2000);
const all = await page.evaluate(() => window.__logs);
console.log('TOTAL LOGS:', all.length);
for (const ln of all.slice(-50)) console.log(ln);
await browser.close();
