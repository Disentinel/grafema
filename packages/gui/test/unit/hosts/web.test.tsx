/**
 * Unit tests for the production SPA host entry (src/hosts/web.tsx).
 *
 * Scope:
 *   - `parseDbFromUrl()` extracts the `{db}` segment from `/ui/{db}`
 *     URLs and returns `'default'` when no path segment is present.
 *   - `buildSource()` produces a LayoutSource that points at the
 *     co-located rfdb-server's `/api/graph-stream` endpoint, preserving
 *     any `?rust=1` / `?packages=foo` query params the user already
 *     passed.
 *
 * Mount + createRoot is NOT exercised here: the actual mount into
 * #root lives at module-top-level and would pull in the full Canvas
 * stack (WebGL). We cover the pure parsers + builders; any regression
 * in the mount wiring surfaces in Playwright smoke later.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

let prevWindow: unknown;
let prevDocument: unknown;

function stubLocation(pathname: string, search = '') {
  (g.window as { location?: unknown }).location = {
    pathname,
    search,
    href: `http://example.test${pathname}${search}`,
  };
}

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
      location: { pathname: '/', search: '', href: 'http://example.test/' },
    };
  }
  if (g.document === undefined) {
    g.document = {
      getElementById: () => null,
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

// Fresh module import per describe-block: the file mounts on
// import, so we use a dynamic import after location has been stubbed
// and bypass the createRoot call by stubbing getElementById → null
// (createRoot tolerates null only if mount is gated — our host gates
// via document.getElementById('root')).
async function loadWebHost() {
  // Ensure #root is absent so the auto-mount at module-bottom bails
  // out cleanly. parseDbFromUrl + buildSource are pure exports we
  // can call independently.
  (g.document as { getElementById?: unknown }).getElementById = () => null;
  const mod = await import('../../../src/hosts/web.tsx');
  return mod;
}

describe('hosts/web.parseDbFromUrl — path parser', () => {
  beforeEach(() => {
    stubLocation('/');
  });

  it('returns the first segment after /ui/', async () => {
    stubLocation('/ui/mydb');
    const { parseDbFromUrl } = await loadWebHost();
    assert.equal(parseDbFromUrl(), 'mydb');
  });

  it('handles trailing slash (/ui/mydb/)', async () => {
    stubLocation('/ui/another/');
    const { parseDbFromUrl } = await loadWebHost();
    assert.equal(parseDbFromUrl(), 'another');
  });

  it('falls back to "default" when pathname is just "/"', async () => {
    stubLocation('/');
    const { parseDbFromUrl } = await loadWebHost();
    assert.equal(parseDbFromUrl(), 'default');
  });

  it('falls back to "default" when pathname does not match /ui/', async () => {
    stubLocation('/some/other/path');
    const { parseDbFromUrl } = await loadWebHost();
    assert.equal(parseDbFromUrl(), 'default');
  });
});

describe('hosts/web.buildSource — LayoutSource builder', () => {
  it('produces a stream source with encoded db when no query string is present', async () => {
    stubLocation('/ui/mydb', '');
    const { buildSource } = await loadWebHost();
    const src = buildSource();
    assert.deepEqual(src, {
      kind: 'stream',
      url: '/api/graph-stream?db=mydb',
    });
  });

  it('appends the existing query string (e.g. ?rust=1) onto the stream URL', async () => {
    stubLocation('/ui/mydb', '?rust=1');
    const { buildSource } = await loadWebHost();
    const src = buildSource();
    assert.equal(src.kind, 'stream');
    // The URL may be assembled as `db=mydb&rust=1` — we tolerate
    // either order so future refactors of the joiner don't break
    // the test.
    assert.match(
      (src as { url: string }).url,
      /^\/api\/graph-stream\?(db=mydb&rust=1|rust=1&db=mydb)$/,
    );
  });

  it('URL-encodes the db name so special chars produce a safe query param', async () => {
    // Pathnames cannot contain `/` literally inside the {db} segment,
    // so we use a name with characters that must be percent-escaped
    // when placed in a query string (`+`, `&`, `=` etc.).
    stubLocation('/ui/a+b&c', '');
    const { buildSource } = await loadWebHost();
    const src = buildSource();
    // `+`, `&`, `=` must all be percent-escaped in the query string
    // — otherwise the server would parse `a+b&c` as two params.
    assert.doesNotMatch(
      (src as { url: string }).url,
      /db=a\+b&c/,
      'unescaped `+`, `&`, or `=` would be misparsed by the server',
    );
    assert.match(
      (src as { url: string }).url,
      /db=a%2Bb%26c/,
    );
  });

  it('uses "default" when no /ui/{db} segment is present', async () => {
    stubLocation('/');
    const { buildSource } = await loadWebHost();
    const src = buildSource();
    assert.deepEqual(src, {
      kind: 'stream',
      url: '/api/graph-stream?db=default',
    });
  });
});
