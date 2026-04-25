# REG-198: Proper Scope Breakdown

## Summary

Initial implementation was rejected because it used `brandNode()` as an escape hatch instead of creating proper factory methods. This document provides a proper breakdown of work required.

## Analysis of Inline Node Creation Sites

Total: **52 direct `addNode` calls** across **18 files** creating **~35 distinct node types**.

### Category A: Already Have NodeFactory Methods (Low Effort)

These analyzers create node types that already have factory methods - just need refactoring to use them.

| File | Node Types | Factory Methods Available |
|------|------------|---------------------------|
| JSModuleIndexer.ts | MODULE | `NodeFactory.createModule()` |
| IncrementalModuleIndexer.ts | MODULE | `NodeFactory.createModule()` |
| WorkspaceDiscovery.ts | SERVICE | `NodeFactory.createService()` |
| MonorepoServiceDiscovery.ts | SERVICE | `NodeFactory.createService()` |
| SimpleProjectDiscovery.ts | SERVICE | `NodeFactory.createService()` |

**Effort: 1-2 hours**

### Category B: Need Node Contracts + Factory Methods

These analyzers create specialized node types that need:
1. Node type definition in `nodes.ts`
2. Node contract class with `create()` and `validate()`
3. Factory method in `NodeFactory.ts`
4. Refactor analyzer to use factory

#### B1: Express/HTTP Analyzers (4-6 hours)

| File | Node Types Needed |
|------|-------------------|
| ExpressAnalyzer.ts | `http:route`, `express:mount`, `net:request` |
| FetchAnalyzer.ts | `http:request`, `EXTERNAL`, `net:request` |
| ExpressRouteAnalyzer.ts | `http:route`, `express:middleware` |

#### B2: Rust Analyzer (4-6 hours)

| File | Node Types Needed |
|------|-------------------|
| RustAnalyzer.ts | `RUST_CALL`, `RUST_FUNCTION`, `RUST_STRUCT`, `RUST_IMPL`, `RUST_METHOD`, `RUST_TRAIT` |
| RustModuleIndexer.ts | `RUST_MODULE` |

#### B3: React Analyzer (3-4 hours)

| File | Node Types Needed |
|------|-------------------|
| ReactAnalyzer.ts | `react:component`, `react:hook`, `dom:event`, `browser:api`, plus ISSUE nodes |

#### B4: SocketIO Analyzer (2-3 hours)

| File | Node Types Needed |
|------|-------------------|
| SocketIOAnalyzer.ts | `socketio:event`, `socketio:emit`, `socketio:on`, `socketio:room` |

#### B5: Database Analyzers (2-3 hours)

| File | Node Types Needed |
|------|-------------------|
| DatabaseAnalyzer.ts | `db:connection`, `db:query`, `db:table` |
| SQLiteAnalyzer.ts | `db:query` (reuse from DatabaseAnalyzer) |

#### B6: Service Layer Analyzer (2-3 hours)

| File | Node Types Needed |
|------|-------------------|
| ServiceLayerAnalyzer.ts | `SERVICE_CLASS`, `SERVICE_INSTANCE`, `SERVICE_REGISTRATION`, `SERVICE_USAGE` |

#### B7: Enrichers (2-3 hours)

| File | Node Types Needed |
|------|-------------------|
| NodejsBuiltinsResolver.ts | `EXTERNAL_MODULE`, `EXTERNAL_FUNCTION` |
| FunctionCallResolver.ts | `EXTERNAL_MODULE` (reuse) |
| ExternalCallResolver.ts | `EXTERNAL_MODULE` (reuse) |
| MountPointResolver.ts | Updates existing nodes (may need different approach) |

#### B8: Misc Analyzers (3-4 hours)

| File | Node Types Needed |
|------|-------------------|
| ExpressResponseAnalyzer.ts | Generic AST nodes (`OBJECT_LITERAL`, `VARIABLE`, `CALL`, `ARRAY_LITERAL`, `EXPRESSION`) |
| SystemDbAnalyzer.ts | `SYSTEM_DB_VIEW_REGISTRATION`, `SYSTEM_DB_SUBSCRIPTION` |
| JSASTAnalyzer.ts | `MODULE` (reuse) |
| IncrementalAnalysisPlugin.ts | Re-adds enriched nodes (special case) |

### Category C: GraphBuilder (Special Case)

GraphBuilder batches nodes and calls `addNodes()`. This is a legitimate use of internal branding since nodes come from validated factory calls.

**Approach:** Keep `brandNode()` usage here but make it internal/private.

## Proposed Subtasks

### Phase 1: Infrastructure (REG-198-A)
- [ ] Make `brandNode()` internal (not exported from types)
- [ ] Create internal branding helper for GraphBuilder/RFDBServerBackend
- [ ] Update GraphBackend interface to require `AnyBrandedNode`
- **Estimate: 2 hours**

### Phase 2: Category A - Existing Factory Methods (REG-198-B)
- [ ] Refactor JSModuleIndexer, IncrementalModuleIndexer
- [ ] Refactor WorkspaceDiscovery, MonorepoServiceDiscovery, SimpleProjectDiscovery
- **Estimate: 2 hours**

### Phase 3: Express/HTTP Nodes (REG-198-C)
- [ ] Create HttpRouteNode contract
- [ ] Create ExpressMountNode contract
- [ ] Create HttpRequestCallNode contract
- [ ] Create NetworkRequestNode contract (or reuse existing)
- [ ] Add factory methods
- [ ] Refactor ExpressAnalyzer, FetchAnalyzer, ExpressRouteAnalyzer
- **Estimate: 6 hours**

### Phase 4: Rust Nodes (REG-198-D)
- [ ] Create RustFunctionNode, RustStructNode, RustImplNode, RustMethodNode, RustTraitNode, RustCallNode contracts
- [ ] Create RustModuleNode contract
- [ ] Add factory methods
- [ ] Refactor RustAnalyzer, RustModuleIndexer
- **Estimate: 6 hours**

### Phase 5: React Nodes (REG-198-E)
- [ ] Create ReactComponentNode, ReactHookNode contracts
- [ ] Create DomEventNode, BrowserApiNode contracts
- [ ] Add factory methods
- [ ] Refactor ReactAnalyzer
- **Estimate: 4 hours**

### Phase 6: SocketIO Nodes (REG-198-F)
- [ ] Create SocketIOEmitNode, SocketIOOnNode, SocketIORoomNode contracts
- [ ] Add factory methods
- [ ] Refactor SocketIOAnalyzer
- **Estimate: 3 hours**

### Phase 7: Database Nodes (REG-198-G)
- [ ] Create DbConnectionNode, DbQueryNode, DbTableNode contracts
- [ ] Add factory methods
- [ ] Refactor DatabaseAnalyzer, SQLiteAnalyzer
- **Estimate: 3 hours**

### Phase 8: Service Layer Nodes (REG-198-H)
- [ ] Create ServiceClassNode, ServiceInstanceNode, ServiceRegistrationNode, ServiceUsageNode contracts
- [ ] Add factory methods
- [ ] Refactor ServiceLayerAnalyzer
- **Estimate: 3 hours**

### Phase 9: External Module Nodes (REG-198-I)
- [ ] Create ExternalModuleNode, ExternalFunctionNode contracts
- [ ] Add factory methods
- [ ] Refactor NodejsBuiltinsResolver, FunctionCallResolver, ExternalCallResolver
- **Estimate: 3 hours**

### Phase 10: Misc Analyzers (REG-198-J)
- [ ] Handle ExpressResponseAnalyzer (generic AST nodes)
- [ ] Create SystemDbNode contracts
- [ ] Refactor JSASTAnalyzer, IncrementalAnalysisPlugin
- **Estimate: 4 hours**

## Total Estimate

**36-40 hours** of implementation work.

## Recommended Approach

1. Create subtasks in Linear for each phase
2. Implement phases incrementally, each as a separate PR
3. Phase 1 (Infrastructure) blocks all others
4. Phases 2-10 can be parallelized after Phase 1

## Alternative: Phased Rollout

If full implementation is too much, consider:

1. **MVP Phase:** Phases 1-3 (Infrastructure + Express/HTTP)
   - Covers the most commonly used analyzers
   - ~10 hours

2. **Phase 2:** Rust + React + SocketIO
   - ~13 hours

3. **Phase 3:** Everything else
   - ~13 hours

This allows shipping incremental value while maintaining architectural integrity.
