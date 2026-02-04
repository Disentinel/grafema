/**
 * Shared Types for Graph Query Utilities
 *
 * These types are used by findCallsInFunction, findContainingFunction,
 * and other query utilities.
 *
 * @module queries/types
 */

/**
 * Information about a function/method call found in code
 */
export interface CallInfo {
  /** Node ID of the call site */
  id: string;
  /** Called function/method name */
  name: string;
  /** Node type: 'CALL' or 'METHOD_CALL' */
  type: 'CALL' | 'METHOD_CALL';
  /** Object name for method calls (e.g., 'response' for response.json()) */
  object?: string;
  /** Whether the call target was resolved (has CALLS edge) */
  resolved: boolean;
  /** Target function info if resolved */
  target?: {
    id: string;
    name: string;
    file?: string;
    line?: number;
  };
  /** File where call occurs */
  file?: string;
  /** Line number of call */
  line?: number;
  /** Depth in transitive call chain (0 = direct call) */
  depth?: number;
}

/**
 * Information about a function that calls another function
 */
export interface CallerInfo {
  /** Caller function ID */
  id: string;
  /** Caller function name */
  name: string;
  /** Caller function type (FUNCTION, CLASS, MODULE) */
  type: string;
  /** File containing the caller */
  file?: string;
  /** Line of the call site */
  line?: number;
}

/**
 * Options for finding calls in a function
 */
export interface FindCallsOptions {
  /** Maximum depth for scope traversal (default: 10) */
  maxDepth?: number;
  /** Follow transitive calls (default: false) */
  transitive?: boolean;
  /** Maximum depth for transitive traversal (default: 5) */
  transitiveDepth?: number;
}

// =============================================================================
// VALUE TRACING TYPES (REG-244)
// =============================================================================

/**
 * Location of a value source in the graph
 */
export interface ValueSource {
  /** Node ID in the graph */
  id: string;
  /** File path */
  file: string;
  /** Line number (1-based) */
  line: number;
}

/**
 * Reason why a value could not be determined statically.
 * Used for debugging and user-facing messages.
 */
export type UnknownReason =
  | 'parameter'           // Function parameter (runtime input)
  | 'call_result'         // Return value from function call
  | 'constructor_call'    // Constructor call without traceable data (REG-334)
  | 'nondeterministic'    // process.env, req.body, etc.
  | 'max_depth'           // Hit depth limit during traversal
  | 'no_sources';         // No ASSIGNED_FROM/DERIVES_FROM edges found

/**
 * A single traced value from the graph.
 * Represents either a concrete value (from LITERAL) or an unknown value
 * (from PARAMETER, CALL, nondeterministic source, etc.)
 */
export interface TracedValue {
  /** The literal value (undefined if unknown) */
  value: unknown;
  /** Source location in the codebase */
  source: ValueSource;
  /** Whether value could not be determined statically */
  isUnknown: boolean;
  /** Why the value is unknown (for debugging/display) */
  reason?: UnknownReason;
}

/**
 * Options for traceValues()
 */
export interface TraceValuesOptions {
  /** Maximum traversal depth (default: 10) */
  maxDepth?: number;
  /** Follow DERIVES_FROM edges in addition to ASSIGNED_FROM (default: true) */
  followDerivesFrom?: boolean;
  /** Detect nondeterministic patterns like process.env (default: true) */
  detectNondeterministic?: boolean;
}

/**
 * Aggregated result from tracing.
 * Convenience type for consumers who don't need individual sources.
 */
export interface ValueSetResult {
  /** All unique concrete values found */
  values: unknown[];
  /** Whether any path led to unknown value */
  hasUnknown: boolean;
}

/**
 * Edge record for traceValues
 */
export interface TraceValuesEdge {
  src: string;
  dst: string;
  type: string;
  metadata?: { argIndex?: number; isReject?: boolean };
}

/**
 * Node record for traceValues
 */
export interface TraceValuesNode {
  id: string;
  type?: string;
  nodeType?: string;
  value?: unknown;
  file?: string;
  line?: number;
  expressionType?: string;
  object?: string;
  property?: string;
  className?: string;
}

/**
 * Minimal graph backend interface for traceValues().
 * Works with both RFDBServerBackend and internal Graph interface.
 */
export interface TraceValuesGraphBackend {
  getNode(id: string): Promise<TraceValuesNode | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<TraceValuesEdge[]>;
  /**
   * Get incoming edges to a node (REG-334: needed for RESOLVES_TO)
   * Required for Promise tracing - must be implemented by all backends
   */
  getIncomingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<TraceValuesEdge[]>;
}

/**
 * Nondeterministic MemberExpression pattern.
 * object.property combinations that represent external/user input.
 */
export interface NondeterministicPattern {
  object: string;
  property: string;
}
