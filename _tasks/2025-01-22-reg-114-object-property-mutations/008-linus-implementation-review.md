# REG-114: Object Property Mutation Tracking - Implementation Review

**Author:** Linus Torvalds (High-level Reviewer)
**Date:** 2025-01-22
**Status:** APPROVED FOR MERGE

---

## Executive Assessment

This is the RIGHT implementation. It solves a real problem in the right way, follows established patterns, and doesn't cut corners. The tests pass, the architecture is sound, and the limitations are documented, not hidden.

---

## What Was Done Right

### 1. Pattern Consistency

The implementation mirrors the successful array mutation tracking (REG-113) exactly:
- Same `ObjectMutationInfo` → `ObjectMutationValue` structure as `ArrayMutationInfo` → `ArrayMutationArgument`
- Same detection points: module-level, function-level, special cases
- Same edge type (`FLOWS_INTO`) with consistent metadata (`mutationType`, `propertyName`)

This is NOT code duplication—this is following an established, proven pattern. That's correct.

### 2. Architectural Alignment

This fills a critical gap in the graph query capability:
```javascript
// Before: No way to trace this
const config = {};
config.handler = userHandler;

// After: Can query "what flows into config?"
MATCH (value)-[:FLOWS_INTO {mutationType: 'property', propertyName: 'handler'}]->(config)
```

This directly enables the Grafema vision: "AI should query the graph, not read code." Without this, AI still has to read code to understand data flow through configuration objects. With it, the graph is the answer.

### 3. Test Coverage is Thorough

21/23 tests pass. 2 are explicitly skipped with documented reasons:
- Class constructor/method parameters not being PARAMETER nodes → Pre-existing limitation, not introduced here
- Both tests have clear comments explaining the architectural gap

The passing tests cover:
- ✅ Basic property assignment (`obj.prop = value`)
- ✅ Bracket notation with string literals (`obj['prop'] = value`)
- ✅ Computed keys (`obj[key] = value`)
- ✅ Object.assign with single and multiple sources
- ✅ Spread in Object.assign
- ✅ Function-level mutations
- ✅ Arrow function mutations
- ✅ Edge metadata (mutationType, propertyName)
- ✅ Edge direction verification
- ✅ Real-world patterns (DI container, config merging, event handlers)
- ✅ Edge cases (expressions, call expressions, array vs object ambiguity)

This is comprehensive.

### 4. Known Limitations Are Clear

Rob documented the limitations clearly:

| Limitation | Status | Impact |
|-----------|--------|--------|
| Class parameter tracking | Pre-existing gap | Affects `this.prop = param` only; documented, skipped tests |
| Computed key ambiguity | Accepted behavior | `arr[i] = value` can trigger both array/object mutation detection; reasonable trade-off |
| Arrow function constants | No issue found | Works correctly |

None of these are hidden hacks or sweeping things under the rug. They're explicit architectural choices.

### 5. Code Quality

- TypeScript builds cleanly with no errors
- No `TODO`, `FIXME`, `HACK` comments in production code
- No mocks in production paths
- Consistent naming and structure
- Proper separation of concerns (detection in JSASTAnalyzer/CallExpressionVisitor, edge creation in GraphBuilder)

---

## Edge Direction is Correct

```typescript
// value FLOWS_INTO object (via property)
const edge = {
  type: 'FLOWS_INTO',
  src: valueNodeId,
  dst: objectVar.id,
  mutationType: 'property',
  propertyName: 'handler'
};
```

This is semantically correct:
- **Source**: What flows in (the value)
- **Destination**: Where it flows to (the object)
- **Metadata**: How it flows (property assignment, Object.assign, etc.)

Matches the original request exactly: "value FLOWS_INTO obj (via prop)"

---

## Abstraction Level is Right

The implementation is at exactly the right level:

**Too high-level:** Would just say "track object mutations" without distinguishing how they happen
**Too low-level:** Would track every field access, creating noise
**Just right:** Tracks the *semantic mutation event* (property assignment, Object.assign, spread)

This enables useful queries like:
- "What flows into this object via property assignment?"
- "What sources were merged into this object with Object.assign?"
- "What was the order of Object.assign sources?" (via argIndex)

---

## What's NOT a Problem

### Computed Key Ambiguity

Rob noted that `arr[0] = value` (array) and `obj['prop'] = value` (object) are syntactically identical. The solution is pragmatic:
- NumericLiteral keys → Array mutation only
- StringLiteral keys → Object mutation only
- Variable keys → Both (can't determine statically)

This is the right trade-off for untyped JavaScript analysis. Better to over-approximate than under-approximate.

### Anonymous Object.assign Targets

```javascript
const result = Object.assign({}, source);
```

The implementation correctly skips this because there's no variable to reference. Good decision.

### 'this' Property Assignments

```javascript
class Config {
  constructor(handler) {
    this.handler = handler;  // Can't find 'this' variable
  }
}
```

The implementation handles this gracefully: if the target object doesn't have a node, the edge isn't created. The comment explains why: "Future enhancement: create a special MUTATES_THIS edge or use class node as target."

This isn't a hack—it's a documented limitation that can be addressed in a follow-up issue.

---

## Why This Isn't Over-Engineering

Some might argue: "Just read the code, why create extra edges?"

**Because that's the entire point of Grafema.** The graph IS the answer. If AI still has to read code to understand data flow, then Grafema is just overhead. But if the graph can answer "what flows into this object?", then that's a feature, not waste.

The tests prove it works. The architecture proves it's sound.

---

## What Needs to Happen Next

### Before Merge
- ✅ Tests pass (21/23, with 2 documented skips)
- ✅ TypeScript compiles
- ✅ No production hacks
- ✅ Aligned with vision

### After Merge
These are NOT blockers for this PR:

1. **Create Linear issue for class parameter tracking**
   - Link the skipped tests to it
   - Can be addressed separately (is pre-existing limitation)

2. **Verify real-world impact**
   - Try running `grafema analyze` on a real legacy codebase with heavy object mutation patterns
   - Measure query performance impact

3. **Consider edge metadata unification** (future)
   - Array mutations use `mutationMethod`, object mutations use `mutationType`
   - Not a problem now, but could be unified for consistency

---

## Final Verdict

**APPROVED FOR MERGE**

This implementation:
- ✅ Does the right thing (solves real problem, aligns with vision)
- ✅ Doesn't cut corners (proper TDD, thorough tests)
- ✅ Follows established patterns (mirrors array mutations)
- ✅ Documents limitations (no hidden hacks)
- ✅ Is at the right abstraction level
- ✅ Builds cleanly, tests pass

The only surprises would be pleasant ones—this is solid work that moves Grafema forward toward its vision of being "the graph, not the code."

Rob's implementation is clean and pragmatic. Kent's tests are comprehensive. The architecture is right. This can merge.

---

## Questions for Product/Planning

1. Should we announce this capability in docs/marketing? (Config object tracing is a strong feature for legacy code)
2. Should we create the Linear issue for class parameters now or wait for feedback?
3. Want to dogfood this on Grafema itself before shipping?

