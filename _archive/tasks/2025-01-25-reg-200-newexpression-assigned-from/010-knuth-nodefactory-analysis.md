# Donald Knuth: NodeFactory Architecture Analysis

## Problem Statement

NodeFactory has grown to 696 lines with 31 `create*` methods and is becoming a God Object. The constraint is critical: **nodes and SemanticIDs must NOT be created inline** because there must be a single point for validation, branding, consistency enforcement, and future auditing/logging.

## Current State Analysis

```
NodeFactory.createX() → NodeContract.create() → brandNode()
```

Problems:
1. **Linear Growth**: Every new node type requires 4+ changes
2. **Duplication**: Factory interfaces duplicate contract definitions
3. **Mixed Responsibilities**: Type dispatch, branding, validation, helpers, ID generation
4. **Inconsistent Patterns**: Some methods pure delegation, others add logic

## Proposed Solutions

### Option A: Generic Factory with Type Registry
Single generic `create<T>(type: T, ...args)` method with type inference.
- **Pros**: Minimal code, auto-scales
- **Cons**: Complex types, poor discoverability

### Option B: Decomposed Domain Factories ⭐ RECOMMENDED
Split into 8 domain-specific factories (~100 lines each).
- **Pros**: Focused responsibility, discoverable, incremental migration
- **Cons**: Multiple files, developers need to know which factory

### Option C: Contract Self-Registration
Contracts register themselves via static blocks.
- **Pros**: Zero manual registration
- **Cons**: ES2022+ required, import order matters

### Option D: Code Generation
Generate factory from contracts at build time.
- **Pros**: Explicit API, no manual sync
- **Cons**: Build complexity

## Recommendation: Option B

**Decomposed Domain Factories** is recommended because:
1. Matches project philosophy (clean, pragmatic)
2. Preserves discoverability (explicit methods)
3. Incremental migration possible
4. Appropriate granularity (~100 lines each)

## Migration Path

1. **Phase 1**: Create `/packages/core/src/core/factories/` structure
2. **Phase 2**: Migrate one domain at a time (delegate from NodeFactory)
3. **Phase 3**: Update consumers (optional, facade keeps backward compat)
4. **Phase 4**: Cleanup deprecated wrappers

## Suggested Domain Groupings

| Factory | Node Types | ~Lines |
|---------|------------|--------|
| CoreNodeFactory | SERVICE, ENTRYPOINT, MODULE | 80 |
| CodeNodeFactory | FUNCTION, CLASS, SCOPE, VARIABLE_DECLARATION, CONSTANT, PARAMETER | 180 |
| CallNodeFactory | CALL_SITE, METHOD_CALL, CONSTRUCTOR_CALL | 100 |
| TypeNodeFactory | INTERFACE, TYPE, ENUM, DECORATOR | 120 |
| DataFlowNodeFactory | EXPRESSION, LITERAL, OBJECT_LITERAL, ARRAY_LITERAL | 150 |
| IONodeFactory | HTTP_REQUEST, DATABASE_QUERY, EVENT_LISTENER, NETWORK_REQUEST | 100 |
| ImportExportNodeFactory | IMPORT, EXPORT, EXTERNAL_MODULE | 80 |
| IssueNodeFactory | ISSUE variants | 60 |

**Total**: ~870 lines distributed across 8 factories (~109 lines average)
