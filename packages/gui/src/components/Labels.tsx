import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useDataStore } from '../store/dataStore';
import { SceneManager } from '../three/SceneManager';

interface LabelCandidate {
  key: string;
  text: string;
  worldX: number;
  worldZ: number;
  priority: number;
  fontSize: number;
  minDist: number; // appear when camera closer than this
}

/**
 * HTML overlay labels — direct DOM manipulation, no React re-renders.
 * Creates label divs once, updates transform each frame via RAF.
 */
export function Labels({ sceneManager }: { sceneManager: SceneManager | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { nodes, regions, loaded } = useDataStore();

  useEffect(() => {
    if (!sceneManager || !loaded || !containerRef.current) return;

    const container = containerRef.current;
    const vec = new THREE.Vector3();
    const camera = sceneManager.camera;
    const canvas = sceneManager.renderer.domElement;

    // Build label candidates once
    const candidates: LabelCandidate[] = [];

    for (const region of regions) {
      candidates.push({
        key: `r:${region.path}`,
        text: region.path,
        worldX: region.centroid.x,
        worldZ: region.centroid.z,
        priority: 1000 + region.tileCount,
        fontSize: 14,
        minDist: 500,
      });
    }

    for (const node of nodes) {
      if (node.type === 'SERVICE') {
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 500 + node.degree,
          fontSize: 12,
          minDist: 200,
        });
      } else if (node.type === 'MODULE' || node.type === 'CLASS') {
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 100 + node.degree,
          fontSize: 10,
          minDist: 80,
        });
      } else if (node.type === 'FUNCTION' || node.type === 'METHOD') {
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 10 + node.degree,
          fontSize: 9,
          minDist: 40,
        });
      }
    }

    // Sort by priority desc (stable order)
    candidates.sort((a, b) => b.priority - a.priority);

    // Create DOM elements once
    const elements = candidates.map((c) => {
      const el = document.createElement('div');
      el.className = 'map-label';
      el.textContent = c.text;
      el.style.fontSize = c.fontSize + 'px';
      el.style.display = 'none';
      container.appendChild(el);
      return el;
    });

    // Reusable collision rects
    const placed: { x: number; y: number; w: number; h: number }[] = [];

    let running = true;

    const update = () => {
      if (!running) return;
      requestAnimationFrame(update);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dist = sceneManager.getCameraDistance();

      placed.length = 0;

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const el = elements[i];

        // Skip if too far for this label's tier
        if (dist > c.minDist) {
          el.style.display = 'none';
          continue;
        }

        // Project to screen
        vec.set(c.worldX, 0, c.worldZ);
        vec.project(camera);

        const sx = (vec.x * 0.5 + 0.5) * w;
        const sy = (-vec.y * 0.5 + 0.5) * h;

        // Off-screen or behind camera
        if (vec.z > 1 || sx < -80 || sx > w + 80 || sy < -30 || sy > h + 30) {
          el.style.display = 'none';
          continue;
        }

        // Estimate bounding box
        const estW = c.text.length * c.fontSize * 0.55;
        const estH = c.fontSize * 1.4;
        const rx = sx - estW / 2;
        const ry = sy - estH / 2 - 8; // offset above tile

        // Check overlap
        let overlaps = false;
        for (let j = 0; j < placed.length; j++) {
          const p = placed[j];
          if (rx < p.x + p.w && rx + estW > p.x && ry < p.y + p.h && ry + estH > p.y) {
            overlaps = true;
            break;
          }
        }

        if (overlaps) {
          el.style.display = 'none';
          continue;
        }

        placed.push({ x: rx, y: ry, w: estW, h: estH });

        // Position directly via transform (no layout thrash)
        el.style.display = '';
        el.style.transform = `translate(${sx}px, ${sy - 8}px) translate(-50%, -100%)`;
        el.style.opacity = String(Math.min(1, 2 - dist / c.minDist));
      }
    };

    update();

    return () => {
      running = false;
      for (const el of elements) el.remove();
    };
  }, [sceneManager, loaded, nodes, regions]);

  return <div ref={containerRef} className="labels-overlay" />;
}
