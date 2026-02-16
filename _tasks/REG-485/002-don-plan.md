## Don Melton — Plan: REG-485

### Problem Analysis

**What's broken:** MethodCallResolver fails to resolve cross-class method calls when the object's type must be traced through variable assignment chains and interface/abstract implementations.

**Concrete example:** The command `impact addNodes` returns 0 callers despite 21+ call sites like:
```typescript
const { graph } = context;  // graph is GraphBackend (interface)
await graph.addNode(...)    // addNode is defined in RFDBServerBackend (concrete class)
```

**Why it fails:**
1. MethodCallResolver looks up `graph` in its variable type index (built from INSTANCE_OF edges)
2. No INSTANCE_OF edge exists for `graph` because it's typed as an interface, not a concrete class
3. Current resolution strategy only handles:
   - Direct class name matches (`RFDBServerBackend.addNode`)
   - `this.method()` within a class
   - Variables with INSTANCE_OF edges pointing to concrete classes
   - DERIVES_FROM inheritance chains (REG-400)

**Missing:** Resolution through:
- Interface type → concrete implementations via IMPLEMENTS edges
- Variable assignment chains (`const graph = context.graph`)
- Type inference from context (e.g., PluginContext has a `graph` property typed as GraphBackend)

### Current Architecture

**MethodCallResolver flow:**
1. Collects all CALL nodes with `object` attribute (METHOD_CALL nodes)
2. Builds two indexes:
   - `classMethodIndex`: Map of class name → class entry with methods
   - `variableTypes`: Map of variable ID → class name (from INSTANCE_OF edges)
3. For each method call, tries resolution strategies in order:
   - Direct class name match
   - Local class in same file
   - "this" reference
   - Variable type index lookup

**Available edges:**
- `CONTAINS`: CLASS → METHOD (connects classes to their methods)
- `INSTANCE_OF`: VARIABLE → CLASS (type assignment)
- `DERIVES_FROM`: CLASS → CLASS (inheritance, REG-400)
- `EXTENDS`: CLASS → CLASS (inheritance)
- `IMPLEMENTS`: CLASS → INTERFACE (interface implementation) — **Currently NOT used by MethodCallResolver**

**Current gap:** The `variableTypes` index only includes variables with INSTANCE_OF edges. It doesn't:
1. Walk through IMPLEMENTS edges to find concrete implementations
2. Trace assignment chains (`const graph = context.graph`)
3. Infer types from property access (reading a typed property from an interface)

### Proposed Solution

**Minimal change:** Extend the variable type index building to include interface → implementation mapping, then use it during resolution.

**Two-phase approach:**

**Phase 1 (Required for REG-485):** Add interface → implementation resolution
- When a variable's type is an interface (detected via IMPLEMENTS edge), find all concrete classes implementing it
- During method call resolution, if object matches a known interface, search implementing classes for the method

**Phase 2 (Future enhancement):** Add assignment chain tracing
- Track ASSIGNED_FROM edges to trace `const x = y` chains
- Build transitive closure of variable → type mappings
- This handles the `context.graph` → `graph` pattern

**For REG-485, Phase 1 is sufficient** because most real-world code uses the interface directly from the context (`context.graph.addNode(...)`), not via intermediate variables.

### Algorithm

**Extend buildVariableTypeIndex() in MethodCallIndexers.ts:**

```typescript
// Current: only indexes INSTANCE_OF edges
// New: also index IMPLEMENTS edges for interface resolution

async function buildVariableTypeIndex(
  graph: PluginContext['graph'],
  logger: Logger
): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  // Existing: CLASS <- INSTANCE_OF - VARIABLE
  for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
    const incomingEdges = await graph.getIncomingEdges(classNode.id, ['INSTANCE_OF']);
    for (const edge of incomingEdges) {
      index.set(edge.src.toString(), classNode.name as string);
    }
  }

  // NEW: Build interface → implementations map
  const interfaceImpls = new Map<string, string[]>();
  for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
    const implementsEdges = await graph.getOutgoingEdges(classNode.id, ['IMPLEMENTS']);
    for (const edge of implementsEdges) {
      const interfaceNode = await graph.getNode(edge.dst);
      if (interfaceNode?.name) {
        const impls = interfaceImpls.get(interfaceNode.name as string) || [];
        impls.push(classNode.name as string);
        interfaceImpls.set(interfaceNode.name as string, impls);
      }
    }
  }

  return { variableTypes: index, interfaceImpls };
}
```

**Complexity:** O(n) where n = number of CLASS nodes (reuses existing iteration space, no new scans).

**Modify resolveMethodCall() in MethodCallResolution.ts:**

```typescript
// Step 4 (variable type index) becomes:
// 4a. Check direct variable type
// 4b. If no match, check if object is an interface name
// 4c. Search all implementing classes for the method

// Existing step 4
for (const [, className] of variableTypes.entries()) {
  // ... existing code ...
}

// NEW: Step 4b - Interface resolution
if (!targetMethod && interfaceImpls.has(object)) {
  const implementations = interfaceImpls.get(object)!;
  for (const implClassName of implementations) {
    if (classMethodIndex.has(implClassName)) {
      const classEntry = classMethodIndex.get(implClassName)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
    }
  }
}
```

**Complexity:** O(m) where m = number of implementations for the interface. Typically m is small (1-5).

**Edge case handling:**
- Multiple implementations: Return first match (deterministic order by class name)
- Interface extends interface: Walk EXTENDS edges on interfaces (similar to DERIVES_FROM for classes)
- Interface not implemented: Return null (unresolved, counted in stats)

### Files to Modify

1. **packages/core/src/plugins/enrichment/method-call/MethodCallIndexers.ts** (~84 lines)
   - Modify `buildVariableTypeIndex()` to return `{ variableTypes, interfaceImpls }`
   - Add interface → implementations mapping (30-40 new lines)
   - **Estimated change:** +40 lines

2. **packages/core/src/plugins/enrichment/method-call/MethodCallData.ts** (~130 lines)
   - Add `InterfaceImplsMap` type export
   - **Estimated change:** +5 lines

3. **packages/core/src/plugins/enrichment/method-call/MethodCallResolution.ts** (~182 lines)
   - Modify `resolveMethodCall()` signature to accept interfaceImpls map
   - Add step 4b for interface resolution (20-25 lines)
   - **Estimated change:** +25 lines

4. **packages/core/src/plugins/enrichment/MethodCallResolver.ts** (~263 lines)
   - Update call to `buildVariableTypeIndex()` to destructure result
   - Pass interfaceImpls to `resolveMethodCall()`
   - **Estimated change:** +5 lines

5. **test/unit/MethodCallResolver.test.js** (~493 lines)
   - Add test case for interface → implementation resolution
   - Test scenario: INTERFACE with IMPLEMENTS edge from CLASS containing METHOD
   - **Estimated change:** +80 lines (new test case)

**Total LOC change estimate:** ~155 lines

### Risks

**Medium risk:**
1. **IMPLEMENTS edges may not exist in current graph** — Need to verify that JSASTAnalyzer actually creates these edges. If not, this becomes a two-task fix (first add IMPLEMENTS edge creation, then add resolution).
2. **Interface node type unknown** — Current code assumes CLASS nodes. Need to check if TypeScript interfaces are represented as separate INTERFACE nodes or as CLASS nodes with metadata.
3. **Multiple implementations ambiguity** — If GraphBackend has 5 implementations and they all have `addNode`, which one do we return? (Current plan: first match, but this may need refinement based on call context).

**Low risk:**
4. **Performance** — Adding one more iteration over CLASS nodes is O(n) and happens once at startup, acceptable.
5. **Test coverage** — Existing test infrastructure supports this change (MethodCallResolver.test.js has clear patterns).

**Mitigation:**
- Step 0: Verify IMPLEMENTS edges exist in graph (search for IMPLEMENTS edge creation in JSASTAnalyzer)
- If IMPLEMENTS doesn't exist, split into two tasks:
  - REG-485a: Add IMPLEMENTS edge creation in TypeSystemBuilder
  - REG-485b: Add interface resolution in MethodCallResolver

### Grafema Dogfooding

**Graph queries attempted:** 0 (RFDB server not available)

**Fallbacks to file read:** 5
- Read MethodCallResolver.ts to understand current implementation
- Read MethodCallResolution.ts to understand resolution strategy
- Read MethodCallIndexers.ts to understand index building
- Read test file to understand test patterns
- Read types to understand edge types and node types

**Product gaps found:** None (task was code exploration, not graph querying)

**Verdict:** N/A (server not running)

**Prior art research:**

Used WebSearch to find existing approaches to cross-class method resolution. Key findings:

1. **Hybrid overloading** (POPL 2026): Uses approximate type information from local static analysis before full type checking — similar to our indexing approach.

2. **Call graph analysis for dynamic languages**: Existing tools (PHP, Python) skip method calls when variable type cannot be inferred statically. Grafema should do better by:
   - Building interface → implementation maps
   - Tracking assignment chains
   - Providing strict mode errors with suggestions when resolution fails

3. **Common pattern**: Type inference is essential for accurate cross-class resolution, and most tools struggle with interface/implementation boundaries in dynamically-typed code.

**Our approach is grounded in real prior art** and matches modern static analysis research (approximation + local analysis before global type inference).

**Sources:**
- [Decoupling Resolution from Type Inference (WITS 2026) - POPL 2026](https://popl26.sigplan.org/details/wits-2026-papers/6/Decoupling-Resolution-from-Type-Inference)
- [Static Analysis of Implicit Control Flow](https://dada.cs.washington.edu/research/tr/2015/05/UW-CSE-15-05-01.pdf)
- [Type Inference for C: Applications to the Static Analysis of Incomplete Programs](https://dl.acm.org/doi/fullHtml/10.1145/3421472)
