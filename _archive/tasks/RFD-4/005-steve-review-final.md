# Steve Jobs Review: RFD-4 Semantic ID v2 -- Final

## Verdict: APPROVE

---

## What I checked

I read every line of the following files:

1. **`packages/core/src/core/SemanticId.ts`** -- all v2 functions: `computeSemanticIdV2`, `parseSemanticIdV2`, `computeContentHash`, plus types `ParsedSemanticIdV2`, `ContentHashHints`
2. **`packages/core/src/plugins/analysis/ast/CollisionResolver.ts`** -- full class, all methods
3. **`packages/core/src/plugins/analysis/ast/IdGenerator.ts`** -- v2 methods: `generateV2`, `generateV2Simple`, `getPendingNodes`, `resetPending`
4. **`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`** -- orchestration: shared IdGenerator creation, CollisionResolver invocation after visitors complete
5. **`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`** -- `resolveVariableInScope`, `resolveParameterInScope` with v2 `scopePath` field + v1 fallback
6. **`packages/core/src/core/ScopeTracker.ts`** -- `getNamedParent()` implementation
7. **All 6 visitors** -- `FunctionVisitor`, `CallExpressionVisitor`, `VariableVisitor`, `ClassVisitor`, `PropertyAccessVisitor`, `TypeScriptVisitor` -- verified v2 ID generation calls
8. **`packages/cli/src/commands/query.ts`** -- `matchesScope`, `extractScopeContext` with v2-first, v1-fallback
9. **`packages/cli/src/commands/trace.ts`** -- scope filtering with v2-first, v1-fallback
10. **`test/unit/SemanticIdV2.test.js`** -- 43 unit tests for core v2 functions
11. **`test/unit/CollisionResolver.test.js`** -- 11 tests covering all disambiguation paths
12. **`test/unit/SemanticIdV2Migration.test.js`** -- 18 integration tests including THE KEY TEST

I also reviewed Don's plan (`002-don-plan.md`) and Joel's technical spec (`003-joel-tech-plan.md`) to verify alignment.

## MANDATORY Architecture Checklist

### 1. Complexity Check: PASS

- `CollisionResolver.resolve()` runs O(n) where n = pending nodes in ONE file. Only CALL, METHOD_CALL, and PROPERTY_ACCESS types are pending nodes -- these are bounded by file size.
- `ScopeTracker.getNamedParent()` is O(d) where d = scope depth, typically <10.
- `computeContentHash()` is O(k) where k = hint string length, typically <50 chars.
- No O(n) over all nodes globally. No O(n) over all nodes of one type globally. This is clean.

### 2. Plugin Architecture: PASS

Forward registration pattern:
- Visitors register PendingNodes during AST traversal (forward pass)
- CollisionResolver resolves after all visitors complete (single post-hoc pass)
- No backward scanning, no pattern searching

The shared IdGenerator per file is the right abstraction. CallExpressionVisitor receives it via constructor injection from JSASTAnalyzer. Other visitors that only use `generateV2Simple` (no collisions) create local instances -- this is fine because `generateV2Simple` has no side effects on pending state.

### 3. Extensibility: PASS

Adding support for new node types requires:
- For unique-by-name types (like adding a new DECORATOR type): call `generateV2Simple()` -- zero CollisionResolver changes
- For collision-prone types: call `generateV2()` with appropriate ContentHashHints -- zero CollisionResolver changes
- Adding new content hint fields: add to `ContentHashHints` interface and `computeContentHash` -- CollisionResolver unchanged

The CollisionResolver is generic over all node types. Good.

## Assessment

### What is fundamentally right

**1. The core design decision is correct.** Removing anonymous scopes (if, for, try) from the ID format eliminates the cascade problem that made v1 IDs unstable. The `namedParent` concept captures enough context for human readability while staying immune to block insertion/removal. This is the right architecture.

**2. Graduated disambiguation is elegant.** The three-level approach (base ID -> content hash -> counter) minimizes noise in IDs. Most nodes get clean IDs (`file->TYPE->name[in:parent]`). Only collisions get hashes. Only identical-content collisions get counters. This means humans reading IDs see the simplest form that uniquely identifies the node.

**3. Separation of identity from resolution is the key insight.** Don's plan correctly identified that the ID was being used for two things: identity (which node) and resolution (where in scope). v2 separates these cleanly: ID for identity, `scopePath` field for resolution. This is architecturally sound.

**4. The CollisionResolver design is clean.** PendingNode with `collectionRef` mutation-in-place is a pragmatic solution to the cross-reference problem. The alternative (rewrite map) would have been one-to-many and broken. The actual implementation matches Joel's spec almost exactly.

**5. v1 fallback everywhere.** Every consumer (GraphBuilder, CLI query, CLI trace) tries v2 parsing first, falls back to v1. This means incremental migration is safe. CLASS and PARAMETER nodes still use v1 -- this is explicitly documented and doesn't break anything.

**6. Tests are comprehensive.** 43 unit tests for core functions, 11 for CollisionResolver, 18 integration tests including THE KEY TEST. The stability test (add an if-block, verify existing IDs don't change) directly validates the feature's raison d'etre.

### Issues found

**Issue 1: CLASS nodes still use v1 IDs (computeSemanticId via ClassNode.createWithContext)**

`ClassNode.createWithContext()` calls `computeSemanticId('CLASS', name, context)` which produces v1 format: `file->global->CLASS->ClassName`. This means CLASS nodes are NOT yet on v2.

The test file acknowledges this: `V1_SEMANTIC_TYPES = new Set(['CLASS', 'PARAMETER'])`.

**Severity: LOW.** CLASS names are unique within a file (language semantics). They are top-level or nested in another class. The v1 ID for classes is already stable because the scope path for classes is typically just `['global']` or `['ParentClass']` -- neither contains anonymous scopes. So the v1 IDs for CLASS nodes don't actually suffer from the cascade problem. Migrating them to v2 is future cleanup, not a functional gap.

**Issue 2: Variables inside counted scopes have v2 IDs but still rely on v1-era scopePath for resolution**

The test comment at line 206-209 of `SemanticIdV2Migration.test.js` says: "Variables inside counted scopes (if, for, try) still use v1 IDs which include the scope counter." But looking at the actual code in `VariableVisitor.ts`, variables DO get v2 IDs via `generateV2Simple()`. What's actually happening is that their `scopePath` field (used for resolution) still contains counted scopes like `['fetchData', 'if#0']`. The ID is v2 (`file->VARIABLE->response[in:fetchData]`), but the resolution path is full. This is correct -- as Joel's spec explicitly explains, the scope resolution needs the full path to model JavaScript lexical scoping correctly.

The test comment is slightly misleading (it says "v1 IDs" when it means "v1-era scope resolution"), but the implementation is correct.

**Severity: NONE.** This is a comment clarity issue, not a code issue.

**Issue 3: FunctionVisitor and VariableVisitor create local IdGenerator instances instead of using shared**

`FunctionVisitor` and `VariableVisitor` create `new IdGenerator(scopeTracker)` locally. These visitors only call `generateV2Simple()` which doesn't register pending nodes, so the local instance is fine. But this could be confusing -- why do some visitors get the shared instance and others don't?

**Severity: NONE.** `generateV2Simple()` is a pure function wrapper with no side effects. There's no functional difference between calling it on a shared vs local IdGenerator. The shared instance is only needed for `generateV2()` which registers pending nodes. The code is correct as-is.

### Vision alignment

Does this advance "AI should query the graph, not read code"?

**Yes.** Stable IDs are the foundation. If IDs change every time a developer adds an if-block, the graph becomes unreliable for cross-session queries. An AI agent that remembers "the response variable in fetchData" needs that ID to persist. v2 makes this possible. Before v2, adding a debug block would silently break every stored reference.

This is infrastructure work. It's invisible to the user. But without it, everything built on top (agents, trace history, diff analysis) would be built on sand.

### Did we cut corners?

**No.** The implementation follows the plan faithfully across all 8 phases. The v1 fallback pattern is thorough -- every consumer handles both formats. The test coverage is extensive: unit tests for all core functions, integration tests through the real pipeline, and THE KEY TEST that directly validates the problem statement.

The one area where a shortcut was taken (CLASS/PARAMETER still on v1) is explicitly documented and justified -- these types don't suffer from the cascade problem.

### Would shipping this embarrass us?

**No.** This is clean, well-tested infrastructure. The code is clear, the algorithms are documented with complexity analysis, and the test suite directly validates the feature's value proposition.

---

*"The most important thing is a person who has confidence in the vision. That vision has to be something that is right. And you can only be confident in the vision if you can see it clearly." -- The IDs now say what they mean: a name, a type, and where it lives. The anonymous scope noise is gone. That's clarity.*
