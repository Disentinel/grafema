import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SceneManager } from '../three/SceneManager';
import { RouteLayer } from '../three/RouteLayer';

/**
 * HTML overlay for route waypoint labels.
 * Shows step number + node name at each waypoint, colored by route.
 */
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
    const camera = sceneManager.camera;
    const canvas = sceneManager.renderer.domElement;

    let elements: HTMLDivElement[] = [];
    let prevLabelCount = -1;

    let running = true;
    const update = () => {
      if (!running) return;
      requestAnimationFrame(update);

      const labels = routeLayer.waypointLabels;

      // Rebuild DOM elements if label count changed
      if (labels.length !== prevLabelCount) {
        for (const el of elements) el.remove();
        elements = [];
        for (const label of labels) {
          const el = document.createElement('div');
          el.className = 'route-label';
          el.innerHTML = `<span class="rl-step" style="background:${label.routeColor}">${label.step}</span> ${label.name}`;
          el.style.color = label.routeColor;
          container.appendChild(el);
          elements.push(el);
        }
        prevLabelCount = labels.length;
      }

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      for (let i = 0; i < labels.length && i < elements.length; i++) {
        const label = labels[i];
        const el = elements[i];

        vec.set(label.worldX, 2.5, label.worldZ); // above elevated tile
        vec.project(camera);

        const sx = (vec.x * 0.5 + 0.5) * w;
        const sy = (-vec.y * 0.5 + 0.5) * h;

        if (vec.z > 1 || sx < -50 || sx > w + 50 || sy < -20 || sy > h + 20) {
          el.style.display = 'none';
          continue;
        }

        el.style.display = '';
        el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      }
    };
    update();

    return () => {
      running = false;
      for (const el of elements) el.remove();
    };
  }, [sceneManager, routeLayer]);

  return <div ref={containerRef} className="route-labels-overlay" />;
}
