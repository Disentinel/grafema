# Formal Analysis of Grafema Graph Warnings

**Authors:** Robert Tarjan (Graph Theory) + Patrick Cousot (Static Analysis)
**Date:** 2025-01-25

## Executive Summary

Three fundamental issues detected in Grafema's program dependence graph:

1. **Disconnected Nodes (172 nodes)** - Graph connectivity violation
2. **Missing ASSIGNED_FROM edges (45 variables)** - Dataflow lattice incompleteness
3. **Unresolved Calls (987 call sites)** - Open-world call graph approximation

All three issues stem from **incomplete graph construction**, not algorithmic bugs. The graph builder creates nodes but fails to link them to the reachability tree rooted at SERVICE/MODULE nodes.

---

## 1. Disconnected Nodes - Graph Connectivity Analysis

### Formal Problem Statement (Tarjan)

**Definition:** A **program dependence graph** G = (V, E) is a directed graph where:
- V = set of nodes representing program entities (functions, variables, literals, etc.)
- E = set of edges representing relationships (CONTAINS, CALLS, ASSIGNED_FROM, etc.)

**Root nodes:** R ⊆ V where type(v) ∈ {SERVICE, MODULE, PROJECT}

**Connectivity Invariant:**
∀v ∈ V, ∃r ∈ R such that v is reachable from r via undirected paths in G.

**Violation detected:** 172 nodes v ∈ V where ¬∃r ∈ R : reachable(r, v)

This is a **weakly connected component** problem. The graph contains:
- One large connected component (9502 nodes) containing all root nodes
- 172 isolated nodes (no edges) or small disconnected components

### Impact on Analysis Correctness

**False Negatives:**
Disconnected nodes are **invisible** to graph queries starting from root nodes. Any analysis using BFS/DFS from SERVICE/MODULE will miss these 172 nodes.

Example: If a LITERAL node is disconnected, value flow analysis cannot trace variable origins.

**Root Cause:**
Node creation without corresponding **containment edges**. The graph builder creates nodes in `bufferLiterals()`, `bufferObjectLiteralNodes()`, `bufferArrayLiteralNodes()` but fails to link them to parent CALL nodes.

From GraphBuilder.ts:
```typescript
private bufferLiterals(literals: LiteralInfo[]): void {
  for (const literal of literals) {
    const { parentCallId, argIndex, ...literalData } = literal;
    this._bufferNode(literalData as GraphNode);
    // BUG: No edge creation! Should create:
    // parentCallId -> PASSES_ARGUMENT -> literal.id
  }
}
```

**Standard Solution:**

In dependence graph construction (Ferrante et al., 1987), **every non-root node must have at least one incoming edge** from its syntactic container. For argument literals:

```
CALL_SITE --[PASSES_ARGUMENT]--> LITERAL
```

This ensures the graph forms a **spanning tree** rooted at MODULE nodes.

### Tradeoff: Precision vs Soundness

**Soundness:** A sound analysis must account for ALL program entities. Disconnected nodes break soundness.

**Fix:** Add containment edges during node creation (zero precision cost, fixes soundness).

---

## 2. Missing ASSIGNED_FROM Edges - Dataflow Lattice Analysis

### Formal Problem Statement (Cousot)

**Dataflow Analysis Framework:**

Let L be the lattice of abstract values for variable assignments:
- ⊤ = uninitialized
- ⊥ = unreachable
- {LITERAL, METHOD_CALL, CALL_SITE, FUNCTION, CLASS, ...} = concrete value sources

**Transfer function** for assignment `x = e`:

τ(σ) = σ[x ↦ [[e]]σ]

where [[e]]σ evaluates expression e in state σ.

**Violation:** 45 variables where σ(x) = ⊤ (no ASSIGNED_FROM edge exists).

Examples:
```javascript
const date = new Date();         // NewExpression - no edge
const [a, b] = destructure();    // Destructuring - no edge
const db = new Database(config); // Constructor call - no edge
```

### Impact on Analysis Correctness

**False Positives:**
Queries like "where does variable X get its value?" return EMPTY when they should return `new Date()` or constructor call.

**False Negatives:**
Value set analysis (VDomainAnalyzer) cannot propagate concrete values through the chain:

```
VARIABLE --[ASSIGNED_FROM]--> ??? (missing)
```

This breaks **must-alias analysis** and **constant propagation**.

### Root Cause Analysis

GraphBuilder.ts `bufferAssignmentEdges()` handles:
- ✓ LITERAL assignment: `const x = 42`
- ✓ VARIABLE assignment: `const x = y`
- ✓ CALL_SITE assignment: `const x = foo()`
- ✓ METHOD_CALL assignment: `const x = obj.method()`
- ✗ **NewExpression**: `const x = new Date()` ← MISSING
- ✗ **Destructuring**: `const [a, b] = arr` ← MISSING
- ✗ **Constructor with params**: `const db = new DB(cfg)` ← MISSING

The JSASTAnalyzer collects this data in `variableAssignments[]` but marks sourceType differently:

```typescript
// JSASTAnalyzer.ts - NewExpression handling
if (init.type === 'NewExpression') {
  // Stores className but NOT as sourceType='CLASS'
  // GraphBuilder skips these assignments entirely
}
```

### Standard Solution from Literature

**Abstract Interpretation (Cousot & Cousot, 1977):**

For constructor calls, the abstract value should be:

[[new C(args)]]σ = {fresh object of type C}

In a dependence graph, this maps to:

```
VARIABLE --[ASSIGNED_FROM]--> EXPRESSION(NewExpression)
EXPRESSION --[DERIVES_FROM]--> CLASS(C)
EXPRESSION --[PASSES_ARGUMENT]--> arg₁, arg₂, ...
```

**Current implementation** creates INSTANCE_OF edge but no ASSIGNED_FROM:

```typescript
// GraphBuilder.ts line 472-476
this._bufferEdge({
  type: 'INSTANCE_OF',
  src: variableId,
  dst: classId
});
// Missing: ASSIGNED_FROM edge!
```

### Tradeoff: Precision vs Soundness

**Soundness trade-off:**
Without ASSIGNED_FROM, the dataflow analysis is **unsound** - it claims "no definition found" when one exists.

**Precision trade-off:**
Adding edges for `new Date()` vs built-in constructors:

| Approach | Soundness | Precision |
|----------|-----------|-----------|
| Skip built-ins | Unsound | High (no noise) |
| Create placeholder nodes | Sound | Low (many external nodes) |
| Implicit edge to constructor | Sound | High (tracks user constructors) |

**Recommended:** Hybrid approach:
- User-defined classes: explicit edges to CLASS node
- Built-in constructors: implicit edge to synthetic BUILTIN_CONSTRUCTOR node

---

## 3. Unresolved Calls - Open-World Call Graph

### Formal Problem Statement (Both Perspectives)

**Call Graph Construction:**

Let CG = (N, E) where:
- N = {all functions in program} ∪ {external functions}
- E ⊆ CALL_SITE × FUNCTION (call edges)

**Closed-world assumption (CWA):** All callees are known statically.
**Open-world assumption (OWA):** Callees may be external or dynamically resolved.

**Grafema's current model:** Hybrid
- Internal calls: CWA (expect CALLS edge)
- External calls: OWA (no placeholder nodes)

**Violation:** 987 call sites with no CALLS edge:
- Promise callbacks: `resolve`, `reject` (runtime-provided)
- Built-in functions: `parseInt`, `Error`, `Date` (language runtime)
- React hooks: `useState`, `useEffect` (framework-provided)
- External libraries: anything imported from npm

### Impact on Analysis Correctness

**Tarjan's perspective (Graph Algorithms):**

Call graph incompleteness breaks **strongly connected component (SCC)** analysis:

```
function foo() { bar(); }
function bar() { foo(); }  // Mutual recursion
```

If `bar()` call is unresolved, we miss the cycle → incorrect topological sort.

**Cousot's perspective (Dataflow):**

Missing call edges break **interprocedural analysis**:

```javascript
const x = parseInt(input);  // What is x's type?
```

Without edge to `parseInt` definition, we cannot infer:
- Return type: number | NaN
- Side effects: none
- Exceptions: none

### Standard Solutions from Literature

**1. Placeholder Stubs (Sound, Low Precision)**

Create synthetic EXTERNAL_FUNCTION nodes for all unknown callees:

```
CALL_SITE --[CALLS]--> EXTERNAL_FUNCTION(parseInt)
```

Pros: Sound call graph (all edges exist)
Cons: Pollutes graph with thousands of external nodes

**2. Conservative Approximation (Sound, Medium Precision)**

Use type signatures for built-ins:

```
parseInt: (string, radix?) -> number | NaN
```

Store signature in CALL_SITE metadata instead of creating full nodes.

Pros: Compact representation
Cons: Requires signature database

**3. On-Demand Resolution (Unsound, High Precision)**

Resolve calls lazily during query execution:

```datalog
calls(CallSite, Target) :-
  node(CallSite, "CALL"),
  attr(CallSite, "name", Name),
  (edge(CallSite, Target, "CALLS") ; external_function(Name, Target)).
```

Pros: No extra nodes in graph
Cons: Non-monotonic (results change as external DB grows)

**4. Grafema's Current Approach (Unsound, High Precision)**

Only track internal calls, ignore external.

Pros: Clean graph, no noise
Cons: Queries like "who calls X?" miss external callers

### Recommended Solution: Hybrid Strategy

```typescript
enum CallResolution {
  INTERNAL,      // Edge to FUNCTION node (user code)
  EXTERNAL_LIB,  // Edge to EXTERNAL_MODULE node (npm package)
  BUILTIN,       // No edge, metadata only (parseInt, Promise)
  UNRESOLVED     // Warning, needs manual review
}
```

Decision tree:

1. If callee name matches FUNCTION in same module → INTERNAL
2. If callee matches import from external package → EXTERNAL_LIB
3. If callee matches known built-in (from stdlib catalog) → BUILTIN
4. Otherwise → UNRESOLVED (validator warning)

Example:

```javascript
parseInt(x)       → BUILTIN (no edge)
fetch(url)        → BUILTIN (Web API)
lodash.map()      → EXTERNAL_LIB (edge to node-modules/lodash)
myFunction()      → INTERNAL (edge to FUNCTION node)
dynamicCall[x]()  → UNRESOLVED (warning: computed call)
```

This balances **soundness** (track what matters) vs **precision** (don't pollute graph).

### Tradeoff Analysis

| Solution | Soundness | Precision | Graph Size | Query Speed |
|----------|-----------|-----------|------------|-------------|
| All placeholder nodes | ✓ Sound | Low | +5000 nodes | Slow (more edges) |
| Type signatures only | ✓ Sound | Medium | +0 nodes | Fast |
| On-demand resolution | ✗ Unsound | High | +0 nodes | Medium (DB lookup) |
| Ignore external calls | ✗ Unsound | High | +0 nodes | Fast |
| **Hybrid (recommended)** | **Mostly sound** | **High** | **+50 nodes** | **Fast** |

---

## Comparison with Existing Static Analyzers

### How do others handle these issues?

**1. TypeScript Compiler (tsc)**

- **Disconnected nodes:** N/A - AST is always a tree (by construction)
- **Missing assignments:** All variables MUST have initializers or type annotations
- **Unresolved calls:** Type error if callee not found in scope or `.d.ts` files

TypeScript uses **closed-world assumption** - everything must be declared.

**2. Flow (Facebook)**

- **Disconnected nodes:** N/A - AST-based, not graph
- **Missing assignments:** Infers `any` for uninitialized variables (unsound)
- **Unresolved calls:** Allows dynamic calls, tracks as `Function` type (imprecise)

Flow is **unsound by design** (performance over correctness).

**3. ESLint (no-undef rule)**

- **Disconnected nodes:** N/A - only checks scope, not graph
- **Missing assignments:** Flags uninitialized variables
- **Unresolved calls:** Flags calls to undefined functions

ESLint uses **syntactic checks only** - no dataflow analysis.

**4. SonarQube (JavaScript analyzer)**

- **Disconnected nodes:** Tracks "dead code" via CFG reachability
- **Missing assignments:** Flags "variable used before assignment"
- **Unresolved calls:** Assumes external calls are valid (unsound)

SonarQube is **pragmatic** - warns but doesn't error on external calls.

**5. CodeQL (Semmle)**

- **Disconnected nodes:** Full program database - all entities linked
- **Missing assignments:** Explicit `Expr` → `Variable` edges
- **Unresolved calls:** Creates placeholder `UnknownFunction` nodes

**CodeQL is closest to what Grafema should be.**

---

## Recommendations for Grafema

### Priority 1: Fix Disconnected Nodes (Soundness Bug)

**Impact:** High - breaks all graph queries
**Effort:** Low - add edges during node creation
**Issue:** Create Linear ticket

**Fix locations:**
1. `bufferLiterals()` - add PASSES_ARGUMENT edges to parent call
2. `bufferObjectLiteralNodes()` - add PASSES_ARGUMENT edges
3. `bufferArrayLiteralNodes()` - add PASSES_ARGUMENT edges

Validation: After fix, `GraphConnectivityValidator` should report 0 disconnected nodes.

### Priority 2: Add ASSIGNED_FROM for NewExpression (Correctness)

**Impact:** Medium - breaks value flow analysis
**Effort:** Medium - handle 3 new assignment types
**Issue:** Create Linear ticket

**Fix locations:**
1. `JSASTAnalyzer` - emit `variableAssignments` for NewExpression
2. `GraphBuilder.bufferAssignmentEdges()` - create edges for NewExpression
3. Handle destructuring assignments separately (complex)

Validation: `DataFlowValidator` should report 0 missing assignments for `new Date()` patterns.

### Priority 3: Define External Call Policy (Design Decision)

**Impact:** Low - mainly affects query precision
**Effort:** High - requires design discussion
**Issue:** Create Linear ticket for design discussion

**Questions to answer:**
1. Should we create placeholder nodes for built-in functions? (parseInt, Promise, etc.)
2. Should we track external library calls? (lodash, react, etc.)
3. What's the UX for "unresolved call" warnings?

**Recommendation:** Start with **hybrid approach** (track only what's actionable):
- Internal calls: require CALLS edge (error if missing)
- External imports: create EXTERNAL_MODULE nodes (one per package)
- Built-ins: metadata only (no nodes)
- Unresolved: warning (manual review)

This gives users actionable results without graph pollution.

---

## Theoretical Foundations

### Graph Theory (Tarjan)

**Key insight:** A program dependence graph must be **weakly connected** to support reachability queries. Disconnected components are dead code or construction bugs.

**Algorithm:** Use **BFS from root nodes** to find reachable set. Unreachable nodes indicate missing edges.

**Complexity:** O(V + E) for connectivity check - very cheap.

### Abstract Interpretation (Cousot)

**Key insight:** Dataflow analysis requires **complete lattice** with monotonic transfer functions. Missing edges create ⊤ (unknown) values that poison downstream analysis.

**Fix:** Ensure every variable has at least one ASSIGNED_FROM edge (even if to synthetic UNINITIALIZED node).

**Soundness guarantee:**
```
∀v ∈ Variables, ∃e ∈ Edges : e.type = ASSIGNED_FROM ∧ e.src = v.id
```

### Call Graph Construction (Both)

**Key insight:** No static analysis can achieve 100% precision for dynamic calls. Must choose between:
- **Soundness:** Overapproximate (include all possible callees)
- **Precision:** Underapproximate (only track provable calls)

**Grafema's target users:** Large legacy codebases without type systems.

**Implication:** Soundness matters less than precision (false positives kill UX). Better to warn "unresolved" than pollute graph with noise.

---

## Conclusion

All three warnings point to **incomplete graph construction**, not design flaws.

**Root cause:** GraphBuilder creates nodes but forgets to link them to the program's hierarchical structure.

**Impact:**
- Disconnected nodes: **Soundness violation** (queries miss entities)
- Missing ASSIGNED_FROM: **Correctness issue** (dataflow broken)
- Unresolved calls: **Precision trade-off** (by design, but needs policy)

**Fix priority:**
1. Disconnected nodes - **must fix** (breaks core functionality)
2. Missing assignments - **should fix** (breaks value flow)
3. Unresolved calls - **design discussion** (trade-off, not bug)

**Estimated effort:**
- Priority 1: 2-4 hours (add missing edges)
- Priority 2: 4-8 hours (handle NewExpression + destructuring)
- Priority 3: Design discussion + 8-16 hours (hybrid call resolution)

**Next steps:**
1. Create Linear issues for all three priorities
2. Fix Priority 1 immediately (low-hanging fruit)
3. Discuss Priority 3 policy with product team
4. Implement Priority 2 after policy is clear

---

**References:**

- Tarjan, R. (1972). "Depth-First Search and Linear Graph Algorithms"
- Ferrante, J. et al. (1987). "The Program Dependence Graph and Its Use in Optimization"
- Cousot, P. & Cousot, R. (1977). "Abstract Interpretation: A Unified Lattice Model"
- Grove, D. & Chambers, C. (2001). "A framework for call graph construction algorithms" (TOPLAS)
- Sridharan, M. et al. (2013). "F4F: taint analysis of framework-based web applications" (OOPSLA)
