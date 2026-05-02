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
import { useDataStore, type GraphNode } from './store/dataStore';
import { useLayoutStore, type OverflowFile } from './store/layoutStore';
import { meanPosition, placedNodesForFile } from './OverflowBadge';
import { fetchLayout } from './layout/layoutClient';
import { loadFixture } from './store/loadFixture';
import { loadStream, hydrateLayoutStoreFromLayout } from './store/loadStream';
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
    // DAI-22 Chunk-10b: hydrate layoutStore so EmptyLayoutOverlay,
    // OverflowBadge, and HullLayer render. Previously only the URL-
    // param bootstrap path did this; the production SPA host at
    // /ui/{db} passes a source prop and silently missed hydration.
    hydrateLayoutStoreFromLayout(result);
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

/**
 * "Layout not computed" overlay per §B.4. Rendered when the server
 * reports `layout_meta.source === "missing"`. Dismissible within a
 * session (local state only — reappears on page reload since a fresh
 * HexAtlas mount starts with `dismissed=false`).
 */
export interface EmptyLayoutOverlayProps {
  onReload?: () => void;
}

export function EmptyLayoutOverlay({ onReload }: EmptyLayoutOverlayProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const cmd = 'grafema layout --commit';
  const handleReload = () => {
    if (onReload) onReload();
    else if (typeof window !== 'undefined') window.location.reload();
  };

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)',
    zIndex: 1000,
  };
  const panelStyle: React.CSSProperties = {
    background: '#1e1e1e',
    color: '#eee',
    border: '1px solid #444',
    borderRadius: 6,
    padding: '18px 22px',
    maxWidth: 440,
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    lineHeight: 1.5,
    boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
  };
  const codeStyle: React.CSSProperties = {
    display: 'block',
    background: '#0d0d0d',
    color: '#9fefb3',
    padding: '6px 8px',
    borderRadius: 4,
    fontFamily: 'monospace',
    margin: '8px 0 12px',
    userSelect: 'all',
  };
  const btnRow: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 12,
  };
  const primary: React.CSSProperties = {
    background: '#2d7af6',
    color: '#fff',
    border: 0,
    padding: '6px 12px',
    borderRadius: 4,
    cursor: 'pointer',
  };
  const secondary: React.CSSProperties = {
    background: 'transparent',
    color: '#bbb',
    border: '1px solid #555',
    padding: '6px 12px',
    borderRadius: 4,
    cursor: 'pointer',
  };

  return (
    <div className="grafema-empty-layout-overlay" style={overlayStyle} role="dialog" aria-modal="true">
      <div style={panelStyle}>
        <strong style={{ fontSize: 15 }}>Layout not computed.</strong>
        <p style={{ margin: '8px 0' }}>
          Run <code>grafema layout --commit</code> (after <code>grafema analyze</code>)
          and reload this view.
        </p>
        <code style={codeStyle}>{cmd}</code>
        <div style={btnRow}>
          <button type="button" style={secondary} onClick={() => setDismissed(true)}>
            Dismiss for this session
          </button>
          <button type="button" style={primary} onClick={handleReload}>
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Overlay layer that renders one <OverflowBadge> per
 * `layoutMeta.overflow_files` entry, positioned at the mean placed-node
 * position for the file (Chunk-6 fallback; hull centroid in Chunk-7).
 *
 * `nodes` is an explicit prop so the component is trivially testable
 * without a Zustand subscription (Zustand v5 returns the initial
 * snapshot under SSR, which breaks renderToString-based tests).
 */
export interface OverflowBadgeLayerProps {
  overflowFiles: OverflowFile[];
  nodes: ReadonlyArray<GraphNode>;
}

export function OverflowBadgeLayer({ overflowFiles, nodes }: OverflowBadgeLayerProps) {
  if (overflowFiles.length === 0) return null;
  // World→screen projection requires a camera ref from the Three scene —
  // placing <OverflowBadge> with raw world (x, z) as CSS px puts them
  // off-map. Until the ScenApi projector is wired through (follow-up),
  // surface overflow as a compact sidebar chip instead so the signal
  // isn't lost but isn't visually misleading either.
  void nodes;
  void meanPosition;
  void placedNodesForFile;

  const sideStyle: React.CSSProperties = {
    position: 'fixed',
    right: '340px',
    bottom: '12px',
    maxWidth: '320px',
    background: 'rgba(20, 20, 26, 0.82)',
    color: '#ffcccc',
    padding: '8px 10px',
    borderRadius: '6px',
    font: '11px/1.35 monospace',
    border: '1px solid #d32f2f',
    zIndex: 40,
    pointerEvents: 'auto',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  };

  return (
    <div className="grafema-overflow-sidebar" style={sideStyle} data-overflow-count={overflowFiles.length}>
      <div style={{ fontWeight: 600, color: '#ff8080', marginBottom: 4 }}>
        overflow: {overflowFiles.length} file{overflowFiles.length === 1 ? '' : 's'} over cap
      </div>
      {overflowFiles
        .slice(0, 8)
        .sort((a, b) => b.skipped - a.skipped)
        .map((e) => (
          <div key={e.file} title={`${e.skipped} skipped / cap ${e.cap}`}
               style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: '#ff8080' }}>{e.skipped}</span>{' '}
            <span style={{ color: '#aab' }}>{e.file.split('/').slice(-3).join('/')}</span>
          </div>
        ))}
      {overflowFiles.length > 8 && (
        <div style={{ color: '#889', marginTop: 4 }}>
          +{overflowFiles.length - 8} more
        </div>
      )}
    </div>
  );
}

/**
 * Store-connected wrapper — pulls nodes from dataStore so HexAtlas
 * doesn't have to plumb them explicitly. Kept separate from the pure
 * layer above so tests can render the pure component directly.
 */
function ConnectedOverflowBadgeLayer({ overflowFiles }: { overflowFiles: OverflowFile[] }) {
  const nodes = useDataStore((s) => s.nodes);
  return <OverflowBadgeLayer overflowFiles={overflowFiles} nodes={nodes} />;
}

export function HexAtlas({ mode, source, className, skipCanvas }: HexAtlasProps) {
  const [status, setStatus] = useState('');
  const layoutMeta = useLayoutStore((s) => s.layoutMeta);

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
  }, [source]);

  // Debug-surface exposure — runs on mount regardless of whether the
  // host passed `source`. DEV mode OR opt-in via `?debug=1` (for
  // Playwright DAI-22 Chunk-10b verify). Production hosts without the
  // flag stay clean. (P2.1; extended for browser-level assertions.)
  useEffect(() => {
    const debugOptIn =
      typeof window !== 'undefined' &&
      typeof window.location !== 'undefined' &&
      /[?&]debug=1\b/.test(window.location.search);
    if (import.meta.env?.DEV || debugOptIn) {
      (window as unknown as Record<string, unknown>).grafema = mapController;
      (window as unknown as Record<string, unknown>).dataStore = useDataStore;
      (window as unknown as Record<string, unknown>).layoutStore = useLayoutStore;
    }
  }, []);

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

  const showEmptyLayout = layoutMeta?.source === 'missing';
  const overflowFiles = layoutMeta?.overflow_files ?? [];
  const loaded = useDataStore((s) => s.loaded);
  const nodeCount = useDataStore((s) => s.nodes.length);
  const showLoadingOverlay = !loaded && !showEmptyLayout;

  return (
    <div className={className ?? 'app'} style={rootStyle}>
      {status && <div className="status-bar">{status}</div>}
      {skipCanvas ? null : <Canvas />}
      <Sidebar />
      <ModeToggle />
      {overflowFiles.length > 0 && <ConnectedOverflowBadgeLayer overflowFiles={overflowFiles} />}
      {showEmptyLayout && <EmptyLayoutOverlay />}
      {showLoadingOverlay && <LoadingOverlay status={status} nodeCount={nodeCount} />}
    </div>
  );
}

/**
 * Full-screen progress indicator shown while the graph-stream is still
 * populating the dataStore. Dismissed automatically once `loaded` flips
 * true (via `setGraphData` in the loader). Mirrors the EmptyLayoutOverlay
 * shape so the UX feels cohesive.
 */
function LoadingOverlay({ status, nodeCount }: { status: string; nodeCount: number }) {
  const label = status || (nodeCount > 0
    ? `Loading graph… ${nodeCount.toLocaleString()} nodes`
    : 'Loading graph…');
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(2px)',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1rem',
        color: '#cdeafd',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{
          width: 40, height: 40,
          borderRadius: '50%',
          border: '3px solid rgba(0, 200, 255, 0.25)',
          borderTopColor: 'rgba(0, 200, 255, 0.95)',
          animation: 'hexatlas-spin 900ms linear infinite',
        }} />
        <div style={{ fontSize: '0.9rem', letterSpacing: 0.4 }}>{label}</div>
      </div>
      <style>{'@keyframes hexatlas-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

export default HexAtlas;
