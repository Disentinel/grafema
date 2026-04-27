import * as React from 'react';
import { useCallback } from 'react';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { useViewStore } from '../store/viewStore';
import type { SceneMode } from '../three/types';
import { useSceneApiOptional } from '../controller/SceneApiContext';
import { mapController } from '../controller/MapController';
import { FlowPanel } from './FlowPanel';
import { RoutePanel } from './RoutePanel';
import { LensPanel } from './LensPanel';
import { DiffPanel } from './DiffPanel';
import { PinPanel } from './PinPanel';
import { FLOWS } from '../config/flows';

// Silence "React imported but unused" under isolatedModules: the JSX
// output references React.createElement via the classic runtime that
// tsx uses in tests. Vite's automatic runtime ignores this import.
void React;

const LOD_NAMES = ['Package', 'Directory', 'File', 'Function'];

/**
 * Pure, stateless formatter for the "View" readout.
 *
 * 3D mode → `Distance: {cameraDistance}` (rounded)
 * 2D mode → `Zoom: {zoom}` (two decimals)
 *
 * Exposed so tests can verify the conditional without mounting the
 * component (Zustand v5 returns `getInitialState()` under SSR, so
 * store mutations made inside a test do not propagate to
 * `renderToString`; testing the pure function sidesteps that).
 */
export function formatViewReadout(
  mode: SceneMode,
  cameraDistance: number,
  zoom: number,
): string {
  return mode.kind === '3d'
    ? `Distance: ${Math.round(cameraDistance)}`
    : `Zoom: ${zoom.toFixed(2)}`;
}

/**
 * Pure formatter for the streaming progress line. Pulled out so unit
 * tests can pin the wording / clamp without standing up React.
 *
 * Format: `Loading: 12,300 / 28,023 nodes (44%)` while nodes still
 * inbound; switches to edges once nodes are at 100% and edge total > 0.
 */
export function formatProgressLine(p: {
  nodesLoaded: number;
  nodesTotal: number;
  edgesLoaded: number;
  edgesTotal: number;
}): string {
  if (p.nodesTotal === 0) return 'Connecting…';
  if (p.nodesLoaded < p.nodesTotal) {
    const pct = Math.min(100, Math.round((p.nodesLoaded / p.nodesTotal) * 100));
    return `${p.nodesLoaded.toLocaleString()} / ${p.nodesTotal.toLocaleString()} nodes (${pct}%)`;
  }
  if (p.edgesTotal > 0) {
    const pct = Math.min(100, Math.round((p.edgesLoaded / p.edgesTotal) * 100));
    return `${p.edgesLoaded.toLocaleString()} / ${p.edgesTotal.toLocaleString()} edges (${pct}%)`;
  }
  return 'Finalizing…';
}

/** Bar width 0..1 derived from progress. Same precedence as formatProgressLine. */
export function progressFraction(p: {
  nodesLoaded: number;
  nodesTotal: number;
  edgesLoaded: number;
  edgesTotal: number;
}): number {
  if (p.nodesTotal === 0) return 0;
  if (p.nodesLoaded < p.nodesTotal) return p.nodesLoaded / p.nodesTotal;
  if (p.edgesTotal > 0) return p.edgesLoaded / p.edgesTotal;
  return 1;
}

export function Sidebar() {
  const { nodes, edges, regions, loaded, loading, progress } = useDataStore();
  const { lodLevel, cameraDistance, zoom } = useMapStore();
  const { enabledFlows, mode } = useViewStore();
  // Sidebar renders OUTSIDE Canvas's SceneApiProvider (it's a sibling
  // in HexAtlas, not a child), so the React-context lookup returns null
  // in production. We resolve the api lazily inside each handler via
  // mapController.getSceneApi() so a Canvas that mounts AFTER Sidebar
  // (the usual order) still wires through. Context fallback covers
  // SSR / pre-mount tests where neither path is available yet.
  const ctxApi = useSceneApiOptional();
  const resolveSceneApi = () => ctxApi ?? mapController.getSceneApi();

  const toggleFlow = useCallback(
    (name: string) => {
      useViewStore.getState().toggleFlow(name);
      const next = useViewStore.getState().enabledFlows;
      const api = resolveSceneApi();
      api?.setFlowVisible(name, next.has(name));
      // Lazy-load this flow's edge types on first enable. Bootstrap
      // fetched with `noEdges=1` so anything other than the always-on
      // Bridges has zero edges to display until we ask for them.
      if (next.has(name) && api) {
        const preset = FLOWS[name];
        if (preset) {
          void api.loadEdgesByTypes(preset.types).catch((e) => {
            console.warn(`[Sidebar] loadEdgesByTypes failed for ${name}:`, e);
          });
        }
      }
    },
    // resolveSceneApi closes over ctxApi; recreate when ctx flips.
    [ctxApi],
  );

  const setAllFlows = useCallback(
    (next: Set<string>) => {
      const prev = useViewStore.getState().enabledFlows;
      useViewStore.getState().setEnabledFlows(next);
      const api = resolveSceneApi();
      const newlyEnabledTypes: string[] = [];
      for (const name of new Set([...prev, ...next])) {
        const wasOn = prev.has(name);
        const nowOn = next.has(name);
        if (wasOn !== nowOn) api?.setFlowVisible(name, nowOn);
        if (!wasOn && nowOn) {
          const preset = FLOWS[name];
          if (preset) newlyEnabledTypes.push(...preset.types);
        }
      }
      if (newlyEnabledTypes.length > 0 && api) {
        // Single batched fetch covering every flow that just turned on
        // — avoids N round-trips when the user clicks "All".
        void api.loadEdgesByTypes(Array.from(new Set(newlyEnabledTypes)))
          .catch((e) => console.warn('[Sidebar] batched loadEdgesByTypes failed:', e));
      }
    },
    [ctxApi],
  );

  return (
    <div className="sidebar">
      <div>
        <h2>Grafema</h2>
        <div className="stats">Hex Map v2</div>
      </div>

      {(loading || progress.phase === 'connecting' || progress.phase === 'streaming') && (
        <div>
          <h2>Loading</h2>
          <div className="stats">{formatProgressLine(progress)}</div>
          <div
            style={{
              marginTop: 6,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.round(progressFraction(progress) * 100)}%`,
                background: '#00e5ff',
                transition: 'width 120ms linear',
              }}
            />
          </div>
        </div>
      )}

      {loaded && (
        <>
          <div>
            <h2>Graph</h2>
            <div className="stats">
              {nodes.length.toLocaleString()} nodes<br />
              {edges.length.toLocaleString()} edges<br />
              {regions.length} regions
            </div>
          </div>

          <div>
            <h2>View</h2>
            <div className="stats">
              LOD: {LOD_NAMES[lodLevel] ?? lodLevel}<br />
              {formatViewReadout(mode, cameraDistance, zoom)}
            </div>
          </div>

          <LensPanel />
          <FlowPanel enabledFlows={enabledFlows} onToggle={toggleFlow} onSetAll={setAllFlows} />
          <RoutePanel />
          <PinPanel />
          <DiffPanel />

          <div>
            <h2>Debug</h2>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#888' }}>
              <input
                type="checkbox"
                onChange={(e) => resolveSceneApi()?.setShowCoords(e.target.checked)}
                style={{ accentColor: '#00e5ff' }}
              />
              Show coords (q,r)
            </label>
          </div>
        </>
      )}
    </div>
  );
}
