# REG-114 Plan Review - Linus Torvalds

**Date:** 2025-01-22
**Status:** APPROVED - Ready for implementation

---

## High-Level Assessment

This is the right thing to do. Both Don and Joel have delivered solid, pragmatic plans that align with Grafema's vision and established patterns. The scope is appropriate, the architecture is sound, and the implementation path is clear.

---

## Evaluation Against Acceptance Criteria

### Original Requirements

```javascript
obj.prop = value    → value FLOWS_INTO obj (via prop)
obj['prop'] = value → value FLOWS_INTO obj (via prop)
Object.assign(obj, source) → source properties FLOW_INTO obj
{ ...obj, prop: value } → value + obj FLOWS_INTO new object
```

**Plan Coverage:**

| Requirement | Addressed? | How |
|---|---|---|
| `obj.prop = value` | ✓ Yes | `detectObjectPropertyAssignment()` in module and function level |
| `obj['prop'] = value` | ✓ Yes | Handled as computed property with string literal check |
| `Object.assign()` | ✓ Yes | `detectObjectAssign()` in CallExpressionVisitor and function level |
| Spread operator `{ ...obj }` | ✓ Yes | Leverages existing `ObjectPropertyInfo` handling |
| Tests pass | ✓ Plan includes | Comprehensive test spec in Joel's plan |

**All acceptance criteria are addressed. No gaps.**

---

## Architectural Soundness

### 1. Vision Alignment: "AI Should Query the Graph"

✓ **Correct.** Without object mutation tracking:
- Configuration objects become invisible in the graph
- DI containers, event handlers, config builders can't be queried
- Cross-file data flow breaks

This fills a real gap. The feature is not a luxury—it's necessary for the tool to work on real legacy codebases.

### 2. Pattern Consistency

✓ **Good decision.** Following the array mutation pattern (REG-113) is exactly right:
- `FLOWS_INTO` edge semantics are consistent
- Data collection structure mirrors `ArrayMutationInfo`
- Integration point in `GraphBuilder` is identical
- No architectural reinvention

This is not overengineering—it's applying proven patterns.

### 3. Scope Definition

✓ **Appropriate.** The plan correctly defines:

**In scope:**
- Direct property: `obj.prop = value`
- Computed property: `obj['prop'] = value`, `obj[key] = value`
- `Object.assign()` with multiple sources
- Spread operators in object literals
- `this.prop = value` in methods

**Out of scope (documented):**
- Method-based mutations: `obj.setProperty(name, value)`
- Prototype chain modifications
- Chained access: `obj.nested.prop = value`
- `Object.defineProperty()`

This is pragmatic. The in-scope items cover 95% of real-world patterns. The out-of-scope items can become follow-up issues.

### 4. Edge Cases

Both plans correctly identify and address:
- **Aliased objects:** `const ref = obj; ref.prop = value` → creates flow to `ref`, not `obj`. Documented limitation.
- **Computed keys:** `obj[key] = value` → tracks with `<computed>` marker
- **Multiple sources:** `Object.assign(target, s1, s2, s3)` → multiple edges with `argIndex`
- **Anonymous targets:** `Object.assign({}, source)` → skipped (no variable to track)

These decisions are sensible. We're over-approximating in uncertain cases (which is correct for untyped analysis).

---

## Technical Plan Quality

### Code Organization

✓ **Clean.** The plan:
- Adds new types to existing `types.ts`
- Keeps detection split by context (module-level vs function-level)
- Creates parallel methods (`detectObjectPropertyAssignment`, `detectObjectAssign`) that mirror array mutation methods
- Centralizes edge creation in `GraphBuilder.bufferObjectMutationEdges()`

This follows the existing architecture. No surprises, no custom patterns.

### Interface Design

✓ **Solid.** The `ObjectMutationInfo` interface:
```typescript
{
  objectName: string;           // 'config', 'this'
  propertyName: string;         // 'handler', '<computed>', '<assign>'
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  value: ObjectMutationValue;   // Details about what's being assigned
}
```

This is exactly the right level of detail. Not too much, not too little. The `mutationType` and `propertyName` metadata enable future query-time analysis.

### Semantic IDs

✓ **Good.** The plan includes semantic ID generation:
```typescript
computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, ...)
```

This is consistent with REG-126 (semantic IDs for MODULE nodes). Enables deterministic analysis.

---

## Test Strategy

✓ **Comprehensive.** Joel's test spec covers:
- Direct property assignment
- Multiple properties on same object
- `this.prop` in methods
- String literal computed keys
- Dynamic computed keys
- `Object.assign()` with 1, 2, 3+ sources
- Spread in Object.assign
- Edge metadata verification
- Function-level mutations
- Integration with data flow

This is not a checkbox exercise. Tests actually validate the feature.

---

## Potential Concerns (And Why They're Resolved)

### Concern 1: False Positives
"We track all property assignments on identifiers, even non-objects."

**Resolution:** Don explicitly addresses this. In untyped codebases, over-approximation is correct. Better to include `str.length = 10` than miss legitimate cases. This is intentional, not a bug.

### Concern 2: Performance
"Adding more edge traversals could slow analysis."

**Resolution:** Don addresses this. Uses existing batching infrastructure. No new data structures, no new traversal algorithms. Risk is low.

### Concern 3: Aliased Objects
```javascript
const ref = obj;
ref.prop = value;  // Creates flow to 'ref', not 'obj'
```

**Resolution:** Documented limitation. Correctly scoped as out of scope. This would require SSA-form variable analysis (future work).

### Concern 4: `this` Tracking
"Cross-method `this` tracking is incomplete."

**Resolution:** Joel correctly scopes this. `this` mutations are tracked within the same method. Cross-method analysis is documented as future work. Correct decision.

---

## Implementation Readiness

✓ **Ready.** The plan is specific enough for implementation:

**Phase breakdown is clear:**
1. Types (2-3 edits)
2. Detection (6-8 methods added)
3. Edge creation (1 method in GraphBuilder)
4. Integration (4-5 wiring points)
5. Tests (comprehensive spec provided)

**Code locations are identified** (specific line numbers in files).

**Method signatures are detailed** (not pseudocode, actual TypeScript).

**Edge cases are decided** (not punted to implementation phase).

This is not "figure it out as you go"—it's "here's the implementation."

---

## One Minor Question

Joel's plan says spread operator handling is "already handled by existing `ObjectPropertyInfo`." I want Kent to verify during test writing that:
- Existing test coverage for `{ ...obj, prop: value }` actually works
- No double-counting when both spread and property assignment happen in same literal

This is a **verification step, not a blocker**. If there's an issue, it's a quick fix.

---

## Missing Pieces? No.

The plan covers:
- ✓ What to track (4 mutation types)
- ✓ How to detect (AST visitors in 2 contexts)
- ✓ How to represent (ObjectMutationInfo type)
- ✓ How to create edges (GraphBuilder method)
- ✓ How to test (detailed test spec)
- ✓ Implementation order (phased approach)
- ✓ Edge cases (handled with documented limitations)

**Nothing forgotten.**

---

## Verdict

**APPROVED. Proceed with implementation.**

This is good engineering:
- Fills a real product gap
- Follows established patterns
- Appropriately scoped
- Well-documented limitations
- Clear implementation path
- Ready for testing

Kent (test engineer) and Rob (implementation) have clear specifications and can move forward independently. No ambiguity, no design by committee in the implementation phase.

One thing I appreciate: Both Don and Joel knew when to say "that's out of scope" and when to say "we handle that." That's the difference between a feature and a mess.

Let's ship this.
