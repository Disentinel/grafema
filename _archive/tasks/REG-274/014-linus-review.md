# Linus Torvalds: REG-274 Review

**Status:** REJECT - Incomplete and misaligned with requirements

---

## Summary Assessment

REG-274 was supposed to implement "BRANCH node for IfStatement" per the original user request. Instead, the team pivoted to implementing `find_guards` MCP tool + scope tracking improvements. This is a **scope creep + pivot without explicit user approval**, and the resulting implementation is **architecturally incomplete**.

The delivered system doesn't do what the user asked for, and what WAS delivered is only a partial workaround.

---

## Did We Do the Right Thing?

**NO.**

The original requirement was explicit:
- Create BRANCH node type
- HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE edges
- Enable answering "what conditions guard this operation?"

Instead, the team:
1. Abandoned BRANCH nodes
2. Built `find_guards` MCP tool to query the graph
3. Fixed scope tracking in JSASTAnalyzer

**Why this is wrong:**
- User asked for a **feature** (BRANCH nodes for control flow)
- We delivered a **tool** (MCP handler) that requires **prior architectural fixes**
- The MCP tool only works AFTER the scope tracking fix is complete
- Steve's demo (REG-274/008) shows the feature **doesn't actually work** - find_guards returns empty guards even with correct SCOPE nodes in place

---

## Does It Align with Vision?

**PARTIALLY, but with wrong approach.**

The vision says "AI should query the graph, not read code." The `find_guards` tool aligns with this. But:

1. **The graph was broken** - CONTAINS edges didn't reflect actual scope nesting
2. **The fix is incomplete** - Scope tracking works, but find_guards MCP tests pass only with **mocks**
3. **No end-to-end validation** - Steve's demo found the real graph doesn't work; no one fixed it

This is building features on top of broken foundations.

---

## Any Hacks or Shortcuts?

**YES - Multiple:**

### 1. Scope Tracking Fix is Incomplete

Rob implemented dynamic scope ID tracking in `JSASTAnalyzer`, but:
- Added `scopeIdStack` parameter to multiple handlers
- This is **parameter threading**, not architectural fix
- The real issue: `analyzeFunctionBody()` method signature is getting bloated with optional parameters

**Better approach would have been:**
- Make `scopeIdStack` part of `this.state` or a class field
- Not threading it through 10+ function signatures
- This would be cleaner and more maintainable

### 2. find_guards Tests Use Mocks, Not Real Graph

From `packages/mcp/test/mcp.test.ts`:
```typescript
// Tests manually create mock SCOPE nodes with 'conditional' flag
// Real graph doesn't have these edges created by JSASTAnalyzer
```

The tests mock the graph structure find_guards expects. They pass. But when Steve tested with **actual generated graph** (REG-274/008), it failed:
- find_guards returned empty array
- CONTAINS edges don't connect conditional SCOPE to contained CALL nodes

**This is a red flag:** Mocked tests pass, real usage fails = tests are lying.

### 3. Pre-existing Try/Catch Limitation Documented but Not Fixed

2 of 16 scope tests fail due to `handleTryStatement.skip()` preventing call visitors from seeing try/catch/finally blocks. This is a **known architectural issue** that should have been surfaced earlier, not discovered during implementation.

---

## Scope Tracking Fix Assessment

**The mechanism is sound, but incomplete:**

✓ `scopeIdStack` correctly tracks scope nesting
✓ `getCurrentScopeId()` returns correct ID for current scope
✓ JSASTAnalyzer updated to track scope on enter/exit
✓ CALL/VARIABLE nodes now include `parentScopeId`

**BUT:**
- Tests show 14/16 pass (2 try/catch failures)
- find_guards MCP tests mock the graph
- Steve's real-world demo shows find_guards fails end-to-end
- Root cause: Changes to JSASTAnalyzer don't create correct CONTAINS edges in the **actual graph storage**

This suggests the CONTAINS edge creation in **GraphBuilder** might not be using the new `parentScopeId` correctly.

---

## What's Broken Right Now

### The Real Issue (from Steve's Demo)

User code:
```javascript
function processUser(user) {
  if (user.isAdmin) {
    if (user.active) {
      deleteAllRecords();  // Should have 2 guards
    }
  }
}
```

Expected: `find_guards` returns [user.isAdmin guard, user.active guard]
Actual: Returns [] (no guards)

**Why:**
- Semantic ID is CORRECT: `test-guards.js->processUser->if#0->if#0->CALL->deleteAllRecords#0`
- SCOPE nodes ARE created with `conditional=true`, `condition="..."`
- But CONTAINS edges don't connect these scopes to the CALL

This means JSASTAnalyzer changes are only half-implemented. The graph edge creation isn't wired up.

### Evidence of Incomplete Integration

From Steve's diagnostic:
```
SCOPE: if:2:2:0 (conditional=true, condition="user.isAdmin")     ✓ Exists
SCOPE: if:3:4:1 (conditional=true, condition="user.active")     ✓ Exists
CALL: deleteAllRecords                                           ✓ Exists
CONTAINS edges from if-scopes to CALL                           ✗ Missing
```

The data exists in the graph, but the connections are wrong.

---

## What Should Have Happened

### Option A: Implement BRANCH Nodes (Original Request)
1. Create BRANCH node type
2. Create HAS_CONDITION/HAS_CONSEQUENT/HAS_ALTERNATE edge types
3. JSASTAnalyzer creates BRANCH nodes alongside SCOPE nodes
4. find_guards walks BRANCH -> CONDITION chain
5. Done

### Option B: Fix Scope Tracking + find_guards (Chosen Path)
1. Fix CONTAINS edges to reflect actual scope nesting ← **This is what was attempted**
2. Create find_guards MCP tool to query CONTAINS chain ← **This was created**
3. **Fully test end-to-end** ← **This was NOT done**
4. Ship when working

**We committed to Option B but didn't finish it.** The MCP tool exists, but the graph queries it depends on are broken.

---

## Verdict

### What Was Delivered
- [x] RFDBClient.addNodes() preserves metadata fields
- [x] find_guards MCP tool (definition + handler)
- [x] Scope tracking in JSASTAnalyzer (scopeIdStack)
- [x] Tests for find_guards (using mocks - they pass)
- [ ] **End-to-end working feature** ← FAILED
- [ ] **Real graph properly structured** ← FAILED

### Test Score: 14/16 Scope Tests, 33/33 MCP Tests

But these numbers are **misleading:**
- MCP tests pass because they mock the graph
- Scope tests fail on try/catch (pre-existing issue)
- **Real usage test (Steve's demo): FAILED**

---

## Recommendations

### For This Task
**Do NOT merge.**

**What needs to happen:**
1. **Diagnostic:** Run Steve's test case with current code, capture actual CONTAINS edges being created
2. **Trace:** Follow GraphBuilder logic to see why `parentScopeId` isn't being used for edge source
3. **Fix:** Likely need to ensure GraphBuilder reads the new `parentScopeId` values from nodes
4. **Validate:** Re-run Steve's demo - find_guards must return correct guards
5. **Only then:** Merge

### For Future
- **Mocked tests ≠ passing tests.** Mock-based tests need a mandatory end-to-end validation with real graph
- **Architecture decisions matter.** Parameter threading through 10+ functions (scopeIdStack) is a code smell. Should be refactored to class state
- **Try/catch limitation** should be tracked as a separate Linear issue (v0.2 backlog)
- **Consider revisiting BRANCH nodes** - they would be cleaner than the current scope-query approach

---

## The Bottom Line

You built a tool (find_guards) that can't find guards because the graph structure it queries isn't being created correctly. This is not a merge-ready state.

**Go back. Fix the integration. Validate end-to-end. Then we talk about merging.**

