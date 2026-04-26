# REG-429: RoutingMapImpl — optimize findMatch with per-fromService index

**Source:** Linear issue REG-429
**Priority:** Low

## Request

Optimize `RoutingMapImpl.findMatch()` which currently iterates all entries in `rulesByPair` Map and filters by `key.startsWith(prefix)`. Replace with `Map<fromService, Map<toService, RoutingRule[]>>` for O(1) lookup by fromService.

**File:** `packages/core/src/resources/RoutingMapImpl.ts`

**Priority:** Low — only matters with 50+ routing rules which is unlikely in practice.
