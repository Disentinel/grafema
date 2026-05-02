/**
 * Lightweight perf logger for DAI-22 stutter hunt.
 *
 * Tag each hot-path call with `perfMark(name)` / `perfMeasure(name, ms)`.
 * Above-threshold spans are emitted to `console.warn` with a `[perf]`
 * prefix so the user can filter the DevTools console:
 *
 *   `[perf] HullLayer.setRegionHulls 12.4ms (visible 380, allocs 0)`
 *   `[perf] toponyms.RAF 8.1ms (cands 320, kept 47)`
 *   `[perf] canvasBuild.applyFrame 2.3ms (bucket 482→501)`
 *
 * Frames under `WARN_MS_THRESHOLD` are silent so the console isn't a
 * waterfall. Tweak via `window.__perfThreshold__ = N` from DevTools.
 */

const WARN_MS_THRESHOLD = 8;

declare global {
  interface Window {
    __perfThreshold__?: number;
    __perfDisabled__?: boolean;
  }
}

function threshold(): number {
  if (typeof window === 'undefined') return WARN_MS_THRESHOLD;
  return window.__perfThreshold__ ?? WARN_MS_THRESHOLD;
}

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.__perfDisabled__;
}

/** Time a single block; emit a warn if it exceeded the threshold. */
export function perfTime<T>(label: string, fn: () => T, extra?: () => string): T {
  if (!enabled()) return fn();
  const start = performance.now();
  const out = fn();
  const dt = performance.now() - start;
  if (dt >= threshold()) {
    const tail = extra ? ` (${extra()})` : '';
    console.warn(`[perf] ${label} ${dt.toFixed(1)}ms${tail}`);
  }
  return out;
}

/** Same as perfTime but returns the elapsed ms separately. */
export function perfTimeSpan<T>(label: string, fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  if (enabled() && ms >= threshold()) {
    console.warn(`[perf] ${label} ${ms.toFixed(1)}ms`);
  }
  return { result, ms };
}

/** Simple counter to detect runaway calls (e.g. a hot path firing
 *  thousands of times per frame). Reports cumulative count + rate. */
const counters = new Map<string, { count: number; lastFlush: number }>();

export function perfCount(label: string): void {
  if (!enabled()) return;
  const now = performance.now();
  const e = counters.get(label) ?? { count: 0, lastFlush: now };
  e.count++;
  if (now - e.lastFlush > 1000) {
    if (e.count > 5) {
      console.warn(`[perf] ${label} fired ${e.count}× in last ${(now - e.lastFlush).toFixed(0)}ms`);
    }
    e.count = 0;
    e.lastFlush = now;
  }
  counters.set(label, e);
}
