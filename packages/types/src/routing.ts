/**
 * Routing Types — cross-service URL mapping for infrastructure-level routing.
 *
 * The RoutingMap is source-agnostic. It doesn't know where rules came from
 * (config.yaml, nginx.conf, k8s manifests). It only knows:
 * "request from service A with path P routes to service B with path P'"
 */

import type { Resource } from './resources.js';

/**
 * A routing rule describes how requests are transformed between services.
 * Source-agnostic — can come from config.yaml, nginx.conf, k8s, etc.
 */
export interface RoutingRule {
  /** Service where requests originate (matches ServiceDefinition.name) */
  from: string;
  /** Service where routes are defined (matches ServiceDefinition.name) */
  to: string;
  /** Path prefix to strip from request URL before matching.
   *  e.g., stripPrefix: '/api' transforms '/api/users' -> '/users' */
  stripPrefix?: string;
  /** Path prefix to add to request URL before matching.
   *  e.g., addPrefix: '/v2' transforms '/users' -> '/v2/users' */
  addPrefix?: string;
  /** Source of this rule (for debugging/traceability) */
  source?: string;
  /** Priority — lower numbers match first. Default: 0 */
  priority?: number;
}

/**
 * Context for matching a request against the routing map.
 */
export interface MatchContext {
  /** Service name where the request originates */
  fromService: string;
  /** Original request URL (before any transformation) */
  requestUrl: string;
  /** HTTP method (optional, for future method-based routing) */
  method?: string;
}

/**
 * Result of a routing match — the transformed URL to use for matching.
 */
export interface MatchResult {
  /** Transformed URL to match against route paths */
  transformedUrl: string;
  /** Service name where the route should be found */
  targetService: string;
  /** The rule that matched */
  rule: RoutingRule;
}

/**
 * RoutingMap Resource — abstract routing table built by multiple builder plugins.
 *
 * Resource ID: 'routing:map'
 */
export interface RoutingMap extends Resource {
  readonly id: 'routing:map';

  /**
   * Add a routing rule. Called by builder plugins during ENRICHMENT phase.
   * Duplicate rules (same from/to/strip/add) are silently deduplicated.
   */
  addRule(rule: RoutingRule): void;

  /** Add multiple rules at once. */
  addRules(rules: RoutingRule[]): void;

  /**
   * Find matching route transformation for a request context.
   *
   * If multiple rules match, returns the most specific one:
   * 1. Rules with longer stripPrefix match first (more specific)
   * 2. Among equal-length prefixes, lower priority number wins
   * 3. If still tied, first-added wins
   *
   * @returns MatchResult if a rule matches, null if no rule applies
   */
  findMatch(context: MatchContext): MatchResult | null;

  /** Find ALL matching rules for a from/to service pair. */
  findRulesForPair(fromService: string, toService: string): RoutingRule[];

  /** Get all rules (for debugging/logging). */
  getAllRules(): RoutingRule[];

  /** Get count of rules (for metrics). */
  get ruleCount(): number;
}

/** Well-known Resource ID for the RoutingMap */
export const ROUTING_MAP_RESOURCE_ID = 'routing:map' as const;
