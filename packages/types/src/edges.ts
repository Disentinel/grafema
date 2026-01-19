/**
 * Edge Types - graph edge type definitions
 */

// === EDGE TYPES ===
export const EDGE_TYPE = {
  // Structure
  CONTAINS: 'CONTAINS',
  DEPENDS_ON: 'DEPENDS_ON',
  HAS_SCOPE: 'HAS_SCOPE',

  // Calls
  CALLS: 'CALLS',
  HAS_CALLBACK: 'HAS_CALLBACK',
  PASSES_ARGUMENT: 'PASSES_ARGUMENT',
  RECEIVES_ARGUMENT: 'RECEIVES_ARGUMENT',
  RETURNS: 'RETURNS',

  // Inheritance
  EXTENDS: 'EXTENDS',
  IMPLEMENTS: 'IMPLEMENTS',
  INSTANCE_OF: 'INSTANCE_OF',

  // Imports/Exports
  IMPORTS: 'IMPORTS',
  EXPORTS: 'EXPORTS',
  IMPORTS_FROM: 'IMPORTS_FROM',
  EXPORTS_TO: 'EXPORTS_TO',

  // Variables/Data flow
  DEFINES: 'DEFINES',
  USES: 'USES',
  DECLARES: 'DECLARES',
  MODIFIES: 'MODIFIES',
  CAPTURES: 'CAPTURES',
  ASSIGNED_FROM: 'ASSIGNED_FROM',
  READS_FROM: 'READS_FROM',
  WRITES_TO: 'WRITES_TO',

  // HTTP/Routing
  ROUTES_TO: 'ROUTES_TO',
  HANDLED_BY: 'HANDLED_BY',
  MAKES_REQUEST: 'MAKES_REQUEST',
  MOUNTS: 'MOUNTS',
  EXPOSES: 'EXPOSES',

  // Events/Sockets
  LISTENS_TO: 'LISTENS_TO',
  EMITS_EVENT: 'EMITS_EVENT',
  JOINS_ROOM: 'JOINS_ROOM',

  // External
  CALLS_API: 'CALLS_API',
  INTERACTS_WITH: 'INTERACTS_WITH',

  // Views
  REGISTERS_VIEW: 'REGISTERS_VIEW',

  // Errors
  THROWS: 'THROWS',

  // Guarantees/Invariants
  GOVERNS: 'GOVERNS',
  VIOLATES: 'VIOLATES',

  // Unknown/fallback
  UNKNOWN: 'UNKNOWN',
} as const;

export type EdgeType = typeof EDGE_TYPE[keyof typeof EDGE_TYPE] | string;

// === EDGE RECORD ===
export interface EdgeRecord {
  src: string;
  dst: string;
  type: EdgeType;
  index?: number;
  metadata?: Record<string, unknown>;
}

// Semantic edge types for better type inference
export interface ContainsEdge extends EdgeRecord {
  type: 'CONTAINS';
}

export interface CallsEdge extends EdgeRecord {
  type: 'CALLS';
  argumentCount?: number;
}

export interface ImportsEdge extends EdgeRecord {
  type: 'IMPORTS';
  specifier?: string;
  isDefault?: boolean;
}

export interface ExportsEdge extends EdgeRecord {
  type: 'EXPORTS';
  exportedName?: string;
}

export interface DataFlowEdge extends EdgeRecord {
  type: 'ASSIGNED_FROM' | 'READS_FROM' | 'WRITES_TO' | 'PASSES_ARGUMENT';
  dataType?: string;
}

export interface RouteEdge extends EdgeRecord {
  type: 'ROUTES_TO' | 'HANDLED_BY';
  method?: string;
  path?: string;
}
