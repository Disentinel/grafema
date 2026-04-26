/**
 * Unit tests for mapController singleton (controller/MapController).
 *
 * The controller is a renderer-agnostic JSON-RPC facade over the Zustand stores
 * (data/view/route/diff/map). It holds a lazily-injected SceneApi for camera
 * operations like flyTo. All 10 commands must return { ok: true } on success
 * and { ok: false, error } on failure, and handleRPC must dispatch by method name.
 *
 * These tests:
 *  - reset each store to known state before every test (stores are singletons)
 *  - inject a spy-backed mock SceneApi for commands that touch the scene
 *  - verify dispatch to the correct store and correct args passed through
 */

// mapStore.ts reads `window.innerWidth` at module load — shim it for Node.
// Must run BEFORE the store is imported (transitively via mapController),
// so we stub `globalThis.window` here and import the modules dynamically
// below. Top-level `import` would be hoisted above this statement.
(globalThis as unknown as { window: { innerWidth: number; innerHeight: number } }).window = {
  innerWidth: 1024,
  innerHeight: 768,
};

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { mapController } = await import('../../../src/controller/MapController.js');
type SceneApi = import('../../../src/controller/SceneApi.js').SceneApi;
const { useDataStore } = await import('../../../src/store/dataStore.js');
const { useViewStore } = await import('../../../src/store/viewStore.js');
const { useRouteStore } = await import('../../../src/store/routeStore.js');
const { useDiffStore } = await import('../../../src/store/diffStore.js');
const { useMapStore } = await import('../../../src/store/mapStore.js');

// ---------------------------------------------------------------------------
// Manual spy helpers (avoid vitest/jest — node:test only)
// ---------------------------------------------------------------------------

interface Spy<Args extends unknown[] = unknown[]> {
  calls: Args[];
  fn: (...args: Args) => void;
}

function spy<Args extends unknown[]>(): Spy<Args> {
  const calls: Args[] = [];
  const fn = (...args: Args) => {
    calls.push(args);
  };
  return { calls, fn };
}

function makeMockSceneApi(): {
  api: SceneApi;
  flyTo: Spy<[number, number, number | undefined]>;
} {
  const flyToSpy = spy<[number, number, number | undefined]>();
  const api: SceneApi = {
    setMode: () => {},
    getMode: () => ({
      version: 1,
      kind: '3d',
      projection: 'perspective',
      cameraUp: [0, 1, 0],
      frustumSize: 200,
      tileElevation: 'on',
      hoverLift: 0.4,
      flowStyle: 'tube',
      flowDensityCap: 500,
      hullStyle: 'line',
      labelTier: 'package+region+file',
      background: 0x0a0a12,
      ambientOnly: false,
      fog: 'linear',
    }),
    getView: () => ({ kind: 'perspective', distance: 300 }),
    flyTo: flyToSpy.fn,
    fitToScene: () => {},
    setShowCoords: () => {},
    setFlowVisible: () => {},
    recolorFlowsByNodes: () => {},
    applyLens: () => {},
    addRoute: () => {},
    removeRoute: () => {},
    setRouteVisible: () => {},
    pin: () => {},
    unpin: () => {},
    enterDiff: () => {},
    exitDiff: () => {},
    setTargetPositions: () => {},
    dispose: () => {},
    projectWorldToNdc: () => ({ x: 0, y: 0, z: 0 }),
    getScene: () => ({} as unknown as import('three').Scene),
  };
  return { api, flyTo: flyToSpy };
}

// ---------------------------------------------------------------------------
// Store reset — stores are singletons, each test must start from known state
// ---------------------------------------------------------------------------

function resetStores() {
  useDataStore.setState({
    nodes: [],
    edges: [],
    regions: [],
    typeTable: [],
    edgeTypeTable: [],
    loaded: false,
    loading: false,
  });
  useViewStore.setState({
    lens: 'default',
    enabledFlows: new Set(['bridges']),
    hoveredTile: -1,
    pins: new Map(),
    selection: new Set(),
  });
  useRouteStore.setState({ routes: [] });
  useDiffStore.setState({
    active: false,
    added: new Set(),
    removed: new Set(),
    changed: new Map(),
  });
  useMapStore.setState({
    cameraDistance: 300,
    lodLevel: 0,
    target: { x: 0, z: 0 },
    viewport: { width: 1024, height: 768 },
  });
}

// Reset SceneApi to a fresh null each test so we don't leak across tests
function clearSceneApi() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mapController as unknown as { _sceneApi?: SceneApi | null })._sceneApi = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapController.flyTo', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
  });

  it('returns {ok:false} when target node is not found (no scene)', () => {
    const res = mapController.flyTo({ nodeName: 'missing' });
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').includes('not found'));
  });

  it('calls sceneApi.flyTo with (x, z, 800) when node exists', () => {
    const { api, flyTo } = makeMockSceneApi();
    useDataStore.setState({
      nodes: [
        {
          id: 'n1',
          type: 'FUNCTION',
          name: 'existent',
          file: 'src/a.ts',
          region: 'core',
          x: 12,
          z: 34,
          degree: 0,
        },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
    mapController.setScene(api);
    const res = mapController.flyTo({ nodeName: 'existent' });
    assert.equal(res.ok, true);
    assert.equal(flyTo.calls.length, 1);
    assert.deepEqual(flyTo.calls[0], [12, 34, 800]);
  });

  it('returns ok even when no scene is set (silent no-op on camera)', () => {
    useDataStore.setState({
      nodes: [
        {
          id: 'n1',
          type: 'FUNCTION',
          name: 'existent',
          file: 'src/a.ts',
          region: 'core',
          x: 1,
          z: 2,
          degree: 0,
        },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
    const res = mapController.flyTo({ nodeName: 'existent' });
    // Without a scene, camera can't move — but the lookup succeeded
    assert.equal(res.ok, true);
  });
});

describe('mapController.setLens', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
  });

  it('dispatches to viewStore.setLens', () => {
    const res = mapController.setLens({ name: 'complexity' });
    assert.equal(res.ok, true);
    assert.equal(useViewStore.getState().lens, 'complexity');
  });
});

describe('mapController.toggleFlow', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
  });

  it('dispatches to viewStore.toggleFlow — add', () => {
    const res = mapController.toggleFlow({ name: 'deps' });
    assert.equal(res.ok, true);
    assert.ok(useViewStore.getState().enabledFlows.has('deps'));
  });

  it('dispatches to viewStore.toggleFlow — remove', () => {
    // Seed the flow, then toggle it off
    useViewStore.setState({ enabledFlows: new Set(['deps']) });
    const res = mapController.toggleFlow({ name: 'deps' });
    assert.equal(res.ok, true);
    assert.ok(!useViewStore.getState().enabledFlows.has('deps'));
  });
});

describe('mapController.addRoute / removeRoute / toggleRoute', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
    useDataStore.setState({
      nodes: [
        { id: 'n0', type: 'F', name: 'a', file: 'x.ts', region: 'r', x: 0, z: 0, degree: 0 },
        { id: 'n1', type: 'F', name: 'b', file: 'x.ts', region: 'r', x: 1, z: 1, degree: 0 },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
  });

  it('addRoute dispatches to routeStore with resolved indices', () => {
    const res = mapController.addRoute({
      id: 'r1',
      label: 'Route 1',
      color: '#ff0000',
      nodeNames: ['a', 'b'],
    });
    assert.equal(res.ok, true);
    const routes = useRouteStore.getState().routes;
    assert.equal(routes.length, 1);
    assert.equal(routes[0].id, 'r1');
    assert.deepEqual(routes[0].nodeIndices, [0, 1]);
  });

  it('addRoute returns {ok:false} when fewer than 2 valid nodes', () => {
    const res = mapController.addRoute({
      id: 'r1',
      label: 'Route 1',
      color: '#ff0000',
      nodeNames: ['a', 'nonexistent'],
    });
    assert.equal(res.ok, false);
  });

  it('removeRoute dispatches to routeStore', () => {
    useRouteStore.setState({
      routes: [
        { id: 'r1', label: 'R1', color: '#f00', nodeIndices: [0, 1], visible: true },
        { id: 'r2', label: 'R2', color: '#0f0', nodeIndices: [0, 1], visible: true },
      ],
    });
    const res = mapController.removeRoute({ id: 'r1' });
    assert.equal(res.ok, true);
    const routes = useRouteStore.getState().routes;
    assert.equal(routes.length, 1);
    assert.equal(routes[0].id, 'r2');
  });

  it('toggleRoute flips visibility in routeStore', () => {
    useRouteStore.setState({
      routes: [
        { id: 'r1', label: 'R1', color: '#f00', nodeIndices: [0, 1], visible: true },
      ],
    });
    const res = mapController.toggleRoute({ id: 'r1' });
    assert.equal(res.ok, true);
    assert.equal(useRouteStore.getState().routes[0].visible, false);
  });
});

describe('mapController.pin / unpin', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
    useDataStore.setState({
      nodes: [
        { id: 'n0', type: 'F', name: 'pinme', file: 'x.ts', region: 'r', x: 0, z: 0, degree: 0 },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
  });

  it('pin dispatches to viewStore.addPin', () => {
    const res = mapController.pin({ nodeName: 'pinme', color: '#abc' });
    assert.equal(res.ok, true);
    const pins = useViewStore.getState().pins;
    assert.ok(pins.has('n0'));
    assert.equal(pins.get('n0')?.color, '#abc');
    assert.equal(pins.get('n0')?.label, 'pinme');
  });

  it('pin defaults color to red if not provided', () => {
    mapController.pin({ nodeName: 'pinme' });
    const pins = useViewStore.getState().pins;
    assert.equal(pins.get('n0')?.color, '#ff2222');
  });

  it('unpin dispatches to viewStore.removePin', () => {
    useViewStore.setState({
      pins: new Map([['n0', { color: '#ff2222', label: 'pinme' }]]),
    });
    const res = mapController.unpin({ nodeName: 'pinme' });
    assert.equal(res.ok, true);
    assert.ok(!useViewStore.getState().pins.has('n0'));
  });

  it('pin returns {ok:false} for unknown node', () => {
    const res = mapController.pin({ nodeName: 'nonexistent' });
    assert.equal(res.ok, false);
  });
});

describe('mapController.enterDiff / exitDiff', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
    useDataStore.setState({
      nodes: [
        { id: 'n0', type: 'F', name: 'a', file: 'x.ts', region: 'r', x: 0, z: 0, degree: 0 },
        { id: 'n1', type: 'F', name: 'b', file: 'x.ts', region: 'r', x: 1, z: 1, degree: 0 },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
  });

  it('enterDiff dispatches to diffStore with resolved indices', () => {
    const res = mapController.enterDiff({
      removed: ['n0'],
      changed: [{ id: 'n1', changes: { complexity: [3, 5] } }],
    });
    assert.equal(res.ok, true);
    const st = useDiffStore.getState();
    assert.equal(st.active, true);
    assert.ok(st.removed.has(0));
    assert.ok(st.changed.has(1));
    assert.equal(st.changed.get(1)?.[0].field, 'complexity');
    assert.equal(st.changed.get(1)?.[0].from, 3);
    assert.equal(st.changed.get(1)?.[0].to, 5);
  });

  it('exitDiff dispatches to diffStore.exitDiff', () => {
    useDiffStore.setState({
      active: true,
      added: new Set(),
      removed: new Set([0]),
      changed: new Map(),
    });
    const res = mapController.exitDiff();
    assert.equal(res.ok, true);
    assert.equal(useDiffStore.getState().active, false);
  });
});

describe('mapController.getState', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
  });

  it('returns expected shape', () => {
    useDataStore.setState({
      nodes: [
        { id: 'n0', type: 'F', name: 'a', file: 'x.ts', region: 'r', x: 0, z: 0, degree: 0 },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
    useViewStore.setState({ lens: 'complexity', enabledFlows: new Set(['deps']) });
    useRouteStore.setState({
      routes: [{ id: 'r1', label: 'R1', color: '#f00', nodeIndices: [0], visible: true }],
    });
    useMapStore.setState({ cameraDistance: 250 });

    const res = mapController.getState();
    assert.equal(res.ok, true);
    const data = res.data as Record<string, unknown>;
    assert.equal(data.nodeCount, 1);
    assert.equal(data.edgeCount, 0);
    assert.equal(data.lens, 'complexity');
    assert.deepEqual(data.enabledFlows, ['deps']);
    assert.equal(data.cameraDistance, 250);
    assert.deepEqual(data.routes, [{ id: 'r1', label: 'R1', visible: true }]);
  });
});

describe('mapController.handleRPC', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
  });

  it('dispatches setLens by method name', () => {
    const res = mapController.handleRPC({ method: 'setLens', params: { name: 'complexity' } });
    assert.equal(res.ok, true);
    assert.equal(useViewStore.getState().lens, 'complexity');
  });

  it('dispatches exitDiff with no params', () => {
    useDiffStore.setState({
      active: true,
      added: new Set(),
      removed: new Set(),
      changed: new Map(),
    });
    const res = mapController.handleRPC({ method: 'exitDiff' });
    assert.equal(res.ok, true);
    assert.equal(useDiffStore.getState().active, false);
  });

  it('returns {ok:false, error} for unknown method', () => {
    const res = mapController.handleRPC({ method: 'nonExistent' });
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').includes('Unknown method'));
  });
});

describe('mapController.setScene', () => {
  beforeEach(() => {
    resetStores();
    clearSceneApi();
  });

  it('accepts a SceneApi object and routes flyTo through it', () => {
    const { api, flyTo } = makeMockSceneApi();
    mapController.setScene(api);
    useDataStore.setState({
      nodes: [
        { id: 'n0', type: 'F', name: 'a', file: 'x.ts', region: 'r', x: 5, z: 6, degree: 0 },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
      loaded: true,
      loading: false,
    });
    mapController.flyTo({ nodeName: 'a' });
    assert.equal(flyTo.calls.length, 1);
    assert.equal(flyTo.calls[0][0], 5);
    assert.equal(flyTo.calls[0][1], 6);
  });
});
