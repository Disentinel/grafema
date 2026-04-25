---
name: gui-perf-profiling-cdp
description: |
  Diagnose React + Three.js (or any browser canvas) frame stutter by capturing a CDP CPU profile via Playwright instead of guessing from `[perf]` console logs. Use when:
  (1) frame time is bad but `[perf]` instrumentation doesn't pinpoint the offender,
  (2) you've spent more than ~30 minutes "fixing" suspects without measuring,
  (3) hot paths involve animation systems, allocation bursts, or invisible scene-graph traversal,
  (4) you need self-time per function with line numbers, not aggregate "render slow".
  The `console.warn` pattern is good for monitoring; CDP is needed for diagnosis. Covers script template, sourcemap setup so minified function names are decoded, and interactive variant where the user drives the interaction and signals stop via `touch /tmp/<flag>`.
author: Claude Code
version: 1.0.0
date: 2026-04-25
---

# GUI Performance Profiling via CDP + Playwright

## Problem

You have a Three.js / React scene that stutters under interaction. You added `[perf]` console.warn instrumentation in your render loop. The logs show `_animate 165ms` but they don't tell you **which function inside the frame ate the time**. You then spend hours patching plausible suspects (bloom, scene-graph traversal, lazy mesh allocation) and the stutter only partially improves.

The shortcut you missed: **Chrome DevTools Protocol gives a real CPU profile in 30 seconds**, exposing the actual hot leaf functions.

This is what happened during DAI-22 (atlas stutter hunt). After 4-5 patch iterations on plausible suspects, a CDP profile in one Playwright run revealed `animateTo` taking **14.4 seconds of self-time** in an 8-second window — a function I hadn't even suspected, called from a wholesale `for (i=0; i<27149; i++) animateTo(i, ...)` selection-clear loop.

## Decision rule

If you've spent more than 30 minutes "guessing-and-patching" a perf problem and the next iteration is also a guess — **stop and run a CDP profile first**. Self-time hot list almost always points at the real culprit; intuitions don't.

## Script template (synthetic — driven by the script)

`packages/gui/scripts/profile-stutter.mjs`:

```js
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const secondsArgIdx = argv.indexOf('--seconds');
const seconds = secondsArgIdx >= 0 ? Number(argv[secondsArgIdx + 1]) : 10;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--seconds');
const url = positional[0] || 'http://localhost:3000/';

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

page.on('console', (msg) => {
  if (msg.text().startsWith('[perf]')) console.log('  >>', msg.text());
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
// IMPORTANT: wait long enough for the scene to fully load. Headless
// `networkidle` fires before WebGL upload finishes — overshoot deliberately.
await page.waitForTimeout(3_000);

const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); // 100µs
await cdp.send('Profiler.start');

// Drive the interaction. Tune to reproduce the stutter you're hunting.
const canvas = await page.locator('canvas').first().boundingBox();
const cx = canvas.x + canvas.width / 2;
const cy = canvas.y + canvas.height / 2;
const tStart = Date.now();
while ((Date.now() - tStart) / 1000 < seconds) {
  const dx = (Math.random() - 0.5) * 400;
  const dy = (Math.random() - 0.5) * 400;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'left' });
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + dx * i / 10, cy + dy * i / 10);
    await page.waitForTimeout(20);
  }
  await page.mouse.up({ button: 'left' });
  await page.mouse.wheel(0, (Math.random() - 0.5) * 400);
  await page.waitForTimeout(100);
}

const { profile } = await cdp.send('Profiler.stop');
writeFileSync('/tmp/stutter.cpuprofile', JSON.stringify(profile));

// Build self-time hot list directly — Chrome DevTools is nice but
// terminal output is faster for triage.
const idToNode = new Map(profile.nodes.map((n) => [n.id, n]));
const selfHits = new Map();
for (const id of profile.samples ?? []) selfHits.set(id, (selfHits.get(id) ?? 0) + 1);
const totalUs = profile.endTime - profile.startTime;
const interval = totalUs / (profile.samples?.length || 1);
const hot = [...selfHits.entries()]
  .map(([id, hits]) => {
    const n = idToNode.get(id);
    return { selfMs: (hits * interval) / 1000, fn: n?.callFrame?.functionName || '(anon)',
             url: n?.callFrame?.url || '', line: n?.callFrame?.lineNumber ?? -1 };
  })
  .sort((a, b) => b.selfMs - a.selfMs).slice(0, 20);
for (const h of hot) {
  console.log(`  ${h.selfMs.toFixed(1).padStart(9)}ms  ${h.fn}  ${h.url.split('/').pop()}:${h.line}`);
}
await browser.close();
```

Run with `node packages/gui/scripts/profile-stutter.mjs --seconds 10 http://localhost:51833/ui/default`.

## Interactive variant (user drives the action)

When the stutter only happens during a specific interaction the user knows ("when I rotate AND click"), let them drive:

1. Script opens browser, attaches profiler, then **polls for a sentinel file**: `while (!existsSync('/tmp/stutter-stop')) await new Promise(r => setTimeout(r, 500));`
2. Tell the user: "потыкай в браузере. Когда наберёшь стоп — `touch /tmp/stutter-stop` в шелле".
3. On signal: stop profiler, write report, unlink sentinel, close browser.

The user gets to reproduce the exact gesture; you get the profile of that gesture.

## Decoding minified function names

Production bundles minify — top hot list shows `animateTo HexAtlas-BPUSy0eX.js:4045`, useless without source.

**Two fixes:**

1. **Build with sourcemaps for the profiling session.** In `vite.config.ts` set `build.sourcemap: true`, rebuild, profile. CDP profile carries the original names.
2. **Profile against a dev build** (`vite dev` on a separate port). Function names are unmangled.

If neither is available: grep the bundle for the minified token + surrounding context (`grep -o ".\{60\}animateTo.\{60\}" dist/assets/*.js`) to identify the original.

## Reading the profile

- **`(idle)` at #1** = browser is bored. If your script's interaction time was N seconds and `(idle)` self-time ≈ N seconds, your scene is genuinely fast and the stutter is elsewhere (input handling, layout reflow, scroll).
- **`(garbage collector)` >> 100ms** = allocation pressure. Look for `new` in hot paths.
- **A single function holding > 30% self-time** = your real bottleneck. Open it and look at how often it's called, not how slow each call is.
- Two entries for the same function (`animateTo:4045` × 2) = V8 deopt — the function has two ICs. Same logical function, both contribute.

## Common traps the profile exposes

| Symptom in hot list | Likely cause |
|---|---|
| Animation API (`animateTo`, `tween`, `lerp`) at top | Bulk schedule on selection / lens change. Look for `for (i=0; i<allNodes; i++)` |
| `needsUpdate` setter / `Float32BufferAttribute` | Per-frame buffer reupload of a large array even when 1 element changed |
| `bindVertexArray` × thousands | Many small draw calls — merge into BufferGeometry |
| `setMatrixAt` / `updateMatrixWorld` | Scene graph traversal cost — too many Object3Ds even if `visible=false` |
| `Profiler/(program)` >> work | Sampling overhead — normal at 100µs interval |

## Why this matters

`console.warn('[perf]')` instrumentation gives **per-callback** wall-time. CDP gives **per-leaf-function** self-time. Different granularity, different debug strategy. When a callback is 105ms, instrumentation tells you "callback #0 is slow" — CDP tells you `animateTo` inside callback #0 is being called 50,000 times.

For a stutter that resists patches: switch granularities. The fix follows in one iteration.
