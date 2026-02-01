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
