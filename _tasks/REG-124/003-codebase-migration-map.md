# REG-124: Codebase Migration Map

**Author:** Codebase Exploration Agent
**Date:** 2026-02-06

## Executive Summary

**Total Codebase Size:** 59.5K LOC
- **Core (packages/core):** 47.9K LOC - 160 files (primary migration candidate)
- **Types (packages/types):** 1.3K LOC - 6 files (boundary/API)
- **CLI (packages/cli):** 6.9K LOC - 25 files (stays in TypeScript)
- **MCP (packages/mcp):** 3.3K LOC - 9 files (stays in TypeScript)
- **RFDB Server (Rust):** 14.5K LOC - 28 files (already Rust)

---

## 1. Size Breakdown by Module

### packages/core/src (47,879 LOC, 160 files)

| Submodule | Files | LOC | Priority | Notes |
|-----------|-------|-----|----------|-------|
| **plugins/** | 69 | 30,965 | MEDIUM | Analyzers, enrichers, discovery - highly polymorphic. Would benefit from pattern matching. Heavy Babel usage (54 imports). |
| **core/** | 58 | 9,787 | HIGH | Node factories, visitor orchestration, core logic. Massive verbosity potential. |
| **Orchestrator.ts** | 1 | 928 | MEDIUM | Phase management, plugin coordination. Good candidate for Rust (deterministic control flow). |
| **storage/** | 2 | 935 | LOW | Database connection management - thin wrapper around RFDB. |
| **queries/** | 5 | 897 | LOW | Datalog query builders - light layer over graph backend. |
| **api/** | 2 | 706 | LOW | Public API exports, orchestration wrappers. |
| **diagnostics/** | 5 | 749 | MEDIUM | Issue reporting, diagnostic collection. Could be simpler in Rust. |
| **data/** | 7 | 687 | MEDIUM | Data structures for analysis results. Would benefit from algebraic data types. |
| **config/** | 2 | 360 | LOW | Configuration loading - YAML parsing (already external). |
| **schema/** | 3 | 355 | LOW | Validation schemas. Keep with TypeScript for JSON Schema compatibility. |
| **utils/** | 2 | 404 | LOW | Utilities (mostly location tracking). Keep where used. |
| **validation/** | 1 | 342 | LOW | Validation logic. Thin layer. |
| **errors/** | 1 | 297 | LOW | Error types. Expose via FFI. |
| **logging/** | 1 | 152 | LOW | Logger interface. Keep as TypeScript protocol. |
| **index.ts** | 1 | 315 | LOW | Exports. Becomes Rust entry point. |

### packages/types/src (1,269 LOC, 6 files)

| File | LOC | Content | Keep in? |
|------|-----|---------|----------|
| **nodes.ts** | 331 | 30+ node type definitions, union types, helper functions | **TypeScript** - boundary definition |
| **edges.ts** | 281 | Edge type definitions, constants, helpers | **TypeScript** - boundary definition |
| **plugins.ts** | 341 | PluginContext, PluginResult, PluginMetadata, Logger interface | **TypeScript** - plugin contract |
| **rfdb.ts** | 318 | GraphBackend interface, NodeFilter, query types | **TypeScript** - boundary definition |
| **branded.ts** | 127 | Branded types for type safety | **TypeScript** - compile-time only |
| **index.ts** | 71 | Re-exports | **TypeScript** |

**Strategic decision:** Keep all types in TypeScript as boundary definitions. Expose Rust data structures via TypeScript type definitions (FFI layer).

### packages/cli/src (6,886 LOC, 25 files)

| Directory | LOC | Decision |
|-----------|-----|----------|
| **commands/** | 6,206 | **STAY in TypeScript** - CLI commands, user interaction, formatting |
| **utils/** | 622 | **STAY in TypeScript** - CLI helpers, display formatting |
| **cli.ts** | 58 | **STAY in TypeScript** - CLI bootstrap |

**Rationale:** CLI is I/O-bound, uses commander/ink/react for TUI. No algorithmic complexity. Orchestrates core via API.

### packages/mcp/src (3,340 LOC, 9 files)

| File | LOC | Decision |
|------|-----|----------|
| **handlers.ts** | 1,180 | **STAY in TypeScript** - MCP protocol implementation |
| **definitions.ts** | 508 | **STAY in TypeScript** - MCP tool/resource definitions |
| **analysis-worker.ts** | 295 | **STAY in TypeScript** - Worker thread coordination |
| **state.ts** | 296 | **STAY in TypeScript** - Session state management |
| **analysis.ts** | 186 | **STAY in TypeScript** - Analysis result formatting |
| **types.ts** | 278 | **STAY in TypeScript** - MCP-specific types |
| **config.ts** | 205 | **STAY in TypeScript** - Configuration |
| **utils.ts** | 204 | **STAY in TypeScript** - Helper functions |
| **server.ts** | 188 | **STAY in TypeScript** - MCP server setup |

**Rationale:** MCP server is protocol adapter. Pure TypeScript handles JSON serialization elegantly. No algorithmic bottleneck here.

---

## 2. Verbosity Hotspots in Core

### A. Node Type Definitions (36 Node Types)

**Location:** `packages/core/src/core/nodes/*.ts`
**Total LOC:** 4,052 across 36 files
**Average per node:** ~112 LOC

**Top 10 Largest Node Types:**

| Node Type | File | LOC | Key Fields |
|-----------|------|-----|-----------|
| **ExpressionNode** | ExpressionNode.ts | 232 | object, property, computed, operator, path, baseName, propertyPath, arrayIndex |
| **ConstructorCallNode** | ConstructorCallNode.ts | 217 | className, arguments, instantiates, throwsErrors |
| **FunctionNode** | FunctionNode.ts | 178 | async, generator, exported, params, returnType, signature |
| **IssueNode** | IssueNode.ts | 177 | category, severity, message, targetNodeId |
| **NodeKind.ts** | NodeKind.ts | 171 | All node type constants (BASE + NAMESPACED) |
| **EntrypointNode** | EntrypointNode.ts | 164 | path, methods, isDefault |
| **GuaranteeNode** | GuaranteeNode.ts | 162 | priority, status, schema, condition, owner |
| **ScopeNode** | ScopeNode.ts | 145 | scopeType, parentScopeId, capturesFrom |
| **MethodCallNode** | MethodCallNode.ts | 145 | objectName, methodName, isAsync, isStatic |
| **MethodNode** | MethodNode.ts | 143 | className, async, static, kind |

**Boilerplate Pattern:** Each node has:
1. Interface definition (4-8 fields)
2. Options interface
3. Factory class with:
   - TYPE constant
   - REQUIRED/OPTIONAL static arrays
   - Validation in `create()` method
   - Optional name computation helper
   - ~15-25 lines of repetitive field assignment

**Verbosity Analysis:**
- 40% is duplicated validation logic (could be macro or generic in Rust)
- 30% is field assignment boilerplate
- 20% is type definitions
- 10% is actual logic

**Rust Reduction Potential:**
- ADTs eliminate optional fields boilerplate
- Pattern matching replaces conditional validation
- Derive macros handle most serialization
- **Estimated reduction: 60-70% of node definition code**

### B. AST Visitor Patterns (8 Visitor Classes)

**Location:** `packages/core/src/plugins/analysis/ast/visitors/`
**Total LOC:** 3,825

| Visitor | LOC | Complexity | Key Operations |
|---------|-----|----------|-----------------|
| **CallExpressionVisitor** | 1,435 | VERY HIGH | Call site extraction, method detection, event handlers, constructor calls |
| **VariableVisitor** | 513 | MEDIUM | Variable/constant declaration tracking |
| **ClassVisitor** | 638 | HIGH | Class definition, constructor, method extraction |
| **FunctionVisitor** | 419 | MEDIUM | Function declaration, parameters, scope |
| **ImportExportVisitor** | 374 | MEDIUM | Import/export tracking, specifier extraction |
| **TypeScriptVisitor** | 262 | MEDIUM | TypeScript-specific syntax |
| **ASTVisitor** (base) | 148 | MEDIUM | Base visitor protocol |

**Boilerplate Patterns:**
1. **Visitor registration:** Each visitor manually registers handlers
2. **Error handling:** Try-catch blocks with error collection (50+ patterns)
3. **Node extraction:** Repeated pattern of location info → ID → metadata → push
4. **Scope tracking:** Manual scope ID resolution using ScopeTracker

**TypeScript-Specific Overhead:**
- Babel types are extremely granular (`NodePath`, union types)
- Type guards scattered throughout
- Manual type narrowing in 10+ locations per visitor
- Comments/metadata extraction (5-10 helper functions per visitor)

**Rust Reduction Potential:**
- Pattern matching on AST nodes (instead of if-type guards)
- Sum types eliminate optional fields
- Derive macros for metadata extraction
- Compile-time parsing rules
- **Estimated reduction: 50-60% of visitor code**

### C. Enricher Plugins

**Location:** `packages/core/src/plugins/enrichment/`

**Pattern:**
- Boilerplate: metadata getter, plugin context handling, result construction
- Core logic: graph traversal, scope chain walking, edge creation
- Error handling: Try-catch, collection, reporting

**Rust Reduction Potential:**
- Graph traversal can use iterators
- Chain walking becomes recursive descent
- Error handling via Result<T,E>
- **Estimated reduction: 40-50%**

---

## 3. Plugin Boundary Analysis

### Plugin Interface Structure

**Location:** `packages/types/src/plugins.ts` + `packages/core/src/plugins/Plugin.ts`

**Plugin Contract:**
```typescript
interface IPlugin {
  metadata: PluginMetadata;
  execute(context: PluginContext): Promise<PluginResult>;
  initialize?(context: PluginContext): Promise<void>;
  cleanup?(): Promise<void>;
}

interface PluginContext {
  graph: GraphBackend;
  manifest?: unknown;
  config?: OrchestratorConfig;
  phase?: PluginPhase;
  logger?: Logger;
  reportIssue?(spec: IssueSpec): Promise<string>;
  strictMode?: boolean;
}

interface PluginResult {
  success: boolean;
  created: { nodes: number; edges: number };
  errors: Error[];
  warnings: string[];
}
```

### Plugin Phases (5 Phases)

| Phase | Plugins | Data Flow |
|-------|---------|-----------|
| **DISCOVERY** | SimpleProjectDiscovery, PackageJsonDiscovery | Filesystem → File list |
| **INDEXING** | JSModuleIndexer, ... | Files → Modules + basic nodes |
| **ANALYSIS** | JSASTAnalyzer, ExpressAnalyzer, DatabaseAnalyzer, ... | AST → Nodes + Edges |
| **ENRICHMENT** | ClosureCaptureEnricher, ImportExportLinker, ... | Graph → Enhanced edges |
| **VALIDATION** | ValidateGuarantees, ... | Graph → Issues |

### WASM/FFI Boundary Proposal

**Core Analysis Engine (Rust) ↔ Plugin System (TypeScript)**

**What Crosses Boundary:**

1. **Input (TypeScript → Rust)**
   - File paths (Vec<String>)
   - File contents (String)
   - Configuration (JSON struct)
   - Manifest data (JSON)

2. **Output (Rust → TypeScript)**
   - Node records (Vec<NodeRecord>)
   - Edge records (Vec<EdgeRecord>)
   - Errors/warnings (Vec<Error>)
   - Metrics (AnalysisMetrics)

3. **Graph Access (Both ways)**
   - Query interface: `graph.queryNodes(filter)` → async iterator
   - Mutation: `graph.createNode()`, `graph.createEdge()` → async
   - **Complexity:** Async iteration must work through boundary

**FFI Strategy:**
- Node/edge types remain in TypeScript types package
- Serialization via JSON (serde_json in Rust)
- WASM module with typed bindings (tsoa-like)
- Plugins stay in TypeScript, call Rust via WASM

### Plugin Creation Analysis

**69 plugins in core:**
- 18 analysis plugins (Express, Socket.IO, React, Database, etc.)
- 8 visitor patterns
- ~10 enrichers
- 5 validators
- Discovery/indexing plugins

**Decision:** Plugins that are framework-specific stay in TypeScript:
- Can be updated without recompiling
- Plugin authors can contribute without Rust knowledge
- Language-specific variants easier in TS

**Analysis core (AST parsing, node extraction) moves to Rust:**
- Pure data transformation
- Performance-critical
- No I/O or side effects

---

## 4. Dependencies on JS Ecosystem

### @babel/parser Usage

**Files importing:** 54 occurrences across core

**Primary usage:**
- `packages/core/src/core/ASTWorker.ts` - Parse all files in worker threads
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Main analysis
- 12+ analyzer plugins (DatabaseAnalyzer, ExpressAnalyzer, etc.)
- Visitor implementations

**Babel Parser features used:**
```typescript
import { parse, ParserPlugin } from '@babel/parser';

parse(code, {
  sourceType: 'module',
  plugins: [
    'typescript',
    'jsx',
    'classProperties',
    'decorators',
    'asyncGenerators',
    'logicalAssignment',
    'optionalChaining',
    'nullishCoalescingOperator',
    'partialApplication',
  ],
  attachComment: true,  // For grafema-ignore comments
})
```

**Replacement Options for Rust:**
1. **Swc** - Rust-based JavaScript compiler
   - Same feature set as Babel
   - 20x faster
   - WASM bindings available
   - **Recommendation:** Use Swc for JS/TS parsing in Rust

2. **tree-sitter** (not currently used)
   - Would require different analysis approach
   - Lighter-weight but less semantic info
   - Not recommended

### @babel/traverse Usage

**Files importing:** 14 occurrences

**Purpose:** AST traversal with visitor pattern

**Replacement in Rust:**
- Swc provides AST structures
- Manual traversal (recursive descent) or use visitor macro patterns
- Rust's pattern matching is more ergonomic than babel's visitor protocol

---

## 5. Migration Summary Table

| Module | Current LOC | **Decision** | Why | Rust LOC Est. | TS LOC Est. |
|--------|-------------|-------------|-----|--------------|------------|
| **Node Factories** | 4,052 | → **Rust** | ADTs eliminate boilerplate | 1,200-1,600 | 300 (types only) |
| **AST Visitors** | 3,825 | → **Rust** | Pattern matching + Swc integration | 1,800-2,200 | 0 |
| **Graph Builders** | ~2,000 | → **Rust** | Node/edge creation logic | 800-1,000 | 100 |
| **Enrichers** | ~3,500 | **Mixed** | Core logic → Rust, orchestration ↔ TS | 1,200-1,500 | 1,500-1,800 |
| **Orchestrator** | 928 | → **Rust** | Deterministic phase management | 400-600 | 200 |
| **Plugin System** | ~5,000 | **Stays TypeScript** | Framework-specific, extensible | 0 | 5,000 |
| **CLI** | 6,886 | **Stays TypeScript** | I/O + TUI, no algorithmic bottleneck | 0 | 6,886 |
| **MCP Server** | 3,340 | **Stays TypeScript** | Protocol adapter, not performance-critical | 0 | 3,340 |
| **Types Boundary** | 1,269 | **Stays TypeScript** | Interface definitions, compile-time only | 0 | 1,269 |
| **RFDB Server** | 14,516 | **Already Rust** | Graph database engine | 14,516 | 0 |

**Total Migration Scope:**
- **Rust:** ~6,000-7,500 LOC (vs current 47,879 TS in core)
- **Stays TypeScript:** ~17,495 LOC (plugins, CLI, MCP, types)
- **Reduction:** 50-65% less code in core analysis path

---

## 6. Specific Hotspot Examples

### Example 1: ExpressionNode Boilerplate

**Current TypeScript (232 LOC):**
```typescript
interface ExpressionNodeRecord extends BaseNodeRecord {
  type: 'EXPRESSION';
  column: number;
  expressionType: string;
  object?: string;
  property?: string;
  computed?: boolean;
  // ... 8 more optional fields
}

interface ExpressionNodeOptions {
  object?: string;
  property?: string;
  computed?: boolean;
  // ... duplicated
}

export class ExpressionNode {
  static readonly TYPE = 'EXPRESSION' as const;
  static readonly REQUIRED = [...];
  static readonly OPTIONAL = [...];

  static create(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionNodeOptions = {}
  ): ExpressionNodeRecord {
    if (!expressionType) throw new Error('...');
    if (!file) throw new Error('...');
    if (!line) throw new Error('...');
    if (column === undefined) throw new Error('...');

    const node: ExpressionNodeRecord = {
      id: `${file}:EXPRESSION:${expressionType}:${line}:${column}`,
      type: this.TYPE,
      name: this._computeName(expressionType, options),
      file,
      line,
      column,
      expressionType
    };

    // 12+ conditional field assignments
    if (options.object !== undefined) node.object = options.object;
    // ...
    return node;
  }
}
```

**Rust ADT (50-70 LOC):**
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Expression {
    Member {
        object: String,
        property: String,
        computed: bool,
    },
    Binary {
        operator: String,
        path: Option<String>,
    },
    // ...
}

impl Expression {
    pub fn create(
        kind: &str,
        file: &str,
        line: u32,
        column: u32,
        data: ExpressionData,
    ) -> Result<Self> {
        let id = format!("{}:EXPRESSION:{}:{}:{}", file, kind, line, column);
        match kind {
            "MemberExpression" => Ok(Expression::Member { ... }),
            "BinaryExpression" => Ok(Expression::Binary { ... }),
            _ => Err(format!("Unknown expression: {}", kind)),
        }
    }
}
```

**Savings: 70% reduction** (232 → ~70 LOC)

### Example 2: CallExpressionVisitor Pattern Matching

**Current Babel/TypeScript (1,435 LOC)** — nested if-else chains with type guards

**Rust with Swc (300-400 LOC):**
```rust
fn visit_call_expr(&mut self, call: &CallExpression) {
    match &*call.callee {
        Callee::Expr(expr) => match expr.as_ref() {
            Expression::Identifier(id) => {
                self.handle_function_call(&id.sym, &call.args);
            }
            Expression::Member(member) => {
                match member.object.as_ref() {
                    Expression::Identifier(obj) => {
                        self.handle_method_call(&obj.sym, &member.property, &call.args);
                    }
                    Expression::Member(_) => {
                        self.handle_chain_call(&member, &call.args);
                    }
                    Expression::Call(_) => {
                        self.handle_chained_call(member, &call.args);
                    }
                    _ => {}
                }
            }
            _ => {}
        },
        Callee::Super => {}
    }
}
```

**Savings: 60% reduction** (1,435 → ~600 LOC)

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Months 1-2)
1. Migrate node type definitions → Rust enums + Serde
2. Set up Swc integration for JavaScript/TypeScript parsing
3. Create WASM boundary with TypeScript type bindings
4. Implement basic node factory

### Phase 2: Core Logic (Months 2-3)
1. Migrate AST visitors → Rust with Swc
2. Migrate graph builders
3. Implement enricher trait system

### Phase 3: Integration (Months 3-4)
1. WASM FFI layer
2. Plugin orchestration protocol
3. Backward compatibility layer for TypeScript plugins

### Phase 4: Migration (Months 4-6)
1. Migrate enrichers one by one
2. Performance benchmarking
3. TypeScript plugin layer testing

---

## 8. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Swc compatibility gaps | Medium | Test against current test suite; fallback to Babel if needed |
| WASM boundary overhead | Medium | Batch graph operations; minimize serialization |
| Plugin breakage | High | Keep plugin interface stable; deprecate carefully |
| Development velocity | High | Rust learning curve; use existing patterns from rfdb-server |
