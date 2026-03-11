/**
 * Notation Types — interfaces for the Grafema DSL rendering engine
 *
 * The DSL is output-only: graph data → compact visual notation.
 * Datalog remains the query language.
 *
 * @module notation/types
 */

import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';

export type Archetype =
  | 'contains'
  | 'flow_out'
  | 'flow_in'
  | 'write'
  | 'exception'
  | 'depends'
  | 'publishes'
  | 'gates'
  | 'governs';

export interface EdgeMapping {
  archetype: Archetype;
  /** ASCII operator: >, <, =>, >x, o-, ~>>, ?|, |=, '' for containment */
  operator: string;
  /** Human-readable verb: "calls", "reads", "writes"... */
  verb: string;
  /** Rendering order within blocks */
  sortOrder: number;
}

export interface DescribeOptions {
  /** LOD: 0=names only, 1=edges (default), 2=nested */
  depth?: number;
  /** Only show these archetypes */
  archetypeFilter?: Archetype[];
  /** Max items before summarization (default 7) */
  budget?: number;
  /** Append file:line to node headers */
  includeLocations?: boolean;
}

export interface SubgraphData {
  rootNodes: BaseNodeRecord[];
  edges: EdgeRecord[];
  nodeMap: Map<string, BaseNodeRecord>;
}

export interface NotationBlock {
  nodeId: string;
  displayName: string;
  nodeType: string;
  lines: NotationLine[];
  children: NotationBlock[];
  location?: string;
}

export interface NotationLine {
  operator: string;
  verb: string;
  targets: string[];
  sortOrder: number;
  /** Optional prefix modifier, e.g. '[]' for edges inside loops */
  modifier?: string;
}
