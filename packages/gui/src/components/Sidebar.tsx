import { useState, useCallback } from 'react';
import { useDataStore } from '../store/dataStore';
import { useMapStore } from '../store/mapStore';
import { FlowPanel } from './FlowPanel';
import { flowLayerRef, setShowCoordsRef } from './Canvas';
import { FLOWS } from '../config/flows';

const LOD_NAMES = ['Package', 'Directory', 'File', 'Function'];

export function Sidebar() {
  const { nodes, edges, regions, loaded, loading } = useDataStore();
  const { lodLevel, cameraDistance } = useMapStore();

  // Track enabled flows locally (bridges on by default)
  const [enabledFlows, setEnabledFlows] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const [name, preset] of Object.entries(FLOWS)) {
      if (preset.alwaysOn) initial.add(name);
    }
    return initial;
  });

  const toggleFlow = useCallback((name: string) => {
    setEnabledFlows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      // Update FlowLayer visibility
      flowLayerRef?.setFlowVisible(name, next.has(name));
      return next;
    });
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

          <FlowPanel enabledFlows={enabledFlows} onToggle={toggleFlow} />

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
