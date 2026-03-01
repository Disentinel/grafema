/**
 * LibraryRegistry Types
 *
 * Type definitions for npm library function registry.
 * Used by enrichers to classify library method calls
 * into semantic side-effect nodes (redis:write, redis:read, etc.).
 */

/**
 * Operation type for a library function.
 * Describes what kind of side effect the function performs.
 */
export type LibraryOperation =
  | 'read'
  | 'write'
  | 'delete'
  | 'subscribe'
  | 'publish'
  | 'transaction'
  | 'connection'
  | 'utility';

/**
 * Definition of a single library function/method.
 */
export interface LibraryFunctionDef {
  /** Method name (e.g., 'set', 'get', 'hset') */
  name: string;
  /** npm package name (e.g., 'ioredis') */
  package: string;
  /** Semantic operation type */
  operation: LibraryOperation;
  /** Whether the function has observable side effects */
  sideEffect: boolean;
  /** Index of the key/resource argument (0-based). undefined = no key argument */
  keyArgIndex?: number;
  /** Semantic node type to create (e.g., 'redis:write', 'redis:read') */
  nodeType: string;
  /** Human-readable description of why this classification was chosen */
  description: string;
}

/**
 * Definition of an npm library with all its known functions.
 */
export interface LibraryDef {
  /** Canonical package name (e.g., 'ioredis') */
  name: string;
  /** Alternative names for this package (e.g., ['redis'] for ioredis) */
  aliases: string[];
  /** Semantic category (e.g., 'cache', 'database', 'http-client') */
  category: string;
  /** All known functions in this library */
  functions: LibraryFunctionDef[];
}
