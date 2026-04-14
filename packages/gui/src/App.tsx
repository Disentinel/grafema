import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { loadFixture } from './store/loadFixture';
import { loadStream } from './store/loadStream';
import { loadLiveLayout } from './store/loadLiveLayout';
import { initPostMessageAdapter } from './api/PostMessageAdapter';
import { initWebSocketAdapter } from './api/WebSocketAdapter';
import { mapController } from './api/MapController';
import './App.css';

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    // ?rust=true → use Rust RFDB server (JSONL + WS SA)
    // ?live=true → use Node.js server (JSONL only, client SA)
    rust: params.get('rust') === 'true',
    live: params.get('live') === 'true' || params.has('packages') || params.has('nodeTypes'),
    packages: params.get('packages') || undefined,
    nodeTypes: params.get('nodeTypes') || undefined,
    edgeTypes: params.get('edgeTypes') || undefined,
    maxNodes: params.get('maxNodes') ? parseInt(params.get('maxNodes')!, 10) : undefined,
    lodLevel: params.get('lodLevel') || undefined,
  };
}

export function App() {
  const [status, setStatus] = useState('');

  useEffect(() => {
    const params = getUrlParams();

    const streamProgress = (phase: string, count: number, total?: number) => {
      switch (phase) {
        case 'header': setStatus('Receiving graph...'); break;
        case 'nodes': setStatus(`Loading nodes: ${count}`); break;
        case 'nodes_done': setStatus(`${count} nodes loaded, fetching edges...`); break;
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
        // Default cap raised from 5000 (server default) to 15000 — this
        // hits ~2.4s build time on the real grafema self-analysis and
        // gives ~3x the visible density of the server's 5k default.
        // Explicit ?maxNodes= still overrides.
        maxNodes: params.maxNodes ?? 15000,
        lodLevel: params.lodLevel,
        onProgress: streamProgress,
        ...(params.rust ? {
          onSAProgress: (iteration: number, cost: number, _temp: number, settled: boolean) => {
            if (settled) {
              setStatus('');
            } else {
              setStatus(`SA: iter ${iteration}, cost ${cost}`);
            }
          },
        } : {}),
      }).catch(err => {
        console.error('Stream load failed:', err);
        setStatus(`Error: ${err.message}. Falling back to fixture.`);
        loadFixture();
      });
    } else {
      loadFixture();
    }

    initPostMessageAdapter();
    initWebSocketAdapter();
    // Expose controller for console access
    (window as unknown as Record<string, unknown>).grafema = mapController;
    // Debug: expose dataStore for layout inspection
    import('./store/dataStore').then(m => {
      (window as unknown as Record<string, unknown>).dataStore = m.useDataStore;
    });
  }, []);

  return (
    <div className="app">
      {status && <div className="status-bar">{status}</div>}
      <Canvas />
      <Sidebar />
    </div>
  );
}
