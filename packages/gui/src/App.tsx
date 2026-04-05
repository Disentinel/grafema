import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { loadFixture } from './store/loadFixture';
import { loadStream } from './store/loadStream';
import { initPostMessageAdapter } from './api/PostMessageAdapter';
import { initWebSocketAdapter } from './api/WebSocketAdapter';
import { mapController } from './api/MapController';
import './App.css';

function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    live: params.get('live') === 'true' || params.has('packages') || params.has('nodeTypes'),
    packages: params.get('packages') || undefined,
    nodeTypes: params.get('nodeTypes') || undefined,
    edgeTypes: params.get('edgeTypes') || undefined,
    maxNodes: params.get('maxNodes') ? parseInt(params.get('maxNodes')!, 10) : undefined,
  };
}

export function App() {
  const [status, setStatus] = useState('');

  useEffect(() => {
    const params = getUrlParams();

    if (params.live) {
      setStatus('Connecting to RFDB...');
      loadStream({
        packages: params.packages,
        nodeTypes: params.nodeTypes,
        edgeTypes: params.edgeTypes,
        maxNodes: params.maxNodes,
        onProgress: (phase, count, total) => {
          switch (phase) {
            case 'header': setStatus('Receiving graph...'); break;
            case 'nodes': setStatus(`Loading nodes: ${count}`); break;
            case 'nodes_done': setStatus(`${count} nodes loaded, fetching edges...`); break;
            case 'edges': setStatus(`Loading edges: ${count}`); break;
            case 'layout': setStatus(`Running layout for ${count} nodes...`); break;
            case 'done': setStatus(`Done: ${count} nodes, ${total} edges`); break;
            case 'complete': setStatus(''); break;
          }
        },
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
  }, []);

  return (
    <div className="app">
      {status && <div className="status-bar">{status}</div>}
      <Canvas />
      <Sidebar />
    </div>
  );
}
