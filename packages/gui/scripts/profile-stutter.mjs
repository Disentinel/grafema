#!/usr/bin/env node
/**
 * DAI-22 stutter profiler.
 *
 * Drives Chromium to http://localhost:51833/ui/default via Playwright,
 * waits for the atlas to fully load, then captures a CDP CPU profile
 * while simulating a pan/zoom interaction. Writes the profile as
 * `.cpuprofile` and a `--summary` JSON with the top hot functions.
 *
 * Usage:
 *   node packages/gui/scripts/profile-stutter.mjs [URL] [--seconds N]
 *
 * Output:
 *   /tmp/dai22-stutter.cpuprofile  (load in Chrome DevTools → Performance → Load profile)
 *   /tmp/dai22-stutter.summary.json  (top 30 self-time hotspots)
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const secondsArgIdx = argv.indexOf('--seconds');
const seconds = secondsArgIdx >= 0 ? Number(argv[secondsArgIdx + 1]) : 10;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--seconds');
const url = positional[0] || 'http://localhost:51833/ui/default';

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[perf]')) console.log('  >>', text);
});

console.log(`→ navigating to ${url}`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

console.log('→ waiting for atlas hull cache (max 60s)');
await page.waitForFunction(
  () => {
    // @ts-ignore
    const w = /** @type {any} */ (window);
    return w.__layoutStoreReady || (
      document.querySelectorAll('canvas').length > 0 &&
      document.querySelector('.canvas-container canvas')?.getAttribute('width') !== null
    );
  },
  { timeout: 60_000 },
);
// Extra time for hull priming + first render
await page.waitForTimeout(3_000);

console.log('→ starting CDP profiler');
const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); // 100µs
await cdp.send('Profiler.start');

console.log(`→ simulating pan/zoom for ${seconds}s`);
const canvas = await page.locator('.canvas-container canvas').boundingBox();
if (!canvas) throw new Error('canvas not found');
const cx = canvas.x + canvas.width / 2;
const cy = canvas.y + canvas.height / 2;

const tStart = Date.now();
let panCount = 0;
while ((Date.now() - tStart) / 1000 < seconds) {
  // Pan: drag from center to a random offset
  const dx = (Math.random() - 0.5) * 400;
  const dy = (Math.random() - 0.5) * 400;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'left' });
  // Walk in 10 small steps so OrbitControls fires many 'change' events
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + dx * i / 10, cy + dy * i / 10);
    await page.waitForTimeout(20);
  }
  await page.mouse.up({ button: 'left' });
  // Zoom in/out via wheel
  await page.mouse.wheel(0, (Math.random() - 0.5) * 400);
  await page.waitForTimeout(100);
  panCount++;
}
console.log(`→ ${panCount} pan/zoom cycles done`);

const { profile } = await cdp.send('Profiler.stop');
console.log(`→ profile captured: ${profile.nodes.length} nodes, ${profile.samples?.length ?? 0} samples`);

const profilePath = '/tmp/dai22-stutter.cpuprofile';
writeFileSync(profilePath, JSON.stringify(profile));
console.log(`→ wrote ${profilePath}`);

// Build self-time hot list
const idToNode = new Map(profile.nodes.map((n) => [n.id, n]));
const childrenSeen = new Set();
for (const n of profile.nodes) for (const c of n.children ?? []) childrenSeen.add(c);
const selfHits = new Map(); // id → hits
for (const sampleId of profile.samples ?? []) {
  selfHits.set(sampleId, (selfHits.get(sampleId) ?? 0) + 1);
}
const totalSamples = profile.samples?.length || 1;
const interval = profile.endTime ? (profile.endTime - profile.startTime) / totalSamples : 100; // µs/sample
const hotlist = [...selfHits.entries()]
  .map(([id, hits]) => {
    const n = idToNode.get(id);
    return {
      hits,
      selfMs: ((hits * interval) / 1000),
      function: n?.callFrame?.functionName || '(anonymous)',
      url: n?.callFrame?.url || '',
      line: n?.callFrame?.lineNumber ?? -1,
    };
  })
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, 30);

const summary = {
  url,
  seconds,
  panCount,
  totalSamples,
  durationMs: profile.endTime ? (profile.endTime - profile.startTime) / 1000 : null,
  topSelfTime: hotlist,
};
const summaryPath = '/tmp/dai22-stutter.summary.json';
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`→ wrote ${summaryPath}\n`);

console.log('TOP 15 self-time hotspots:');
for (const h of hotlist.slice(0, 15)) {
  const tail = h.url ? ` ${h.url.split('/').slice(-2).join('/')}:${h.line}` : '';
  console.log(`  ${h.selfMs.toFixed(1).padStart(8)}ms  ${h.function || '(anon)'}${tail}`);
}

await browser.close();
console.log('\n→ done. Open /tmp/dai22-stutter.cpuprofile in Chrome DevTools → Performance.');
