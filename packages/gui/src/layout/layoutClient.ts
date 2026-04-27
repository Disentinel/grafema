/**
 * Unified layout fetcher: `fetchLayout(opts, signal?) → LayoutResult`.
 *
 * Dispatches between the static-fixture and NDJSON-stream transport
 * primitives without touching any store. The host is responsible for
 * wiring the result into `useDataStore.getState().setGraphData(...)`.
 *
 * This removes the implicit state mutation inside the fetchers and lets
 * tests verify data shape without standing up zustand.
 */

import { parseFixture } from '../store/loadFixture';
import { parseStream } from '../store/loadStream';
import { useDataStore } from '../store/dataStore';
import type { LayoutOptions, LayoutResult } from './types';

export async function fetchLayout(
  opts: LayoutOptions,
  signal?: AbortSignal,
): Promise<LayoutResult> {
  const { source } = opts;
  switch (source.kind) {
    case 'fixture':
      return parseFixture(source.path, signal);
    case 'stream': {
      // Streaming progress → dataStore.progress so the Sidebar (and any
      // other consumer) can render a real loaded/total bar instead of an
      // unbounded spinner. Fixture path is synchronous-ish — no progress
      // wiring there.
      const { setProgress } = useDataStore.getState();
      setProgress({ phase: 'connecting', nodesLoaded: 0, nodesTotal: 0, edgesLoaded: 0, edgesTotal: 0 });
      return parseStream(
        {
          url: source.url,
          maxNodes: opts.maxNodes,
          packages: opts.packages,
          onProgress: (phase, count, total) => {
            switch (phase) {
              case 'totals':
                // count = total nodes, total = total edges (parseStream
                // signature reuses the two-arg shape).
                setProgress({ phase: 'streaming', nodesTotal: count, edgesTotal: total ?? 0 });
                break;
              case 'nodes':
                setProgress({ nodesLoaded: count });
                break;
              case 'nodes_done':
                setProgress({ nodesLoaded: count });
                break;
              case 'edges':
                setProgress({ edgesLoaded: count });
                break;
              case 'done':
                setProgress({ phase: 'done', nodesLoaded: count, edgesLoaded: total ?? 0 });
                break;
            }
          },
        },
        signal,
      );
    }
    default: {
      // Exhaustiveness guard + runtime TypeError for callers that dodge
      // the compile-time discriminated-union check.
      const _never: never = source;
      void _never;
      throw new TypeError(
        `fetchLayout: unknown source kind ${JSON.stringify((opts.source as { kind: unknown }).kind)}`,
      );
    }
  }
}
