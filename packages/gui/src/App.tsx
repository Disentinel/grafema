import { useEffect } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { loadFixture } from './store/loadFixture';
import { initPostMessageAdapter } from './api/PostMessageAdapter';
import { initWebSocketAdapter } from './api/WebSocketAdapter';
import { mapController } from './api/MapController';
import './App.css';

export function App() {
  useEffect(() => {
    loadFixture();
    initPostMessageAdapter();
    initWebSocketAdapter();
    // Expose controller for console access
    (window as unknown as Record<string, unknown>).grafema = mapController;
  }, []);

  return (
    <div className="app">
      <Canvas />
      <Sidebar />
    </div>
  );
}
