/**
 * BuiltinRegistry - Registry for Node.js builtin functions (REG-218)
 *
 * Provides lookup for Node.js builtin modules and functions.
 * Used by NodejsBuiltinsResolver for lazy EXTERNAL_FUNCTION node creation.
 *
 * Usage:
 *   const registry = new BuiltinRegistry();
 *   if (registry.isBuiltinModule('fs')) {
 *     const funcDef = registry.getFunction('fs', 'readFile');
 *     if (funcDef) {
 *       // Create EXTERNAL_FUNCTION node with metadata
 *     }
 *   }
 */

import type { BuiltinFunctionDef, BuiltinModuleDef } from './types.js';
import { ALL_BUILTIN_MODULES } from './definitions.js';

export class BuiltinRegistry {
  /** Map of module name to module definition */
  private modules: Map<string, BuiltinModuleDef>;

  /** Map of "module:funcName" to function definition for fast lookup */
  private functions: Map<string, BuiltinFunctionDef>;

  constructor(modules: BuiltinModuleDef[] = ALL_BUILTIN_MODULES) {
    this.modules = new Map();
    this.functions = new Map();

    for (const mod of modules) {
      this.modules.set(mod.name, mod);

      for (const func of mod.functions) {
        const key = `${mod.name}:${func.name}`;
        this.functions.set(key, func);
      }
    }
  }

  /**
   * Check if module is a Node.js builtin module.
   * Handles node: prefix automatically.
   *
   * @param moduleName - Module name (e.g., 'fs', 'node:fs', 'fs/promises')
   * @returns true if module is a known builtin
   */
  isBuiltinModule(moduleName: string): boolean {
    const normalized = this.normalizeModule(moduleName);
    return this.modules.has(normalized);
  }

  /**
   * Normalize module name by stripping node: prefix.
   *
   * @param moduleName - Module name (e.g., 'node:fs', 'fs')
   * @returns Normalized module name (e.g., 'fs')
   */
  normalizeModule(moduleName: string): string {
    if (moduleName.startsWith('node:')) {
      return moduleName.slice(5); // Remove 'node:' prefix
    }
    return moduleName;
  }

  /**
   * Get function definition by module and function name.
   *
   * @param module - Module name (e.g., 'fs', 'node:fs')
   * @param funcName - Function name (e.g., 'readFile')
   * @returns Function definition or null if not found
   */
  getFunction(module: string, funcName: string): BuiltinFunctionDef | null {
    const normalizedModule = this.normalizeModule(module);
    const key = `${normalizedModule}:${funcName}`;
    return this.functions.get(key) || null;
  }

  /**
   * Check if function is a known builtin function.
   *
   * @param module - Module name
   * @param funcName - Function name
   * @returns true if function is known
   */
  isKnownFunction(module: string, funcName: string): boolean {
    return this.getFunction(module, funcName) !== null;
  }

  /**
   * Get all functions for a module.
   *
   * @param module - Module name
   * @returns Array of function definitions (empty if module not found)
   */
  getAllFunctions(module: string): BuiltinFunctionDef[] {
    const normalizedModule = this.normalizeModule(module);
    const mod = this.modules.get(normalizedModule);
    return mod ? mod.functions : [];
  }

  /**
   * List all supported builtin module names.
   *
   * @returns Array of module names
   */
  listModules(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Create node ID for EXTERNAL_FUNCTION node.
   *
   * Format: EXTERNAL_FUNCTION:{module}.{funcName}
   *
   * @param module - Module name (will be normalized)
   * @param funcName - Function name
   * @returns Node ID string
   */
  createNodeId(module: string, funcName: string): string {
    const normalizedModule = this.normalizeModule(module);
    return `EXTERNAL_FUNCTION:${normalizedModule}.${funcName}`;
  }
}
