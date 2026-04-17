import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SceneManager } from '../three/SceneManager';

export interface EdgeLabelData {
  worldX: number;
  worldZ: number;
  worldY: number;
  text: string;
  color?: string;
}

/** Shared mutable array — Canvas writes, EdgeLabels reads each frame */
export const activeEdgeLabels: EdgeLabelData[] = [];

/**
 * HTML overlay for edge type labels on flow tubes.
 * Reads from activeEdgeLabels[] each frame.
 */
export function EdgeLabels({ sceneManager }: { sceneManager: SceneManager | null }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sceneManager || !containerRef.current) return;

    const container = containerRef.current;
    const vec = new THREE.Vector3();
    const camera = sceneManager.camera;
    const canvas = sceneManager.renderer.domElement;
    let elements: HTMLDivElement[] = [];
    let prevCount = -1;

    let running = true;
    const update = () => {
      if (!running) return;
      requestAnimationFrame(update);

      const labels = activeEdgeLabels;

      if (labels.length !== prevCount) {
        for (const el of elements) el.remove();
        elements = [];
        for (const label of labels) {
          const el = document.createElement('div');
          el.className = 'flow-edge-label';
          el.textContent = label.text;
          if (label.color) el.style.color = label.color;
          container.appendChild(el);
          elements.push(el);
        }
        prevCount = labels.length;
      }

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      for (let i = 0; i < labels.length && i < elements.length; i++) {
        const label = labels[i];
        const el = elements[i];
        vec.set(label.worldX, label.worldY, label.worldZ);
        vec.project(camera);
        const sx = (vec.x * 0.5 + 0.5) * w;
        const sy = (-vec.y * 0.5 + 0.5) * h;
        if (vec.z > 1 || sx < -50 || sx > w + 50 || sy < -20 || sy > h + 20) {
          el.style.display = 'none';
        } else {
          el.style.display = '';
          el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
        }
      }
    };
    update();

    return () => {
      running = false;
      for (const el of elements) el.remove();
    };
  }, [sceneManager]);

  return <div ref={containerRef} className="flow-edge-labels-overlay" />;
}
