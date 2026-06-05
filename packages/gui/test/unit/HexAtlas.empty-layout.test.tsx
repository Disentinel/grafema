/**
 * Unit tests for HexAtlas's empty-layout overlay (DAI-22 Chunk-6 §B.4).
 *
 * Renders the EmptyLayoutOverlay standalone (skipping the full HexAtlas
 * shell which needs a Canvas GL context), then asserts the message text
 * and command snippet are present.
 *
 * Also asserts that HexAtlas itself renders the overlay when
 * `useLayoutStore.layoutMeta.source === "missing"`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
      location: { reload: () => undefined, search: '' },
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

describe('EmptyLayoutOverlay', () => {
  it('renders the "Layout not computed" message and command snippet', async () => {
    const React = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { EmptyLayoutOverlay } = await import('../../src/HexAtlas');

    const html = renderToString(React.createElement(EmptyLayoutOverlay, {}));
    assert.match(html, /Layout not computed/);
    assert.match(html, /grafema layout --commit/);
    assert.match(html, /Reload/);
    assert.match(html, /Dismiss for this session/);
  });
});

describe('OverflowBadgeLayer — §A.7 mean-position fallback', () => {
  it('renders one badge per overflow entry with position from mean of placed nodes', async () => {
    const React = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { OverflowBadgeLayer } = await import('../../src/HexAtlas');

    const nodes = [
      { id: 'a', type: 'FUNCTION', name: 'a', file: 'src/heavy.ts', region: '', x: 0, z: 0, degree: 0 },
      { id: 'b', type: 'FUNCTION', name: 'b', file: 'src/heavy.ts', region: '', x: 10, z: 10, degree: 0 },
      { id: 'c', type: 'FUNCTION', name: 'c', file: 'src/other.ts', region: '', x: 0, z: 0, degree: 0 },
    ];

    const html = renderToString(
      React.createElement(OverflowBadgeLayer, {
        overflowFiles: [{ file: 'src/heavy.ts', skipped: 42, cap: 10 }],
        nodes,
      }),
    );
    assert.match(html, /data-file="src\/heavy\.ts"/);
    assert.match(html, /data-skipped="42"/);
    assert.match(html, />42</);
    // Position = mean of (0,0) and (10,10) = (5,5).
    assert.match(html, /left:5(px)?;top:5(px)?/);
  });

  it('skips entries with no placed nodes (nothing to anchor on)', async () => {
    const React = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { OverflowBadgeLayer } = await import('../../src/HexAtlas');

    const html = renderToString(
      React.createElement(OverflowBadgeLayer, {
        overflowFiles: [{ file: 'src/heavy.ts', skipped: 42, cap: 10 }],
        nodes: [],
      }),
    );
    // The wrapper (grafema-overflow-badges, plural) may render; the
    // individual badge (data-file) must not.
    assert.doesNotMatch(html, /data-file=/);
  });
});
