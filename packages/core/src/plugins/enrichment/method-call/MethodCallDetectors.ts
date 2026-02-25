/**
 * MethodCallDetectors - Detection functions for method call classification.
 *
 * Extracted from MethodCallResolver.ts (REG-463).
 * Restructured in REG-583: uses runtimeCategories.ts for builtin detection,
 * removes COMMON_LIBRARY_METHODS gate.
 */

import {
  ALL_KNOWN_OBJECTS,
} from '../../../data/builtins/runtimeCategories.js';
import {
  BUILTIN_PROTOTYPE_METHODS,
  LIBRARY_SEMANTIC_GROUPS,
} from './MethodCallData.js';
import type { LibraryCallStats } from './MethodCallData.js';

/**
 * Check if an object is a known runtime builtin (has a typed CALLS target).
 *
 * Returns true for ECMAScript builtins, WEB_API, BROWSER_API, and NODEJS_STDLIB objects.
 * Does NOT include npm namespaces or unknown variable names.
 */
export function isKnownBuiltinObject(object: string): boolean {
  return ALL_KNOWN_OBJECTS.has(object);
}

/**
 * Check if a method name is a built-in prototype method.
 * When the object is a variable (not a known builtin), this indicates
 * an ECMAScript prototype call.
 */
export function isPrototypeMethod(method: string): boolean {
  return BUILTIN_PROTOTYPE_METHODS.has(method);
}

/**
 * @deprecated Use isKnownBuiltinObject() + isPrototypeMethod() separately.
 * Kept for backward compatibility with any callers outside MethodCallResolver.
 * COMMON_LIBRARY_METHODS is NOT checked here. MethodCallResolver does not
 * call this function — it calls the finer-grained functions directly.
 */
export function isExternalMethod(object: string, method: string): boolean {
  return isKnownBuiltinObject(object) || isPrototypeMethod(method);
  // NOTE: COMMON_LIBRARY_METHODS check is intentionally removed.
  // Calls that previously hit COMMON_LIBRARY_METHODS now fall through to
  // Step 5 in MethodCallResolver → UNKNOWN_CALL_TARGET:{object}.
  // Zero silent skips.
}

/**
 * Check if object is a built-in JavaScript global (not a library namespace).
 * Delegates to isKnownBuiltinObject for backward compatibility.
 */
export function isBuiltInObject(object: string): boolean {
  return isKnownBuiltinObject(object);
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
