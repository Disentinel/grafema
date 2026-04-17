import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneManager } from '../three/SceneManager';
import { cubeToWorld } from '../geom/hex';

const CUBE_DIRS = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

/**
 * Shows q,r coordinates on hex tiles and nearby empty tiles.
 * Direct DOM — no React re-renders.
 */
export function CoordGrid({ sceneManager, visible }: { sceneManager: SceneManager | null; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sceneManager || !containerRef.current) return;

    const container = containerRef.current;
    const vec = new THREE.Vector3();
    // Camera is re-read per frame inside `update` so mode swaps
    // (perspective ↔ orthographic) pick up the new camera without a
    // remount. Canvas stays stable across swaps (DAI-12b).
    const canvas = sceneManager.renderer.domElement;

    const tileCoords = (globalThis as Record<string, unknown>).__grafemaTileCoords as Map<number, { q: number; r: number }> | undefined;
    const tileSize = ((globalThis as Record<string, unknown>).__grafemaTileSize as number) ?? 3.0;

    if (!tileCoords) return;

    // Collect occupied tiles and expand 5 tiles outward
    const occupied = new Set<string>();
    const allCoords = new Map<string, { q: number; r: number; occupied: boolean; nodeIdx?: number }>();

    for (const [ni, coord] of tileCoords) {
      const key = `${coord.q},${coord.r}`;
      occupied.add(key);
      allCoords.set(key, { q: coord.q, r: coord.r, occupied: true, nodeIdx: ni });
    }

    // BFS expand 5 rings outward from occupied
    const frontier = [...allCoords.values()].map(c => ({ q: c.q, r: c.r, depth: 0 }));
    const visited = new Set(occupied);

    while (frontier.length > 0) {
      const { q, r, depth } = frontier.shift()!;
      if (depth >= 5) continue;
      for (const dir of CUBE_DIRS) {
        const nq = q + dir.q;
        const nr = r + dir.r;
        const key = `${nq},${nr}`;
        if (!visited.has(key)) {
          visited.add(key);
          allCoords.set(key, { q: nq, r: nr, occupied: false });
          frontier.push({ q: nq, r: nr, depth: depth + 1 });
        }
      }
    }

    // Create DOM elements
    const elements: { el: HTMLDivElement; worldX: number; worldZ: number }[] = [];

    for (const [, coord] of allCoords) {
      const { x, z } = cubeToWorld(coord.q, coord.r, tileSize);
      const el = document.createElement('div');
      el.className = 'coord-label';
      el.textContent = `${coord.q},${coord.r}`;
      if (coord.occupied) {
        el.style.color = '#ffcc00';
        el.style.fontWeight = '600';
      }
      container.appendChild(el);
      elements.push({ el, worldX: x, worldZ: z });
    }

    let running = true;
    const update = () => {
      if (!running) return;
      requestAnimationFrame(update);

      if (!visible) {
        for (const { el } of elements) el.style.display = 'none';
        return;
      }

      // Fresh per-frame camera read — see comment above.
      const camera = sceneManager.camera;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      for (const { el, worldX, worldZ } of elements) {
        vec.set(worldX, 0.1, worldZ);
        vec.project(camera);

        const sx = (vec.x * 0.5 + 0.5) * w;
        const sy = (-vec.y * 0.5 + 0.5) * h;

        if (vec.z > 1 || sx < -20 || sx > w + 20 || sy < -10 || sy > h + 10) {
          el.style.display = 'none';
          continue;
        }

        el.style.display = '';
        el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
      }
    };
    update();

    return () => {
      running = false;
      for (const { el } of elements) el.remove();
    };
  }, [sceneManager, visible]);

  return <div ref={containerRef} className="coord-grid-overlay" />;
}
