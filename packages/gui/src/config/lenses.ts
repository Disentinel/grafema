import type { GraphNode } from '../store/dataStore';
import * as THREE from 'three';
import { hueFromString } from '../geom/color';
import { useLayoutStore, type RegionTree } from '../store/layoutStore';
import { computeFolderHues } from '../hulls/folderHues';

export interface Lens {
  label: string;
  colorFn: (node: GraphNode, allNodes: GraphNode[]) => THREE.Color;
  legend?: 'gradient' | 'categorical';
}

/** Shorter local alias — every caller below uses the shared hash. */
const strHash = hueFromString;

const TYPE_LIGHTNESS: Record<string, number> = {
  SERVICE: 55, MODULE: 42, CLASS: 45, INTERFACE: 43,
  FUNCTION: 35, METHOD: 33, GETTER: 33, VARIABLE: 28,
  PARAMETER: 26, CONSTANT: 40, CALL: 25, EXPRESSION: 22,
  LITERAL: 20, IMPORT: 30, EXPORT: 32, EXTERNAL: 38,
  PROPERTY_ACCESS: 25, PROJECT: 50,
};

/** Heatmap: cold (dark blue) → warm (orange) → hot (red) */
function heatmapColor(t: number): THREE.Color {
  // t ∈ [0, 1]
  const c = new THREE.Color();
  if (t < 0.5) {
    // blue → cyan → green
    c.setHSL(0.55 - t * 0.5, 0.7, 0.2 + t * 0.3);
  } else {
    // green → yellow → red
    c.setHSL(0.15 - (t - 0.5) * 0.3, 0.8, 0.3 + (t - 0.5) * 0.2);
  }
  return c;
}

function normalizeMetric(nodes: GraphNode[], metric: string): Map<number, number> {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const v = nodes[i].metrics?.[metric] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const result = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    result.set(i, ((nodes[i].metrics?.[metric] ?? 0) - min) / range);
  }
  return result;
}

// Caches for normalized metrics (rebuilt per lens switch)
let cachedMetric = '';
let cachedNorm = new Map<number, number>();

function getNormalized(nodes: GraphNode[], metric: string): Map<number, number> {
  if (cachedMetric !== metric) {
    cachedMetric = metric;
    cachedNorm = normalizeMetric(nodes, metric);
  }
  return cachedNorm;
}

/** Take the first N segments of a slash-separated path. */
function topSegments(path: string, n: number): string {
  const parts = path.split('/');
  return parts.slice(0, n).join('/');
}

// Tree-aware hue cache for the region lens. Keyed by region PATH so the
// lens can look up by `node.region` (which is the immediate folder
// path, not the UUID). Rebuilt when `regionTree` identity flips
// (fresh stream load).
let cachedPathHueTreeRef: unknown = null;
let cachedPathHues: Map<string, number> = new Map();
function pathHueFor(path: string): number | undefined {
  const tree: RegionTree = useLayoutStore.getState().regionTree;
  if (tree !== cachedPathHueTreeRef) {
    cachedPathHueTreeRef = tree;
    const idHues = computeFolderHues(tree);
    cachedPathHues = new Map();
    for (const info of tree.byId.values()) {
      const hue = idHues.get(info.id);
      if (hue !== undefined) cachedPathHues.set(info.path, hue);
    }
  }
  return cachedPathHues.get(path);
}

export const LENSES: Record<string, Lens> = {
  region: {
    label: 'By Region',
    colorFn: (node) => {
      // Tree-aware hue — looks up the same `computeFolderHues` map
      // HullLayer paints the region outline with, so a tile's colour
      // unambiguously matches its containing hull. Falls back to the
      // legacy string-hash on top-2 segments for nodes whose region
      // path isn't in the tree (excluded / synthetic / fixture data).
      const treeHue = pathHueFor(node.region);
      let hue: number;
      if (treeHue !== undefined) {
        // Per-file sub-shift inside the parent folder's hue so adjacent
        // files don't render as a flat block of the same colour. ±10°
        // is wide enough to read as variation, narrow enough that a
        // file is unmistakably "in this folder's zone".
        const subPath = node.file.includes('/')
          ? node.file.slice(0, node.file.lastIndexOf('/'))
          : node.file;
        const subHash = strHash(subPath);
        const hueShift = (subHash % 21) - 10;
        hue = ((treeHue + hueShift) % 360 + 360) % 360;
      } else {
        const top = topSegments(node.region, 2);
        hue = strHash(top);
      }
      // Lightness keyed off node type (TYPE_LIGHTNESS table) plus a
      // small per-sub-path wobble so a folder full of identical-type
      // nodes still has surface texture.
      const subPath2 = node.file.includes('/')
        ? node.file.slice(0, node.file.lastIndexOf('/'))
        : node.file;
      const subHash2 = strHash(subPath2);
      const lightShift = (((subHash2 >> 4) % 17) - 8) / 100; // ±0.08
      const lightness = (TYPE_LIGHTNESS[node.type] ?? 30) / 100;
      return new THREE.Color().setHSL(
        hue / 360,
        0.85,
        Math.max(0.18, Math.min(0.6, lightness * 0.8 + lightShift)),
      );
    },
    legend: 'categorical',
  },

  type: {
    label: 'By Type',
    colorFn: (node) => {
      const hue = strHash(node.type) / 360;
      return new THREE.Color().setHSL(hue, 0.9, 0.3);
    },
    legend: 'categorical',
  },

  complexity: {
    label: 'Complexity',
    colorFn: (node, all) => {
      const norm = getNormalized(all, 'complexity');
      return heatmapColor(norm.get(all.indexOf(node)) ?? 0);
    },
    legend: 'gradient',
  },

  fileSize: {
    label: 'File Size',
    colorFn: (node, all) => {
      const norm = getNormalized(all, 'fileSize');
      return heatmapColor(norm.get(all.indexOf(node)) ?? 0);
    },
    legend: 'gradient',
  },

  churn: {
    label: 'Git Churn',
    colorFn: (node, all) => {
      const norm = getNormalized(all, 'churn');
      return heatmapColor(norm.get(all.indexOf(node)) ?? 0);
    },
    legend: 'gradient',
  },

  degree: {
    label: 'Connections',
    colorFn: (node, all) => {
      let maxDeg = 1;
      for (const n of all) if (n.degree > maxDeg) maxDeg = n.degree;
      return heatmapColor(node.degree / maxDeg);
    },
    legend: 'gradient',
  },
};
