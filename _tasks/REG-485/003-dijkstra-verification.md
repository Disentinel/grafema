## Dijkstra Plan Verification: REG-485

**Verdict:** REJECT

**Reviewed:** Don's plan to add interface → implementation resolution to MethodCallResolver

### Critical Gap: Incomplete Input Universe

Don's plan proposes adding interface resolution as a fallback step in `resolveMethodCall()`. The plan says:

> "Step 4b - Interface resolution: if object matches an interface name in interfaceImpls, search implementing classes for the method"

**This assumes `object` will contain the interface name.** But that's NOT what happens in the real-world failure case.

### Input Category Enumeration

For the `object` field in a METHOD_CALL node (e.g., `object.method()`), I enumerate ALL possible input categories:

| Input category | Example | Expected behavior | Handled by plan? |
|---------------|---------|-------------------|-----------------|
| **Concrete class name** | `RFDBServerBackend.addNode()` | Resolve via classMethodIndex direct lookup | ✅ YES (step 1) |
| **Local class in same file** | `MyClass.method()` | Resolve via file:className key | ✅ YES (step 2) |
| **Interface name directly** | `GraphBackend.addNode()` | Search all implementing classes | ✅ YES (step 4b, proposed) |
| **`this`** | `this.method()` | Resolve via containing class | ✅ YES (step 3) |
| **Variable with INSTANCE_OF** | `const db = new DB(); db.query()` | Resolve via variableTypes index | ✅ YES (step 4) |
| **Variable typed as interface** | `const graph: GraphBackend = ...` | **NOT HANDLED** | ❌ NO |
| **Property access** | `context.graph.addNode()` | **NOT HANDLED** | ❌ NO |
| **Destructured variable** | `const { graph } = context` | **NOT HANDLED** | ❌ NO |
| **Function return value** | `getClient().send()` | **NOT HANDLED** | ❌ NO |
| **Array element** | `arr[0].method()` | **NOT HANDLED** | ❌ NO |
| **Ternary/conditional** | `(x ? a : b).method()` | **NOT HANDLED** | ❌ NO |

### The Real-World Failure Case (from task description)

```typescript
const { graph } = context;  // graph is GraphBackend (interface)
await graph.addNode(...)    // object = "graph", NOT "GraphBackend"
```

**What `object` contains:** The string `"graph"` (variable name).

**What Don's plan checks:** `interfaceImpls.has(object)` → checks if `"graph"` is a known interface name.

**Result:** No match, because `"graph"` is a variable name, not the interface name `"GraphBackend"`.

### Why the Plan Fails

Don's step 4b proposes:

```typescript
if (!targetMethod && interfaceImpls.has(object)) {
  const implementations = interfaceImpls.get(object)!;
  // ...
}
```

This only works if `object === "GraphBackend"` (the interface name itself). But in the real-world case:
- `object = "graph"` (variable name)
- The interface name is `"GraphBackend"` (type of the variable)
- No connection between variable name and its type in the proposed algorithm

### What's Missing: Type Resolution for Variables

The plan ONLY adds interface → implementation mapping. It does NOT add:

1. **Variable → type mapping for interface-typed variables**
   - Current `variableTypes` index only includes variables with INSTANCE_OF edges
   - Interface-typed variables need a different mechanism (type annotations, property types from parent interfaces)

2. **Property type inference**
   - `context.graph` → what is the type of the `graph` property on `context`?
   - Requires reading type definitions or interface declarations for `PluginContext`
   - NOT addressed in the plan

3. **Assignment chain tracing**
   - `const { graph } = context` → destructuring
   - `const x = y` → simple assignment
   - Don mentions this as "Phase 2 (Future enhancement)" but it's NOT future — it's REQUIRED for REG-485

### The Actual Root Cause

The failure is NOT "we don't have interface → implementation mapping."

The failure is: **"We don't know that variable `graph` has type `GraphBackend`"**

Once we know `graph: GraphBackend`, THEN we need interface → implementation resolution.

### What WOULD Work

**Required components (both needed, not either/or):**

1. **Type inference for variables:**
   - Parse type annotations: `const graph: GraphBackend = ...`
   - Infer from property access: `context.graph` → read type of `graph` property from `PluginContext` interface
   - Trace assignment chains: `const { graph } = context` → follow destructuring

2. **Interface resolution (Don's plan):**
   - Once we know variable type is `GraphBackend`, look up implementing classes
   - Find `RFDBServerBackend implements GraphBackend`
   - Search for method in implementing class

**Don's plan only includes #2, but #1 is the blocker.**

### Precondition Issues

**Assumed but not verified:**

1. **IMPLEMENTS edges exist** — Don mentions this as "Medium risk" but doesn't verify. Must check TypeSystemBuilder to confirm IMPLEMENTS edges are created.

2. **Interface nodes exist** — The plan assumes INTERFACE nodes exist in the graph. Must verify JSASTAnalyzer creates them.

3. **Type annotations are extracted** — The plan assumes type information is available somewhere in the graph. Where? How do we know `const graph: GraphBackend` → type is GraphBackend?

4. **Property types are tracked** — For `context.graph`, we need to know the type of the `graph` property. Is this in the graph? If not, where?

### Completeness Check for Don's Algorithm

Don proposes:

```typescript
// NEW: Build interface → implementations map
const interfaceImpls = new Map<string, string[]>();
for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
  const implementsEdges = await graph.getOutgoingEdges(classNode.id, ['IMPLEMENTS']);
  for (const edge of implementsEdges) {
    const interfaceNode = await graph.getNode(edge.dst);
    if (interfaceNode?.name) {
      interfaceImpls.set(interfaceNode.name as string, [classNode.name]);
    }
  }
}
```

**Edge cases:**

| Case | Handled? |
|------|----------|
| Multiple classes implement same interface | ❌ NO — code only stores LAST class, overwrites previous (missing array append logic) |
| Interface extends interface | ❌ NO — doesn't walk EXTENDS chain |
| Interface not implemented by any class | ✅ YES — returns null (unresolved) |
| Interface implemented by abstract class | ❓ UNCLEAR — abstract classes may also have IMPLEMENTS edges |

**The algorithm has a critical bug:** It should be `interfaceImpls.set(..., [...(interfaceImpls.get(...) || []), className])` to accumulate, not overwrite.

### Recommended Action

**REJECT the plan.** Don must address:

1. **Missing input category:** Variable typed as interface (not interface name directly)
2. **Missing precursor:** Type inference for variables BEFORE interface resolution
3. **Algorithm bug:** Interface implementations map overwrites instead of accumulates
4. **Unverified preconditions:** Check IMPLEMENTS edges exist, check type information is available in graph

**Revised scope should include:**

- Add type annotation extraction (if not already present)
- Build variable → declared type mapping (from type annotations)
- THEN add interface → implementation resolution as planned
- OR defer this to Phase 2 and focus on narrower cases (direct interface name usage only)

### Gaps Found

**GAP 1: Object type is variable name, not type name**
- Attempted: Resolve `graph.addNode()` by checking if "graph" is an interface
- Why it fails: "graph" is a variable name, need to look up its type first
- Suggested fix: Add type annotation extraction + variable → type mapping before interface resolution

**GAP 2: Accumulation bug in interface implementations map**
- Attempted: Store multiple implementations per interface
- Why it fails: Code overwrites instead of accumulating (missing array append)
- Suggested fix: Change to `interfaceImpls.set(name, [...(interfaceImpls.get(name) || []), className])`

**GAP 3: Unverified preconditions**
- Attempted: Assume IMPLEMENTS edges and type information exist
- Why it fails: No verification that TypeSystemBuilder creates these edges or that type annotations are extracted
- Suggested fix: Verify with graph queries or code inspection BEFORE implementation

### Enumeration Proof

For `resolveMethodCall(methodCall, ...)` where `methodCall.object = "graph"`:

1. Step 1 (direct class name): `classMethodIndex.has("graph")` → NO (graph is not a class name)
2. Step 2 (local class): `classMethodIndex.has("file.ts:graph")` → NO (graph is not a class)
3. Step 3 (this check): `object === "this"` → NO ("graph" !== "this")
4. Step 4 (variable types): `variableTypes.get(methodCall.id)` → NO (no INSTANCE_OF edge for graph)
5. **Step 4b (proposed):** `interfaceImpls.has("graph")` → NO ("graph" is not an interface name)

**Conclusion:** ALL steps return null. The call remains unresolved even with Don's changes.

**The plan does not fix REG-485.**
