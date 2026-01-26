/**
 * Global Symbols Registry
 *
 * Provides lookup for JavaScript/TypeScript global symbols.
 * Used by BrokenImportValidator to avoid false positives on globals.
 */

import { ALL_GLOBALS as DEFAULT_GLOBALS } from './definitions.js';

export {
  ECMASCRIPT_GLOBALS,
  NODEJS_GLOBALS,
  BROWSER_GLOBALS,
  TEST_GLOBALS,
  ALL_GLOBALS,
} from './definitions.js';

/**
 * GlobalsRegistry class for extensible globals management.
 *
 * Usage:
 *   const registry = new GlobalsRegistry();
 *   if (registry.isGlobal('console')) { ... }
 *   registry.addCustomGlobals(['myGlobal']);
 */
export class GlobalsRegistry {
  private globals: Set<string>;

  constructor(includeDefaults: boolean = true) {
    this.globals = includeDefaults
      ? new Set(DEFAULT_GLOBALS)
      : new Set();
  }

  /**
   * Check if a symbol name is a known global.
   */
  isGlobal(name: string): boolean {
    return this.globals.has(name);
  }

  /**
   * Add custom globals (e.g., from project config).
   */
  addCustomGlobals(names: string[]): void {
    for (const name of names) {
      this.globals.add(name);
    }
  }

  /**
   * Remove globals from the set (e.g., if project doesn't use browser env).
   */
  removeGlobals(names: string[]): void {
    for (const name of names) {
      this.globals.delete(name);
    }
  }

  /**
   * Get all registered globals.
   */
  getAllGlobals(): string[] {
    return Array.from(this.globals);
  }
}
