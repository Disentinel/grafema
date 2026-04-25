# Linus Review: REG-312 Plan

## Status: APPROVED

Don's plan is RIGHT. This is how it should be done.

## Key Strengths

### 1. Semantic Correctness

Don caught the trap: member expression updates are NOT object mutations, they ARE update expressions.

The plan correctly identifies:
```
i++           → UPDATE_EXPRESSION (variable modification)
obj.prop++    → UPDATE_EXPRESSION (property modification via object reference)
obj.prop = x  → FLOWS_INTO (data flow between variables)
```

The discriminated union (`targetType: 'IDENTIFIER' | 'MEMBER_EXPRESSION'`) is the right abstraction level. It preserves the operation semantic (increment/decrement) while handling different targets.

### 2. Edge Structure is Correct

```
UPDATE_EXPRESSION --MODIFIES--> VARIABLE(obj)
VARIABLE(obj) --READS_FROM--> VARIABLE(obj)  // self-loop
```

**MODIFIES points to the object variable, NOT the property.**

This is RIGHT because:
- The graph tracks variables (nodes), not property values
- `obj.prop++` modifies the object's state through the obj reference
- The property name is metadata on the UPDATE_EXPRESSION node
- Users query: "what modifies this object?" not "what modifies this property?"

The READS_FROM self-loop correctly captures read-before-write semantic.

### 3. Consistency with Existing Patterns

Don's analysis of the architectural tension (lines 66-90) shows deep understanding:
- He considered ObjectMutation pattern (FLOWS_INTO edges)
- He considered creating new node types (PROPERTY_UPDATE)
- He rejected both in favor of extending UPDATE_EXPRESSION
- **This is the right call.**

The plan aligns with:
- **REG-288**: UPDATE_EXPRESSION pattern for modification operations
- **REG-152**: this.prop handling with enclosingClassName
- **Object mutations**: property/computed mutationType vocabulary

### 4. Proper Scope of Work

The plan correctly SKIPS:
- Chained access: `obj.nested.prop++` (same limitation as object mutations)
- Complex objects: `(obj || fallback).prop++`

These are documented limitations, not TODOs. No half-baked compromises.

### 5. Test Coverage

Lines 893-912 specify exact test cases needed. This is complete.

## Architectural Review

### Question: Is the discriminated union approach correct?

**YES.**

TypeScript discriminated unions are the right tool when:
1. Variants share common operations (++ and --)
2. Each variant has type-specific metadata (variableName vs objectName/propertyName)
3. Processing logic branches on variant type (IDENTIFIER vs MEMBER_EXPRESSION paths)

All three apply here. This is not premature abstraction - it's the minimal correct model.

### Question: Is MODIFIES pointing to the object (not property) correct?

**YES.**

The graph models **variable references**, not property values. When you do `obj.prop++`:
- You modify the object that `obj` points to
- The property name is an implementation detail (metadata)
- The operation target is the variable `obj`

If we tried to make MODIFIES point to "the property", we'd need property nodes in the graph. That's a much bigger semantic change (and probably wrong).

### Question: Does this align with project vision?

**YES.**

Grafema's thesis: "AI should query the graph, not read code."

This enables queries like:
```
find_node('UPDATE_EXPRESSION', {propertyName: 'count'})
find_edges({dst: obj_id, type: 'MODIFIES'})  # What modifies obj?
find_edges({src: obj_id, type: 'READS_FROM'})  # What does obj read from?
```

These are the RIGHT queries for understanding code behavior.

### Question: Any semantic incorrectness?

**NO.**

The semantic model is sound:
- UPDATE_EXPRESSION represents the operation node (AST-level)
- MODIFIES edge represents the effect (semantic-level)
- READS_FROM edge represents data dependency (semantic-level)
- targetType discriminates operation targets (structural-level)

All levels are clean and aligned.

## Minor Observations

### 1. Code Reuse

Lines 577-617 show significant duplication with `detectObjectPropertyAssignment`. Don acknowledges this (line 801: "reuse detectObjectPropertyAssignment logic").

This is acceptable for initial implementation. If duplication becomes painful, extract shared helper. Not a blocker.

### 2. Scope Resolution Limitation

Lines 829-840 document the known scope resolution limitation.

Don correctly identifies this affects both `obj.prop++` and `obj.prop = value`. Consistent limitation = correct. Fix globally later, not piecemeal.

### 3. Array vs Object Ambiguity

Lines 850-862: The plan uses numeric literal as discriminator (arr[0] = array, arr[key] = object).

This is pragmatic. JavaScript doesn't distinguish arrays from objects at runtime anyway. The heuristic matches user intent 99% of the time.

## Concerns

**NONE.**

This plan does the right thing, the right way, with no shortcuts or hacks.

## Decision

**PROCEED WITH IMPLEMENTATION.**

Don's plan is architecturally sound, semantically correct, and aligned with project vision. Joel can expand this into implementation steps.

## Final Check

Would I show this design on stage?

**YES.** This is clean, understandable, and defensible.

---

**APPROVED. Move to Joel for detailed tech plan.**
