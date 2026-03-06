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
  KBScope,
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
export { parseYamlArrayFile } from './parser.js';
export { GitIngest, parseGitLog, normalizeAuthors } from './git-ingest.js';
export type { RawCommit, FileChange, AuthorEntry, CommitEntry, IngestResult, Meta } from './git-ingest.js';
export { getChurn, getCoChanges, getOwnership, getArchaeology } from './git-queries.js';
export type { ChurnEntry, CoChangeEntry, OwnershipEntry, ArchaeologyEntry } from './git-queries.js';
