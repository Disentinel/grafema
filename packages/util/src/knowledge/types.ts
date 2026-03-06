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

/** Base fields shared by all KB nodes */
export interface KBNodeBase {
  /** Semantic ID in format kb:<type>:<slug> */
  id: string;
  /** Node type */
  type: KBNodeType;
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
}
