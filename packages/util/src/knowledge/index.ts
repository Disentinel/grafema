/**
 * Knowledge Base — persistent knowledge layer for Grafema
 */

export { KnowledgeBase } from './KnowledgeBase.js';
export { parseFrontmatter, parseKBNode, serializeKBNode, parseEdgesFile, appendEdge } from './parser.js';
export type {
  KBNodeType,
  KBLifecycle,
  KBNodeBase,
  KBDecision,
  KBFact,
  KBSession,
  KBNode,
  KBEdge,
  KBStats,
  KBQueryFilter,
} from './types.js';
