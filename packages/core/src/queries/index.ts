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
export type { CallInfo, CallerInfo, FindCallsOptions } from './types.js';
