# Don Melton's Revised Plan for REG-177

## Executive Summary

Investigation reveals that the original premise was **FALSE**: variables inside try/catch blocks **ARE** extracted by JSASTAnalyzer. The problem is NOT a coverage gap, but a **discovery and query UX problem**.

**New thesis:** Users can't find nodes because:
1. Semantic IDs are opaque (e.g., `src/pages/Invitations.tsx->fetchInvitations->try#0->VARIABLE->response`)
2. Query command requires knowing exact node structure
3. No way to discover "what exists in this file" without raw Datalog queries

**Revised solution:** `grafema explain <file>` as a **file inspection tool**, NOT a "known limitations explainer".

---

## What Changed

### Original Plan (WRONG)
- **Premise:** JSASTAnalyzer doesn't extract variables in try/catch blocks
- **Goal:** Explain known limitations to users
- **Approach:** AST-to-graph comparison to find "missing" nodes

### Revised Plan (RIGHT)
- **Premise:** Extraction IS complete, but discovery is hard
- **Goal:** Help users discover what nodes exist in a file
- **Approach:** Show graph contents for a file, with semantic IDs for querying

**Key insight from investigation:** Variables in try blocks have semantic IDs like:
```
src/pages/Invitations.tsx->fetchInvitations->try#0->VARIABLE->response
```

Users can't guess this structure. They need to SEE it to query it.

---

## The Real Problem (Validated)

**Original user report:** "We spent 15 minutes trying to understand why `response` variable wasn't in the graph."

**What actually happened:**
1. `response` variable WAS in the graph
2. Its semantic ID includes `try#0` scope (auto-generated try block scope)
3. Simple query `grafema query "response"` might not find it if scope-specific lookup fails
4. User assumes "not in graph" when actually "can't find it"

**This is a product gap:** The graph is good, the query UX is inadequate.

---

## Revised Solution: `grafema explain <file>`

### Purpose (CHANGED)
NOT: "Explain why nodes are missing"
BUT: "Show what nodes exist in this file and how to query them"

### Output Format

```bash
$ grafema explain apps/frontend/src/pages/Invitations.tsx

File: apps/frontend/src/pages/Invitations.tsx
Status: ANALYZED

Nodes in graph: 8

[MODULE]
  ID: apps/frontend/src/pages/Invitations.tsx->MODULE
  Location: apps/frontend/src/pages/Invitations.tsx

[FUNCTION] Invitations
  ID: apps/frontend/src/pages/Invitations.tsx->global->FUNCTION->Invitations
  Location: apps/frontend/src/pages/Invitations.tsx:12

[FUNCTION] fetchInvitations
  ID: apps/frontend/src/pages/Invitations.tsx->global->FUNCTION->fetchInvitations
  Location: apps/frontend/src/pages/Invitations.tsx:35

[VARIABLE] response (inside try block)
  ID: apps/frontend/src/pages/Invitations.tsx->fetchInvitations->try#0->VARIABLE->response
  Location: apps/frontend/src/pages/Invitations.tsx:43

[VARIABLE] data (inside try block)
  ID: apps/frontend/src/pages/Invitations.tsx->fetchInvitations->try#0->VARIABLE->data
  Location: apps/frontend/src/pages/Invitations.tsx:44

[VARIABLE] error (catch parameter)
  ID: apps/frontend/src/pages/Invitations.tsx->fetchInvitations->catch#0->VARIABLE->error
  Location: apps/frontend/src/pages/Invitations.tsx:46

To query specific node:
  grafema query --raw 'attr(X, "id", "apps/frontend/src/pages/Invitations.tsx->fetchInvitations->try#0->VARIABLE->response")'
  grafema query "response"  (will search across all files)
```

### Key Differences from Original Plan

**REMOVED:**
- AST-to-graph comparison (not needed - nodes exist!)
- "Missing elements" section (nothing is missing)
- "Known limitations" registry (no limitations to explain)
- ISSUE node creation (no issues to report)

**ADDED:**
- Clear semantic ID display (this is what users need to query)
- Scope context annotations (e.g., "inside try block", "catch parameter")
- Query examples (show HOW to find these nodes)
- Status reporting (was file analyzed or not)

---

## Implementation Approach (SIMPLIFIED)

### Core Logic (packages/core/src/core/FileExplainer.ts)

```typescript
export class FileExplainer {
  constructor(private graph: GraphBackend) {}

  async explain(filePath: string): Promise<FileExplainResult> {
    // 1. Query graph for all nodes in this file
    const nodes = await this.getNodesForFile(filePath);

    // 2. Group by type
    const byType = this.groupByType(nodes);

    // 3. Enhance with context (scope annotations)
    const enhanced = this.enhanceWithContext(nodes);

    return {
      file: filePath,
      status: nodes.length > 0 ? 'ANALYZED' : 'NOT_ANALYZED',
      nodes: enhanced,
      byType,
      totalCount: nodes.length
    };
  }

  private async getNodesForFile(filePath: string): Promise<BaseNodeRecord[]> {
    // Simple query: attr(X, "file", filePath)
    return await this.graph.queryNodes({ file: filePath });
  }

  private enhanceWithContext(nodes: BaseNodeRecord[]): EnhancedNode[] {
    return nodes.map(node => {
      const parsed = parseSemanticId(node.id);
      
      // Detect scope context from semantic ID
      let context: string | undefined;
      if (parsed?.scopePath.some(s => s.startsWith('try#'))) {
        context = 'inside try block';
      } else if (parsed?.scopePath.some(s => s.startsWith('catch#'))) {
        context = 'catch parameter';
      } else if (parsed?.scopePath.some(s => s.startsWith('if#'))) {
        context = 'inside conditional';
      }

      return { ...node, context };
    });
  }
}
```

**No AST parsing needed!** Just query the graph and format the output.

---

## Why This Is Better

### 1. Solves the Real Problem
Users struggled to find `response` variable. Now they can:
```bash
grafema explain Invitations.tsx
# See: apps/frontend/src/pages/Invitations.tsx->fetchInvitations->try#0->VARIABLE->response
# Copy semantic ID, use in queries
```

### 2. Aligns with Vision
"AI should query the graph, not read code."

- `explain` shows what's IN the graph
- No re-parsing of source files
- Semantic IDs are the source of truth
- Query examples teach proper graph usage

### 3. Much Simpler
**Original plan:** Re-parse file, walk AST, compare to graph, detect "missing" nodes, explain limitations
**Revised plan:** Query graph for file, format output with semantic IDs

**Lines of code estimate:**
- Original: ~500 lines (FileExplainer + AST walking + limitations registry + tests)
- Revised: ~150 lines (FileExplainer + formatting + tests)

### 4. No Maintenance Burden
**Original:** "Known limitations" registry must stay in sync with analyzer changes
**Revised:** No hardcoded assumptions, just show what's in the graph

---

## Scope for MVP

**In scope:**
- `grafema explain <file>` command
- List all nodes for a file
- Show semantic IDs prominently
- Annotate scope context (try/catch/if)
- Provide query examples in help text

**Out of scope:**
- `grafema diagnose <pattern>` (can use `query` for now)
- AST-to-graph comparison (not needed)
- Coverage percentages (already have file-level coverage)
- Integration with MCP (future, separate task)

---

## Validation Plan

Before implementing, validate the hypothesis:

1. **Create test file with try/catch:**
```javascript
async function fetchData() {
  try {
    const response = await fetch('/api');
    const data = await response.json();
    return data;
  } catch (error) {
    return null;
  }
}
```

2. **Run analysis:**
```bash
grafema analyze test-file.js
```

3. **Query for `response` variable:**
```bash
# Try different query patterns
grafema query "response"
grafema query "variable response"
grafema query --raw 'type(X, "VARIABLE"), attr(X, "name", "response")'
```

4. **Check semantic ID:**
```bash
grafema query --json "response" | jq '.[].id'
```

**Expected result:** `response` variable exists with semantic ID including `try#0` scope.

**If this is true:** Proceed with revised plan
**If this is false:** We have an extraction bug to fix first

---

## Critical Files for Implementation

1. `packages/core/src/core/FileExplainer.ts` - **New file, MUCH simpler than original**
2. `packages/cli/src/commands/explain.ts` - **New CLI command**
3. `packages/cli/src/utils/formatNode.ts` - **Existing formatter to reuse**
4. `packages/core/src/core/SemanticId.ts` - **For parsing semantic IDs**
5. `packages/cli/test/explain.test.ts` - **New tests**

---

## Next Steps

1. **Validation first** (Kent creates test, Rob runs it, documents results)
2. If validation confirms hypothesis → proceed with implementation
3. If validation reveals bug → file separate bug report, fix extraction first

**Do NOT skip validation.** We already built one plan on false assumptions. Let's not do it twice.

---

## Conclusion

The original plan was technically sound but solving the wrong problem. The revised plan:

- **Addresses real user pain:** Can't discover what's in the graph
- **Simpler implementation:** No AST parsing, just graph queries
- **Better alignment with vision:** Graph is source of truth, show it clearly
- **No false assumptions:** No "known limitations" registry that might be wrong

`grafema explain` is still a valuable feature, but as a **discovery tool**, not a "limitations explainer".
