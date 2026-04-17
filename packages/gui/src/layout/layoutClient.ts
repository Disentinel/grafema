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
import type { LayoutOptions, LayoutResult } from './types';

export async function fetchLayout(
  opts: LayoutOptions,
  signal?: AbortSignal,
): Promise<LayoutResult> {
  const { source } = opts;
  switch (source.kind) {
    case 'fixture':
      return parseFixture(source.path, signal);
    case 'stream':
      return parseStream(
        {
          url: source.url,
          maxNodes: opts.maxNodes,
          packages: opts.packages,
        },
        signal,
      );
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
