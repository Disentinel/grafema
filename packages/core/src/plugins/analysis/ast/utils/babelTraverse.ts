/**
 * Babel traverse helper for ESM/CJS interop
 *
 * @babel/traverse has inconsistent exports between ESM and CJS environments.
 * In ESM, the default export may be wrapped in a .default property.
 * This helper normalizes access to the traverse function.
 *
 * Usage:
 *   import traverseModule from '@babel/traverse';
 *   import { getTraverseFunction } from './utils/babelTraverse.js';
 *   const traverse = getTraverseFunction(traverseModule);
 */

import type { TraverseOptions, Scope, NodePath, Node, Visitor } from '@babel/traverse';

/**
 * Type for the traverse function from @babel/traverse
 */
export type TraverseFunction = <S = undefined>(
  parent: Node,
  opts?: TraverseOptions<S>,
  scope?: Scope,
  state?: S,
  parentPath?: NodePath
) => void;

/**
 * Interface for module that may have default export wrapped
 */
interface ModuleWithPossibleDefault {
  default?: TraverseFunction;
}

/**
 * Type guard to check if a module has a wrapped default export
 */
function hasDefaultExport(mod: unknown): mod is ModuleWithPossibleDefault {
  return typeof mod === 'object' && mod !== null && 'default' in mod;
}

/**
 * Type guard to check if a value is a traverse function
 */
function isTraverseFunction(value: unknown): value is TraverseFunction {
  return typeof value === 'function';
}

/**
 * Get the traverse function from @babel/traverse module, handling ESM/CJS interop
 *
 * @param traverseModule - The imported @babel/traverse module
 * @returns The traverse function
 * @throws Error if traverse function cannot be resolved
 */
export function getTraverseFunction(traverseModule: unknown): TraverseFunction {
  // Case 1: ESM environment where default is wrapped
  if (hasDefaultExport(traverseModule) && isTraverseFunction(traverseModule.default)) {
    return traverseModule.default;
  }

  // Case 2: CJS environment or direct function export
  if (isTraverseFunction(traverseModule)) {
    return traverseModule;
  }

  // Should not happen with correct @babel/traverse installation
  throw new Error(
    'Unable to resolve @babel/traverse function. ' +
    'This may indicate an incompatible version or broken installation.'
  );
}

// Re-export types for convenience
export type { TraverseOptions, Scope, NodePath, Node, Visitor };
