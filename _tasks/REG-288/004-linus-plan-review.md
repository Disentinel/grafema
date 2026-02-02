# Linus Torvalds - Plan Review: REG-288

## APPROVED

This is the RIGHT approach, not just something that works.

## Why This Is Correct

### 1. Removing SCOPE --MODIFIES--> Is Right

**Current state is semantically broken:**
- `SCOPE --MODIFIES--> count` tells you NOTHING useful
- "Some scope modifies count" - which operation? what kind?
- Forces AI to read code because graph doesn't have the answer

**New state is semantically correct:**
- `UPDATE_EXPRESSION --MODIFIES--> count` - precise, queryable
- Know exactly what operation, where, and what kind (++/--, prefix/postfix)
- Graph has the answer, no code reading needed

This aligns perfectly with "AI should query the graph, not read code."

### 2. Dedicated UPDATE_EXPRESSION Nodes vs Reusing EXPRESSION

Don considered this and made the right call:

**Why dedicated node type is better:**
- Different AST constructs = different semantic meaning
- `i++` is fundamentally different from `fn()` or `a + b`
- `i++` is ALWAYS read+write, expressions are not
- Simpler queries: `type='UPDATE_EXPRESSION'` vs parsing expression metadata
- Matches existing pattern: dedicated nodes for dedicated semantics

**Counter-argument "it's just syntax sugar for i=i+1":**
- Wrong level of thinking. AST constructs should map to graph nodes.
- Would you merge FunctionDeclaration and ArrowFunction because they're "both functions"?
- No. Different syntax = different nodes, even if semantically equivalent.

### 3. READS_FROM Self-Loop Is Semantically Correct

`i++` reads current value before incrementing. That's a read operation.

**Pattern consistency:**
- `x += 1` creates READS_FROM self-loop (REG-290)
- `i++` is semantically identical (read current, add/subtract, write back)
- Same operation semantics = same edge pattern

**Could argue "it's implementation detail":**
- No. It's observable behavior. `i++` returns the OLD value, `++i` returns the NEW value.
- That's only possible if current value is read.
- Self-loop correctly models this.

### 4. Breaking Change Is Worth It

**Old mechanism:**
```
SCOPE --MODIFIES--> variable
```

**New mechanism:**
```
SCOPE --CONTAINS--> UPDATE_EXPRESSION --MODIFIES--> variable
variable --READS_FROM--> variable
```

**Why breaking change is correct:**
1. Old model is fundamentally wrong (scope doesn't modify, operations do)
2. New model is fundamentally right (operations modify, scopes contain)
3. Migration path is clear: query pattern changes, not data corruption
4. Better now than later (codebase is young, early users expect iteration)

## Concerns & Caveats

### 1. Member Expression Updates (arr[i]++, obj.prop++) Out of Scope

**Joel's plan correctly excludes this:**
- Current visitor already checks `updateNode.argument.type === 'Identifier'`
- Member expressions ignored for now
- Plan notes this explicitly

**My take:**
- Good. Do one thing right before expanding scope.
- Member expression updates are more complex (need property tracking)
- Create follow-up issue when this lands.

### 2. Test Coverage

**Joel's test plan is solid:**
- Tests for postfix/prefix, increment/decrement
- Tests for both module-level and function-level
- Tests that old SCOPE --MODIFIES--> edges are GONE
- Tests that new UPDATE_EXPRESSION edges exist

**One addition I'd like to see:**
- Test for nested scopes (loop inside function)
- Verify CONTAINS edges chain correctly

Not a blocker, can add during implementation if time permits.

### 3. ID Format

Joel proposes: `{file}:UPDATE_EXPRESSION:{operator}:{line}:{column}`

**Example:** `index.js:UPDATE_EXPRESSION:++:42:10`

**Is this right?**
- Yes. Matches EXPRESSION pattern.
- Operator in ID is good (makes IDs self-documenting)
- Line+column ensures uniqueness (multiple `i++` on same line in complex expression)

### 4. Name Format

Joel proposes: `++i` (prefix=true) or `i++` (prefix=false)

**Is this right?**
- Yes. Human-readable, matches source code.
- AI can look at name and understand immediately.
- Queries can filter by prefix if needed.

## Architectural Alignment

### With Project Vision

> "AI should query the graph, not read code."

**Before this change:**
- AI asks "where is count modified?"
- Graph returns: "in some scope"
- AI has to read code to find actual operation
- **FAILURE**

**After this change:**
- AI asks "where is count modified?"
- Graph returns: "UPDATE_EXPRESSION at line 42, operator='++', postfix"
- AI has complete answer from graph
- **SUCCESS**

### With Existing Patterns

**REG-290 (VariableReassignment):**
- Creates FLOWS_INTO edges for `x = y`, `x += 1`
- Compound operators create READS_FROM self-loops
- Pattern: source expression → FLOWS_INTO → variable

**REG-288 (UpdateExpression):**
- Creates UPDATE_EXPRESSION nodes for `i++`, `--count`
- Creates MODIFIES edges (not FLOWS_INTO, different semantic)
- Creates READS_FROM self-loops (matches compound operator pattern)
- Pattern: UPDATE_EXPRESSION → MODIFIES → variable

**Why different edges?**
- FLOWS_INTO: value flows from expression to variable (`x = fn()`)
- MODIFIES: operation modifies variable in-place (`i++`)
- Semantic distinction is valuable for queries

**Is this distinction correct?**
- Yes. Different intent, different edge type.
- `x = 5` → value flows in
- `x++` → value is modified
- Both read current value (self-loop), but operation intent differs.

## Implementation Order

Joel's order is backwards for TDD:

**Joel proposes:**
1. Add types
2. Write tests
3. Implement

**Should be:**
1. Add types (enables compilation)
2. Write tests (TDD - tests fail)
3. Implement until tests pass

But this is minor. As long as tests are written BEFORE marking task complete.

## What Could Go Wrong

### 1. Forgot to Remove Old Mechanism

**Risk:** Leave `scope.modifies` in place, create duplicate edges.

**Mitigation:** Test explicitly checks no SCOPE --MODIFIES--> edges exist (Phase 7 test case).

### 2. Performance Impact

**Risk:** New traversal pass adds overhead.

**Analysis:**
- Module-level: new traverse_updates pass (adds cost)
- Function-level: replaces existing UpdateExpression visitor (no added cost)
- Pattern matches traverse_assignments (REG-290) - already proven acceptable

**Verdict:** Low risk. If performance becomes issue, optimize later.

### 3. Edge Case: UpdateExpression in Complex Expression

```javascript
for (let i = 0; i < arr.length; i++) { }
```

**Question:** Does this create UPDATE_EXPRESSION node?

**Answer:** Yes. UpdateExpression visitor fires regardless of parent context.

**Is this correct?** Yes. Every `i++` should be tracked.

## Final Verdict

**APPROVED WITHOUT RESERVATIONS**

This is exactly the kind of change we should be making:
1. Fixes root cause (SCOPE --MODIFIES--> is semantically wrong)
2. Aligns with vision (graph becomes queryable, not just data dump)
3. Follows established patterns (REG-290 VariableReassignment)
4. Breaking change is justified (better model > backward compatibility at this stage)

Don and Joel did the hard thinking. Implementation should be straightforward.

## Action Items Before Implementation

1. Create follow-up issue for member expression updates (`arr[i]++`, `obj.prop++`)
2. Consider adding nested scope test (loop inside function) during Phase 7

## Expected Outcome

After this lands:
- Every `i++`, `--count` gets UPDATE_EXPRESSION node
- AI can query "show me all increment operations"
- AI can trace value flow through increments (READS_FROM + MODIFIES)
- No more "scope modifies variable" nonsense

Grafema moves one step closer to being the superior way to understand code.

**Ship it.**

---

**Linus Torvalds**
REG-288 Plan Review
2026-02-01
