import { useCallback } from 'react';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { useViewStore } from '../store/viewStore';
import { FlowPanel } from './FlowPanel';
import { RoutePanel } from './RoutePanel';
import { LensPanel } from './LensPanel';
import { flowLayerRef, setShowCoordsRef } from './Canvas';

const LOD_NAMES = ['Package', 'Directory', 'File', 'Function'];

export function Sidebar() {
  const { nodes, edges, regions, loaded, loading } = useDataStore();
  const { lodLevel, cameraDistance } = useMapStore();
  const { enabledFlows } = useViewStore();

  const toggleFlow = useCallback((name: string) => {
    useViewStore.getState().toggleFlow(name);
    // Sync to FlowLayer
    const next = useViewStore.getState().enabledFlows;
    flowLayerRef?.setFlowVisible(name, next.has(name));
  }, []);

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
              Distance: {Math.round(cameraDistance)}
            </div>
          </div>

          <LensPanel />
          <FlowPanel enabledFlows={enabledFlows} onToggle={toggleFlow} />
          <RoutePanel />

          <div>
            <h2>Debug</h2>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#888' }}>
              <input
                type="checkbox"
                onChange={(e) => setShowCoordsRef?.(e.target.checked)}
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
