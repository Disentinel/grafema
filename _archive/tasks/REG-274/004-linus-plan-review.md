# Linus Torvalds Review: REG-274 BRANCH Nodes

## Verdict: REJECT

## Analysis

### 1. Is BRANCH coexisting with SCOPE the right design?

**No. BRANCH is unnecessary.**

The existing SCOPE implementation already tracks:
- `scopeType: 'if_statement'` / `'else_statement'`
- `condition: string` (the condition text)
- `constraints: unknown[]` (parsed conditions from ConditionParser)

Creating a separate BRANCH node is **architectural bloat**. Two node types for the same concept creates confusion.

### 2. Is creating EXPRESSION nodes for conditions correct?

**No. It's graph bloat.**

SCOPE already has:
- `condition: string` - the condition text
- `constraints: unknown[]` - parsed constraint objects

The semantic information is already captured. Creating a separate EXPRESSION node for every condition would unnecessarily inflate the graph.

### 3. HAS_CONSEQUENT and HAS_ALTERNATE edges

**Semantic pollution.**

The current implementation uses CONTAINS edge from parent to child scope. The `scopeType` distinguishes if-block from else-block. Adding new edge types duplicates existing information.

## What's Actually Missing

The user's pain points are valid:
1. "Can't answer what conditions guard this operation?"
2. "Can't detect dead code in branches"
3. "Can't calculate cyclomatic complexity"

But the solution is **NOT** creating BRANCH nodes.

The existing SCOPE with `constraints` already enables (1) and (3). For (2), dead code detection requires control flow analysis - a separate feature.

## Recommendation

**Option A: Do Nothing (Preferred)**
Current implementation is sufficient. Query layer improvements needed instead.

**Option B: Minor Enhancement**
If better ergonomics are needed:
1. Add `HAS_ELSE` edge from if-scope to else-scope
2. Ensure DERIVES_FROM edges connect condition variables

But creating BRANCH as a new node type is **over-engineering**.

## Backward Compatibility Concern

BRANCH nodes wouldn't break queries, but would:
1. Increase graph size unnecessarily
2. Create confusion between BRANCH and SCOPE
3. Force users to understand two node types for the same concept

## Conclusion

If the user can't query "what conditions guard this operation?", the problem is in the **query layer**, not the graph schema. Create better MCP tools, not new node types.
