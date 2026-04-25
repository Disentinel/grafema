# Вадим Auto-Review: REG-256

**Verdict:** APPROVE (with mandatory fixes before implementation)
**Reason:** Architecture is sound, plan is thorough and well-phased. Several concrete issues must be resolved during implementation that Steve partially identified but underestimated.

---

## Concerns

### 1. CRITICAL: `context.config` is NEVER set in ENRICHMENT phase — plan assumes it exists

The plan's ConfigRoutingMapBuilder reads `context.config.routing`, and ServiceConnectionEnricher reads `context.config.services`. But looking at the actual Orchestrator code (lines 1005-1013 in `Orchestrator.ts`), the ENRICHMENT phase call is:

```typescript
await this.runPhase('ENRICHMENT', { manifest, graph: this.graph, workerCount: this.workerCount });
```

And in `runPhase()`, the pluginContext is built as:

```typescript
const pluginContext: PluginContext = {
  ...context,  // spreads { manifest, graph, workerCount }
  onProgress, forceAnalysis, logger, strictMode, rootPrefix,
};
```

No `config` field. `pluginContext.config` is **undefined** for ENRICHMENT and VALIDATION phases. No existing enrichment plugin uses `context.config` — confirmed by grep.

Joel acknowledges this complexity in Step 3.1g (spending ~60 lines wrestling with it) and defers to Rob. Steve dismisses it as "not a blocker, Rob will figure it out." But this is the most dangerous part of the plan because:

- It requires modifying a critical code path (`runPhase`) that every single plugin touches
- The proposed approaches in 3.1g are increasingly hacky (casting, fallbacks, conditional merging)
- There is a **clean** solution: just add `config` when building pluginContext in `runPhase()` the same way `strictMode`, `logger`, etc. are added — from stored Orchestrator fields

**Mandatory fix:** Rob must add `config` construction in `runPhase()` as a dedicated line, not a spread hack:

```typescript
const pluginContext: PluginContext = {
  ...context,
  config: {
    projectPath: (context as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? '',
    services: this.configServices,
    routing: this.routing,
  },
  resources: this.resourceRegistry,
  // ... existing fields
};
```

This is clean, follows the pattern of `strictMode` and `logger`, and doesn't break existing plugins (they access `config?.projectPath` with optional chaining).

**Risk if not fixed properly:** Subtle undefined errors at runtime that only surface when routing is actually configured.

### 2. IMPORTANT: `routing` is NOT passed to OrchestratorOptions in CLI/MCP — plan omits this wiring

The plan (Joel's 006, Step 3.1b) adds `routing` to `OrchestratorOptions`. But looking at how the CLI creates the Orchestrator (analyze.ts line 389-401):

```typescript
const orchestrator = new Orchestrator({
  graph: backend as unknown as GraphBackend,
  plugins,
  serviceFilter: options.service || null,
  services: config.services.length > 0 ? config.services : undefined,
  strictMode,
  // ...
});
```

There is **no `routing` field** passed here. The plan says to wire it in Step 3.1b (add to OrchestratorOptions) and notes CLI/MCP changes in section 8.3, but the actual wiring code is never shown. Joel says "pass `config.routing` to OrchestratorOptions" in section 8.3 but doesn't include it in any code snippet.

**Mandatory fix:** The CLI must pass `routing` from loaded config to Orchestrator, just like it does for `services`:

```typescript
routing: config.routing,  // REG-256
```

And `GrafemaConfig.routing` must be populated in `mergeConfig()` and `loadConfig()` first (Steps 2.1-2.5 handle this correctly).

Same applies to MCP's analysis.ts and analysis-worker.ts.

### 3. IMPORTANT: `findMatch()` semantics mismatch with ServiceConnectionEnricher usage

Steve identified this (concern #2) but classified it as "medium" — it's actually important because the plan's code in section 5.5 is **actively buggy**.

The code in section 5.5 does this:

```typescript
const rules = routingMap.findRulesForPair(requestService, routeService);
for (const rule of rules) {
  const transformed = routingMap.findMatch({ fromService: requestService, requestUrl: url });
  if (transformed && transformed.targetService === routeService) {
    urlToMatch = transformed.transformedUrl;
    break;
  }
}
```

Issues:
1. It calls `findRulesForPair` but then ignores the `rules` — it calls `findMatch()` in the loop body, which searches ALL rules again
2. `findMatch()` iterates ALL service pairs, not just the one we want
3. The loop variable `rule` from `findRulesForPair` is never used

**Mandatory fix:** Use `findRulesForPair` + manual URL transformation (the enricher already knows the target service), or refactor `findMatch()` to accept `targetService` in `MatchContext`. The clean approach (per Steve's option A) is:

```typescript
if (requestService && routeService && routingMap) {
  const rules = routingMap.findRulesForPair(requestService, routeService);
  for (const rule of rules) {
    // Apply rule manually (RoutingMapImpl.applyRule logic)
    const transformed = applyRoutingRule(url, rule);
    if (transformed !== null) {
      urlToMatch = transformed;
      break;
    }
  }
}
```

This means either:
- Make `applyRule` a public method on RoutingMap (or a standalone function), OR
- Add `targetService` to `MatchContext` and use `findMatch`

Either way, the current plan code doesn't work as written.

### 4. MODERATE: Service path matching uses file paths from SERVICE nodes, but SERVICE nodes store absolute paths

In `buildServiceMap()` (section 5.3), the enricher queries SERVICE nodes and uses `node.file` as the path prefix. Looking at how SERVICE nodes are created in Orchestrator.discover() (line 867):

```typescript
const serviceNode = NodeFactory.createService(configSvc.name, servicePath, { ... });
```

Where `servicePath = join(projectPath, configSvc.path)` — this is an **absolute** path like `/Users/vadim/myproject/apps/backend`.

The `getServiceForFile` method then checks `filePath.startsWith(entry.path)`. Route nodes' `file` field also stores absolute paths, so this works **only if both use consistent absolute paths**.

The plan correctly uses absolute paths for SERVICE nodes (because the Orchestrator resolves them). But needs to verify:
- Do `http:route` and `http:request` nodes store absolute file paths?
- Is the path separator consistent?

**Action:** Rob should add a test case verifying the path matching works with actual absolute paths from the graph. This is not a blocker but a "verify during implementation" item.

### 5. MODERATE: MCP config.ts is missing several plugins that CLI has

Steve noted this (concern #5). Looking at MCP's BUILTIN_PLUGINS: it's missing `ImportExportLinker`, `ExpressHandlerLinker`, `CallbackCallResolver`, `ClosureCaptureEnricher`, `BrokenImportValidator`. These are all in CLI's BUILTIN_PLUGINS and DEFAULT_CONFIG.

Adding three new plugins to MCP's list won't cause errors, but the MCP will fail to resolve `ConfigRoutingMapBuilder`, `ServiceConnectionEnricher`, `UnconnectedRouteValidator` if they're not in BUILTIN_PLUGINS AND the config references them.

Since DEFAULT_CONFIG includes our new plugins, MCP MUST have them in its BUILTIN_PLUGINS too.

**Not a new problem, but the plan must not make it worse.** The plan correctly identifies MCP changes in section 8.3. Just ensure all three new plugins are added.

### 6. MINOR: Test files must be `.test.js`, not `.test.ts`

Joel's plan uses `.test.ts` in filenames (Step 1.9, 1.10, etc.). But the existing codebase uses `.test.js` exclusively — there are zero `.test.ts` files. The test command is `node --test 'test/unit/*.test.js'`. TypeScript test files would require a separate compilation step or ts-node.

**Mandatory fix:** All new test files must use `.test.js` extension. Tests import from `@grafema/core` (the dist output), so they don't need TypeScript.

### 7. MINOR: `customerFacing` marking via `graph.addNode()` — verify upsert behavior

Section 5.4 marks routes as customerFacing by calling `graph.addNode({ ...route, customerFacing: true })`. This relies on `addNode` being an upsert (merge fields into existing node).

Joel notes this in "Potential Issues" (section 3) and rates it "Medium" risk. It's actually low risk because:
- Both `GraphBackend` (in-memory) and `RFDBServerBackend` treat addNode as upsert
- The spread `{ ...route, customerFacing: true }` preserves all existing fields

**Action:** Add one explicit test case verifying that addNode-based update preserves existing route fields.

---

## Steve's Concerns Status

### Concern #1 (Medium): `findMatch` iterates ALL pairs instead of direct Map lookup
**Agree.** The implementation should use a Map indexed by `fromService` or at minimum a direct `this.rulesByPair.get(fromService + ':' + toService)` lookup instead of scanning all entries. With 1-20 rules it doesn't matter for performance, but the code is architecturally wrong — using a Map like a list.

### Concern #2 (Medium): `findMatch` returns first matching target service, not the right one
**Agree, but underestimated.** The plan's actual code in section 5.5 is actively buggy (see my concern #3 above). The enricher calls both `findRulesForPair` AND `findMatch` in a confused way. This must be resolved before implementation, not during.

### Concern #3 (Medium): Orchestrator config plumbing is messy
**Agree, and upgrading to IMPORTANT** (see my concern #1 above). This isn't just messy — `context.config` is literally `undefined` in ENRICHMENT. The plan's ConfigRoutingMapBuilder will fail silently (return `rulesLoaded: 0`) because it checks `config?.routing` with optional chaining. The user would see zero connections and no error. Silent failures are the worst kind of bug.

### Concern #4 (Minor): `connectivity` issue category undeclared
**Agree.** `IssueSpec.category` is typed as `string`, so it's open. No issue. The new category should be documented in a comment near the existing ones in the IssueSpec JSDoc (line 63 of plugins.ts already lists examples: 'security', 'performance', 'style', 'smell').

### Concern #5 (Minor): Test file extensions
**Agree, upgrading to mandatory.** All existing tests are `.test.js`. Must follow the pattern.

### Concern #6 (Minor): Hard dependency on ConfigRoutingMapBuilder
**Agree it's fine in practice.** DEFAULT_CONFIG includes it. Advanced users customizing plugin lists understand dependencies. But for future extensibility, when NginxRoutingMapBuilder exists, ServiceConnectionEnricher would need BOTH in its dependencies or switch to soft deps. Leave as-is for now, track for future.

---

## Additional Observations

### A. The plan creates `packages/core/src/resources/` directory for RoutingMapImpl

This is a NEW directory. Existing core code is organized as:
- `packages/core/src/core/` — core utilities (Profiler, NodeFactory, etc.)
- `packages/core/src/plugins/` — plugins by phase
- `packages/core/src/config/` — config loading
- `packages/core/src/storage/` — graph backends

A `resources/` directory is reasonable and follows the pattern. No concern.

### B. Plugin base class import path

Joel's ConfigRoutingMapBuilder imports from:
```typescript
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
```

This is correct — it matches existing plugins like HTTPConnectionEnricher which use the same relative import.

### C. Cross-validation of routing rules against services skips when services is empty

The `validateRouting()` function checks `if (serviceNames.size > 0)` before cross-validating. This means if a user defines routing rules but no services (relying on auto-discovery), the from/to names won't be validated at config load time.

This is acceptable behavior — auto-discovered services don't have config-level names. But the plan should document this limitation: routing rules only work with explicitly defined services (since auto-discovered services use a different naming scheme). This is already implicit in the UX vision but should be explicit in validation code comments.

### D. No `from === to` validation in routing rules

A routing rule where `from` and `to` are the same service is nonsensical (service routing to itself). The plan doesn't validate this. Low priority but easy to add:

```typescript
if (rule.from === rule.to) {
  throw new Error(`Config error: routing[${i}].from and .to cannot be the same service`);
}
```

### E. Backward compatibility when DEFAULT_CONFIG changes

When `HTTPConnectionEnricher` is replaced by `ServiceConnectionEnricher` + `ConfigRoutingMapBuilder` in DEFAULT_CONFIG (Phase 5), users who DON'T have a config file get the new behavior. Users WITH a config file that explicitly lists `HTTPConnectionEnricher` keep it. This is correct.

However, users who run `grafema init --force` to regenerate their config will get the new DEFAULT_CONFIG with `ServiceConnectionEnricher`. If their project depends on specific HTTPConnectionEnricher behavior, this could be surprising. Low risk but worth noting in release notes.

### F. MCP analysis-worker.ts Orchestrator call doesn't pass services/routing

Looking at the MCP analysis-worker.ts (line 235-248), the Orchestrator is created without `services` or `routing`:

```typescript
const orchestrator = new Orchestrator({
  graph: db,
  plugins,
  parallel: parallelConfig,
  serviceFilter: serviceName,
  indexOnly: indexOnly,
  onProgress: ...,
});
```

The plan notes changes needed in analysis-worker.ts (section 8.3) but only mentions "Import + register 3 new plugins." It doesn't mention passing `services` and `routing` to the Orchestrator constructor. The MCP has the SAME wiring gap as the CLI (concern #2), but the plan is even more vague about it.

---

## Summary

The architecture is well-designed. The Resource system, RoutingMap, and three-layer extraction model are all correct abstractions. Steve's approval is justified.

The concerns are all **implementation-level issues**, not architectural problems:

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | CRITICAL | `context.config` is undefined in ENRICHMENT | Build config in `runPhase()` from stored fields |
| 2 | IMPORTANT | `routing` not wired CLI/MCP -> Orchestrator | Add `routing` to Orchestrator constructor calls |
| 3 | IMPORTANT | `findMatch`/`findRulesForPair` usage is buggy | Pick one API, use it correctly |
| 4 | MODERATE | Service path matching — verify absolute paths | Add integration test |
| 5 | MODERATE | MCP missing plugins in BUILTIN_PLUGINS | Add all three new plugins |
| 6 | MINOR | Test files must be `.test.js` | Use correct extension |
| 7 | MINOR | Verify addNode upsert for customerFacing | Add test case |

None require architecture changes. All are solvable during implementation. But concerns #1-3 must be resolved in the implementation plan BEFORE coding starts, not left to "Rob will figure it out."
