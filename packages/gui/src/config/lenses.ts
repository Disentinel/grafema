import type { GraphNode } from '../store/dataStore';
import * as THREE from 'three';

export interface Lens {
  label: string;
  colorFn: (node: GraphNode, allNodes: GraphNode[]) => THREE.Color;
  legend?: 'gradient' | 'categorical';
}

/** Stable hash for string → hue */
function strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

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

export const LENSES: Record<string, Lens> = {
  region: {
    label: 'By Region',
    colorFn: (node) => {
      const hue = strHash(node.region) / 360;
      const lightness = (TYPE_LIGHTNESS[node.type] ?? 30) / 100;
      return new THREE.Color().setHSL(hue, 0.85, lightness * 0.8);
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
