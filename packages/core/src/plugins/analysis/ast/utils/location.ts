/**
 * Location extraction utilities for AST nodes.
 *
 * Convention: 0:0 means "unknown location" when AST node lacks position data.
 * This can happen with synthetic nodes, transformed AST, or malformed source.
 *
 * This is the single source of truth for location extraction across all analyzers.
 *
 * @module location
 */
import type { Node } from '@babel/types';

/**
 * Fallback location for nodes without position data.
 * Used when AST was generated without source maps or from synthetic nodes.
 */
export const UNKNOWN_LOCATION = { line: 0, column: 0 } as const;

/**
 * Location information extracted from an AST node.
 * Both line and column are guaranteed to be numbers (not undefined).
 */
export interface NodeLocation {
  readonly line: number;
  readonly column: number;
}

/**
 * Extract start location from an AST node.
 *
 * Returns { line: 0, column: 0 } if node is null, undefined, or lacks location data.
 * This is the preferred way to get location info - use this instead of node.loc!
 *
 * @example
 * // Instead of:
 * const line = node.loc!.start.line;
 * const column = node.loc!.start.column;
 *
 * // Use:
 * const { line, column } = getNodeLocation(node);
 *
 * @param node - Babel AST node (may be null or undefined)
 * @returns Location with line and column (both guaranteed numbers)
 */
export function getNodeLocation(node: Node | null | undefined): NodeLocation {
  return {
    line: node?.loc?.start?.line ?? 0,
    column: node?.loc?.start?.column ?? 0
  };
}

/**
 * Extract start line number from an AST node.
 *
 * Returns 0 if node is null, undefined, or lacks location data.
 *
 * @example
 * // Instead of:
 * const line = node.loc!.start.line;
 *
 * // Use:
 * const line = getLine(node);
 *
 * @param node - Babel AST node (may be null or undefined)
 * @returns Line number (1-based) or 0 for unknown
 */
export function getLine(node: Node | null | undefined): number {
  return node?.loc?.start?.line ?? 0;
}

/**
 * Extract start column number from an AST node.
 *
 * Returns 0 if node is null, undefined, or lacks location data.
 *
 * @example
 * // Instead of:
 * const col = node.loc!.start.column;
 *
 * // Use:
 * const col = getColumn(node);
 *
 * @param node - Babel AST node (may be null or undefined)
 * @returns Column number (0-based) or 0 for unknown
 */
export function getColumn(node: Node | null | undefined): number {
  return node?.loc?.start?.column ?? 0;
}

/**
 * Extract end location from an AST node.
 *
 * Returns { line: 0, column: 0 } if node is null, undefined, or lacks location data.
 *
 * @param node - Babel AST node (may be null or undefined)
 * @returns End location with line and column (both guaranteed numbers)
 */
export function getEndLocation(node: Node | null | undefined): NodeLocation {
  return {
    line: node?.loc?.end?.line ?? 0,
    column: node?.loc?.end?.column ?? 0
  };
}
