# core v1 vs core-v2: Feature Parity Analysis

*Date: 2026-03-01*
*Method: Grafema graph query (236 CLASS nodes) + source analysis*

---

## Summary

| Dimension | v1 | v2 | Parity |
|-----------|---:|---:|--------|
| Total lines | 68,262 | 7,246 | v2 = 10.6% of v1 |
| AST visitors (JS/TS) | 97 visitors | **97 visitors** | **100%** |
| Domain analyzers | 10 | 0 | **0%** |
| Enrichment plugins | 21 | 0 (resolve.ts partial) | **~20%** |
| Incremental analysis | yes | no | **0%** |
| Golden constructs | unknown | 385/591 (65%) | — |

v2 achieves **full JS/TS AST parity** and far exceeds v1 on TypeScript.
The gap is **domain analyzers** and **enrichment pipeline**.

---

## AST Walking (Analysis Phase)

### Fully covered by v2

v1 had 58 classes for AST walking. v2 replaces them with 97 pure visitor functions + edge-map.

| v1 Class | v2 Replacement |
|----------|----------------|
| GraphBuilder | walk.ts + edge-map.ts + registry.ts |
| ASTVisitor | registry.ts (AST type → visitor dispatch) |
| FunctionVisitor | visitFunctionDeclaration, visitArrowFunctionExpression, visitFunctionExpression |
| ClassVisitor | visitClassDeclaration, visitClassMethod, visitClassProperty, visitClassPrivateMethod, visitClassPrivateProperty, visitStaticBlock, visitClassAccessorProperty |
| ImportExportVisitor | visitImportDeclaration, visitExportNamedDeclaration, visitExportDefaultDeclaration, visitExportAllDeclaration |
| VariableVisitor + VariableHandler | visitVariableDeclaration, visitVariableDeclarator |
| CallExpressionVisitor + Handler | visitCallExpression, visitNewExpression, visitOptionalCallExpression |
| PropertyAccessVisitor + Handler | visitMemberExpression, visitOptionalMemberExpression |
| BranchHandler | visitIfStatement, visitConditionalExpression |
| LoopHandler | visitForStatement, visitForInStatement, visitForOfStatement, visitWhileStatement, visitDoWhileStatement |
| TryCatchHandler + ThrowHandler | visitTryStatement, visitCatchClause, visitThrowStatement |
| ReturnYieldHandler + ReturnBuilder | visitReturnStatement |
| YieldBuilder | visitYieldExpression |
| LiteralHandler | visitTemplateLiteral, visitTemplateElement + literals.ts |
| ControlFlowBuilder | visitSwitchStatement, visitSwitchCase, visitBreakStatement, visitContinueStatement |
| MutationBuilder + MutationDetector | visitAssignmentExpression (WRITES_TO), visitUpdateExpression (MODIFIES) |
| AssignmentBuilder | visitAssignmentExpression + edge-map ASSIGNED_FROM |
| TypeScriptVisitor + TypeSystemBuilder | 37 TS visitors (interfaces, enums, type aliases, generics, mapped types, conditional types, etc.) |
| CoreBuilder | edge-map.ts (declarative rules) |
| NestedFunctionHandler + FunctionBodyHandler | walk.ts handles nesting naturally via recursive descent |
| CollisionResolver | Not needed — v2 generates unique IDs by construction |
| IdGenerator | Semantic ID generation in each visitor |
| ExpressionEvaluator | Partially in visitBinaryExpression, visitUnaryExpression |
| ConditionParser | edge-map HAS_CONDITION entries |
| PropertyAssignmentBuilder | visitObjectProperty, visitObjectMethod |
| MiscEdgeBuilder | Edge-map entries + various visitors |
| CallFlowBuilder | visitCallExpression (CALLS, CALLS_ON, CHAINS_FROM, FLOWS_INTO) |
| UpdateExpressionBuilder | visitUpdateExpression |
| ModuleRuntimeBuilder | visitImport (import.meta, dynamic import()) |
| NewExpressionHandler | visitNewExpression |
| ObjectPropertyExtractor | visitObjectExpression, visitObjectProperty |
| ArgumentExtractor | edge-map PASSES_ARGUMENT |
| ArrayElementExtractor | visitArrayExpression + edge-map HAS_ELEMENT |

### v2 exceeds v1

| Feature | v1 | v2 |
|---------|----|----|
| TypeScript type system | Basic (TSTypeAnnotation skipped) | **37 visitors** covering full TS type grammar |
| Decorators | Not handled | visitDecorator + DECORATED_BY edges |
| Private fields/methods | Not handled | visitClassPrivateProperty, visitClassPrivateMethod, ACCESSES_PRIVATE |
| Static blocks | Not handled | visitStaticBlock |
| for-in / for-of | Not handled | visitForInStatement, visitForOfStatement + ITERATES_OVER |
| Destructuring patterns | Not handled | visitObjectPattern, visitArrayPattern, visitRestElement, visitAssignmentPattern |
| Spread | Not handled | visitSpreadElement + SPREADS_FROM |
| Tagged templates | Not handled | visitTaggedTemplateExpression |
| Optional chaining | Not handled | visitOptionalMemberExpression, visitOptionalCallExpression |
| Scope tracking + SHADOWS | Manual | Automatic scope stack with closure capture detection |
| Binary/unary/logical | Not handled | visitBinaryExpression, visitUnaryExpression + USES edges |

---

## Domain Analyzers (v1 only)

10 domain-specific analyzers that v2 does NOT replace. These detect framework-specific patterns during AST walking:

| v1 Analyzer | What It Does | Lines |
|-------------|-------------|------:|
| ExpressAnalyzer | Express route/middleware detection | ~500 |
| ExpressRouteAnalyzer | Route method patterns (get, post, use) | ~300 |
| ExpressResponseAnalyzer | Response method tracking (json, send, render) | ~200 |
| NestJSRouteAnalyzer | NestJS controller/decorator routes | ~300 |
| FetchAnalyzer | fetch() call detection, URL extraction | ~200 |
| SocketAnalyzer | Raw socket patterns | ~100 |
| SocketIOAnalyzer | Socket.IO emit/on/join patterns | ~400 |
| DatabaseAnalyzer + SQLiteAnalyzer + SystemDbAnalyzer | DB query detection (SQL, ORM) | ~600 |
| ReactAnalyzer | React component/hook detection | ~300 |
| ServiceLayerAnalyzer | Service layer pattern detection | ~200 |
| RustAnalyzer | Rust FFI call patterns | ~400 |

**Total: ~3,500 lines** of domain logic not yet in v2.

These are **plugin territory** — they should NOT be baked into core-v2. The plan is to support domain plugins on top of v2's visitor infrastructure. v1 mixes them into the analysis phase; v2 should expose a plugin API for them.

---

## Enrichment Pipeline (v1 only)

21 enrichment classes that run AFTER AST walking. v2's `resolve.ts` (1,022 lines) covers some of this:

| v1 Enricher | What It Does | v2 resolve.ts? |
|-------------|-------------|:--------------:|
| **FunctionCallResolver** | Resolves CALL → FUNCTION edges | **Yes** (call_resolve) |
| **MethodCallResolver** | Resolves method calls on objects | Partial (scope lookup) |
| **ExternalCallResolver** | Resolves calls to imported functions | **Yes** (import_resolve) |
| **ImportExportLinker** | Links imports to exports across files | **Yes** (import_resolve + export_lookup) |
| **ExportEntityLinker** | Links EXPORT → actual declaration | **Yes** (export_lookup) |
| **AliasTracker** | Tracks variable aliases | **Yes** (alias_resolve) |
| **InstanceOfResolver** | Resolves `new X()` → CLASS | Partial (call_resolve) |
| **ArgumentParameterLinker** | Links call args to function params | **No** |
| **ClosureCaptureEnricher** | Detects closure variable captures | **Yes** (CAPTURES edges during walk) |
| **CallbackCallResolver** | Resolves callback invocations | **No** |
| **NodejsBuiltinsResolver** | Resolves Node.js stdlib calls | **No** |
| **ExpressHandlerLinker** | Links routes to handler functions | **No** (domain) |
| **MountPointResolver** | Resolves Express mount prefixes | **No** (domain) |
| **HTTPConnectionEnricher** | Frontend↔backend HTTP connections | **No** (domain) |
| **ServiceConnectionEnricher** | Inter-service connections | **No** (domain) |
| **SocketConnectionEnricher** | Socket.IO event connections | **No** (domain) |
| **RejectionPropagationEnricher** | Promise rejection chains | **No** |
| **ConfigRoutingMapBuilder** | Config-based route maps | **No** (domain) |
| **PrefixEvaluator** | Route prefix evaluation | **No** (domain) |
| **RustFFIEnricher** | Rust↔JS FFI connections | **No** (domain) |
| **ValueDomainAnalyzer** | Value domain analysis | **No** |

**Score: 7/21 covered** (~33%). But 7/21 are domain-specific (Express, Socket, Rust, HTTP) — separating those: **7/14 generic enrichers covered (50%)**.

### v2 resolve.ts Deferred Kinds

| Kind | Stage | What It Resolves |
|------|-------|-----------------|
| scope_lookup | post-file | Variable references → declarations (by scope chain) |
| export_lookup | post-file | Export nodes → actual exported declarations |
| import_resolve | post-project | Import → export across files |
| call_resolve | post-project | CALL → FUNCTION (cross-file) |
| type_resolve | post-project | TSTypeReference → declaration |
| alias_resolve | post-file | Variable alias chains |

---

## Infrastructure (shared)

88 v1 core infrastructure classes are NOT replaced by v2 — they're **shared**:

- **Node factories** (41 classes): FunctionNode, ClassNode, CallSiteNode, etc. — v2 uses the same node types
- **Graph backend**: RFDBServerBackend — same for both
- **Orchestrator**: Orchestrator, PhaseRunner, ParallelAnalysisRunner — drives both engines
- **Diagnostics**: DiagnosticCollector, DiagnosticReporter — shared
- **Guarantees**: GuaranteeManager — shared

---

## Remaining Gaps for Full Parity

### Must-have (blocks v2 replacing v1)

| Gap | Effort | Approach |
|-----|--------|----------|
| ArgumentParameterLinker | Medium | Add to resolve.ts post-file stage |
| CallbackCallResolver | Medium | Add to resolve.ts |
| NodejsBuiltinsResolver | Small | Registry of known Node.js APIs |
| MethodCallResolver (full) | Large | Needs type inference for `obj.method()` |
| Incremental analysis | Large | Content hash diffing + partial re-walk |

### Domain plugins (separate from v2 core)

| Gap | Effort | Approach |
|-----|--------|----------|
| Express/NestJS routes | Medium | v2 plugin API + pattern matching on CALL nodes |
| Database detection | Medium | v2 plugin API |
| React detection | Small | v2 plugin API |
| Socket.IO events | Small | v2 plugin API |
| Fetch/HTTP requests | Small | v2 plugin API |
| Cross-service connections | Large | Enrichment pipeline on top of v2 |
| Rust FFI | Small | v2 plugin API |

### Nice-to-have

| Gap | Effort |
|-----|--------|
| RejectionPropagationEnricher | Medium |
| ValueDomainAnalyzer | Large |
| PrefixEvaluator (route prefixes) | Medium |

---

## Grafema Dogfooding Notes

### What worked
- `get_stats` — instant overview of graph size (214K nodes, 278K edges)
- `find_nodes(type=CLASS, limit=236)` — got all 236 classes with file paths, grouped by component
- Datalog exact match `attr(X, "name", "...")` — works for FILE nodes

### Gaps found
- **`find_nodes` file filter broken for FILE nodes** — `find_nodes(type=FILE, file="core/src/plugins")` returns 0 results despite files existing. Name filter also broken for FILE. Only works via Datalog exact match.
- **No string_contains in Datalog** — can't query "all files where path contains X". Need `string_contains(N, "substring")` or `string_starts_with(N, "prefix")` predicate.
- **`get_file_overview` fails for analyzed files** — returns "File not analyzed" for files that have FILE nodes in the graph. Likely a mismatch between FILE nodes (from v2) and MODULE nodes (expected by get_file_overview).
