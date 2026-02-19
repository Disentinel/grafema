/**
 * Shared HTTP path-matching utilities used by HTTPConnectionEnricher
 * and ServiceConnectionEnricher.
 *
 * Pure functions — no class state, no side effects.
 */

import type { BaseNodeRecord } from '@grafema/types';

/**
 * Normalize URL to canonical form for comparison.
 * Converts both Express params (:id) and template literals (${...}) to {param}.
 */
export function normalizeUrl(url: string): string {
  return url
    .replace(/:[A-Za-z0-9_]+/g, '{param}')
    .replace(/\$\{[^}]*\}/g, '{param}');
}

/**
 * Check if URL has any parameter placeholders (after normalization)
 */
export function hasParamsNormalized(normalizedUrl: string): boolean {
  return normalizedUrl.includes('{param}');
}

/**
 * Escape special regex characters in a string.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex that matches a normalized route pattern,
 * replacing each {param} placeholder with a [^/]+ segment.
 */
export function buildParamRegex(normalizedRoute: string): RegExp {
  const parts = normalizedRoute.split('{param}');
  const pattern = parts.map(part => escapeRegExp(part)).join('[^/]+');
  return new RegExp(`^${pattern}$`);
}

/**
 * Check if request URL matches route path.
 * Supports:
 * - Exact match
 * - Express params (:id)
 * - Template literals (${...})
 * - Concrete values matching params (/users/123 matches /users/:id)
 */
export function pathsMatch(requestUrl: string, routePath: string): boolean {
  const normRequest = normalizeUrl(requestUrl);
  const normRoute = normalizeUrl(routePath);

  // If both normalize to same string, they match
  if (normRequest === normRoute) {
    return true;
  }

  // If route has no params after normalization, require exact match
  if (!hasParamsNormalized(normRoute)) {
    return false;
  }

  // Handle case where request has concrete value (e.g., '/users/123')
  // and route has param (e.g., '/users/{param}')
  return buildParamRegex(normRoute).test(normRequest);
}

/**
 * Check if path has parameters (for edge matchType metadata).
 * Detects Express params (:id) and template literals (${...}).
 */
export function hasParams(path: string): boolean {
  if (!path) return false;
  return path.includes(':') || path.includes('${');
}

/**
 * Deduplicate nodes by ID, preserving first occurrence.
 */
export function deduplicateById<T extends BaseNodeRecord>(nodes: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const node of nodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      unique.push(node);
    }
  }

  return unique;
}
