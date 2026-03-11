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
} from './types.js';

export { EDGE_ARCHETYPE_MAP, lookupEdge } from './archetypes.js';
export { renderNotation } from './renderer.js';
export { extractSubgraph } from './lodExtractor.js';
export { shortenName } from './nameShortener.js';
