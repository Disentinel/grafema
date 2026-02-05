/**
 * Diagnostic Categories - Single source of truth for category/code mappings
 *
 * This module defines diagnostic categories once and derives both mapping
 * directions:
 * - DIAGNOSTIC_CATEGORIES: category → codes (used by CLI check command)
 * - CODE_TO_CATEGORY: code → category metadata (used by DiagnosticReporter)
 *
 * Adding a new diagnostic code requires updating only this file.
 */

/**
 * Category definition with human-readable metadata and associated codes
 */
export interface DiagnosticCategory {
  /** Human-readable name for display */
  readonly name: string;
  /** Description of what this category checks */
  readonly description: string;
  /** Diagnostic codes that belong to this category */
  readonly codes: readonly string[];
}

/**
 * Valid category keys
 */
export type DiagnosticCategoryKey = 'connectivity' | 'calls' | 'dataflow' | 'imports';

/**
 * Canonical definition of all diagnostic categories
 *
 * This is the SINGLE SOURCE OF TRUTH for category mappings.
 * Both CLI and DiagnosticReporter derive their mappings from this.
 */
export const DIAGNOSTIC_CATEGORIES: Record<DiagnosticCategoryKey, DiagnosticCategory> = {
  connectivity: {
    name: 'Graph Connectivity',
    description: 'Check for disconnected nodes in the graph',
    codes: ['ERR_DISCONNECTED_NODES', 'ERR_DISCONNECTED_NODE'],
  },
  calls: {
    name: 'Call Resolution',
    description: 'Check for unresolved function calls',
    codes: ['ERR_UNRESOLVED_CALL'],
  },
  dataflow: {
    name: 'Data Flow',
    description: 'Check for missing assignments and broken references',
    codes: ['ERR_MISSING_ASSIGNMENT', 'ERR_BROKEN_REFERENCE', 'ERR_NO_LEAF_NODE'],
  },
  imports: {
    name: 'Import Validation',
    description: 'Check for broken imports and undefined symbols',
    codes: ['ERR_BROKEN_IMPORT', 'ERR_UNDEFINED_SYMBOL'],
  },
};

/**
 * Metadata for code-to-category lookup (used by DiagnosticReporter)
 */
export interface CodeCategoryInfo {
  /** Human-readable name for the issue type */
  name: string;
  /** CLI command to check this category */
  checkCommand: string;
}

/**
 * Derived mapping: code → category metadata
 *
 * Auto-generated from DIAGNOSTIC_CATEGORIES.
 * Used by DiagnosticReporter to show actionable commands.
 */
export const CODE_TO_CATEGORY: Record<string, CodeCategoryInfo> = (() => {
  const result: Record<string, CodeCategoryInfo> = {};

  for (const [categoryKey, category] of Object.entries(DIAGNOSTIC_CATEGORIES)) {
    // Generate human-readable name from category name (lowercase, plural)
    const issueName = category.name.toLowerCase().replace('graph ', '');

    for (const code of category.codes) {
      result[code] = {
        name: issueName,
        checkCommand: `grafema check ${categoryKey}`,
      };
    }
  }

  return result;
})();

/**
 * Get category for a diagnostic code
 */
export function getCategoryForCode(code: string): CodeCategoryInfo | undefined {
  return CODE_TO_CATEGORY[code];
}

/**
 * Get all codes for a category
 */
export function getCodesForCategory(category: DiagnosticCategoryKey): readonly string[] {
  return DIAGNOSTIC_CATEGORIES[category].codes;
}
