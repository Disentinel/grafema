## Vadim Auto-Review -- REG-256 Implementation

**Verdict:** APPROVE
**Reason:** Clean, well-structured implementation with thorough test coverage. Backward compatibility preserved, edge cases handled, no loose ends.

### Correctness

The implementation correctly delivers all 6 components:

1. **ResourceRegistry** (`packages/core/src/core/ResourceRegistry.ts`) -- Simple Map-based registry with getOrCreate/get/has/clear. The id mismatch check in `getOrCreate` (line 17) prevents a subtle bug where factory returns wrong resource type. Correct.

2. **RoutingMapImpl** (`packages/core/src/resources/RoutingMapImpl.ts`) -- Rules indexed by "from:to" key for O(1) pair lookup. Deduplication checks `stripPrefix` and `addPrefix` (lines 35-36). The `applyRule` method correctly:
   - Returns null when stripPrefix doesn't match (line 106)
   - Guards against partial prefix match like `/api` matching `/api-v2` (lines 109-111)
   - Normalizes empty result to `/` (line 113)
   - Prevents double-slash when addPrefix ends with `/` (lines 118-119)

   Priority sorting (lines 69-74): longer stripPrefix first, then lower priority number. This is correct -- more specific rules win.

3. **ConfigRoutingMapBuilder** (`packages/core/src/plugins/enrichment/ConfigRoutingMapBuilder.ts`) -- Reads `config.routing`, creates RoutingMap resource, adds rules with `source: 'config'` attribution. Gracefully handles: no routing rules, no ResourceRegistry, empty config. All paths return success with metadata.

4. **ServiceConnectionEnricher** (`packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts`) -- This is the core piece. It:
   - Builds service map from SERVICE nodes (sorted by path length desc for longest-prefix match)
   - Applies routing transformations only when both services are determined
   - Falls back to direct URL matching when no routing exists (backward compat)
   - Marks customerFacing routes via graph addNode with spread
   - Preserves all HTTPConnectionEnricher matching logic (normalizeUrl, pathsMatch, buildParamRegex)

5. **UnconnectedRouteValidator** (`packages/core/src/plugins/validation/UnconnectedRouteValidator.ts`) -- Only checks `customerFacing: true` routes. Correct use of `reportIssue` API. Handles missing file/line gracefully.

6. **Config validation** (`packages/core/src/config/ConfigLoader.ts`, `validateRouting`) -- Cross-validates `from`/`to` against service names. Validates prefix format (must start with `/`). Skips cross-validation when services array is empty.

### Edge Cases

**No routing rules in config**: ConfigRoutingMapBuilder returns early with `rulesLoaded: 0`, RoutingMap resource is never created. ServiceConnectionEnricher gets `null` from `resources?.get()` and falls back to direct matching. **Tested** (ConfigRoutingMapBuilder test line 75-93, ServiceConnectionEnricher test line 873-897).

**Empty services array**: `markCustomerFacingRoutes` returns 0 immediately (line 334). `transformUrl` returns original URL when services can't be determined. **Tested** (ServiceConnectionEnricher test line 899-928).

**ResourceRegistry not available in context**: ConfigRoutingMapBuilder checks `context.resources` (line 43-46) and returns gracefully. ServiceConnectionEnricher uses optional chaining `context.resources?.get<RoutingMap>(...)` (line 96). **Tested** (ConfigRoutingMapBuilder test line 110-125).

**URL edge cases**:
- Trailing slashes: The `applyRule` method handles `/api` matching `/api` (empty result becomes `/`). **Tested** (RoutingMapImpl test line 101-112).
- Partial prefix: `/api` does NOT strip from `/api-v2` (boundary check at line 110-111). **Tested** (RoutingMapImpl test line 89-99).
- Double slashes: `addPrefix: '/v2/'` + URL `/users` correctly becomes `/v2/users` not `/v2//users`. **Tested** (RoutingMapImpl test line 129-141).

**Route without file path**: ServiceConnectionEnricher falls back to direct matching since service can't be determined. **Tested** (ServiceConnectionEnricher test line 1008-1037).

**Single-service project (no routing needed)**: Works exactly like old HTTPConnectionEnricher. **Tested** (ServiceConnectionEnricher test line 1232-1264).

### Code Quality

- Clean separation of concerns: types in `@grafema/types`, implementation in `@grafema/core`
- No forbidden patterns (TODO, FIXME, HACK, mock outside tests)
- No commented-out code
- All methods are well-documented with JSDoc including complexity annotations
- Pattern matching with existing codebase (extends Plugin base class, uses createSuccessResult/createErrorResult, follows same import style)
- The `ServiceConnectionEnricher` correctly declares its dependencies including `ConfigRoutingMapBuilder` (line 79), ensuring correct toposort ordering

### Test Coverage

**88 tests passing across 5 test files** (plus ConfigLoader tests):

| File | Tests | Coverage |
|------|-------|----------|
| ResourceRegistry.test.js | 8 | getOrCreate, get, has, clear, wrong-id-throw, multi-resource, re-creation |
| RoutingMapImpl.test.js | 16 | addRule, dedup, stripPrefix, addPrefix, combined, priority, no-rules, multiple-pairs, factory |
| ConfigRoutingMapBuilder.test.js | 9 | happy path, empty rules, undefined config, no registry, source attribution, multiple rules, pre-existing resource |
| ServiceConnectionEnricher.test.js | 31 | Basic matching (8), HTTP_RECEIVES (5), template literals (5), routing transform (7), service ownership (3), customerFacing (3) |
| UnconnectedRouteValidator.test.js | 11 | issue creation, non-CF routes, CF with edges, message format, category, severity, targetNodeId, no file/line, count, no reportIssue |
| ConfigLoader.test.ts (routing) | 15+ | validateRouting, mergeConfig routing, loadConfig routing validation |

Tests cover happy paths AND failure modes meaningfully. Tests communicate intent clearly through descriptive names.

### Potential Issues

None blocking. The implementation is solid.

### Nitpicks (non-blocking)

1. **`ServiceConnectionEnricher` line 102**: `const config = context.config as OrchestratorConfig & { routing?: RoutingRule[] }` -- The `routing` field already exists on `OrchestratorConfig` (line 219 of plugins.ts), so the intersection type is redundant. However, this is cosmetic and harmless since TypeScript will just merge them.

2. **`RoutingMapImpl` findMatch complexity comment** (line 11): States `O(p * r * log r)` but the `log r` factor comes from the sort which happens after collecting ALL candidates. For typical workloads (1-20 rules), this is a non-issue, but the comment is slightly imprecise -- it's `O(p * r + c * log c)` where `c` is the number of matching candidates. Non-blocking, just a documentation precision point.

3. **`analysis-worker.ts` still has `HTTPConnectionEnricher` in its builtinPlugins map** (line 180): This is fine because the worker uses config-driven plugin selection, and the default config no longer includes HTTPConnectionEnricher. The presence in the registry just means it's still available for explicit use. However, this file also imports it (line 35), which is a minor dead-code concern if no config ever references it. Non-blocking.

4. **MCP `config.ts`** does not include several enrichment plugins that are in DEFAULT_CONFIG (ClosureCaptureEnricher, ExpressHandlerLinker, ImportExportLinker, CallbackCallResolver). This is a pre-existing gap, NOT introduced by this PR.

### Commit Quality

Three atomic commits with clear messages:
1. `0d26197` -- Phase 1: Resource system and RoutingMap infrastructure (types + implementations)
2. `97d5ea2` -- Phase 2-3: Config validation and Orchestrator wiring
3. `eb330e1` -- Phase 4-6: Three plugins + registration

Each commit is logically coherent. The phased approach ensures each commit builds on the previous without breaking anything.

### Backward Compatibility

- HTTPConnectionEnricher file still exists and is exported (not deleted)
- HTTPConnectionEnricher is still in CLI and MCP BUILTIN_PLUGINS registries (available for explicit config use)
- HTTPConnectionEnricher is removed from DEFAULT_CONFIG enrichment list, replaced by ConfigRoutingMapBuilder + ServiceConnectionEnricher
- ServiceConnectionEnricher produces identical behavior to HTTPConnectionEnricher when no routing/services are configured (tested explicitly)
- ResourceRegistry is optional (`context.resources?`) -- plugins that don't need it are unaffected
