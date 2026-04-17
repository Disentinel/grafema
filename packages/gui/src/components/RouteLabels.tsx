import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneManager } from '../three/SceneManager';
import type { RouteLayer } from '../three/RouteLayer';

export function RouteLabels({
  sceneManager,
  routeLayer,
}: {
  sceneManager: SceneManager | null;
  routeLayer: RouteLayer | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sceneManager || !routeLayer || !containerRef.current) return;

    const container = containerRef.current;
    const vec = new THREE.Vector3();
    // Camera is re-read per frame inside `update` so mode swaps
    // (perspective ↔ orthographic) pick up the new camera without a
    // remount. Canvas stays stable across swaps (DAI-12b).
    const canvas = sceneManager.renderer.domElement;

    let wpElements: HTMLDivElement[] = [];
    let edgeElements: HTMLDivElement[] = [];
    let prevWpCount = -1;
    let prevEdgeCount = -1;

    let running = true;
    const update = () => {
      if (!running) return;
      requestAnimationFrame(update);

      // Fresh per-frame camera read — see comment above.
      const camera = sceneManager.camera;

      const wpLabels = routeLayer.waypointLabels;
      const edgeLabels = routeLayer.edgeLabels;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      // Rebuild waypoint elements
      if (wpLabels.length !== prevWpCount) {
        for (const el of wpElements) el.remove();
        wpElements = [];
        for (const label of wpLabels) {
          const el = document.createElement('div');
          el.className = 'route-label';
          el.innerHTML = `<span class="rl-step" style="background:${label.routeColor}">${label.step}</span> ${label.name}`;
          el.style.color = label.routeColor;
          container.appendChild(el);
          wpElements.push(el);
        }
        prevWpCount = wpLabels.length;
      }

      // Rebuild edge type elements
      if (edgeLabels.length !== prevEdgeCount) {
        for (const el of edgeElements) el.remove();
        edgeElements = [];
        for (const label of edgeLabels) {
          const el = document.createElement('div');
          el.className = 'route-edge-label';
          el.textContent = label.edgeType;
          el.style.color = label.routeColor;
          container.appendChild(el);
          edgeElements.push(el);
        }
        prevEdgeCount = edgeLabels.length;
      }

      // Position waypoint labels
      for (let i = 0; i < wpLabels.length && i < wpElements.length; i++) {
        const label = wpLabels[i];
        vec.set(label.worldX, 2.5, label.worldZ);
        vec.project(camera);
        const sx = (vec.x * 0.5 + 0.5) * w;
        const sy = (-vec.y * 0.5 + 0.5) * h;
        const el = wpElements[i];
        if (vec.z > 1 || sx < -50 || sx > w + 50 || sy < -20 || sy > h + 20) {
          el.style.display = 'none';
        } else {
          el.style.display = '';
          el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
        }
      }

      // Position edge type labels
      for (let i = 0; i < edgeLabels.length && i < edgeElements.length; i++) {
        const label = edgeLabels[i];
        vec.set(label.worldX, label.worldY, label.worldZ);
        vec.project(camera);
        const sx = (vec.x * 0.5 + 0.5) * w;
        const sy = (-vec.y * 0.5 + 0.5) * h;
        const el = edgeElements[i];
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
      for (const el of wpElements) el.remove();
      for (const el of edgeElements) el.remove();
    };
  }, [sceneManager, routeLayer]);

  return <div ref={containerRef} className="route-labels-overlay" />;
}
