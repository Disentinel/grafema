# Linus Torvalds - Plan Review

## Verdict: NEEDS CHANGES

## What's Good

Joel's plan shows thoroughness in:
- **Correct problem understanding**: Accurately identified that we need both `importType` (syntax) and `importBinding` (semantics)
- **Breaking change awareness**: Called out ID format changes and field renames explicitly
- **Comprehensive test plan**: Unit tests + integration tests cover all edge cases
- **Rollback plan**: Clear recovery strategy if things go wrong
- **Auto-detection logic**: Smart inference of `importType` from `imported` field reduces API surface

The technical steps are sequenced correctly and the test coverage is solid.

## Concerns

### 1. CRITICAL: The ID Format Change Is Wrong

**Problem:**

Current GraphBuilder ID: `${file}:IMPORT:${source}:${local}:${line}`
Joel's proposed ID: `${file}:IMPORT:${name}:${line}` (where name = local)

**This removes `source` from the ID, which breaks uniqueness.**

Consider:
```javascript
import React from 'react';           // line 1
import React from 'preact/compat';   // line 2 (aliasing React)
```

Both would get ID: `/file.js:IMPORT:React:1` and `/file.js:IMPORT:React:2`

But if you import the same binding from different sources on the same line (rare but legal):
```javascript
import { foo } from 'lib-a'; import { foo as foo2 } from 'lib-b';  // line 1
```

Wait, actually this case is fine because `local` would be different (`foo` vs `foo2`).

**But here's the real problem:**

```javascript
import React from 'react';     // line 1
import { React } from './lib'; // line 1 (different file, but inline imports on same line)
```

If both happen to be on line 1, same file, we get ID collision.

**Worse still:** ImportNode contract says the ID includes `name`, but GraphBuilder calls it with `spec.local`. What if `name` parameter is meant to be something else? The semantic mismatch between "name" (ImportNode) and "local binding" (GraphBuilder) is suspicious.

**Don was right to flag this.** The ID format is part of the graph's identity system. We can't just arbitrarily change it without understanding what "name" means in the ImportNode contract vs what GraphBuilder is tracking.

### 2. MISSING: What Is "name" In ImportNode?

ImportNode.create() takes a `name` parameter as first argument. Joel assumes `name = spec.local` (the local binding).

But look at the return value:
```typescript
return {
  id: `${file}:IMPORT:${name}:${line}`,
  type: this.TYPE,
  name,   // ← This is stored
  file,
  line,
  column: column || 0,
  source,
  importKind: options.importKind || 'value',
  imported: options.imported || name,  // ← defaults to name
  local: options.local || name         // ← defaults to name
};
```

So `name` is stored on the node. But we also have `imported` and `local`. What's the semantic difference?

**In JavaScript/TypeScript imports:**
- `imported`: what the exporter named it
- `local`: what we bind it to locally

```javascript
import { foo as bar } from './lib';
// imported = 'foo'
// local = 'bar'
```

**So what is `name`?** The current ImportNode contract defaults both `imported` and `local` to `name` if not provided. This suggests `name` is meant to be the "primary identifier" — probably the local binding.

Joel's plan uses `spec.local` as the `name` parameter, which seems right. But Don's concern about ID format is valid: **we're removing the source from the ID, which could theoretically cause collisions for imports of the same binding from different sources on the same line.**

### 3. The Cast to `GraphNode` Is A Code Smell

In Step 3, Joel writes:
```typescript
this._bufferNode(importNode as unknown as GraphNode);
```

**This is a hack.** If ImportNodeRecord doesn't match GraphNode, that's a type system problem that should be fixed at the type level, not with `as unknown as`.

Why doesn't ImportNodeRecord match GraphNode? Let me guess: GraphNode probably doesn't know about the new `importType` and `importBinding` fields yet.

**This means we're missing a step:** Update the GraphNode type definition to include the new fields. Otherwise we're lying to TypeScript and the lie will come back to bite us later.

### 4. The Auto-Detection Logic Should Be In One Place

Joel's plan has `importType` auto-detection logic in TWO places:
1. Inside ImportNode.create() (lines 132-136 in Step 1)
2. Inside GraphBuilder.bufferImportNodes() (lines 331-332 in Step 3)

**This violates DRY.** If GraphBuilder already computes `importType` and passes it explicitly, why would ImportNode.create() have auto-detection fallback logic?

Pick one:
- Either GraphBuilder computes it and passes it (explicit)
- Or ImportNode.create() infers it from `imported` (implicit)

Don't do both. Dual logic means dual maintenance and dual bugs.

### 5. Column Defaulting to 0 Is Fine, But Document It

Joel correctly identifies that column isn't available in ImportInfo. Defaulting to 0 is pragmatic. But this should be **documented in the ImportNode.create() JSDoc** so future developers understand why all imports have column: 0.

Add a comment:
```typescript
/**
 * @param column - Column position. Pass 0 if unavailable (current limitation: JSASTAnalyzer doesn't capture column for imports)
 */
```

## Required Changes

### Change 1: Keep Source In ID (Or Prove We Don't Need It)

**Option A:** Keep the old ID format to avoid breaking changes:
```typescript
id: `${file}:IMPORT:${source}:${name}:${line}`
```

**Option B:** Prove that the new format can't cause collisions by analyzing real-world code patterns. If we can guarantee one file never imports the same binding from multiple sources on the same line, then the simplified format is safe.

**My recommendation:** **Keep the source in the ID.** It's more information, it's what we have now, and removing it creates risk for zero gain. Simplifying IDs isn't a goal here — correctness is.

If we keep the old format, we need to update ImportNode.create() to accept `source` in the ID generation logic. Or we need a separate ID generation function that matches GraphBuilder's expectations.

**Actually, wait. Let's think about this differently.**

The real question is: **What is the ImportNode contract meant to represent?**

- Is it the **generic concept** of an import node (format-agnostic)?
- Or is it the **specific format** that GraphBuilder needs?

If it's generic, then GraphBuilder shouldn't be using it directly — it should have its own ID format and convert to ImportNode format when needed.

If it's specific to GraphBuilder, then ImportNode.create() should match what GraphBuilder needs exactly.

**This is an architectural question that needs user input.** We can't proceed until we know which way to go.

### Change 2: Remove The Type Cast

Fix the GraphNode type to include the new fields, or fix the impedance mismatch properly. No `as unknown as` in production code.

### Change 3: Choose ONE Place For importType Auto-Detection

Remove the auto-detection logic from either:
- ImportNode.create() (let the caller decide)
- GraphBuilder (let ImportNode infer it)

**My vote:** Let GraphBuilder compute it explicitly and pass it to ImportNode. Why? Because:
1. GraphBuilder already has this logic
2. GraphBuilder knows the AST context
3. ImportNode.create() should be dumb and explicit — it's a factory, not a heuristic engine

### Change 4: Document Column Limitation

Add JSDoc to ImportNode.create() explaining why column might be 0.

### Change 5: Clarify "name" Semantics

Add a comment in ImportNode.ts explaining what `name` represents:
```typescript
/**
 * @param name - The local binding name (what the import is called in this module)
 */
```

This makes it explicit that `name = local`, which is currently implicit and confusing.

## Optional Suggestions

### 1. Consider Adding A Graph Schema Test

After migration, add a test that validates all IMPORT nodes in a real codebase:
- Every IMPORT has required fields
- No IMPORT has the old `importKind` field
- IDs match expected format

This is a "health check" that would catch migration issues early.

### 2. Consider A Feature Flag

If we're worried about the ID format change causing production issues, wrap it in a feature flag:
```typescript
const USE_NEW_IMPORT_ID_FORMAT = process.env.GRAFEMA_NEW_IMPORT_IDS === 'true';
```

This lets us test in production without full commitment. Can be removed after 1-2 releases.

### 3. Add importType To BaseNodeRecord In @grafema/types

If `importType` and `importBinding` are now part of the IMPORT node schema, they should be defined in `@grafema/types/nodes.ts` (if that's where GraphNode is defined). This ensures type consistency across the codebase.

## Bottom Line

Joel's plan is 80% there. The test coverage is great, the step sequence is logical, and the breaking change awareness is solid.

But we have an **architectural blocker**: the ID format change needs user sign-off because it's not just a refactor — it's a change to the graph's identity system.

**Before implementation:**
1. Get user decision on ID format (keep source or remove it?)
2. Fix the type cast issue (update GraphNode type definition)
3. Pick one place for `importType` auto-detection logic
4. Document the column limitation

Once those are resolved, Kent and Rob can proceed with confidence.

## Questions For User

1. **ID format:** Should IMPORT node IDs include the source module, or is `${file}:IMPORT:${name}:${line}` sufficient? Are there real-world cases where the same binding is imported from different sources on the same line in the same file?

2. **GraphNode type:** Where is GraphNode defined, and should we update it to include the new IMPORT fields before migration?

3. **Auto-detection:** Should `importType` inference live in ImportNode.create() as a fallback, or should GraphBuilder always compute it explicitly? (I vote explicit.)
