/**
 * Notation — Grafema DSL rendering engine
 *
 * Transforms graph data into compact visual notation.
 * Output-only — Datalog remains the query language.
 *
 * @module notation
 */

export type {
  Archetype,
  EdgeMapping,
  DescribeOptions,
  SubgraphData,
  NotationBlock,
  NotationLine,
  FoldMeta,
} from './types.js';

export { EDGE_ARCHETYPE_MAP, lookupEdge, generateLegend } from './archetypes.js';
export { PERSPECTIVES } from './perspectives.js';
export { renderNotation } from './renderer.js';
export { extractSubgraph } from './lodExtractor.js';
export { shortenName } from './nameShortener.js';
export { foldBlocks } from './fold.js';
export { renderTraceNarrative } from './traceRenderer.js';
export type { TraceDetail, TraceNarrativeOptions } from './traceRenderer.js';
