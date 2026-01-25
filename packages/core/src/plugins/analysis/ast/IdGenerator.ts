/**
 * IdGenerator - Centralized ID generation for AST nodes
 *
 * Encapsulates the dual ID system:
 * - Semantic IDs (stable, based on scope path) when ScopeTracker is available
 * - Legacy IDs (hash-separated, location-based) as fallback
 *
 * This removes 18+ duplicate instances of the same pattern across visitor files.
 */

import type { ScopeTracker } from '../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../core/SemanticId.js';

/**
 * Counter reference for legacy ID generation
 */
export interface CounterRef {
  value: number;
}

/**
 * Options for ID generation
 */
export interface IdGeneratorOptions {
  /**
   * Whether to use discriminator for same-named items in same scope.
   * When true, calls scopeTracker.getItemCounter() to get a unique discriminator.
   */
  useDiscriminator?: boolean;

  /**
   * Custom key for discriminator counter.
   * Defaults to `${type}:${name}` if not specified.
   */
  discriminatorKey?: string;
}

/**
 * IdGenerator - Centralized ID generation for AST nodes
 *
 * Usage:
 * ```typescript
 * const idGen = new IdGenerator(scopeTracker);
 *
 * // For nodes with counter (VARIABLE, CALL, etc.)
 * const varId = idGen.generate('VARIABLE', 'myVar', file, line, col, counterRef);
 *
 * // For nodes with discriminator (CALL - same function called multiple times)
 * const callId = idGen.generate('CALL', 'console.log', file, line, col, counterRef, {
 *   useDiscriminator: true
 * });
 *
 * // For nodes without counter (FUNCTION)
 * const funcId = idGen.generateSimple('FUNCTION', 'myFunc', file, line);
 *
 * // For scope bodies
 * const scopeId = idGen.generateScope('body', 'myFunc:body', file, line);
 * ```
 */
export class IdGenerator {
  constructor(private scopeTracker?: ScopeTracker) {}

  /**
   * Generate ID for nodes that use a counter in legacy format.
   *
   * Legacy format: `TYPE#name#file#line:column:counter`
   * Semantic format: `file->scope->TYPE->name[#discriminator]`
   *
   * Used for: VARIABLE, CONSTANT, CALL, METHOD_CALL, LITERAL
   */
  generate(
    type: string,
    name: string,
    file: string,
    line: number,
    column: number,
    counterRef: CounterRef,
    options?: IdGeneratorOptions
  ): string {
    const legacyId = `${type}#${name}#${file}#${line}:${column}:${counterRef.value++}`;

    if (!this.scopeTracker) return legacyId;

    const discriminator = options?.useDiscriminator
      ? this.scopeTracker.getItemCounter(options.discriminatorKey ?? `${type}:${name}`)
      : undefined;

    return computeSemanticId(type, name, this.scopeTracker.getContext(), { discriminator });
  }

  /**
   * Generate ID for nodes without counter in legacy format.
   *
   * Legacy format: `TYPE#name#file#line` or `TYPE#name#file#line:column`
   * Semantic format: `file->scope->TYPE->name`
   *
   * Used for: FUNCTION (named), CLASS
   */
  generateSimple(
    type: string,
    name: string,
    file: string,
    line: number,
    column?: number
  ): string {
    const legacyId = column !== undefined
      ? `${type}#${name}#${file}#${line}:${column}`
      : `${type}#${name}#${file}#${line}`;

    if (!this.scopeTracker) return legacyId;

    return computeSemanticId(type, name, this.scopeTracker.getContext());
  }

  /**
   * Generate ID for scope nodes.
   *
   * Legacy format: `SCOPE#funcName:body#file#line` or with column
   * Semantic format: `file->scope->SCOPE->body`
   *
   * @param semanticName - Name for semantic ID (usually 'body')
   * @param legacyName - Name for legacy ID (usually 'funcName:body')
   */
  generateScope(
    semanticName: string,
    legacyName: string,
    file: string,
    line: number,
    column?: number
  ): string {
    const legacyId = column !== undefined
      ? `SCOPE#${legacyName}#${file}#${line}:${column}`
      : `SCOPE#${legacyName}#${file}#${line}`;

    if (!this.scopeTracker) return legacyId;

    return computeSemanticId('SCOPE', semanticName, this.scopeTracker.getContext());
  }

  /**
   * Generate legacy-only ID (no semantic version).
   *
   * Used for: LITERAL (arguments), DECORATOR, PROPERTY
   *
   * NOTE: PARAMETER nodes use computeSemanticId() for stable, semantic identifiers.
   * See createParameterNodes.ts for the implementation.
   *
   * @param includeSuffix - Additional suffix after line:column (counter or index)
   */
  generateLegacy(
    type: string,
    name: string,
    file: string,
    line: number,
    column: number,
    suffix?: string | number
  ): string {
    if (suffix !== undefined) {
      return `${type}#${name}#${file}#${line}:${column}:${suffix}`;
    }
    return `${type}#${name}#${file}#${line}:${column}`;
  }

  /**
   * Check if semantic IDs are available (scopeTracker is present)
   */
  hasSemanticIds(): boolean {
    return this.scopeTracker !== undefined;
  }

  /**
   * Get the underlying ScopeTracker (for advanced usage)
   */
  getScopeTracker(): ScopeTracker | undefined {
    return this.scopeTracker;
  }
}
