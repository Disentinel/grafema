/**
 * JavaScript Global Functions (REG-583)
 *
 * DEPRECATED SET REMOVED. See runtimeCategories.ts for the authoritative
 * source of truth about JS global function categorization.
 *
 * This file now re-exports from runtimeCategories.ts for backward
 * compatibility with CallResolverValidator's 'require' handling.
 *
 * `require` is NOT in any of the runtime category sets because it is
 * already modeled via IMPORT/REQUIRES_MODULE nodes. It has no CALLS edge.
 */
export const REQUIRE_BUILTINS = new Set(['require']);
