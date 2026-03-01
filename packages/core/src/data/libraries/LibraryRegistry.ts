/**
 * LibraryRegistry - Registry for npm library functions
 *
 * Provides lookup for npm package methods and their semantic classifications.
 * Used by enrichers (RedisEnricher, etc.) to create typed side-effect nodes
 * from CALL nodes to known library methods.
 *
 * Analogous to BuiltinRegistry for Node.js builtins.
 *
 * Usage:
 *   const registry = new LibraryRegistry();
 *   if (registry.isKnownLibrary('ioredis')) {
 *     const funcDef = registry.getFunction('ioredis', 'set');
 *     if (funcDef) {
 *       // Create redis:write node with metadata
 *     }
 *   }
 */

import type { LibraryDef, LibraryFunctionDef } from './types.js';
import { IOREDIS_LIBRARY } from './definitions/ioredis.js';

const DEFAULT_LIBRARIES: LibraryDef[] = [IOREDIS_LIBRARY];

export class LibraryRegistry {
  /** Map of package name (including aliases) → LibraryDef */
  private libraries: Map<string, LibraryDef>;

  /** Map of "package:method" → LibraryFunctionDef for fast lookup */
  private functions: Map<string, LibraryFunctionDef>;

  constructor(libraries: LibraryDef[] = DEFAULT_LIBRARIES) {
    this.libraries = new Map();
    this.functions = new Map();

    for (const lib of libraries) {
      this.registerLibrary(lib);
    }
  }

  /**
   * Register a library definition.
   * Indexes by canonical name and all aliases.
   */
  registerLibrary(def: LibraryDef): void {
    // Register under canonical name
    this.libraries.set(def.name, def);

    // Register under aliases
    for (const alias of def.aliases) {
      this.libraries.set(alias, def);
    }

    // Index all functions
    for (const func of def.functions) {
      // Index by canonical name
      this.functions.set(`${def.name}:${func.name}`, func);

      // Index by aliases
      for (const alias of def.aliases) {
        this.functions.set(`${alias}:${func.name}`, func);
      }
    }
  }

  /**
   * Get library definition by package name (or alias).
   *
   * @param packageName - Package name (e.g., 'ioredis', 'redis')
   * @returns Library definition or null if not found
   */
  getLibrary(packageName: string): LibraryDef | null {
    return this.libraries.get(packageName) ?? null;
  }

  /**
   * Get function definition by package and method name.
   *
   * @param packageName - Package name (e.g., 'ioredis')
   * @param methodName - Method name (e.g., 'set')
   * @returns Function definition or null if not found
   */
  getFunction(packageName: string, methodName: string): LibraryFunctionDef | null {
    return this.functions.get(`${packageName}:${methodName}`) ?? null;
  }

  /**
   * Check if package is a known library.
   *
   * @param packageName - Package name (including aliases)
   * @returns true if package is registered
   */
  isKnownLibrary(packageName: string): boolean {
    return this.libraries.has(packageName);
  }

  /**
   * List all registered library names (canonical only, no aliases).
   */
  listLibraries(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const lib of this.libraries.values()) {
      if (!seen.has(lib.name)) {
        seen.add(lib.name);
        result.push(lib.name);
      }
    }

    return result;
  }
}
