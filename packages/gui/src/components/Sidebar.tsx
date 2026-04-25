import * as React from 'react';
import { useCallback } from 'react';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { useViewStore } from '../store/viewStore';
import type { SceneMode } from '../three/types';
import { useSceneApiOptional } from '../controller/SceneApiContext';
import { FlowPanel } from './FlowPanel';
import { RoutePanel } from './RoutePanel';
import { LensPanel } from './LensPanel';
import { DiffPanel } from './DiffPanel';
import { PinPanel } from './PinPanel';

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

export function Sidebar() {
  const { nodes, edges, regions, loaded, loading } = useDataStore();
  const { lodLevel, cameraDistance, zoom } = useMapStore();
  const { enabledFlows, mode } = useViewStore();
  // Optional: Sidebar renders under SSR (no provider) during the pure
  // formatter smoke test. Falls back to store-only state when api is null.
  const sceneApi = useSceneApiOptional();

  const toggleFlow = useCallback(
    (name: string) => {
      useViewStore.getState().toggleFlow(name);
      // Push the new visibility into the scene through the imperative
      // surface. When no api is attached (SSR / pre-mount) the toggle
      // still lands in the store, which Canvas's mount effect reads.
      const next = useViewStore.getState().enabledFlows;
      sceneApi?.setFlowVisible(name, next.has(name));
    },
    [sceneApi],
  );

  const setAllFlows = useCallback(
    (next: Set<string>) => {
      const prev = useViewStore.getState().enabledFlows;
      useViewStore.getState().setEnabledFlows(next);
      // Sync each preset whose visibility flipped — sceneApi is the only
      // path into FlowLayer's per-preset visibility flag.
      for (const name of new Set([...prev, ...next])) {
        const wasOn = prev.has(name);
        const nowOn = next.has(name);
        if (wasOn !== nowOn) sceneApi?.setFlowVisible(name, nowOn);
      }
    },
    [sceneApi],
  );

  return (
    <div className="sidebar">
      <div>
        <h2>Grafema</h2>
        <div className="stats">Hex Map v2</div>
      </div>

      {loading && <div className="stats">Loading graph...</div>}

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
                onChange={(e) => sceneApi?.setShowCoords(e.target.checked)}
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
