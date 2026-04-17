/**
 * Unit tests for Sidebar — ortho readout (C-viewStore-mode / DAI-9).
 *
 * Before: Sidebar always rendered "Distance: N" regardless of scene
 * mode. In 2D/orthographic mode that number is meaningless (ortho has
 * no distance; you pan and zoom).
 *
 * After: Sidebar reads `viewStore.mode.kind`:
 *   - 3D → "Distance: {cameraDistance}" (existing behavior)
 *   - 2D → "Zoom: {mapStore.zoom}"     (new behavior)
 *
 * `formatViewReadout(mode, cameraDistance, zoom)` is exported from
 * Sidebar so we can unit-test the pure conditional without mounting
 * the full component. Zustand v5's `useSyncExternalStore` returns the
 * initial snapshot under SSR (`renderToString`), so store mutations
 * inside a test would NOT propagate to the rendered output — hence
 * testing the pure formatter is the contract we actually care about.
 *
 * We keep a smoke test for the default mount to ensure imports and
 * module-level side effects (mapStore SSR guard, store creation)
 * still work together.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Window/document stubs — mapStore reads window.innerWidth at module-load
// time, and Sidebar's import graph (through Canvas + Three.js) also touches
// `document`. Install both before any import.
// ---------------------------------------------------------------------------

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

let prevWindow: unknown;
let prevDocument: unknown;

before(() => {
  prevWindow = g.window;
  prevDocument = g.document;
  if (g.window === undefined) {
    g.window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }
  if (g.document === undefined) {
    g.document = {
      createElement: () => ({ style: {}, addEventListener: () => undefined }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }
});

after(() => {
  if (prevWindow === undefined) delete g.window;
  else g.window = prevWindow;
  if (prevDocument === undefined) delete g.document;
  else g.document = prevDocument;
});

// ---------------------------------------------------------------------------
// Deferred imports — after window stub is in place
// ---------------------------------------------------------------------------

async function loadSidebar() {
  const [react, reactDom, sidebarMod, typesMod] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('../../../src/components/Sidebar.tsx'),
    import('../../../src/three/types.ts'),
  ]);
  return {
    createElement: react.createElement,
    renderToString: reactDom.renderToString,
    Sidebar: sidebarMod.Sidebar,
    formatViewReadout: sidebarMod.formatViewReadout,
    DEFAULT_2D_MODE: typesMod.DEFAULT_2D_MODE,
    DEFAULT_3D_MODE: typesMod.DEFAULT_3D_MODE,
  };
}

// ---------------------------------------------------------------------------
// Pure formatter tests — the real contract
// ---------------------------------------------------------------------------

describe('Sidebar.formatViewReadout — pure readout formatter', () => {
  it('3D mode with cameraDistance=100 → "Distance: 100"', async () => {
    const { formatViewReadout, DEFAULT_3D_MODE } = await loadSidebar();
    assert.equal(formatViewReadout(DEFAULT_3D_MODE, 100, 1), 'Distance: 100');
  });

  it('3D mode rounds cameraDistance (e.g., 99.6 → 100)', async () => {
    const { formatViewReadout, DEFAULT_3D_MODE } = await loadSidebar();
    assert.equal(formatViewReadout(DEFAULT_3D_MODE, 99.6, 1), 'Distance: 100');
  });

  it('2D mode with zoom=2 → "Zoom: 2.00" (not "Distance:")', async () => {
    const { formatViewReadout, DEFAULT_2D_MODE } = await loadSidebar();
    const out = formatViewReadout(DEFAULT_2D_MODE, 999, 2);
    assert.ok(out.startsWith('Zoom:'), `expected "Zoom:" prefix, got "${out}"`);
    assert.ok(!out.includes('Distance'), `expected no "Distance" in "${out}"`);
  });

  it('2D mode formats zoom to two decimals', async () => {
    const { formatViewReadout, DEFAULT_2D_MODE } = await loadSidebar();
    assert.equal(formatViewReadout(DEFAULT_2D_MODE, 0, 1.5), 'Zoom: 1.50');
    assert.equal(formatViewReadout(DEFAULT_2D_MODE, 0, 2.333), 'Zoom: 2.33');
  });

  it('kind drives the branch regardless of cameraDistance/zoom values', async () => {
    const { formatViewReadout, DEFAULT_2D_MODE, DEFAULT_3D_MODE } =
      await loadSidebar();
    // 3D with high zoom still shows distance; 2D with high distance shows zoom.
    assert.ok(formatViewReadout(DEFAULT_3D_MODE, 42, 99).startsWith('Distance:'));
    assert.ok(formatViewReadout(DEFAULT_2D_MODE, 42, 99).startsWith('Zoom:'));
  });
});

// ---------------------------------------------------------------------------
// Smoke test — Sidebar mounts and renders the default snapshot
// ---------------------------------------------------------------------------

describe('Sidebar — renders under renderToString', () => {
  it('renders without throwing (default stores, loaded=false)', async () => {
    const { createElement, renderToString, Sidebar } = await loadSidebar();
    const html = renderToString(createElement(Sidebar));
    assert.ok(
      html.includes('Grafema'),
      `expected header "Grafema" in ${html}`,
    );
  });
});
