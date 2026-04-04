import { useEffect } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { loadFixture } from './store/loadFixture';
import './App.css';

export function App() {
  useEffect(() => {
    loadFixture();
  }, []);

  return (
    <div className="app">
      <Canvas />
      <Sidebar />
    </div>
  );
}
