/**
 * HexAtlas — host-facing wrapper component.
 *
 * Responsibilities:
 *   1. Provide a single mounting root for the full Hex Atlas UI:
 *      Canvas (Three.js surface), Sidebar (panels), the top-right
 *      ModeToggle, and a status bar.
 *   2. Accept an optional `mode` prop that hosts use to drive scene
 *      mode imperatively — when present, we write it into viewStore
 *      on mount + whenever the prop changes.
 *   3. Accept an optional `source` prop that pre-populates dataStore
 *      from a fixture path or a stream URL via `fetchLayout`. When
 *      absent, HexAtlas falls back to its default bootstrap: URL
 *      params drive live/rust/fixture selection — identical to the
 *      legacy App.tsx behaviour.
 *   4. Stay style-neutral at the root: a full-viewport container
 *      (position: fixed, inset: 0) by default; hosts can swap in
 *      their own wrapper by passing `className`.
 *
 * The panels (FlowPanel, LensPanel, RoutePanel, DiffPanel, PinPanel)
 * already live inside Sidebar, so we do not re-mount them here.
 * Canvas internally mounts CoordGrid, RouteLabels, EdgeLabels as
 * overlay children.
 *
 * Test escape hatch: `skipCanvas`. Canvas needs a WebGL context which
 * node:test does not provide, so the smoke test renders HexAtlas
 * without it. Production mounts never pass `skipCanvas`.
 */

import * as React from 'react';
import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { ModeToggle } from './components/ModeToggle';
import { useViewStore } from './store/viewStore';
import { useDataStore } from './store/dataStore';
import { fetchLayout } from './layout/layoutClient';
import { loadFixture } from './store/loadFixture';
import { loadStream } from './store/loadStream';
import { loadLiveLayout } from './store/loadLiveLayout';
import { initPostMessageAdapter } from './api/PostMessageAdapter';
import { initWebSocketAdapter } from './api/WebSocketAdapter';
import { mapController } from './controller/MapController';
import type { LayoutOptions, LayoutResult, LayoutSource } from './layout/types';
import type { SceneMode } from './three/types';

// Classic JSX runtime compat (see ModeToggle.tsx for why).
// CSS for the shell lives in App.tsx so the Vite bundle picks it up
// once at app entry. Keeping CSS imports out of HexAtlas also lets
// node:test import this module without a CSS loader.
void React;

export interface HexAtlasProps {
  /**
   * Override `viewStore.mode` for the lifetime of this mount.
   * Host-driven imperative control — if absent, HexAtlas leaves
   * viewStore's own default in place (Canvas still syncs SceneManager
   * via its own subscription).
   */
  mode?: SceneMode;
  /**
   * Pre-load a graph from the given source. When present, we trigger
   * `fetchLayout(...)` on mount and pipe the result into
   * `dataStore.setGraphData(...)`. Absent = HexAtlas falls back to
   * its default URL-param bootstrap (?live=, ?rust=, or fixture).
   */
  source?: LayoutSource;
  /**
   * Optional class name applied to the root container. Overrides the
   * default full-viewport positioning if a host wants a custom layout.
   */
  className?: string;
  /**
   * Test-only escape hatch: skip the Canvas child so renderToString
   * can execute without a GL context. Never set in production.
   */
  skipCanvas?: boolean;
}

/**
 * Pure mirror of the `mode`-prop useEffect body.
 *
 * Exported so tests can assert the prop-to-store bridge without
 * mounting. Relies on viewStore.setMode's idempotent guard, so
 * repeated calls with a deep-equal mode do nothing.
 */
export function applyModeOverride(mode: SceneMode | undefined): void {
  if (mode === undefined) return;
  useViewStore.getState().setMode(mode);
}

/**
 * Dependency-injected helpers so the test can inject a mock fetcher
 * + setter pair. Default `deps` uses the real `fetchLayout` and the
 * real dataStore setter.
 */
export interface LoadDeps {
  fetchLayout: (opts: LayoutOptions, signal?: AbortSignal) => Promise<LayoutResult>;
  setGraphData: (data: LayoutResult) => void;
}

/**
 * Pure mirror of the `source`-prop useEffect body.
 *
 * Swallows fetch rejections so a transient network failure does not
 * crash React; consumers who need error reporting should wrap HexAtlas
 * in their own error boundary.
 */
export async function loadFromSource(
  source: LayoutSource | undefined,
  deps: LoadDeps,
  signal?: AbortSignal,
): Promise<void> {
  if (source === undefined) return;
  try {
    const result = await deps.fetchLayout({ source }, signal);
    deps.setGraphData(result);
  } catch (err) {
    // Intentional swallow — log for diagnostics but don't bubble.
     
    console.error('[HexAtlas] fetchLayout failed:', err);
  }
}

interface UrlParams {
  rust: boolean;
  live: boolean;
  packages?: string;
  nodeTypes?: string;
  edgeTypes?: string;
  maxNodes?: number;
  lodLevel?: string;
}

function readUrlParams(): UrlParams {
  if (typeof window === 'undefined') {
    return { rust: false, live: false };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    rust: params.get('rust') === 'true',
    live:
      params.get('live') === 'true' ||
      params.has('packages') ||
      params.has('nodeTypes'),
    packages: params.get('packages') || undefined,
    nodeTypes: params.get('nodeTypes') || undefined,
    edgeTypes: params.get('edgeTypes') || undefined,
    maxNodes: params.get('maxNodes') ? parseInt(params.get('maxNodes')!, 10) : undefined,
    lodLevel: params.get('lodLevel') || undefined,
  };
}

export function HexAtlas({ mode, source, className, skipCanvas }: HexAtlasProps) {
  const [status, setStatus] = useState('');

  // Bridge `mode` prop → viewStore. Runs on mount + whenever the prop
  // identity changes. Deep-equal modes are absorbed by viewStore's
  // idempotent guard, so passing the same object repeatedly is safe.
  useEffect(() => {
    applyModeOverride(mode);
  }, [mode]);

  // Bridge `source` prop → dataStore via fetchLayout. AbortController
  // cancels in-flight loads when the component unmounts or the source
  // changes. Only active when a caller explicitly passed a source.
  useEffect(() => {
    if (source === undefined) return;
    const ctl = new AbortController();
    void loadFromSource(
      source,
      {
        fetchLayout,
        setGraphData: (data) => useDataStore.getState().setGraphData(data),
      },
      ctl.signal,
    );
    return () => ctl.abort();
  }, [source]);

  // Default bootstrap — only runs when the host did NOT pass a source.
  // This mirrors the legacy App.tsx behaviour (URL-param-driven live /
  // rust / fixture selection) so App.tsx can collapse to a single line.
  useEffect(() => {
    if (source !== undefined) return;
    const params = readUrlParams();

    const streamProgress = (phase: string, count: number, total?: number) => {
      switch (phase) {
        case 'header': setStatus('Receiving graph...'); break;
        case 'nodes': setStatus(`Loading nodes: ${count}`); break;
        case 'nodes_done':
          setStatus(`${count} nodes loaded, fetching edges...`);
          break;
        case 'edges': setStatus(`Loading edges: ${count}`); break;
        case 'layout': setStatus(`Running layout for ${count} nodes...`); break;
        case 'done': setStatus(`Done: ${count} nodes, ${total} edges`); break;
        case 'complete': setStatus(''); break;
      }
    };

    if (params.rust || params.live) {
      setStatus('Connecting to RFDB...');
      const loader = params.rust ? loadLiveLayout : loadStream;
      loader({
        packages: params.packages,
        nodeTypes: params.nodeTypes,
        edgeTypes: params.edgeTypes,
        // HullLayer is disabled; stream size is bounded by server build
        // time + client HexLayer cost. 50k nodes → ~14s on the server
        // stream but the client HexLayer (instanced) handles them.
        maxNodes: params.maxNodes ?? 50000,
        lodLevel: params.lodLevel,
        onProgress: streamProgress,
        ...(params.rust
          ? {
              onSAProgress: (
                iteration: number,
                cost: number,
                _temp: number,
                settled: boolean,
              ) => {
                if (settled) {
                  setStatus('');
                } else {
                  setStatus(`SA: iter ${iteration}, cost ${cost}`);
                }
              },
            }
          : {}),
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
         
        console.error('Stream load failed:', err);
        setStatus(`Error: ${msg}. Falling back to fixture.`);
        void loadFixture();
      });
    } else {
      void loadFixture();
    }

    initPostMessageAdapter();
    initWebSocketAdapter();
    // Expose controller + dataStore for console access. DEV-only — we
    // do not leak globals into production hosts. (P2.1)
    if (import.meta.env?.DEV) {
      (window as unknown as Record<string, unknown>).grafema = mapController;
      (window as unknown as Record<string, unknown>).dataStore = useDataStore;
    }
  }, [source]);

  // When no className is supplied we fall back to the `.app` class that
  // App.css provides: `display:flex; position:relative; width:100%;
  // height:100%`. Hosts that don't load App.css can pass a className to
  // opt into their own styling — the inline style fallback below covers
  // the bare minimum so HexAtlas still paints without external CSS.
  const needsInlineFallback =
    className === undefined && typeof document !== 'undefined';
  const rootStyle: React.CSSProperties = needsInlineFallback
    ? {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        width: '100%',
        height: '100%',
      }
    : {};

  return (
    <div className={className ?? 'app'} style={rootStyle}>
      {status && <div className="status-bar">{status}</div>}
      {skipCanvas ? null : <Canvas />}
      <Sidebar />
      <ModeToggle />
    </div>
  );
}

export default HexAtlas;
