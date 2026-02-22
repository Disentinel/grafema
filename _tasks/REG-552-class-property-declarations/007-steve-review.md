## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK with one noted asymmetry

---

### Summary

REG-552 adds indexing of non-function class property declarations (data fields) as VARIABLE nodes with `HAS_PROPERTY` edges. This is exactly the kind of structural data that makes the graph a better tool than reading code.

### Vision Alignment

The core thesis — "AI should query the graph, not read code" — demands that the graph capture class structure completely. Before this change, an AI agent querying the graph for a class like `GraphBuilder` would see its methods but be blind to its data fields. It could not answer "what does this class hold?", "what are its dependencies by type?", or "which fields are mutable vs readonly?" without falling back to reading the file.

This change closes that gap. After REG-552:

- `modifier` is queryable — find all `private` fields, find all `readonly` fields across a codebase
- `declaredType` is queryable — find all fields of type `Database`, find all classes that hold a reference to `GraphBackend`
- `HAS_PROPERTY` edges connect CLASS → VARIABLE — structural queries work: "what data does class X own?"
- `isStatic` is captured — static vs instance fields are distinguishable

This directly serves the target environment: massive legacy JS/TS codebases where understanding class structure requires either reading every file or having a graph that answers these questions. The graph now answers them.

The feature also handles untyped properties correctly. A field like `count = 0` (no TypeScript annotation, no modifier) still creates a VARIABLE node with `modifier: 'public'` and no `declaredType`. The graph is populated with what is actually there, not silently dropped because type information is absent. That is the right behavior for a tool aimed at loosely-typed codebases.

### Architecture

The implementation follows existing patterns precisely:

- `computeSemanticIdV2('VARIABLE', ...)` — same ID strategy used throughout
- `isClassProperty: true` flag — consistent with function-valued properties
- `parentScopeId: currentClass.id` — same mechanism used in `ClassPrivateProperty` handler
- `currentClass.properties.push(fieldId)` — same mechanism used in `ClassPrivateProperty` handler for HAS_PROPERTY edge generation
- `typeNodeToString` from `TypeScriptVisitor` — reuses existing infrastructure, no new wheel

The `ClassPrivateProperty` handler (lines 512-618) already had this pattern for private fields. REG-552 extends the same logic to the `ClassProperty` handler (public/protected/private fields with TypeScript accessibility modifiers). The symmetry is correct.

### The `declaredType` Field Name

The naming workaround — `declaredType` instead of `type` to avoid collision with `_parseNode`'s deserialization — is not ideal, but it is the right call given the constraint. The implementation report documents the RFDB pipeline behavior clearly. This is a known limitation of how RFDB flattens metadata, not a bug introduced here. The field name `declaredType` is semantically accurate and unambiguous. An AI agent querying for `declaredType` will not be confused.

### One Asymmetry: ClassExpression Missing Decorator Handling

The implementation report notes that the `ClassExpression > ClassProperty` handler has no decorator handling — this is a pre-existing asymmetry documented as out of scope. This is the correct decision. Patching decorator support into `ClassExpression` in the same PR would be scope creep and risk. It should be tracked as a separate issue.

### Test Coverage

Seven tests cover the meaningful surface:
- All three access modifiers (private / public / protected)
- TypeScript type annotation extraction
- HAS_PROPERTY edge existence
- Source position correctness
- readonly modifier
- Field with initializer (non-typed JS-style property)
- Regression: function-valued properties still produce FUNCTION nodes

Test 6 (field with initializer, `count = 0`) is the one that validates the untyped-codebase scenario. It passes. Coverage is sufficient for this change.

### What Would Embarrass Us

Nothing in this implementation would embarrass. The feature does what it says, the graph is richer, and the data is correct and queryable.
