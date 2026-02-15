import type { RoutingMap, RoutingRule, MatchContext, MatchResult } from '@grafema/types';

/**
 * Default implementation of RoutingMap.
 *
 * Stores rules indexed by service pair for O(1) pair lookup.
 * For typical workloads (1-20 rules), this is optimal.
 *
 * Complexity:
 * - addRule: O(r) dedup check where r = rules for the pair
 * - findMatch: O(p * r + c * log c) where p = pairs from service, r = rules per pair, c = matching candidates
 * - findRulesForPair: O(1) map lookup + O(r) copy
 */
export class RoutingMapImpl implements RoutingMap {
  readonly id = 'routing:map' as const;

  /** Rules indexed by "from:to" key for O(1) lookup by service pair */
  private rulesByPair = new Map<string, RoutingRule[]>();
  /** All rules in insertion order */
  private allRules: RoutingRule[] = [];

  private pairKey(from: string, to: string): string {
    return `${from}:${to}`;
  }

  addRule(rule: RoutingRule): void {
    const key = this.pairKey(rule.from, rule.to);
    let rules = this.rulesByPair.get(key);
    if (!rules) {
      rules = [];
      this.rulesByPair.set(key, rules);
    }

    // Deduplicate: skip if identical rule already exists
    const isDuplicate = rules.some(
      r => r.stripPrefix === rule.stripPrefix && r.addPrefix === rule.addPrefix
    );
    if (!isDuplicate) {
      rules.push(rule);
      this.allRules.push(rule);
    }
  }

  addRules(rules: RoutingRule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  findMatch(context: MatchContext): MatchResult | null {
    // Collect all matching candidates across all target services
    const candidates: { rule: RoutingRule; transformedUrl: string }[] = [];
    const prefix = context.fromService + ':';

    for (const [key, rules] of this.rulesByPair.entries()) {
      if (!key.startsWith(prefix)) continue;

      for (const rule of rules) {
        const transformed = this.applyRule(context.requestUrl, rule);
        if (transformed !== null) {
          candidates.push({ rule, transformedUrl: transformed });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Sort: longer stripPrefix first, then lower priority number
    candidates.sort((a, b) => {
      const aLen = a.rule.stripPrefix?.length ?? 0;
      const bLen = b.rule.stripPrefix?.length ?? 0;
      if (aLen !== bLen) return bLen - aLen;
      return (a.rule.priority ?? 0) - (b.rule.priority ?? 0);
    });

    const best = candidates[0];
    return {
      transformedUrl: best.transformedUrl,
      targetService: best.rule.to,
      rule: best.rule,
    };
  }

  findRulesForPair(fromService: string, toService: string): RoutingRule[] {
    return [...(this.rulesByPair.get(this.pairKey(fromService, toService)) ?? [])];
  }

  getAllRules(): RoutingRule[] {
    return [...this.allRules];
  }

  get ruleCount(): number {
    return this.allRules.length;
  }

  /**
   * Apply a routing rule to transform a URL.
   * Returns transformed URL, or null if the rule's stripPrefix doesn't match.
   */
  private applyRule(url: string, rule: RoutingRule): string | null {
    let result = url;

    // Strip prefix
    if (rule.stripPrefix) {
      if (!result.startsWith(rule.stripPrefix)) {
        return null; // Rule doesn't apply — prefix doesn't match
      }
      const afterPrefix = result.slice(rule.stripPrefix.length);
      // Verify prefix boundary: next char must be '/' or end of string
      if (afterPrefix !== '' && !afterPrefix.startsWith('/')) {
        return null; // Partial prefix match (e.g., /api doesn't strip from /api-v2)
      }
      result = afterPrefix || '/';
    }

    // Add prefix
    if (rule.addPrefix) {
      if (result.startsWith('/') && rule.addPrefix.endsWith('/')) {
        result = rule.addPrefix + result.slice(1);
      } else {
        result = rule.addPrefix + result;
      }
    }

    return result;
  }
}

/** Factory function for creating a RoutingMap Resource */
export function createRoutingMap(): RoutingMapImpl {
  return new RoutingMapImpl();
}
