/**
 * MethodCallErrorAnalysis - Error analysis and suggestion generation.
 *
 * Extracted from MethodCallResolver.ts (REG-463).
 * Free functions that analyze resolution failures and generate
 * context-aware suggestions for strict mode error reporting (REG-332).
 */

import type { ResolutionStep, ResolutionFailureReason } from '../../../errors/GrafemaError.js';
import { LIBRARY_SEMANTIC_GROUPS } from './MethodCallData.js';
import type { MethodCallNode, ClassEntry } from './MethodCallData.js';

/**
 * Analyze why method resolution failed (REG-332).
 * Returns the failure reason and resolution chain for context-aware suggestions.
 */
export function analyzeResolutionFailure(
  methodCall: MethodCallNode,
  classMethodIndex: Map<string, ClassEntry>,
  _variableTypes: Map<string, string>
): { reason: ResolutionFailureReason; chain: ResolutionStep[] } {
  const { object, method, file } = methodCall;
  const chain: ResolutionStep[] = [];

  if (!object || !method) {
    return { reason: 'unknown', chain };
  }

  // Check if object is a known class name (static call)
  if (classMethodIndex.has(object)) {
    const classEntry = classMethodIndex.get(object)!;
    chain.push({
      step: `${object} class lookup`,
      result: 'found',
      file: classEntry.classNode.file as string | undefined,
      line: classEntry.classNode.line as number | undefined,
    });

    if (!classEntry.methods.has(method)) {
      chain.push({
        step: `${object}.${method} method`,
        result: 'NOT FOUND in class',
      });
      return { reason: 'method_not_found', chain };
    }
  }

  // Check for local class in same file
  const localKey = `${file}:${object}`;
  if (classMethodIndex.has(localKey)) {
    const classEntry = classMethodIndex.get(localKey)!;
    chain.push({
      step: `${object} local class`,
      result: 'found in same file',
    });

    if (!classEntry.methods.has(method)) {
      chain.push({
        step: `${object}.${method} method`,
        result: 'NOT FOUND',
      });
      return { reason: 'method_not_found', chain };
    }
  }

  // Check if this is a library call
  if (LIBRARY_SEMANTIC_GROUPS[object]) {
    const libInfo = LIBRARY_SEMANTIC_GROUPS[object];
    chain.push({
      step: `${object} lookup`,
      result: `external library (${libInfo.semantic})`,
    });
    return { reason: 'external_dependency', chain };
  }

  // Object type is unknown
  chain.push({
    step: `${object} type lookup`,
    result: 'unknown (not in class index)',
  });
  chain.push({
    step: `${object}.${method}`,
    result: 'FAILED (no type information)',
  });

  return { reason: 'unknown_object_type', chain };
}

/**
 * Generate context-aware suggestion based on failure reason (REG-332).
 */
export function generateContextualSuggestion(
  object: string,
  method: string,
  reason: ResolutionFailureReason,
  chain: ResolutionStep[]
): string {
  switch (reason) {
    case 'unknown_object_type': {
      // Find the source in chain that shows "unknown"
      const sourceStep = chain.find(s => s.result.includes('unknown'));
      const sourceDesc = sourceStep?.step || 'the source';
      return `Variable "${object}" has unknown type from ${sourceDesc}. ` +
             `Add JSDoc: /** @type {${object}Class} */ or check imports.`;
    }

    case 'class_not_imported':
      return `Class "${object}" is not imported. Check your imports or ensure the class is defined.`;

    case 'method_not_found':
      return `Class "${object}" exists but has no method "${method}". ` +
             `Check spelling or verify the method is defined in the class.`;

    case 'external_dependency': {
      const libInfo = LIBRARY_SEMANTIC_GROUPS[object];
      if (libInfo?.suggestedPlugin) {
        return `This call is to external library "${object}" (${libInfo.semantic}). ` +
               `Consider using ${libInfo.suggestedPlugin} for semantic analysis.`;
      }
      return `This call is to external library "${object}". ` +
             `Consider adding type stubs or a dedicated analyzer plugin.`;
    }

    case 'circular_reference':
      return `Alias chain for "${object}" is too deep (possible cycle). ` +
             `Simplify variable assignments or check for circular references.`;

    default:
      return `Check if class "${object}" is imported and has method "${method}".`;
  }
}
