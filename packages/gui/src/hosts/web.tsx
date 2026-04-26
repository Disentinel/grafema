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
  // Stream enough nodes to cover post-DAI-22 full placed-symbol sets
  // (grafema self-analysis: ~27k placed, ~301k excluded = ~328k total).
  // 500k gives headroom for larger bases. Server default (5000) only
  // caught ~340 placed symbols via top-by-degree after EXCLUDED filter,
  // which rendered the atlas as scattered outline-fragments.
  const hasMax = /(^|&)maxNodes=/.test(extra);
  const maxParam = hasMax ? '' : '&maxNodes=500000';
  // Skip edges in the initial stream — flow toggles default to
  // "bridges" only and the user usually never enables the others, so
  // shipping 487k+ `edge` frames upfront is parser overhead for
  // nothing. When the user toggles a flow on, the GUI will fetch
  // edges lazily (TODO: /api/edges endpoint). To force the legacy
  // "ship all edges" behaviour, append `&noEdges=0` (or remove this
  // line) in the query.
  const hasEdges = /(^|&)noEdges=/.test(extra);
  const noEdgesParam = hasEdges ? '' : '&noEdges=1';
  // Same opt-out for the excluded_nodes batch — it's one giant
  // JSON.parse on the client (300k+ entries) that blocks the main
  // thread for seconds, observable as a frozen mouse cursor during
  // ingest. Drop it from the default fetch; the unplaced-nodes
  // search dataset can be re-fetched on demand if/when the user
  // opens that path. Override with `&noExcluded=0` to restore.
  const hasExcluded = /(^|&)noExcluded=/.test(extra);
  const noExcludedParam = hasExcluded ? '' : '&noExcluded=1';
  const query = extra
    ? `db=${encodeURIComponent(db)}&${extra}${maxParam}${noEdgesParam}${noExcludedParam}`
    : `db=${encodeURIComponent(db)}${maxParam}${noEdgesParam}${noExcludedParam}`;
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
