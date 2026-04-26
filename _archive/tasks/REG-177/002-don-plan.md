# Don Melton's Analysis and High-Level Plan for REG-177

## Executive Summary

The user request for REG-177 asks for debugging tools to understand why nodes are missing from the graph. The proposed solution includes `grafema explain`, `grafema diagnose`, and coverage reporting. After thorough codebase analysis, I find the request is **critically important** and **aligned with Grafema's vision**, but the proposed implementation needs architectural refinement.

## The Core Problem

When a user can't find `response` variable inside `fetchInvitations` function, they face a black box. The graph either has the node or it doesn't, with no explanation. This fundamentally undermines trust - and trust is essential when we ask AI agents to "query the graph, not read code."

**This is a product gap, not a user education issue.**

## Current State Assessment

**What Grafema currently tracks:**
1. **DiagnosticCollector** - Collects errors and warnings during analysis (syntax errors, plugin failures)
2. **CoverageAnalyzer** - File-level coverage (analyzed vs unreachable vs unsupported)
3. **ManifestStore** - Processing state per file/phase
4. **IssueNode** - Issue nodes for security/performance problems

**What Grafema does NOT track:**
1. **AST elements seen but not extracted** - The analyzer parses try/catch blocks but may not extract all variables inside
2. **Extraction decisions** - Why a particular node was or wasn't created
3. **Known limitations** - Which patterns are intentionally not supported
4. **Completeness metadata** - Per-file record of what was extracted vs what exists in source

## Architectural Gap Analysis

The user expects: "FILE X was analyzed. Inside FUNCTION Y, VARIABLE Z exists at line 43 but wasn't extracted. REASON: variables inside try blocks not extracted."

Current architecture can answer: "FILE X was analyzed. FUNCTION Y was created. VARIABLE Z doesn't exist."

The gap is the **"expected but missing"** detection. To know what's "expected," we need to compare:
1. What the AST contains (all identifiers, declarations, etc.)
2. What Grafema extracted (nodes in the graph)

This requires either:
- **Option A**: Runtime comparison (re-parse file, walk AST, compare to graph)
- **Option B**: Persist extraction metadata during analysis (record what was seen vs what was created)

## Vision Alignment Check

**Question:** Does this feature make "query the graph" more viable than "read the code"?

**Answer:** Absolutely yes. When debugging missing data, users currently must read code to understand what should exist. With `explain`, the graph itself can explain its limitations. This is exactly the kind of feature that builds trust in Grafema as the source of truth.

## High-Level Approach

I recommend a **phased approach** with Option A (runtime comparison) as MVP:

### Phase 1: `grafema explain <file>` (MVP)

**Approach:** Re-parse the file, compare AST to graph, report differences.

**Why runtime comparison for MVP:**
1. No schema changes to graph storage
2. Works with existing graphs (no re-analysis required)
3. Simpler to implement and test
4. Good enough for debugging use case

**Output structure:**
```
File: apps/frontend/src/pages/Invitations.tsx
Status: ANALYZED

Created nodes: 5
  - MODULE: Invitations.tsx
  - FUNCTION: Invitations
  - FUNCTION: fetchInvitations
  ...

AST elements not in graph: 3
  - Variable 'response' at line 43 (inside try block)
  - Variable 'data' at line 44 (inside try block)
  - Call 'authFetch' at line 43 (unresolved)

Why some elements aren't extracted:
  - Variables inside try/catch: Not supported (known limitation)
  - Unresolved calls: Target function not in scope
```

**Key insight:** We don't need to track "expected" during analysis. We can compute it on-demand by comparing AST to graph.

### Phase 2: `grafema diagnose <pattern>`

**Approach:** Natural language pattern matching to find nodes and explain their absence.

```bash
grafema diagnose "response from fetchInvitations"
```

This is essentially a smarter `query` command that:
1. Attempts to find the node
2. If not found, explains possible reasons
3. Suggests which file to `explain`

### Phase 3: Known Limitations Tracking (Future)

**Approach:** During analysis, record known limitations as ISSUE nodes.

```typescript
// In JSASTAnalyzer when skipping try/catch variable extraction
graph.addNode(IssueNode.create(
  'limitation',  // category
  'info',        // severity
  'Variables inside try/catch blocks not extracted',
  'JSASTAnalyzer',
  file, line, column,
  { pattern: 'try-catch-variable', affectedNodes: ['response'] }
));
```

This allows future queries like:
```bash
grafema query "issue limitation try-catch"
```

## What Needs to Exist vs What Needs to Be Built

**Already exists:**
- `RFDBServerBackend.queryNodes()` - Query graph for existing nodes
- `DiagnosticCollector` - Error/warning collection infrastructure
- `@babel/parser` - Can re-parse files for comparison
- `CoverageAnalyzer` - Pattern for file-level analysis

**Needs to be built:**

1. **FileExplainer class** (core)
   - Re-parses file
   - Walks AST to collect "expected" elements
   - Queries graph for existing nodes
   - Computes difference
   - Returns structured report

2. **explain command** (cli)
   - Takes file path argument
   - Creates FileExplainer
   - Formats output for terminal

3. **Known limitations registry** (core)
   - Static registry of what JSASTAnalyzer doesn't extract
   - Patterns like: `try-catch-variables`, `dynamic-property-access`, etc.
   - Human-readable explanations

## Scope Reduction for MVP

**In scope:**
- `grafema explain <file>` command
- Report of created vs AST elements
- Known limitation explanations (hardcoded initially)

**Out of scope (future):**
- `grafema diagnose` (nice-to-have, can use `query` for now)
- ISSUE nodes for limitations (requires schema design)
- Coverage percentages per file (already have file-level coverage)
- Integration with MCP for AI agents

## Potential Concerns

1. **Performance:** Re-parsing large files is expensive. Mitigation: cache parsed AST, limit to single file at a time.

2. **Accuracy:** "Expected" heuristics might be noisy. Mitigation: Focus on high-confidence patterns first (declared variables, function declarations).

3. **Maintenance:** Known limitations list must stay in sync with analyzer. Mitigation: Co-locate limitation definitions with analyzer code.

## Critical Files for Implementation

1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Understand what IS extracted and how
2. `packages/core/src/core/CoverageAnalyzer.ts` - Pattern to follow for file analysis
3. `packages/cli/src/commands/doctor.ts` - Pattern for diagnostic commands
4. `packages/cli/src/commands/query.ts` - Node lookup patterns
5. `packages/core/src/diagnostics/DiagnosticCollector.ts` - Diagnostic infrastructure

## Conclusion

REG-177 is the RIGHT thing to build. It directly addresses the trust gap that prevents AI agents from fully relying on Grafema. The proposed `explain` command is a pragmatic MVP that can be built without schema changes.

The key architectural decision is **runtime AST-to-graph comparison** rather than persisting extraction metadata during analysis. This is simpler, works with existing graphs, and is good enough for the debugging use case.
