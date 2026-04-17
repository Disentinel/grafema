/**
 * Unit tests for SceneApiContext (React context + hooks).
 *
 * We use react-dom/server.renderToString instead of a DOM-based renderer
 * because the monorepo has no jsdom/happy-dom dependency. Context semantics
 * (provider + useContext lookup) work identically under SSR — React still
 * threads the context cursor through the render, so a component mounted
 * inside a provider reads the provider's value, and one mounted without a
 * provider receives the context's default (null in our case).
 *
 * Note on `useSceneApi throws without provider` — React swallows render
 * errors from renderToString and emits them asynchronously. To keep the
 * assertion synchronous, we import the hook and invoke it with a mocked
 * dispatcher via a minimal ReactCurrentDispatcher shim... but that is
 * brittle. Instead, we rely on the documented React SSR behavior:
 * renderToString throws if a component's render function throws and the
 * error is not a Suspense boundary. We test it by assert.throws on the
 * call itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import {
  SceneApiProvider,
  useSceneApi,
  useSceneApiOptional,
} from '../../../src/controller/SceneApiContext.js';
import type { SceneApi } from '../../../src/controller/SceneApi.js';

// ---------------------------------------------------------------------------
// Mock SceneApi — only the fields the test components need
// ---------------------------------------------------------------------------

function mockApi(marker: string): SceneApi {
  return {
    setMode: () => {},
    getMode: () =>
      ({
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
      }) as const,
    getView: () => ({ kind: 'perspective', distance: 300 }),
    flyTo: () => {},
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
    // Tag for assertion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...({ __marker: marker } as any),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSceneApi (required hook)', () => {
  it('throws when used without provider', () => {
    function Probe() {
      useSceneApi();
      return null;
    }
    assert.throws(
      () => renderToString(createElement(Probe)),
      /useSceneApi called outside SceneApiProvider/,
    );
  });

  it('returns the provided api value inside a provider', () => {
    const api = mockApi('PROVIDER-VAL');
    function Probe() {
      const got = useSceneApi();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const marker = (got as any).__marker as string;
      return createElement('span', null, marker);
    }
    const html = renderToString(
      createElement(SceneApiProvider, { api, children: createElement(Probe) }),
    );
    assert.ok(html.includes('PROVIDER-VAL'), `expected PROVIDER-VAL in ${html}`);
  });
});

describe('useSceneApiOptional (optional hook)', () => {
  it('returns null without provider', () => {
    function Probe() {
      const got = useSceneApiOptional();
      return createElement('span', null, got === null ? 'NULL' : 'HAS-VAL');
    }
    const html = renderToString(createElement(Probe));
    assert.ok(html.includes('NULL'), `expected NULL in ${html}`);
  });

  it('returns the provided api value inside a provider', () => {
    const api = mockApi('OPT-VAL');
    function Probe() {
      const got = useSceneApiOptional();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const marker = (got as any)?.__marker as string | undefined;
      return createElement('span', null, marker ?? 'NO-MARKER');
    }
    const html = renderToString(
      createElement(SceneApiProvider, { api, children: createElement(Probe) }),
    );
    assert.ok(html.includes('OPT-VAL'), `expected OPT-VAL in ${html}`);
  });
});

describe('SceneApiProvider accepts null', () => {
  it('useSceneApiOptional returns null when provider value is null', () => {
    function Probe() {
      const got = useSceneApiOptional();
      return createElement('span', null, got === null ? 'NULL' : 'NOT-NULL');
    }
    const html = renderToString(
      createElement(SceneApiProvider, { api: null, children: createElement(Probe) }),
    );
    assert.ok(html.includes('NULL'), `expected NULL in ${html}`);
  });

  it('useSceneApi throws when provider value is null', () => {
    function Probe() {
      useSceneApi();
      return null;
    }
    assert.throws(
      () =>
        renderToString(
          createElement(SceneApiProvider, { api: null, children: createElement(Probe) }),
        ),
      /useSceneApi called outside SceneApiProvider/,
    );
  });
});
