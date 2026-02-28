---
name: grafema-call-node-end-positions
description: |
  Debug Grafema CALL node missing endLine/endColumn issues. Use when: (1) "Find at
  cursor" returns wrong node or falls back to proximity matching, (2) dump of
  getAllNodes({file}) shows CALL nodes with endLine=undefined/endColumn=undefined,
  (3) "Variable X not found in graph" — entire module analysis silently failed
  because a CALL node threw GraphDataError before variable nodes were committed,
  (4) new AST node handler creates CALL nodes without endLine/endColumn. Root causes:
  (A) stale graph — fix with grafema analyze --clear; (B) new CALL-creating handler
  missing endLine/endColumn — fix by adding getEndLocation() to the handler.
author: Claude Code
version: 1.1.0
date: 2026-02-22
---

# Grafema CALL Node Missing End Positions

## Problem

Two distinct symptoms, same root cause — CALL nodes created without `endLine`/`endColumn`.

**Symptom A (VS Code):** `findNodeAtCursor` silently falls back to proximity-based
matching. Phase 1 (containment) is skipped entirely, leading to wrong or no node selected.

**Symptom B (Analysis):** "Variable X not found in graph" for module-level variables.
The `GraphDataError` guard in `GraphBuilder._bufferNode` throws when a CALL node lacks
end positions. `JSASTAnalyzer` re-propagates `GraphDataError` (unlike regular errors which
are swallowed), so the entire module analysis silently fails — variable nodes are added
to the local array but never committed to the graph.

## Context / Trigger Conditions

**Symptom A (stale graph):**
- VS Code extension "Find at cursor" returns wrong node or "No graph node at cursor"
- Graph was built before `endLine`/`endColumn` were added to `CallExpressionVisitor`
- Confirmed by checking raw node metadata (see diagnosis below)

**Symptom B (new handler bug):**
- Test or analysis says "Variable X not found in graph" for a module containing a
  specific syntax construct (e.g. tagged template, decorator call, etc.)
- `nodesCreated` log shows a low number despite the file having variables
- The syntax construct was recently added as a new handler in `CallExpressionVisitor`
  without `endLine`/`endColumn` in the CALL node it creates

**Known real-world cases (handlers that had this bug):**
- `TaggedTemplateExpression` (both `callInfo` and `methodCallInfo` branches) — fixed 2026-02-23
  Symptom: `const result = html\`...\`` → "Variable 'result' not found in graph"

## Diagnosis

Run this to verify the issue:

```js
node - << 'EOF'
import { RFDBClient } from '/path/to/grafema/packages/rfdb/dist/client.js';
const client = new RFDBClient('/path/to/project/.grafema/rfdb.sock');
await client.connect();
const nodes = await client.getAllNodes({ file: 'src/yourfile.ts' });
const calls = nodes.filter(n => n.nodeType === 'CALL');
let missing = 0, present = 0;
for (const n of calls) {
  const m = JSON.parse(n.metadata || '{}');
  if (m.endLine === undefined) missing++; else present++;
}
console.log(`${present} with endLine, ${missing} WITHOUT`);
client.socket?.destroy();
EOF
```

If `missing > 0` → graph is stale.

## Solution

**Symptom A (stale graph):**
```bash
grafema analyze --clear
```
The `--clear` flag rebuilds the graph from scratch, ensuring all CALL nodes get
`endLine`/`endColumn` from the current version of `CallExpressionVisitor`.

**Symptom B (new handler missing end positions):**

Add `endLine`/`endColumn` to every `CallSiteInfo` or `MethodCallInfo` created in the
new handler:

```typescript
import { getEndLocation } from '../utils/location.js';

const callInfo: CallSiteInfo = {
  id: '',
  type: 'CALL',
  name: tagName,
  file: s.module.file,
  line: tagLine,
  column: tagColumn,
  endLine: getEndLocation(node as Node).line,    // ← REQUIRED
  endColumn: getEndLocation(node as Node).column, // ← REQUIRED
  parentScopeId,
  targetFunctionName: tagName,
};
```

**Checklist for new CALL-creating handlers in `CallExpressionVisitor`:**
- [ ] `callInfo.endLine` set via `getEndLocation(node).line`
- [ ] `callInfo.endColumn` set via `getEndLocation(node).column`
- [ ] A test verifying that variables assigned from the new construct appear in the graph

## Warning: `--service X` Wipes the Whole Graph

**Never use `grafema analyze --service vscode` to add a single service** — it replaces
the entire graph with just that service. Always run without `--service` (or with all
services) when you need a full graph.

## How endLine/endColumn Flow

```
CallExpressionVisitor.handleSimpleMethodCall()
  → MethodCallInfo { endLine: getEndLocation(callNode).line, endColumn: ... }
  → GraphBuilder._bufferNode()   ← GraphDataError guard here
  → batchNode() → JSON.stringify(rest) → stored in metadata
```

`getEndLocation` returns `{ line: 0, column: 0 }` as fallback for missing AST location.
Both `undefined` and `0` are invalid — `findNodeAtCursor` guards against `endLine > 0`.

## GraphDataError Guard

As of commit `e86cf29`, `GraphBuilder._bufferNode` throws `GraphDataError` (which
propagates through JSASTAnalyzer's silent catch) when a CALL node has missing or
zero endLine. This surfaces future regressions at analysis time rather than silently
corrupting cursor matching.

## Verification

After `grafema analyze --clear`:
- Re-run the diagnosis script above → `missing` should be 0
- Test "Find at cursor" in VS Code — should now find CALL nodes precisely
