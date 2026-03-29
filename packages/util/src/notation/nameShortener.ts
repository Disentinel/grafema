/**
 * Name Shortener — shortest-unambiguous-name within scope
 *
 * Given a set of display names in a subgraph, shorten them to the
 * minimum unique suffix. For example:
 *
 *   auth/login.ts -> UserDB.findByEmail  →  UserDB.findByEmail
 *   auth/login.ts -> createToken         →  createToken
 *   auth/utils.ts -> createToken         →  utils:createToken
 *
 * Phase 4 feature — placeholder for future implementation.
 *
 * @module notation/nameShortener
 */

/**
 * Shorten a display name to its shortest unambiguous form
 * within the given set of all names.
 *
 * Current implementation: return name as-is (no shortening).
 */
export function shortenName(name: string, _allNames: string[]): string {
  return name;
}
