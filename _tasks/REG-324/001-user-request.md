# REG-324: responseDataNode links to wrong response.json() call

## Problem

`FetchAnalyzer.findResponseJsonCall()` finds the FIRST `response.json()` call in the file matching the variable name, not the one in the same function as the fetch call.

## Example

In `Invitations.tsx`:

* `fetchInvitations` line 43: `const response = await authFetch(...)` → `response.json()` line 44
* `acceptInvitation` line 55: `const response = await authFetch(...)` → `response.json()` line 66

The `responseDataNode` for the first request incorrectly points to `acceptInvitation`'s `response.json()`.

## Root Cause

```typescript
// FetchAnalyzer.ts:findResponseJsonCall
for await (const node of graph.queryNodes({ type: 'CALL' })) {
  if (node.file !== file) continue;           // Only filters by file
  if (callNode.object !== responseVarName) continue;  // "response"
  // Returns FIRST match, not scope-aware!
}
```

## Solution

Same pattern as REG-322 fix: filter by line range or semantic ID scope to ensure we match the `response.json()` from the SAME function as the fetch call.

## Impact

Breaks HTTP_RECEIVES edge linking (frontend response ← backend response), making cross-service value tracing unreliable.

## Acceptance Criteria

- [ ] `responseDataNode` points to `response.json()` in the same function as the fetch
- [ ] Test: multiple functions with same variable name in one file
- [ ] HTTP_RECEIVES edges link correct nodes
