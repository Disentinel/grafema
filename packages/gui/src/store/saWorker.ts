/**
 * Web Worker for SA layout computation.
 * Runs annealingLayout off the main thread so lerp/render stays smooth.
 *
 * Protocol (postMessage):
 *   Main → Worker: { type: 'start', nodes, edges, regionNames }
 *   Worker → Main: { type: 'flood', tileCoords: [idx, q, r][] }
 *   Worker → Main: { type: 'progress', iteration, cost }
 *   Worker → Main: { type: 'settled', tileCoords: [idx, q, r][], cost, iterations }
 */

import { IncrementalLayout, type LayoutNode } from './hexLayout';
import type { GraphEdge } from './dataStore';

export interface SAStartMessage {
  type: 'start';
  nodes: LayoutNode[];
  edges: GraphEdge[];
  regionNames: string[];
}

export interface SAFloodMessage {
  type: 'flood';
  tileCoords: [number, number, number][]; // [idx, q, r]
}

export interface SAProgressMessage {
  type: 'progress';
  iteration: number;
  cost: number;
}

export interface SASettledMessage {
  type: 'settled';
  tileCoords: [number, number, number][];
  cost: number;
  iterations: number;
}

export type SAWorkerMessage = SAFloodMessage | SAProgressMessage | SASettledMessage;

// Worker entry point (runs in worker context)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof self !== 'undefined' && typeof (self as any).onmessage !== 'undefined') {
  self.onmessage = (e: MessageEvent<SAStartMessage>) => {
    if (e.data.type !== 'start') return;

    const { nodes, edges, regionNames } = e.data;
    const engine = new IncrementalLayout(nodes, edges, regionNames);

    // Send flood fill positions immediately
    const floodCoords: [number, number, number][] = [];
    for (const [idx, coord] of engine.tileCoords) {
      floodCoords.push([idx, coord.q, coord.r]);
    }
    self.postMessage({ type: 'flood', tileCoords: floodCoords } satisfies SAFloodMessage);

    // SA refinement in batches
    const BATCH = 10_000;
    let lastReport = 0;

    while (!engine.settled) {
      engine.refineBatch(BATCH);
      if (engine.iterations - lastReport >= 20_000) {
        self.postMessage({
          type: 'progress',
          iteration: engine.iterations,
          cost: engine.cost,
        } satisfies SAProgressMessage);
        lastReport = engine.iterations;
      }
    }

    // Send final positions
    const finalCoords: [number, number, number][] = [];
    for (const [idx, coord] of engine.tileCoords) {
      finalCoords.push([idx, coord.q, coord.r]);
    }
    self.postMessage({
      type: 'settled',
      tileCoords: finalCoords,
      cost: engine.cost,
      iterations: engine.iterations,
    } satisfies SASettledMessage);
  };
}
