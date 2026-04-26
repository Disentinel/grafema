# Linus Torvalds - Plan Review for REG-309

**Task**: Scope-aware variable lookup for mutations
**Date**: 2026-02-01
**Reviewer**: Linus Torvalds (High-level Reviewer)

---

## Verdict: **APPROVED WITH RESERVATIONS**

This is the RIGHT thing to do. The technical approach is sound. But we need to address some concerns before implementation.

---

## 1. Did We Do the RIGHT Thing?

**YES.** Option B (Late Binding with Scope Chain Resolution) is the ONLY correct choice.

**Why the other options are wrong:**

- **Option A (Early Binding)**: Fundamentally broken. JavaScript lexical scoping means variables declared in parent scopes are visible in child scopes. Don himself identified this killer problem:
  ```javascript
  let total = 0;
  for (item of items) {
    total += item.price;  // total is in PARENT scope
  }
  ```
  Early binding would look for `total` in the loop scope and fail. Dead end.

- **Option C (Line-based)**: Stupid idea. Line numbers are unstable. Doesn't work for hoisting. Doesn't align with semantic IDs. Don was right to dismiss it immediately.

**Option B mirrors JavaScript semantics**: Walk the scope chain from inner to outer, just like the runtime. This is not negotiable — it's how the language works.

**Correctness matters more than performance.** Joel's O(n*m*s) analysis is honest, and the mitigation is reasonable (s ≤ 3 in practice). If profiling shows a problem later, optimize then. Don't prematurely optimize and introduce bugs.

---

## 2. Does It Align with Project Vision?

**YES. This is CRITICAL for correctness.**

From Don's plan:
> Without scope-aware lookup, the graph lies about data flow in any codebase with nested scopes. That's most real-world code.

**This is not a feature request. It's a correctness bug.**

If the graph says `outer.x` receives data flow from `inner.x += 3`, the graph is WRONG. AI agents can't trust wrong data. If you can't trust the graph, Grafema is worthless.

**Vision alignment:**
- "AI should query the graph, not read code" — requires graph to be CORRECT
- Graph must represent reality, not a broken approximation
- Shadowing is fundamental to JavaScript — we MUST handle it

**Priority**: This should be v0.1.x or v0.2 at latest. It's a correctness bug, not a nice-to-have.

---

## 3. Is It at the Right Level of Abstraction?

**Mostly YES, with one concern.**

**Good abstractions:**

1. **`resolveVariableInScope(name, scopePath, file, variables)`** — Clean interface. Takes scope path, returns variable. Mirrors JavaScript semantics. ✅

2. **Scope path in mutation info** — Right choice. Capture WHERE mutation happens, resolve WHAT it mutates at enrichment time. Separation of concerns. ✅

3. **Scope chain walk** — Correct algorithm. Try current scope, then parent, then grandparent. Exactly how JavaScript works. ✅

**Questionable abstraction:**

**Parameter lookup duplication** — Joel duplicates this pattern in ALL THREE handlers:

```typescript
let targetParam: ParameterInfo | undefined;
if (!targetVar) {
  targetParam = parameters.find(p => {
    if (p.name !== variableName || p.file !== file) return false;
    if (p.semanticId) {
      const parsed = parseSemanticId(p.semanticId);
      if (parsed && parsed.type === 'PARAMETER') {
        for (let i = scopePath.length; i >= 0; i--) {
          if (this.scopePathsMatch(parsed.scopePath, scopePath.slice(0, i))) {
            return true;
          }
        }
      }
    }
    return false;
  });
}
```

This is copied verbatim in:
- `bufferVariableReassignmentEdges`
- `bufferArrayMutationEdges` (twice: target and base object)
- `bufferObjectMutationEdges` (twice: target and source)

**Six copies of the same logic.** This is a maintenance bomb. If we fix a bug in parameter lookup, we have to fix it six times.

**RECOMMENDATION**: Extract to `resolveParameterInScope()` helper. Same signature as `resolveVariableInScope()`:

```typescript
private resolveParameterInScope(
  name: string,
  scopePath: string[],
  file: string,
  parameters: ParameterInfo[]
): ParameterInfo | null {
  return parameters.find(p => {
    if (p.name !== name || p.file !== file) return false;
    if (p.semanticId) {
      const parsed = parseSemanticId(p.semanticId);
      if (parsed && parsed.type === 'PARAMETER') {
        for (let i = scopePath.length; i >= 0; i--) {
          if (this.scopePathsMatch(parsed.scopePath, scopePath.slice(0, i))) {
            return true;
          }
        }
      }
    }
    return false;
  }) ?? null;
}
```

Then all handlers use:
```typescript
const targetVar = this.resolveVariableInScope(name, scopePath, file, variableDeclarations);
const targetParam = !targetVar ? this.resolveParameterInScope(name, scopePath, file, parameters) : null;
const targetNodeId = targetVar?.id ?? targetParam?.id;
```

**Cleaner. DRY. Easier to maintain.**

---

## 4. Did We Add a Hack Where We Could Do the Right Thing?

**One legitimate fallback, one questionable choice.**

**Legitimate fallback (ACCEPTABLE):**

```typescript
// Legacy ID - assume module-level if no semantic ID
return searchScopePath.length === 0;
```

This handles backward compatibility with old graph data. Reasonable. If `parseSemanticId()` returns null (legacy format), assume file-level variable. This is safe because:
- Old data doesn't have scope info
- File-level is the most conservative assumption
- New analysis will generate semantic IDs going forward

**Not a hack. It's graceful degradation.**

**Questionable choice (CONCERN):**

Joel's plan removes Map-based lookup cache and switches to O(n*m*s) linear search:

```typescript
// Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk
// Performance: O(n*m*s) where s = scope depth (typically 2-3), acceptable for correctness
```

**Question**: Could we have BOTH correctness AND performance?

**Possible optimization (defer to later, but think about it now):**

Build scope-indexed cache at enrichment start:
```typescript
const scopedVarIndex = new Map<string, VariableDeclarationInfo>();
for (const v of variableDeclarations) {
  const parsed = parseSemanticId(v.id);
  if (parsed) {
    // Key format: "file:scope1->scope2:name"
    const scopeKey = parsed.scopePath.join('->');
    const key = `${v.file}:${scopeKey}:${v.name}`;
    scopedVarIndex.set(key, v);
  }
}
```

Then scope chain walk becomes O(s) Map lookups instead of O(m*s) linear search:
```typescript
for (let i = scopePath.length; i >= 0; i--) {
  const searchScope = scopePath.slice(0, i).join('->');
  const key = `${file}:${searchScope}:${name}`;
  const match = scopedVarIndex.get(key);
  if (match) return match;
}
```

**Performance**: O(n) to build cache + O(s) per lookup = O(n + k*s) where k = mutations. Much better than O(k*m*s).

**BUT**: Joel is right — don't prematurely optimize. Linear search is fine for now. If profiling shows a bottleneck on large files (thousands of variables), optimize then.

**Verdict**: Not a hack. Acceptable tradeoff. But keep optimization possibility in mind.

---

## 5. Did We Forget Something from the Original Request?

**Let me check acceptance criteria:**

From `001-user-request.md`:
- [x] Implement scope-aware variable lookup in GraphBuilder ✅
- [x] Update all mutation handlers to use scope-aware lookup ✅
- [x] Add tests for shadowed variable scenarios ✅

**All covered.**

**Additional coverage from Joel's plan:**
- Variable reassignments ✅
- Array mutations ✅
- Object mutations ✅
- Parameters ✅
- Nested scopes ✅
- Module-level variables ✅

**Edge cases identified:**
- Parameters in nested scopes ✅
- Arrow functions ✅
- Class methods ✅
- Multiple nesting levels ✅

**Joel's test strategy is comprehensive.** Kent will expand it, but the scenarios are right.

**One missing edge case (MINOR):**

**Block-scoped variables (let/const) vs function-scoped (var):**

```javascript
function foo() {
  var x = 1;  // Function-scoped
  if (true) {
    var x = 2;  // SAME variable (var is function-scoped)
    x++;        // Mutates the function-level x
  }
}

function bar() {
  let y = 1;  // Block-scoped
  if (true) {
    let y = 2;  // DIFFERENT variable (let is block-scoped)
    y++;        // Mutates the inner y
  }
}
```

**Does ScopeTracker handle this correctly?** Need to verify that `var` declarations don't create new scopes for blocks.

**Likely fine** — ScopeTracker probably only creates scopes for functions/classes, not blocks. But verify in testing.

---

## Open Questions Review

Joel asked 4 questions. Here are my answers:

### 1. Semantic ID coverage: require ALL or fallback acceptable?

**ANSWER**: Fallback is acceptable for backward compatibility.

**Rationale**:
- New analysis generates semantic IDs (verified in IdGenerator.ts:88)
- Old graph data may have legacy IDs
- Graceful degradation is better than failing hard
- Fallback to module-level is safe (conservative)

**Requirement**: Add logging when fallback is used. If we see lots of fallbacks on new analysis, that's a bug.

### 2. Performance optimization: cache now or defer?

**ANSWER**: Defer until profiling shows bottleneck.

**Rationale**:
- Correctness first, performance second
- O(n*m*s) is acceptable for typical files (s ≤ 3, m ≤ 100)
- Optimization path is clear (scope-indexed Map)
- Don't add complexity without evidence it's needed

**Requirement**: Add a comment explaining the optimization possibility for future reference.

### 3. Parameter lookup: extract helper or inline?

**ANSWER**: Extract helper. Six copies of same logic is too much.

**Rationale**:
- DRY principle violated
- Bug fixes require six edits
- Helper is 10 lines, saves 60+ lines of duplication
- Same abstraction level as `resolveVariableInScope()`

**Requirement**: Add `resolveParameterInScope()` helper before implementation.

### 4. Function-level variables: scope chain or file-level?

**ANSWER**: Keep current file-level lookup for functions.

**Rationale**:
- Functions are hoisted in JavaScript
- Function declarations are visible throughout file (or module)
- Arrow functions assigned to const are scoped like variables (already handled)
- Current logic is correct for function declarations

**No change needed.**

---

## Technical Concerns

### 1. Semantic ID Parsing Reliability

Joel's code assumes `parseSemanticId()` is robust:
```typescript
const parsed = parseSemanticId(v.id);
if (parsed && parsed.type === 'VARIABLE') {
  return this.scopePathsMatch(parsed.scopePath, searchScopePath);
}
```

**Question**: What if parsing succeeds but returns wrong type?

Example:
- Variable ID is accidentally a PARAMETER semantic ID
- `parsed.type === 'PARAMETER'` not `'VARIABLE'`
- Lookup fails silently

**MITIGATION**: Type check is correct — if type doesn't match, we skip it and try next scope. Fallback to legacy ID handles edge cases. **Acceptable.**

### 2. Scope Path Consistency

Don raised this in his plan:
> Do mutation scope paths match variable declaration scope paths?

**Verification needed**: Both use `ScopeTracker.getContext().scopePath`. Should be consistent.

**Requirement for Kent**: Add test that verifies semantic IDs from variables and mutations use same scope path format.

### 3. Empty Scope Path for Module-Level

Joel verified: module-level variables have `scopePath = []`.

**Evidence**:
- `ScopeTracker.getContext()` returns `scopePath: this.scopeStack.map(s => s.name)`
- Empty stack → empty array
- `computeSemanticId()` with empty scope generates: `file->global->VARIABLE->name`

**Wait. Joel said empty scope path generates `file->global->VARIABLE->name`, but also said scope path is empty array.**

Let me check Don's plan:
> `computeSemanticId()` with empty scope path generates: `file->VARIABLE->name`

**Contradiction.** Joel says "global" is inserted, Don says it's omitted.

**Let me check SemanticId.ts** (from earlier read):
```typescript
const scope = scopePath.length > 0 ? scopePath.join('->') : 'global';
let id = `${file}->${scope}->${type}->${name}`;
```

**Actual behavior**: Empty scope path → `"global"` string is used.

**So semantic ID is**: `file->global->VARIABLE->name` for module-level variables.

**Joel is right, Don's example was wrong.**

**Impact on implementation**:
```typescript
// Joel's code
const scopePath = parts.slice(1, -2);
```

For `file->global->VARIABLE->name`:
- `parts = ['file', 'global', 'VARIABLE', 'name']`
- `scopePath = parts.slice(1, -2) = ['global']`

**So module-level variables have `scopePath = ['global']`, not `[]`.**

**CRITICAL BUG IN JOEL'S PLAN:**

Joel's code checks:
```typescript
// Legacy ID - assume module-level if no semantic ID
return searchScopePath.length === 0;
```

But module-level variables have `scopePath = ['global']`, not `[]`.

**FIX NEEDED**:
```typescript
// Module-level variables have scopePath = ['global']
return searchScopePath.length === 0 && parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
```

Or better:
```typescript
// Empty search scope path matches 'global' scope
if (searchScopePath.length === 0) {
  return parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
}
return this.scopePathsMatch(parsed.scopePath, searchScopePath);
```

**This is a show-stopper bug.** Must be fixed before implementation.

---

## Required Changes Before Implementation

### CRITICAL (must fix):

1. **Fix module-level scope matching** — Empty search scope `[]` should match semantic ID scope `['global']`. Current logic is broken.

2. **Extract `resolveParameterInScope()` helper** — Six copies of same logic is unacceptable. Extract to helper method before implementation.

### RECOMMENDED (should fix):

3. **Add comment about optimization path** — Document the scope-indexed Map optimization for future reference.

4. **Add logging for fallback usage** — When `parseSemanticId()` fails and we fall back to module-level assumption, log it. This will surface bugs in semantic ID generation.

### NICE-TO-HAVE (optional):

5. **Add test for var vs let/const scoping** — Verify that `var` hoisting and function-scoping work correctly.

---

## Test Coverage Requirements

Kent's test plan should include:

**MUST HAVE:**

1. **Basic shadowing** (all three mutation types) ✅
2. **Parent scope lookup** ✅
3. **Multiple nesting levels** ✅
4. **Module-level mutations** (`scopePath = []` → matches `['global']`) ⚠️ **Add explicit test**
5. **Parameter mutations in nested scopes** ✅
6. **Semantic ID scope path consistency** ⚠️ **Add verification test**

**SHOULD HAVE:**

7. **Legacy ID fallback** — Test that variables with legacy IDs work (backward compatibility)
8. **Arrow functions** ✅
9. **Class methods** ✅

**NICE TO HAVE:**

10. **var vs let/const scoping** — Verify hoisting works correctly

---

## Performance Expectations

Joel's analysis:
- **Before**: O(n) with Map cache
- **After**: O(k*m*s) where k=mutations, m=variables, s=scope depth

**Typical values**:
- k = 50-100 mutations per file
- m = 50-100 variables per file
- s = 2-3 scope depth

**Worst case**: 100 * 100 * 3 = 30,000 operations per file

**Is this acceptable?** YES. Modern CPUs do millions of operations per second. 30k is negligible.

**When to optimize**: If profiling shows >100ms per file on large codebases.

**Optimization path**: Scope-indexed Map (reduces to O(n + k*s)).

---

## Alignment Check

**Does this fix move us toward the vision?**

**HELL YES.**

Before this fix:
```
Agent: "Where does data flow into x in function foo?"
Graph: "From outer x"
Agent: "But there are two x variables..."
User: "The graph is lying. Don't trust it."
```

After this fix:
```
Agent: "Where does data flow into x in function foo?"
Graph: "From literal 3 in the mutation x += 3"
Agent: "And what about outer x?"
Graph: "From literal 1 in the declaration"
Agent: "Perfect. Two separate variables, two separate flows."
```

**This is what correctness looks like.** The graph must represent reality.

---

## Final Verdict

**APPROVED WITH RESERVATIONS**

**Why approved:**
- Option B is the RIGHT architectural choice ✅
- Aligns with project vision (correctness over convenience) ✅
- Technical approach is sound ✅
- Test coverage is comprehensive ✅
- Performance tradeoff is acceptable ✅

**Why reservations:**

1. **CRITICAL BUG**: Module-level scope matching is broken. Empty search scope `[]` won't match semantic ID scope `['global']`. **MUST FIX.**

2. **CODE DUPLICATION**: Parameter lookup duplicated six times. **MUST EXTRACT** to `resolveParameterInScope()` helper.

3. **MISSING VERIFICATION**: Need test that checks scope path consistency between variables and mutations.

**Joel must revise plan to address items 1 and 2 before Kent starts writing tests.**

---

## Instructions for Next Steps

1. **Joel**: Revise tech plan to fix module-level matching and add `resolveParameterInScope()` helper.
2. **Don**: Review Joel's revision. If approved, proceed to implementation.
3. **Kent**: Write tests based on revised plan. Include module-level scope test and scope path consistency verification.
4. **Rob**: Implement after Kent's tests are in place.

---

**Bottom line**: This is the right thing to do. Fix the critical bug, extract the helper, then ship it.

No half measures. No shortcuts. Do it right.

---

**Linus Torvalds**
High-level Reviewer, Grafema
