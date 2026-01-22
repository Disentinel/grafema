/**
 * ScopeTracker - Track scope hierarchy during AST traversal
 *
 * Maintains the current scope path and provides counters for:
 * - Counted scopes (if#0, try#1, etc.)
 * - Item counters (CALL, LITERAL, etc.)
 * - Sibling tracking (anonymous[0], anonymous[1], etc.)
 *
 * Used with SemanticId to generate stable identifiers.
 */

import type { ScopeContext } from './SemanticId.js';

/**
 * Entry in the scope stack
 */
export interface ScopeEntry {
  name: string;
  type: string;
  counter?: number;
}

/**
 * Result of entering a counted scope
 */
export interface CountedScopeResult {
  name: string;
  discriminator: number;
}

/**
 * ScopeTracker - Manages scope hierarchy and counters during AST traversal
 */
export class ScopeTracker {
  /** Source file path */
  readonly file: string;

  /** Current scope stack */
  private scopeStack: ScopeEntry[] = [];

  /** Counters for various purposes (scoped by scope path) */
  private counters: Map<string, number> = new Map();

  constructor(file: string) {
    this.file = file;
  }

  // === Scope Management ===

  /**
   * Enter a named scope (function, class, etc.)
   */
  enterScope(name: string, type: string): void {
    this.scopeStack.push({ name, type });
  }

  /**
   * Enter a counted scope (if, try, for, etc.)
   * Automatically assigns a discriminator.
   */
  enterCountedScope(type: string): CountedScopeResult {
    const key = this.counterKey(type);
    const n = this.counters.get(key) || 0;
    this.counters.set(key, n + 1);

    const name = `${type}#${n}`;
    this.scopeStack.push({ name, type, counter: n });
    return { name, discriminator: n };
  }

  /**
   * Exit the current scope
   */
  exitScope(): void {
    this.scopeStack.pop();
  }

  // === ID Generation ===

  /**
   * Get current scope context for semantic ID generation
   */
  getContext(): ScopeContext {
    return {
      file: this.file,
      scopePath: this.scopeStack.map(s => s.name)
    };
  }

  /**
   * Get scope path as string (for display/debugging)
   */
  getScopePath(): string {
    if (this.scopeStack.length === 0) return 'global';
    return this.scopeStack.map(s => s.name).join('->');
  }

  // === Counter Management ===

  /**
   * Get next counter for item type within current scope.
   * Used for CALL, LITERAL, etc. that need #N discriminators.
   */
  getItemCounter(itemType: string): number {
    const key = this.counterKey(itemType);
    const n = this.counters.get(key) || 0;
    this.counters.set(key, n + 1);
    return n;
  }

  /**
   * Get current count without incrementing.
   * Used to check for collisions.
   */
  peekItemCounter(itemType: string): number {
    return this.counters.get(this.counterKey(itemType)) || 0;
  }

  // === Sibling Tracking ===

  /**
   * Track siblings by name within current scope.
   * Used for anonymous functions: anonymous[0], anonymous[1]
   */
  getSiblingIndex(name: string): number {
    const key = `${this.getScopePath()}:sibling:${name}`;
    const n = this.counters.get(key) || 0;
    this.counters.set(key, n + 1);
    return n;
  }

  // === Private ===

  private counterKey(itemType: string): string {
    return `${this.getScopePath()}:${itemType}`;
  }
}
