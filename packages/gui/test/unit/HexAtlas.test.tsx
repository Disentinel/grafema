/**
 * Unit tests for HexAtlas (C-HexAtlas).
 *
 * HexAtlas is the host-facing wrapper that:
 *   - accepts an optional `mode` prop that, when present, writes
 *     `useViewStore.setState({mode})` on mount + whenever the prop
 *     changes (imperative override for hosts);
 *   - accepts an optional `source` prop that triggers `fetchLayout`
 *     and writes the result into `dataStore.setGraphData`;
 *   - renders `<Canvas>` + the panel set (Sidebar, FlowPanel, LensPanel,
 *     RoutePanel, DiffPanel, PinPanel, CoordGrid, Labels, EdgeLabels,
 *     RouteLabels) under a single root.
 *
 * We cannot mount Canvas in node:test — it constructs a real
 * WebGLRenderer which needs a GL context. Instead we validate:
 *   1. pure helpers HexAtlas exports (applyModeOverride,
 *      loadFromSource) — these are the contract surface, mirrors of
 *      the effect bodies.
 *   2. a smoke render of HexAtlas under renderToString that skips
 *      Canvas via a prop or feature flag.
 *
 * The reason we test the pure helpers instead of full mount is the
 * same reason Sidebar.test.tsx does — Zustand v5 returns the initial
 * snapshot under SSR, so store mutations inside a rendered effect
 * are not observable in the HTML.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// mapStore/viewStore/dataStore touch `window` on import. Stub first.
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

async function loadHexAtlas() {
  const [react, reactDom, hexAtlasMod, typesMod, viewStoreMod, dataStoreMod] =
    await Promise.all([
      import('react'),
      import('react-dom/server'),
      import('../../src/HexAtlas.tsx'),
      import('../../src/three/types.ts'),
      import('../../src/store/viewStore.ts'),
      import('../../src/store/dataStore.ts'),
    ]);
  return {
    createElement: react.createElement,
    renderToString: reactDom.renderToString,
    HexAtlas: hexAtlasMod.HexAtlas,
    default: hexAtlasMod.default,
    applyModeOverride: hexAtlasMod.applyModeOverride,
    loadFromSource: hexAtlasMod.loadFromSource,
    DEFAULT_2D_MODE: typesMod.DEFAULT_2D_MODE,
    DEFAULT_3D_MODE: typesMod.DEFAULT_3D_MODE,
    useViewStore: viewStoreMod.useViewStore,
    useDataStore: dataStoreMod.useDataStore,
  };
}

// ----------------------------------------------------------------------------
// Exports: named + default
// ----------------------------------------------------------------------------

describe('HexAtlas — module exports', () => {
  it('exports a named `HexAtlas` component', async () => {
    const { HexAtlas } = await loadHexAtlas();
    assert.equal(typeof HexAtlas, 'function', 'HexAtlas is a function component');
  });

  it('exports a default that matches the named export', async () => {
    const { HexAtlas, default: def } = await loadHexAtlas();
    assert.equal(def, HexAtlas, 'default export must equal the named export');
  });
});

// ----------------------------------------------------------------------------
// applyModeOverride — pure mirror of the mode-prop useEffect body
// ----------------------------------------------------------------------------

describe('HexAtlas.applyModeOverride — prop-to-store bridge', () => {
  beforeEach(async () => {
    const { useViewStore, DEFAULT_3D_MODE } = await loadHexAtlas();
    useViewStore.setState({
      lens: 'default',
      enabledFlows: new Set(['bridges']),
      hoveredTile: -1,
      pins: new Map(),
      selection: new Set(),
      mode: DEFAULT_3D_MODE,
    });
  });

  it('no-op when `mode` is undefined (no prop → no store write)', async () => {
    const { applyModeOverride, useViewStore, DEFAULT_3D_MODE } = await loadHexAtlas();
    // Default store state: 3D mode.
    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });
    applyModeOverride(undefined);
    unsub();
    assert.equal(notifications, 0, 'undefined prop must not touch store');
    assert.equal(useViewStore.getState().mode.kind, DEFAULT_3D_MODE.kind);
  });

  it('writes to store when `mode` is provided and differs', async () => {
    const { applyModeOverride, useViewStore, DEFAULT_2D_MODE } = await loadHexAtlas();
    applyModeOverride(DEFAULT_2D_MODE);
    assert.equal(useViewStore.getState().mode.kind, '2d');
    assert.equal(
      useViewStore.getState().mode.background,
      DEFAULT_2D_MODE.background,
    );
  });

  it('is idempotent when prop deep-equals current store mode', async () => {
    const { applyModeOverride, useViewStore, DEFAULT_3D_MODE } = await loadHexAtlas();
    // Store is 3D (beforeEach). Pass a structurally-equal but fresh object.
    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });
    applyModeOverride({
      ...DEFAULT_3D_MODE,
      cameraUp: [...DEFAULT_3D_MODE.cameraUp] as [number, number, number],
    });
    unsub();
    assert.equal(
      notifications,
      0,
      'deep-equal mode prop must short-circuit viewStore.setMode',
    );
  });

  it('re-applying after prop change flips mode back and forth', async () => {
    const { applyModeOverride, useViewStore, DEFAULT_2D_MODE, DEFAULT_3D_MODE } =
      await loadHexAtlas();
    applyModeOverride(DEFAULT_2D_MODE);
    assert.equal(useViewStore.getState().mode.kind, '2d');
    applyModeOverride(DEFAULT_3D_MODE);
    assert.equal(useViewStore.getState().mode.kind, '3d');
  });
});

// ----------------------------------------------------------------------------
// loadFromSource — pure mirror of the source-prop useEffect body
// ----------------------------------------------------------------------------

describe('HexAtlas.loadFromSource — source-prop bridge', () => {
  it('no-op when `source` is undefined (no fetch, no store write)', async () => {
    const { loadFromSource } = await loadHexAtlas();
    // Mock fetcher that would record calls if invoked.
    let fetchCount = 0;
    let storeSets = 0;
    await loadFromSource(undefined, {
      fetchLayout: async () => {
        fetchCount += 1;
        return { nodes: [], edges: [], regions: [], typeTable: [], edgeTypeTable: [] };
      },
      setGraphData: () => {
        storeSets += 1;
      },
    });
    assert.equal(fetchCount, 0, 'undefined source must not fetch');
    assert.equal(storeSets, 0, 'undefined source must not touch store');
  });

  it('passes the source through to fetchLayout and writes the result', async () => {
    const { loadFromSource } = await loadHexAtlas();
    let seenSource: unknown = null;
    let setData: unknown = null;
    const fakeResult = {
      nodes: [],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
    };
    await loadFromSource(
      { kind: 'fixture', path: './fixtures/foo.json' },
      {
        fetchLayout: async (opts) => {
          seenSource = opts.source;
          return fakeResult;
        },
        setGraphData: (data) => {
          setData = data;
        },
      },
    );
    assert.deepEqual(seenSource, { kind: 'fixture', path: './fixtures/foo.json' });
    assert.equal(setData, fakeResult);
  });

  it('swallows fetch errors (no throw out of component)', async () => {
    const { loadFromSource } = await loadHexAtlas();
    let setCalled = false;
    // The effect body must not crash React on fetch rejection.
    await assert.doesNotReject(
      loadFromSource(
        { kind: 'stream', url: '/api/bad' },
        {
          fetchLayout: async () => {
            throw new Error('simulated network fail');
          },
          setGraphData: () => {
            setCalled = true;
          },
        },
      ),
    );
    assert.equal(setCalled, false, 'setGraphData must not be called on error');
  });
});

// ----------------------------------------------------------------------------
// Smoke render — verifies the component returns a valid React tree
// ----------------------------------------------------------------------------

describe('HexAtlas — smoke render', () => {
  it('renders "Grafema" header via Sidebar under renderToString', async () => {
    const { createElement, renderToString, HexAtlas } = await loadHexAtlas();
    // skipCanvas: true keeps the test DOM-free — real canvas needs WebGL.
    // The prop is a test-only escape hatch exposed by HexAtlas; production
    // mounts always hit the full Canvas code path.
    const html = renderToString(
      createElement(HexAtlas, { skipCanvas: true }),
    );
    assert.ok(
      html.includes('Grafema'),
      `expected "Grafema" header from Sidebar in ${html}`,
    );
  });

  it('renders the ModeToggle widget labels', async () => {
    const { createElement, renderToString, HexAtlas } = await loadHexAtlas();
    const html = renderToString(
      createElement(HexAtlas, { skipCanvas: true }),
    );
    assert.ok(html.includes('2D'), `expected "2D" from ModeToggle in ${html}`);
    assert.ok(html.includes('3D'), `expected "3D" from ModeToggle in ${html}`);
  });
});
