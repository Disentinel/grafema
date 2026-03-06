/**
 * Knowledge Base — persistent knowledge layer for Grafema
 */

export { KnowledgeBase } from './KnowledgeBase.js';
export { SemanticAddressResolver, parseSemanticAddress } from './SemanticAddressResolver.js';
export type { ResolverBackend } from './SemanticAddressResolver.js';
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
  ParsedSemanticAddress,
  ResolvedAddress,
  DanglingCodeRef,
} from './types.js';
