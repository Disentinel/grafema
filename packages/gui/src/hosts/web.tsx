/**
 * Production SPA host — mounts `<HexAtlas>` against the rfdb-server
 * that serves this bundle (same origin).
 *
 * URL shape: `/ui/{db}` (+ optional `?rust=1&packages=…` query params).
 * We derive `db` from the pathname and pass the full query string
 * through so server-side filtering (packages, nodeTypes, rust-SA
 * layout) keeps working exactly the way the dev overlay does.
 */
import { createRoot } from 'react-dom/client';
import HexAtlas from '../HexAtlas';
import type { LayoutSource } from '../layout/types';

/**
 * Extract the first path segment after `/ui/` from the browser
 * pathname. `'/ui/mydb'` → `'mydb'`, `'/ui/mydb/'` → `'mydb'`,
 * everything else → `'default'`. Exported for tests.
 */
export function parseDbFromUrl(): string {
  if (typeof window === 'undefined') return 'default';
  const match = window.location.pathname.match(/^\/ui\/([^/]+)/);
  return match?.[1] ?? 'default';
}

/**
 * Build the `LayoutSource` for the current URL — points at the
 * serving rfdb-server's graph-stream endpoint, preserving any
 * existing query string the user passed.
 */
export function buildSource(): LayoutSource {
  const db = parseDbFromUrl();
  const search =
    typeof window === 'undefined' ? '' : window.location.search;
  // Strip the leading `?` from the browser-supplied search and
  // glue it onto our pre-built db= query so the order stays
  // `db=…&rust=1` which is the canonical form the server sees.
  const extra = search.startsWith('?') ? search.slice(1) : search;
  const query = extra ? `db=${encodeURIComponent(db)}&${extra}` : `db=${encodeURIComponent(db)}`;
  return { kind: 'stream', url: `/api/graph-stream?${query}` };
}

/**
 * Mount the SPA into #root. Exported separately so the module can
 * be imported from node:test without running the mount (tests don't
 * have a DOM, nor a CSS loader).
 *
 * Vite picks up the CSS side-effect import inside the mount body;
 * node:test never reaches it because the entry HTML is the only
 * caller.
 */
export async function mount(rootEl: HTMLElement): Promise<void> {
  await import('../App.css');
  createRoot(rootEl).render(<HexAtlas source={buildSource()} />);
}

if (typeof document !== 'undefined') {
  const rootEl = document.getElementById('root');
  if (rootEl) void mount(rootEl);
}
