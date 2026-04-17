import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneManager } from '../three/SceneManager';

export interface EdgeLabelData {
  worldX: number;
  worldZ: number;
  worldY: number;
  text: string;
  color?: string;
}

/**
 * HTML overlay for edge type labels on flow tubes.
 *
 * Reads a caller-owned mutable array each RAF tick. The array is passed
 * via props (not exported from this module) so ownership is explicit —
 * Canvas.tsx keeps the reference as a `useRef` and updates it in place
 * on selection changes; EdgeLabels projects whatever is in the array
 * without caring who wrote it.
 *
 * Camera is read fresh each RAF tick (not cached at effect start) so a
 * SceneManager mode swap (perspective → orthographic) takes effect on the
 * very next frame. Previously the camera reference was captured once at
 * effect mount and became stale when SceneManager rebuilt the camera on
 * projection change (DAI-12b).
 */
export function EdgeLabels({
  sceneManager,
  labels,
}: {
  sceneManager: SceneManager | null;
  labels: EdgeLabelData[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sceneManager || !containerRef.current) return;

    const container = containerRef.current;
    const vec = new THREE.Vector3();
    // Read `renderer.domElement` once — the canvas element is stable across
    // mode swaps. Only `camera` gets rebuilt (ortho ↔ perspective) and so
    // must be re-read per frame below.
    const canvas = sceneManager.renderer.domElement;
    let elements: HTMLDivElement[] = [];
    let prevCount = -1;

    let running = true;
    const update = () => {
      if (!running) return;
      requestAnimationFrame(update);

      // Fresh per-frame camera read — ortho/perspective swap safety.
      const camera = sceneManager.camera;

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
  }, [sceneManager, labels]);

  return <div ref={containerRef} className="flow-edge-labels-overlay" />;
}
