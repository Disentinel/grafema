/**
 * Knowledge Base Types
 *
 * Semantic types for the persistent knowledge layer.
 * KB nodes are stored as git-tracked markdown files with YAML frontmatter.
 */

/** Node types in the knowledge graph */
export type KBNodeType = 'DECISION' | 'FACT' | 'SESSION' | 'COMMIT' | 'FILE_CHANGE' | 'AUTHOR' | 'TICKET' | 'INCIDENT';

/** Lifecycle derived from directory path */
export type KBLifecycle = 'declared' | 'derived' | 'synced';

/** Scope of a knowledge node */
export type KBScope = 'global' | 'project' | 'module';

/** Base fields shared by all KB nodes */
export interface KBNodeBase {
  /** Semantic ID in format kb:<type>:<slug> */
  id: string;
  /** Node type */
  type: KBNodeType;
  /** Subtype within the node type (e.g., FACT: domain|error|preference, DECISION: adr|runbook) */
  subtype?: string;
  /** Scope of applicability */
  scope?: KBScope;
  /** Projections this node belongs to (e.g., 'epistemic', 'temporal') */
  projections: string[];
  /** Source node that produced this (e.g., session ID) */
  source?: string;
  /** Creation date (YYYY-MM-DD) */
  created: string;
  /** Markdown body content */
  content: string;
  /** Path to the .md file on disk */
  filePath: string;
  /** Lifecycle derived from directory structure */
  lifecycle: KBLifecycle;
  /** Semantic IDs of related nodes */
  relates_to?: string[];
}

/** Decision node — architectural/design decisions */
export interface KBDecision extends KBNodeBase {
  type: 'DECISION';
  /** Decision status */
  status: 'active' | 'superseded' | 'deprecated' | 'proposed';
  /** Date when decision took effect */
  effective_from?: string;
  /** Date when decision was superseded/deprecated */
  effective_until?: string;
  /** Semantic addresses of code this applies to */
  applies_to?: string[];
  /** ID of the decision that superseded this one */
  superseded_by?: string;
}

/** Fact node — observed facts about the codebase */
export interface KBFact extends KBNodeBase {
  type: 'FACT';
  /** Confidence level */
  confidence?: 'high' | 'medium' | 'low';
  /** ID of the fact that superseded this one */
  superseded_by?: string;
}

/** Session node — records of design/work sessions */
export interface KBSession extends KBNodeBase {
  type: 'SESSION';
  /** Associated Linear task ID */
  task_id?: string;
  /** Path to session transcript */
  session_path?: string;
  /** IDs of nodes produced during this session */
  produced?: string[];
}

/** Union of all KB node types */
export type KBNode = KBDecision | KBFact | KBSession | KBNodeBase;

/** Edge in the knowledge graph */
export interface KBEdge {
  /** Edge type (e.g., PRODUCED, IMPLEMENTS, INFORMED_BY) */
  type: string;
  /** Source node semantic ID */
  from: string;
  /** Target node semantic ID */
  to: string;
  /** Optional evidence for the relationship */
  evidence?: string;
}

/** Statistics about the knowledge base */
export interface KBStats {
  /** Total node count */
  totalNodes: number;
  /** Counts by node type */
  byType: Partial<Record<KBNodeType, number>>;
  /** Counts by lifecycle */
  byLifecycle: Partial<Record<KBLifecycle, number>>;
  /** Total edge count */
  totalEdges: number;
  /** Edge counts by type */
  edgesByType: Record<string, number>;
  /** Dangling edge references (from/to IDs that don't exist as nodes) */
  danglingRefs: string[];
  /** KB nodes referencing code addresses that don't resolve to graph nodes */
  danglingCodeRefs: DanglingCodeRef[];
}

/** Filter for querying KB nodes */
export interface KBQueryFilter {
  /** Filter by node type */
  type?: KBNodeType;
  /** Filter by projection */
  projection?: string;
  /** Case-insensitive text search in body content */
  text?: string;
  /** Filter by decision status */
  status?: string;
  /** Filter by relates_to containing this ID */
  relates_to?: string;
  /** When true, return only nodes with dangling code references */
  include_dangling_only?: boolean;
}

/** Parsed semantic address: file:name:TYPE or file:scope1:...:scopeN:name:TYPE */
export interface ParsedSemanticAddress {
  file: string;
  name: string;
  type: string;
  scopePath: string[];
}

/** Result of resolving a semantic address to a code graph node */
export interface ResolvedAddress {
  address: string;
  codeNodeId: string | null;
  status: 'resolved' | 'dangling';
}

/** A dangling code reference from a KB node */
export interface DanglingCodeRef {
  nodeId: string;
  address: string;
}
