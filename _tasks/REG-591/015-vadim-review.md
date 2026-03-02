## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK
**Commit quality:** minor issue (uncommitted changes)

---

### Acceptance Criteria Check

**1. Plugin API defined and documented** — SATISFIED

`DomainPlugin` and `DomainPluginResult` interfaces are defined in `packages/core-v2/src/types.ts` with comprehensive JSDoc:
- Contracts (pure function, no mutation, no I/O)
- "When to use / when not to use" guidance
- Parameter documentation for `analyzeFile(fileResult, ast)`
- Both types are exported from `packages/core-v2/src/index.ts`

`WalkOptions` interface in `walk.ts` is also exported, enabling callers to pass `{ domainPlugins }`.

**2. At least one domain analyzer (Express) ported to v2 plugin API** — SATISFIED

`packages/core/src/plugins/domain/ExpressPlugin.ts` (295 lines) fully implements `DomainPlugin`:
- Detects all 8 HTTP methods (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, ALL)
- Handles `app.use()` with and without path prefix
- Data-flow based detection: only processes variables that are `ASSIGNED_FROM` `express()` or `express.Router()` calls — no heuristic name matching
- Alias chain resolution via BFS by node ID (avoids shadowing false positives)
- Creates `http:route` and `express:mount` nodes with correct metadata
- Correctly wired into `CoreV2Analyzer` via `DOMAIN_PLUGIN_REGISTRY` and `config.domains` config key

**3. v1 domain analyzers can coexist with v2 plugins during transition** — SATISFIED

v1 analyzers (`JSASTAnalyzer`, `ExpressRouteAnalyzer`, `ExpressResponseAnalyzer`, `NestJSRouteAnalyzer`, etc.) remain entirely unchanged in the default pipeline (`ConfigLoader.DEFAULT_CONFIG`). `CoreV2Analyzer` is a separate plugin selected via `--engine v2`. There is zero coupling between the two code paths.

---

### Test Coverage

Three test files covering distinct concerns:

**`test/unit/argvalues.test.js`** — tests the `argValues` metadata field on CALL nodes:
- String literal args, mixed types, zero args, template literals (with and without expressions), numeric/boolean args, method call pattern, length invariant — comprehensive happy path and edge cases.

**`test/unit/domain-plugin-api.test.js`** — tests the plugin hook contract in `walkFile`:
- Backward compatibility (no plugins / empty plugins array)
- Plugin receives correct arguments (FileResult + AST)
- Node/edge/deferred merging
- Error isolation (throws in plugin, still runs others)
- Execution order, null/undefined return handling, invalid result validation
— All failure modes are covered.

**`test/unit/express-plugin.test.js`** — tests `ExpressPlugin` end-to-end:
- Basic detection, non-standard variable names, express.Router(), data-flow guard (non-express object named "app"), all HTTP methods, `app.use()` with/without path, dynamic path, alias chains, CommonJS require pattern, multiple routes in one file, node ID/name/structure validation
— Happy path and key false-positive guards are covered.

No "it doesn't crash" padding — every assertion validates specific behavior.

---

### Edge Cases and Concerns

**Minor documentation inconsistency (non-blocking):**
The JSDoc on `DomainPlugin` in `types.ts` (line 215) states:
> "A domain plugin analyzes one file AFTER walkFile() + resolveFileRefs() complete."

This is inaccurate. Domain plugins run INSIDE `walkFile()` after Stage 2 (scope resolution), but BEFORE `resolveFileRefs()` is called by `CoreV2Analyzer`. The inline comment in `walk.ts` at line 571 is correct: "Plugins run after Stage 2 (file-scope resolution is complete)."

In practice this distinction is irrelevant for current use cases — `ExpressPlugin` only needs ASSIGNED_FROM edges from Stage 2 which are available. But the documentation should match the implementation. This is not a blocker.

**`argValues` spread into RFDB node properties:**
`CoreV2Analyzer.mapNodes()` spreads all metadata fields into top-level node properties. Every CALL node will now have `argValues: (string|null)[]` stored in the graph. This is consistent with how other metadata fields (`method`, `object`, `arguments`, `chained`) are handled and does not break anything. It is an intentional design that makes domain plugin data queryable via Datalog.

**`${dynamic}` placeholder string in mount node IDs:**
When `app.use(dynamicPath, router)` is called, the mount node ID contains the literal string `${dynamic}`. This works correctly for the current use case and is tested. It is not a forbidden pattern in this context (it is a placeholder value, not a template literal expression).

---

### Scope Creep

None detected. The implementation is minimal and focused:
- `argValues` extraction (enables plugin pattern detection)
- `DomainPlugin` / `DomainPluginResult` interface definitions
- `WalkOptions` + `runDomainPlugins` hook in walkFile
- `ExpressPlugin` reference implementation
- `CoreV2Analyzer` wiring

No other domain analyzers were ported (correct per task scope: "Express first as reference implementation").

---

### Commit Quality

**Issue:** All implementation changes are uncommitted. The working tree has 5 modified files and 3 new test files with no commits on the branch above main. The implementation report (013-rob-implementation.md) describes 5 logical changes that should correspond to 5 atomic commits. This is not yet done.

The code itself is clean — no TODO/FIXME/HACK/XXX, no commented-out code, no mock/stub/fake in production code, no empty implementations, no scope creep.

**Required before merge:** Stage and commit the implementation in logical atomic units as described in the implementation report.
