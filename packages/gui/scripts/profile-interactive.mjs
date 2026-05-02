#!/usr/bin/env node
/**
 * Interactive stutter profiler — opens Chromium pointed at the atlas,
 * starts a CDP CPU profile, then waits for the user to create
 * `/tmp/dai22-stop` (e.g. via `touch /tmp/dai22-stop`). Profile and
 * top-self-time summary are written when the file appears.
 *
 * Console `[perf]` lines are echoed live so the user can correlate
 * subjective stutter with the on-screen interaction.
 */
import { chromium } from 'playwright';
import { writeFileSync, existsSync, unlinkSync } from 'fs';

const url = process.argv[2] || 'http://localhost:51833/ui/default';
const stopFile = '/tmp/dai22-stop';
if (existsSync(stopFile)) unlinkSync(stopFile);

const browser = await chromium.launch({ headless: false, args: ['--auto-open-devtools-for-tabs'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleLines = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('[perf]')) {
    consoleLines.push({ t: Date.now(), text });
    console.log('  >>', text);
  }
});

console.log(`→ navigating to ${url}`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

console.log('→ waiting 5s for atlas to settle');
await page.waitForTimeout(5_000);

console.log('→ starting CDP profiler');
const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');

console.log(`\n>>> ПОТЫКАЙ В БРАУЗЕРЕ. Когда наберёшь стоп — выполни в шелле:`);
console.log(`>>>   touch ${stopFile}`);
console.log(`>>> Жду ${stopFile}...\n`);

while (!existsSync(stopFile)) {
  await new Promise((r) => setTimeout(r, 500));
}

console.log('→ stop signal received, capturing profile');
const { profile } = await cdp.send('Profiler.stop');
console.log(`→ ${profile.nodes.length} nodes, ${profile.samples?.length ?? 0} samples`);

writeFileSync('/tmp/dai22-stutter.cpuprofile', JSON.stringify(profile));

const idToNode = new Map(profile.nodes.map((n) => [n.id, n]));
const selfHits = new Map();
for (const id of profile.samples ?? []) selfHits.set(id, (selfHits.get(id) ?? 0) + 1);
const totalSamples = profile.samples?.length || 1;
const totalUs = profile.endTime - profile.startTime;
const interval = totalUs / totalSamples;
const hot = [...selfHits.entries()]
  .map(([id, hits]) => {
    const n = idToNode.get(id);
    return {
      hits,
      selfMs: (hits * interval) / 1000,
      function: n?.callFrame?.functionName || '(anon)',
      url: n?.callFrame?.url || '',
      line: n?.callFrame?.lineNumber ?? -1,
    };
  })
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, 30);

const summary = {
  url,
  totalSamples,
  durationSec: totalUs / 1_000_000,
  topSelfTime: hot,
  perfLines: consoleLines.slice(-100),
};
writeFileSync('/tmp/dai22-stutter.summary.json', JSON.stringify(summary, null, 2));

console.log(`\n=== TOP 20 self-time hotspots over ${(totalUs / 1_000_000).toFixed(1)}s ===`);
for (const h of hot.slice(0, 20)) {
  const tail = h.url ? ` ${h.url.split('/').slice(-1)[0]}:${h.line}` : '';
  console.log(`  ${h.selfMs.toFixed(1).padStart(9)}ms  ${h.function}${tail}`);
}

console.log(`\n→ profile: /tmp/dai22-stutter.cpuprofile (Chrome DevTools → Performance → Load)`);
console.log(`→ summary: /tmp/dai22-stutter.summary.json`);
unlinkSync(stopFile);
await browser.close();
