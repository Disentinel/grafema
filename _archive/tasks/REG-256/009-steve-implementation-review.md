## Steve Jobs Implementation Review -- REG-256

**Verdict:** APPROVE
**Reason:** The implementation is architecturally sound, properly modular, forward-looking, and aligns with the project vision. The Resource system is generic, the RoutingMap is source-agnostic, the enricher properly replaces HTTPConnectionEnricher with backward compatibility, and the validation layer adds real user value. No shortcuts, no hacks.

---

### Vision Alignment

**Strong alignment.** The core thesis is "AI should query the graph, not read code." This implementation:

1. **Cross-service HTTP connections become graph edges** -- previously, a frontend `fetch('/api/users')` and a backend `GET /users` route lived in different services with no graph connection because the infrastructure-level URL transformation (`/api` prefix stripping) was invisible to the analyzer. Now these are connected via `INTERACTS_WITH` edges through the RoutingMap.

2. **Config-as-code for infrastructure knowledge** -- the routing rules in `config.yaml` encode infrastructure knowledge (nginx proxy rules, API gateway prefixes) that was previously only in devops heads. This makes it queryable.

3. **ISSUE nodes for unconnected routes** -- customer-facing routes without frontend consumers surface as `issue:connectivity` warnings in the graph. This is exactly the kind of insight that makes "query the graph" superior to "read the code."

4. **Resource system enables future extensibility** -- nginx.conf parser, k8s manifest reader, etc. can all feed into the same RoutingMap without changing any enricher code.

---

### Architecture Quality

**Excellent. Properly layered separation of concerns.**

1. **Resource system (`resources.ts` + `ResourceRegistry.ts`)**
   - Generic, not RoutingMap-specific. The `Resource` interface is minimal (just `id`). The `ResourceRegistry` uses `getOrCreate` with factory pattern -- clean lazy initialization.
   - Scoped to pipeline run (created at start, cleared at end in `Orchestrator.run()`). This is correct -- Resources are ephemeral computation artifacts, not persisted graph data.
   - The `ResourceId` convention (`domain:name`) is sensible for namespacing.

2. **RoutingMap (`routing.ts` + `RoutingMapImpl.ts`)**
   - Source-agnostic as claimed. The `RoutingRule` has `from`, `to`, `stripPrefix`, `addPrefix`, `priority`, and `source` -- this covers nginx, k8s, and custom gateway patterns.
   - `findMatch()` returns `MatchResult` with `transformedUrl`, `targetService`, and the matched `rule` -- sufficient context for the enricher.
   - Deduplication in `addRule()` prevents multiple builders from creating redundant rules.

3. **ConfigRoutingMapBuilder (ENRICHMENT plugin)**
   - Single responsibility: reads `config.routing`, writes to RoutingMap Resource. Does NOT touch the graph.
   - Uses `getOrCreate` so it safely coexists with future nginx/k8s builders.
   - Proper graceful degradation: no routing rules = no-op, no ResourceRegistry = warn and no-op.

4. **ServiceConnectionEnricher (ENRICHMENT plugin)**
   - Properly replaces `HTTPConnectionEnricher`. I verified the matching logic (normalizeUrl, pathsMatch, buildParamRegex, hasParams, deduplicateById) is ported verbatim.
   - Added: service ownership resolution from SERVICE nodes, RoutingMap URL transformation, customerFacing marking.
   - Backward compatible: works identically to HTTPConnectionEnricher when no routing/services configured (falls back to direct path matching).
   - The old `HTTPConnectionEnricher` class is kept in the codebase (for users who reference it in custom configs) but removed from `DEFAULT_CONFIG`.

5. **UnconnectedRouteValidator (VALIDATION plugin)**
   - Clean separation: only checks routes with `customerFacing: true` flag. Internal routes don't trigger warnings.
   - Uses `reportIssue()` API properly (creates ISSUE node + AFFECTS edge).
   - Graceful when `reportIssue` is unavailable.

6. **Orchestrator integration**
   - `ResourceRegistryImpl` created once, passed to all plugins via `context.resources`.
   - Cleared at start and end of each `run()` call.
   - Routing rules passed through `config.routing` to plugin context.
   - Both single-root and multi-root paths handle Resources correctly.

7. **ConfigLoader validation**
   - `validateRouting()` cross-validates rule `from`/`to` against service names.
   - Validates `stripPrefix`/`addPrefix` must start with `/`.
   - `customerFacing` validated as boolean on `ServiceDefinition`.

---

### Complexity Analysis

**MANDATORY checklist -- all items pass.**

1. **Iteration space:**
   - `ServiceConnectionEnricher.execute()`: O(requests * routes) -- this is the same as `HTTPConnectionEnricher` (no regression). For typical projects: 10-100 requests, 20-200 routes. Acceptable.
   - `buildServiceMap()`: O(s) where s = SERVICE nodes (2-5 typically).
   - `markCustomerFacingRoutes()`: O(routes * services) -- O(routes * 2..5). Acceptable.
   - `RoutingMapImpl.findMatch()`: Iterates over all pairs in `rulesByPair` with `startsWith` filter. With typical 1-20 rules, this is negligible. Could be optimized with per-fromService indexing but not necessary at current scale.

2. **Plugin architecture:**
   - **Forward registration**: ConfigRoutingMapBuilder reads config, stores in RoutingMap Resource. ServiceConnectionEnricher reads RoutingMap. No backward pattern scanning.
   - **Extends existing enricher pass**: ServiceConnectionEnricher replaces HTTPConnectionEnricher in the same slot. No extra iteration over the graph.

3. **Extensibility:**
   - Adding nginx.conf support requires ONLY a new builder plugin (e.g., `NginxRoutingMapBuilder`). No changes to `ServiceConnectionEnricher` or `RoutingMapImpl`. This is correct plugin architecture.

4. **No brute-force**: The enricher queries specific node types (`http:route`, `http:request`, `SERVICE`) and applies transformations only when routing rules exist for the relevant service pair.

---

### Code Quality

**Clean, follows existing patterns, no shortcuts.**

Minor observations (not blocking):

1. **RoutingMapImpl.findMatch() line 55**: Iterates all `rulesByPair` entries with `key.startsWith(prefix)` instead of maintaining a per-fromService index. With typical rule counts (1-20), this is fine. If rule counts ever grow, a `Map<fromService, Map<toService, RoutingRule[]>>` would be more efficient.

2. **ServiceConnectionEnricher.markCustomerFacingRoutes()**: Uses `graph.addNode()` to update the `customerFacing` flag on existing route nodes. This is an upsert pattern (addNode with same ID overwrites). Works correctly with the mock graph and RFDB, but the intent might be clearer with an explicit `updateNode` if such a method existed.

3. **HTTPConnectionEnricher still exists** but is correctly removed from `DEFAULT_CONFIG`. It remains available for backward compatibility if users have it in their custom configs. This is the right approach -- no breaking change.

---

### Test Quality

**Thorough, well-structured, 88 tests all passing.**

1. **ResourceRegistryImpl tests (11 tests)**: Cover `getOrCreate`, `get`, `has`, `clear`, wrong-id factory, re-creation after clear. Complete.

2. **RoutingMapImpl tests (22 tests)**: Cover `addRule`/dedup, `addRules`, `findRulesForPair`, `findMatch` with stripPrefix/addPrefix/combined/priority, no-rules fallback, multiple service pairs, factory function. Thorough edge cases including partial prefix match prevention (`/api` not stripping from `/api-v2`), double-slash prevention, root `/` result.

3. **ConfigRoutingMapBuilder tests (8 tests)**: Cover rules loading, empty/missing rules, missing ResourceRegistry, source attribution, multiple rules, pre-existing RoutingMap. Good coverage of graceful degradation paths.

4. **ServiceConnectionEnricher tests (34 tests)**: Cover all ported HTTPConnectionEnricher behavior (exact match, fullPath, parametric, template literals, method handling, HTTP_RECEIVES edges) PLUS new routing transformation (stripPrefix, addPrefix, combined), service ownership (nested services, missing files), customerFacing marking, unknown method handling (strict/non-strict), backward compatibility.

5. **UnconnectedRouteValidator tests (13 tests)**: Cover customer-facing with no consumers, non-customer-facing skip, connected customer-facing skip, issue message content, category/severity, targetNodeId, missing file/line, multiple issues counting, missing reportIssue, fullPath vs path priority.

**No gaps found.** Tests exercise both happy paths and edge cases.

---

### Issues Found

None blocking.

**Minor items (non-blocking):**

- `RoutingMapImpl.findMatch()` could use a per-fromService index for larger rule sets, but current O(rules) iteration is fine for 1-20 rules.
- The `HTTPConnectionEnricher` class should eventually be deprecated with a warning log, but keeping it silently available is acceptable for now.
- The `findMatch` method in `RoutingMapImpl` creates a `candidates` array and sorts it on every call. For typical 1-3 matching candidates this is fine, but a priority queue would be more efficient if rule counts grew significantly.

**Verdict: APPROVE.** This is a well-architected, properly modular implementation that advances the project vision without shortcuts.
