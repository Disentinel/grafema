/**
 * MethodCallDetectors - Detection functions for method call classification.
 *
 * Extracted from MethodCallResolver.ts (REG-463).
 * Free functions that classify method calls as external, built-in, or library.
 */

import {
  EXTERNAL_OBJECTS,
  BUILTIN_OBJECTS,
  BUILTIN_PROTOTYPE_METHODS,
  COMMON_LIBRARY_METHODS,
  LIBRARY_SEMANTIC_GROUPS,
} from './MethodCallData.js';
import type { LibraryCallStats } from './MethodCallData.js';

/**
 * Checks if a method call is external (built-in or well-known library).
 * In strict mode, external methods are skipped (no error if unresolved).
 */
export function isExternalMethod(object: string, method: string): boolean {
  // Check if object is a known global
  if (EXTERNAL_OBJECTS.has(object)) {
    return true;
  }

  // Check if method is a built-in prototype method
  if (BUILTIN_PROTOTYPE_METHODS.has(method)) {
    return true;
  }

  // Check if method is a common library method
  if (COMMON_LIBRARY_METHODS.has(method)) {
    return true;
  }

  return false;
}

/**
 * Check if object is a built-in JavaScript global (not a library namespace)
 */
export function isBuiltInObject(object: string): boolean {
  return BUILTIN_OBJECTS.has(object);
}

/**
 * Track a library method call for coverage reporting
 */
export function trackLibraryCall(
  stats: Map<string, LibraryCallStats>,
  object: string,
  method: string
): void {
  if (!stats.has(object)) {
    const semanticInfo = LIBRARY_SEMANTIC_GROUPS[object];
    stats.set(object, {
      object,
      methods: new Map(),
      totalCalls: 0,
      semantic: semanticInfo?.semantic,
      suggestedPlugin: semanticInfo?.suggestedPlugin,
      description: semanticInfo?.description
    });
  }

  const libStats = stats.get(object)!;
  libStats.totalCalls++;
  libStats.methods.set(method, (libStats.methods.get(method) || 0) + 1);
}
