/**
 * Graph Query Utilities
 *
 * Shared utilities for querying the code graph.
 * Used by MCP, CLI, and other tools.
 *
 * @module queries
 */

export { findCallsInFunction } from './findCallsInFunction.js';
export { findContainingFunction } from './findContainingFunction.js';
export { traceValues, aggregateValues, NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS } from './traceValues.js';

export type { CallInfo, CallerInfo, FindCallsOptions } from './types.js';
export type {
  TracedValue,
  ValueSource,
  UnknownReason,
  TraceValuesOptions,
  ValueSetResult,
  TraceValuesGraphBackend,
  NondeterministicPattern,
} from './types.js';
