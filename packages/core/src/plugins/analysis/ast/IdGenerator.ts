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
import { computeSemanticId, computeSemanticIdV2 } from '../../../core/SemanticId.js';
import type { ContentHashHints } from '../../../core/SemanticId.js';
import type { PendingNode } from './CollisionResolver.js';

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
  /** Pending nodes for v2 collision resolution */
  private _pendingNodes: PendingNode[] = [];
  private _insertionCounter = 0;

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

  // ===========================================================================
  // v2 ID Generation
  // ===========================================================================

  /**
   * Generate v2 ID for nodes that can collide (CALL, METHOD_CALL, PROPERTY_ACCESS).
   *
   * Registers a PendingNode for later collision resolution via CollisionResolver.
   * Sets collectionRef.id to the base ID immediately (may be overwritten later).
   *
   * namedParent is automatically obtained from ScopeTracker.getNamedParent().
   *
   * @param type - Node type ('CALL', 'METHOD_CALL', 'PROPERTY_ACCESS')
   * @param name - Node name (e.g., 'console.log')
   * @param file - Source file path
   * @param contentHints - Content data for hash-based disambiguation
   * @param collectionRef - Object whose .id will be updated by CollisionResolver
   * @returns Base ID (may change after collision resolution)
   */
  generateV2(
    type: string,
    name: string,
    file: string,
    contentHints: ContentHashHints,
    collectionRef: { id: string }
  ): string {
    const namedParent = this.scopeTracker?.getNamedParent();
    const baseId = computeSemanticIdV2(type, name, file, namedParent);

    this._pendingNodes.push({
      baseId,
      contentHints,
      collectionRef,
      insertionOrder: this._insertionCounter++
    });

    collectionRef.id = baseId;
    return baseId;
  }

  /**
   * Generate v2 ID for nodes that are unique by construction.
   * (FUNCTION, CLASS, VARIABLE, CONSTANT, INTERFACE, TYPE, ENUM, SCOPE)
   *
   * These don't need collision resolution — language semantics guarantee uniqueness.
   * namedParent is automatically obtained from ScopeTracker.getNamedParent().
   *
   * @returns Final ID (no collision resolution needed)
   */
  generateV2Simple(
    type: string,
    name: string,
    file: string
  ): string {
    const namedParent = this.scopeTracker?.getNamedParent();
    return computeSemanticIdV2(type, name, file, namedParent);
  }

  /**
   * Get all pending nodes for collision resolution.
   * Called after all visitors complete for a file.
   */
  getPendingNodes(): PendingNode[] {
    return this._pendingNodes;
  }

  /**
   * Reset v2 pending state (called at start of each file).
   */
  resetPending(): void {
    this._pendingNodes = [];
    this._insertionCounter = 0;
  }
}
