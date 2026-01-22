# Steve Jobs: Parallel Sprint Selection

## Selection Criteria

I reviewed 50+ backlog issues and selected 4 tasks based on:
1. **No file conflicts** - tasks touch completely different areas of the codebase
2. **Similar complexity** - each can be completed in roughly the same timeframe
3. **Meaningful together** - completing all 4 delivers visible product improvement
4. **No blocking relationships** - all tasks are independent

## Selected Tasks (4)

### Task 1: REG-129 - Migrate TYPE and ENUM to use colon separator ID format

**Files affected**:
- `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` (lines ~193, ~221)
- `packages/core/src/core/nodes/TypeNode.ts` (factory)
- `packages/core/src/core/nodes/EnumNode.ts` (factory)

**Why selected**: Completes the ID format consistency story. All other node types (CLASS, INTERFACE, IMPORT, EXPORT) already use the `:` separator format. TYPE and ENUM are the last holdouts using the legacy `#` format. This is surgical, well-scoped work.

**Complexity**: Small-Medium (clear pattern to follow from REG-103, REG-105)

---

### Task 2: REG-125 - UX: Show semantic IDs in default CLI output

**Files affected**:
- `packages/cli/src/commands/query.ts`
- `packages/cli/src/commands/trace.ts`
- `packages/cli/src/commands/overview.ts`
- `packages/cli/src/utils/codePreview.ts` (potentially)

**Why selected**: This is UX gold. We built semantic IDs (REG-123), but then hid them behind `--json`. That's like building a beautiful product and hiding it in the basement. Users should see semantic IDs as the PRIMARY identifier without special flags.

**Complexity**: Small-Medium (output formatting changes, no core logic changes)

---

### Task 3: REG-126 - Inconsistency: MODULE nodes use hash IDs instead of semantic IDs

**Files affected**:
- `packages/core/src/core/nodes/ModuleNode.ts`
- `packages/core/src/plugins/indexing/JSModuleIndexer.ts`
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (MODULE creation path)

**Why selected**: Another consistency fix that makes the product feel polished. Every other node uses semantic IDs. MODULE nodes still use cryptic hashes. This jarring inconsistency breaks the "semantic IDs everywhere" promise. Fixed.

**Complexity**: Small (clear pattern, isolated change)

---

### Task 4: REG-128 - Clean up dead interfaceId computation in TypeScriptVisitor

**Files affected**:
- `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` (line 129)
- Potentially: interface type definitions

**Why selected**: Technical hygiene. After REG-103, there's dead code computing `interfaceId` that's never used. This creates confusion about where IDs come from. Small change, big clarity improvement.

**Complexity**: Small (remove dead code, update types if needed)

---

## Why These 4 Work Together

### No File Conflicts

| Task | Primary Files | Overlap Risk |
|------|---------------|--------------|
| REG-129 | TypeScriptVisitor (TYPE/ENUM sections), TypeNode, EnumNode | None |
| REG-125 | CLI commands (query, trace, overview) | None |
| REG-126 | ModuleNode, JSModuleIndexer | None |
| REG-128 | TypeScriptVisitor (INTERFACE section only) | Minimal* |

*REG-128 and REG-129 both touch TypeScriptVisitor, but different sections:
- REG-128: line ~129 (interfaceId computation)
- REG-129: lines ~193 (TYPE) and ~221 (ENUM)

These are 60+ lines apart. No conflict.

### Complementary Impact

All 4 tasks contribute to **one theme**: **ID Consistency & Visibility**

1. REG-129: IDs are consistently formatted (`:` separator everywhere)
2. REG-126: IDs are consistently semantic (no hash outliers)
3. REG-125: IDs are consistently visible (no hidden behind flags)
4. REG-128: ID generation is consistently located (no dead code confusion)

### Similar Complexity

All tasks are Small to Small-Medium:
- Clear scope boundaries
- Existing patterns to follow
- No architectural decisions required
- Tests exist to validate changes

---

## Expected Outcome

When all 4 complete, we deliver:

**For Users:**
- `grafema query` shows semantic IDs by default - no `--json` needed
- All node types have readable, consistent IDs
- MODULE nodes no longer look like alien hashes

**For Developers:**
- TypeScriptVisitor is cleaner (no dead code)
- ID format is consistent across the entire codebase
- Clear single source of truth for ID generation

**For the Product:**
- The "semantic IDs" feature feels complete, not half-baked
- Demo-ready: I can show this to users and they'll understand what they see
- No asterisks, no "except MODULE nodes", no "use --json to see the real IDs"

---

## What I Rejected (and Why)

| Task | Reason for Rejection |
|------|---------------------|
| REG-122 (loc assertions) | 100+ occurrences - too large for parallel sprint |
| REG-111 (branded types) | Touches GraphBackend and all node types - too wide |
| REG-114 (object mutations) | Feature work, not polish - different sprint type |
| REG-117 (nested arrays) | Depends on understanding REG-113 patterns - coupling risk |
| REG-127 (code review) | Meta-task, not parallelizable |

---

## Demo Vision

After this sprint, I want to run `grafema query --callers myFunction` and see:

```
myFunction (src/utils/helpers.ts:42)
  Called by:
    - src/api/users.ts:FUNCTION:processUser:15
    - src/api/orders.ts:FUNCTION:createOrder:28
    - src/services/auth.ts:METHOD:AuthService.validate:92
```

Not:
```
Called by:
    - FUNCTION#a7b3c9d2e1f4...
    - FUNCTION#89e2a1b3c4d5...
```

That's the difference between a product and a prototype.

---

*"Real artists ship. But they ship things that make sense."*
