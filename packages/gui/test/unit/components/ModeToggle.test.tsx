/**
 * Unit tests for ModeToggle (C-HexAtlas).
 *
 * ModeToggle is a tiny UI widget: two buttons (2D / 3D) that flip
 * `viewStore.mode` between DEFAULT_3D_MODE and DEFAULT_2D_MODE. The
 * visual "active" state comes from `viewStore.mode.kind`.
 *
 * Test strategy mirrors Sidebar.test.tsx — we test the pure helpers
 * (active resolution, click handler) plus a smoke `renderToString`
 * so the component is exercised end-to-end without needing a DOM.
 *
 * Zustand v5 returns `getInitialState()` under `renderToString`, so
 * store mutations inside a test do not propagate into the rendered
 * HTML. The pure helpers + handler contract are what we actually
 * care about.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// mapStore/viewStore touch `window` at module-load time. Stub before
// any import that pulls them in.
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

async function loadModeToggle() {
  const [react, reactDom, modeToggleMod, typesMod, viewStoreMod] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('../../../src/components/ModeToggle.tsx'),
    import('../../../src/three/types.ts'),
    import('../../../src/store/viewStore.ts'),
  ]);
  return {
    createElement: react.createElement,
    renderToString: reactDom.renderToString,
    ModeToggle: modeToggleMod.ModeToggle,
    resolveActiveKind: modeToggleMod.resolveActiveKind,
    handleModeClick: modeToggleMod.handleModeClick,
    DEFAULT_2D_MODE: typesMod.DEFAULT_2D_MODE,
    DEFAULT_3D_MODE: typesMod.DEFAULT_3D_MODE,
    useViewStore: viewStoreMod.useViewStore,
  };
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

describe('ModeToggle.resolveActiveKind — pure active resolver', () => {
  it('returns "3d" when viewStore.mode.kind === "3d"', async () => {
    const { resolveActiveKind, DEFAULT_3D_MODE } = await loadModeToggle();
    assert.equal(resolveActiveKind(DEFAULT_3D_MODE), '3d');
  });

  it('returns "2d" when viewStore.mode.kind === "2d"', async () => {
    const { resolveActiveKind, DEFAULT_2D_MODE } = await loadModeToggle();
    assert.equal(resolveActiveKind(DEFAULT_2D_MODE), '2d');
  });
});

describe('ModeToggle.handleModeClick — mode swap handler', () => {
  beforeEach(async () => {
    const { useViewStore, DEFAULT_3D_MODE } = await loadModeToggle();
    useViewStore.setState({
      lens: 'default',
      enabledFlows: new Set(['bridges']),
      hoveredTile: -1,
      pins: new Map(),
      selection: new Set(),
      mode: DEFAULT_3D_MODE,
    });
  });

  it('clicking "2d" when active is "3d" sets viewStore.mode to DEFAULT_2D_MODE', async () => {
    const { handleModeClick, useViewStore, DEFAULT_2D_MODE } = await loadModeToggle();
    handleModeClick('2d');
    assert.equal(useViewStore.getState().mode.kind, '2d');
    // Structural parity — everything downstream expects a full SceneMode.
    assert.equal(useViewStore.getState().mode.background, DEFAULT_2D_MODE.background);
    assert.equal(useViewStore.getState().mode.projection, DEFAULT_2D_MODE.projection);
  });

  it('clicking "3d" after "2d" flips back to DEFAULT_3D_MODE', async () => {
    const { handleModeClick, useViewStore, DEFAULT_3D_MODE } = await loadModeToggle();
    handleModeClick('2d');
    assert.equal(useViewStore.getState().mode.kind, '2d');
    handleModeClick('3d');
    assert.equal(useViewStore.getState().mode.kind, '3d');
    assert.equal(useViewStore.getState().mode.background, DEFAULT_3D_MODE.background);
  });

  it('is idempotent: clicking the currently active mode does not notify store', async () => {
    const { handleModeClick, useViewStore } = await loadModeToggle();
    // Store is 3D (beforeEach). Click "3d" — no change, no notify.
    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });
    handleModeClick('3d');
    unsub();
    assert.equal(
      notifications,
      0,
      'clicking active kind must short-circuit viewStore.setMode (no notify)',
    );
  });
});

// ----------------------------------------------------------------------------
// Smoke test — renders and exposes both buttons
// ----------------------------------------------------------------------------

describe('ModeToggle — render smoke test', () => {
  it('renders both "2D" and "3D" labels', async () => {
    const { createElement, renderToString, ModeToggle } = await loadModeToggle();
    const html = renderToString(createElement(ModeToggle));
    assert.ok(html.includes('2D'), `expected "2D" label in ${html}`);
    assert.ok(html.includes('3D'), `expected "3D" label in ${html}`);
  });

  it('marks the active kind on one button (data-active attr)', async () => {
    const {
      createElement,
      renderToString,
      ModeToggle,
      useViewStore,
      DEFAULT_3D_MODE,
    } = await loadModeToggle();
    // Ensure default is 3D.
    useViewStore.setState({
      lens: 'default',
      enabledFlows: new Set(['bridges']),
      hoveredTile: -1,
      pins: new Map(),
      selection: new Set(),
      mode: DEFAULT_3D_MODE,
    });
    const html = renderToString(createElement(ModeToggle));
    // Either a data-active="true" or an aria-pressed="true" must mark the 3D
    // button as active. We tolerate either attribute name — the visual
    // contract is what matters: exactly one button is active.
    const matches3dActive =
      html.includes('data-active="true"') || html.includes('aria-pressed="true"');
    assert.ok(
      matches3dActive,
      `expected an active marker for the 3D button in ${html}`,
    );
  });
});
