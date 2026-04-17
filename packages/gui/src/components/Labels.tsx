import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useDataStore } from '../store/dataStore';
import type { SceneManager } from '../three/SceneManager';

interface LabelCandidate {
  key: string;
  text: string;
  worldX: number;
  worldZ: number;
  priority: number;
  fontSize: number;
  minDist: number; // appear when camera closer than this
  mandatory: boolean; // always visible (region/service labels)
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
    // Read `renderer.domElement` once — canvas element is stable across
    // mode swaps. Camera is re-read every frame in `update` so a
    // perspective ↔ orthographic swap inside SceneManager picks up the
    // new camera reference without a component remount (DAI-12b).
    const canvas = sceneManager.renderer.domElement;

    // Build label candidates once
    const candidates: LabelCandidate[] = [];

    // One label per region — use SERVICE name if available, else region path
    const serviceByRegion = new Map<string, typeof nodes[0]>();
    for (const node of nodes) {
      if (node.type === 'SERVICE') serviceByRegion.set(node.region, node);
    }

    // Aggregate "package-level" labels: one per top-2 path prefix.
    // Centroid is the size-weighted average of member region centroids.
    // These show at any zoom (mandatory + huge minDist).
    const packageGroups = new Map<
      string,
      { cx: number; cz: number; total: number }
    >();
    for (const region of regions) {
      const segs = region.path.split('/');
      if (segs.length < 2) continue;
      const pkg = segs.slice(0, 2).join('/');
      const g = packageGroups.get(pkg);
      const w = region.tileCount || 1;
      if (!g) {
        packageGroups.set(pkg, {
          cx: region.centroid.x * w,
          cz: region.centroid.z * w,
          total: w,
        });
      } else {
        g.cx += region.centroid.x * w;
        g.cz += region.centroid.z * w;
        g.total += w;
      }
    }
    for (const [pkg, g] of packageGroups) {
      candidates.push({
        key: `pkg:${pkg}`,
        text: pkg,
        worldX: g.cx / g.total,
        worldZ: g.cz / g.total,
        priority: 5000 + g.total,
        fontSize: 16,
        minDist: 4000, // always visible
        mandatory: true,
      });
    }

    // Per-region labels with LOD by depth — deeper paths only show when
    // the camera gets closer. Show only the part of the path INSIDE
    // the package (e.g. "src/api" instead of "packages/util/src/api")
    // so the label isn't redundant with the package label above it.
    for (const region of regions) {
      const svc = serviceByRegion.get(region.path);
      const segs = region.path.split('/');
      const depth = segs.length;
      let minDist: number;
      let fontSize: number;
      let mandatory: boolean;
      if (depth <= 2) {
        // Top-level only — already covered by the package label, skip.
        // (kept here for legacy regions that aren't real sub-paths)
        minDist = 4000;
        fontSize = 14;
        mandatory = true;
      } else if (depth === 3) {
        minDist = 220;
        fontSize = 12;
        mandatory = false;
      } else if (depth === 4) {
        minDist = 110;
        fontSize = 11;
        mandatory = false;
      } else {
        minDist = 60;
        fontSize = 10;
        mandatory = false;
      }
      const insideText = depth > 2 ? segs.slice(2).join('/') : region.path;
      candidates.push({
        key: `r:${region.path}`,
        text: svc ? svc.name : insideText,
        worldX: region.centroid.x,
        worldZ: region.centroid.z,
        priority: 2000 + region.tileCount - depth * 10,
        fontSize,
        minDist,
        mandatory,
      });
    }

    for (const node of nodes) {
      // Skip SERVICE — already shown as region label
      if (node.type === 'SERVICE') continue;

      if (node.type === 'EXTERNAL') {
        // Always visible — important external dependencies
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 800 + node.degree,
          fontSize: 10,
          minDist: 500,
          mandatory: true,
        });
      } else if (node.type === 'MODULE' || node.type === 'CLASS' || node.type === 'INTERFACE') {
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 100 + node.degree,
          fontSize: 10,
          minDist: 60,
          mandatory: false,
        });
      } else if (node.type === 'FUNCTION' || node.type === 'METHOD') {
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 10 + node.degree,
          fontSize: 9,
          minDist: 35,
          mandatory: false,
        });
      } else if (node.type === 'VARIABLE' || node.type === 'CONSTANT' || node.type === 'PARAMETER') {
        candidates.push({
          key: `n:${node.id}`,
          text: node.name,
          worldX: node.x,
          worldZ: node.z,
          priority: 5 + node.degree,
          fontSize: 8,
          minDist: 30,
          mandatory: false,
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

      // Fresh per-frame camera read — see comment above.
      const camera = sceneManager.camera;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Effective distance: real distance for perspective, or the ortho
      // equivalent `frustumHeight / zoom`. Per-label minDist thresholds
      // are finer-grained than the four-band lodFromView, so we keep
      // them as-is and only reuse the same effective-distance concept.
      const view = sceneManager.getView();
      const dist =
        view.kind === 'perspective'
          ? view.distance
          : view.frustumHeight / Math.max(view.zoom, 1e-6);

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

        let sx = (vec.x * 0.5 + 0.5) * w;
        let sy = (-vec.y * 0.5 + 0.5) * h;

        // Off-screen or behind camera
        if (vec.z > 1 || sx < -80 || sx > w + 80 || sy < -30 || sy > h + 30) {
          el.style.display = 'none';
          continue;
        }

        const PAD = 4;
        let fontSize = c.fontSize;
        const estW = c.text.length * fontSize * 0.55 + PAD * 2;
        const estH = fontSize * 1.4 + PAD * 2;
        let rx = sx - estW / 2;
        let ry = sy - estH / 2 - 10;

        // Check overlap
        let overlaps = false;
        for (let j = 0; j < placed.length; j++) {
          const p = placed[j];
          if (rx < p.x + p.w && rx + estW > p.x && ry < p.y + p.h && ry + estH > p.y) {
            overlaps = true;
            break;
          }
        }

        if (overlaps && c.mandatory) {
          // Mandatory: try nudging downward, then reduce font
          for (const nudge of [20, -20, 35, -35]) {
            ry = sy - estH / 2 - 10 + nudge;
            rx = sx - estW / 2;
            let nudgeOverlaps = false;
            for (const p of placed) {
              if (rx < p.x + p.w && rx + estW > p.x && ry < p.y + p.h && ry + estH > p.y) {
                nudgeOverlaps = true;
                break;
              }
            }
            if (!nudgeOverlaps) {
              overlaps = false;
              sy += nudge;
              break;
            }
          }
          if (overlaps) {
            // Still overlapping — show with smaller font
            fontSize = 10;
            overlaps = false;
          }
        }

        if (overlaps) {
          el.style.display = 'none';
          continue;
        }

        placed.push({ x: rx, y: ry, w: estW, h: estH });

        el.style.display = '';
        el.style.fontSize = fontSize + 'px';
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
