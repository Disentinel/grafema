/**
 * Unit tests for mapStore (C-viewStore-mode / DAI-7).
 *
 * mapStore used to read `window.innerWidth/innerHeight` at module load,
 * which breaks under SSR/Node where `window` is undefined. The fix is an
 * SSR-safe initial viewport: fall back to a sane default (1280x720) when
 * `window` is unavailable.
 *
 * This suite covers:
 *   - SSR path: with `globalThis.window` deleted before import, the
 *     module must load and expose viewport={1280,720}.
 *   - Browser path: with a stubbed `window`, viewport must pick up the
 *     stubbed innerWidth/innerHeight.
 *   - `setZoom(n)` updates `zoom` (new field used by the Sidebar ortho
 *     readout).
 *
 * The Node-test runner shares module state across `it` blocks, so each
 * path lives in its own `describe` with a guarded dynamic import. We
 * tear down/restore `globalThis.window` around each import so test
 * order is irrelevant.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers — manage globalThis.window around dynamic imports
// ---------------------------------------------------------------------------

type G = Record<string, unknown>;

function deleteWindow(): unknown {
  const g = globalThis as unknown as G;
  const prev = g.window;
  delete g.window;
  return prev;
}

function stubWindow(width: number, height: number): unknown {
  const g = globalThis as unknown as G;
  const prev = g.window;
  g.window = { innerWidth: width, innerHeight: height, devicePixelRatio: 1 };
  return prev;
}

function restoreWindow(prev: unknown): void {
  const g = globalThis as unknown as G;
  if (prev === undefined) delete g.window;
  else g.window = prev;
}

// Fresh module load on each import path — Node test runner caches ESM
// imports per URL, so we append a unique query to defeat the cache.
let cacheBuster = 0;
async function freshImport(): Promise<typeof import('../../../src/store/mapStore.ts')> {
  cacheBuster += 1;
  return import(
    `../../../src/store/mapStore.ts?bust=${cacheBuster}`
  ) as Promise<typeof import('../../../src/store/mapStore.ts')>;
}

// ---------------------------------------------------------------------------
// SSR — window missing
// ---------------------------------------------------------------------------

describe('mapStore — SSR safe (no window)', () => {
  let prev: unknown;
  before(() => {
    prev = deleteWindow();
  });
  after(() => {
    restoreWindow(prev);
  });

  it('loads without window and uses {1280, 720} viewport fallback', async () => {
    const { useMapStore } = await freshImport();
    const { viewport } = useMapStore.getState();
    assert.equal(viewport.width, 1280, 'fallback width');
    assert.equal(viewport.height, 720, 'fallback height');
  });
});

// ---------------------------------------------------------------------------
// Browser — window stubbed with explicit values
// ---------------------------------------------------------------------------

describe('mapStore — browser (stubbed window)', () => {
  let prev: unknown;
  before(() => {
    prev = stubWindow(1024, 768);
  });
  after(() => {
    restoreWindow(prev);
  });

  it('reads viewport from window.innerWidth/innerHeight', async () => {
    const { useMapStore } = await freshImport();
    const { viewport } = useMapStore.getState();
    assert.equal(viewport.width, 1024);
    assert.equal(viewport.height, 768);
  });
});

// ---------------------------------------------------------------------------
// setZoom — new field for Sidebar ortho readout
// ---------------------------------------------------------------------------

describe('mapStore.setZoom — ortho zoom value for Sidebar', () => {
  let prev: unknown;
  before(() => {
    prev = stubWindow(800, 600);
  });
  after(() => {
    restoreWindow(prev);
  });

  it('defaults to zoom=1', async () => {
    const { useMapStore } = await freshImport();
    assert.equal(useMapStore.getState().zoom, 1);
  });

  it('setZoom(2.5) updates zoom to 2.5', async () => {
    const { useMapStore } = await freshImport();
    useMapStore.getState().setZoom(2.5);
    assert.equal(useMapStore.getState().zoom, 2.5);
  });
});
