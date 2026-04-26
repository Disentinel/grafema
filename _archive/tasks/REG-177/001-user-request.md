# REG-177: Debugging tools: "Why is X not in the graph?"

## Problem

When a variable/function/node is missing from the graph, there's no way to understand WHY. User has to:

1. Check logs manually
2. Try different query patterns
3. Guess what went wrong

We spent 15 minutes trying to understand why `response` variable in `fetchInvitations` function wasn't in the graph. The file was analyzed, MODULE exists, FUNCTION exists, but the VARIABLE inside is missing. No error, no warning, no explanation.

## Proposed Solution

### 1. `grafema explain <file>` command

```bash
$ grafema explain apps/frontend/src/pages/Invitations.tsx

File Analysis Report
====================
Status: PARTIALLY_ANALYZED

Parsed: ✓ (no syntax errors)
Indexed: ✓ (in dependency tree from main.tsx)
Analyzed: ⚠️ INCOMPLETE

Created nodes: 5
  - MODULE: module
  - FUNCTION: Invitations
  - FUNCTION: fetchInvitations
  - VARIABLE: fetchInvitations
  - VARIABLE: invitations

Missing (expected but not created): 3
  - VARIABLE: response (line 43) - inside try block, not extracted
  - VARIABLE: data (line 44) - inside try block, not extracted
  - CALL: authFetch (line 43) - call not linked

Reason: JSASTAnalyzer doesn't extract variables inside try/catch blocks
Related issue: REG-XXX
```

### 2. `grafema diagnose <pattern>` command

```bash
$ grafema diagnose "response from fetchInvitations"

Looking for: VARIABLE named "response" in scope "fetchInvitations"

Search results:
  ✗ Not found in graph

Possible reasons:
  1. Variable is inside try/catch block (not extracted by default)
  2. Variable is inside callback/closure (scope resolution issue)
  3. File was not fully analyzed (check with: grafema explain <file>)

Suggestion: Run `grafema explain Invitations.tsx` for details
```

### 3. Analysis coverage per file

```bash
$ grafema coverage apps/frontend/src/pages/Invitations.tsx

Coverage: 67% (estimated)
  - Top-level declarations: 100%
  - Function bodies: 80%
  - Try/catch blocks: 0%
  - Callbacks: 50%
```

## Acceptance Criteria

1. `grafema explain <file>` shows what was/wasn't extracted and why
2. `grafema diagnose <pattern>` helps find missing nodes
3. Clear error messages when analysis is incomplete
4. ISSUE nodes created for known limitations (not just errors)

## Context

This is critical for debugging and trust. If users can't understand why Grafema doesn't see their code, they won't use it.
